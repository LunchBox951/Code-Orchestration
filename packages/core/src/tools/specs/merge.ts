import { z } from 'zod';
import { CoReviewGate } from '../../review/merge.js';
import { detectBaseRef } from '../../worktrees/detect-base.js';
import type { ToolSpec } from '../registry.js';

// Every input field carries a .describe() (Principle 5). The merge INTENT is structured (not a prose
// blob) so `co` — not the provider — renders the house-style merge message from it (AC-L3-3 /
// Principle 3). The caller never supplies its own identity, project, or repo — those come from the
// mount-assembled ToolContext.

const mergeIntentInput = z
  .object({
    summary: z
      .string()
      .min(1)
      .refine((s) => !/[\r\n]/u.test(s), 'summary must be a single line')
      .describe('Imperative one-line summary of what the merged branch delivered.'),
    body: z
      .string()
      .optional()
      .describe('Optional body prose describing the merged work; the stat line is appended to it.'),
  })
  .describe('The structured merge intent co renders into the house-style merge commit message.');

const mergeInput = z.object({
  branch: z.string().min(1).describe('The reviewed source branch to merge.'),
  into: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The target branch to merge into. Defaults to the detected base of your worktree (e.g. your ' +
        'integration branch).',
    ),
  intent: mergeIntentInput,
});
type MergeInput = z.infer<typeof mergeInput>;

const mergeOutput = z.object({
  merged: z.boolean().describe('True once the reviewed branch was merged into the target.'),
  commit_sha: z.string().describe('The full sha of the merge commit.'),
  commit_message: z.string().describe('The house-style merge message co rendered from the intent.'),
  mode: z
    .enum(['owner', 'contributor', 'offline'])
    .describe('The repository-relationship mode the merge ran in.'),
});
type MergeOutput = z.infer<typeof mergeOutput>;

/**
 * `co_merge` (AC-L5-1): the lead-facing verb that integrates a reviewed branch — GATED on a recorded
 * PASS. It refuses unless `ctx.reviews.getVerdict(target, branch)` is a recorded `PASS` (absent or
 * `ISSUES` ⇒ refuse, loud — there is NO un-gated merge path), renders the house-style merge message
 * (`[reviewed: PASS]`), and enacts the merge for `owner` + `offline` modes (a local `--no-ff` merge).
 * `contributor` publishing (fork→PR) is refused as Phase C (co_push / co_pr_merge).
 *
 * The handler loud-fails if the mount did not inject the review or worktree store (Principle 9 — a tool
 * never opens its own store). It delegates to {@link CoReviewGate} — the single gated merge core — so
 * the gate logic is shared + headless-testable. Writes only program-data + the target repo's own git
 * (the merge commit) — never an orchestration file into the tree (Principle 12).
 */
export const mergeTool: ToolSpec<MergeInput, MergeOutput> = {
  name: 'co_merge',
  title: 'Merge a reviewed branch',
  description:
    'Integrate a reviewed branch into your target branch — only if a PASS verdict is recorded for it. ' +
    'co renders the house-style merge message from your intent and merges in owner/offline mode. It ' +
    'refuses without a recorded PASS; contributor fork→PR publishing is a later phase.',
  inputSchema: mergeInput,
  outputSchema: mergeOutput,
  handler: (ctx, input): MergeOutput => {
    if (!ctx.reviews) {
      throw new Error('co_merge: the mount did not inject a review store (ctx.reviews absent).');
    }
    if (!ctx.worktrees) {
      throw new Error(
        'co_merge: the mount did not inject a worktree store (ctx.worktrees absent).',
      );
    }
    // Default the target to the detected base of the lead's worktree (its integration branch), the
    // same auto-detection co_sling uses — never a hard-coded master (AC-L3-1).
    const into = input.into ?? detectBaseRef(ctx.cwd);
    const gate = new CoReviewGate({ reviews: ctx.reviews });
    const result = gate.merge({
      branch: input.branch,
      into,
      summary: input.intent.summary,
      projectId: ctx.projectId,
      repoCwd: ctx.cwd,
      ...(input.intent.body != null ? { body: input.intent.body } : {}),
    });
    return {
      merged: result.merged,
      commit_sha: result.commitSha,
      commit_message: result.commitMessage,
      mode: result.mode,
    };
  },
};
