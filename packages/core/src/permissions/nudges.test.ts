import { describe, expect, it } from 'vitest';
import { NUDGE_CATALOG, injectNudge, nudgeFor } from './nudges.js';

describe('NUDGE_CATALOG', () => {
  it('is non-empty', () => {
    expect(NUDGE_CATALOG.length).toBeGreaterThan(0);
  });

  it('every entry has non-empty id, trigger, and nudge', () => {
    for (const entry of NUDGE_CATALOG) {
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.trigger.length).toBeGreaterThan(0);
      expect(entry.nudge.length).toBeGreaterThan(0);
    }
  });

  it('all ids are unique', () => {
    const ids = NUDGE_CATALOG.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('nudgeFor', () => {
  it('resolves a known id', () => {
    const rule = nudgeFor('finish-before-yield');
    expect(rule).toBeDefined();
    expect(rule?.id).toBe('finish-before-yield');
  });

  it('returns undefined for an unknown id', () => {
    expect(nudgeFor('no-such-nudge')).toBeUndefined();
  });
});

describe('injectNudge — L7 stub (AC-L6a-9)', () => {
  it('throws loudly rather than silently no-op-ing', () => {
    expect(() => injectNudge()).toThrow(/L7/);
  });
});
