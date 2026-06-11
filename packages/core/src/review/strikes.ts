import { openConfigStore, type ConfigStore } from '../config/config-store.js';
import { escalate, type ParentResolver } from '../mail/escalation.js';
import type { MailStore } from '../mail/mail-store.js';
import type { ReviewStrike, ReviewVerdictRecord } from './events.js';
import type { Blocker } from './verdict.js';

/** Config key for the consecutive-ISSUES budget (tunable per project). */
export const REVIEW_ROUND_BUDGET_KEY = 'review_round_budget' as const;

/** Default consecutive-ISSUES budget before the loop escalates instead of kicking back. */
export const REVIEW_ROUND_BUDGET_DEFAULT = 3;

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

/** Resolve the configured review-round budget for a project, defaulting to 3 when unset. */
export function resolveReviewRoundBudget(projectId: string, config?: ConfigStore): number {
  const store = config ?? openConfigStore();
  const ownsStore = config == null;
  try {
    const effective = store.resolveEffective(projectId);
    if (!Object.prototype.hasOwnProperty.call(effective, REVIEW_ROUND_BUDGET_KEY)) {
      return REVIEW_ROUND_BUDGET_DEFAULT;
    }
    const raw = effective[REVIEW_ROUND_BUDGET_KEY];
    if (!Number.isInteger(raw) || Number(raw) < 1) {
      throw new Error(
        `${REVIEW_ROUND_BUDGET_KEY}: expected a positive integer review-round budget.`,
      );
    }
    return Number(raw);
  } finally {
    if (ownsStore) store.close();
  }
}

/** Minimal store seam the enforcement function requires — subset of ReviewStore. */
interface StrikeStore {
  recordStrike(s: ReviewStrike): void;
  getStrikeCount(target: string, branch: string): number;
  hasStrike(target: string, branch: string, reviewId: string): boolean;
}

/** Injectable seams for {@link applyStrikePolicy}. */
export interface StrikeEnforcementDeps {
  readonly reviews: StrikeStore;
  readonly mail: MailStore;
  readonly resolver: ParentResolver;
  readonly agentId: string;
  readonly budget: number;
  /**
   * Optional notification hook for callers that need to notify before the strike is persisted.
   * If supplied, it owns any kickback/escalation notification for the planned action; a thrown
   * notification prevents the strike from being recorded.
   */
  readonly beforeRecordStrike?: (plan: StrikeNotificationPlan) => void;
}

/** Per-verdict context for {@link applyStrikePolicy}. */
export interface StrikeEnforcementContext {
  readonly reviewId: string;
  readonly target: string;
  readonly branch: string;
  readonly blockers: readonly Blocker[];
}

export interface StrikeNotificationPlan {
  readonly action: 'kickback' | 'escalate';
  readonly strikeCount: number;
  readonly fireEscalation: boolean;
  readonly reason: string;
  readonly target: string;
  readonly branch: string;
}

export type StrikePolicyAction = 'kickback' | 'escalate' | 'already_struck';

/**
 * Record a strike for a freshly-recorded ISSUES verdict and decide whether to kick back or
 * escalate (AC-L5-4). Steps:
 *   1. Plans the next strike count from the current read-model.
 *   2. Optionally runs a caller-supplied notification hook BEFORE recording the strike.
 *   3. Appends a `review.strike` event (reason = summarized blockers).
 *   4. Returns `kickback` if count < budget; fires exactly ONE escalation mail to the spawning
 *      parent and returns `escalate` when count first reaches budget; returns `escalate` without
 *      re-firing for any count beyond budget (idempotent over the already-escalated run).
 *
 * A subsequent PASS resets the count to 0 (via the projector), so ISSUES×N < budget, PASS,
 * ISSUES×M never escalates regardless of N+M.
 */
export function applyStrikePolicy(
  deps: StrikeEnforcementDeps,
  ctx: StrikeEnforcementContext,
): StrikePolicyAction {
  const reason =
    ctx.blockers.length > 0
      ? ctx.blockers.map((b) => b.summary).join('; ')
      : 'ISSUES verdict (no named blockers)';

  if (deps.reviews.hasStrike(ctx.target, ctx.branch, ctx.reviewId)) {
    return 'already_struck';
  }

  const count = deps.reviews.getStrikeCount(ctx.target, ctx.branch) + 1;
  const action = nextReviewAction(count, deps.budget);
  const fireEscalation = action === 'escalate' && count === deps.budget;

  deps.beforeRecordStrike?.({
    action,
    strikeCount: count,
    fireEscalation,
    reason,
    target: ctx.target,
    branch: ctx.branch,
  });

  // Fire exactly one escalation when the count first reaches the budget threshold. It runs before
  // the strike is recorded so a failed delivery cannot consume the pressure-release signal.
  if (deps.beforeRecordStrike == null && fireEscalation) {
    escalate(deps.mail, deps.resolver, {
      from: deps.agentId,
      subject: `review strike budget reached for '${ctx.branch}' into '${ctx.target}' (${count}/${deps.budget})`,
      body:
        `The branch '${ctx.branch}' has accumulated ${count} consecutive ISSUES verdict(s) ` +
        `(budget: ${deps.budget}) into '${ctx.target}'. The review loop stops kicking back. ` +
        `Blockers: ${reason}.`,
      idempotencyKey: `review-strike-escalation:${ctx.target}:${ctx.branch}:${ctx.reviewId}`,
    });
  }

  deps.reviews.recordStrike({
    reviewId: ctx.reviewId,
    target: ctx.target,
    branch: ctx.branch,
    reason,
  });

  return action;
}
