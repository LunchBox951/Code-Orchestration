import type { DatabaseSync } from 'node:sqlite';
import { decode } from '../replay/decode.js';
import { applyEvent, type Projector } from '../replay/projector.js';
import { openProjectStore } from '../store/sqlite-store.js';
import type { ReviewScope } from './ladder.js';
import {
  EVENT_MERGE_SERIALIZED,
  makeMergeSerializedEvent,
  makeReviewOverrideEvent,
  makeReviewRequestedEvent,
  makeReviewStrikeEvent,
  makeReviewVerdictEvent,
  reviewScope,
  reviewSchemas,
  reviewUpcasters,
  type MergeSerialized,
  type ReviewOverride,
  type ReviewRequested,
  type ReviewRequestRecord,
  type ReviewStrike,
  type ReviewVerdictRecord,
  type ReviewVerdictRecorded,
} from './events.js';
import {
  ensureReviewTables,
  ReviewProjector,
  selectReviewRequest,
  selectReviewStrike,
  selectSerializedBranches,
  selectStrikeCount,
  selectVerdict,
  selectVerdictsForTarget,
} from './review-projector.js';
import { foldActiveSlot, type MergeSlotResult } from './serialize.js';

export function activeSerializedFromEvents(db: DatabaseSync, target: string): string | undefined {
  const rows = db
    .prepare(
      `SELECT payload
       FROM events
       WHERE scope = ? AND type = ?
       ORDER BY seq ASC`,
    )
    .all(reviewScope(target), EVENT_MERGE_SERIALIZED) as Array<{ payload: string }>;
  return foldActiveSlot(
    rows.map((row) => ({
      branch: String((JSON.parse(row.payload) as { branch: unknown }).branch),
    })),
  );
}

export function prepareReviewVerdictForDb(
  db: DatabaseSync,
  v: ReviewVerdictRecorded,
  source: string,
): ReviewVerdictRecorded {
  ensureReviewTables(db);
  const request = selectReviewRequest(db, v.target, v.branch);
  if (request != null && request.reviewId !== v.reviewId) {
    throw new Error(
      `${source}: stale review verdict '${v.reviewId}' for '${v.branch}' into '${v.target}' ` +
        `does not match the latest request '${request.reviewId}'`,
    );
  }
  if (request != null && v.scope != null && v.scope !== request.scope) {
    throw new Error(
      `${source}: verdict scope '${v.scope}' for '${v.branch}' into '${v.target}' does not ` +
        `match the latest request scope '${request.scope}'`,
    );
  }
  const verdict = request != null && v.scope == null ? { ...v, scope: request.scope } : v;
  const existing = selectVerdict(db, verdict.target, verdict.branch, verdict.scope);
  if (existing != null && existing.reviewId === verdict.reviewId) {
    throw new Error(
      `${source}: review verdict '${verdict.reviewId}' for '${verdict.branch}' into ` +
        `'${verdict.target}' is already recorded; create a new review request before ` +
        'recording another verdict.',
    );
  }
  return verdict;
}

function assertSameReviewRequest(existing: ReviewRequestRecord, requested: ReviewRequested): void {
  const scope = requested.scope ?? 'worker_merge';
  if (existing.scope !== scope) {
    throw new Error(
      `openReviewStore.recordReviewRequested: duplicate reviewId '${requested.reviewId}' ` +
        `conflicts on scope: stored '${existing.scope}', requested '${scope}'.`,
    );
  }
  if (existing.requestedBy !== requested.requestedBy) {
    throw new Error(
      `openReviewStore.recordReviewRequested: duplicate reviewId '${requested.reviewId}' ` +
        `conflicts on requestedBy: stored '${existing.requestedBy}', requested ` +
        `'${requested.requestedBy}'.`,
    );
  }
  const requestedReviewerKind = requested.reviewerKind ?? 'agent';
  if (existing.reviewerKind !== requestedReviewerKind) {
    throw new Error(
      `openReviewStore.recordReviewRequested: duplicate reviewId '${requested.reviewId}' ` +
        `conflicts on reviewerKind: stored '${existing.reviewerKind}', requested ` +
        `'${requestedReviewerKind}'.`,
    );
  }
  const requestedKind = requested.specRefKind ?? 'no-locked-spec';
  const requestedRef = requested.specRefRef;
  if (
    existing.specRef.kind !== requestedKind ||
    (existing.specRef.kind === 'criteria' && existing.specRef.ref !== requestedRef)
  ) {
    const stored =
      existing.specRef.kind === 'criteria'
        ? `criteria:${existing.specRef.ref}`
        : existing.specRef.kind;
    const incoming =
      requestedKind === 'criteria' ? `criteria:${requestedRef ?? ''}` : requestedKind;
    throw new Error(
      `openReviewStore.recordReviewRequested: duplicate reviewId '${requested.reviewId}' ` +
        `conflicts on specRef: stored '${stored}', requested '${incoming}'.`,
    );
  }
}

function selectReviewRequestById(
  db: DatabaseSync,
  reviewId: string,
): ReviewRequestRecord | undefined {
  ensureReviewTables(db);
  const row = db
    .prepare(
      `SELECT target, branch, scope, review_id, verdict, blockers, suggestions, verification,
              reviewer, verdict_ts, reviewer_kind, requested_by, requested_ts, strikes,
              serialized, overridden, override_reason, override_by, spec_ref_kind, spec_ref_ref
       FROM reviews
       WHERE review_id = ? AND requested_ts IS NOT NULL`,
    )
    .get(reviewId);
  return row
    ? {
        reviewId: String((row as Record<string, unknown>).review_id),
        target: String((row as Record<string, unknown>).target),
        branch: String((row as Record<string, unknown>).branch),
        scope: String((row as Record<string, unknown>).scope ?? 'worker_merge') as ReviewScope,
        reviewerKind:
          (row as Record<string, unknown>).reviewer_kind === 'human' ||
          (row as Record<string, unknown>).reviewer_kind === 'agent'
            ? ((row as Record<string, unknown>).reviewer_kind as 'agent' | 'human')
            : 'agent',
        requestedBy: String((row as Record<string, unknown>).requested_by),
        requestedTs: Number((row as Record<string, unknown>).requested_ts),
        specRef:
          (row as Record<string, unknown>).spec_ref_kind === 'criteria' &&
          typeof (row as Record<string, unknown>).spec_ref_ref === 'string'
            ? { kind: 'criteria', ref: String((row as Record<string, unknown>).spec_ref_ref) }
            : { kind: 'no-locked-spec' },
      }
    : undefined;
}

function selectHistoricalReviewRequestById(
  db: DatabaseSync,
  reviewId: string,
): { readonly target: string; readonly branch: string } | undefined {
  const row = db
    .prepare(
      `SELECT
         json_extract(payload, '$.target') AS target,
         json_extract(payload, '$.branch') AS branch
       FROM events
       WHERE type = ? AND json_extract(payload, '$.reviewId') = ?
       ORDER BY seq ASC
       LIMIT 1`,
    )
    .get('review.requested', reviewId) as Record<string, unknown> | undefined;
  if (typeof row?.target !== 'string' || typeof row.branch !== 'string') return undefined;
  return { target: row.target, branch: row.branch };
}

export function assertReviewIdAvailableInDb(
  db: DatabaseSync,
  reviewId: string,
  target: string,
  branch: string,
): void {
  const existingById = selectReviewRequestById(db, reviewId);
  if (existingById != null) {
    if (existingById.target === target && existingById.branch === branch) return;
    throw new Error(
      `openReviewStore.recordReviewRequested: duplicate reviewId '${reviewId}' already ` +
        `belongs to '${existingById.branch}' into '${existingById.target}'.`,
    );
  }
  const historicalById = selectHistoricalReviewRequestById(db, reviewId);
  if (historicalById != null) {
    throw new Error(
      `openReviewStore.recordReviewRequested: duplicate reviewId '${reviewId}' already ` +
        `belongs to '${historicalById.branch}' into '${historicalById.target}'.`,
    );
  }
}

/**
 * The headless L5 review store over a single project store (the L5 analogue of L3's
 * {@link import('../worktrees/worktree-store.js').WorktreeStore}). It records the orchestration facts
 * of a review — the structured verdict (and a minimal request) — entirely in program-data, never the
 * repo (Principle 12 — pristine-repo). A recording event-sources its read-model row in the same
 * transaction as the append (so the log and projection commit atomically), then reads it straight back;
 * reads are plain projections.
 *
 * Opening this alongside the mail / worktree / dispatch stores on the SAME per-project `store.db` is
 * safe: `node:sqlite` is synchronous/single-threaded so transactions never interleave in-process, and
 * this store owns a DIFFERENT scope (`review:`) and read-model table (`reviews`) than the others.
 *
 * The facade is shaped so phases B–F slot in additively: `recordStrike` (D) / `recordSerialized` +
 * `recordOverride` (F) are NEW methods folding the events whose schemas are already defined +
 * projected, with no change to the table. (They were deliberately NOT declared until their phase —
 * a method that threw would be the banned silent stub; the seam was "left room for", not pre-stubbed.)
 */
export interface ReviewStore {
  /**
   * Record a verdict (append `review.verdict` + fold); returns the read-back record. The builder runs
   * {@link import('./verdict.js').assertValidVerdict}, so an `{verdict:'ISSUES', blockers:[]}` throws.
   */
  recordVerdict(v: ReviewVerdictRecorded): ReviewVerdictRecord;
  /**
   * The latest verdict for `branch` on `target`, or undefined. UPSERT/last-wins (like `recordFinish`):
   * a re-review after an ISSUES→fix returns the LATEST verdict — which is the one `co_merge` gates on.
   */
  getVerdict(target: string, branch: string, scope?: ReviewScope): ReviewVerdictRecord | undefined;
  /** Every recorded verdict on `target`, oldest-recorded first. */
  listVerdicts(target: string): readonly ReviewVerdictRecord[];
  /**
   * Record a review request (append `review.requested` + fold); returns the read-back record. Minimal
   * now — the request flow's real consumer is Phase E.
   */
  recordReviewRequested(r: ReviewRequested): ReviewRequestRecord;
  /**
   * Preflight the project-wide reviewId uniqueness invariant before request side effects such as
   * human mail or reviewer placement. `recordReviewRequested` rechecks this in the same transaction
   * before append, so this is an ordering guard rather than the only enforcement point.
   */
  assertReviewIdAvailable(reviewId: string, target: string, branch: string): void;
  /** The latest review request for `branch` on `target`, or undefined. */
  getReviewRequest(target: string, branch: string): ReviewRequestRecord | undefined;
  /** The durable review request with `reviewId`, or undefined. */
  getReviewRequestById(reviewId: string): ReviewRequestRecord | undefined;
  /**
   * Record a strike against `branch` on `target` (append `review.strike` + fold). Called by
   * {@link import('./strikes.js').applyStrikePolicy} on each freshly-recorded ISSUES verdict; the
   * consecutive count is reset to 0 when a PASS verdict is recorded for the same (target, branch).
   */
  recordStrike(s: ReviewStrike): void;
  /** The current consecutive `review.strike` count for `branch` on `target` (0 if none). */
  getStrikeCount(target: string, branch: string): number;
  /** Whether `reviewId` has already consumed a strike for `(target, branch)`. */
  hasStrike(target: string, branch: string, reviewId: string): boolean;
  /**
   * Record a merge-serialization grant/release (append `merge.serialized` + fold). The per-target
   * merge lock ({@link import('./serialize.js').acquireMergeSlot}/`releaseMergeSlot`) drives this:
   * an odd write claims the slot, the paired even write releases it (AC-L5-7).
   */
  recordSerialized(m: MergeSerialized): void;
  /**
   * Atomically acquire the per-target merge slot for `m.branch`, or return queued when another branch
   * holds it. This is the store-level compare-and-record primitive used by `acquireMergeSlot`.
   */
  acquireSerialized(m: MergeSerialized): MergeSlotResult;
  /**
   * Atomically release the per-target merge slot for `m.branch`. A duplicate release when the slot is
   * already free is a no-op; releasing another branch's active slot fails loud.
   */
  releaseSerialized(m: MergeSerialized): void;
  /**
   * Atomically record an ISSUES verdict and release the active slot held by the reviewed branch.
   * Used by reviewer/human finalization so neither half can persist without the other.
   */
  recordVerdictAndRelease(v: ReviewVerdictRecorded): void;
  /**
   * The branch currently HOLDING `target`'s merge slot, or undefined when none. Derived by folding
   * the target's ordered `merge.serialized` log ({@link import('./serialize.js').foldActiveSlot}) —
   * the active-reviewer/merge query serialization reads (AC-L5-7).
   */
  activeSerialized(target: string): string | undefined;
  /** Every branch ever serialized into `target` (the `serialized` flag set), in branch order. */
  serializedBranches(target: string): readonly string[];
  /**
   * Record an audited PASS-gate override (append `review.override` + fold). Written by the operator
   * escape hatch (`co_merge --operator-override --reason`): records `{target, branch, reason,
   * overriddenBy}` so the bypass is never silent (AC-L5-6, Principle 9).
   */
  recordOverride(o: ReviewOverride): void;
  /** Close the underlying project store. */
  close(): void;
}

/**
 * Open the project review store: open the PROJECT store, wire the {@link ReviewProjector}, and return
 * the {@link ReviewStore} facade. The store is resolved by the MOUNT (a tool never opens its own store)
 * and injected onto {@link import('../tools/context.js').ToolContext}.`reviews`.
 */
export function openReviewStore(projectId: string): ReviewStore {
  const store = openProjectStore(projectId);
  const projectors: readonly Projector[] = [new ReviewProjector()];

  return {
    recordVerdict(v: ReviewVerdictRecorded): ReviewVerdictRecord {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        const verdict = prepareReviewVerdictForDb(db, v, 'openReviewStore.recordVerdict');
        const [stored] = tx.append([makeReviewVerdictEvent(projectId, verdict)]);
        applyEvent(tx, decode(stored!, reviewUpcasters, reviewSchemas), projectors);
        const row = selectVerdict(db, verdict.target, verdict.branch, verdict.scope);
        if (!row) {
          throw new Error(
            `openReviewStore.recordVerdict: row missing after projection ` +
              `(target='${verdict.target}', branch='${verdict.branch}')`,
          );
        }
        return row;
      });
    },

    getVerdict(
      target: string,
      branch: string,
      scope?: ReviewScope,
    ): ReviewVerdictRecord | undefined {
      return store.transaction((tx) =>
        selectVerdict(tx.raw as DatabaseSync, target, branch, scope),
      );
    },

    listVerdicts(target: string): readonly ReviewVerdictRecord[] {
      return store.transaction((tx) => selectVerdictsForTarget(tx.raw as DatabaseSync, target));
    },

    recordReviewRequested(r: ReviewRequested): ReviewRequestRecord {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureReviewTables(db);
        const existing = selectReviewRequest(db, r.target, r.branch);
        if (existing != null && existing.reviewId === r.reviewId) {
          assertSameReviewRequest(existing, r);
          return existing;
        }
        assertReviewIdAvailableInDb(db, r.reviewId, r.target, r.branch);
        const [stored] = tx.append([makeReviewRequestedEvent(projectId, r)]);
        applyEvent(tx, decode(stored!, reviewUpcasters, reviewSchemas), projectors);
        const row = selectReviewRequest(db, r.target, r.branch);
        if (!row) {
          throw new Error(
            `openReviewStore.recordReviewRequested: row missing after projection ` +
              `(target='${r.target}', branch='${r.branch}')`,
          );
        }
        return row;
      });
    },

    assertReviewIdAvailable(reviewId: string, target: string, branch: string): void {
      store.transaction((tx) =>
        assertReviewIdAvailableInDb(tx.raw as DatabaseSync, reviewId, target, branch),
      );
    },

    getReviewRequest(target: string, branch: string): ReviewRequestRecord | undefined {
      return store.transaction((tx) => selectReviewRequest(tx.raw as DatabaseSync, target, branch));
    },

    getReviewRequestById(reviewId: string): ReviewRequestRecord | undefined {
      return store.transaction((tx) => selectReviewRequestById(tx.raw as DatabaseSync, reviewId));
    },

    recordStrike(s: ReviewStrike): void {
      store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureReviewTables(db);
        if (selectReviewStrike(db, s.target, s.branch, s.reviewId)) return;
        const [stored] = tx.append([makeReviewStrikeEvent(projectId, s)]);
        applyEvent(tx, decode(stored!, reviewUpcasters, reviewSchemas), projectors);
      });
    },

    getStrikeCount(target: string, branch: string): number {
      return store.transaction((tx) => selectStrikeCount(tx.raw as DatabaseSync, target, branch));
    },

    hasStrike(target: string, branch: string, reviewId: string): boolean {
      return store.transaction((tx) =>
        selectReviewStrike(tx.raw as DatabaseSync, target, branch, reviewId),
      );
    },

    recordSerialized(m: MergeSerialized): void {
      store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureReviewTables(db);
        const [stored] = tx.append([makeMergeSerializedEvent(projectId, m)]);
        applyEvent(tx, decode(stored!, reviewUpcasters, reviewSchemas), projectors);
      });
    },

    acquireSerialized(m: MergeSerialized): MergeSlotResult {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureReviewTables(db);
        const active = activeSerializedFromEvents(db, m.target);
        if (active === undefined) {
          const [stored] = tx.append([makeMergeSerializedEvent(projectId, m)]);
          applyEvent(tx, decode(stored!, reviewUpcasters, reviewSchemas), projectors);
          return { acquired: true, queued: false, active: m.branch, fresh: true };
        }
        if (active === m.branch) return { acquired: true, queued: false, active, fresh: false };
        return { acquired: false, queued: true, active, fresh: false };
      });
    },

    releaseSerialized(m: MergeSerialized): void {
      store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureReviewTables(db);
        const active = activeSerializedFromEvents(db, m.target);
        if (active === undefined) return;
        if (active !== m.branch) {
          throw new Error(
            `openReviewStore.releaseSerialized: '${m.branch}' does not hold the merge slot ` +
              `for '${m.target}' (active holder: ${active}).`,
          );
        }
        const [stored] = tx.append([makeMergeSerializedEvent(projectId, m)]);
        applyEvent(tx, decode(stored!, reviewUpcasters, reviewSchemas), projectors);
      });
    },

    recordVerdictAndRelease(v: ReviewVerdictRecorded): void {
      store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        const verdict = prepareReviewVerdictForDb(db, v, 'openReviewStore.recordVerdictAndRelease');
        const active = activeSerializedFromEvents(db, verdict.target);
        if (active !== undefined && active !== verdict.branch) {
          throw new Error(
            `openReviewStore.recordVerdictAndRelease: '${verdict.branch}' does not hold the ` +
              `merge slot for '${verdict.target}' (active holder: ${active}).`,
          );
        }
        const events = [makeReviewVerdictEvent(projectId, verdict)];
        if (active === verdict.branch) {
          events.push(
            makeMergeSerializedEvent(projectId, {
              target: verdict.target,
              branch: verdict.branch,
            }),
          );
        }
        const stored = tx.append(events);
        for (const event of stored) {
          applyEvent(tx, decode(event, reviewUpcasters, reviewSchemas), projectors);
        }
      });
    },

    activeSerialized(target: string): string | undefined {
      // The slot state is derived from the target's ORDERED merge.serialized log (the toggle fold),
      // not the read-model `serialized` flag (a boolean can't express acquire-then-release). Reading
      // the stream keeps the lock event-sourced (Principle 14) and replay-deterministic (AC-L5-11).
      return store.transaction((tx) => activeSerializedFromEvents(tx.raw as DatabaseSync, target));
    },

    serializedBranches(target: string): readonly string[] {
      return store.transaction((tx) => selectSerializedBranches(tx.raw as DatabaseSync, target));
    },

    recordOverride(o: ReviewOverride): void {
      store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureReviewTables(db);
        const [stored] = tx.append([makeReviewOverrideEvent(projectId, o)]);
        applyEvent(tx, decode(stored!, reviewUpcasters, reviewSchemas), projectors);
      });
    },

    close(): void {
      store.close();
    },
  };
}
