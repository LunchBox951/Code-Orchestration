import type { DatabaseSync } from 'node:sqlite';
import type { Projector } from '../replay/projector.js';
import type { StoredEvent, StoreTx } from '../store/types.js';
import {
  EVENT_AGENT_CONTROL_STOPPED,
  EVENT_AGENT_CONTROL_UNSTOPPED,
  agentIdForControlScope,
  type AgentControlPayload,
} from './events.js';

const CREATE_AGENT_CONTROL_TABLE = `
  CREATE TABLE IF NOT EXISTS agent_control (
    agent_id TEXT PRIMARY KEY,
    stopped  INTEGER NOT NULL
  )
`;

export function ensureAgentControlTable(db: DatabaseSync): void {
  db.exec(CREATE_AGENT_CONTROL_TABLE);
}

export function selectStoppedAgentIds(db: DatabaseSync): readonly string[] {
  ensureAgentControlTable(db);
  const rows = db
    .prepare('SELECT agent_id FROM agent_control WHERE stopped = 1 ORDER BY agent_id')
    .all();
  return rows.map((row) => String(row.agent_id));
}

export function selectAgentStopped(db: DatabaseSync, agentId: string): boolean {
  ensureAgentControlTable(db);
  const row = db.prepare('SELECT stopped FROM agent_control WHERE agent_id = ?').get(agentId) as
    | { stopped?: unknown }
    | undefined;
  return Number(row?.stopped ?? 0) === 1;
}

export class AgentControlProjector implements Projector {
  readonly name = 'agent_control';

  handles(type: string): boolean {
    return type === EVENT_AGENT_CONTROL_STOPPED || type === EVENT_AGENT_CONTROL_UNSTOPPED;
  }

  reset(tx: StoreTx): void {
    const db = tx.raw as DatabaseSync;
    ensureAgentControlTable(db);
    db.exec('DELETE FROM agent_control');
  }

  apply(tx: StoreTx, event: StoredEvent): void {
    const db = tx.raw as DatabaseSync;
    ensureAgentControlTable(db);
    const payload = event.payload as AgentControlPayload;
    const scopedAgentId = agentIdForControlScope(event.scope);
    if (payload.agentId !== scopedAgentId) {
      throw new Error(
        `agent-control: payload agent '${payload.agentId}' does not match scope '${scopedAgentId}'`,
      );
    }
    if (event.type === EVENT_AGENT_CONTROL_STOPPED) {
      db.prepare(
        `INSERT INTO agent_control (agent_id, stopped)
         VALUES (?, 1)
         ON CONFLICT(agent_id) DO UPDATE SET stopped = 1`,
      ).run(payload.agentId);
      return;
    }
    if (event.type === EVENT_AGENT_CONTROL_UNSTOPPED) {
      db.prepare(
        `INSERT INTO agent_control (agent_id, stopped)
         VALUES (?, 0)
         ON CONFLICT(agent_id) DO UPDATE SET stopped = 0`,
      ).run(payload.agentId);
      return;
    }
  }
}
