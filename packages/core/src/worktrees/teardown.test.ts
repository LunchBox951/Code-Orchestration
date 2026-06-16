import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openProjectStore } from '../store/sqlite-store.js';
import { applyEvent, rebuildAll } from '../replay/projector.js';
import { decode } from '../replay/decode.js';
import { assertRepoPristine } from '../config/pristine.js';
import { projectDataDir } from '../store/paths.js';
import {
  makeBaselineCapturedEvent,
  makeWorktreeCreatedEvent,
  makeWorktreeRemovedEvent,
  worktreeSchemas,
  worktreeUpcasters,
  type WorktreeCreated,
} from './events.js';
import { WorktreeProjector } from './worktree-projector.js';
import {
  defaultWorktreeRealityProbe,
  openWorktreeStore,
  type RemoveWorktreeDeps,
  type SandboxFs,
  type WorktreeStore,
} from './worktree-store.js';
import { slingWorktree, worktreePathFor, type BaselineProbe } from './sling.js';
import { CleanupGateStub, type CleanupGate } from './cleanup-gate.js';

// AC-L3-5 (worktree teardown + orphan surfacing). The real `git worktree remove` runs against REAL
// temp repos (so the sandbox really disappears); the comparison / replay / pristine logic is tested
// headless with injected seams (no real git needed) — the established split in sling.test.ts.

const ORIGINAL_ENV = process.env;
let tmpDirs: string[] = [];
let stores: WorktreeStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  tmpDirs = [];
  stores = [];
  const data = mkdtempSync(join(tmpdir(), 'co-teardown-data-'));
  tmpDirs.push(data);
  process.env.CO_DATA_DIR = data;
});

afterEach(() => {
  for (const s of stores) s.close();
  process.env = ORIGINAL_ENV;
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
  stores = [];
});

function openStore(projectId: string): WorktreeStore {
  const s = openWorktreeStore(projectId);
  stores.push(s);
  return s;
}

/** A real repo with a `main` branch + one commit, no remote → base auto-detects to `main`. */
function makeMainRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-teardown-repo-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  execFileSync(
    'git',
    [
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=Test',
      'commit',
      '--allow-empty',
      '-m',
      'init',
    ],
    { cwd: dir, stdio: 'ignore' },
  );
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync(
    'git',
    ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', 'commit', '-m', 'readme'],
    { cwd: dir, stdio: 'ignore' },
  );
  return dir;
}

/** A throwaway repo-like tree (a tracked file + a `.git/HEAD`), mirroring worktree-store.test.ts. */
function makeFakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-teardown-fake-'));
  tmpDirs.push(dir);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}

const knownProbe: BaselineProbe = () => [{ name: 'suite/known', passed: true }];

const rec = (over: Partial<WorktreeCreated> = {}): WorktreeCreated => ({
  branch: 'co/feature',
  baseRef: 'main',
  baseSha: 'a'.repeat(40),
  path: '/data/worktrees/co/feature',
  parent: 'lead-7',
  ...over,
});

/** A recording fake-fs seam (so the headless paths assert what teardown touched). */
function recordingFs(
  initialExists: boolean,
): SandboxFs & { removed: string[]; exists: () => boolean } {
  const removed: string[] = [];
  return {
    removed,
    exists: () => initialExists,
    isSymlink: () => false,
    realpath: (path) => path,
    removeDir: (path: string) => {
      removed.push(path);
    },
  };
}

// ── Teardown removes the real worktree ──────────────────────────────────────────────────────────
describe('removeWorktree — teardown removes the git worktree + sandbox dir', () => {
  it('removes the sandbox (dir gone) and marks the record removed', () => {
    const repo = makeMainRepo();
    const store = openStore('p-teardown');
    const slung = slingWorktree(
      store,
      { parent: 'lead-7', branch: 'co/gone', repoCwd: repo, projectId: 'p-teardown' },
      { probe: knownProbe },
    );
    expect(existsSync(slung.worktreePath)).toBe(true);
    expect(store.getWorktree('co/gone')?.removed).toBe(false);

    const updated = store.removeWorktree('co/gone', { repoCwd: repo });

    expect(updated.removed).toBe(true);
    expect(existsSync(slung.worktreePath)).toBe(false); // the sandbox dir is gone
    expect(store.getWorktree('co/gone')?.removed).toBe(true); // the record is marked
    // git no longer tracks it as a worktree (teardown's own `.git/worktrees/…` admin update).
    const listed = execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' });
    expect(listed).not.toContain(slung.worktreePath);
  });

  it('leaves ZERO orchestration files — the whole sandbox dir is gone, state is in program-data', () => {
    const repo = makeMainRepo();
    const store = openStore('p-zero');
    const slung = slingWorktree(
      store,
      { parent: 'lead-7', branch: 'co/zero', repoCwd: repo, projectId: 'p-zero' },
      { probe: knownProbe },
    );
    store.removeWorktree('co/zero', { repoCwd: repo });
    // Nothing survives the sandbox — it held only code + gitignored essentials, never co state.
    expect(existsSync(slung.worktreePath)).toBe(false);
    // The teardown FACT lives only in program-data (the marked record), never the repo.
    expect(store.getWorktree('co/zero')?.removed).toBe(true);
    expect(existsSync(join(repo, '.co'))).toBe(false);
  });

  it('is idempotent on an already-absent sandbox (a second teardown is cleanup, not an error)', () => {
    const repo = makeMainRepo();
    const store = openStore('p-idem');
    slingWorktree(
      store,
      { parent: 'lead-7', branch: 'co/twice', repoCwd: repo, projectId: 'p-idem' },
      { probe: knownProbe },
    );
    store.removeWorktree('co/twice', { repoCwd: repo }); // dir gone after this
    // Second teardown: the dir is already absent → skip git, stay green, record stays removed.
    expect(() => store.removeWorktree('co/twice', { repoCwd: repo })).not.toThrow();
    expect(store.getWorktree('co/twice')?.removed).toBe(true);
  });

  it('prunes stale git worktree metadata when the sandbox dir was manually deleted', () => {
    const repo = makeMainRepo();
    const store = openStore('p-prune-stale');
    const slung = slingWorktree(
      store,
      { parent: 'lead-7', branch: 'co/stale', repoCwd: repo, projectId: 'p-prune-stale' },
      { probe: knownProbe },
    );
    rmSync(slung.worktreePath, { recursive: true, force: true });

    store.removeWorktree('co/stale', { repoCwd: repo });

    expect(store.getWorktree('co/stale')?.removed).toBe(true);
    const listed = execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' });
    expect(listed).not.toContain(slung.worktreePath);
  });

  it('fails loud when tearing down an unrecorded branch (Principle 9)', () => {
    const store = openStore('p-unrecorded');
    expect(() => store.removeWorktree('co/never', { repoCwd: '/irrelevant' })).toThrow(
      /no worktree recorded/i,
    );
  });

  it('prunes git when the dir is already absent, then records the teardown (headless)', () => {
    const store = openStore('p-headless');
    const path = worktreePathFor('p-headless', 'co/h');
    store.recordWorktree(rec({ branch: 'co/h', path }));
    const fs = recordingFs(false); // dir reported absent → prune stale git worktree metadata
    const calls: Array<{ cwd: string; args: readonly string[] }> = [];
    const deps: RemoveWorktreeDeps = {
      repoCwd: '/main/repo',
      gitExec: (cwd, args) => calls.push({ cwd, args }),
      fs,
    };

    const updated = store.removeWorktree('co/h', deps);

    expect(calls).toEqual([{ cwd: '/main/repo', args: ['worktree', 'prune'] }]);
    expect(fs.removed).toEqual([path]); // dir-removal still attempted (idempotent)
    expect(updated.removed).toBe(true);
  });

  it('invokes `git worktree remove` with the sandbox path when the dir exists (headless)', () => {
    const store = openStore('p-headless-exists');
    const path = worktreePathFor('p-headless-exists', 'co/e');
    store.recordWorktree(rec({ branch: 'co/e', path }));
    const fs = recordingFs(true);
    const calls: Array<{ cwd: string; args: readonly string[] }> = [];
    store.removeWorktree('co/e', {
      repoCwd: '/main/repo',
      gitExec: (cwd, args) => calls.push({ cwd, args }),
      fs,
    });
    expect(calls).toEqual([{ cwd: '/main/repo', args: ['worktree', 'remove', path] }]);
    expect(store.getWorktree('co/e')?.removed).toBe(true);
  });

  it('can force-remove a dirty sandbox for rollback paths', () => {
    const store = openStore('p-headless-force');
    const path = worktreePathFor('p-headless-force', 'co/dirty');
    store.recordWorktree(rec({ branch: 'co/dirty', path }));
    const fs = recordingFs(true);
    const calls: Array<{ cwd: string; args: readonly string[] }> = [];
    store.removeWorktree('co/dirty', {
      repoCwd: '/main/repo',
      gitExec: (cwd, args) => calls.push({ cwd, args }),
      fs,
      force: true,
    });
    expect(calls).toEqual([{ cwd: '/main/repo', args: ['worktree', 'remove', '--force', path] }]);
    expect(store.getWorktree('co/dirty')?.removed).toBe(true);
  });

  it('refuses to remove a recorded path outside this project’s program-data worktrees root', () => {
    const store = openStore('p-bounded-remove');
    store.recordWorktree(rec({ branch: 'co/unsafe', path: '/tmp/not-co-owned' }));
    const fs = recordingFs(true);
    const calls: Array<{ cwd: string; args: readonly string[] }> = [];

    expect(() =>
      store.removeWorktree('co/unsafe', {
        repoCwd: '/main/repo',
        gitExec: (cwd, args) => calls.push({ cwd, args }),
        fs,
      }),
    ).toThrow(/outside this project's worktrees root/i);

    expect(calls).toEqual([]);
    expect(fs.removed).toEqual([]);
    expect(store.getWorktree('co/unsafe')?.removed).toBe(false);
  });

  it('refuses a symlinked recorded path under the root that targets an outside worktree', () => {
    const repo = makeMainRepo();
    const projectId = 'p-symlink-remove';
    const store = openStore(projectId);
    const outsideParent = mkdtempSync(join(tmpdir(), 'co-teardown-outside-'));
    tmpDirs.push(outsideParent);
    const outsideWorktree = join(outsideParent, 'outside-worktree');
    execFileSync('git', ['worktree', 'add', '-b', 'co/outside', outsideWorktree, 'main'], {
      cwd: repo,
      stdio: 'ignore',
    });
    const symlinkPath = worktreePathFor(projectId, 'co/symlink');
    mkdirSync(dirname(symlinkPath), { recursive: true });
    symlinkSync(outsideWorktree, symlinkPath, 'dir');
    store.recordWorktree(rec({ branch: 'co/symlink', path: symlinkPath }));

    expect(() => store.removeWorktree('co/symlink', { repoCwd: repo })).toThrow(
      /symlink|outside this project's worktrees root/i,
    );

    expect(existsSync(outsideWorktree)).toBe(true);
    const listed = execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' });
    expect(listed).toContain(outsideWorktree);
    expect(store.getWorktree('co/symlink')?.removed).toBe(false);

    execFileSync('git', ['worktree', 'remove', outsideWorktree], { cwd: repo, stdio: 'ignore' });
  });

  it('refuses when the project worktrees root itself is a symlink to outside program-data', () => {
    const repo = makeMainRepo();
    const projectId = 'p-root-symlink-remove';
    const store = openStore(projectId);
    const outsideRoot = mkdtempSync(join(tmpdir(), 'co-teardown-root-outside-'));
    tmpDirs.push(outsideRoot);
    const root = join(projectDataDir(projectId), 'worktrees');
    symlinkSync(outsideRoot, root, 'dir');
    const outsideWorktree = join(outsideRoot, 'co', 'root-symlink');
    mkdirSync(dirname(outsideWorktree), { recursive: true });
    execFileSync('git', ['worktree', 'add', '-b', 'co/root-outside', outsideWorktree, 'main'], {
      cwd: repo,
      stdio: 'ignore',
    });
    const recordedPath = worktreePathFor(projectId, 'co/root-symlink');
    store.recordWorktree(rec({ branch: 'co/root-symlink', path: recordedPath }));

    expect(() => store.removeWorktree('co/root-symlink', { repoCwd: repo })).toThrow(
      /worktrees root|symlink|outside this project's worktrees root/i,
    );

    expect(existsSync(outsideWorktree)).toBe(true);
    const listed = execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' });
    expect(listed).toContain(outsideWorktree);
    expect(store.getWorktree('co/root-symlink')?.removed).toBe(false);

    execFileSync('git', ['worktree', 'remove', outsideWorktree], { cwd: repo, stdio: 'ignore' });
  });

  it('refuses a non-normalized raw path before filesystem teardown can follow a skipped symlink', () => {
    const repo = makeMainRepo();
    const projectId = 'p-raw-path-remove';
    const store = openStore(projectId);
    const outsideParent = mkdtempSync(join(tmpdir(), 'co-teardown-raw-outside-'));
    tmpDirs.push(outsideParent);
    const linkTarget = join(outsideParent, 'link-target');
    mkdirSync(linkTarget, { recursive: true });
    const outsideWorktree = join(outsideParent, 'victim');
    execFileSync('git', ['worktree', 'add', '-b', 'co/raw-outside', outsideWorktree, 'main'], {
      cwd: repo,
      stdio: 'ignore',
    });
    const linkPath = join(projectDataDir(projectId), 'worktrees', 'co', 'link');
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(linkTarget, linkPath, 'dir');
    const rawPath = `${linkPath}/../victim`;
    store.recordWorktree(rec({ branch: 'co/raw-path', path: rawPath }));
    const calls: Array<{ cwd: string; args: readonly string[] }> = [];

    expect(() =>
      store.removeWorktree('co/raw-path', {
        repoCwd: repo,
        gitExec: (cwd, args) => calls.push({ cwd, args }),
      }),
    ).toThrow(/normalized|outside this project's worktrees root|symlink/i);

    expect(calls).toEqual([]);
    expect(existsSync(outsideWorktree)).toBe(true);
    const listed = execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' });
    expect(listed).toContain(outsideWorktree);
    expect(store.getWorktree('co/raw-path')?.removed).toBe(false);

    execFileSync('git', ['worktree', 'remove', outsideWorktree], { cwd: repo, stdio: 'ignore' });
  });

  it('refuses a broken symlinked worktrees root before pruning or recording teardown', () => {
    const projectId = 'p-broken-root-remove';
    const store = openStore(projectId);
    const root = join(projectDataDir(projectId), 'worktrees');
    symlinkSync(join(tmpdir(), 'co-missing-worktrees-root'), root, 'dir');
    const path = worktreePathFor(projectId, 'co/broken-root');
    store.recordWorktree(rec({ branch: 'co/broken-root', path }));
    const calls: Array<{ cwd: string; args: readonly string[] }> = [];

    expect(() =>
      store.removeWorktree('co/broken-root', {
        repoCwd: '/main/repo',
        gitExec: (cwd, args) => calls.push({ cwd, args }),
      }),
    ).toThrow(/worktrees root|symlink/i);

    expect(calls).toEqual([]);
    expect(store.getWorktree('co/broken-root')?.removed).toBe(false);
  });

  it('refuses a broken symlinked path boundary before pruning or recording teardown', () => {
    const projectId = 'p-broken-boundary-remove';
    const store = openStore(projectId);
    const root = join(projectDataDir(projectId), 'worktrees');
    const linkPath = join(root, 'co', 'broken-link');
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync(join(tmpdir(), 'co-missing-worktree-boundary'), linkPath, 'dir');
    const path = join(linkPath, 'sandbox');
    store.recordWorktree(rec({ branch: 'co/broken-boundary', path }));
    const calls: Array<{ cwd: string; args: readonly string[] }> = [];

    expect(() =>
      store.removeWorktree('co/broken-boundary', {
        repoCwd: '/main/repo',
        gitExec: (cwd, args) => calls.push({ cwd, args }),
      }),
    ).toThrow(/boundary|symlink/i);

    expect(calls).toEqual([]);
    expect(store.getWorktree('co/broken-boundary')?.removed).toBe(false);
  });

  it('refuses a broken symlinked recorded leaf before pruning or recording teardown', () => {
    const projectId = 'p-broken-leaf-remove';
    const store = openStore(projectId);
    const path = worktreePathFor(projectId, 'co/broken-leaf');
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(join(tmpdir(), 'co-missing-worktree-leaf'), path, 'dir');
    store.recordWorktree(rec({ branch: 'co/broken-leaf', path }));
    const calls: Array<{ cwd: string; args: readonly string[] }> = [];

    expect(() =>
      store.removeWorktree('co/broken-leaf', {
        repoCwd: '/main/repo',
        gitExec: (cwd, args) => calls.push({ cwd, args }),
      }),
    ).toThrow(/boundary|symlink/i);

    expect(calls).toEqual([]);
    expect(store.getWorktree('co/broken-leaf')?.removed).toBe(false);
  });
});

// ── Orphan surfacing (recorded-vs-reality) ──────────────────────────────────────────────────────
describe('detectOrphans — surface recorded-vs-reality mismatches (surface only, do NOT act)', () => {
  it('surfaces a dangling-record and an untracked-sandbox; excludes removed records', () => {
    const store = openStore('p-orphan');
    store.recordWorktree(rec({ branch: 'co/a', path: '/sandboxes/a' }));
    store.recordWorktree(rec({ branch: 'co/b', path: '/sandboxes/b' }));

    // Reality: a exists, b's dir is gone, and an unknown sandbox c exists with no record.
    const orphans = store.detectOrphans(() => ['/sandboxes/a', '/sandboxes/c']);
    expect(orphans).toEqual([
      { branch: 'co/b', path: '/sandboxes/b', kind: 'dangling-record' },
      { path: '/sandboxes/c', kind: 'untracked-sandbox' },
    ]);
  });

  it('a torn-down (removed) record is intentionally gone — never surfaced as a dangling-record', () => {
    const store = openStore('p-orphan-removed');
    const aPath = worktreePathFor('p-orphan-removed', 'co/a');
    const bPath = worktreePathFor('p-orphan-removed', 'co/b');
    store.recordWorktree(rec({ branch: 'co/a', path: aPath }));
    store.recordWorktree(rec({ branch: 'co/b', path: bPath }));
    // Tear down b headlessly (dir already absent → idempotent).
    store.removeWorktree('co/b', {
      repoCwd: '/irrelevant',
      gitExec: () => {},
      fs: {
        exists: () => false,
        isSymlink: () => false,
        realpath: (path) => path,
        removeDir: () => {},
      },
    });
    // Reality has only a; b is removed (not dangling), so there are NO orphans.
    expect(store.detectOrphans(() => [aPath])).toEqual([]);
  });

  it('no mismatch ⇒ no orphans (records and reality agree)', () => {
    const store = openStore('p-orphan-clean');
    store.recordWorktree(rec({ branch: 'co/a', path: '/sandboxes/a' }));
    expect(store.detectOrphans(() => ['/sandboxes/a'])).toEqual([]);
  });

  it('the DEFAULT reality probe finds a real, unrecorded sandbox as untracked (end-to-end)', () => {
    const repo = makeMainRepo();
    const store = openStore('p-default-probe');
    // A recorded sandbox (matches reality → not an orphan).
    slingWorktree(
      store,
      { parent: 'lead-7', branch: 'co/recorded', repoCwd: repo, projectId: 'p-default-probe' },
      { probe: knownProbe },
    );
    // A real git worktree created under the worktrees root WITHOUT a record → untracked-sandbox.
    const manualPath = worktreePathFor('p-default-probe', 'co/manual');
    execFileSync('git', ['worktree', 'add', '-b', 'co/manual', manualPath, 'main'], {
      cwd: repo,
      stdio: 'ignore',
    });

    // The default probe (no arg) walks program-data and finds both real worktrees.
    const seen = defaultWorktreeRealityProbe('p-default-probe')();
    expect(seen).toContain(manualPath);

    const orphans = store.detectOrphans();
    expect(orphans).toEqual([{ path: manualPath, kind: 'untracked-sandbox' }]);

    execFileSync('git', ['worktree', 'remove', manualPath], { cwd: repo, stdio: 'ignore' });
  });
});

// ── AC-L0-2 preserved: the post-removal read-model replays byte-equal (brief invariant #2) ──────
describe('AC-L0-2 (L3-E) — the post-removal worktree read-model rebuilds byte-identical', () => {
  function snapshot(db: DatabaseSync): string {
    return JSON.stringify({
      worktrees: db
        .prepare(
          'SELECT branch, base_ref, base_sha, path, parent, created_ts, removed, provisioned FROM worktrees ORDER BY branch',
        )
        .all(),
      baselines: db
        .prepare(
          'SELECT branch, base_ref, base_sha, tests, captured_ts FROM baselines ORDER BY branch',
        )
        .all(),
    });
  }

  it('live fold (incl. worktree.removed) → snapshot → rebuildAll → snapshot is byte-equal', () => {
    const store = openProjectStore('p-replay-removed');
    const projectors = [new WorktreeProjector()];
    const sequence = [
      makeWorktreeCreatedEvent('p-replay-removed', rec({ branch: 'co/a', path: '/d/a' })),
      makeWorktreeCreatedEvent('p-replay-removed', rec({ branch: 'co/b', path: '/d/b' })),
      makeBaselineCapturedEvent('p-replay-removed', {
        branch: 'co/a',
        baseRef: 'main',
        baseSha: 'a'.repeat(40),
        tests: [],
      }),
      makeWorktreeRemovedEvent('p-replay-removed', { branch: 'co/a' }),
      // A re-removal of co/a (idempotent — re-asserts removed=1): the rebuild must reach the same row.
      makeWorktreeRemovedEvent('p-replay-removed', { branch: 'co/a' }),
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
      // Non-vacuous: co/a is present AND marked removed; co/b stays live.
      expect(live).toContain('"branch":"co/a"');
      expect(live).toContain('"removed":1');
      expect(live).toContain('"branch":"co/b"');
      // co/b is NOT removed (the removal is scoped to co/a only).
      const parsed = JSON.parse(live) as {
        worktrees: Array<{ branch: string; removed: number }>;
      };
      expect(parsed.worktrees.find((w) => w.branch === 'co/a')?.removed).toBe(1);
      expect(parsed.worktrees.find((w) => w.branch === 'co/b')?.removed).toBe(0);
    } finally {
      store.close();
    }
  });
});

// ── Principle 12: the record path writes only program-data, never the repo ──────────────────────
describe('AC-L3-5 — assertRepoPristine holds around the teardown record path + orphan reads', () => {
  it('removeWorktree writes nothing into the target repo (the git/fs sides faked, record path real)', () => {
    const repo = makeFakeRepo();
    const store = openStore('p-pristine');
    store.recordWorktree(rec({ branch: 'co/p', path: worktreePathFor('p-pristine', 'co/p') }));
    // Fake the git + fs sides so the ONLY real write is the `worktree.removed` append — which must
    // land in program-data, leaving the repo byte-identical (the git worktree-remove that would
    // legitimately touch `.git/worktrees/…` is faked away here so the record path is isolated).
    const result = assertRepoPristine(repo, () =>
      store.removeWorktree('co/p', {
        repoCwd: repo,
        gitExec: () => {},
        fs: {
          exists: () => true,
          isSymlink: () => false,
          realpath: (path) => path,
          removeDir: () => {},
        },
      }),
    );
    expect(result.removed).toBe(true); // the write really happened; pristine proved it skipped the repo
    expect(existsSync(join(repo, '.co'))).toBe(false);
  });

  it('the THROWING path (unrecorded branch) is also repo-pristine, original error propagates', () => {
    const repo = makeFakeRepo();
    const store = openStore('p-pristine-throw');
    expect(() =>
      assertRepoPristine(repo, () => store.removeWorktree('co/absent', { repoCwd: repo })),
    ).toThrow(/no worktree recorded/i);
    let pristineViolation = false;
    try {
      assertRepoPristine(repo, () => store.removeWorktree('co/absent', { repoCwd: repo }));
    } catch (err) {
      pristineViolation = /was modified by the wrapped operation/.test(String(err));
    }
    expect(pristineViolation).toBe(false);
    expect(existsSync(join(repo, '.co'))).toBe(false);
  });

  it('detectOrphans reads write nothing into the target repo (read-only)', () => {
    const repo = makeFakeRepo();
    const store = openStore('p-pristine-orphans');
    store.recordWorktree(rec({ branch: 'co/a', path: '/sandboxes/a' }));
    const orphans = assertRepoPristine(repo, () => store.detectOrphans(() => ['/sandboxes/c']));
    expect(orphans).toEqual([
      { branch: 'co/a', path: '/sandboxes/a', kind: 'dangling-record' },
      { path: '/sandboxes/c', kind: 'untracked-sandbox' },
    ]);
    expect(existsSync(join(repo, '.co'))).toBe(false);
  });
});

// ── The L8 cleanup-verb contract is a typed loud-failing stub (NOT built) ────────────────────────
describe('CleanupGateStub — the L8 operator cleanup verbs fail loud (Principle 9)', () => {
  it('every verb throws a typed, L8-named error — never a silent no-op', () => {
    // Typed as the interface (which declares the `branch` param the stub's `never` bodies ignore).
    const gate: CleanupGate = new CleanupGateStub();
    expect(() => gate.cleanup('co/x')).toThrow(/cleanup.*not implemented at L3.*L8 plug-point/s);
    expect(() => gate.unstick('co/x')).toThrow(/unstick.*not implemented at L3.*L8 plug-point/s);
    expect(() => gate.nuke('co/x', { confirm: true })).toThrow(
      /nuke.*not implemented at L3.*L8 plug-point/s,
    );
  });
});
