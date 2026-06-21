/**
 * The durable archive of unmerged branches. Opens the PROJECT store, wires the
 * {@link ArchiveProjector}, and exposes a typed {@link ArchiveStore} facade.
 *
 * The cascade-delete primitive appends records here; the reaper purges expired ones;
 * IPC verbs list/restore/purge them. Scope prefix: `archive:`. Table: `archive`.
 */
import type { DatabaseSync } from 'node:sqlite';
import { decode } from '../replay/decode.js';
import { applyEvent, type Projector } from '../replay/projector.js';
import { openProjectStore } from '../store/sqlite-store.js';
import {
  makeArchiveAppendedEvent,
  makeArchiveRemovedEvent,
  archiveSchemas,
  archiveUpcasters,
  type ArchiveRecord,
  type ArchiveAppended,
} from './events.js';
import {
  ArchiveProjector,
  ensureArchiveTables,
  selectArchive,
  selectAllArchive,
  selectExpired,
} from './archive-projector.js';

export interface ArchiveStore {
  /** Append an archive record (append `archive.appended` + fold); returns the read-back record. */
  appendRecord(rec: ArchiveAppended): ArchiveRecord;
  /**
   * Remove an archived record (append `archive.removed` + fold); returns the existing record if
   * present, or undefined if the id was not found.
   */
  removeRecord(id: string): ArchiveRecord | undefined;
  /** The archive record for `id`, or undefined. */
  getRecord(id: string): ArchiveRecord | undefined;
  /** Every archived record, in stable order (deleted_at, id). */
  listRecords(): readonly ArchiveRecord[];
  /**
   * All records whose `expiresAt` is STRICTLY LESS THAN `nowMs`.
   * The strict `<` boundary means a record at exactly `nowMs` is NOT expired.
   * `nowMs` is an injected parameter (never wall-clock — replay-deterministic).
   */
  listExpired(nowMs: number): readonly ArchiveRecord[];
  /** Close the underlying project store. */
  close(): void;
}

/**
 * Open the project archive store: open the PROJECT store, wire the {@link ArchiveProjector}, and
 * return the {@link ArchiveStore} facade. Safe alongside other stores on the same per-project
 * `store.db` — `node:sqlite` is synchronous/single-threaded; the archive owns distinct scopes
 * (`archive:`) and a distinct read-model table (`archive`).
 */
export function openArchiveStore(projectId: string): ArchiveStore {
  const store = openProjectStore(projectId);
  const projectors: readonly Projector[] = [new ArchiveProjector()];

  return {
    appendRecord(rec: ArchiveAppended): ArchiveRecord {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureArchiveTables(db);
        const [stored] = tx.append([makeArchiveAppendedEvent(projectId, rec)]);
        applyEvent(tx, decode(stored!, archiveUpcasters, archiveSchemas), projectors);
        const row = selectArchive(db, rec.id);
        if (!row) {
          throw new Error(
            `openArchiveStore.appendRecord: row missing after projection (id='${rec.id}')`,
          );
        }
        return row;
      });
    },

    removeRecord(id: string): ArchiveRecord | undefined {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureArchiveTables(db);
        const existing = selectArchive(db, id);
        if (existing == null) return undefined;
        const [stored] = tx.append([makeArchiveRemovedEvent(projectId, { id })]);
        applyEvent(tx, decode(stored!, archiveUpcasters, archiveSchemas), projectors);
        return existing;
      });
    },

    getRecord(id: string): ArchiveRecord | undefined {
      return store.transaction((tx) => selectArchive(tx.raw as DatabaseSync, id));
    },

    listRecords(): readonly ArchiveRecord[] {
      return store.transaction((tx) => selectAllArchive(tx.raw as DatabaseSync));
    },

    listExpired(nowMs: number): readonly ArchiveRecord[] {
      return store.transaction((tx) => selectExpired(tx.raw as DatabaseSync, nowMs));
    },

    close(): void {
      store.close();
    },
  };
}
