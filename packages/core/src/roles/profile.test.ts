import { describe, it, expect } from 'vitest';
import { BASE_ROLES, roleToolsets, toolsForRole } from '../tools/scoping.js';
import { checkToolCompleteness } from '../tools/completeness.js';
import { buildCoreRegistry } from '../tools/core-registry.js';
import { ROLE_PROFILES, checkRoleProfileCompleteness, type RoleProfile } from './profile.js';

// AC-L6a-1 + AC-L6a-8 — authoritative role profiles: five distinct permission profiles; roleToolsets
// is derived from them; checkRoleProfileCompleteness is green for real profiles and red for crafted
// bad input (both paths must be exercised).

describe('ROLE_PROFILES — five authoritative profiles', () => {
  it('has exactly one profile per base role and no extras', () => {
    const profileKeys = new Set(Object.keys(ROLE_PROFILES));
    const baseRoleSet = new Set<string>(BASE_ROLES);
    expect(profileKeys).toEqual(baseRoleSet);
  });

  it("each profile's baseRole field matches its map key", () => {
    for (const [role, profile] of Object.entries(ROLE_PROFILES)) {
      expect(profile.baseRole).toBe(role);
    }
  });

  it('each profile has a non-empty mandate', () => {
    for (const profile of Object.values(ROLE_PROFILES)) {
      expect(profile.mandate.trim().length).toBeGreaterThan(0);
    }
  });

  it('each profile has a non-empty toolset', () => {
    for (const profile of Object.values(ROLE_PROFILES)) {
      expect(profile.toolset.length).toBeGreaterThan(0);
    }
  });

  it('profiles have a meaningful writeScope spread — not all identical', () => {
    const scopes = new Set(Object.values(ROLE_PROFILES).map((p) => p.writeScope));
    // The five roles carry: delegates (coord, lead), code (impl), read-only-for-code (reviewer),
    // nothing (researcher) — at least 3 distinct values.
    expect(scopes.size).toBeGreaterThanOrEqual(3);
    expect(scopes.has('delegates')).toBe(true);
    expect(scopes.has('code')).toBe(true);
    expect(scopes.has('nothing')).toBe(true);
  });

  it('profiles have distinct mandates', () => {
    const mandates = Object.values(ROLE_PROFILES).map((p) => p.mandate);
    const unique = new Set(mandates);
    expect(unique.size).toBe(mandates.length);
  });

  it('researcher carries web-search capability; other roles do not', () => {
    expect(ROLE_PROFILES.researcher.capabilities.has('web-search')).toBe(true);
    for (const role of ['coordinator', 'lead', 'implementer', 'reviewer'] as const) {
      expect(ROLE_PROFILES[role].capabilities.has('web-search')).toBe(false);
    }
  });

  it('both code-owning worker roles can finish through the durable co_finish path', () => {
    expect(ROLE_PROFILES.lead.toolset).toContain('co_finish');
    expect(ROLE_PROFILES.implementer.toolset).toContain('co_finish');
  });

  it('implementer can request scoped researcher dispatch through co_sling only', () => {
    expect(ROLE_PROFILES.implementer.toolset).toContain('co_sling');
    expect(ROLE_PROFILES.implementer.mandate).toMatch(/researcher/i);
  });
});

describe('roleToolsets — derived from ROLE_PROFILES', () => {
  it('toolsForRole(r) names match ROLE_PROFILES[r].toolset for every base role', () => {
    for (const role of BASE_ROLES) {
      const offered = toolsForRole(role).map((t) => t.name);
      const profile = ROLE_PROFILES[role].toolset;
      // offered is the registry-filtered subset; the sorted names must match the profile toolset.
      expect([...offered].sort()).toEqual([...profile].sort());
    }
  });

  it('roleToolsets map entries match ROLE_PROFILES toolsets', () => {
    for (const role of BASE_ROLES) {
      expect([...roleToolsets.get(role)!].sort()).toEqual([...ROLE_PROFILES[role].toolset].sort());
    }
  });
});

describe('checkRoleProfileCompleteness — green on real profiles, red on crafted input', () => {
  it('returns [] for the authoritative ROLE_PROFILES (GREEN)', () => {
    expect(checkRoleProfileCompleteness()).toEqual([]);
  });

  it('flags a profile with an empty mandate (RED)', () => {
    const bad: Record<string, RoleProfile> = {
      coordinator: { ...ROLE_PROFILES.coordinator, mandate: '   ' },
    };
    const violations = checkRoleProfileCompleteness(bad);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.reason.includes('mandate'))).toBe(true);
  });

  it('flags a profile with an empty toolset (RED)', () => {
    const bad: Record<string, RoleProfile> = {
      lead: { ...ROLE_PROFILES.lead, toolset: [] },
    };
    const violations = checkRoleProfileCompleteness(bad);
    expect(violations.some((v) => v.reason.includes('toolset'))).toBe(true);
  });

  it('flags a profile whose baseRole does not match its key (RED)', () => {
    const bad: Record<string, RoleProfile> = {
      implementer: { ...ROLE_PROFILES.implementer, baseRole: 'coordinator' },
    };
    const violations = checkRoleProfileCompleteness(bad);
    expect(violations.some((v) => v.reason.includes('baseRole'))).toBe(true);
  });

  it('flags a profile with an invalid writeScope (RED)', () => {
    const bad: Record<string, RoleProfile> = {
      reviewer: { ...ROLE_PROFILES.reviewer, writeScope: 'everything' as never },
    };
    const violations = checkRoleProfileCompleteness(bad);
    expect(violations.some((v) => v.reason.includes('writeScope'))).toBe(true);
  });
});

describe('AC-L6a-8 (partial) — checkToolCompleteness still green after refactor', () => {
  it('the tool completeness gate stays GREEN over the real registry', () => {
    expect(checkToolCompleteness(buildCoreRegistry())).toEqual([]);
  });
});
