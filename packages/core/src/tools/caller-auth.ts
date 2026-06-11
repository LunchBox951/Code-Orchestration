import type { RosterStore } from '../roles/roster-store.js';
import type { Role } from './scoping.js';

export function assertToolCallerRole(
  tool: string,
  roster: Pick<RosterStore, 'getAgent'>,
  agent: string,
  allowed: readonly Role[],
): void {
  const caller = roster.getAgent(agent);
  if (caller == null) {
    throw new Error(
      `${tool}: caller '${agent}' is not registered in the roster — refusing owner-tier tool use.`,
    );
  }
  if (!allowed.includes(caller.role)) {
    throw new Error(
      `${tool}: caller '${agent}' has role '${caller.role}', but this tool requires ` +
        `${allowed.join(' or ')}.`,
    );
  }
}
