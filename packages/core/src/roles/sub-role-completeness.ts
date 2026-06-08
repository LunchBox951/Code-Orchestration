/**
 * Sub-role completeness discipline (L6a Phase B). A declared sub-role earns its place only when
 * its approach meaningfully differs — a non-differentiated or duplicate sub-role fails this check.
 *
 * This is a pure function — no I/O, no clock (AC-L6a-9).
 */
import type { SubRoleSpec } from './sub-roles.js';
import { SUB_ROLES } from './sub-roles.js';

export interface SubRoleViolation {
  readonly subRole: string;
  readonly reason: string;
}

/** Owner-tier roles that may NOT have sub-roles. */
const OWNER_TIER_ROLES = new Set(['coordinator', 'lead']);

/**
 * Validate the completeness of a set of sub-role specs. Defaults to {@link SUB_ROLES}.
 *
 * A declared sub-role is complete iff:
 *   (a) its `approach` is non-empty,
 *   (b) its `baseRole` is not an owner-tier role (coordinator/lead),
 *   (c) its `name` is unique within its base role,
 *   (d) its `approach` is unique within its base role (no two sub-roles of the same base may
 *       share an identical approach string — they must meaningfully differ).
 *
 * Returns `[]` for the shipped set; one {@link SubRoleViolation} per failed condition otherwise.
 */
export function checkSubRoleCompleteness(
  subs: readonly SubRoleSpec[] = SUB_ROLES,
): SubRoleViolation[] {
  const violations: SubRoleViolation[] = [];

  // Group by baseRole for duplicate-detection passes
  const byBase = new Map<string, SubRoleSpec[]>();
  for (const sub of subs) {
    const group = byBase.get(sub.baseRole) ?? [];
    group.push(sub);
    byBase.set(sub.baseRole, group);
  }

  // Per-sub-role checks
  for (const sub of subs) {
    const id = `${sub.baseRole}:${sub.name}`;

    if (!sub.approach.trim()) {
      violations.push({ subRole: id, reason: 'approach is empty' });
    }

    if (OWNER_TIER_ROLES.has(sub.baseRole)) {
      violations.push({
        subRole: id,
        reason: `base role '${sub.baseRole}' is an owner-tier role and may not have sub-roles`,
      });
    }
  }

  // Per-base-role duplicate checks
  for (const [baseRole, group] of byBase) {
    const seenNames = new Set<string>();
    const seenApproaches = new Map<string, string>(); // approach → first sub-role name

    for (const sub of group) {
      const id = `${baseRole}:${sub.name}`;

      if (seenNames.has(sub.name)) {
        violations.push({
          subRole: id,
          reason: `duplicate name '${sub.name}' within base role '${baseRole}'`,
        });
      }
      seenNames.add(sub.name);

      if (sub.approach.trim() && seenApproaches.has(sub.approach)) {
        violations.push({
          subRole: id,
          reason: `approach is identical to sub-role '${baseRole}:${seenApproaches.get(sub.approach)}' — sub-roles must meaningfully differ`,
        });
      }
      if (sub.approach.trim()) {
        seenApproaches.set(sub.approach, sub.name);
      }
    }
  }

  return violations;
}
