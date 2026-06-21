/**
 * L6a event definitions for the durable agent→role→parent record. Lives in the PROJECT store
 * (one per registered project), exactly like the L3 worktree events. Pure ORCHESTRATION state
 * stored in program-data only (Principle 12 — pristine-repo).
 *
 * One stream per agent, keyed by the L0 `agent:<agentId>` scope pattern. `agent.registered` records
 * which role an agent was dispatched under and who spawned it. `agent.removed` is reserved for
 * launch rollback of a leaf agent whose session/worktree never became durable. The Conductor emits
 * these at the L7 seam; this layer defines the events + projection + store.
 */
import { z } from 'zod';
import type { NewEvent } from '../store/types.js';
import type { SchemaMap } from '../replay/decode.js';
import type { UpcasterRegistry } from '../replay/upcaster.js';
import { BASE_ROLES } from '../tools/scoping.js';
import type { Role } from '../tools/scoping.js';

/** Current payload schema version — v1; no upcasters yet. */
export const ROLES_EVENT_V = 1;

/** An agent was registered (spawned) with a role under a parent. */
export const EVENT_AGENT_REGISTERED = 'agent.registered' as const;
/** A leaf agent registration was rolled back after a failed launch/durable-write sequence. */
export const EVENT_AGENT_REMOVED = 'agent.removed' as const;

/** Scope prefix for the per-agent registration stream; suffix is the agent id. */
export const AGENT_SCOPE_PREFIX = 'agent:';

/** The per-agent stream scope: `agent:<agentId>`. */
export function agentScope(agentId: string): string {
  return AGENT_SCOPE_PREFIX + agentId;
}

/** zod enum matching the five base roles — validated at event construction AND decode. */
const roleEnumSchema = z.enum(BASE_ROLES as unknown as [Role, ...Role[]]);

/** The `agent.registered` payload: the agent id, its base role, an optional sub-role, and its parent. */
export const agentRegisteredSchema = z.object({
  agentId: z.string().min(1),
  role: roleEnumSchema,
  subRole: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  parent: z.string().min(1),
});
export type AgentRegistered = z.infer<typeof agentRegisteredSchema>;

/** The `agent.removed` payload: the leaf agent id to remove from the roster read model. */
export const agentRemovedSchema = z.object({
  agentId: z.string().min(1),
});
export type AgentRemoved = z.infer<typeof agentRemovedSchema>;

/** Current-version schema map for roles events — validated on append AND on read (decode). */
export const rolesSchemas: SchemaMap = new Map<string, z.ZodType>([
  [EVENT_AGENT_REGISTERED, agentRegisteredSchema],
  [EVENT_AGENT_REMOVED, agentRemovedSchema],
]);

/** No payload migrations at v1 (an empty chain is the identity upcast). */
export const rolesUpcasters: UpcasterRegistry = new Map();

/**
 * Build + validate an `agent.registered` NewEvent. The agent id keys the stream scope; the
 * parent is recorded as the event `actor` (the spawner), mirroring `makeWorktreeCreatedEvent`.
 */
export function makeAgentRegisteredEvent(projectId: string, rec: AgentRegistered): NewEvent {
  const payload = agentRegisteredSchema.parse(rec);
  return {
    projectId,
    scope: agentScope(payload.agentId),
    type: EVENT_AGENT_REGISTERED,
    v: ROLES_EVENT_V,
    payload,
    actor: payload.parent,
  };
}

/** Build + validate an `agent.removed` NewEvent. */
export function makeAgentRemovedEvent(
  projectId: string,
  rec: AgentRemoved,
  actor = rec.agentId,
): NewEvent {
  const payload = agentRemovedSchema.parse(rec);
  return {
    projectId,
    scope: agentScope(payload.agentId),
    type: EVENT_AGENT_REMOVED,
    v: ROLES_EVENT_V,
    payload,
    actor,
  };
}

/**
 * A persisted, read-back agent record — the read-model shape the roster store facade returns.
 * `registeredTs` is the PERSISTED event ts (freeze #6 — never wall-clock on read).
 */
export interface AgentRecord {
  readonly agentId: string;
  readonly role: Role;
  readonly subRole?: string;
  readonly name?: string;
  readonly parent: string;
  readonly registeredTs: number;
}
