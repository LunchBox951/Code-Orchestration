/**
 * The L6a durable agent→role→parent projection store. Opens the PROJECT store, wires the
 * {@link RosterProjector}, and exposes a typed {@link RosterStore} facade.
 *
 * L7 seam note: the production WRITE of `agent.registered` at spawn time is the Conductor's job
 * (L7). This layer builds the record + projection + store only — no spawn path is wired here.
 * Tests populate via `recordAgent` directly.
 */
import type { DatabaseSync } from 'node:sqlite';
import { decode } from '../replay/decode.js';
import { applyEvent, type Projector } from '../replay/projector.js';
import { openProjectStore } from '../store/sqlite-store.js';
import {
  makeAgentRemovedEvent,
  makeAgentRegisteredEvent,
  rolesSchemas,
  rolesUpcasters,
  type AgentRecord,
  type AgentRemoved,
  type AgentRegistered,
} from './events.js';
import {
  RosterProjector,
  ensureRosterTables,
  selectAgent,
  selectAllAgents,
  validateAgentRemoval,
  validateAgentRegistration,
} from './roster-projector.js';

export interface RosterStore {
  /** Record an agent registration (append `agent.registered` + fold); returns the read-back record. */
  recordAgent(rec: AgentRegistered): AgentRecord;
  /** Remove a registered leaf agent (append `agent.removed` + fold); used by launch rollback. */
  removeAgent(agentId: string): AgentRecord;
  /** The agent record for `agentId`, or undefined. */
  getAgent(agentId: string): AgentRecord | undefined;
  /** Every recorded agent, in registration order. */
  listAgents(): readonly AgentRecord[];
  /** Close the underlying project store. */
  close(): void;
}

/**
 * Open the project roster store: open the PROJECT store, wire the {@link RosterProjector}, and
 * return the {@link RosterStore} facade. Safe alongside other stores on the same per-project
 * `store.db` — `node:sqlite` is synchronous/single-threaded; the roster owns distinct scopes
 * (`agent:`) and a distinct read-model table (`roster`).
 */
export function openRosterStore(projectId: string): RosterStore {
  const store = openProjectStore(projectId);
  const projectors: readonly Projector[] = [new RosterProjector()];

  return {
    recordAgent(rec: AgentRegistered): AgentRecord {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureRosterTables(db);
        const existing = validateAgentRegistration(db, rec);
        if (existing != null) return existing;
        const [stored] = tx.append([makeAgentRegisteredEvent(projectId, rec)]);
        applyEvent(tx, decode(stored!, rolesUpcasters, rolesSchemas), projectors);
        const row = selectAgent(db, rec.agentId);
        if (!row) {
          throw new Error(
            `openRosterStore.recordAgent: row missing after projection (agentId='${rec.agentId}')`,
          );
        }
        return row;
      });
    },

    removeAgent(agentId: string): AgentRecord {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureRosterTables(db);
        const payload: AgentRemoved = { agentId };
        const existing = validateAgentRemoval(db, payload);
        const [stored] = tx.append([makeAgentRemovedEvent(projectId, payload)]);
        applyEvent(tx, decode(stored!, rolesUpcasters, rolesSchemas), projectors);
        const row = selectAgent(db, agentId);
        if (row != null) {
          throw new Error(
            `openRosterStore.removeAgent: row remained after projection (agentId='${agentId}')`,
          );
        }
        return existing;
      });
    },

    getAgent(agentId: string): AgentRecord | undefined {
      return store.transaction((tx) => selectAgent(tx.raw as DatabaseSync, agentId));
    },

    listAgents(): readonly AgentRecord[] {
      return store.transaction((tx) => selectAllAgents(tx.raw as DatabaseSync));
    },

    close(): void {
      store.close();
    },
  };
}
