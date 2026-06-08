import { describe, expect, it } from 'vitest';
import { findSubRole, parseSubRoleId, SUB_ROLES, subRolesFor } from './sub-roles.js';

describe('SUB_ROLES — shipped set coverage', () => {
  it('includes exactly the agent-roles.md implementer sub-roles: code, test, docs, polish', () => {
    const names = subRolesFor('implementer').map((s) => s.name);
    expect(names.sort()).toEqual(['code', 'docs', 'polish', 'test']);
  });

  it('includes exactly the agent-roles.md reviewer sub-roles: feature, bugfix, pr', () => {
    const names = subRolesFor('reviewer').map((s) => s.name);
    expect(names.sort()).toEqual(['bugfix', 'feature', 'pr']);
  });

  it('includes exactly the agent-roles.md researcher sub-roles: codebase, external, diagnostic, decision', () => {
    const names = subRolesFor('researcher').map((s) => s.name);
    expect(names.sort()).toEqual(['codebase', 'decision', 'diagnostic', 'external']);
  });

  it('has no sub-roles for coordinator (owner tier)', () => {
    expect(subRolesFor('coordinator')).toEqual([]);
  });

  it('has no sub-roles for lead (owner tier)', () => {
    expect(subRolesFor('lead')).toEqual([]);
  });

  it('total count is exactly 11 (4 + 3 + 4)', () => {
    expect(SUB_ROLES.length).toBe(11);
  });
});

describe('SUB_ROLES — web-search real permission delta', () => {
  it('researcher:external retains web-search capability', () => {
    const sub = findSubRole('researcher', 'external');
    expect(sub).toBeDefined();
    expect(sub!.profile.capabilities.has('web-search')).toBe(true);
  });

  it('researcher:codebase does NOT have web-search', () => {
    const sub = findSubRole('researcher', 'codebase');
    expect(sub).toBeDefined();
    expect(sub!.profile.capabilities.has('web-search')).toBe(false);
  });

  it('researcher:diagnostic does NOT have web-search', () => {
    const sub = findSubRole('researcher', 'diagnostic');
    expect(sub).toBeDefined();
    expect(sub!.profile.capabilities.has('web-search')).toBe(false);
  });

  it('researcher:decision does NOT have web-search', () => {
    const sub = findSubRole('researcher', 'decision');
    expect(sub).toBeDefined();
    expect(sub!.profile.capabilities.has('web-search')).toBe(false);
  });
});

describe('SUB_ROLES — reviewer sub-roles writeScope', () => {
  it('all reviewer sub-roles have writeScope read-only-for-code', () => {
    const reviewerSubs = subRolesFor('reviewer');
    for (const sub of reviewerSubs) {
      expect(sub.profile.writeScope).toBe('read-only-for-code');
    }
  });
});

describe('findSubRole', () => {
  it('returns the sub-role when found', () => {
    const sub = findSubRole('implementer', 'test');
    expect(sub).toBeDefined();
    expect(sub!.baseRole).toBe('implementer');
    expect(sub!.name).toBe('test');
  });

  it('returns undefined for an unknown sub-role name', () => {
    expect(findSubRole('implementer', 'nonexistent')).toBeUndefined();
  });

  it('returns undefined for an owner-tier role', () => {
    expect(findSubRole('coordinator', 'anything')).toBeUndefined();
  });
});

describe('parseSubRoleId', () => {
  it('parses a base:sub identity', () => {
    expect(parseSubRoleId('implementer:test')).toEqual({ baseRole: 'implementer', name: 'test' });
  });

  it('tolerates a bare base role (no colon)', () => {
    expect(parseSubRoleId('researcher')).toEqual({ baseRole: 'researcher' });
  });

  it('handles an unknown/arbitrary string gracefully', () => {
    const result = parseSubRoleId('foo:bar');
    expect(result.baseRole).toBe('foo');
    expect(result.name).toBe('bar');
  });
});
