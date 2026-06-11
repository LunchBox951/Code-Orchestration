/**
 * Structural spawn rules derived from agent-roles.md §"The agent hierarchy":
 *   - A Coordinator never spawns a Coordinator; a Lead never spawns a Lead.
 *   - A Researcher is a leaf — spawnable but cannot itself spawn any agent.
 *   - A Reviewer is a leaf — cannot spawn any agent (including a Researcher).
 *   - An Implementer may only spawn a Researcher.
 *
 * L7 seam note: spawn-TIME enforcement (rejecting a bad spawn live at the Conductor layer) is
 * an L7 concern. This module is the static check only — usable in tests, validation, and the
 * Conductor's future guard once that path exists.
 */
import type { Role } from '../tools/scoping.js';

/** Allowed child roles per parent role (structural rules from agent-roles.md). */
export const SPAWN_RULES: Readonly<Record<Role, ReadonlySet<Role>>> = {
  coordinator: new Set<Role>(['lead', 'implementer', 'reviewer', 'researcher']),
  lead: new Set<Role>(['implementer', 'reviewer', 'researcher']),
  implementer: new Set<Role>(['researcher']),
  reviewer: new Set<Role>(),
  researcher: new Set<Role>(),
};

/** Return true iff `parent` is structurally allowed to spawn `child`. */
export function canSpawn(parent: Role, child: Role): boolean {
  return SPAWN_RULES[parent].has(child);
}

export interface SpawnViolation {
  readonly parent: Role;
  readonly child: Role;
  readonly reason: string;
}

/**
 * Check a single parent→child edge against the structural rules. Returns null on a legal edge;
 * returns a {@link SpawnViolation} with a named reason on a violation.
 */
export function checkSpawnPlan(parent: Role, child: Role): SpawnViolation | null {
  if (canSpawn(parent, child)) return null;

  let reason: string;
  if (parent === 'coordinator' && child === 'coordinator') {
    reason = 'a coordinator never spawns a coordinator';
  } else if (parent === 'lead' && child === 'lead') {
    reason = 'a lead never spawns a lead';
  } else if (parent === 'researcher') {
    reason = 'researcher is a leaf and cannot spawn any agent';
  } else if (parent === 'reviewer') {
    reason = 'reviewer is a leaf and cannot spawn any agent';
  } else if (parent === 'implementer') {
    reason = 'implementer can only spawn a researcher';
  } else {
    reason = `${parent} is not allowed to spawn ${child}`;
  }
  return { parent, child, reason };
}

/** Validate a sequence of parent→child edges; returns all violations (empty = fully legal). */
export function validateSpawnPlan(
  edges: readonly { parent: Role; child: Role }[],
): SpawnViolation[] {
  const violations: SpawnViolation[] = [];
  for (const { parent, child } of edges) {
    const v = checkSpawnPlan(parent, child);
    if (v) violations.push(v);
  }
  return violations;
}
