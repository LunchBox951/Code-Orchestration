import { z } from 'zod';
import { finishWorktree } from '../../worktrees/finish.js';
import { defaultGitReader } from '../../worktrees/detect-base.js';
import { resolveProvisioningManifest } from '../../worktrees/provision.js';
import type { ToolSpec } from '../registry.js';
import { readWorktreeInfo } from '../worktree.js';

// Every input field carries a .describe() (Principle 5 — the schemas are the single syntax source).
// The commit INTENT is structured (not a prose blob) so `co` — not the provider — renders the
// house-style commit message from it (AC-L3-3); the test run is structured + aligned with the
// baseline so L5 can compare it (AC-L3-6). The caller never supplies its own identity, branch, or
// parent — those come from the mount-assembled ToolContext + the sling record.
const conventionalType = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9-]*$/u, 'type must be a single lowercase Conventional-Commit token')
  .describe('Conventional-Commit type — e.g. feat, fix, chore, docs, refactor, test.');

const conventionalScope = z
  .string()
  .regex(/^[A-Za-z0-9._/-]+$/u, 'scope must be a single token without spaces, parens, or newlines')
  .optional()
  .describe('Optional Conventional-Commit scope, rendered as type(scope): when present.');

const conventionalSummary = z
  .string()
  .min(1)
  .refine((s) => !/[\r\n]/u.test(s), 'summary must be a single line')
  .refine(
    (s) => !/^[a-z][a-z0-9-]*(?:\([^)]+\))?:\s/u.test(s.trim()),
    'summary must not include a pre-rendered Conventional-Commit header',
  )
  .describe('Imperative one-line summary (no type/scope prefix — co adds it).');

const commitBody = z
  .string()
  .optional()
  .describe(
    'Optional commit body explaining what changed and why, to help a reader follow the diff. ' +
      'Omit for a trivial change (summary only).',
  );

const commitIntentInput = z
  .object({
    type: conventionalType,
    scope: conventionalScope,
    summary: conventionalSummary,
    body: commitBody,
  })
  .describe('The structured commit intent co renders into the house-style commit message.');

const testOutcomeInput = z.object({
  name: z.string().describe('The test (or suite) name.'),
  passed: z.boolean().describe('Whether it passed.'),
});

const finishInput = z.object({
  intent: commitIntentInput,
  tests: z
    .array(testOutcomeInput)
    .describe(
      'The finish’s test run, one entry per test/suite — recorded for L5 to compare against the ' +
        'captured baseline (do not summarize as prose).',
    ),
  notes: z
    .string()
    .optional()
    .describe('Optional free-form notes surfaced in the worker_done message to your parent.'),
});
type FinishInput = z.infer<typeof finishInput>;

const finishOutput = z.object({
  commit_sha: z.string().describe('The full sha of the house-style commit co_finish created.'),
  commit_message: z.string().describe('The commit message co rendered from the intent.'),
  worker_done_seq: z
    .number()
    .describe('The store seq of the worker_done (informational) mail sent to the recorded parent.'),
  finish_recorded: z
    .boolean()
    .describe('True once the finish (commit + test run) was recorded for L5.'),
});
type FinishOutput = z.infer<typeof finishOutput>;

/**
 * `co_finish` (AC-L3-6): COMMIT the worktree with a house-style message rendered from the agent's
 * intent (DCO-signed), RECORD the finish (commit + the finish's test run — the durable input L5
 * compares against the captured baseline), and EMIT `worker_done` (informational) to the parent the
 * sling recorded. It does NOT dispatch a reviewer and does NOT merge — that gate is L5's lead-facing
 * `co_merge` (which refuses without a recorded PASS). `co_finish` itself stays a leaf, non-publishing
 * verb, so it introduces no un-gated path to master/remote/PR (Principle 7).
 *
 * The handler loud-fails if the mount did not inject a worktree store (Principle 9 — a tool never
 * opens its own store), mirroring `co_sling`. It injects `readWorktreeInfo` as the finish core's
 * read-only git seam (keeping the core free of a `tools/` import — no `tools` ↔ `worktrees` cycle).
 */
export const finishTool: ToolSpec<FinishInput, FinishOutput> = {
  name: 'co_finish',
  title: 'Finish a worktree',
  description:
    'Commit your worktree with a house-style message co renders from your intent (DCO-signed), ' +
    'record the finish’s test results for review, and notify your parent with an informational ' +
    'worker_done. It does not review or merge — that is your parent’s gated job.',
  inputSchema: finishInput,
  outputSchema: finishOutput,
  handler: (ctx, input): FinishOutput => {
    if (!ctx.worktrees) {
      throw new Error(
        'co_finish: the mount did not inject a worktree store (ctx.worktrees absent).',
      );
    }
    const result = finishWorktree(
      ctx.worktrees,
      ctx.mail,
      {
        agent: ctx.agent,
        repoCwd: ctx.cwd,
        intent: input.intent,
        tests: input.tests,
        ...(input.notes != null ? { notes: input.notes } : {}),
      },
      {
        readInfo: readWorktreeInfo,
        gitReader: defaultGitReader,
        provisioningManifest: () => resolveProvisioningManifest(ctx.projectId),
      },
    );
    return {
      commit_sha: result.commitSha,
      commit_message: result.commitMessage,
      worker_done_seq: result.workerDoneSeq,
      finish_recorded: result.finishRecorded,
    };
  },
};
