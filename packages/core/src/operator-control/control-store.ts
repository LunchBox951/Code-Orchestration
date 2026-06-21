import type { DatabaseSync } from 'node:sqlite';
import { decode } from '../replay/decode.js';
import { applyEvent, type Projector } from '../replay/projector.js';
import { openProjectStore } from '../store/sqlite-store.js';
import {
  makeAgentStoppedEvent,
  makeAgentUnstoppedEvent,
  operatorControlSchemas,
  operatorControlUpcasters,
} from './events.js';
import {
  AgentControlProjector,
  selectAgentStopped,
  selectStoppedAgentIds,
} from './control-projector.js';

/** Durable operator-control state for one project. */
export interface AgentControlStore {
  /** Persist that operator Stop suppresses this agent until an explicit unstop/re-wake. */
  recordStopped(agentId: string): void;
  /** Clear the durable stopped suppression for this agent. */
  clearStopped(agentId: string): void;
  /** Whether this agent is currently durably stopped. */
  isStopped(agentId: string): boolean;
  /** All durably stopped agents, sorted for deterministic hydration. */
  listStopped(): readonly string[];
  close(): void;
}

export function openAgentControlStore(projectId: string): AgentControlStore {
  const store = openProjectStore(projectId);
  const projectors: readonly Projector[] = [new AgentControlProjector()];

  return {
    recordStopped(agentId: string): void {
      store.transaction((tx) => {
        const [stored] = tx.append([makeAgentStoppedEvent(projectId, agentId)]);
        applyEvent(
          tx,
          decode(stored!, operatorControlUpcasters, operatorControlSchemas),
          projectors,
        );
      });
    },

    clearStopped(agentId: string): void {
      store.transaction((tx) => {
        const [stored] = tx.append([makeAgentUnstoppedEvent(projectId, agentId)]);
        applyEvent(
          tx,
          decode(stored!, operatorControlUpcasters, operatorControlSchemas),
          projectors,
        );
      });
    },

    isStopped(agentId: string): boolean {
      return store.transaction((tx) => selectAgentStopped(tx.raw as DatabaseSync, agentId));
    },

    listStopped(): readonly string[] {
      return store.transaction((tx) => selectStoppedAgentIds(tx.raw as DatabaseSync));
    },

    close(): void {
      store.close();
    },
  };
}
