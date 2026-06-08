import { z } from 'zod';
import { assertValidVerdict, type ReviewVerdict } from '../../review/verdict.js';
import type { ToolSpec } from '../registry.js';

// Every input field carries a .describe() (Principle 5 — the schemas are the single syntax source).
// The verdict is STRUCTURED (verdict enum + named blockers/suggestions + an optional verification
// marker) — never a prose blob. The reviewer agent id is NOT a caller input: it comes from the
// mount-assembled ToolContext (ctx.agent), mirroring how co_finish never takes its own identity.

const blockerInput = z.object({
  summary: z.string().min(1).describe('A single-line reason this work cannot merge.'),
});

const suggestionInput = z.object({
  summary: z.string().min(1).describe('A single-line, non-blocking improvement to offer.'),
});

const verificationInput = z.object({
  commands_run: z
    .array(z.string())
    .describe('The verification commands you actually ran (e.g. the test/lint/build gate).'),
  suite_result: z.enum(['pass', 'fail']).describe('Whether the suite you ran passed or failed.'),
  baseline_compared: z
    .boolean()
    .describe('Whether you compared the result against the branch-off baseline.'),
});

const reviewFinalizeInput = z.object({
  target: z
    .string()
    .min(1)
    .describe('The merge target the review is for (the branch the reviewed work merges into).'),
  branch: z.string().min(1).describe('The reviewed source branch this verdict is about.'),
  scope: z
    .enum(['worker_merge', 'phase_merge', 'pr_merge'])
    .optional()
    .describe(
      'The review strictness scope this verdict was judged under; defaults to worker_merge. ' +
        'Use pr_merge for PR/remote publish reviews.',
    ),
  review_id: z
    .string()
    .min(1)
    .describe('The id of this review (shared by the request and this verdict).'),
  verdict: z
    .enum(['PASS', 'ISSUES'])
    .describe('The verdict — PASS (mergeable, zero blockers) or ISSUES (must name ≥1 blocker).'),
  blockers: z
    .array(blockerInput)
    .describe(
      'The named blockers — REQUIRED to be non-empty for an ISSUES verdict; MUST be empty for a ' +
        'PASS (AC-L5-1). Each is a single-line reason.',
    ),
  suggestions: z
    .array(suggestionInput)
    .describe('Non-blocking suggestions you offer (may be empty).'),
  verification: verificationInput
    .optional()
    .describe(
      'The honest-verification marker — REQUIRED for a PASS verdict (AC-L5-3), optional for ISSUES. ' +
        'A PASS recorded without a marker is rejected.',
    ),
});
type ReviewFinalizeInput = z.infer<typeof reviewFinalizeInput>;

const reviewFinalizeOutput = z.object({
  review_id: z.string().describe('The recorded review id.'),
  verdict: z.enum(['PASS', 'ISSUES']).describe('The recorded verdict.'),
  recorded: z.boolean().describe('True once the verdict was recorded as a review.verdict event.'),
});
type ReviewFinalizeOutput = z.infer<typeof reviewFinalizeOutput>;

/**
 * `co_review_finalize` (AC-L5-1): the reviewer-facing verb that RECORDS a structured verdict as a
 * `review.verdict` event via `ctx.reviews`. It runs {@link assertValidVerdict}, so an
 * `{verdict:'ISSUES', blockers:[]}` is rejected (the banned rubber-stamp inverse) and a PASS with a
 * blocker is rejected. The reviewer id is `ctx.agent` (never a caller input).
 *
 * Regression-cure note (the prototype's `review-finalize` exit-1-after-cwd-delete bug): the verdict is
 * a RECORDED EVENT and this handler returns it STRUCTURALLY — callers branch on the recorded verdict,
 * NEVER on a finalizer shell exit code. There is deliberately NO worktree teardown here (the
 * record → mail → teardown ordering is Phase F).
 *
 * The handler loud-fails if the mount did not inject a review store (Principle 9 — a tool never opens
 * its own store), mirroring `co_finish`'s `ctx.worktrees` guard.
 */
export const reviewFinalizeTool: ToolSpec<ReviewFinalizeInput, ReviewFinalizeOutput> = {
  name: 'co_review_finalize',
  title: 'Record a review verdict',
  description:
    'Record your structured review verdict (PASS or ISSUES) for a reviewed branch on a target. An ' +
    'ISSUES verdict must name at least one blocker; a PASS must carry none. The verdict is recorded ' +
    'as an event your lead’s gated co_merge reads — it does not merge or tear anything down.',
  inputSchema: reviewFinalizeInput,
  outputSchema: reviewFinalizeOutput,
  handler: (ctx, input): ReviewFinalizeOutput => {
    if (!ctx.reviews) {
      throw new Error(
        'co_review_finalize: the mount did not inject a review store (ctx.reviews absent).',
      );
    }
    const verdict: ReviewVerdict = {
      verdict: input.verdict,
      blockers: input.blockers,
      suggestions: input.suggestions,
      ...(input.verification != null ? { verification: input.verification } : {}),
    };
    // Reject the rubber-stamp inverse (and the PASS-with-blocker contradiction) before recording.
    assertValidVerdict(verdict);
    // AC-L5-3 defense-in-depth: a PASS recorded without a verification marker is rejected here so a
    // marker-less PASS can never reach the store. The gate re-derives the truth mechanically from
    // baseline/finish events, so a marker that lies cannot smuggle a regression past the gate.
    if (input.verdict === 'PASS' && input.verification == null) {
      throw new Error(
        'co_review_finalize: a PASS verdict requires a verification marker (AC-L5-3 — ' +
          'PASS-without-marker rejected; the gate re-derives the truth from baseline/finish events).',
      );
    }
    // Record from the (mutable) zod-parsed input — `verdict` above is the readonly view used only for
    // the cross-field validation; the event payload schema re-validates on append.
    const record = ctx.reviews.recordVerdict({
      reviewId: input.review_id,
      target: input.target,
      branch: input.branch,
      ...(input.scope != null ? { scope: input.scope } : {}),
      reviewer: ctx.agent,
      verdict: input.verdict,
      blockers: input.blockers,
      suggestions: input.suggestions,
      ...(input.verification != null ? { verification: input.verification } : {}),
    });
    return {
      review_id: record.reviewId,
      verdict: record.verdict,
      recorded: true,
    };
  },
};
