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
    verdict_seq     INTEGER,
    reviewer_kind   TEXT,
    requested_by    TEXT,
    requested_ts    INTEGER,
    strikes         INTEGER NOT NULL DEFAULT 0,
    serialized      INTEGER NOT NULL DEFAULT 0,
    overridden      INTEGER NOT NULL DEFAULT 0,
    override_reason TEXT,
    override_by     TEXT,
    override_verification_failures TEXT,
    spec_ref_kind   TEXT,
    spec_ref_ref    TEXT,
    PRIMARY KEY (target, branch)
  );

  CREATE TABLE IF NOT EXISTS review_strikes (
    target    TEXT NOT NULL,
    branch    TEXT NOT NULL,
    review_id TEXT NOT NULL,
    PRIMARY KEY (target, branch, review_id)
  );

  CREATE TABLE IF NOT EXISTS review_request_ids (
    review_id TEXT PRIMARY KEY,
    target    TEXT NOT NULL,
    branch    TEXT NOT NULL
  );
`;

/**
 * Defensive create of the L5 read-model table. Called from the projector's reset/apply AND every read
 * path, so a freshly opened store can be queried before any write has happened.
 */
export function ensureReviewTables(
  db: DatabaseSync,
  opts: { readonly backfillStrikes?: boolean; readonly backfillLegacy?: boolean } = {},
): void {
  db.exec(CREATE_REVIEW_TABLES);
  addMissingReviewColumn(db, 'scope', "TEXT NOT NULL DEFAULT 'worker_merge'");
  addMissingReviewColumn(db, 'reviewer_kind', 'TEXT');
  addMissingReviewColumn(db, 'verdict_seq', 'INTEGER');
  addMissingReviewColumn(db, 'spec_ref_kind', 'TEXT');
  addMissingReviewColumn(db, 'spec_ref_ref', 'TEXT');
  addMissingReviewColumn(db, 'override_verification_failures', 'TEXT');
  if (opts.backfillLegacy ?? true) {
    backfillReviewRequestIds(db);
    backfillReviewVerdictSeq(db);
  }
  if (opts.backfillStrikes ?? true) backfillReviewStrikes(db);
}

function addMissingReviewColumn(db: DatabaseSync, column: string, definition: string): void {
  const columns = db.prepare('PRAGMA table_info(reviews)').all() as Array<{
    readonly name: string;
  }>;
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE reviews ADD COLUMN ${column} ${definition}`);
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return row != null;
}

function backfillReviewRequestIds(db: DatabaseSync): void {
  if (!tableExists(db, 'events')) return;
  db.prepare(
    `INSERT OR IGNORE INTO review_request_ids (review_id, target, branch)
     SELECT
       json_extract(payload, '$.reviewId') AS review_id,
       json_extract(payload, '$.target') AS target,
       json_extract(payload, '$.branch') AS branch
     FROM events
     WHERE type = ?
       AND json_extract(payload, '$.reviewId') IS NOT NULL
     ORDER BY seq ASC`,
  ).run(EVENT_REVIEW_REQUESTED);
}

function backfillReviewVerdictSeq(db: DatabaseSync): void {
  if (!tableExists(db, 'events')) return;
  db.prepare(
    `UPDATE reviews
        SET verdict_seq = (
          SELECT e.seq
            FROM events e
           WHERE e.type = ?
             AND json_extract(e.payload, '$.target') = reviews.target
             AND json_extract(e.payload, '$.branch') = reviews.branch
             AND json_extract(e.payload, '$.reviewId') = reviews.review_id
             AND COALESCE(json_extract(e.payload, '$.scope'), 'worker_merge') = reviews.scope
           ORDER BY e.seq DESC
           LIMIT 1
        )
      WHERE verdict IS NOT NULL
        AND verdict_seq IS NULL`,
  ).run(EVENT_REVIEW_VERDICT);
}

function backfillReviewStrikes(db: DatabaseSync): void {
  if (!tableExists(db, 'events')) return;
  const rows = db
    .prepare(
      `SELECT
         type,
         json_extract(payload, '$.target') AS target,
         json_extract(payload, '$.branch') AS branch,
         json_extract(payload, '$.reviewId') AS review_id,
         json_extract(payload, '$.verdict') AS verdict
       FROM events
       WHERE type IN (?, ?)
       ORDER BY seq ASC`,
    )
    .all(EVENT_REVIEW_STRIKE, EVENT_REVIEW_VERDICT) as Array<Record<string, unknown>>;

  const states = new Map<
    string,
    {
      readonly target: string;
      readonly branch: string;
      readonly consumed: Set<string>;
      readonly visible: Set<string>;
    }
  >();
  const stateFor = (target: string, branch: string) => {
    const key = `${target}\0${branch}`;
    let state = states.get(key);
    if (state == null) {
      state = { target, branch, consumed: new Set(), visible: new Set() };
      states.set(key, state);
    }
    return state;
  };

  for (const row of rows) {
    const target = typeof row.target === 'string' ? row.target : undefined;
    const branch = typeof row.branch === 'string' ? row.branch : undefined;
    if (target == null || branch == null) continue;
    const state = stateFor(target, branch);
    if (row.type === EVENT_REVIEW_STRIKE) {
      const reviewId = typeof row.review_id === 'string' ? row.review_id : undefined;
      if (reviewId == null) continue;
      const fresh = !state.consumed.has(reviewId);
      state.consumed.add(reviewId);
      if (fresh) state.visible.add(reviewId);
      continue;
    }
    if (row.type === EVENT_REVIEW_VERDICT && row.verdict === 'PASS') {
      state.visible.clear();
    }
  }

  const insertStrike = db.prepare(
    'INSERT OR IGNORE INTO review_strikes (target, branch, review_id) VALUES (?, ?, ?)',
  );
  const upsertVisible = db.prepare(
    `INSERT INTO reviews (target, branch, strikes)
     VALUES (?, ?, ?)
     ON CONFLICT(target, branch) DO UPDATE SET strikes = excluded.strikes`,
  );
  for (const state of states.values()) {
    for (const reviewId of state.consumed) {
      insertStrike.run(state.target, state.branch, reviewId);
    }
    upsertVisible.run(state.target, state.branch, state.visible.size);
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
    ...(row.verdict_seq != null ? { recordedSeq: Number(row.verdict_seq) } : {}),
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
    reviewerKind:
      row.reviewer_kind === 'human' || row.reviewer_kind === 'agent' ? row.reviewer_kind : 'agent',
    requestedBy: String(row.requested_by),
    requestedTs: Number(row.requested_ts),
    specRef: rowToSpecRef(row),
  };
}

const REVIEW_COLUMNS =
  'target, branch, scope, review_id, verdict, blockers, suggestions, verification, reviewer, verdict_ts, verdict_seq, ' +
  'reviewer_kind, requested_by, requested_ts, strikes, serialized, overridden, override_reason, ' +
  'override_by, spec_ref_kind, spec_ref_ref';

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

/** True iff `reviewId` already consumed a strike for `(target, branch)`. */
export function selectReviewStrike(
  db: DatabaseSync,
  target: string,
  branch: string,
  reviewId: string,
  opts: { readonly backfillStrikes?: boolean; readonly backfillLegacy?: boolean } = {},
): boolean {
  ensureReviewTables(db, opts);
  const row = db
    .prepare('SELECT 1 FROM review_strikes WHERE target = ? AND branch = ? AND review_id = ?')
    .get(target, branch, reviewId);
  return row != null;
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
  opts: { readonly backfillStrikes?: boolean; readonly backfillLegacy?: boolean } = {},
): ReviewRequestRecord | undefined {
  ensureReviewTables(db, opts);
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
    ensureReviewTables(db, { backfillStrikes: false, backfillLegacy: false });
    db.exec('DELETE FROM review_request_ids');
    db.exec('DELETE FROM review_strikes');
    db.exec('DELETE FROM reviews');
  }

  apply(tx: StoreTx, event: StoredEvent): void {
    const db = tx.raw as DatabaseSync;
    ensureReviewTables(db, { backfillStrikes: false, backfillLegacy: false });
    const reviewEvent = event as ReviewEvent;
    switch (reviewEvent.type) {
      case EVENT_REVIEW_REQUESTED: {
        const { reviewId, target, branch, reviewerKind, requestedBy, specRefKind, specRefRef } =
          reviewEvent.payload;
        const scope = reviewEvent.payload.scope ?? 'worker_merge';
        const route = reviewerKind ?? 'agent';
        const kind = specRefKind ?? null;
        const ref = specRefRef ?? null;
        const existingById = db
          .prepare('SELECT target, branch FROM review_request_ids WHERE review_id = ?')
          .get(reviewId) as Record<string, unknown> | undefined;
        if (existingById != null) {
          const existingTarget = String(existingById.target);
          const existingBranch = String(existingById.branch);
          if (existingTarget !== target || existingBranch !== branch) {
            throw new Error(
              `duplicate reviewId '${reviewId}' already belongs to ` +
                `'${existingBranch}' into '${existingTarget}'.`,
            );
          }
          const existingRequest = db
            .prepare(
              `SELECT review_id, scope, reviewer_kind, requested_by, spec_ref_kind, spec_ref_ref
                 FROM reviews
                WHERE target = ? AND branch = ? AND requested_ts IS NOT NULL`,
            )
            .get(target, branch) as Record<string, unknown> | undefined;
          if (
            existingRequest == null ||
            String(existingRequest.review_id) !== reviewId ||
            String(existingRequest.scope) !== scope ||
            ((existingRequest.reviewer_kind as string | null | undefined) ?? 'agent') !== route ||
            String(existingRequest.requested_by) !== requestedBy ||
            (existingRequest.spec_ref_kind ?? null) !== kind ||
            (existingRequest.spec_ref_ref ?? null) !== ref
          ) {
            throw new Error(
              `duplicate reviewId '${reviewId}' for '${branch}' into '${target}' conflicts ` +
                'with an earlier request event.',
            );
          }
          return;
        } else {
          db.prepare(
            'INSERT INTO review_request_ids (review_id, target, branch) VALUES (?, ?, ?)',
          ).run(reviewId, target, branch);
        }
        db.prepare(
          `INSERT INTO reviews
             (target, branch, scope, review_id, reviewer_kind, requested_by, requested_ts, spec_ref_kind, spec_ref_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(target, branch) DO UPDATE SET
             review_id = excluded.review_id,
             scope = excluded.scope,
             reviewer_kind = excluded.reviewer_kind,
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
        ).run(target, branch, scope, reviewId, route, requestedBy, event.ts, kind, ref);
        return;
      }
      case EVENT_REVIEW_VERDICT: {
        const { reviewId, target, branch, reviewer, verdict, blockers, suggestions, verification } =
          reviewEvent.payload;
        const request = selectReviewRequest(db, target, branch, {
          backfillStrikes: false,
          backfillLegacy: false,
        });
        if (request != null && request.reviewId !== reviewId) {
          throw new Error(
            `stale review verdict '${reviewId}' for '${branch}' into '${target}' — latest ` +
              `request is '${request.reviewId}'.`,
          );
        }
        if (
          request != null &&
          reviewEvent.payload.scope != null &&
          reviewEvent.payload.scope !== request.scope
        ) {
          throw new Error(
            `review verdict scope '${reviewEvent.payload.scope}' for '${branch}' into ` +
              `'${target}' does not match requested scope '${request.scope}'.`,
          );
        }
        const scope = reviewEvent.payload.scope ?? request?.scope ?? 'worker_merge';
        const existingVerdict = db
          .prepare(
            `SELECT review_id FROM reviews
             WHERE target = ? AND branch = ? AND scope = ? AND verdict IS NOT NULL`,
          )
          .get(target, branch, scope) as Record<string, unknown> | undefined;
        if (existingVerdict != null && String(existingVerdict.review_id) === reviewId) {
          throw new Error(
            `review verdict '${reviewId}' for '${branch}' into '${target}' is already recorded; ` +
              'create a new review request before recording another verdict.',
          );
        }
        // Persist the validated arrays' deterministic JSON (stable key order), so a rebuild reproduces
        // the same bytes. UPSERT (last verdict wins): a re-review after an ISSUES→fix re-records, and a
        // replay in seq order reaches the same final row. event.ts is the persisted record time.
        // A PASS resets the consecutive-strike counter to 0 (AC-L5-4: PASS resets the run).
        db.prepare(
          `INSERT INTO reviews
             (
               target,
               branch,
               scope,
               review_id,
               verdict,
               blockers,
               suggestions,
               verification,
               reviewer,
               verdict_ts,
               verdict_seq
             )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(target, branch) DO UPDATE SET
             scope = excluded.scope,
             review_id = excluded.review_id,
             verdict = excluded.verdict,
             blockers = excluded.blockers,
             suggestions = excluded.suggestions,
             verification = excluded.verification,
             reviewer = excluded.reviewer,
             verdict_ts = excluded.verdict_ts,
             verdict_seq = excluded.verdict_seq,
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
          event.seq,
        );
        // PASS resets the visible consecutive-strike count above, but consumed reviewIds stay in
        // review_strikes so a replay/retry cannot count the same reviewId again after the reset.
        return;
      }
      case EVENT_REVIEW_STRIKE: {
        const { reviewId, target, branch } = reviewEvent.payload;
        if (
          selectReviewStrike(db, target, branch, reviewId, {
            backfillStrikes: false,
            backfillLegacy: false,
          })
        ) {
          return;
        }
        db.prepare('INSERT INTO review_strikes (target, branch, review_id) VALUES (?, ?, ?)').run(
          target,
          branch,
          reviewId,
        );
        // Read-model plumbing (Phase D writer): a fresh row starts at one strike; an existing row
        // bumps the counter. Duplicate reviewId strikes are ignored, so retries are idempotent.
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
        const { target, branch, reason, overriddenBy, verificationFailures } = reviewEvent.payload;
        // Read-model plumbing (Phase F writer): mark the PASS gate overridden + record the reason/who.
        db.prepare(
          `INSERT INTO reviews (
             target,
             branch,
             overridden,
             override_reason,
             override_by,
             override_verification_failures
           )
           VALUES (?, ?, 1, ?, ?, ?)
           ON CONFLICT(target, branch) DO UPDATE SET
             overridden = 1,
             override_reason = excluded.override_reason,
             override_by = excluded.override_by,
             override_verification_failures = excluded.override_verification_failures`,
        ).run(
          target,
          branch,
          reason,
          overriddenBy,
          verificationFailures != null ? JSON.stringify(verificationFailures) : null,
        );
        return;
      }
      default:
        return assertNever(reviewEvent);
    }
  }
}
