import { describe, expect, it } from 'vitest';
import { checkSubRoleCompleteness } from './sub-role-completeness.js';
import { ROLE_PROFILES } from './profile.js';
import { checkRoleProfileCompleteness } from './profile.js';
import { buildCoreRegistry } from '../tools/core-registry.js';
import { checkToolCompleteness } from '../tools/completeness.js';
import type { SubRoleSpec } from './sub-roles.js';
import { SUB_ROLES } from './sub-roles.js';

describe('checkSubRoleCompleteness — shipped set (AC-L6a-8 partial)', () => {
  it('returns [] for the entire shipped sub-role set', () => {
    expect(checkSubRoleCompleteness()).toEqual([]);
  });
});

describe('checkSubRoleCompleteness — RED on synthetic violations', () => {
  it('flags a sub-role with an empty approach', () => {
    const bad: SubRoleSpec = {
      baseRole: 'implementer',
      name: 'empty-approach',
      approach: '',
      profile: ROLE_PROFILES['implementer'],
    };
    const violations = checkSubRoleCompleteness([...SUB_ROLES, bad]);
    expect(violations.some((v) => v.subRole === 'implementer:empty-approach')).toBe(true);
    expect(violations.some((v) => v.reason.includes('approach is empty'))).toBe(true);
  });

  it('flags a duplicate approach within the same base role', () => {
    const dup: SubRoleSpec = {
      baseRole: 'implementer',
      name: 'dup',
      approach:
        'implementation-first: write the change, then write tests that lock the decisions in against regression — tests follow code',
      profile: ROLE_PROFILES['implementer'],
    };
    const violations = checkSubRoleCompleteness([...SUB_ROLES, dup]);
    expect(violations.some((v) => v.subRole === 'implementer:dup')).toBe(true);
    expect(violations.some((v) => v.reason.includes('identical'))).toBe(true);
  });

  it('flags a sub-role declared for coordinator (owner tier)', () => {
    const bad: SubRoleSpec = {
      baseRole: 'coordinator',
      name: 'detail',
      approach: 'coordinator detail sub-role',
      profile: ROLE_PROFILES['coordinator'],
    };
    const violations = checkSubRoleCompleteness([...SUB_ROLES, bad]);
    expect(violations.some((v) => v.subRole === 'coordinator:detail')).toBe(true);
    expect(violations.some((v) => v.reason.includes('owner-tier'))).toBe(true);
  });

  it('flags a sub-role declared for lead (owner tier)', () => {
    const bad: SubRoleSpec = {
      baseRole: 'lead',
      name: 'phase',
      approach: 'lead sub-role',
      profile: ROLE_PROFILES['lead'],
    };
    const violations = checkSubRoleCompleteness([...SUB_ROLES, bad]);
    expect(violations.some((v) => v.subRole === 'lead:phase')).toBe(true);
    expect(violations.some((v) => v.reason.includes('owner-tier'))).toBe(true);
  });
});

describe('Phase A still green (AC-L6a-8)', () => {
  it('checkToolCompleteness(buildCoreRegistry()) returns []', () => {
    expect(checkToolCompleteness(buildCoreRegistry())).toEqual([]);
  });

  it('checkRoleProfileCompleteness() returns []', () => {
    expect(checkRoleProfileCompleteness()).toEqual([]);
  });
});
