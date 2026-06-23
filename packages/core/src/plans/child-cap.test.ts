import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfigStore, type ConfigStore } from '../config/config-store.js';
import {
  MAX_ACTIVE_CHILDREN_DEFAULT,
  MAX_ACTIVE_CHILDREN_KEY,
  activeChildCount,
  childCapDisposition,
  resolveMaxActiveChildren,
  type CapChild,
} from './child-cap.js';

// L6b E4 — the max-active-children cap. active children = non-reviewer children whose branch is NOT
// merged (reviewers EXCLUDED; merged children EXCLUDED). At/over the cap a new dispatch QUEUES → WAITING.

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let configStores: ConfigStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  configStores = [];
  const dir = mkdtempSync(join(tmpdir(), 'co-child-cap-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const c of configStores) c.close();
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
  configStores = [];
});

function openCfg(): ConfigStore {
  const cfg = openConfigStore();
  configStores.push(cfg);
  return cfg;
}

const child = (childId: string, role: CapChild['role'], branch?: string): CapChild =>
  branch != null ? { childId, role, branch } : { childId, role };

// A simple merged-set predicate so the policy tests stay pure (no store).
const mergedBy =
  (mergedBranches: ReadonlySet<string>) =>
  (c: CapChild): boolean =>
    c.branch != null && mergedBranches.has(c.branch);

describe('activeChildCount — excludes reviewers and excludes merged children', () => {
  it('counts only non-reviewer, unmerged children', () => {
    const children = [
      child('impl-1', 'implementer', 'co/a'), // active
      child('impl-2', 'implementer', 'co/b'), // merged → excluded
      child('rev-1', 'reviewer', 'co/r'), // reviewer → excluded
      child('lead-1', 'lead', 'co/c'), // active (a non-reviewer worker role)
    ];
    const count = activeChildCount(children, mergedBy(new Set(['co/b'])));
    expect(count).toBe(2); // impl-1 + lead-1
  });

  it('a reviewer child is ALWAYS excluded, even when unmerged', () => {
    const children = [child('rev-1', 'reviewer', 'co/r'), child('rev-2', 'reviewer')];
    expect(activeChildCount(children, () => false)).toBe(0);
  });

  it('a merged child frees its slot (excluded) regardless of role', () => {
    const children = [child('impl-1', 'implementer', 'co/a')];
    expect(activeChildCount(children, mergedBy(new Set(['co/a'])))).toBe(0);
    expect(activeChildCount(children, mergedBy(new Set()))).toBe(1);
  });

  it('a child with no resolvable branch counts as still-active (slot conservatively occupied)', () => {
    const children = [child('impl-1', 'implementer')];
    expect(activeChildCount(children, mergedBy(new Set()))).toBe(1);
  });

  // #131 — a durably STOPPED child no longer occupies a slot. The optional isInactive predicate
  // EXCLUDES it; omitting the predicate (default `() => false`) preserves the existence-only count.
  it('excludes a child where isInactive returns true (stopped frees the slot — #131)', () => {
    const children = [
      child('impl-1', 'implementer', 'co/a'), // active
      child('impl-2', 'implementer', 'co/b'), // stopped → excluded
    ];
    const stopped = new Set(['impl-2']);
    const count = activeChildCount(children, mergedBy(new Set()), (c) => stopped.has(c.childId));
    expect(count).toBe(1); // only impl-1
  });

  it('the isInactive predicate defaults to false (existence-only count unchanged)', () => {
    const children = [
      child('impl-1', 'implementer', 'co/a'),
      child('impl-2', 'implementer', 'co/b'),
    ];
    expect(activeChildCount(children, mergedBy(new Set()))).toBe(2);
  });
});

describe('childCapDisposition — at/over cap queues → WAITING (first-class, never a throw)', () => {
  it('queues when activeCount >= cap', () => {
    const children = [
      child('impl-1', 'implementer', 'co/a'),
      child('impl-2', 'implementer', 'co/b'),
    ];
    const d = childCapDisposition(children, () => false, 2);
    expect(d).toEqual({ queued: true, activeCount: 2, cap: 2 });
  });

  it('does NOT queue when activeCount < cap', () => {
    const children = [child('impl-1', 'implementer', 'co/a')];
    const d = childCapDisposition(children, () => false, 2);
    expect(d).toEqual({ queued: false, activeCount: 1, cap: 2 });
  });

  it('merged + reviewer children do not count toward the cap', () => {
    const children = [
      child('impl-1', 'implementer', 'co/a'), // active
      child('impl-2', 'implementer', 'co/b'), // merged → excluded
      child('rev-1', 'reviewer', 'co/r'), // reviewer → excluded
    ];
    const d = childCapDisposition(children, mergedBy(new Set(['co/b'])), 2);
    expect(d.activeCount).toBe(1);
    expect(d.queued).toBe(false);
  });

  // #131 — at a cap of 2 with 2 children, one STOPPED, the activeCount drops to 1 and the new
  // dispatch is NOT queued (the stopped child freed its slot).
  it('a stopped child frees a slot so a new dispatch is not queued (activeCount 1, queued false)', () => {
    const children = [
      child('impl-1', 'implementer', 'co/a'),
      child('impl-2', 'implementer', 'co/b'),
    ];
    const stopped = new Set(['impl-2']);
    const d = childCapDisposition(
      children,
      () => false,
      2,
      (c) => stopped.has(c.childId),
    );
    expect(d).toEqual({ queued: false, activeCount: 1, cap: 2 });
  });

  it('without an isInactive predicate, two children at a cap of 2 still queue (unchanged)', () => {
    const children = [
      child('impl-1', 'implementer', 'co/a'),
      child('impl-2', 'implementer', 'co/b'),
    ];
    const d = childCapDisposition(children, () => false, 2);
    expect(d).toEqual({ queued: true, activeCount: 2, cap: 2 });
  });
});

describe('resolveMaxActiveChildren — config-cascade reader (default 2, overridable)', () => {
  it('the key + default are pinned', () => {
    expect(MAX_ACTIVE_CHILDREN_KEY).toBe('dispatch.maxActiveChildren');
    expect(MAX_ACTIVE_CHILDREN_DEFAULT).toBe(2);
  });

  it('defaults to 2 when unset', () => {
    const cfg = openCfg();
    expect(resolveMaxActiveChildren('p-cap', cfg)).toBe(2);
  });

  it('honors a project override', () => {
    const cfg = openCfg();
    cfg.setProjectOverride('p-cap', MAX_ACTIVE_CHILDREN_KEY, 5);
    expect(resolveMaxActiveChildren('p-cap', cfg)).toBe(5);
  });

  it('fails loud on a non-positive-integer override (Principle 9)', () => {
    const cfg = openCfg();
    cfg.setProjectOverride('p-cap', MAX_ACTIVE_CHILDREN_KEY, 0);
    expect(() => resolveMaxActiveChildren('p-cap', cfg)).toThrow(/positive integer/i);
    cfg.setProjectOverride('p-cap2', MAX_ACTIVE_CHILDREN_KEY, 1.5);
    expect(() => resolveMaxActiveChildren('p-cap2', cfg)).toThrow(/positive integer/i);
  });

  it('opens its own config store when none is injected (default path)', () => {
    expect(resolveMaxActiveChildren('p-unset')).toBe(MAX_ACTIVE_CHILDREN_DEFAULT);
  });
});
