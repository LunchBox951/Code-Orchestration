/**
 * Authoritative permission profiles for the five base roles (L6a Phase A). Each profile is the
 * single source of truth for a role's mandate, write-scope, toolset, and capability ceiling.
 * `roleToolsets` in tools/scoping.ts is now DERIVED from these profiles.
 *
 * Import-cycle guard: only a type-import of `Role` from tools/scoping.ts is used here (type-only
 * — no runtime import of scoping from this file). `Role`/`BASE_ROLES` stay defined in scoping.ts
 * so that file remains the single Role-vocabulary owner; profile.ts is the single permission-data
 * owner.
 */
import type { Role } from '../tools/scoping.js';

/** What a role is allowed to write. `delegates` means it writes via its children's writes. */
export type WriteScope = 'delegates' | 'code' | 'read-only-for-code' | 'nothing';

/** Sub-role-gated capabilities; `web-search` is Phase B's narrowing point per researcher sub-role. */
export type Capability = 'web-search';

export interface RoleProfile {
  readonly baseRole: Role;
  readonly mandate: string;
  readonly writeScope: WriteScope;
  readonly toolset: readonly string[];
  readonly capabilities: ReadonlySet<Capability>;
}

const UNIVERSAL: readonly string[] = [
  'co_orient',
  'co_status',
  'co_mail_inbox',
  'co_mail_get',
  'co_mail_thread',
  'co_mail_send',
  'co_mail_ack',
  'co_spec_get',
  // L6b G/H — friction can hit ANY agent (capture + the dedup read), and any agent may read a
  // finalized research record instead of re-searching (context economy, research.md).
  'co_issue_capture',
  'co_issue_list',
  'co_research_get',
];

/**
 * The authoritative permission profile for each of the five base roles (agent-roles.md §"The
 * roster"). Toolsets mirror the seed rosters from tools/scoping.ts — scoping.ts now DERIVES its
 * `roleToolsets` map from this object rather than maintaining a separate seed.
 */
export const ROLE_PROFILES: Readonly<Record<Role, RoleProfile>> = {
  coordinator: {
    baseRole: 'coordinator',
    mandate:
      'task owner: shape intent → lock spec → plan phases → dispatch → gate → publish → close. Plans the work itself, spawning Researchers when investigation is needed.',
    writeScope: 'delegates',
    toolset: [
      ...UNIVERSAL,
      'co_mail_retract',
      'co_spec_draft',
      'co_spec_archive',
      'co_plan_ingest',
      'co_phase_status',
      'co_sling',
      'co_kickback',
      'co_merge',
      'co_push',
      'co_pr_merge',
      'co_issue_file',
    ],
    capabilities: new Set<Capability>(),
  },
  lead: {
    baseRole: 'lead',
    mandate:
      'phase owner: decompose → dispatch workers → integrate reviewed branches → verify → report phase-ready.',
    writeScope: 'delegates',
    toolset: [
      ...UNIVERSAL,
      'co_mail_retract',
      'co_worktree_info',
      'co_phase_status',
      'co_sling',
      'co_finish',
      'co_merge',
      'co_kickback',
      'co_push',
      'co_pr_merge',
      'co_issue_file',
    ],
    capabilities: new Set<Capability>(),
  },
  implementer: {
    baseRole: 'implementer',
    mandate:
      'changes code in an isolated worktree, finishes through the gate, and may request scoped researcher dispatch.',
    writeScope: 'code',
    toolset: [...UNIVERSAL, 'co_mail_retract', 'co_worktree_info', 'co_finish', 'co_sling'],
    capabilities: new Set<Capability>(),
  },
  reviewer: {
    baseRole: 'reviewer',
    mandate: 'the gate; inspects a target and returns a verdict.',
    writeScope: 'read-only-for-code',
    toolset: [...UNIVERSAL, 'co_worktree_info', 'co_review_finalize'],
    capabilities: new Set<Capability>(),
  },
  researcher: {
    baseRole: 'researcher',
    mandate: 'read-only; answers a scoped question with cited evidence; stays warm for follow-ups.',
    writeScope: 'nothing',
    toolset: [...UNIVERSAL, 'co_issue_diagnose', 'co_research_finalize'],
    capabilities: new Set<Capability>(['web-search']),
  },
};

/** Return the authoritative profile for `role`. */
export function profileFor(role: Role): RoleProfile {
  return ROLE_PROFILES[role];
}

export interface RoleProfileViolation {
  readonly role: string;
  readonly reason: string;
}

const VALID_WRITE_SCOPES: ReadonlySet<string> = new Set([
  'delegates',
  'code',
  'read-only-for-code',
  'nothing',
]);

/**
 * Validate the completeness of a set of role profiles. Called with no argument it checks the
 * authoritative `ROLE_PROFILES`; tests may pass a crafted map to exercise the RED path.
 *
 * A profile is complete iff:
 *   (a) its `baseRole` field matches its map key,
 *   (b) its `mandate` is non-empty,
 *   (c) its `toolset` is non-empty,
 *   (d) its `writeScope` is a valid member of the `WriteScope` union.
 *
 * Returns `[]` when every entry is green; one {@link RoleProfileViolation} per failed condition
 * otherwise.
 */
export function checkRoleProfileCompleteness(
  profiles: Readonly<Record<string, RoleProfile>> = ROLE_PROFILES as Readonly<
    Record<string, RoleProfile>
  >,
): RoleProfileViolation[] {
  const violations: RoleProfileViolation[] = [];
  for (const [role, profile] of Object.entries(profiles)) {
    if (profile.baseRole !== role) {
      violations.push({
        role,
        reason: `baseRole '${profile.baseRole}' does not match map key '${role}'`,
      });
    }
    if (!profile.mandate.trim()) {
      violations.push({ role, reason: 'mandate is empty' });
    }
    if (!profile.toolset.length) {
      violations.push({ role, reason: 'toolset is empty' });
    }
    if (!VALID_WRITE_SCOPES.has(profile.writeScope)) {
      violations.push({ role, reason: `invalid writeScope: '${String(profile.writeScope)}'` });
    }
  }
  return violations;
}
