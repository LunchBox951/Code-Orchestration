import { z } from 'zod';
import { MAIL_WORKER_DONE } from '../../mail/events.js';
import type { ReviewRequestRecord } from '../../review/events.js';
import type { ReviewScope } from '../../review/ladder.js';
import { resolveReviewerProfiles, reviewerRoleForScope } from '../../review/merge.js';
import type { ReviewStore } from '../../review/review-store.js';
import { assertValidVerdict, type ReviewVerdict } from '../../review/verdict.js';
import type { ToolSpec } from '../registry.js';
import { assertToolCallerRole } from '../caller-auth.js';

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
      'The review strictness scope this verdict was judged under; when omitted, defaults to the ' +
        'requested scope recorded with this review_id. Use pr_merge for PR/remote publish reviews.',
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

function expectedReviewerFromPlacement(
  ctx: {
    readonly dispatch?: {
      readPlacements: () => readonly {
        agent: string;
        role: string;
        kind?: string;
        reviewId?: string;
        reviewTarget?: string;
        reviewBranch?: string;
        reviewScope?: string;
      }[];
    };
  },
  request: ReviewRequestRecord,
): string | undefined {
  if (ctx.dispatch == null) return undefined;
  const reviewId = request.reviewId;
  const matches = ctx.dispatch
    .readPlacements()
    .filter(
      (placement) =>
        placement.agent === `${placement.role}@${reviewId}` &&
        (placement.role === 'reviewer' || placement.role.startsWith('reviewer:')),
    );
  if (matches.length === 0) {
    throw new Error(
      `co_review_finalize: refused — no recorded reviewer placement exists for review_id ` +
        `'${reviewId}'.`,
    );
  }
  const compatible = matches.filter(
    (placement) =>
      (placement.reviewId == null || placement.reviewId === request.reviewId) &&
      (placement.reviewTarget == null || placement.reviewTarget === request.target) &&
      (placement.reviewBranch == null || placement.reviewBranch === request.branch) &&
      (placement.reviewScope == null || placement.reviewScope === request.scope),
  );
  if (compatible.length === 0) {
    throw new Error(
      `co_review_finalize: refused — recorded reviewer placement for review_id '${reviewId}' ` +
        'does not match the current review request target/branch/scope.',
    );
  }
  const placed = compatible.filter((placement) => placement.kind === 'placed');
  if (placed.length > 0) return placed.at(-1)!.agent;
  throw new Error(
    `co_review_finalize: refused — reviewer placement for review_id '${reviewId}' is waiting ` +
      'and has not been placed yet.',
  );
}

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
    'Record your structured review verdict (PASS or ISSUES) for a reviewed branch on a target. ' +
    'ISSUES needs at least one blocker; PASS needs none. Records a verdict event; merges nothing.',
  inputSchema: reviewFinalizeInput,
  outputSchema: reviewFinalizeOutput,
  handler: (ctx, input): ReviewFinalizeOutput => {
    if (!ctx.reviews) {
      throw new Error(
        'co_review_finalize: the mount did not inject a review store (ctx.reviews absent).',
      );
    }
    if (!ctx.roster) {
      throw new Error(
        'co_review_finalize: the mount did not inject a roster store (ctx.roster absent).',
      );
    }
    assertToolCallerRole('co_review_finalize', ctx.roster, ctx.agent, ['reviewer']);
    const request = ctx.reviews.getReviewRequest(input.target, input.branch);
    if (request == null) {
      throw new Error(
        `co_review_finalize: refused — no matching review request exists for ` +
          `'${input.branch}' into '${input.target}' with review_id '${input.review_id}'.`,
      );
    }
    if (request.reviewId !== input.review_id) {
      // #170: a request row EXISTS for (target,branch) but carries a different (newer) review_id than
      // the caller's — the (target,branch) review was re-requested (e.g. a co_merge re-call minted a
      // fresh review_id) and this reviewer seat is now stale. Recording nothing is correct (the seat
      // is pinned to a superseded id), but it must be SURFACED, not silent: name BOTH ids so the
      // coordinator knows to re-place the reviewer under the current review_id.
      throw new Error(
        `co_review_finalize: refused — your review_id '${input.review_id}' was superseded by a ` +
          `newer review request '${request.reviewId}' for '${input.branch}' into '${input.target}'; ` +
          'this reviewer seat is stale and its verdict cannot be recorded. The coordinator must ' +
          `re-place the reviewer under '${request.reviewId}'.`,
      );
    }
    const scope = input.scope ?? request.scope;
    if (scope !== request.scope) {
      throw new Error(
        `co_review_finalize: refused — verdict scope '${scope}' does not match requested ` +
          `scope '${request.scope}'.`,
      );
    }
    if (request.reviewerKind === 'human') {
      throw new Error(
        `co_review_finalize: refused — review_id '${request.reviewId}' is routed to human ` +
          'review; record the verdict through the operator Review view.',
      );
    }
    const expectedReviewer =
      expectedReviewerFromPlacement(ctx, request) ??
      `${reviewerRoleForScope(
        request.scope,
        resolveReviewerProfiles(ctx.projectId),
      )}@${request.reviewId}`;
    if (ctx.agent !== expectedReviewer) {
      throw new Error(
        `co_review_finalize: refused — assigned reviewer for review_id '${request.reviewId}' is ` +
          `'${expectedReviewer}', not '${ctx.agent}'.`,
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
    const recordedVerdict = {
      reviewId: input.review_id,
      target: input.target,
      branch: input.branch,
      scope,
      reviewer: ctx.agent,
      verdict: input.verdict,
      blockers: input.blockers,
      suggestions: input.suggestions,
      ...(input.verification != null ? { verification: input.verification } : {}),
    };
    const record =
      input.verdict === 'ISSUES'
        ? recordIssuesVerdictAndRelease(ctx.reviews, recordedVerdict, scope)
        : ctx.reviews.recordVerdict(recordedVerdict);
    // #167 reviewer-verdict-wake: the verdict is now durably recorded, but the gate owner
    // (request.requestedBy — the lead/coordinator) is asleep and will never re-call co_merge on its
    // own. Wake it with ONE mail. MAIL_WORKER_DONE is already in isUnreadTurnWakeMail's set (reuse it;
    // do NOT touch the wake set). A deterministic idempotencyKey makes a retried finalize a no-op so we
    // never double-post. Sent AFTER the record so a thrown send can never lose the verdict.
    const verdictDirective =
      record.verdict === 'PASS'
        ? `PASS recorded — re-call co_merge for '${input.branch}' into '${input.target}' to publish.`
        : `ISSUES recorded — address the named blockers (or kick back to the worker) for ` +
          `'${input.branch}' into '${input.target}'; the branch was released.`;
    ctx.mail.send({
      type: MAIL_WORKER_DONE,
      to: request.requestedBy,
      from: ctx.agent,
      subject: `review ${record.verdict}: ${input.branch} into ${input.target}`,
      body:
        `${verdictDirective} (review_id '${record.reviewId}', scope '${scope}', reviewer ` +
        `'${ctx.agent}').`,
      idempotencyKey: `review-verdict-wake:${record.reviewId}`,
    });
    return {
      review_id: record.reviewId,
      verdict: record.verdict,
      recorded: true,
    };
  },
};

function recordIssuesVerdictAndRelease(
  reviews: Pick<ReviewStore, 'recordVerdictAndRelease' | 'getVerdict'>,
  recordedVerdict: Parameters<ReviewStore['recordVerdictAndRelease']>[0],
  scope: ReviewScope,
): NonNullable<ReturnType<ReviewStore['getVerdict']>> {
  reviews.recordVerdictAndRelease(recordedVerdict);
  const record = reviews.getVerdict(recordedVerdict.target, recordedVerdict.branch, scope);
  if (record == null) {
    throw new Error(
      `co_review_finalize: verdict row missing after atomic ISSUES record for ` +
        `'${recordedVerdict.branch}' into '${recordedVerdict.target}'.`,
    );
  }
  return record;
}
