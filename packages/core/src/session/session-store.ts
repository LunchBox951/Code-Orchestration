/**
 * The L7 durable session projection store. Opens the PROJECT store, wires the
 * {@link SessionProjector}, and exposes a typed {@link SessionStore} facade.
 *
 * Each store opens its OWN project store and wires its OWN projector (no central registry).
 * The `session:` scope and `sessions` table are distinct from other projections, so this store
 * coexists safely alongside the roster and dispatch stores on the same per-project db.
 */
import type { DatabaseSync } from 'node:sqlite';
import { decode } from '../replay/decode.js';
import { applyEvent, type Projector } from '../replay/projector.js';
import { openProjectStore } from '../store/sqlite-store.js';
import {
  makeSessionCreatedEvent,
  sessionSchemas,
  sessionUpcasters,
  type SessionCreated,
  type SessionRecord,
} from './events.js';
import {
  SessionProjector,
  ensureSessionTable,
  selectSession,
  selectAllSessions,
} from './session-projector.js';

export interface SessionStore {
  /** Record (or replace) a session for an agent (appends `session.created` + folds); returns the read-back record. */
  recordSession(rec: SessionCreated): SessionRecord;
  /** The current session for `agentId`, or undefined. */
  getSession(agentId: string): SessionRecord | undefined;
  /** Every recorded session, in creation order. */
  listSessions(): readonly SessionRecord[];
  /** Close the underlying project store. */
  close(): void;
}

/**
 * Open the project session store: open the PROJECT store, wire the {@link SessionProjector}, and
 * return the {@link SessionStore} facade. Safe alongside other stores on the same per-project db.
 */
export function openSessionStore(projectId: string): SessionStore {
  const store = openProjectStore(projectId);
  const projectors: readonly Projector[] = [new SessionProjector()];

  return {
    recordSession(rec: SessionCreated): SessionRecord {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureSessionTable(db);
        const [stored] = tx.append([makeSessionCreatedEvent(projectId, rec)]);
        applyEvent(tx, decode(stored!, sessionUpcasters, sessionSchemas), projectors);
        const row = selectSession(db, rec.agentId);
        if (!row) {
          throw new Error(
            `openSessionStore.recordSession: row missing after projection (agentId='${rec.agentId}')`,
          );
        }
        return row;
      });
    },

    getSession(agentId: string): SessionRecord | undefined {
      return store.transaction((tx) => selectSession(tx.raw as DatabaseSync, agentId));
    },

    listSessions(): readonly SessionRecord[] {
      return store.transaction((tx) => selectAllSessions(tx.raw as DatabaseSync));
    },

    close(): void {
      store.close();
    },
  };
}
