import type { DatabaseSync } from 'node:sqlite';
import { assertNever } from '../assert-never.js';
import type { Projector } from '../replay/projector.js';
import type { StoredEvent, StoreTx } from '../store/types.js';
import {
  EVENT_ARCHIVE_APPENDED,
  EVENT_ARCHIVE_REMOVED,
  type ArchiveRecord,
  type ArchiveAppended,
} from './events.js';

const CREATE_ARCHIVE_TABLE = `
  CREATE TABLE IF NOT EXISTS archive (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    branch     TEXT NOT NULL,
    base_ref   TEXT NOT NULL,
    deleted_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`;

const CREATE_ARCHIVE_EXPIRES_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_archive_expires ON archive(expires_at);
`;

/** Defensive create of the archive read-model table and index — called on reset/apply AND every read path. */
export function ensureArchiveTables(db: DatabaseSync): void {
  db.exec(CREATE_ARCHIVE_TABLE);
  db.exec(CREATE_ARCHIVE_EXPIRES_INDEX);
}

/** Map a raw `archive` row to an {@link ArchiveRecord}. */
export function rowToArchiveRecord(row: Record<string, unknown>): ArchiveRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    branch: String(row.branch),
    baseRef: String(row.base_ref),
    deletedAt: Number(row.deleted_at),
    expiresAt: Number(row.expires_at),
  };
}

const ARCHIVE_COLUMNS = 'id, name, branch, base_ref, deleted_at, expires_at';

/** The archive record for `id`, or undefined. */
export function selectArchive(db: DatabaseSync, id: string): ArchiveRecord | undefined {
  ensureArchiveTables(db);
  const row = db.prepare(`SELECT ${ARCHIVE_COLUMNS} FROM archive WHERE id = ?`).get(id);
  return row ? rowToArchiveRecord(row as Record<string, unknown>) : undefined;
}

/** All archive records, in stable order: by `deleted_at` then `id` for tie-breaks. */
export function selectAllArchive(db: DatabaseSync): ArchiveRecord[] {
  ensureArchiveTables(db);
  const rows = db.prepare(`SELECT ${ARCHIVE_COLUMNS} FROM archive ORDER BY deleted_at, id`).all();
  return rows.map((r) => rowToArchiveRecord(r as Record<string, unknown>));
}

/**
 * All archive records whose `expires_at` is STRICTLY LESS THAN `nowMs`.
 * The strict `<` boundary means a record at exactly `nowMs` is NOT expired.
 * Ordered by `expires_at, id` for deterministic reaper processing.
 *
 * `nowMs` is an injected parameter (never wall-clock — replay-deterministic).
 */
export function selectExpired(db: DatabaseSync, nowMs: number): ArchiveRecord[] {
  ensureArchiveTables(db);
  const rows = db
    .prepare(`SELECT ${ARCHIVE_COLUMNS} FROM archive WHERE expires_at < ? ORDER BY expires_at, id`)
    .all(nowMs);
  return rows.map((r) => rowToArchiveRecord(r as Record<string, unknown>));
}

interface ArchiveAppendedEvent extends StoredEvent {
  readonly type: typeof EVENT_ARCHIVE_APPENDED;
  readonly payload: ArchiveAppended;
}
interface ArchiveRemovedEvent extends StoredEvent {
  readonly type: typeof EVENT_ARCHIVE_REMOVED;
  readonly payload: { id: string };
}
type ArchiveEvent = ArchiveAppendedEvent | ArchiveRemovedEvent;

/**
 * Folds `archive.appended` / `archive.removed` events into the `archive` read-model.
 * Appending an identical row is a no-op (idempotent); a conflicting re-append fails loud.
 * Removal is a no-op if the record has already been removed (remove is idempotent in replay).
 */
export class ArchiveProjector implements Projector {
  readonly name = 'archive';

  handles(type: string): boolean {
    return type === EVENT_ARCHIVE_APPENDED || type === EVENT_ARCHIVE_REMOVED;
  }

  reset(tx: StoreTx): void {
    const db = tx.raw as DatabaseSync;
    ensureArchiveTables(db);
    db.exec('DELETE FROM archive');
  }

  apply(tx: StoreTx, event: StoredEvent): void {
    const db = tx.raw as DatabaseSync;
    ensureArchiveTables(db);
    const archiveEvent = event as ArchiveEvent;
    const type = archiveEvent.type;
    switch (type) {
      case EVENT_ARCHIVE_APPENDED: {
        const { id, name, branch, baseRef, deletedAt, expiresAt } =
          archiveEvent.payload as ArchiveAppended;
        // Idempotent: if identical row already exists (replay), skip. Conflict = loud fail.
        const existing = selectArchive(db, id);
        if (existing != null) {
          if (
            existing.name === name &&
            existing.branch === branch &&
            existing.baseRef === baseRef &&
            existing.deletedAt === deletedAt &&
            existing.expiresAt === expiresAt
          ) {
            return; // identical — idempotent no-op
          }
          throw new Error(
            `archive: conflicting re-append for id '${id}' — existing record differs from incoming payload`,
          );
        }
        db.prepare(
          `INSERT INTO archive (id, name, branch, base_ref, deleted_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(id, name, branch, baseRef, deletedAt, expiresAt);
        return;
      }
      case EVENT_ARCHIVE_REMOVED: {
        db.prepare('DELETE FROM archive WHERE id = ?').run(archiveEvent.payload.id);
        return;
      }
      default:
        return assertNever(type);
    }
  }
}
