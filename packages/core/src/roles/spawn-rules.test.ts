import { describe, it, expect } from 'vitest';
import { canSpawn, checkSpawnPlan, validateSpawnPlan, SPAWN_RULES } from './spawn-rules.js';

// AC-L6a-3 — structural spawn rules: named violations on illegal edges; empty result on a legal plan.

describe('SPAWN_RULES — correct allowed-child sets per parent', () => {
  it('coordinator may spawn lead, implementer, reviewer, researcher — not coordinator', () => {
    expect(canSpawn('coordinator', 'lead')).toBe(true);
    expect(canSpawn('coordinator', 'implementer')).toBe(true);
    expect(canSpawn('coordinator', 'reviewer')).toBe(true);
    expect(canSpawn('coordinator', 'researcher')).toBe(true);
    expect(canSpawn('coordinator', 'coordinator')).toBe(false);
  });

  it('lead may spawn implementer, reviewer, researcher — not coordinator or lead', () => {
    expect(canSpawn('lead', 'implementer')).toBe(true);
    expect(canSpawn('lead', 'reviewer')).toBe(true);
    expect(canSpawn('lead', 'researcher')).toBe(true);
    expect(canSpawn('lead', 'coordinator')).toBe(false);
    expect(canSpawn('lead', 'lead')).toBe(false);
  });

  it('implementer may only spawn researcher', () => {
    expect(canSpawn('implementer', 'researcher')).toBe(true);
    expect(canSpawn('implementer', 'implementer')).toBe(false);
    expect(canSpawn('implementer', 'lead')).toBe(false);
    expect(canSpawn('implementer', 'reviewer')).toBe(false);
    expect(canSpawn('implementer', 'coordinator')).toBe(false);
  });

  it('reviewer and researcher are leaves — they cannot spawn anyone', () => {
    expect(SPAWN_RULES.reviewer.size).toBe(0);
    expect(SPAWN_RULES.researcher.size).toBe(0);
    for (const role of ['coordinator', 'lead', 'implementer', 'reviewer', 'researcher'] as const) {
      expect(canSpawn('reviewer', role)).toBe(false);
      expect(canSpawn('researcher', role)).toBe(false);
    }
  });
});

describe('checkSpawnPlan — named violations on illegal edges', () => {
  it('coordinator → coordinator returns a violation with a named reason', () => {
    const v = checkSpawnPlan('coordinator', 'coordinator');
    expect(v).not.toBeNull();
    expect(v!.parent).toBe('coordinator');
    expect(v!.child).toBe('coordinator');
    expect(v!.reason).toMatch(/coordinator/i);
  });

  it('lead → lead returns a violation with a named reason', () => {
    const v = checkSpawnPlan('lead', 'lead');
    expect(v).not.toBeNull();
    expect(v!.parent).toBe('lead');
    expect(v!.child).toBe('lead');
    expect(v!.reason).toMatch(/lead/i);
  });

  it('researcher → implementer returns a violation (researcher-is-leaf)', () => {
    const v = checkSpawnPlan('researcher', 'implementer');
    expect(v).not.toBeNull();
    expect(v!.reason).toMatch(/leaf/i);
  });

  it('reviewer → researcher returns a violation (reviewer-is-leaf)', () => {
    const v = checkSpawnPlan('reviewer', 'researcher');
    expect(v).not.toBeNull();
    expect(v!.reason).toMatch(/leaf/i);
  });

  it('returns null for every legal edge', () => {
    const legalEdges = [
      { parent: 'coordinator', child: 'lead' },
      { parent: 'coordinator', child: 'implementer' },
      { parent: 'coordinator', child: 'reviewer' },
      { parent: 'coordinator', child: 'researcher' },
      { parent: 'lead', child: 'implementer' },
      { parent: 'lead', child: 'reviewer' },
      { parent: 'lead', child: 'researcher' },
      { parent: 'implementer', child: 'researcher' },
    ] as const;
    for (const { parent, child } of legalEdges) {
      expect(checkSpawnPlan(parent, child)).toBeNull();
    }
  });
});

describe('validateSpawnPlan — full plan validation', () => {
  it('a legal plan returns an empty violations array', () => {
    const plan = [
      { parent: 'coordinator', child: 'lead' },
      { parent: 'lead', child: 'implementer' },
      { parent: 'lead', child: 'researcher' },
      { parent: 'implementer', child: 'researcher' },
    ] as const;
    expect(validateSpawnPlan(plan)).toEqual([]);
  });

  it('a plan with mixed legal + illegal edges returns only the violations', () => {
    const plan = [
      { parent: 'coordinator', child: 'lead' }, // legal
      { parent: 'coordinator', child: 'coordinator' }, // illegal
      { parent: 'lead', child: 'implementer' }, // legal
      { parent: 'reviewer', child: 'researcher' }, // illegal
    ] as const;
    const violations = validateSpawnPlan(plan);
    expect(violations).toHaveLength(2);
    expect(violations.some((v) => v.parent === 'coordinator' && v.child === 'coordinator')).toBe(
      true,
    );
    expect(violations.some((v) => v.parent === 'reviewer')).toBe(true);
  });

  it('an empty plan returns an empty violations array', () => {
    expect(validateSpawnPlan([])).toEqual([]);
  });
});
