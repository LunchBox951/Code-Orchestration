/**
 * Issue #126 — the observability READ path must not WRITE.
 *
 * `queryObservability` is an operator dashboard read, polled on every desktop refresh tick. It used to
 * run the review projector's heavy legacy backfills (full-table `INSERT ... SELECT` over the `events`
 * log) inside the write-mode transaction on EVERY call, contending with the daemon writer → "database is
 * locked". These tests pin the read path to pure reads, with no projection DDL/backfill writes:
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
      if (!tableExists(db, table)) return 0;
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      return Number(row.n);
    });
  } finally {
    store.close();
  }
}

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return row != null;
}

function hasColumn(table: string, column: string): boolean {
  const store = openProjectStore(PROJECT_ID);
  try {
    return store.transaction((tx) => {
      const db = tx.raw as DatabaseSync;
      const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return rows.some((row) => row.name === column);
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

function seedConflictingLegacyCostRollups(): void {
  const store = openProjectStore(PROJECT_ID);
  try {
    const obs = {
      provider: 'codex' as const,
      agent: 'impl-1',
      task: 'task-1',
      turn: 0,
      total_tokens: 10,
    };
    store.transaction((tx) => {
      tx.append([
        makeCostRecordedEvent(PROJECT_ID, obs),
        makeCostRecordedEvent(PROJECT_ID, { ...obs, total_tokens: 99 }),
      ]);
      const db = tx.raw as DatabaseSync;
      ensureCostTables(db, { backfillLegacy: false });
      db.prepare(
        `INSERT INTO cost_rollup
           (kind, id, total_cost_usd, input_tokens, output_tokens, total_tokens, used_pct, observations)
         VALUES
           ('agent', 'impl-1', 0, 0, 0, 10, 0, 1),
           ('task', 'task-1', 0, 0, 0, 10, 0, 1)`,
      ).run();
    });
  } finally {
    store.close();
  }
}

function seedOldProjectionSchemas(): void {
  const store = openProjectStore(PROJECT_ID);
  try {
    const costObs = {
      provider: 'claude' as const,
      agent: 'impl-old',
      task: 'task-old',
      turn: 0,
      source_id: 'claude-jsonl:v1:old:1',
      input_tokens: 7,
      output_tokens: 8,
    };
    store.transaction((tx) => {
      tx.append([
        makeReviewStrikeEvent(PROJECT_ID, {
          reviewId: 'rev-before-pass',
          target: 'main',
          branch: 'co/old-schema',
          reason: 'legacy duplicate before pass',
        }),
        makeReviewStrikeEvent(PROJECT_ID, {
          reviewId: 'rev-before-pass',
          target: 'main',
          branch: 'co/old-schema',
          reason: 'legacy duplicate before pass',
        }),
        makeReviewVerdictEvent(PROJECT_ID, {
          reviewId: 'rev-pass',
          target: 'main',
          branch: 'co/old-schema',
          scope: 'worker_merge',
          reviewer: 'reviewer-1',
          verdict: 'PASS',
          blockers: [],
          suggestions: [],
        }),
        makeReviewStrikeEvent(PROJECT_ID, {
          reviewId: 'rev-after-pass',
          target: 'main',
          branch: 'co/old-schema',
          reason: 'legacy duplicate after pass',
        }),
        makeReviewStrikeEvent(PROJECT_ID, {
          reviewId: 'rev-after-pass',
          target: 'main',
          branch: 'co/old-schema',
          reason: 'legacy duplicate after pass',
        }),
        makeCostRecordedEvent(PROJECT_ID, costObs),
        makeCostRecordedEvent(PROJECT_ID, { ...costObs, turn: 1 }),
      ]);
      const db = tx.raw as DatabaseSync;
      db.exec(`
        CREATE TABLE roster (
          agent_id      TEXT PRIMARY KEY,
          role          TEXT NOT NULL,
          sub_role      TEXT,
          parent        TEXT NOT NULL,
          registered_ts INTEGER NOT NULL
        );
        INSERT INTO roster (agent_id, role, sub_role, parent, registered_ts)
        VALUES ('impl-old', 'implementer', NULL, '@operator', 100);

        CREATE TABLE plans (
          task_id       TEXT PRIMARY KEY,
          goal          TEXT NOT NULL,
          task_criteria TEXT NOT NULL,
          drafted_ts    INTEGER NOT NULL,
          replan_count  INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE plan_phases (
          task_id      TEXT NOT NULL,
          phase_id     TEXT NOT NULL,
          name         TEXT NOT NULL,
          owner        TEXT,
          deps         TEXT NOT NULL,
          criteria     TEXT NOT NULL,
          status       TEXT NOT NULL DEFAULT 'planned',
          verified_pass INTEGER,
          PRIMARY KEY (task_id, phase_id)
        );
        INSERT INTO plans (task_id, goal, task_criteria, drafted_ts, replan_count)
        VALUES ('task-old', 'old goal', '[]', 101, 0);
        INSERT INTO plan_phases (task_id, phase_id, name, owner, deps, criteria, status, verified_pass)
        VALUES ('task-old', 'phase-old', 'old phase', 'lead-old', '[]', '[]', 'planned', NULL);

        CREATE TABLE reviews (
          target     TEXT NOT NULL,
          branch     TEXT NOT NULL,
          review_id  TEXT,
          strikes    INTEGER NOT NULL DEFAULT 0,
          serialized INTEGER NOT NULL DEFAULT 0,
          overridden INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (target, branch)
        );
        INSERT INTO reviews (target, branch, review_id, strikes, serialized, overridden)
        VALUES ('main', 'co/old-schema', 'rev-after-pass', 4, 0, 0);

        CREATE TABLE cost_rollup (
          kind           TEXT NOT NULL,
          id             TEXT NOT NULL,
          total_cost_usd REAL NOT NULL DEFAULT 0,
          input_tokens   INTEGER NOT NULL DEFAULT 0,
          output_tokens  INTEGER NOT NULL DEFAULT 0,
          total_tokens   INTEGER NOT NULL DEFAULT 0,
          used_pct       REAL NOT NULL DEFAULT 0,
          observations   INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (kind, id)
        );
        INSERT INTO cost_rollup
          (kind, id, total_cost_usd, input_tokens, output_tokens, total_tokens, used_pct, observations)
        VALUES
          ('agent', 'impl-old', 0, 14, 16, 0, 0, 2),
          ('task', 'task-old', 0, 14, 16, 0, 0, 2);
      `);
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

  it('does not run schema migrations on first read of old projections under a held write lock', () => {
    seedOldProjectionSchemas();
    expect(hasColumn('reviews', 'scope')).toBe(false);
    expect(hasColumn('cost_rollup', 'token_observations')).toBe(false);

    const dbPath = join(projectDataDir(PROJECT_ID), 'store.db');
    const writer = new DatabaseSync(dbPath);
    writer.exec('PRAGMA journal_mode = WAL');
    writer.exec('PRAGMA busy_timeout = 5000');
    try {
      writer.exec('BEGIN IMMEDIATE');
      const snap = queryObservability(PROJECT_ID);
      expect(snap.agents[0]).toEqual(
        expect.objectContaining({ agentId: 'impl-old', role: 'implementer' }),
      );
      expect(snap.plans[0]).toEqual(
        expect.objectContaining({
          taskId: 'task-old',
          phases: [expect.objectContaining({ phaseId: 'phase-old' })],
        }),
      );
      expect(snap.reviews.find((r) => r.branch === 'co/old-schema')?.strikes).toBe(1);
      expect(snap.costRollups.find((r) => r.kind === 'agent' && r.id === 'impl-old')).toEqual(
        expect.objectContaining({
          inputTokens: 7,
          outputTokens: 8,
          totalTokens: 15,
          observations: 1,
        }),
      );
      writer.exec('ROLLBACK');
    } finally {
      writer.close();
    }

    expect(hasColumn('reviews', 'scope')).toBe(false);
    expect(hasColumn('cost_rollup', 'token_observations')).toBe(false);
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

  it('fails loud on conflicting legacy duplicate cost events without writing observations', () => {
    seedConflictingLegacyCostRollups();
    expect(countRows('cost_observations')).toBe(0);

    expect(() => queryObservability(PROJECT_ID)).toThrow(/conflicting duplicate cost observation/);
    expect(countRows('cost_observations')).toBe(0);
  });
});
