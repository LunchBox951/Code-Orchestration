import { describe, expect, it } from 'vitest';
import { ROLE_PROFILES } from './profile.js';
import { narrowOnly, validateSubRoles } from './narrow-only.js';
import { SUB_ROLES } from './sub-roles.js';
import type { SubRoleSpec } from './sub-roles.js';

describe('validateSubRoles — shipped set (AC-L6a-2)', () => {
  it('returns [] for the entire shipped sub-role set', () => {
    expect(validateSubRoles(SUB_ROLES)).toEqual([]);
  });
});

describe('narrowOnly — widening detection', () => {
  it('flags a reviewer sub-role with writeScope code (writeScope widening)', () => {
    const base = ROLE_PROFILES['reviewer'];
    const sub: SubRoleSpec = {
      baseRole: 'reviewer',
      name: 'widened',
      approach: 'widened approach',
      profile: { ...base, writeScope: 'code' },
    };
    const violations = narrowOnly(base, sub);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.reason.includes('wider'))).toBe(true);
  });

  it('flags a sub-role whose toolset adds a tool the base lacks (toolset widening)', () => {
    const base = ROLE_PROFILES['implementer'];
    const sub: SubRoleSpec = {
      baseRole: 'implementer',
      name: 'toolwidened',
      approach: 'adds a phantom tool',
      profile: { ...base, toolset: [...base.toolset, 'co_phantom_tool'] },
    };
    const violations = narrowOnly(base, sub);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.reason.includes('co_phantom_tool'))).toBe(true);
    expect(violations.some((v) => v.reason.includes('widening'))).toBe(true);
  });

  it('flags a sub-role whose capabilities add a capability the base lacks (capability widening)', () => {
    // Construct a base without web-search; then a sub that adds it
    const base = ROLE_PROFILES['implementer']; // implementer has no capabilities
    const sub: SubRoleSpec = {
      baseRole: 'implementer',
      name: 'capwidened',
      approach: 'acquires web-search on a base that lacks it',
      profile: { ...base, capabilities: new Set(['web-search']) },
    };
    const violations = narrowOnly(base, sub);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.reason.includes('web-search'))).toBe(true);
    expect(violations.some((v) => v.reason.includes('widening'))).toBe(true);
  });

  it('passes for a researcher sub-role that narrows web-search away (researcher:codebase)', () => {
    const base = ROLE_PROFILES['researcher'];
    const sub = SUB_ROLES.find((s) => s.baseRole === 'researcher' && s.name === 'codebase');
    expect(sub).toBeDefined();
    const violations = narrowOnly(base, sub!);
    expect(violations).toEqual([]);
  });
});
