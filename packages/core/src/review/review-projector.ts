import type { DatabaseSync } from 'node:sqlite';
import { assertNever } from '../assert-never.js';
import type { Projector } from '../replay/projector.js';
import type { StoredEvent, StoreTx } from '../store/types.js';
import {
  blockerSchema,
  suggestionSchema,
  verdictSchema,
  verificationMarkerSchema,
} from './verdict.js';
import {
  EVENT_MERGE_SERIALIZED,
  EVENT_REVIEW_OVERRIDE,
  EVENT_REVIEW_REQUESTED,
  EVENT_REVIEW_STRIKE,
  EVENT_REVIEW_VERDICT,
  type MergeSerialized,
  type ReviewOverride,
  type ReviewRequested,
  type ReviewStrike,
  type ReviewVerdictRecord,
  type ReviewVerdictRecorded,
  type ReviewRequestRecord,
} from './events.js';

/**
 * The L5 read-model: one `reviews` row per `(target, branch)` review, accumulating the lifecycle of a
 * branch's review INTO a target. Every column is log-derived, so a `rebuildAll` reproduces the table
 * byte-identical (AC-L5-11 / freeze #6): `verdict_ts` / `requested_ts` come from the PERSISTED event
 * ts, and the `blockers`/`suggestions`/`verification` arrays are stored as the deterministic JSON of
 * the validated value (stable key order).
 *
 * The projector folds ALL FIVE L5 event types now, even though Phase A only WRITES `review.verdict`
 * (and a minimal `review.requested`). Folding `review.strike` (→ `strikes` counter), `merge.serialized`
 * (→ `serialized` flag), and `review.override` (→ `overridden`/`override_*`) now is read-model PLUMBING
 * — the ENFORCEMENT that consumes these columns (3-strike = D, the merge mutex + override verb = F) is a
 * later phase. Folding them now keeps the projector stable so B–F add only WRITERS, never reshape the
 * table (which would break replay-equality). All five UPSERT on `(target, branch)`, so each event sets
 * only the columns it owns and a replay in seq order reaches the same final row.
 */
const CREATE_REVIEW_TABLES = `
  CREATE TABLE IF NOT EXISTS reviews (
    target          TEXT NOT NULL,
    branch          TEXT NOT NULL,
    review_id       TEXT,
    verdict         TEXT,
    blockers        TEXT,
    suggestions     TEXT,
    verification    TEXT,
    reviewer        TEXT,
    verdict_ts      INTEGER,
    requested_by    TEXT,
    requested_ts    INTEGER,
    strikes         INTEGER NOT NULL DEFAULT 0,
    serialized      INTEGER NOT NULL DEFAULT 0,
    overridden      INTEGER NOT NULL DEFAULT 0,
    override_reason TEXT,
    override_by     TEXT,
    PRIMARY KEY (target, branch)
  );
`;

/**
 * Defensive create of the L5 read-model table. Called from the projector's reset/apply AND every read
 * path, so a freshly opened store can be queried before any write has happened.
 */
export function ensureReviewTables(db: DatabaseSync): void {
  db.exec(CREATE_REVIEW_TABLES);
}

// `handles()` guarantees only these five types reach `apply()`; modelling them as a StoredEvent
// subtype lets the switch be GENUINELY exhaustive (assertNever sees a real `never`), mirroring
// worktrees/worktree-projector.ts.
interface ReviewRequestedEvent extends StoredEvent {
  readonly type: typeof EVENT_REVIEW_REQUESTED;
  readonly payload: ReviewRequested;
}
interface ReviewVerdictEvent extends StoredEvent {
  readonly type: typeof EVENT_REVIEW_VERDICT;
  readonly payload: ReviewVerdictRecorded;
}
interface ReviewStrikeEvent extends StoredEvent {
  readonly type: typeof EVENT_REVIEW_STRIKE;
  readonly payload: ReviewStrike;
}
interface MergeSerializedEvent extends StoredEvent {
  readonly type: typeof EVENT_MERGE_SERIALIZED;
  readonly payload: MergeSerialized;
}
interface ReviewOverrideEvent extends StoredEvent {
  readonly type: typeof EVENT_REVIEW_OVERRIDE;
  readonly payload: ReviewOverride;
}
type ReviewEvent =
  | ReviewRequestedEvent
  | ReviewVerdictEvent
  | ReviewStrikeEvent
  | MergeSerializedEvent
  | ReviewOverrideEvent;

/** Map a raw `reviews` row to a {@link ReviewVerdictRecord} (the JSON columns are parsed back). */
export function rowToReviewVerdictRecord(row: Record<string, unknown>): ReviewVerdictRecord {
  const verification =
    row.verification != null
      ? verificationMarkerSchema.parse(JSON.parse(String(row.verification)))
      : undefined;
  return {
    reviewId: String(row.review_id),
    target: String(row.target),
    branch: String(row.branch),
    reviewer: String(row.reviewer),
    verdict: verdictSchema.parse(String(row.verdict)),
    blockers: blockerSchema.array().parse(JSON.parse(String(row.blockers))),
    suggestions: suggestionSchema.array().parse(JSON.parse(String(row.suggestions))),
    recordedTs: Number(row.verdict_ts),
    ...(verification !== undefined ? { verification } : {}),
  };
}

/** Map a raw `reviews` row to a {@link ReviewRequestRecord}. */
export function rowToReviewRequestRecord(row: Record<string, unknown>): ReviewRequestRecord {
  return {
    reviewId: String(row.review_id),
    target: String(row.target),
    branch: String(row.branch),
    requestedBy: String(row.requested_by),
    requestedTs: Number(row.requested_ts),
  };
}

const REVIEW_COLUMNS =
  'target, branch, review_id, verdict, blockers, suggestions, verification, reviewer, verdict_ts, ' +
  'requested_by, requested_ts, strikes, serialized, overridden, override_reason, override_by';

/** The latest recorded verdict for `branch` on `target`, or undefined (no verdict folded yet). */
export function selectVerdict(
  db: DatabaseSync,
  target: string,
  branch: string,
): ReviewVerdictRecord | undefined {
  ensureReviewTables(db);
  const row = db
    .prepare(
      `SELECT ${REVIEW_COLUMNS} FROM reviews WHERE target = ? AND branch = ? AND verdict IS NOT NULL`,
    )
    .get(target, branch);
  return row ? rowToReviewVerdictRecord(row as Record<string, unknown>) : undefined;
}

/** Every recorded verdict on `target`, oldest-recorded first (then branch for a stable tie-break). */
export function selectVerdictsForTarget(db: DatabaseSync, target: string): ReviewVerdictRecord[] {
  ensureReviewTables(db);
  const rows = db
    .prepare(
      `SELECT ${REVIEW_COLUMNS} FROM reviews WHERE target = ? AND verdict IS NOT NULL ` +
        'ORDER BY verdict_ts, branch',
    )
    .all(target);
  return rows.map((r) => rowToReviewVerdictRecord(r as Record<string, unknown>));
}

/** The latest review request for `branch` on `target`, or undefined (no request folded yet). */
export function selectReviewRequest(
  db: DatabaseSync,
  target: string,
  branch: string,
): ReviewRequestRecord | undefined {
  ensureReviewTables(db);
  const row = db
    .prepare(
      `SELECT ${REVIEW_COLUMNS} FROM reviews WHERE target = ? AND branch = ? AND requested_ts IS NOT NULL`,
    )
    .get(target, branch);
  return row ? rowToReviewRequestRecord(row as Record<string, unknown>) : undefined;
}

/**
 * Folds the five L5 review events into the `reviews` read-model, in the SAME tx as the append so the
 * log and the projection commit atomically; carries NO wall-clock field (freeze #6 — it persists the
 * event ts). Each event UPSERTs on `(target, branch)`, touching only its own columns, so a verdict
 * after a request (or vice versa) never clobbers the other's facts and a replay reaches the same row.
 */
export class ReviewProjector implements Projector {
  readonly name = 'reviews';

  handles(type: string): boolean {
    return (
      type === EVENT_REVIEW_REQUESTED ||
      type === EVENT_REVIEW_VERDICT ||
      type === EVENT_REVIEW_STRIKE ||
      type === EVENT_MERGE_SERIALIZED ||
      type === EVENT_REVIEW_OVERRIDE
    );
  }

  reset(tx: StoreTx): void {
    const db = tx.raw as DatabaseSync;
    ensureReviewTables(db);
    db.exec('DELETE FROM reviews');
  }

  apply(tx: StoreTx, event: StoredEvent): void {
    const db = tx.raw as DatabaseSync;
    ensureReviewTables(db);
    const reviewEvent = event as ReviewEvent;
    switch (reviewEvent.type) {
      case EVENT_REVIEW_REQUESTED: {
        const { reviewId, target, branch, requestedBy } = reviewEvent.payload;
        db.prepare(
          `INSERT INTO reviews (target, branch, review_id, requested_by, requested_ts)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(target, branch) DO UPDATE SET
             review_id = excluded.review_id,
             requested_by = excluded.requested_by,
             requested_ts = excluded.requested_ts`,
        ).run(target, branch, reviewId, requestedBy, event.ts);
        return;
      }
      case EVENT_REVIEW_VERDICT: {
        const { reviewId, target, branch, reviewer, verdict, blockers, suggestions, verification } =
          reviewEvent.payload;
        // Persist the validated arrays' deterministic JSON (stable key order), so a rebuild reproduces
        // the same bytes. UPSERT (last verdict wins): a re-review after an ISSUES→fix re-records, and a
        // replay in seq order reaches the same final row. event.ts is the persisted record time.
        db.prepare(
          `INSERT INTO reviews
             (target, branch, review_id, verdict, blockers, suggestions, verification, reviewer, verdict_ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(target, branch) DO UPDATE SET
             review_id = excluded.review_id,
             verdict = excluded.verdict,
             blockers = excluded.blockers,
             suggestions = excluded.suggestions,
             verification = excluded.verification,
             reviewer = excluded.reviewer,
             verdict_ts = excluded.verdict_ts`,
        ).run(
          target,
          branch,
          reviewId,
          verdict,
          JSON.stringify(blockers),
          JSON.stringify(suggestions),
          verification != null ? JSON.stringify(verification) : null,
          reviewer,
          event.ts,
        );
        return;
      }
      case EVENT_REVIEW_STRIKE: {
        const { reviewId, target, branch } = reviewEvent.payload;
        // Read-model plumbing (Phase D writer): a fresh row starts at one strike; an existing row bumps
        // the counter. The count is order-independent, so a replay reaches the same total.
        db.prepare(
          `INSERT INTO reviews (target, branch, review_id, strikes)
           VALUES (?, ?, ?, 1)
           ON CONFLICT(target, branch) DO UPDATE SET strikes = strikes + 1`,
        ).run(target, branch, reviewId);
        return;
      }
      case EVENT_MERGE_SERIALIZED: {
        const { target, branch } = reviewEvent.payload;
        // Read-model plumbing (Phase F writer): mark the merge serialized. Idempotent + replay-safe.
        db.prepare(
          `INSERT INTO reviews (target, branch, serialized)
           VALUES (?, ?, 1)
           ON CONFLICT(target, branch) DO UPDATE SET serialized = 1`,
        ).run(target, branch);
        return;
      }
      case EVENT_REVIEW_OVERRIDE: {
        const { target, branch, reason, overriddenBy } = reviewEvent.payload;
        // Read-model plumbing (Phase F writer): mark the PASS gate overridden + record the reason/who.
        db.prepare(
          `INSERT INTO reviews (target, branch, overridden, override_reason, override_by)
           VALUES (?, ?, 1, ?, ?)
           ON CONFLICT(target, branch) DO UPDATE SET
             overridden = 1,
             override_reason = excluded.override_reason,
             override_by = excluded.override_by`,
        ).run(target, branch, reason, overriddenBy);
        return;
      }
      default:
        return assertNever(reviewEvent);
    }
  }
}
