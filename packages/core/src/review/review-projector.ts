import type { DatabaseSync } from 'node:sqlite';
import { assertNever } from '../assert-never.js';
import type { Projector } from '../replay/projector.js';
import type { StoredEvent, StoreTx } from '../store/types.js';
import type { ReviewScope } from './ladder.js';
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
import type { ReviewSpecRef } from './spec-ref.js';

/**
 * The L5 read-model: one `reviews` row per `(target, branch)` review, accumulating the lifecycle of a
 * branch's review INTO a target. Every column is log-derived, so a `rebuildAll` reproduces the table
 * byte-identical (AC-L5-11 / freeze #6): `verdict_ts` / `requested_ts` come from the PERSISTED event
 * ts, and the `blockers`/`suggestions`/`verification` arrays are stored as the deterministic JSON of
 * the validated value (stable key order).
 *
 * The projector folds ALL FIVE L5 event types: `review.requested`, `review.verdict`, `review.strike`,
 * `merge.serialized`, and `review.override`. Folding every lifecycle event through one read-model keeps
 * the gate replay-deterministic and lets each event touch only the columns it owns. All five UPSERT on
 * `(target, branch)`, so a replay in seq order reaches the same final row.
 */
const CREATE_REVIEW_TABLES = `
  CREATE TABLE IF NOT EXISTS reviews (
    target          TEXT NOT NULL,
    branch          TEXT NOT NULL,
    scope           TEXT NOT NULL DEFAULT 'worker_merge',
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
    spec_ref_kind   TEXT,
    spec_ref_ref    TEXT,
    PRIMARY KEY (target, branch)
  );
`;

/**
 * Defensive create of the L5 read-model table. Called from the projector's reset/apply AND every read
 * path, so a freshly opened store can be queried before any write has happened.
 */
export function ensureReviewTables(db: DatabaseSync): void {
  db.exec(CREATE_REVIEW_TABLES);
  addMissingReviewColumn(db, 'scope', "TEXT NOT NULL DEFAULT 'worker_merge'");
  addMissingReviewColumn(db, 'spec_ref_kind', 'TEXT');
  addMissingReviewColumn(db, 'spec_ref_ref', 'TEXT');
}

function addMissingReviewColumn(db: DatabaseSync, column: string, definition: string): void {
  const columns = db.prepare('PRAGMA table_info(reviews)').all() as Array<{
    readonly name: string;
  }>;
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE reviews ADD COLUMN ${column} ${definition}`);
  }
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
    scope: (row.scope != null ? String(row.scope) : 'worker_merge') as ReviewScope,
    reviewer: String(row.reviewer),
    verdict: verdictSchema.parse(String(row.verdict)),
    blockers: blockerSchema.array().parse(JSON.parse(String(row.blockers))),
    suggestions: suggestionSchema.array().parse(JSON.parse(String(row.suggestions))),
    recordedTs: Number(row.verdict_ts),
    ...(verification !== undefined ? { verification } : {}),
  };
}

/** Rebuild the `ReviewSpecRef` from `spec_ref_kind`/`spec_ref_ref` columns (default: `no-locked-spec`). */
function rowToSpecRef(row: Record<string, unknown>): ReviewSpecRef {
  if (row.spec_ref_kind === 'criteria' && typeof row.spec_ref_ref === 'string') {
    return { kind: 'criteria', ref: row.spec_ref_ref };
  }
  return { kind: 'no-locked-spec' };
}

/** Map a raw `reviews` row to a {@link ReviewRequestRecord}. */
export function rowToReviewRequestRecord(row: Record<string, unknown>): ReviewRequestRecord {
  return {
    reviewId: String(row.review_id),
    target: String(row.target),
    branch: String(row.branch),
    scope: (row.scope != null ? String(row.scope) : 'worker_merge') as ReviewScope,
    requestedBy: String(row.requested_by),
    requestedTs: Number(row.requested_ts),
    specRef: rowToSpecRef(row),
  };
}

const REVIEW_COLUMNS =
  'target, branch, scope, review_id, verdict, blockers, suggestions, verification, reviewer, verdict_ts, ' +
  'requested_by, requested_ts, strikes, serialized, overridden, override_reason, override_by, ' +
  'spec_ref_kind, spec_ref_ref';

/** The latest recorded verdict for `branch` on `target`, or undefined (no verdict folded yet). */
export function selectVerdict(
  db: DatabaseSync,
  target: string,
  branch: string,
  scope?: ReviewScope,
): ReviewVerdictRecord | undefined {
  ensureReviewTables(db);
  const row =
    scope != null
      ? db
          .prepare(
            `SELECT ${REVIEW_COLUMNS} FROM reviews
             WHERE target = ? AND branch = ? AND scope = ? AND verdict IS NOT NULL`,
          )
          .get(target, branch, scope)
      : db
          .prepare(
            `SELECT ${REVIEW_COLUMNS} FROM reviews
             WHERE target = ? AND branch = ? AND verdict IS NOT NULL`,
          )
          .get(target, branch);
  return row ? rowToReviewVerdictRecord(row as Record<string, unknown>) : undefined;
}

/** The consecutive `review.strike` count for `branch` on `target`, or 0 if not yet recorded. */
export function selectStrikeCount(db: DatabaseSync, target: string, branch: string): number {
  ensureReviewTables(db);
  const row = db
    .prepare('SELECT strikes FROM reviews WHERE target = ? AND branch = ?')
    .get(target, branch) as Record<string, unknown> | undefined;
  return row != null ? Number(row.strikes) : 0;
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

/** Every branch ever serialized into `target` (the `serialized` flag set), in branch order. */
export function selectSerializedBranches(db: DatabaseSync, target: string): string[] {
  ensureReviewTables(db);
  const rows = db
    .prepare('SELECT branch FROM reviews WHERE target = ? AND serialized = 1 ORDER BY branch')
    .all(target);
  return rows.map((r) => String((r as Record<string, unknown>).branch));
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
        const { reviewId, target, branch, requestedBy, specRefKind, specRefRef } =
          reviewEvent.payload;
        const scope = reviewEvent.payload.scope ?? 'worker_merge';
        const kind = specRefKind ?? null;
        const ref = specRefRef ?? null;
        db.prepare(
          `INSERT INTO reviews
             (target, branch, scope, review_id, requested_by, requested_ts, spec_ref_kind, spec_ref_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(target, branch) DO UPDATE SET
             review_id = excluded.review_id,
             scope = excluded.scope,
             verdict = NULL,
             blockers = NULL,
             suggestions = NULL,
             verification = NULL,
             reviewer = NULL,
             verdict_ts = NULL,
             requested_by = excluded.requested_by,
             requested_ts = excluded.requested_ts,
             spec_ref_kind = excluded.spec_ref_kind,
             spec_ref_ref = excluded.spec_ref_ref`,
        ).run(target, branch, scope, reviewId, requestedBy, event.ts, kind, ref);
        return;
      }
      case EVENT_REVIEW_VERDICT: {
        const { reviewId, target, branch, reviewer, verdict, blockers, suggestions, verification } =
          reviewEvent.payload;
        const scope = reviewEvent.payload.scope ?? 'worker_merge';
        // Persist the validated arrays' deterministic JSON (stable key order), so a rebuild reproduces
        // the same bytes. UPSERT (last verdict wins): a re-review after an ISSUES→fix re-records, and a
        // replay in seq order reaches the same final row. event.ts is the persisted record time.
        // A PASS resets the consecutive-strike counter to 0 (AC-L5-4: PASS resets the run).
        db.prepare(
          `INSERT INTO reviews
             (target, branch, scope, review_id, verdict, blockers, suggestions, verification, reviewer, verdict_ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(target, branch) DO UPDATE SET
             scope = excluded.scope,
             review_id = excluded.review_id,
             verdict = excluded.verdict,
             blockers = excluded.blockers,
             suggestions = excluded.suggestions,
             verification = excluded.verification,
             reviewer = excluded.reviewer,
             verdict_ts = excluded.verdict_ts,
             strikes = CASE WHEN excluded.verdict = 'PASS' THEN 0 ELSE strikes END`,
        ).run(
          target,
          branch,
          scope,
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
