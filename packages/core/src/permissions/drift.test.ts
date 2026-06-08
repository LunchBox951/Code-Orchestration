import { describe, expect, it } from 'vitest';
import { BLOCK_LIST } from './block-list.js';
import { checkBlockListDrift, readEnforcedConfig } from './drift.js';

const ALL_IDS = BLOCK_LIST.map((r) => r.id);

describe('checkBlockListDrift', () => {
  it('returns [] when enforced ids exactly match the registry (AC-L6a-6 GREEN)', () => {
    const result = checkBlockListDrift(BLOCK_LIST, { blockedIds: ALL_IDS });
    expect(result).toEqual([]);
  });

  it('returns declared-not-enforced when a registry rule is missing from enforced config', () => {
    const missingId = 'git-force-push';
    const enforced = { blockedIds: ALL_IDS.filter((id) => id !== missingId) };
    const violations = checkBlockListDrift(BLOCK_LIST, enforced);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ id: missingId, kind: 'declared-not-enforced' });
  });

  it('returns enforced-not-declared when an enforced id is absent from the registry', () => {
    const bogusId = 'not-a-real-rule';
    const enforced = { blockedIds: [...ALL_IDS, bogusId] };
    const violations = checkBlockListDrift(BLOCK_LIST, enforced);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ id: bogusId, kind: 'enforced-not-declared' });
  });

  it('reports both kinds simultaneously when ids diverge in both directions', () => {
    const missing = 'sudo';
    const bogus = 'phantom-rule';
    const enforced = {
      blockedIds: [...ALL_IDS.filter((id) => id !== missing), bogus],
    };
    const violations = checkBlockListDrift(BLOCK_LIST, enforced);
    expect(violations).toHaveLength(2);
    expect(violations.find((v) => v.kind === 'declared-not-enforced')?.id).toBe(missing);
    expect(violations.find((v) => v.kind === 'enforced-not-declared')?.id).toBe(bogus);
  });
});

describe('readEnforcedConfig — L7 stub (AC-L6a-9)', () => {
  it('throws loudly rather than silently no-op-ing', () => {
    expect(() => readEnforcedConfig()).toThrow(/L7/);
  });
});
