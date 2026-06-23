/**
 * Issue #126 — the observability READ path must not WRITE.
 *
 * `queryObservability` is an operator dashboard read, polled on every desktop refresh tick. It used to
 * run the review projector's heavy legacy backfills (full-table `INSERT ... SELECT` over the `events`
 * log) inside the write-mode transaction on EVERY call, contending with the daemon writer → "database is
 * locked". These tests pin the read path to idempotent `CREATE TABLE IF NOT EXISTS` only:
 *
 *   - a `review.requested` event in the log but NOT folded leaves `review_request_ids` EMPTY after a
 *     read (the legacy `backfillReviewRequestIds` did NOT run on the read path);
 *   - a second read writes nothing new (read path is pure);
 *   - a concurrent write transaction on a SECOND handle does not make the read throw
 *     "database is locked" (busy_timeout-backed, Principle 14 — recoverable).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openProjectStore } from '../store/sqlite-store.js';
import { projectDataDir } from '../store/paths.js';
import {
  makeReviewRequestedEvent,
  makeReviewStrikeEvent,
  makeReviewVerdictEvent,
} from '../review/events.js';
import { ensureReviewTables } from '../review/review-projector.js';
import { makeCostRecordedEvent } from '../dispatch/events.js';
import { ensureCostTables } from '../dispatch/cost-projector.js';
import { queryObservability } from './observability.js';

const ORIGINAL_ENV = process.env;
let dataDir: string;
const PROJECT_ID = 'test-obs-readpath';

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDir = mkdtempSync(join(tmpdir(), 'co-obs-data-'));
  process.env.CO_DATA_DIR = dataDir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  rmSync(dataDir, { recursive: true, force: true });
});

/** Count rows in a table on a freshly opened handle (NOT through queryObservability). */
function countRows(table: string): number {
  const store = openProjectStore(PROJECT_ID);
  try {
    return store.transaction((tx) => {
      const db = tx.raw as DatabaseSync;
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      return Number(row.n);
    });
  } finally {
    store.close();
  }
}

/**
 * Append `review.requested` events straight to the log WITHOUT folding them through the projector. The
 * old read-path backfill (`backfillReviewRequestIds`) would materialize these into `review_request_ids`
 * on the first `ensureReviewTables` call; the fix skips that on the read path.
 */
function seedUnfoldedReviewRequests(count: number): void {
  const store = openProjectStore(PROJECT_ID);
  try {
    const events = Array.from({ length: count }, (_, i) =>
      makeReviewRequestedEvent(PROJECT_ID, {
        reviewId: `rev-${i}`,
        target: 'main',
        branch: `co/impl-${i}`,
        scope: 'worker_merge',
        requestedBy: 'coord-1',
        specRefKind: 'no-locked-spec',
      }),
    );
    store.append(events);
  } finally {
    store.close();
  }
}

function seedLegacyDuplicateStrikeRows(): void {
  const store = openProjectStore(PROJECT_ID);
  try {
    store.transaction((tx) => {
      tx.append([
        makeReviewStrikeEvent(PROJECT_ID, {
          reviewId: 'rev-before-pass',
          target: 'main',
          branch: 'co/legacy-strikes',
          reason: 'legacy duplicate before pass',
        }),
        makeReviewStrikeEvent(PROJECT_ID, {
          reviewId: 'rev-before-pass',
          target: 'main',
          branch: 'co/legacy-strikes',
          reason: 'legacy duplicate before pass',
        }),
        makeReviewVerdictEvent(PROJECT_ID, {
          reviewId: 'rev-pass',
          target: 'main',
          branch: 'co/legacy-strikes',
          scope: 'worker_merge',
          reviewer: 'reviewer-1',
          verdict: 'PASS',
          blockers: [],
          suggestions: [],
        }),
        makeReviewStrikeEvent(PROJECT_ID, {
          reviewId: 'rev-after-pass',
          target: 'main',
          branch: 'co/legacy-strikes',
          reason: 'legacy duplicate after pass',
        }),
        makeReviewStrikeEvent(PROJECT_ID, {
          reviewId: 'rev-after-pass',
          target: 'main',
          branch: 'co/legacy-strikes',
          reason: 'legacy duplicate after pass',
        }),
      ]);
      const db = tx.raw as DatabaseSync;
      ensureReviewTables(db, { backfillStrikes: false, backfillLegacy: false });
      db.prepare(
        `INSERT INTO reviews (target, branch, scope, review_id, strikes)
         VALUES ('main', 'co/legacy-strikes', 'worker_merge', 'rev-after-pass', 4)`,
      ).run();
    });
  } finally {
    store.close();
  }
}

function seedLegacyCostRollups(): void {
  const store = openProjectStore(PROJECT_ID);
  try {
    const obs = {
      provider: 'codex' as const,
      agent: 'impl-1',
      task: 'task-1',
      turn: 0,
      used_pct: 0,
      total_tokens: 10,
    };
    store.transaction((tx) => {
      tx.append([makeCostRecordedEvent(PROJECT_ID, obs), makeCostRecordedEvent(PROJECT_ID, obs)]);
      const db = tx.raw as DatabaseSync;
      ensureCostTables(db, { backfillLegacy: false });
      db.prepare(
        `INSERT INTO cost_rollup
           (kind, id, total_cost_usd, input_tokens, output_tokens, total_tokens, used_pct, observations)
         VALUES
           ('agent', 'impl-1', 0, 0, 0, 20, 0, 2),
           ('task', 'task-1', 0, 0, 0, 20, 0, 2)`,
      ).run();
    });
  } finally {
    store.close();
  }
}

describe('queryObservability — the read path does NOT write (#126)', () => {
  it('does not run the legacy backfill: review_request_ids stays empty after a read', () => {
    // One read materializes the review tables (idempotent CREATE) without folding anything.
    queryObservability(PROJECT_ID);
    seedUnfoldedReviewRequests(3);
    // Pre-condition: the events exist in the log but were never folded, so review_request_ids is empty.
    expect(countRows('review_request_ids')).toBe(0);

    queryObservability(PROJECT_ID);

    // If the read path ran backfillReviewRequestIds (the bug), this would now be 3.
    expect(countRows('review_request_ids')).toBe(0);
  });

  it('is idempotent across repeated reads: a second query writes nothing new', () => {
    seedUnfoldedReviewRequests(2);

    queryObservability(PROJECT_ID);
    const afterFirst = countRows('review_request_ids');
    queryObservability(PROJECT_ID);
    const afterSecond = countRows('review_request_ids');

    expect(afterFirst).toBe(0);
    expect(afterSecond).toBe(afterFirst);
  });

  it('does not throw "database is locked" when a second handle holds a write transaction', () => {
    // Materialize the store + WAL on disk first (one no-op read opens/migrates the file).
    queryObservability(PROJECT_ID);
    seedUnfoldedReviewRequests(1);

    // Open a SECOND, independent handle on the same store.db and take a real write lock with
    // `BEGIN IMMEDIATE` — this is the daemon writer contending with the desktop refresh read. Since the
    // read path no longer WRITES (backfills skipped), its deferred BEGIN never needs the write lock, so
    // the read completes; busy_timeout (PRAGMA, sqlite-store) backstops any incidental contention.
    const dbPath = join(projectDataDir(PROJECT_ID), 'store.db');
    const writer = new DatabaseSync(dbPath);
    writer.exec('PRAGMA journal_mode = WAL');
    writer.exec('PRAGMA busy_timeout = 5000');
    try {
      writer.exec('BEGIN IMMEDIATE'); // RESERVED → write lock held for the duration of the read.
      const snap = queryObservability(PROJECT_ID);
      expect(Array.isArray(snap.reviews)).toBe(true);
      writer.exec('ROLLBACK');
    } finally {
      writer.close();
    }
  });

  it('returns replay-equivalent legacy strike counts without writing review_strikes', () => {
    seedLegacyDuplicateStrikeRows();
    expect(countRows('review_strikes')).toBe(0);

    const snap = queryObservability(PROJECT_ID);

    expect(
      snap.reviews.find((r) => r.target === 'main' && r.branch === 'co/legacy-strikes')?.strikes,
    ).toBe(1);
    expect(countRows('review_strikes')).toBe(0);
  });

  it('returns deduped legacy cost rollups without writing cost_observations', () => {
    seedLegacyCostRollups();
    expect(countRows('cost_observations')).toBe(0);

    const snap = queryObservability(PROJECT_ID);
    const agent = snap.costRollups.find((r) => r.kind === 'agent' && r.id === 'impl-1');
    const task = snap.costRollups.find((r) => r.kind === 'task' && r.id === 'task-1');

    expect(agent).toEqual(
      expect.objectContaining({ totalTokens: 10, observations: 1, tokenObservations: 1 }),
    );
    expect(task).toEqual(
      expect.objectContaining({ totalTokens: 10, observations: 1, tokenObservations: 1 }),
    );
    expect(countRows('cost_observations')).toBe(0);
  });
});
