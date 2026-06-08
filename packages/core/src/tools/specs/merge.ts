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
  operator_override: z
    .boolean()
    .optional()
    .describe(
      'Audited operator escape hatch (AC-L5-6): bypass the recorded-PASS gate. REQUIRES a non-empty ' +
        'reason — it records a review.override event and stamps the merge message ' +
        '[reviewed: override — <reason>]. Honest-verification still runs for the record (never silent).',
    ),
  reason: z
    .string()
    .optional()
    .describe(
      'The reason for the operator override — REQUIRED (non-empty) when operator_override is set. ' +
        'Recorded in the audit event and rendered verbatim into the merge message; an override ' +
        'without a reason is refused.',
    ),
});
type MergeInput = z.infer<typeof mergeInput>;

const mergeOutput = z.object({
  merged: z.boolean().describe('True once the reviewed branch was merged into the target.'),
  commit_sha: z.string().describe('The full sha of the merge commit.'),
  commit_message: z.string().describe('The house-style merge message co rendered from the intent.'),
  mode: z
    .enum(['owner', 'contributor', 'offline'])
    .describe('The repository-relationship mode the merge ran in.'),
  baseline_failures: z
    .array(z.string())
    .optional()
    .describe(
      'Pre-existing baseline failures the PASS carried — present when honest-verification found ' +
        'fail→fail tests. The merge proceeded but these failures require attention (AC-L5-3).',
    ),
  escalated: z
    .boolean()
    .optional()
    .describe('True when a baseline-failure escalation was emitted to the parent agent.'),
  overridden: z
    .boolean()
    .optional()
    .describe('True when the PASS gate was bypassed by an audited operator override (AC-L5-6).'),
  override_reason: z
    .string()
    .optional()
    .describe('The recorded override reason, present when overridden.'),
  tore_down: z
    .boolean()
    .optional()
    .describe(
      'True once the merged branch’s sandbox was torn down after the merge was recorded; false when ' +
        'the teardown trigger failed (the merge still succeeded — teardown never masks it, AC-L5-7).',
    ),
});
type MergeOutput = z.infer<typeof mergeOutput>;

/**
 * `co_merge` (AC-L5-1): the lead-facing verb that integrates a reviewed branch — GATED on a recorded
 * PASS. It refuses unless `ctx.reviews.getVerdict(target, branch)` is a recorded `PASS` (absent or
 * `ISSUES` ⇒ refuse, loud — there is NO un-gated merge path), renders the house-style merge message
 * (`[reviewed: PASS]`), and enacts the merge for `owner` + `offline` modes (a local `--no-ff` merge).
 * `contributor` local merge is refused; contributors publish through the gated co_push /
 * co_pr_merge path.
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
    'refuses without a recorded PASS; contributor mode publishes through the gated co_push / ' +
    'co_pr_merge path.',
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
    // Capture the (now-present) worktree store + repo cwd for the teardown closure; the guards above
    // narrow them, but a nested closure does not inherit that narrowing.
    const worktrees = ctx.worktrees;
    const repoCwd = ctx.cwd;
    // Default the target to the detected base of the lead's worktree (its integration branch), the
    // same auto-detection co_sling uses — never a hard-coded master (AC-L3-1).
    const into = input.into ?? detectBaseRef(repoCwd);
    // Build the production parent-resolver from the worktree-recorded spawning parent
    // (AC-L5-4 / Phase D): baseline-failure escalations go to the branch's recorded parent.
    const parentAgent = worktrees.getWorktree(input.branch)?.parent;
    // L7 SEAM NOTE (placement recording): CoReviewGate.triggerReview resolves + records a reviewer
    // placement (placement.decided) via the L4 dispatch store. `dispatch`/`config`/`nowMs` are
    // intentionally NOT injected here — triggerReview has zero production callers at this surface
    // (`co_merge` gates on an already-recorded verdict; `co_finish` stops short of triggering a new
    // review). The live invocation of triggerReview — conducting the reviewer dispatch — is the L7
    // seam (AC-L5-11 defers: "no L7 work"). Wiring dispatch here would be dead code. L7 injects it
    // when it wires the live reviewer dispatch.
    const gate = new CoReviewGate({
      reviews: ctx.reviews,
      worktrees,
      mail: ctx.mail,
      agentId: ctx.agent,
      ...(parentAgent != null ? { parentResolver: { parentOf: () => parentAgent } } : {}),
      // Merge-time teardown trigger (AC-L5-7): the merge gate tears the merged branch's sandbox down
      // AFTER the merge is recorded + the slot released — never before (the review-finalize cure).
      teardown: {
        teardown: (branch) => void worktrees.removeWorktree(branch, { repoCwd }),
      },
    });
    const result = gate.merge({
      branch: input.branch,
      into,
      summary: input.intent.summary,
      projectId: ctx.projectId,
      repoCwd,
      ...(input.intent.body != null ? { body: input.intent.body } : {}),
      ...(input.operator_override != null ? { operatorOverride: input.operator_override } : {}),
      ...(input.reason != null ? { reason: input.reason } : {}),
    });
    return {
      merged: result.merged,
      commit_sha: result.commitSha,
      commit_message: result.commitMessage,
      mode: result.mode,
      ...(result.baselineFailures != null
        ? { baseline_failures: [...result.baselineFailures] }
        : {}),
      ...(result.escalated != null ? { escalated: result.escalated } : {}),
      ...(result.overridden != null ? { overridden: result.overridden } : {}),
      ...(result.overrideReason != null ? { override_reason: result.overrideReason } : {}),
      ...(result.toreDown != null ? { tore_down: result.toreDown } : {}),
    };
  },
};
