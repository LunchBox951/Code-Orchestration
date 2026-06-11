import { ROLE_PROFILES } from '../roles/profile.js';
import { buildCoreRegistry } from './core-registry.js';
import type { ToolRegistry, ToolSpec } from './registry.js';

/**
 * The five BASE ROLES — the new orchestration vocabulary (agent-roles.md §"The roster"). A base
 * role is the expensive, safety-bearing unit: a distinct mandate + permission profile. Sub-roles
 * (e.g. `implementer:test`) specialize a base role's *approach* and are an L6/L7 concern — NOT this
 * layer (permissions.md: most specialization is a prompt nudge, not a toolset cut).
 *
 * `Role` and `BASE_ROLES` are the single Role-vocabulary owner; `ROLE_PROFILES` in roles/profile.ts
 * is the single permission-data owner. `roleToolsets` below is DERIVED from the authoritative
 * profiles so the two sources never drift.
 */
export type Role = 'coordinator' | 'lead' | 'implementer' | 'reviewer' | 'researcher';

/** Every base role, for iteration (tests, mounts). Order is documentation, not significance. */
export const BASE_ROLES: readonly Role[] = [
  'coordinator',
  'lead',
  'implementer',
  'reviewer',
  'researcher',
] as const;

/**
 * Per-role toolsets, DERIVED from the authoritative {@link ROLE_PROFILES} in roles/profile.ts.
 * The toolset for each role is exactly `ROLE_PROFILES[role].toolset` — the profiles are the source
 * of truth; this map is a convenience alias so all existing callers (MCP mount, tests, orient) keep
 * working without change. Membership rationale is documented in roles/profile.ts.
 *
 * Scoping is RELEVANCE, not a wall (permissions.md): an irrelevant tool simply isn't offered.
 */
export const roleToolsets: ReadonlyMap<Role, readonly string[]> = new Map<Role, readonly string[]>(
  BASE_ROLES.map((r) => [r, ROLE_PROFILES[r].toolset]),
);

/**
 * The tools offered to `role`, filtered from `registry` (default {@link buildCoreRegistry}) IN
 * REGISTRY ORDER — the offered surface is a relevance-scoped subset of the canonical registry, never
 * a reordering or a superset. This is the per-role scoping hook the MCP mount passes into
 * `createCoMcpServer({ tools })`.
 *
 * Fails loud (Principle 9) on two declaration bugs — the scoping analogue of the C completeness gate:
 *   - a role with no declared toolset (every base role must have a seed roster), and
 *   - a PHANTOM tool: a roster naming a tool absent from the registry. A phantom is exactly the kind
 *     of silent drift the gate exists to kill, so it throws rather than silently offering fewer tools.
 */
export function toolsForRole(role: Role, registry: ToolRegistry = buildCoreRegistry()): ToolSpec[] {
  const offered = roleToolsets.get(role);
  if (offered == null) {
    throw new Error(
      `toolsForRole: no toolset declared for role '${role}' — every base role needs a seed roster ` +
        '(fail loud, Principle 9).',
    );
  }
  for (const name of offered) {
    if (!registry.has(name)) {
      throw new Error(
        `toolsForRole: role '${role}' names tool '${name}', which is absent from the registry ` +
          '(phantom tool — fail loud, Principle 9).',
      );
    }
  }
  const wanted = new Set(offered);
  return registry.list().filter((spec) => wanted.has(spec.name));
}
