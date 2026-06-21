import { z } from 'zod';
import type { NewEvent } from '../store/types.js';
import type { SchemaMap } from '../replay/decode.js';
import type { UpcasterRegistry } from '../replay/upcaster.js';

/**
 * Operator-control events live in the PROJECT store. They persist operator-owned daemon selection
 * suppressions that must survive a daemon restart, without adding any agent-callable surface.
 */
export const OPERATOR_CONTROL_EVENT_V = 1;

export const EVENT_AGENT_CONTROL_STOPPED = 'agent_control.stopped' as const;
export const EVENT_AGENT_CONTROL_UNSTOPPED = 'agent_control.unstopped' as const;

export const AGENT_CONTROL_SCOPE_PREFIX = 'agent-control:';

export const agentControlSchema = z.object({
  agentId: z.string().min(1),
});
export type AgentControlPayload = z.infer<typeof agentControlSchema>;

export const operatorControlSchemas: SchemaMap = new Map<string, z.ZodType>([
  [EVENT_AGENT_CONTROL_STOPPED, agentControlSchema],
  [EVENT_AGENT_CONTROL_UNSTOPPED, agentControlSchema],
]);

export const operatorControlUpcasters: UpcasterRegistry = new Map();

export function agentControlScope(agentId: string): string {
  return AGENT_CONTROL_SCOPE_PREFIX + agentId;
}

export function agentIdForControlScope(scope: string): string {
  if (!scope.startsWith(AGENT_CONTROL_SCOPE_PREFIX)) {
    throw new Error(
      `agent-control: unexpected scope '${scope}' (want '${AGENT_CONTROL_SCOPE_PREFIX}...')`,
    );
  }
  return scope.slice(AGENT_CONTROL_SCOPE_PREFIX.length);
}

function makeAgentControlEvent(projectId: string, type: string, agentId: string): NewEvent {
  const payload = agentControlSchema.parse({ agentId });
  return {
    projectId,
    scope: agentControlScope(payload.agentId),
    type,
    v: OPERATOR_CONTROL_EVENT_V,
    payload,
    actor: '@operator',
  };
}

export function makeAgentStoppedEvent(projectId: string, agentId: string): NewEvent {
  return makeAgentControlEvent(projectId, EVENT_AGENT_CONTROL_STOPPED, agentId);
}

export function makeAgentUnstoppedEvent(projectId: string, agentId: string): NewEvent {
  return makeAgentControlEvent(projectId, EVENT_AGENT_CONTROL_UNSTOPPED, agentId);
}
