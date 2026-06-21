import type { DatabaseSync } from 'node:sqlite';
import { assertNever } from '../assert-never.js';
import { OPERATOR } from '../mail/events.js';
import type { Projector } from '../replay/projector.js';
import type { StoredEvent, StoreTx } from '../store/types.js';
import type { Role } from '../tools/scoping.js';
import {
  EVENT_AGENT_REGISTERED,
  EVENT_AGENT_REMOVED,
  type AgentRecord,
  type AgentRegistered,
  type AgentRemoved,
} from './events.js';
import { checkSpawnPlan } from './spawn-rules.js';
import { findSubRole } from './sub-roles.js';

const CREATE_ROSTER_TABLE = `
  CREATE TABLE IF NOT EXISTS roster (
    agent_id      TEXT PRIMARY KEY,
    role          TEXT NOT NULL,
    sub_role      TEXT,
    name          TEXT,
    parent        TEXT NOT NULL,
    registered_ts INTEGER NOT NULL
  );
`;

/** Defensive create of the roster read-model table — called on reset/apply AND every read path. */
export function ensureRosterTables(db: DatabaseSync): void {
  db.exec(CREATE_ROSTER_TABLE);
  const rosterColumns = db.prepare('PRAGMA table_info(roster)').all() as Array<{ name: string }>;
  if (!rosterColumns.some((c) => c.name === 'name')) {
    db.exec('ALTER TABLE roster ADD COLUMN name TEXT');
  }
}

/** Map a raw `roster` row to an {@link AgentRecord}. */
export function rowToAgentRecord(row: Record<string, unknown>): AgentRecord {
  return {
    agentId: String(row.agent_id),
    role: String(row.role) as Role,
    ...(row.sub_role != null ? { subRole: String(row.sub_role) } : {}),
    ...(row.name != null ? { name: String(row.name) } : {}),
    parent: String(row.parent),
    registeredTs: Number(row.registered_ts),
  };
}

const ROSTER_COLUMNS = 'agent_id, role, sub_role, name, parent, registered_ts';

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

function sameRegistration(existing: AgentRecord, rec: AgentRegistered): boolean {
  return (
    existing.role === rec.role &&
    existing.parent === rec.parent &&
    (existing.subRole ?? undefined) === (rec.subRole ?? undefined)
  );
}

/**
 * Validate roster invariants against the already-folded read model. Returns the existing row when
 * the registration is an idempotent re-assertion; throws on invalid/corrupt registration attempts.
 */
export function validateAgentRegistration(
  db: DatabaseSync,
  rec: AgentRegistered,
): AgentRecord | undefined {
  if (rec.agentId === OPERATOR) {
    throw new Error(`roster: reserved agent id '${OPERATOR}' cannot be registered as an agent`);
  }

  const existing = selectAgent(db, rec.agentId);
  if (existing != null) {
    if (sameRegistration(existing, rec)) return existing;
    throw new Error(
      `roster: agent '${rec.agentId}' is already registered as role '${existing.role}' with ` +
        `parent '${existing.parent}' — refusing conflicting re-registration as role '${rec.role}' ` +
        `with parent '${rec.parent}'`,
    );
  }

  if (rec.subRole != null && findSubRole(rec.role, rec.subRole) == null) {
    throw new Error(
      `roster: unknown sub-role '${rec.subRole}' for base role '${rec.role}' on agent ` +
        `'${rec.agentId}'`,
    );
  }

  if (rec.parent === rec.agentId) {
    throw new Error(`roster: agent '${rec.agentId}' cannot be its own parent`);
  }

  if (rec.role === 'coordinator') {
    if (rec.parent !== OPERATOR) {
      throw new Error(
        `roster: coordinator '${rec.agentId}' must have parent '${OPERATOR}', got ` +
          `'${rec.parent}'`,
      );
    }
    return undefined;
  }

  const parent = selectAgent(db, rec.parent);
  if (parent == null) {
    throw new Error(`roster: parent '${rec.parent}' is not registered for agent '${rec.agentId}'`);
  }

  const violation = checkSpawnPlan(parent.role, rec.role);
  if (violation != null) {
    throw new Error(
      `roster: parent '${rec.parent}' (${parent.role}) cannot spawn '${rec.agentId}' ` +
        `(${rec.role}): ${violation.reason}`,
    );
  }

  return undefined;
}

/** Validate that `rec.agentId` is a registered leaf that may be removed without orphaning children. */
export function validateAgentRemoval(db: DatabaseSync, rec: AgentRemoved): AgentRecord {
  const existing = selectAgent(db, rec.agentId);
  if (existing == null) {
    throw new Error(`roster: agent '${rec.agentId}' is not registered — cannot remove it`);
  }
  const child = db
    .prepare(
      'SELECT agent_id FROM roster WHERE parent = ? ORDER BY registered_ts, agent_id LIMIT 1',
    )
    .get(rec.agentId) as { agent_id?: unknown } | undefined;
  if (child != null) {
    throw new Error(
      `roster: agent '${rec.agentId}' still has child agent '${String(child.agent_id)}' — ` +
        'remove children before removing their parent',
    );
  }
  return existing;
}

interface AgentRegisteredEvent extends StoredEvent {
  readonly type: typeof EVENT_AGENT_REGISTERED;
  readonly payload: AgentRegistered;
}
interface AgentRemovedEvent extends StoredEvent {
  readonly type: typeof EVENT_AGENT_REMOVED;
  readonly payload: AgentRemoved;
}
type RosterEvent = AgentRegisteredEvent | AgentRemovedEvent;

/**
 * Folds `agent.registered` events into the `roster` read-model. Agent identity is immutable:
 * replaying an identical registration is a no-op, but a conflicting re-registration fails loud.
 * `event.ts` is used for `registered_ts` (never wall-clock — freeze #6).
 */
export class RosterProjector implements Projector {
  readonly name = 'roster';

  handles(type: string): boolean {
    return type === EVENT_AGENT_REGISTERED || type === EVENT_AGENT_REMOVED;
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
        const { agentId, role, subRole, name, parent } = rosterEvent.payload;
        const existing = validateAgentRegistration(db, rosterEvent.payload);
        if (existing != null) return;
        db.prepare(
          `INSERT INTO roster (agent_id, role, sub_role, name, parent, registered_ts)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(agentId, role, subRole ?? null, name ?? null, parent, event.ts);
        return;
      }
      case EVENT_AGENT_REMOVED: {
        validateAgentRemoval(db, rosterEvent.payload);
        db.prepare('DELETE FROM roster WHERE agent_id = ?').run(rosterEvent.payload.agentId);
        return;
      }
      default:
        return assertNever(type);
    }
  }
}
