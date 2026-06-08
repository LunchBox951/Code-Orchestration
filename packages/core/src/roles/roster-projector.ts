import type { DatabaseSync } from 'node:sqlite';
import { assertNever } from '../assert-never.js';
import type { Projector } from '../replay/projector.js';
import type { StoredEvent, StoreTx } from '../store/types.js';
import type { Role } from '../tools/scoping.js';
import { EVENT_AGENT_REGISTERED, type AgentRecord, type AgentRegistered } from './events.js';

const CREATE_ROSTER_TABLE = `
  CREATE TABLE IF NOT EXISTS roster (
    agent_id      TEXT PRIMARY KEY,
    role          TEXT NOT NULL,
    sub_role      TEXT,
    parent        TEXT NOT NULL,
    registered_ts INTEGER NOT NULL
  );
`;

/** Defensive create of the roster read-model table — called on reset/apply AND every read path. */
export function ensureRosterTables(db: DatabaseSync): void {
  db.exec(CREATE_ROSTER_TABLE);
}

/** Map a raw `roster` row to an {@link AgentRecord}. */
export function rowToAgentRecord(row: Record<string, unknown>): AgentRecord {
  return {
    agentId: String(row.agent_id),
    role: String(row.role) as Role,
    ...(row.sub_role != null ? { subRole: String(row.sub_role) } : {}),
    parent: String(row.parent),
    registeredTs: Number(row.registered_ts),
  };
}

const ROSTER_COLUMNS = 'agent_id, role, sub_role, parent, registered_ts';

/** The agent record for `agentId`, or undefined. */
export function selectAgent(db: DatabaseSync, agentId: string): AgentRecord | undefined {
  ensureRosterTables(db);
  const row = db.prepare(`SELECT ${ROSTER_COLUMNS} FROM roster WHERE agent_id = ?`).get(agentId);
  return row ? rowToAgentRecord(row as Record<string, unknown>) : undefined;
}

/** All agent records, in stable order: by `registered_ts` then `agent_id` for tie-breaks. */
export function selectAllAgents(db: DatabaseSync): AgentRecord[] {
  ensureRosterTables(db);
  const rows = db
    .prepare(`SELECT ${ROSTER_COLUMNS} FROM roster ORDER BY registered_ts, agent_id`)
    .all();
  return rows.map((r) => rowToAgentRecord(r as Record<string, unknown>));
}

interface AgentRegisteredEvent extends StoredEvent {
  readonly type: typeof EVENT_AGENT_REGISTERED;
  readonly payload: AgentRegistered;
}
type RosterEvent = AgentRegisteredEvent;

/**
 * Folds `agent.registered` events into the `roster` read-model. An UPSERT (ON CONFLICT DO UPDATE)
 * means a re-registration re-asserts the same row — idempotent + replay-safe so `rebuildAll`
 * reaches a byte-identical final row (AC-L6a-1). `event.ts` is used for `registered_ts` (never
 * wall-clock — freeze #6).
 */
export class RosterProjector implements Projector {
  readonly name = 'roster';

  handles(type: string): boolean {
    return type === EVENT_AGENT_REGISTERED;
  }

  reset(tx: StoreTx): void {
    const db = tx.raw as DatabaseSync;
    ensureRosterTables(db);
    db.exec('DELETE FROM roster');
  }

  apply(tx: StoreTx, event: StoredEvent): void {
    const db = tx.raw as DatabaseSync;
    ensureRosterTables(db);
    const rosterEvent = event as RosterEvent;
    const type = rosterEvent.type;
    switch (type) {
      case EVENT_AGENT_REGISTERED: {
        const { agentId, role, subRole, parent } = rosterEvent.payload;
        db.prepare(
          `INSERT INTO roster (agent_id, role, sub_role, parent, registered_ts)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(agent_id) DO UPDATE SET
             role          = excluded.role,
             sub_role      = excluded.sub_role,
             parent        = excluded.parent,
             registered_ts = excluded.registered_ts`,
        ).run(agentId, role, subRole ?? null, parent, event.ts);
        return;
      }
      default:
        return assertNever(type);
    }
  }
}
