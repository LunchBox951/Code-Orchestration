import type { DatabaseSync } from 'node:sqlite';
import { assertNever } from '../assert-never.js';
import type { Projector } from '../replay/projector.js';
import type { StoredEvent, StoreTx } from '../store/types.js';
import {
  EVENT_SESSION_CREATED,
  type SessionCreated,
  type SessionRecord,
  type ResumeHandle,
} from './events.js';

const CREATE_SESSIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS sessions (
    agent_id     TEXT PRIMARY KEY,
    pane         TEXT NOT NULL,
    cwd          TEXT NOT NULL,
    provider     TEXT NOT NULL,
    resume_kind  TEXT NOT NULL,
    resume_value TEXT NOT NULL,
    ts           INTEGER NOT NULL
  );
`;

/** Defensive create of the sessions read-model table — called on reset/apply AND every read path. */
export function ensureSessionTable(db: DatabaseSync): void {
  db.exec(CREATE_SESSIONS_TABLE);
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
type SessionEvent = SessionCreatedEvent;

/**
 * Folds `session.created` events into the `sessions` read-model. PK = `agent_id`; a new event
 * for the same agent REPLACES the row (current-session semantics). `INSERT OR REPLACE` ensures
 * replay-equality: rebuilding from the log reproduces byte-identical rows (AC-L7-7 sandbox).
 */
export class SessionProjector implements Projector {
  readonly name = 'session';

  handles(type: string): boolean {
    return type === EVENT_SESSION_CREATED;
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
        const resumeKind = resume.provider;
        const resumeValue = resume.provider === 'claude' ? resume.sessionId : resume.codexHome;
        db.prepare(
          `INSERT OR REPLACE INTO sessions
           (agent_id, pane, cwd, provider, resume_kind, resume_value, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(agentId, pane, cwd, provider, resumeKind, resumeValue, event.ts);
        return;
      }
      default:
        return assertNever(type);
    }
  }
}
