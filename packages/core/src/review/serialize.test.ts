import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MergeSerialized } from './events.js';
import { openReviewStore, type ReviewStore } from './review-store.js';
import {
  acquireMergeSlot,
  foldActiveSlot,
  reReviewBase,
  releaseMergeSlot,
  type MergeSlotStore,
} from './serialize.js';

// AC-L5-7 — per-target merge SERIALIZATION + the re-review base. Two pending merges to one target
// serialize (exactly one active reviewer/merge; the second waits), and the second re-reviews against the
// POST-LANDING ref resolved via refs — never the caller's stale checkout. The lock is pure + event-
// sourced + clock-free; replay-equality holds on the merge.serialized writes (AC-L5-11).

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let repoDirs: string[] = [];
let reviewStores: ReviewStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  repoDirs = [];
  reviewStores = [];
  const dir = mkdtempSync(join(tmpdir(), 'co-serialize-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const r of reviewStores) r.close();
  for (const dir of [...dataDirs, ...repoDirs]) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
  repoDirs = [];
  reviewStores = [];
});

/** An in-memory {@link MergeSlotStore} that mirrors the real store: the log IS the source of truth. */
function fakeSlotStore(): MergeSlotStore & { readonly log: MergeSerialized[] } {
  const log: MergeSerialized[] = [];
  return {
    log,
    recordSerialized(m: MergeSerialized): void {
      log.push(m);
    },
    activeSerialized(target: string): string | undefined {
      return foldActiveSlot(log.filter((e) => e.target === target));
    },
  };
}

describe('foldActiveSlot — the pure toggle over the merge.serialized log (AC-L5-7 / AC-L5-11)', () => {
  it('no entries ⇒ no active slot', () => {
    expect(foldActiveSlot([])).toBeUndefined();
  });

  it('one grant ⇒ that branch holds the slot', () => {
    expect(foldActiveSlot([{ branch: 'co/a' }])).toBe('co/a');
  });

  it('a grant + its paired release ⇒ the slot is free (even occurrence releases)', () => {
    expect(foldActiveSlot([{ branch: 'co/a' }, { branch: 'co/a' }])).toBeUndefined();
  });

  it('grant a · release a · grant b ⇒ b holds (the queue advances)', () => {
    expect(foldActiveSlot([{ branch: 'co/a' }, { branch: 'co/a' }, { branch: 'co/b' }])).toBe(
      'co/b',
    );
  });

  it('is a pure left-to-right fold — identical input ⇒ identical output (clock-free, AC-L5-11)', () => {
    const log = [{ branch: 'co/a' }, { branch: 'co/a' }, { branch: 'co/b' }, { branch: 'co/c' }];
    expect(foldActiveSlot(log)).toBe(foldActiveSlot([...log]));
    expect(foldActiveSlot(log)).toBe('co/c'); // a released, b took over, c took over.
  });
});

describe('acquire / release the merge slot (AC-L5-7)', () => {
  it('two pending merges to one target ⇒ exactly ONE active; the second WAITS', () => {
    const store = fakeSlotStore();
    const first = acquireMergeSlot(store, 'co/target', 'co/x');
    expect(first).toEqual({ acquired: true, queued: false, active: 'co/x' });

    // The second branch into the SAME target cannot acquire while x holds it — it queues (waits).
    const second = acquireMergeSlot(store, 'co/target', 'co/y');
    expect(second).toEqual({ acquired: false, queued: true, active: 'co/x' });

    // Exactly one active reviewer/merge: x holds it; the queued y recorded NOTHING (one log entry).
    expect(store.activeSerialized('co/target')).toBe('co/x');
    expect(store.log).toHaveLength(1);
  });

  it('after the holder releases on landing, the next branch acquires the slot', () => {
    const store = fakeSlotStore();
    acquireMergeSlot(store, 'co/target', 'co/x');
    releaseMergeSlot(store, 'co/target', 'co/x');
    expect(store.activeSerialized('co/target')).toBeUndefined();

    const y = acquireMergeSlot(store, 'co/target', 'co/y');
    expect(y).toEqual({ acquired: true, queued: false, active: 'co/y' });
    expect(store.activeSerialized('co/target')).toBe('co/y');
  });

  it('re-acquiring by the current holder is idempotent — no second record', () => {
    const store = fakeSlotStore();
    acquireMergeSlot(store, 'co/target', 'co/x');
    const again = acquireMergeSlot(store, 'co/target', 'co/x');
    expect(again).toEqual({ acquired: true, queued: false, active: 'co/x' });
    expect(store.log).toHaveLength(1); // idempotent — did NOT toggle the slot free.
    expect(store.activeSerialized('co/target')).toBe('co/x');
  });

  it('releasing a slot you do not hold fails loud (Principle 9)', () => {
    const store = fakeSlotStore();
    acquireMergeSlot(store, 'co/target', 'co/x');
    expect(() => releaseMergeSlot(store, 'co/target', 'co/z')).toThrow(
      /does not hold the merge slot/,
    );
  });

  it('slots are independent per target', () => {
    const store = fakeSlotStore();
    acquireMergeSlot(store, 'co/t1', 'co/x');
    const y = acquireMergeSlot(store, 'co/t2', 'co/y');
    expect(y.acquired).toBe(true);
    expect(store.activeSerialized('co/t1')).toBe('co/x');
    expect(store.activeSerialized('co/t2')).toBe('co/y');
  });
});

describe('acquire / release over the real ReviewStore (event-sourced, AC-L5-7 / AC-L5-11)', () => {
  it('serializes two pending merges; the slot survives release/re-acquire durably', () => {
    const reviews = openReviewStore('p-serialize');
    reviewStores.push(reviews);

    expect(acquireMergeSlot(reviews, 'co/target', 'co/x').acquired).toBe(true);
    // A second pending merge into the same target waits — exactly one active.
    const second = acquireMergeSlot(reviews, 'co/target', 'co/y');
    expect(second).toEqual({ acquired: false, queued: true, active: 'co/x' });
    expect(reviews.activeSerialized('co/target')).toBe('co/x');

    // x lands → release → y acquires (durably persisted across calls).
    releaseMergeSlot(reviews, 'co/target', 'co/x');
    expect(reviews.activeSerialized('co/target')).toBeUndefined();
    expect(acquireMergeSlot(reviews, 'co/target', 'co/y').acquired).toBe(true);
    expect(reviews.activeSerialized('co/target')).toBe('co/y');

    // Both branches show up in the serialized list (the read-model `serialized` flag).
    expect(reviews.serializedBranches('co/target')).toEqual(['co/x', 'co/y']);
  });

  it('a second connection sees the same persisted active slot (durable, event-sourced)', () => {
    const a = openReviewStore('p-serialize-shared');
    try {
      acquireMergeSlot(a, 'co/target', 'co/x');
    } finally {
      a.close();
    }
    const b = openReviewStore('p-serialize-shared');
    try {
      expect(b.activeSerialized('co/target')).toBe('co/x');
    } finally {
      b.close();
    }
  });
});

// ── reReviewBase: the next queued branch re-reviews against the POST-LANDING ref (via refs) ──────────
describe('reReviewBase — the post-landing base resolved via refs (AC-L5-7)', () => {
  function git(repo: string, args: readonly string[]): string {
    return execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  }

  function initRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'co-serialize-repo-'));
    repoDirs.push(dir);
    git(dir, ['init', '-b', 'co/target']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'CO Test']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(dir, 'README.md'), 'base\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'chore: init']);
    return dir;
  }

  it('resolves the target to its CURRENT (post-landing) commit, not a stale sha', () => {
    const repo = initRepo();
    const before = git(repo, ['rev-parse', 'co/target']);
    expect(reReviewBase(repo, 'co/target')).toBe(before);

    // A first branch lands — the target ref ADVANCES. The next queued branch's re-review base must be
    // the NEW ref, not the stale `before` (the `co merge` worktree-drift cure).
    writeFileSync(join(repo, 'x.txt'), 'x landed\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'feat: x lands']);
    const afterLanding = git(repo, ['rev-parse', 'co/target']);

    expect(afterLanding).not.toBe(before);
    expect(reReviewBase(repo, 'co/target')).toBe(afterLanding); // post-landing ref, resolved via refs.
  });

  it('fails loud on an unresolvable ref (Principle 9 — never a fabricated sha)', () => {
    const repo = initRepo();
    expect(() => reReviewBase(repo, 'co/does-not-exist')).toThrow(/cannot resolve base ref/);
  });
});
