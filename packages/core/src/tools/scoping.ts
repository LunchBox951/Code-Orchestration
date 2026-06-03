import { buildCoreRegistry } from './core-registry.js';
import type { ToolRegistry, ToolSpec } from './registry.js';

/**
 * The five BASE ROLES — the new orchestration vocabulary (agent-roles.md §"The roster"). A base
 * role is the expensive, safety-bearing unit: a distinct mandate + permission profile. Sub-roles
 * (e.g. `implementer:test`) specialize a base role's *approach* and are an L6/L7 concern — NOT this
 * layer (permissions.md: most specialization is a prompt nudge, not a toolset cut).
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
 * The UNIVERSAL coordination toolset every base role is offered: orientation, its own status, the
 * read mail verbs (inbox / get one / read a thread), sending mail, and acknowledging mail. Every
 * orchestrated agent reads its inbox, answers in-thread, reports status, and orients — so these are
 * never scoped away. The edges below differentiate the rest.
 */
const UNIVERSAL_TOOLSET: readonly string[] = [
  'co_orient',
  'co_status',
  'co_mail_inbox',
  'co_mail_get',
  'co_mail_thread',
  'co_mail_send',
  'co_mail_ack',
];

/**
 * SEED per-role toolsets over the CURRENT eleven `co_*` tools — the mechanism plus a defensible
 * starting membership, NOT the authoritative rosters. The concrete, authoritative per-role rosters
 * (and the later gated tools they will gain — `co_merge`, … — which are L5/L6) are not locked here;
 * this seed exists to prove the per-role scoping hook works today (AC-L2-5).
 * Memberships are kept defensible against each role's mandate in agent-roles.md:
 *
 *   - everyone gets {@link UNIVERSAL_TOOLSET};
 *   - `co_mail_retract` (withdraw a message you sent) goes to the roles that actively dispatch /
 *     coordinate — coordinator, lead, implementer — not to the leaf-ish reviewer / researcher;
 *   - `co_worktree_info` (read-only worktree facts) goes to the roles that work over a code
 *     worktree — lead (integrates reviewed branches), implementer (works in one), reviewer
 *     (inspects the target) — not to the coordinator (delegates) or the read-only researcher;
 *   - `co_sling` (create + record an isolated worktree sandbox) goes to the roles that DISPATCH
 *     work into fresh sandboxes — coordinator and lead — not to a leaf implementer / reviewer /
 *     researcher, which work inside a sandbox they were given;
 *   - `co_finish` (commit + record a finish + emit `worker_done`) goes to the IMPLEMENTER — the
 *     role that finishes through the gate — not to a lead (which integrates reviewed branches, it
 *     does not finish through the gate), nor to the leaf reviewer / researcher.
 *
 * Scoping is RELEVANCE, not a wall (permissions.md): an irrelevant tool simply isn't offered.
 */
export const roleToolsets: ReadonlyMap<Role, readonly string[]> = new Map<Role, readonly string[]>([
  ['coordinator', [...UNIVERSAL_TOOLSET, 'co_mail_retract', 'co_sling']],
  ['lead', [...UNIVERSAL_TOOLSET, 'co_mail_retract', 'co_worktree_info', 'co_sling']],
  ['implementer', [...UNIVERSAL_TOOLSET, 'co_mail_retract', 'co_worktree_info', 'co_finish']],
  ['reviewer', [...UNIVERSAL_TOOLSET, 'co_worktree_info']],
  ['researcher', [...UNIVERSAL_TOOLSET]],
]);

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
