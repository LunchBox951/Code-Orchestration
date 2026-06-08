import type { RepoMode } from './repo-mode.js';
import type { ReviewScope } from '../review/ladder.js';

/**
 * The L5 review-trigger + merge gate — the seam `co_finish` STOPS short of (AC-L3-6, freeze #2), now
 * made REAL in L5. In L3, `co_finish` commits the worktree, records the finish, and emits `worker_done`
 * (informational), then STOPS: it does NOT dispatch a reviewer and it does NOT merge. Triggering the
 * review and the gated merge are L5's job — and this interface is now the typed contract for them
 * (the real implementation is {@link import('../review/merge.js').CoReviewGate}, consumed by `co_merge`).
 *
 * `co_finish` STILL does not call this (unchanged — it stops short by design). The gate is reached
 * through the lead-facing review, merge, push, and PR tools.
 */

/** What {@link FinishReviewGate.triggerReview} records: a request to review `branch` into `target`. */
export interface ReviewTriggerRequest {
  /** The id shared by this review's request + its eventual verdict. */
  readonly reviewId: string;
  /** The merge target the review is for (e.g. `co/l5-review-gate`). */
  readonly target: string;
  /** The reviewed source branch (e.g. `co/l5-phase-a`). */
  readonly branch: string;
  /** Who asked for the review. */
  readonly requestedBy: string;
  /**
   * The review scope — determines the reviewer kind when `projectId` is provided (AC-L5-5).
   * Defaults to `'worker_merge'` when omitted. Additive: existing callers compile unchanged.
   */
  readonly scope?: ReviewScope;
  /**
   * The project id for config resolution. When provided alongside `scope`, the gate reads
   * `review.<scope>.reviewer` from the config cascade and branches on `human` vs `agent`.
   * When absent, the gate defaults to the `agent` path. Additive: existing callers compile unchanged.
   */
  readonly projectId?: string;
  /**
   * The source's acceptance-criteria reference (e.g. a path into `.co/specs/…locked.md#AC-…`).
   * When present and non-empty, the assembled review records `{ kind: 'criteria', ref }`.
   * When absent or empty, the gate records the explicit `{ kind: 'no-locked-spec' }` marker —
   * never a `<TODO>` placeholder (AC-L5-8). Additive: existing callers compile unchanged.
   */
  readonly specRef?: string;
}

/** The recorded-request facts {@link FinishReviewGate.triggerReview} returns (ts persisted by the store). */
export interface ReviewTriggerResult {
  readonly reviewId: string;
  readonly target: string;
  readonly branch: string;
  readonly requestedTs: number;
}

/**
 * What {@link FinishReviewGate.merge} is handed: the reviewed source `branch`, the `into` target it
 * lands on, and the structured merge intent (`summary`/`body`) `co` renders into the house-style merge
 * message (Principle 3 — no provider voice). `projectId`/`repoCwd` locate the program-data store + the
 * git repo.
 */
export interface ReviewMergeRequest {
  readonly branch: string;
  readonly into: string;
  readonly summary: string;
  readonly body?: string;
  readonly projectId: string;
  readonly repoCwd: string;
  /**
   * Audited operator override (AC-L5-6): bypass the recorded-PASS gate. Requires a non-empty
   * {@link reason}; records a `review.override` event and renders `[reviewed: override — <reason>]`.
   */
  readonly operatorOverride?: boolean;
  /** The reason recorded into the `review.override` audit event when {@link operatorOverride} is set. */
  readonly reason?: string;
}

/** The structured result of a gated merge — the merge commit's facts + the repo mode it ran in. */
export interface ReviewMergeResult {
  readonly merged: boolean;
  readonly commitSha: string;
  readonly commitMessage: string;
  readonly mode: RepoMode;
  /** Present when the PASS carried pre-existing baseline failures (flag — never silent, AC-L5-3). */
  readonly baselineFailures?: readonly string[];
  /** True when a baseline-failure escalation mail was emitted (requires mail + parentResolver seam). */
  readonly escalated?: boolean;
  /** True when the PASS gate was bypassed by an audited operator override (AC-L5-6). */
  readonly overridden?: boolean;
  /** The recorded override reason, present when {@link overridden}. */
  readonly overrideReason?: string;
  /**
   * Present only when a merge-time teardown trigger was wired (AC-L5-7): true once the merged branch's
   * sandbox was torn down AFTER the merge was recorded; false when the teardown trigger failed (the
   * merge still succeeded — a teardown failure never masks it, the review-finalize regression cure).
   */
  readonly toreDown?: boolean;
}

/**
 * The L5 review gate. Both methods are REAL (no longer `: never`):
 *
 *   - `triggerReview` records a `review.requested` for a branch on a target (the request flow's real
 *     consumer is Phase E; the recorder is real now).
 *   - `merge` enacts the **gated** merge — it refuses unless a `PASS` verdict is recorded for the
 *     branch on the target (AC-L5-1), renders the house-style merge message, and enacts owner/offline
 *     via {@link import('./repo-mode.js').CoRepoModeGate}. Contributor mode publishes through the
 *     gated push/PR path rather than local merge.
 */
export interface FinishReviewGate {
  triggerReview(req: ReviewTriggerRequest): ReviewTriggerResult;
  merge(req: ReviewMergeRequest): ReviewMergeResult;
}
