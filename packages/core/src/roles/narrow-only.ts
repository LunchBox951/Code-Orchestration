/**
 * Narrow-only invariant check for sub-roles (L6a Phase B). A sub-role inherits its base role's
 * permission profile and may narrow it — it must never widen it (sub-roles are not a permission
 * backdoor). Three axes: toolset, capabilities, writeScope.
 *
 * This is a pure function — no I/O, no clock (AC-L6a-9).
 */
import type { RoleProfile } from './profile.js';
import { ROLE_PROFILES } from './profile.js';
import type { SubRoleSpec } from './sub-roles.js';
import { SUB_ROLES } from './sub-roles.js';

export interface NarrowViolation {
  readonly subRole: string;
  readonly reason: string;
}

/**
 * Numeric rank for the code-write-power ordering: nothing(0) < read-only-for-code(1) < code(2)
 * < delegates(3). `delegates` ranks above `code` so a sub-role on a non-delegates base that sets
 * `delegates` is correctly caught as a widening (not a silent pass via the -1 fallback).
 * The `delegates`-base path is handled separately (only narrows to `delegates`).
 */
const WRITE_SCOPE_RANK: Partial<Record<string, number>> = {
  nothing: 0,
  'read-only-for-code': 1,
  code: 2,
  delegates: 3,
};

/**
 * Check that `sub` does not widen `base`'s permission profile. Returns one {@link NarrowViolation}
 * per failed condition; returns `[]` when the sub-role is legal (inherits or narrows only).
 *
 * Checked conditions:
 *   1. `sub.profile.baseRole === base.baseRole` — a sub-role may not change its base role.
 *   2. `sub.profile.toolset ⊆ base.toolset` — a tool present in sub but absent in base = WIDENING.
 *   3. `sub.profile.capabilities ⊆ base.capabilities` — a capability sub has but base lacks = WIDENING.
 *   4. `sub.profile.writeScope` is no wider than `base.writeScope`:
 *      - `delegates` bases may only narrow to `delegates`;
 *      - other scopes: sub rank must not exceed base rank.
 */
export function narrowOnly(base: RoleProfile, sub: SubRoleSpec): NarrowViolation[] {
  const violations: NarrowViolation[] = [];
  const id = `${sub.baseRole}:${sub.name}`;

  if (sub.profile.baseRole !== base.baseRole) {
    violations.push({
      subRole: id,
      reason: `sub-role baseRole '${sub.profile.baseRole}' does not match base role '${base.baseRole}'`,
    });
  }

  const baseToolset = new Set(base.toolset);
  for (const tool of sub.profile.toolset) {
    if (!baseToolset.has(tool)) {
      violations.push({
        subRole: id,
        reason: `sub-role adds tool '${tool}' not present in base role '${base.baseRole}' toolset (widening)`,
      });
    }
  }

  for (const cap of sub.profile.capabilities) {
    if (!base.capabilities.has(cap)) {
      violations.push({
        subRole: id,
        reason: `sub-role adds capability '${String(cap)}' not present in base role '${base.baseRole}' (widening)`,
      });
    }
  }

  const baseScope = base.writeScope;
  const subScope = sub.profile.writeScope;
  if (baseScope === 'delegates') {
    if (subScope !== 'delegates') {
      violations.push({
        subRole: id,
        reason: `base role writeScope is 'delegates'; sub-role may only narrow to 'delegates', got '${subScope}'`,
      });
    }
  } else {
    const baseRank = WRITE_SCOPE_RANK[baseScope];
    const subRank = WRITE_SCOPE_RANK[subScope];
    if (baseRank == null) {
      violations.push({
        subRole: id,
        reason: `base role has unknown writeScope '${baseScope}'; cannot prove sub-role is narrow-only`,
      });
    }
    if (subRank == null) {
      violations.push({
        subRole: id,
        reason: `sub-role has unknown writeScope '${subScope}'; cannot prove sub-role is narrow-only`,
      });
    }
    if (baseRank == null || subRank == null) return violations;
    if (subRank > baseRank) {
      violations.push({
        subRole: id,
        reason: `sub-role writeScope '${subScope}' is wider than base writeScope '${baseScope}' (widening)`,
      });
    }
  }

  return violations;
}

/**
 * Run {@link narrowOnly} over every entry in `subs` (defaults to {@link SUB_ROLES}).
 * Returns `[]` for the shipped set; returns one or more violations for any widening sub-role.
 */
export function validateSubRoles(subs: readonly SubRoleSpec[] = SUB_ROLES): NarrowViolation[] {
  const violations: NarrowViolation[] = [];
  for (const sub of subs) {
    const baseProfile = ROLE_PROFILES[sub.baseRole];
    violations.push(...narrowOnly(baseProfile, sub));
  }
  return violations;
}
