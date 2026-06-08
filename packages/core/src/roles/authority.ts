/**
 * Role-based escalation authority (L6a Phase C, AC-L6a-4). Pure; no I/O.
 *
 * The authority cut determines which role can RESOLVE a given escalation topic (i.e., has the
 * mandate and authority to give an answer) versus which must FORWARD it up the chain. The
 * `lowestCompetentResolver` walks the spawn hierarchy to find the lowest agent that can resolve a
 * topic — so only genuine intent questions reach @operator.
 *
 * Disposition table (agent-roles.md §91-111):
 *   implementer  → always forward (asks, never resolves intent)
 *   lead         → resolves: how-to, integration, approach, worker-rescope
 *                → forwards: phase-scope, spec-interpretation, known-issue-ack, spec-intent
 *   coordinator  → forwards ONLY spec-intent; resolves everything else
 *   reviewer/researcher → always forward (leaf agents)
 *   @operator    → terminal (always resolves by convention; no escalation parent)
 */
import { assertNever } from '../assert-never.js';
import { OPERATOR } from '../mail/events.js';
import type { ParentResolver } from '../mail/escalation.js';
import type { Role } from '../tools/scoping.js';

/**
 * The set of escalation topics an agent can raise. Each topic maps to the LOWEST role that has the
 * mandate + authority to resolve it (the authority cut).
 */
export type EscalationTopic =
  | 'how-to'
  | 'integration'
  | 'approach'
  | 'worker-rescope'
  | 'phase-scope'
  | 'spec-interpretation'
  | 'known-issue-ack'
  | 'spec-intent';

/**
 * Pure: whether `role` can RESOLVE `topic` (`'resolve'`) or must FORWARD it upward (`'forward'`).
 * Uses `assertNever` for exhaustive role coverage — a new role that lacks a branch turns CI red.
 */
export function escalationDisposition(role: Role, topic: EscalationTopic): 'resolve' | 'forward' {
  switch (role) {
    case 'implementer':
      return 'forward';

    case 'lead':
      switch (topic) {
        case 'how-to':
        case 'integration':
        case 'approach':
        case 'worker-rescope':
          return 'resolve';
        default:
          return 'forward';
      }

    case 'coordinator':
      // A coordinator resolves everything EXCEPT spec-intent (true authorial intent — only @operator).
      return topic === 'spec-intent' ? 'forward' : 'resolve';

    case 'reviewer':
    case 'researcher':
      return 'forward';

    default:
      return assertNever(role);
  }
}

/**
 * Walk UP from `startAgent` and return the id of the LOWEST agent that can RESOLVE `topic`.
 * Stops at `@operator` (no role / terminal — operator always resolves). Fails loud on a cycle or
 * on an id that `roleOf` cannot resolve (unknown agent — Principle 9).
 */
export function lowestCompetentResolver(
  deps: {
    resolver: ParentResolver;
    roleOf: (id: string) => Role | undefined;
  },
  startAgent: string,
  topic: EscalationTopic,
): string {
  let holder = startAgent;
  const seen = new Set<string>();

  while (holder !== OPERATOR) {
    if (seen.has(holder)) {
      throw new Error(
        `lowestCompetentResolver: cycle detected at '${holder}' — escalation chain is not a DAG`,
      );
    }
    seen.add(holder);

    const role = deps.roleOf(holder);
    if (role == null) {
      throw new Error(
        `lowestCompetentResolver: unknown agent '${holder}' — not in roster (Principle 9)`,
      );
    }
    if (escalationDisposition(role, topic) === 'resolve') {
      return holder;
    }
    holder = deps.resolver.parentOf(holder);
  }

  return OPERATOR;
}
