import type { DatabaseSync } from 'node:sqlite';
import { assertNever } from '../assert-never.js';
import type { Projector } from '../replay/projector.js';
import type { StoredEvent, StoreTx } from '../store/types.js';
import {
  EVENT_BASELINE_CAPTURED,
  EVENT_WORKTREE_CREATED,
  type Baseline,
  type BaselineCaptured,
  type TestOutcome,
  type WorktreeCreated,
  type WorktreeRecord,
} from './events.js';

/**
 * The L3 read-model: one `worktrees` row per slung branch and one `baselines` row per branch's
 * branch-off snapshot. Both keyed by `branch` (the natural identity of a sandbox). All columns are
 * log-derived, so a `rebuildAll` reproduces them byte-identical (AC-L0-2 / freeze #6): `created_ts`
 * / `captured_ts` come from the PERSISTED event ts, and the baseline `tests` are stored as the
 * deterministic JSON of the validated array (stable key order — zod yields `{name, passed}`).
 *
 * `removed` is the phase-E teardown flag (default 0); carried now so E lights up by folding a
 * `worktree.removed` event without reshaping the table.
 */
const CREATE_WORKTREE_TABLES = `
  CREATE TABLE IF NOT EXISTS worktrees (
    branch     TEXT PRIMARY KEY,
    base_ref   TEXT NOT NULL,
    base_sha   TEXT NOT NULL,
    path       TEXT NOT NULL,
    parent     TEXT NOT NULL,
    created_ts INTEGER NOT NULL,
    removed    INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS baselines (
    branch      TEXT PRIMARY KEY,
    base_ref    TEXT NOT NULL,
    base_sha    TEXT NOT NULL,
    tests       TEXT NOT NULL,
    captured_ts INTEGER NOT NULL
  );
`;

/**
 * Defensive create of the L3 read-model tables. Called from the projector's reset/apply AND every
 * read path, so a freshly opened store can be queried before any write has happened.
 */
export function ensureWorktreeTables(db: DatabaseSync): void {
  db.exec(CREATE_WORKTREE_TABLES);
}

// `handles()` guarantees only these two types reach `apply()`; modelling them as a StoredEvent
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
type WorktreeEvent = WorktreeCreatedEvent | BaselineCapturedEvent;

/** Map a raw `worktrees` row (loosely typed at the SQLite boundary) to a {@link WorktreeRecord}. */
export function rowToWorktreeRecord(row: Record<string, unknown>): WorktreeRecord {
  return {
    branch: String(row.branch),
    baseRef: String(row.base_ref),
    baseSha: String(row.base_sha),
    path: String(row.path),
    parent: String(row.parent),
    createdTs: Number(row.created_ts),
    removed: Number(row.removed) === 1,
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

const WORKTREE_COLUMNS = 'branch, base_ref, base_sha, path, parent, created_ts, removed';
const BASELINE_COLUMNS = 'branch, base_ref, base_sha, tests, captured_ts';

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

/**
 * Folds the two L3 worktree events into the `worktrees` / `baselines` read-model, in the SAME tx as
 * the append so the log and the projection commit atomically; carries NO wall-clock field (freeze
 * #6 — it persists the event ts). A duplicate insert (same branch twice) fails loud at the PK —
 * slinging the same branch twice is a programming error (Principle 9), not a silent overwrite.
 */
export class WorktreeProjector implements Projector {
  readonly name = 'worktrees';

  handles(type: string): boolean {
    return type === EVENT_WORKTREE_CREATED || type === EVENT_BASELINE_CAPTURED;
  }

  reset(tx: StoreTx): void {
    const db = tx.raw as DatabaseSync;
    ensureWorktreeTables(db);
    db.exec('DELETE FROM worktrees');
    db.exec('DELETE FROM baselines');
  }

  apply(tx: StoreTx, event: StoredEvent): void {
    const db = tx.raw as DatabaseSync;
    ensureWorktreeTables(db);
    const worktreeEvent = event as WorktreeEvent;
    switch (worktreeEvent.type) {
      case EVENT_WORKTREE_CREATED: {
        const { branch, baseRef, baseSha, path, parent } = worktreeEvent.payload;
        db.prepare(
          `INSERT INTO worktrees (branch, base_ref, base_sha, path, parent, created_ts, removed)
           VALUES (?, ?, ?, ?, ?, ?, 0)`,
        ).run(branch, baseRef, baseSha, path, parent, event.ts);
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
      default:
        return assertNever(worktreeEvent);
    }
  }
}
