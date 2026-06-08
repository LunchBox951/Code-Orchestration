import { escalate, type ParentResolver } from '../mail/escalation.js';
import type { MailStore } from '../mail/mail-store.js';
import type { ReviewStrike, ReviewVerdictRecord } from './events.js';
import type { Blocker } from './verdict.js';

/** Config key for the consecutive-ISSUES budget (tunable per project). */
export const REVIEW_ROUND_BUDGET_KEY = 'review_round_budget' as const;

/** Default consecutive-ISSUES budget before the loop escalates instead of kicking back. */
export const REVIEW_ROUND_BUDGET_DEFAULT = 5;

/**
 * Counts the trailing run of consecutive `ISSUES` verdicts in `verdicts` (oldest-first).
 * A `PASS` anywhere in the trailing run resets the count to 0 and stops the scan.
 * Pure, deterministic, no I/O.
 */
export function consecutiveStrikes(verdicts: readonly ReviewVerdictRecord[]): number {
  let count = 0;
  for (let i = verdicts.length - 1; i >= 0; i--) {
    if (verdicts[i]!.verdict === 'ISSUES') {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/**
 * Pure decision: given a strike count and the configured budget, return whether the loop should
 * kick back (count below budget) or escalate (count at or beyond budget). No I/O, no clock.
 */
export function nextReviewAction(strikeCount: number, budget: number): 'kickback' | 'escalate' {
  return strikeCount >= budget ? 'escalate' : 'kickback';
}

/** Minimal store seam the enforcement function requires — subset of ReviewStore. */
interface StrikeStore {
  recordStrike(s: ReviewStrike): void;
  getStrikeCount(target: string, branch: string): number;
}

/** Injectable seams for {@link applyStrikePolicy}. */
export interface StrikeEnforcementDeps {
  readonly reviews: StrikeStore;
  readonly mail: MailStore;
  readonly resolver: ParentResolver;
  readonly agentId: string;
  readonly budget: number;
}

/** Per-verdict context for {@link applyStrikePolicy}. */
export interface StrikeEnforcementContext {
  readonly reviewId: string;
  readonly target: string;
  readonly branch: string;
  readonly blockers: readonly Blocker[];
}

/**
 * Record a strike for a freshly-recorded ISSUES verdict and decide whether to kick back or
 * escalate (AC-L5-4). Steps:
 *   1. Appends a `review.strike` event (reason = summarized blockers).
 *   2. Reads the updated consecutive count from the read-model.
 *   3. Returns `kickback` if count < budget; fires exactly ONE escalation mail to the spawning
 *      parent and returns `escalate` when count first reaches budget; returns `escalate` without
 *      re-firing for any count beyond budget (idempotent over the already-escalated run).
 *
 * A subsequent PASS resets the count to 0 (via the projector), so ISSUES×N < budget, PASS,
 * ISSUES×M never escalates regardless of N+M.
 */
export function applyStrikePolicy(
  deps: StrikeEnforcementDeps,
  ctx: StrikeEnforcementContext,
): 'kickback' | 'escalate' {
  const reason =
    ctx.blockers.length > 0
      ? ctx.blockers.map((b) => b.summary).join('; ')
      : 'ISSUES verdict (no named blockers)';

  deps.reviews.recordStrike({
    reviewId: ctx.reviewId,
    target: ctx.target,
    branch: ctx.branch,
    reason,
  });

  const count = deps.reviews.getStrikeCount(ctx.target, ctx.branch);
  const action = nextReviewAction(count, deps.budget);

  // Fire exactly one escalation when the count first reaches the budget threshold.
  if (action === 'escalate' && count === deps.budget) {
    escalate(deps.mail, deps.resolver, {
      from: deps.agentId,
      subject: `review strike budget reached for '${ctx.branch}' into '${ctx.target}' (${count}/${deps.budget})`,
      body:
        `The branch '${ctx.branch}' has accumulated ${count} consecutive ISSUES verdict(s) ` +
        `(budget: ${deps.budget}) into '${ctx.target}'. The review loop stops kicking back. ` +
        `Blockers: ${reason}.`,
    });
  }

  return action;
}
