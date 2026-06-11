import type { DatabaseSync } from 'node:sqlite';
import { assertNever } from '../assert-never.js';
import type { Projector } from '../replay/projector.js';
import type { StoredEvent, StoreTx } from '../store/types.js';
import type { Criterion } from './criteria-schema.js';
import {
  EVENT_SPEC_ARCHIVED,
  EVENT_SPEC_DRAFTED,
  EVENT_SPEC_LOCKED,
  type SpecArchived,
  type SpecDrafted,
  type SpecLocked,
  type SpecRecord,
} from './events.js';

const CREATE_SPECS_TABLE = `
  CREATE TABLE IF NOT EXISTS specs (
    task_id     TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    goal        TEXT NOT NULL,
    criteria    TEXT NOT NULL,
    body        TEXT NOT NULL,
    state       TEXT NOT NULL,
    locked_by   TEXT,
    drafted_ts  INTEGER NOT NULL,
    locked_ts   INTEGER,
    archived_ts INTEGER
  );
`;

/** Defensive create of the specs read-model table — called on reset/apply AND every read path. */
export function ensureSpecsTables(db: DatabaseSync): void {
  db.exec(CREATE_SPECS_TABLE);
}

const SPEC_COLUMNS =
  'task_id, title, goal, criteria, body, state, locked_by, drafted_ts, locked_ts, archived_ts';

/** Map a raw `specs` row to a {@link SpecRecord}. */
export function rowToSpecRecord(row: Record<string, unknown>): SpecRecord {
  return {
    taskId: String(row.task_id),
    title: String(row.title),
    goal: String(row.goal),
    criteria: JSON.parse(String(row.criteria)) as readonly Criterion[],
    body: String(row.body),
    state: String(row.state) as 'draft' | 'locked' | 'archived',
    ...(row.locked_by != null ? { lockedBy: String(row.locked_by) } : {}),
    draftedTs: Number(row.drafted_ts),
    ...(row.locked_ts != null ? { lockedTs: Number(row.locked_ts) } : {}),
    ...(row.archived_ts != null ? { archivedTs: Number(row.archived_ts) } : {}),
  };
}

/** The spec record for `taskId`, or undefined. */
export function selectSpec(db: DatabaseSync, taskId: string): SpecRecord | undefined {
  ensureSpecsTables(db);
  const row = db.prepare(`SELECT ${SPEC_COLUMNS} FROM specs WHERE task_id = ?`).get(taskId);
  return row ? rowToSpecRecord(row as Record<string, unknown>) : undefined;
}

/** All spec records, in stable order: by `drafted_ts` then `task_id` for tie-breaks. */
export function selectAllSpecs(db: DatabaseSync): SpecRecord[] {
  ensureSpecsTables(db);
  const rows = db.prepare(`SELECT ${SPEC_COLUMNS} FROM specs ORDER BY drafted_ts, task_id`).all();
  return rows.map((r) => rowToSpecRecord(r as Record<string, unknown>));
}

function sameDraft(existing: SpecRecord, rec: SpecDrafted): boolean {
  return (
    existing.title === rec.title &&
    existing.goal === rec.goal &&
    existing.body === rec.body &&
    JSON.stringify(existing.criteria) === JSON.stringify(rec.criteria)
  );
}

/**
 * Validate spec lifecycle transitions against the already-folded read model.
 * Returns the existing record when the operation is idempotent (no-op); throws on illegal
 * transitions (Principle 9 — loud-fail). Never returns silently for a true mutation.
 */
export function validateSpecTransition(
  db: DatabaseSync,
  type: string,
  payload: SpecDrafted | SpecLocked | SpecArchived,
): SpecRecord | undefined {
  const { taskId } = payload;

  if (type === EVENT_SPEC_DRAFTED) {
    const rec = payload as SpecDrafted;
    const existing = selectSpec(db, taskId);
    if (existing == null) return undefined;
    if (sameDraft(existing, rec)) return existing;
    throw new Error(
      `specs: spec '${taskId}' already exists with different content — refusing conflicting re-draft`,
    );
  }

  if (type === EVENT_SPEC_LOCKED) {
    const rec = payload as SpecLocked;
    const existing = selectSpec(db, taskId);
    if (existing == null) {
      throw new Error(`specs: cannot lock spec '${taskId}' — no draft exists`);
    }
    if (existing.state === 'archived') {
      throw new Error(`specs: cannot lock spec '${taskId}' — already archived`);
    }
    if (existing.state === 'locked') {
      if (existing.lockedBy === rec.lockedBy) return existing;
      throw new Error(
        `specs: spec '${taskId}' is already locked by '${existing.lockedBy}' — refusing ` +
          `re-lock by '${rec.lockedBy}'`,
      );
    }
    return undefined;
  }

  if (type === EVENT_SPEC_ARCHIVED) {
    const existing = selectSpec(db, taskId);
    if (existing == null) {
      throw new Error(`specs: cannot archive spec '${taskId}' — no draft exists`);
    }
    if (existing.state === 'archived') return existing;
    return undefined;
  }

  throw new Error(`specs: unknown event type '${type}'`);
}

interface SpecDraftedEvent extends StoredEvent {
  readonly type: typeof EVENT_SPEC_DRAFTED;
  readonly payload: SpecDrafted;
}
interface SpecLockedEvent extends StoredEvent {
  readonly type: typeof EVENT_SPEC_LOCKED;
  readonly payload: SpecLocked;
}
interface SpecArchivedEvent extends StoredEvent {
  readonly type: typeof EVENT_SPEC_ARCHIVED;
  readonly payload: SpecArchived;
}
type SpecEvent = SpecDraftedEvent | SpecLockedEvent | SpecArchivedEvent;

/**
 * Folds spec events into the `specs` read-model. Enforces the `draft → locked → archived`
 * lifecycle with loud-fail on illegal transitions (Principle 9). `event.ts` is used for all
 * timestamps (never wall-clock — freeze #6).
 */
export class SpecsProjector implements Projector {
  readonly name = 'specs';

  handles(type: string): boolean {
    return (
      type === EVENT_SPEC_DRAFTED || type === EVENT_SPEC_LOCKED || type === EVENT_SPEC_ARCHIVED
    );
  }

  reset(tx: StoreTx): void {
    const db = tx.raw as DatabaseSync;
    ensureSpecsTables(db);
    db.exec('DELETE FROM specs');
  }

  apply(tx: StoreTx, event: StoredEvent): void {
    const db = tx.raw as DatabaseSync;
    ensureSpecsTables(db);
    const specEvent = event as SpecEvent;
    const type = specEvent.type;
    switch (type) {
      case EVENT_SPEC_DRAFTED: {
        const { taskId, title, goal, criteria, body } = specEvent.payload;
        const existing = validateSpecTransition(db, type, specEvent.payload);
        if (existing != null) return;
        db.prepare(
          `INSERT INTO specs (task_id, title, goal, criteria, body, state, drafted_ts)
           VALUES (?, ?, ?, ?, ?, 'draft', ?)`,
        ).run(taskId, title, goal, JSON.stringify(criteria), body, event.ts);
        return;
      }
      case EVENT_SPEC_LOCKED: {
        const { taskId, lockedBy } = specEvent.payload;
        const existing = validateSpecTransition(db, type, specEvent.payload);
        if (existing != null) return;
        db.prepare(
          `UPDATE specs SET state = 'locked', locked_by = ?, locked_ts = ? WHERE task_id = ?`,
        ).run(lockedBy, event.ts, taskId);
        return;
      }
      case EVENT_SPEC_ARCHIVED: {
        const { taskId } = specEvent.payload;
        const existing = validateSpecTransition(db, type, specEvent.payload);
        if (existing != null) return;
        db.prepare(`UPDATE specs SET state = 'archived', archived_ts = ? WHERE task_id = ?`).run(
          event.ts,
          taskId,
        );
        return;
      }
      default:
        return assertNever(type);
    }
  }
}
