import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openProjectStore } from '../store/sqlite-store.js';
import { applyEvent, rebuildAll } from '../replay/projector.js';
import { decode } from '../replay/decode.js';
import { assertRepoPristine } from '../config/pristine.js';
import {
  makeBaselineCapturedEvent,
  makeFinishRecordedEvent,
  makeWorktreeCreatedEvent,
  worktreeSchemas,
  worktreeUpcasters,
  type BaselineCaptured,
  type FinishRecorded,
  type WorktreeCreated,
} from './events.js';
import { WorktreeProjector } from './worktree-projector.js';
import { openWorktreeStore } from './worktree-store.js';

// ── Program-data dir per test (mirrors mail.test.ts / config-store.test.ts) ──────────────────────
const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let repoDirs: string[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  repoDirs = [];
  const dir = mkdtempSync(join(tmpdir(), 'co-wt-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const dir of [...dataDirs, ...repoDirs]) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
  repoDirs = [];
});

/** A throwaway repo-like tree (a tracked file + a `.git/HEAD`), mirroring mail.test.ts. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-wt-repo-'));
  repoDirs.push(dir);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}

const rec = (over: Partial<WorktreeCreated> = {}): WorktreeCreated => ({
  branch: 'co/feature',
  baseRef: 'main',
  baseSha: 'a'.repeat(40),
  path: '/data/worktrees/co/feature',
  parent: 'lead-7',
  ...over,
});

const base = (over: Partial<BaselineCaptured> = {}): BaselineCaptured => ({
  branch: 'co/feature',
  baseRef: 'main',
  baseSha: 'a'.repeat(40),
  tests: [
    { name: 'suite/a', passed: true },
    { name: 'suite/b', passed: false },
  ],
  ...over,
});

const finish = (over: Partial<FinishRecorded> = {}): FinishRecorded => ({
  branch: 'co/feature',
  baseSha: 'a'.repeat(40),
  commitSha: 'f'.repeat(40),
  tests: [
    { name: 'suite/a', passed: true },
    { name: 'suite/b', passed: true },
  ],
  ...over,
});

describe('WorktreeStore — record + read worktrees and baselines', () => {
  it('records a worktree and reads it back (per project + branch)', () => {
    const store = openWorktreeStore('p-record');
    try {
      const saved = store.recordWorktree(rec());
      expect(saved.branch).toBe('co/feature');
      expect(saved.baseRef).toBe('main');
      expect(saved.parent).toBe('lead-7');
      expect(saved.removed).toBe(false);
      expect(saved.createdTs).toBeGreaterThan(0);
      expect(store.getWorktree('co/feature')).toEqual(saved);
      expect(store.getWorktree('co/absent')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('records a baseline and reads it back, structured (per project + branch)', () => {
    const store = openWorktreeStore('p-baseline');
    try {
      const saved = store.recordBaseline(base());
      expect(saved.branch).toBe('co/feature');
      expect(saved.tests).toEqual([
        { name: 'suite/a', passed: true },
        { name: 'suite/b', passed: false },
      ]);
      expect(saved.capturedTs).toBeGreaterThan(0);
      expect(store.getBaseline('co/feature')).toEqual(saved);
      expect(store.getBaseline('co/absent')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('an empty baseline is a real, readable record (the default at branch-off)', () => {
    const store = openWorktreeStore('p-empty');
    try {
      const saved = store.recordBaseline(base({ tests: [] }));
      expect(saved.tests).toEqual([]);
      expect(store.getBaseline('co/feature')?.tests).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('lists every recorded worktree; two distinct branches → two distinct records (WT-1)', () => {
    const store = openWorktreeStore('p-list');
    try {
      store.recordWorktree(rec({ branch: 'co/a', path: '/d/a' }));
      store.recordWorktree(rec({ branch: 'co/b', path: '/d/b' }));
      const branches = store.listWorktrees().map((w) => w.branch);
      expect(branches).toEqual(['co/a', 'co/b']);
    } finally {
      store.close();
    }
  });

  it('a second connection (alongside mail) sees the same persisted records', () => {
    const a = openWorktreeStore('p-shared');
    try {
      a.recordWorktree(rec());
    } finally {
      a.close();
    }
    const b = openWorktreeStore('p-shared');
    try {
      expect(b.getWorktree('co/feature')?.parent).toBe('lead-7');
    } finally {
      b.close();
    }
  });

  it('records a finish and reads it back, structured (per project + branch)', () => {
    const store = openWorktreeStore('p-finish');
    try {
      const saved = store.recordFinish(finish());
      expect(saved.branch).toBe('co/feature');
      expect(saved.baseSha).toBe('a'.repeat(40));
      expect(saved.commitSha).toBe('f'.repeat(40));
      expect(saved.tests).toEqual([
        { name: 'suite/a', passed: true },
        { name: 'suite/b', passed: true },
      ]);
      expect(saved.recordedTs).toBeGreaterThan(0);
      expect(store.getFinish('co/feature')).toEqual(saved);
      expect(store.getFinish('co/absent')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('a re-finish UPSERTs — the read-model holds the LATEST finish for the branch', () => {
    const store = openWorktreeStore('p-refinish');
    try {
      store.recordFinish(finish({ commitSha: '1'.repeat(40) }));
      const second = store.recordFinish(
        finish({ commitSha: '2'.repeat(40), tests: [{ name: 'suite/a', passed: false }] }),
      );
      expect(store.getFinish('co/feature')).toEqual(second);
      expect(store.getFinish('co/feature')?.commitSha).toBe('2'.repeat(40));
    } finally {
      store.close();
    }
  });
});

// ── AC-L0-2 preserved: the L3 read-model replays byte-equal (the brief's invariant #3) ──────────
describe('AC-L0-2 (L3) — worktree read-model rebuilds byte-identical', () => {
  function snapshot(db: DatabaseSync): string {
    return JSON.stringify({
      worktrees: db
        .prepare(
          'SELECT branch, base_ref, base_sha, path, parent, created_ts, removed FROM worktrees ORDER BY branch',
        )
        .all(),
      baselines: db
        .prepare(
          'SELECT branch, base_ref, base_sha, tests, captured_ts FROM baselines ORDER BY branch',
        )
        .all(),
      finishes: db
        .prepare(
          'SELECT branch, base_sha, commit_sha, tests, recorded_ts FROM finishes ORDER BY branch',
        )
        .all(),
    });
  }

  it('live fold → snapshot → rebuildAll → snapshot is byte-equal (non-vacuous)', () => {
    const store = openProjectStore('p-replay');
    const projectors = [new WorktreeProjector()];
    const sequence = [
      makeWorktreeCreatedEvent('p-replay', rec({ branch: 'co/a', path: '/d/a' })),
      makeBaselineCapturedEvent('p-replay', base({ branch: 'co/a' })),
      makeWorktreeCreatedEvent(
        'p-replay',
        rec({ branch: 'co/b', path: '/d/b', parent: 'coord-1' }),
      ),
      makeBaselineCapturedEvent('p-replay', base({ branch: 'co/b', tests: [] })),
      makeFinishRecordedEvent('p-replay', finish({ branch: 'co/a', commitSha: 'a'.repeat(40) })),
      // A re-finish of co/a (UPSERT — last wins): the rebuild must reach the same final row.
      makeFinishRecordedEvent('p-replay', finish({ branch: 'co/a', commitSha: 'd'.repeat(40) })),
      makeFinishRecordedEvent('p-replay', finish({ branch: 'co/b', commitSha: 'e'.repeat(40) })),
    ];
    try {
      for (const e of sequence) {
        store.transaction((tx) => {
          const [s] = tx.append([e]);
          applyEvent(tx, decode(s!, worktreeUpcasters, worktreeSchemas), projectors);
        });
      }
      const live = store.transaction((tx) => snapshot(tx.raw as DatabaseSync));

      rebuildAll(store, projectors, (e) => decode(e, worktreeUpcasters, worktreeSchemas));
      const replayed = store.transaction((tx) => snapshot(tx.raw as DatabaseSync));

      expect(replayed).toBe(live);
      // Guard against a vacuous pass (two empty snapshots are also "equal").
      expect(live).toContain('"branch":"co/a"');
      expect(live).toContain('"parent":"coord-1"');
      expect(live).toContain('suite/a');
      // The finishes read-model is in the snapshot and reflects the LATEST finish per branch.
      expect(live).toContain('"commit_sha":"' + 'd'.repeat(40) + '"'); // co/a's re-finish won
      expect(live).not.toContain('"commit_sha":"' + 'a'.repeat(40) + '"'); // the superseded finish
      expect(live).toContain('"commit_sha":"' + 'e'.repeat(40) + '"'); // co/b's finish
    } finally {
      store.close();
    }
  });
});

// ── Principle 12: the state-recording cores write only program-data, never the repo ─────────────
describe('AC-L3-1 — assertRepoPristine holds around the state-recording cores', () => {
  it('recordWorktree + recordBaseline + recordFinish write nothing into the target repo', () => {
    const repo = makeRepo();
    const store = openWorktreeStore('p-pristine');
    try {
      assertRepoPristine(repo, () => {
        store.recordWorktree(rec());
        store.recordBaseline(base());
        store.recordFinish(finish());
      });
      // The writes really happened — pristine did not block them, it proved no repo write.
      expect(store.getWorktree('co/feature')).toBeDefined();
      expect(store.getBaseline('co/feature')).toBeDefined();
      expect(store.getFinish('co/feature')).toBeDefined();
      expect(existsSync(join(repo, '.co'))).toBe(false);
    } finally {
      store.close();
    }
  });

  it('the THROWING path is also repo-pristine (the guard re-checks on throw)', () => {
    const repo = makeRepo();
    const store = openWorktreeStore('p-throw');
    try {
      // An invalid record (empty branch) throws inside the recording core; the repo must stay
      // untouched and the ORIGINAL error must propagate (never a masked pristine violation).
      expect(() =>
        assertRepoPristine(repo, () => store.recordWorktree(rec({ branch: '' }))),
      ).toThrow();
      let pristineViolation = false;
      try {
        assertRepoPristine(repo, () => store.recordWorktree(rec({ branch: '' })));
      } catch (err) {
        pristineViolation = /was modified by the wrapped operation/.test(String(err));
      }
      expect(pristineViolation).toBe(false);
      expect(existsSync(join(repo, '.co'))).toBe(false);
    } finally {
      store.close();
    }
  });
});
