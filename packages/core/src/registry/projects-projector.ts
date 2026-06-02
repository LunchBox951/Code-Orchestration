import type { DatabaseSync } from 'node:sqlite';
import { assertNever } from '../assert-never.js';
import type { Projector } from '../replay/projector.js';
import type { StoredEvent, StoreTx } from '../store/types.js';
import {
  EVENT_PROJECT_REGISTERED,
  EVENT_PROJECT_RELINKED,
  type ProjectRegistered,
  type ProjectRelinked,
} from './events.js';

const CREATE_PROJECTS_TABLE = `
  CREATE TABLE IF NOT EXISTS projects (
    project_id   TEXT PRIMARY KEY,
    current_path TEXT UNIQUE NOT NULL,
    created_ts   INTEGER NOT NULL
  )
`;

/**
 * Defensive create of the `projects` read-model. Called from the projector's
 * reset/apply AND every registry read path, so a freshly opened store can resolve
 * before any write has happened.
 */
export function ensureProjectsTable(db: DatabaseSync): void {
  db.exec(CREATE_PROJECTS_TABLE);
}

// `handles()` guarantees only these two types reach `apply()`; modelling them as a
// StoredEvent subtype lets the switch be GENUINELY exhaustive (assertNever sees a
// real `never`), not a cast-to-never escape hatch.
interface RegisteredEvent extends StoredEvent {
  readonly type: typeof EVENT_PROJECT_REGISTERED;
  readonly payload: ProjectRegistered;
}
interface RelinkedEvent extends StoredEvent {
  readonly type: typeof EVENT_PROJECT_RELINKED;
  readonly payload: ProjectRelinked;
}
type RegistryEvent = RegisteredEvent | RelinkedEvent;

/**
 * Folds registry events into the `projects` read-model in the GLOBAL db. The
 * `UNIQUE(current_path)` column IS the path→id index that resolve() queries.
 * Maintained in the SAME tx as the append, so the log and projection commit
 * atomically; created_ts comes from the event's PERSISTED ts (freeze #6).
 */
export class ProjectsProjector implements Projector {
  readonly name = 'projects';

  handles(type: string): boolean {
    return type === EVENT_PROJECT_REGISTERED || type === EVENT_PROJECT_RELINKED;
  }

  reset(tx: StoreTx): void {
    const db = tx.raw as DatabaseSync;
    ensureProjectsTable(db);
    db.exec('DELETE FROM projects');
  }

  apply(tx: StoreTx, event: StoredEvent): void {
    const db = tx.raw as DatabaseSync;
    ensureProjectsTable(db);
    const registryEvent = event as RegistryEvent;
    switch (registryEvent.type) {
      case EVENT_PROJECT_REGISTERED: {
        const { projectId, path } = registryEvent.payload;
        // created_ts is the event's PERSISTED ts (freeze #6), never wall-clock.
        db.prepare(
          'INSERT INTO projects (project_id, current_path, created_ts) VALUES (?, ?, ?)',
        ).run(projectId, path, event.ts);
        return;
      }
      case EVENT_PROJECT_RELINKED: {
        const { projectId, newPath } = registryEvent.payload;
        db.prepare('UPDATE projects SET current_path = ? WHERE project_id = ?').run(
          newPath,
          projectId,
        );
        return;
      }
      default:
        return assertNever(registryEvent);
    }
  }
}
