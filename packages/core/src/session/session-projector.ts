import type { DatabaseSync } from 'node:sqlite';
import { assertNever } from '../assert-never.js';
import type { Projector } from '../replay/projector.js';
import type { StoredEvent, StoreTx } from '../store/types.js';
import {
  EVENT_SESSION_CREATED,
  EVENT_SESSION_ENDED,
  type SessionCreated,
  type SessionEnded,
  type SessionRecord,
  type ResumeHandle,
} from './events.js';

const CREATE_SESSIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS sessions (
    agent_id     TEXT PRIMARY KEY,
    pane         TEXT NOT NULL UNIQUE,
    cwd          TEXT NOT NULL,
    provider     TEXT NOT NULL,
    resume_kind  TEXT NOT NULL,
    resume_value TEXT NOT NULL,
    ts           INTEGER NOT NULL
  );
`;
const CREATE_SESSIONS_PANE_UNIQUE_INDEX = `
  CREATE UNIQUE INDEX IF NOT EXISTS sessions_pane_unique ON sessions(pane);
`;

/** Defensive create of the sessions read-model table — called on reset/apply AND every read path. */
export function ensureSessionTable(db: DatabaseSync): void {
  db.exec(CREATE_SESSIONS_TABLE);
  db.exec(CREATE_SESSIONS_PANE_UNIQUE_INDEX);
}

function resumeFromRow(row: Record<string, unknown>): ResumeHandle {
  const kind = String(row['resume_kind']);
  const value = String(row['resume_value']);
  if (kind === 'claude') return { provider: 'claude', sessionId: value };
  if (kind === 'codex') return { provider: 'codex', codexHome: value };
  throw new Error(`session-projector: unknown resume_kind '${kind}'`);
}

/** Map a raw `sessions` row to a {@link SessionRecord}. */
export function rowToSessionRecord(row: Record<string, unknown>): SessionRecord {
  return {
    agentId: String(row['agent_id']),
    pane: String(row['pane']),
    cwd: String(row['cwd']),
    provider: String(row['provider']) as 'claude' | 'codex',
    resume: resumeFromRow(row),
    createdTs: Number(row['ts']),
  };
}

const SESSION_COLUMNS = 'agent_id, pane, cwd, provider, resume_kind, resume_value, ts';

/** The session record for `agentId`, or undefined. */
export function selectSession(db: DatabaseSync, agentId: string): SessionRecord | undefined {
  ensureSessionTable(db);
  const row = db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE agent_id = ?`).get(agentId);
  return row ? rowToSessionRecord(row as Record<string, unknown>) : undefined;
}

/** The current session for `pane`, or undefined. */
export function selectSessionByPane(db: DatabaseSync, pane: string): SessionRecord | undefined {
  ensureSessionTable(db);
  const row = db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE pane = ?`).get(pane);
  return row ? rowToSessionRecord(row as Record<string, unknown>) : undefined;
}

/** All session records, ordered by ts then agent_id for stable iteration. */
export function selectAllSessions(db: DatabaseSync): SessionRecord[] {
  ensureSessionTable(db);
  const rows = db.prepare(`SELECT ${SESSION_COLUMNS} FROM sessions ORDER BY ts, agent_id`).all();
  return rows.map((r) => rowToSessionRecord(r as Record<string, unknown>));
}

interface SessionCreatedEvent extends StoredEvent {
  readonly type: typeof EVENT_SESSION_CREATED;
  readonly payload: SessionCreated;
}
interface SessionEndedEvent extends StoredEvent {
  readonly type: typeof EVENT_SESSION_ENDED;
  readonly payload: SessionEnded;
}
type SessionEvent = SessionCreatedEvent | SessionEndedEvent;

/**
 * Folds `session.created` events into the `sessions` read-model. PK = `agent_id`; a second active
 * session for the same agent fails loud until a later explicit `session.ended` event exists. This is
 * the duplicate-host guard from the L7 must-not-regress list.
 */
export class SessionProjector implements Projector {
  readonly name = 'session';

  handles(type: string): boolean {
    return type === EVENT_SESSION_CREATED || type === EVENT_SESSION_ENDED;
  }

  reset(tx: StoreTx): void {
    const db = tx.raw as DatabaseSync;
    ensureSessionTable(db);
    db.exec('DELETE FROM sessions');
  }

  apply(tx: StoreTx, event: StoredEvent): void {
    const db = tx.raw as DatabaseSync;
    ensureSessionTable(db);
    const e = event as SessionEvent;
    const type = e.type;
    switch (type) {
      case EVENT_SESSION_CREATED: {
        const { agentId, pane, cwd, provider, resume } = e.payload;
        const existing = selectSession(db, agentId);
        if (existing != null) {
          throw new Error(
            `session-projector: agent '${agentId}' already has an active session ` +
              `'${existing.pane}' — refusing duplicate host '${pane}'.`,
          );
        }
        const existingPane = selectSessionByPane(db, pane);
        if (existingPane != null) {
          throw new Error(
            `session-projector: pane '${pane}' is already hosted by agent ` +
              `'${existingPane.agentId}' — refusing duplicate pane claim by '${agentId}'.`,
          );
        }
        const resumeKind = resume.provider;
        const resumeValue = resume.provider === 'claude' ? resume.sessionId : resume.codexHome;
        db.prepare(
          `INSERT INTO sessions
           (agent_id, pane, cwd, provider, resume_kind, resume_value, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(agentId, pane, cwd, provider, resumeKind, resumeValue, event.ts);
        return;
      }
      case EVENT_SESSION_ENDED: {
        const { agentId, pane } = e.payload;
        const existing = selectSession(db, agentId);
        if (existing == null) {
          throw new Error(`session-projector: agent '${agentId}' has no active session to end.`);
        }
        if (existing.pane !== pane) {
          throw new Error(
            `session-projector: pane '${pane}' does not match active session ` +
              `'${existing.pane}' for agent '${agentId}'.`,
          );
        }
        db.prepare('DELETE FROM sessions WHERE agent_id = ?').run(agentId);
        return;
      }
      default:
        return assertNever(type);
    }
  }
}
