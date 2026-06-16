import type { DatabaseSync } from 'node:sqlite';
import { assertNever } from '../assert-never.js';
import type { Projector } from '../replay/projector.js';
import type { StoredEvent, StoreTx } from '../store/types.js';
import {
  EVENT_BASELINE_CAPTURED,
  EVENT_FINISH_RECORDED,
  EVENT_WORKTREE_CREATED,
  EVENT_WORKTREE_REMOVED,
  worktreeProvisionedEntrySchema,
  type Baseline,
  type BaselineCaptured,
  type FinishRecord,
  type FinishRecorded,
  type TestOutcome,
  type WorktreeCreated,
  type WorktreeRecord,
  type WorktreeRemoved,
} from './events.js';

/**
 * The L3 read-model: one `worktrees` row per slung branch, one `baselines` row per branch's
 * branch-off snapshot, and one `finishes` row per branch's recorded finish. All keyed by `branch`
 * (the natural identity of a sandbox). Every column is log-derived, so a `rebuildAll` reproduces
 * them byte-identical (AC-L0-2 / freeze #6): `created_ts` / `captured_ts` / `recorded_ts` come from
 * the PERSISTED event ts, and the `tests` arrays are stored as the deterministic JSON of the
 * validated array (stable key order — zod yields `{name, passed}`).
 *
 * `removed` is the phase-E teardown flag (default 0); carried now so E lights up by folding a
 * `worktree.removed` event without reshaping the table.
 *
 * `finishes` is keyed by `branch` and folded as an UPSERT (last finish wins): unlike a one-shot
 * `worktree.created`, a worker may finish more than once (a review kickback → fix → re-finish), so
 * the read-model holds the LATEST finish per branch — which is the one L5 compares. Replaying the
 * log in seq order reaches the same final row, so the rebuild stays byte-identical.
 */
const CREATE_WORKTREE_TABLES = `
  CREATE TABLE IF NOT EXISTS worktrees (
    branch     TEXT PRIMARY KEY,
    base_ref   TEXT NOT NULL,
    base_sha   TEXT NOT NULL,
    path       TEXT NOT NULL,
    parent     TEXT NOT NULL,
    agent      TEXT,
    role       TEXT,
    sub_role   TEXT,
    created_ts INTEGER NOT NULL,
    removed    INTEGER NOT NULL DEFAULT 0,
    provisioned TEXT
  );
  CREATE TABLE IF NOT EXISTS baselines (
    branch      TEXT PRIMARY KEY,
    base_ref    TEXT NOT NULL,
    base_sha    TEXT NOT NULL,
    tests       TEXT NOT NULL,
    captured_ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS finishes (
    branch      TEXT PRIMARY KEY,
    base_sha    TEXT NOT NULL,
    commit_sha  TEXT NOT NULL,
    tests       TEXT NOT NULL,
    recorded_ts INTEGER NOT NULL,
    recorded_seq INTEGER,
    agent       TEXT
  );
`;

/**
 * Defensive create of the L3 read-model tables. Called from the projector's reset/apply AND every
 * read path, so a freshly opened store can be queried before any write has happened.
 */
export function ensureWorktreeTables(db: DatabaseSync): void {
  db.exec(CREATE_WORKTREE_TABLES);
  const worktreeColumns = db.prepare('PRAGMA table_info(worktrees)').all() as Array<{
    name: string;
  }>;
  if (!worktreeColumns.some((c) => c.name === 'provisioned')) {
    db.exec('ALTER TABLE worktrees ADD COLUMN provisioned TEXT');
  }
  if (!worktreeColumns.some((c) => c.name === 'agent')) {
    db.exec('ALTER TABLE worktrees ADD COLUMN agent TEXT');
  }
  if (!worktreeColumns.some((c) => c.name === 'role')) {
    db.exec('ALTER TABLE worktrees ADD COLUMN role TEXT');
  }
  if (!worktreeColumns.some((c) => c.name === 'sub_role')) {
    db.exec('ALTER TABLE worktrees ADD COLUMN sub_role TEXT');
  }
  const finishColumns = db.prepare('PRAGMA table_info(finishes)').all() as Array<{ name: string }>;
  if (!finishColumns.some((c) => c.name === 'agent')) {
    db.exec('ALTER TABLE finishes ADD COLUMN agent TEXT');
  }
  if (!finishColumns.some((c) => c.name === 'recorded_seq')) {
    db.exec('ALTER TABLE finishes ADD COLUMN recorded_seq INTEGER');
  }
  backfillFinishRecordedSeq(db);
}

function worktreeTableExists(db: DatabaseSync, name: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return row != null;
}

function backfillFinishRecordedSeq(db: DatabaseSync): void {
  if (!worktreeTableExists(db, 'events')) return;
  db.prepare(
    `UPDATE finishes
        SET recorded_seq = (
          SELECT e.seq
            FROM events e
           WHERE e.type = ?
             AND json_extract(e.payload, '$.branch') = finishes.branch
           ORDER BY e.seq DESC
           LIMIT 1
        )
      WHERE recorded_seq IS NULL`,
  ).run(EVENT_FINISH_RECORDED);
}

// `handles()` guarantees only these worktree event types reach `apply()`; modelling them as a StoredEvent
// subtype lets the switch be GENUINELY exhaustive (assertNever sees a real `never`), mirroring
// registry/projects-projector.ts.
interface WorktreeCreatedEvent extends StoredEvent {
  readonly type: typeof EVENT_WORKTREE_CREATED;
  readonly payload: WorktreeCreated;
}
interface BaselineCapturedEvent extends StoredEvent {
  readonly type: typeof EVENT_BASELINE_CAPTURED;
  readonly payload: BaselineCaptured;
}
interface FinishRecordedEvent extends StoredEvent {
  readonly type: typeof EVENT_FINISH_RECORDED;
  readonly payload: FinishRecorded;
}
interface WorktreeRemovedEvent extends StoredEvent {
  readonly type: typeof EVENT_WORKTREE_REMOVED;
  readonly payload: WorktreeRemoved;
}
type WorktreeEvent =
  | WorktreeCreatedEvent
  | BaselineCapturedEvent
  | FinishRecordedEvent
  | WorktreeRemovedEvent;

/** Map a raw `worktrees` row (loosely typed at the SQLite boundary) to a {@link WorktreeRecord}. */
export function rowToWorktreeRecord(row: Record<string, unknown>): WorktreeRecord {
  const provisioned =
    row.provisioned != null
      ? worktreeProvisionedEntrySchema.array().parse(JSON.parse(String(row.provisioned)))
      : undefined;
  return {
    branch: String(row.branch),
    baseRef: String(row.base_ref),
    baseSha: String(row.base_sha),
    path: String(row.path),
    parent: String(row.parent),
    ...(row.agent != null ? { agent: String(row.agent) } : {}),
    ...(row.role != null ? { role: String(row.role) } : {}),
    ...(row.sub_role != null ? { subRole: String(row.sub_role) } : {}),
    createdTs: Number(row.created_ts),
    removed: Number(row.removed) === 1,
    ...(provisioned !== undefined ? { provisioned } : {}),
  };
}

/** Map a raw `baselines` row to a {@link Baseline} (the `tests` JSON column is parsed back). */
export function rowToBaseline(row: Record<string, unknown>): Baseline {
  return {
    branch: String(row.branch),
    baseRef: String(row.base_ref),
    baseSha: String(row.base_sha),
    tests: JSON.parse(String(row.tests)) as TestOutcome[],
    capturedTs: Number(row.captured_ts),
  };
}

/** Map a raw `finishes` row to a {@link FinishRecord} (the `tests` JSON column is parsed back). */
export function rowToFinishRecord(row: Record<string, unknown>): FinishRecord {
  return {
    branch: String(row.branch),
    baseSha: String(row.base_sha),
    commitSha: String(row.commit_sha),
    tests: JSON.parse(String(row.tests)) as TestOutcome[],
    recordedTs: Number(row.recorded_ts),
    ...(row.recorded_seq != null ? { recordedSeq: Number(row.recorded_seq) } : {}),
    ...(row.agent != null ? { agent: String(row.agent) } : {}),
  };
}

const WORKTREE_COLUMNS =
  'branch, base_ref, base_sha, path, parent, agent, role, sub_role, created_ts, removed, provisioned';
const BASELINE_COLUMNS = 'branch, base_ref, base_sha, tests, captured_ts';
const FINISH_COLUMNS = 'branch, base_sha, commit_sha, tests, recorded_ts, recorded_seq, agent';

/** The worktree record for `branch`, or undefined. */
export function selectWorktree(db: DatabaseSync, branch: string): WorktreeRecord | undefined {
  ensureWorktreeTables(db);
  const row = db.prepare(`SELECT ${WORKTREE_COLUMNS} FROM worktrees WHERE branch = ?`).get(branch);
  return row ? rowToWorktreeRecord(row as Record<string, unknown>) : undefined;
}

/** All worktree records, in creation order (by the persisted ts, then branch for a stable tie-break). */
export function selectAllWorktrees(db: DatabaseSync): WorktreeRecord[] {
  ensureWorktreeTables(db);
  const rows = db
    .prepare(`SELECT ${WORKTREE_COLUMNS} FROM worktrees ORDER BY created_ts, branch`)
    .all();
  return rows.map((r) => rowToWorktreeRecord(r as Record<string, unknown>));
}

/** The baseline for `branch`, or undefined. */
export function selectBaseline(db: DatabaseSync, branch: string): Baseline | undefined {
  ensureWorktreeTables(db);
  const row = db.prepare(`SELECT ${BASELINE_COLUMNS} FROM baselines WHERE branch = ?`).get(branch);
  return row ? rowToBaseline(row as Record<string, unknown>) : undefined;
}

/** The recorded finish for `branch`, or undefined. */
export function selectFinish(db: DatabaseSync, branch: string): FinishRecord | undefined {
  ensureWorktreeTables(db);
  const row = db.prepare(`SELECT ${FINISH_COLUMNS} FROM finishes WHERE branch = ?`).get(branch);
  return row ? rowToFinishRecord(row as Record<string, unknown>) : undefined;
}

/**
 * Folds the two L3 worktree events into the `worktrees` / `baselines` read-model, in the SAME tx as
 * the append so the log and the projection commit atomically; carries NO wall-clock field (freeze
 * #6 — it persists the event ts). A duplicate LIVE branch fails loud; a previously removed branch can
 * be recreated so cleanup-after-failure leaves deterministic root/child branches retryable.
 */
export class WorktreeProjector implements Projector {
  readonly name = 'worktrees';

  handles(type: string): boolean {
    return (
      type === EVENT_WORKTREE_CREATED ||
      type === EVENT_BASELINE_CAPTURED ||
      type === EVENT_FINISH_RECORDED ||
      type === EVENT_WORKTREE_REMOVED
    );
  }

  reset(tx: StoreTx): void {
    const db = tx.raw as DatabaseSync;
    ensureWorktreeTables(db);
    db.exec('DELETE FROM worktrees');
    db.exec('DELETE FROM baselines');
    db.exec('DELETE FROM finishes');
  }

  apply(tx: StoreTx, event: StoredEvent): void {
    const db = tx.raw as DatabaseSync;
    ensureWorktreeTables(db);
    const worktreeEvent = event as WorktreeEvent;
    switch (worktreeEvent.type) {
      case EVENT_WORKTREE_CREATED: {
        const { branch, baseRef, baseSha, path, parent, agent, role, subRole, provisioned } =
          worktreeEvent.payload;
        const existing = selectWorktree(db, branch);
        if (existing != null && !existing.removed) {
          throw new Error(
            `worktree.created: branch '${branch}' already has a live worktree record.`,
          );
        }
        if (existing != null) {
          db.prepare('DELETE FROM baselines WHERE branch = ?').run(branch);
          db.prepare('DELETE FROM finishes WHERE branch = ?').run(branch);
          db.prepare(
            `UPDATE worktrees
                SET base_ref = ?,
                    base_sha = ?,
                    path = ?,
                    parent = ?,
                    agent = ?,
                    role = ?,
                    sub_role = ?,
                    created_ts = ?,
                    removed = 0,
                    provisioned = ?
              WHERE branch = ?`,
          ).run(
            baseRef,
            baseSha,
            path,
            parent,
            agent ?? null,
            role ?? null,
            subRole ?? null,
            event.ts,
            provisioned != null ? JSON.stringify(provisioned) : null,
            branch,
          );
        } else {
          db.prepare(
            `INSERT INTO worktrees
               (branch, base_ref, base_sha, path, parent, agent, role, sub_role, created_ts, removed, provisioned)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
          ).run(
            branch,
            baseRef,
            baseSha,
            path,
            parent,
            agent ?? null,
            role ?? null,
            subRole ?? null,
            event.ts,
            provisioned != null ? JSON.stringify(provisioned) : null,
          );
        }
        return;
      }
      case EVENT_BASELINE_CAPTURED: {
        const { branch, baseRef, baseSha, tests } = worktreeEvent.payload;
        // Persist the validated array's deterministic JSON (stable key order), so a rebuild
        // reproduces the same bytes. event.ts is the persisted capture time (never wall-clock).
        db.prepare(
          `INSERT INTO baselines (branch, base_ref, base_sha, tests, captured_ts)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(branch, baseRef, baseSha, JSON.stringify(tests), event.ts);
        return;
      }
      case EVENT_FINISH_RECORDED: {
        const { branch, baseSha, commitSha, tests, agent } = worktreeEvent.payload;
        // UPSERT (last finish wins) — a worker may re-finish after a review kickback, so the
        // read-model holds the LATEST finish per branch. Replaying the log in seq order reaches
        // the same final row, so the rebuild stays byte-identical. event.ts is the persisted
        // record time (never wall-clock).
        db.prepare(
          `INSERT INTO finishes (branch, base_sha, commit_sha, tests, recorded_ts, recorded_seq, agent)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(branch) DO UPDATE SET
             base_sha = excluded.base_sha,
             commit_sha = excluded.commit_sha,
             tests = excluded.tests,
             recorded_ts = excluded.recorded_ts,
             recorded_seq = excluded.recorded_seq,
             agent = excluded.agent`,
        ).run(
          branch,
          baseSha,
          commitSha,
          JSON.stringify(tests),
          event.ts,
          event.seq,
          agent ?? null,
        );
        return;
      }
      case EVENT_WORKTREE_REMOVED: {
        const { branch } = worktreeEvent.payload;
        // Teardown (L3-E): mark the sandbox record removed. Idempotent + replay-safe — a re-removal
        // (or a branch with no row) re-asserts the same flag with no side effect, so the rebuild
        // reaches a byte-identical row. Carries NO wall-clock field (freeze #6).
        db.prepare('UPDATE worktrees SET removed = 1 WHERE branch = ?').run(branch);
        return;
      }
      default:
        return assertNever(worktreeEvent);
    }
  }
}
