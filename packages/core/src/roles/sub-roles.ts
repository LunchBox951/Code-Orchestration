/**
 * Fixed shipped sub-role set (L6a Phase B). A sub-role specializes a base role's *approach* and
 * may narrow its permission profile, but never widen it (agent-roles.md: "inherits its base role's
 * permission profile and may narrow it, never widen it"). Most specialization is prompt-shaped
 * (soft); only researcher sub-roles carry a permission delta (web-search gating).
 *
 * NOTE (enforcement scope): the web-search capability delta is integrity-checked by narrow-only.ts
 * and is enforced at pane launch for provider-native web tools, GH_TOKEN placement, and Codex sandbox
 * egress (`[sandbox_workspace_write] network_access`); Claude shell network is not yet a hard sandbox
 * boundary (#127).
 *
 * Coordinator and Lead have no sub-roles — they are owner-tier roles.
 */
import type { Role } from '../tools/scoping.js';
import type { Capability, RoleProfile } from './profile.js';
import { ROLE_PROFILES } from './profile.js';

export interface SubRoleSpec {
  /** The base role this sub-role belongs to. */
  readonly baseRole: Role;
  /** The sub-role token (e.g. `'test'`). Full identity: `${baseRole}:${name}`. */
  readonly name: string;
  /** Non-empty one-line description of the prompt-shaped focus. */
  readonly approach: string;
  /** The (possibly narrowed) permission profile for this sub-role. */
  readonly profile: RoleProfile;
}

const implementerProfile = ROLE_PROFILES['implementer'];
const reviewerProfile = ROLE_PROFILES['reviewer'];
const researcherProfile = ROLE_PROFILES['researcher'];

/** Researcher profile with web-search narrowed away (capabilities = empty set). */
const researcherNoWebProfile: RoleProfile = {
  ...researcherProfile,
  capabilities: new Set<Capability>(),
};

/**
 * The authoritative shipped sub-role set (agent-roles.md §"Sub-roles").
 *
 * - **Implementer** sub-roles (`code`, `test`, `docs`, `polish`) are soft/approach specializations —
 *   same profile as the base implementer.
 * - **Reviewer** sub-roles (`feature`, `bugfix`, `pr`) are soft/posture specializations — same
 *   profile as the base reviewer (writeScope `read-only-for-code`).
 * - **Researcher** sub-roles carry a declared permission delta: only `external` retains the base
 *   researcher's `web-search` capability; `codebase`, `diagnostic`, and `decision` narrow it away.
 */
export const SUB_ROLES: readonly SubRoleSpec[] = [
  // ── Implementer sub-roles (soft/approach, writeScope: code) ──────────────────
  {
    baseRole: 'implementer',
    name: 'code',
    approach:
      'implementation-first: write the change, then write tests that lock the decisions in against regression — tests follow code',
    profile: implementerProfile,
  },
  {
    baseRole: 'implementer',
    name: 'test',
    approach:
      'test-first: write the test that captures the contract or reproduces the bug, watch it fail, then fix until it passes — code follows tests',
    profile: implementerProfile,
  },
  {
    baseRole: 'implementer',
    name: 'docs',
    approach:
      'docs-only scope: touch only documentation files; do not modify production code or tests',
    profile: implementerProfile,
  },
  {
    baseRole: 'implementer',
    name: 'polish',
    approach:
      'behavior-preserving cleanup: refactor for clarity, remove dead code, improve naming — test counts must match before and after',
    profile: implementerProfile,
  },

  // ── Reviewer sub-roles (soft/posture, writeScope: read-only-for-code) ─────────
  {
    baseRole: 'reviewer',
    name: 'feature',
    approach:
      'feature review: assess architecture fit, completeness, and consistency with existing conventions',
    profile: reviewerProfile,
  },
  {
    baseRole: 'reviewer',
    name: 'bugfix',
    approach:
      'bugfix review: verify the bug is fixed, check for regressions against the baseline, and assess scope creep',
    profile: reviewerProfile,
  },
  {
    baseRole: 'reviewer',
    name: 'pr',
    approach:
      'PR review: external or random change with no in-house baseline to lean on — apply full scrutiny without assumed context',
    profile: reviewerProfile,
  },

  // ── Researcher sub-roles (declared web-search delta; see header note on enforcement scope) ──
  {
    baseRole: 'researcher',
    name: 'codebase',
    approach:
      'codebase locator: answer questions about repo structure, symbols, and call-graphs using only local search tools — no web search',
    profile: researcherNoWebProfile,
  },
  {
    baseRole: 'researcher',
    name: 'external',
    approach:
      'external researcher: answer questions that require fetching information from the web using web-search tools',
    profile: researcherProfile,
  },
  {
    baseRole: 'researcher',
    name: 'diagnostic',
    approach:
      'diagnostic researcher: trace bug root causes using only local signals — logs, traces, and code; no web search',
    profile: researcherNoWebProfile,
  },
  {
    baseRole: 'researcher',
    name: 'decision',
    approach:
      'decision researcher: synthesize a cited, evidence-based answer to a scoped architectural or design question using only local sources; no web search',
    profile: researcherNoWebProfile,
  },
];

/** All sub-roles declared for `baseRole`, or an empty array for owner-tier roles. */
export function subRolesFor(baseRole: Role): readonly SubRoleSpec[] {
  return SUB_ROLES.filter((s) => s.baseRole === baseRole);
}

/** Find a sub-role by base role + name, or `undefined` if not in the shipped set. */
export function findSubRole(baseRole: Role, name: string): SubRoleSpec | undefined {
  return SUB_ROLES.find((s) => s.baseRole === baseRole && s.name === name);
}

/**
 * Whether a RESOLVED `(role, subRole)` carries the `web-search` capability — the single source of
 * truth for "may this agent reach the web / api.github.com / gh". This is the PURE capability check
 * that {@link import('../permissions/pane-launch-config.js').paneMayResearchWeb} delegates to, so the
 * dispatch-time advisory and the launch-time network gate can never drift (both read the same
 * narrow-only-checked `web-search` delta).
 *
 * True iff the resolved sub-role profile holds `web-search` — today the sole holder is
 * `researcher:external`. A bare researcher (no sub-role), the non-web researcher sub-roles
 * (`codebase`/`diagnostic`/`decision`, which narrow it away), and all code-worker roles are false.
 * A missing role or unknown sub-role is false (least-privilege default-deny).
 */
export function roleMayResearchWeb(role: string | undefined, subRole: string | undefined): boolean {
  if (role == null || subRole == null) return false;
  const profile = findSubRole(role as Role, subRole)?.profile;
  return profile?.capabilities.has('web-search') ?? false;
}

/**
 * Parse a `base:sub` identity string into its components. Tolerates a bare base role (no colon).
 * Does NOT validate that the base role or sub-role name are known — use `findSubRole` for that.
 */
export function parseSubRoleId(id: string): { baseRole: string; name?: string } {
  const colonIdx = id.indexOf(':');
  if (colonIdx === -1) {
    return { baseRole: id };
  }
  return { baseRole: id.slice(0, colonIdx), name: id.slice(colonIdx + 1) };
}
