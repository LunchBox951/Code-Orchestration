import { z } from 'zod';
import type { NewEvent } from '../store/types.js';
import type { SchemaMap } from '../replay/decode.js';
import type { UpcasterRegistry } from '../replay/upcaster.js';
import type { ReviewScope } from './ladder.js';
import type { ReviewSpecRef } from './spec-ref.js';
import {
  assertValidVerdict,
  blockerSchema,
  suggestionSchema,
  verdictSchema,
  verificationMarkerSchema,
  type Blocker,
  type Suggestion,
  type Verdict,
  type VerificationMarker,
} from './verdict.js';

/**
 * L5 review-gate events live in the PROJECT store (one per registered project), exactly like the L1
 * mail events and the L3 worktree events — the owning envelope `projectId` is the real project id
 * (the store owner). They are pure ORCHESTRATION state: who requested a review, the recorded verdict,
 * the strike count, the merge serialization, and the override. None of it ever touches the target repo
 * (Principle 12 — pristine-repo); it lives only in program-data.
 *
 * One stream per MERGE TARGET, keyed via the L0 `${entity}:${id}` scope pattern: `review:<target>`
 * (e.g. `review:co/l5-review-gate`). A target's stream holds every review event for every branch being
 * reviewed INTO it; the read-model rows are keyed by `(target, branch)`.
 *
 * The event types are DOTTED (`review.requested`, `review.verdict`, `merge.serialized`, …) to mark them
 * as L0-style infrastructure events, mirroring `worktree.created` / `config.set`.
 *
 * **ALL FIVE** L5 event types are defined now even though this phase only WRITES `review.verdict` (and
 * a minimal `review.requested`): defining the schemas + folding them now keeps the projector stable and
 * replay-deterministic across phases B–F, which add only the WRITERS for the events they own
 * (`review.strike` = D, `merge.serialized` + `review.override` = F).
 */

/** Current payload schema version — v1; no upcasters yet (an empty chain is the identity upcast). */
export const REVIEW_EVENT_V = 1;

/** A review was requested for a branch on a target (the request flow's real consumer is Phase E). */
export const EVENT_REVIEW_REQUESTED = 'review.requested' as const;
/** A reviewer recorded a structured `PASS`/`ISSUES` verdict (this phase's primary write). */
export const EVENT_REVIEW_VERDICT = 'review.verdict' as const;
/** A strike was recorded against a branch (the 3-strike escalation is Phase D — writer is D's). */
export const EVENT_REVIEW_STRIKE = 'review.strike' as const;
/** A merge into a target was serialized (the merge mutex/ordering is Phase F — writer is F's). */
export const EVENT_MERGE_SERIALIZED = 'merge.serialized' as const;
/** A recorded PASS-gate override (the human/lead override is Phase F — writer is F's). */
export const EVENT_REVIEW_OVERRIDE = 'review.override' as const;

/** Valid review verdict scopes. Optional on old events; readers default absent scope to worker_merge. */
export const reviewScopeValueSchema = z.enum(['worker_merge', 'phase_merge', 'pr_merge']);

/** Scope prefix shared by every target's review stream; the suffix is the merge target. */
export const REVIEW_SCOPE_PREFIX = 'review:';

/** A target's review stream scope: `review:<target>`. */
export function reviewScope(target: string): string {
  return REVIEW_SCOPE_PREFIX + target;
}

/**
 * Derive the merge target from a review scope: `review:co/l5-review-gate` → `co/l5-review-gate`. Fails
 * loud (Principle 9) on an unexpected/empty scope rather than silently folding into the wrong target
 * (mirrors `mail/events.ts` `mailRecipientForScope` and `worktrees/events.ts`).
 */
export function reviewTargetForScope(scope: string): string {
  if (!scope.startsWith(REVIEW_SCOPE_PREFIX)) {
    throw new Error(`review: unexpected scope '${scope}' (want '${REVIEW_SCOPE_PREFIX}…')`);
  }
  const target = scope.slice(REVIEW_SCOPE_PREFIX.length);
  if (target.length === 0) {
    throw new Error(`review: empty target in scope '${scope}'`);
  }
  return target;
}

/**
 * The `review.requested` payload: who asked for a review of `branch` into `target`, tagged with the
 * `reviewId` the request/verdict cycle shares, and the resolved spec-ref (AC-L5-8 — criteria
 * reference or the explicit `no-locked-spec` marker, never a `<TODO>` placeholder). Phase E owns
 * the real request lifecycle; this is the minimal recorder kept now so the schema + fold are stable.
 * `specRefKind`/`specRefRef` are optional for backward-compat replay of pre-Phase-G events.
 */
export const reviewRequestedSchema = z.object({
  reviewId: z.string().min(1),
  target: z.string().min(1),
  branch: z.string().min(1),
  /** The strictness scope this request asks the reviewer to apply. Optional for replay compatibility. */
  scope: reviewScopeValueSchema.optional(),
  requestedBy: z.string().min(1),
  /** `'criteria'` when a locked spec was provided; `'no-locked-spec'` when absent. Optional for replay compat. */
  specRefKind: z.enum(['criteria', 'no-locked-spec']).optional(),
  /** The acceptance-criteria reference string; present only when `specRefKind === 'criteria'`. */
  specRefRef: z.string().min(1).optional(),
});
export type ReviewRequested = z.infer<typeof reviewRequestedSchema>;

/**
 * The `review.verdict` payload: the structured verdict (Principle 5 — never a prose blob) plus the
 * reviewed `branch`/`target`, the `reviewId`, and the `reviewer` agent id. The `verdict`/`blockers`/
 * `suggestions`/optional `verification` are the {@link import('./verdict.js').ReviewVerdict} shape; the
 * builder runs {@link assertValidVerdict} so an `{verdict:'ISSUES', blockers:[]}` can never persist.
 */
export const reviewVerdictRecordedSchema = z.object({
  reviewId: z.string().min(1),
  target: z.string().min(1),
  branch: z.string().min(1),
  /** The strictness scope the verdict was recorded under. Optional for replay compatibility. */
  scope: reviewScopeValueSchema.optional(),
  reviewer: z.string().min(1),
  verdict: verdictSchema,
  blockers: z.array(blockerSchema),
  suggestions: z.array(suggestionSchema),
  verification: verificationMarkerSchema.optional(),
});
export type ReviewVerdictRecorded = z.infer<typeof reviewVerdictRecordedSchema>;

/**
 * The `review.strike` payload (Phase D writer): a strike against `branch` on `target` with a named
 * reason. Defined + folded now (strike COUNT is read-model plumbing); the 3-strike ENFORCEMENT is D.
 */
export const reviewStrikeSchema = z.object({
  reviewId: z.string().min(1),
  target: z.string().min(1),
  branch: z.string().min(1),
  reason: z.string().min(1),
});
export type ReviewStrike = z.infer<typeof reviewStrikeSchema>;

/**
 * The `merge.serialized` payload (Phase F writer): a merge of `branch` into `target` was serialized.
 * Defined + folded now (the `serialized` flag is read-model plumbing); the merge mutex/ordering is F.
 */
export const mergeSerializedSchema = z.object({
  target: z.string().min(1),
  branch: z.string().min(1),
});
export type MergeSerialized = z.infer<typeof mergeSerializedSchema>;

/**
 * The `review.override` payload (Phase F writer): a recorded override of the PASS gate for `branch`
 * into `target`, with the reason rendered into the merge message `[reviewed: override — <reason>]` and
 * who authorized it. Defined + folded now (the `overridden` flag is read-model plumbing); the override
 * VERB + the override merge-message path are F.
 */
export const reviewOverrideSchema = z.object({
  target: z.string().min(1),
  branch: z.string().min(1),
  reason: z.string().min(1),
  overriddenBy: z.string().min(1),
});
export type ReviewOverride = z.infer<typeof reviewOverrideSchema>;

/** Current-version schema per L5 review event type — validated on append AND on read (decode). */
export const reviewSchemas: SchemaMap = new Map<string, z.ZodType>([
  [EVENT_REVIEW_REQUESTED, reviewRequestedSchema],
  [EVENT_REVIEW_VERDICT, reviewVerdictRecordedSchema],
  [EVENT_REVIEW_STRIKE, reviewStrikeSchema],
  [EVENT_MERGE_SERIALIZED, mergeSerializedSchema],
  [EVENT_REVIEW_OVERRIDE, reviewOverrideSchema],
]);

/** No payload migrations at v1 (an empty chain is the identity upcast). */
export const reviewUpcasters: UpcasterRegistry = new Map();

/**
 * Build + validate a `review.requested` `NewEvent`, keyed on the target's review stream scope. The
 * requester lands on the event `actor` (the L0 reserved field), mirroring how a mail's sender does.
 */
export function makeReviewRequestedEvent(projectId: string, r: ReviewRequested): NewEvent {
  const payload = reviewRequestedSchema.parse(r);
  return {
    projectId,
    scope: reviewScope(payload.target),
    type: EVENT_REVIEW_REQUESTED,
    v: REVIEW_EVENT_V,
    payload,
    actor: payload.requestedBy,
  };
}

/**
 * Build + validate a `review.verdict` `NewEvent`, keyed on the target's review stream scope. It runs
 * {@link assertValidVerdict} AFTER the zod parse so the AC-L5-1 cross-field invariant is enforced at
 * the event boundary too — an invalid verdict can never reach the log. The reviewer lands on `actor`.
 */
export function makeReviewVerdictEvent(projectId: string, v: ReviewVerdictRecorded): NewEvent {
  const payload = reviewVerdictRecordedSchema.parse(v);
  assertValidVerdict(payload);
  return {
    projectId,
    scope: reviewScope(payload.target),
    type: EVENT_REVIEW_VERDICT,
    v: REVIEW_EVENT_V,
    payload,
    actor: payload.reviewer,
  };
}

/** Build + validate a `review.strike` `NewEvent`, keyed on the target's review stream scope. */
export function makeReviewStrikeEvent(projectId: string, s: ReviewStrike): NewEvent {
  const payload = reviewStrikeSchema.parse(s);
  return {
    projectId,
    scope: reviewScope(payload.target),
    type: EVENT_REVIEW_STRIKE,
    v: REVIEW_EVENT_V,
    payload,
  };
}

/** Build + validate a `merge.serialized` `NewEvent`, keyed on the target's review stream scope. */
export function makeMergeSerializedEvent(projectId: string, m: MergeSerialized): NewEvent {
  const payload = mergeSerializedSchema.parse(m);
  return {
    projectId,
    scope: reviewScope(payload.target),
    type: EVENT_MERGE_SERIALIZED,
    v: REVIEW_EVENT_V,
    payload,
  };
}

/** Build + validate a `review.override` `NewEvent`, keyed on the target's review stream scope. */
export function makeReviewOverrideEvent(projectId: string, o: ReviewOverride): NewEvent {
  const payload = reviewOverrideSchema.parse(o);
  return {
    projectId,
    scope: reviewScope(payload.target),
    type: EVENT_REVIEW_OVERRIDE,
    v: REVIEW_EVENT_V,
    payload,
    actor: payload.overriddenBy,
  };
}

/**
 * A persisted, read-back verdict — the read-model shape `getVerdict`/`listVerdicts` return.
 * `recordedTs` is the PERSISTED event ts (never wall-clock on read). The structured verdict facts
 * are returned exactly as recorded (Principle 5).
 */
export interface ReviewVerdictRecord {
  readonly reviewId: string;
  readonly target: string;
  readonly branch: string;
  readonly scope: ReviewScope;
  readonly reviewer: string;
  readonly verdict: Verdict;
  readonly blockers: readonly Blocker[];
  readonly suggestions: readonly Suggestion[];
  readonly verification?: VerificationMarker;
  readonly recordedTs: number;
}

/**
 * A persisted, read-back review request — the read-model shape `getReviewRequest` returns.
 * `requestedTs` is the PERSISTED event ts. `specRef` carries the resolved spec-reference or the
 * explicit `no-locked-spec` marker (AC-L5-8 — never `<TODO>`). Minimal now; Phase E grows the
 * request lifecycle.
 */
export interface ReviewRequestRecord {
  readonly reviewId: string;
  readonly target: string;
  readonly branch: string;
  readonly scope: ReviewScope;
  readonly requestedBy: string;
  readonly requestedTs: number;
  /** The resolved spec reference — criteria ref or explicit `no-locked-spec` marker (AC-L5-8). */
  readonly specRef: ReviewSpecRef;
}
