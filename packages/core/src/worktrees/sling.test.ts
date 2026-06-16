import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfigStore, type ConfigStore } from '../config/config-store.js';
import { IDENTITY_PERSONA_KEY } from '../permissions/identity-guard.js';
import { projectDataDir } from '../store/paths.js';
import { WORKTREE_PROVISION_CONFIG_KEY } from './provision.js';
import { openWorktreeStore, type WorktreeStore } from './worktree-store.js';
import { type GitReader } from './detect-base.js';
import {
  defaultGitExec,
  slingWorktree,
  worktreePathFor,
  type BaselineProbe,
  type GitExec,
} from './sling.js';

// AC-L3-1 (co_sling core): from the auto-detected base, create an isolated worktree+branch under
// program-data, record it, and capture a branch-off baseline — never touching the repo with
// orchestration state, with no base/parent defaults and no two-sling collision. Exercised against
// REAL git repos so the real `git worktree add` runs (the brief: do NOT wrap that in
// assertRepoPristine — git legitimately writes .git/worktrees/…; instead assert the SANDBOX is pure).

const ORIGINAL_ENV = process.env;
let tmpDirs: string[] = [];
let stores: WorktreeStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  tmpDirs = [];
  stores = [];
  const data = mkdtempSync(join(tmpdir(), 'co-sling-data-'));
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

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=Test',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  ).trim();
}

function rawGit(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function branchExists(cwd: string, branch: string): boolean {
  return git(cwd, 'branch', '--list', branch).length > 0;
}

/** A real repo with a `main` branch + one commit, no remote → base auto-detects to `main`. */
function makeMainRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-sling-repo-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

function openStore(projectId: string): WorktreeStore {
  const s = openWorktreeStore(projectId);
  stores.push(s);
  return s;
}

const knownProbe: BaselineProbe = () => [{ name: 'suite/known', passed: true }];

describe('slingWorktree — create + record from the auto-detected base', () => {
  it('slings a co/ branch from auto-detected main, records the sandbox + baseline', () => {
    const repo = makeMainRepo();
    const store = openStore('p-sling');
    const headSha = git(repo, 'rev-parse', 'HEAD');

    const result = slingWorktree(
      store,
      { parent: 'lead-7', branch: 'co/feature-x', repoCwd: repo, projectId: 'p-sling' },
      { probe: knownProbe },
    );

    expect(result.baseRef).toBe('main'); // auto-detected, NOT master
    expect(result.baseSha).toBe(headSha);
    expect(result.branch).toBe('co/feature-x');
    expect(result.baselineCaptured).toBe(true);
    expect(result.worktreePath).toBe(worktreePathFor('p-sling', 'co/feature-x'));

    // The sandbox is a real checkout of the base.
    expect(existsSync(join(result.worktreePath, 'README.md'))).toBe(true);
    expect(git(result.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('co/feature-x');

    // Recorded facts: the worktree + a readable baseline, keyed by branch.
    const recorded = store.getWorktree('co/feature-x');
    expect(recorded?.baseRef).toBe('main');
    expect(recorded?.baseSha).toBe(headSha);
    expect(recorded?.path).toBe(result.worktreePath);
    expect(store.getBaseline('co/feature-x')?.tests).toEqual([
      { name: 'suite/known', passed: true },
    ]);
  });

  it('records the EXPLICIT parent — there is no @operator default', () => {
    const repo = makeMainRepo();
    const store = openStore('p-parent');
    slingWorktree(
      store,
      { parent: 'coord-abc', branch: 'co/p', repoCwd: repo, projectId: 'p-parent' },
      { probe: knownProbe },
    );
    const recorded = store.getWorktree('co/p');
    expect(recorded?.parent).toBe('coord-abc');
    expect(recorded?.parent).not.toBe('@operator');
  });

  it('honours an explicit base override instead of auto-detecting', () => {
    const repo = makeMainRepo();
    git(repo, 'branch', 'release'); // a second local branch to branch from
    const store = openStore('p-override');
    const result = slingWorktree(
      store,
      {
        parent: 'lead-7',
        branch: 'co/from-release',
        base: 'release',
        repoCwd: repo,
        projectId: 'p-override',
      },
      { probe: knownProbe },
    );
    expect(result.baseRef).toBe('release');
  });

  it('WT-1: two parallel slings → distinct worktrees + distinct records, both recorded', () => {
    const repo = makeMainRepo();
    const store = openStore('p-two');
    const a = slingWorktree(
      store,
      { parent: 'lead-7', branch: 'co/a', repoCwd: repo, projectId: 'p-two' },
      { probe: knownProbe },
    );
    const b = slingWorktree(
      store,
      { parent: 'lead-7', branch: 'co/b', repoCwd: repo, projectId: 'p-two' },
      { probe: knownProbe },
    );

    expect(a.worktreePath).not.toBe(b.worktreePath);
    expect(existsSync(a.worktreePath)).toBe(true);
    expect(existsSync(b.worktreePath)).toBe(true);
    expect(
      store
        .listWorktrees()
        .map((w) => w.branch)
        .sort(),
    ).toEqual(['co/a', 'co/b']);
  });

  it('the slung worktree is a PURE code sandbox — no .co/ or orchestration state inside it', () => {
    const repo = makeMainRepo();
    const store = openStore('p-pure');
    const result = slingWorktree(
      store,
      { parent: 'lead-7', branch: 'co/pure', repoCwd: repo, projectId: 'p-pure' },
      { probe: knownProbe },
    );
    expect(existsSync(join(result.worktreePath, '.co'))).toBe(false);
    // Only the base repo's own content (+ git's own `.git` worktree pointer) — no co state files.
    const entries = readdirSync(result.worktreePath)
      .filter((e) => e !== '.git')
      .sort();
    expect(entries).toEqual(['README.md']);
  });

  it('the sandbox lives under program-data, never in the repo (Principle 12)', () => {
    const repo = makeMainRepo();
    const store = openStore('p-loc');
    const result = slingWorktree(
      store,
      { parent: 'lead-7', branch: 'co/loc', repoCwd: repo, projectId: 'p-loc' },
      { probe: knownProbe },
    );
    expect(result.worktreePath.startsWith(projectDataDir('p-loc'))).toBe(true);
    expect(result.worktreePath.startsWith(repo)).toBe(false);
    expect(existsSync(join(repo, '.co'))).toBe(false);
  });

  it('the default probe captures an empty baseline (bare worktree at branch-off)', () => {
    const repo = makeMainRepo();
    const store = openStore('p-default-probe');
    slingWorktree(store, {
      parent: 'lead-7',
      branch: 'co/empty',
      repoCwd: repo,
      projectId: 'p-default-probe',
    });
    expect(store.getBaseline('co/empty')?.tests).toEqual([]);
  });

  it('does not record a live worktree without its baseline when the baseline probe fails', () => {
    const repo = makeMainRepo();
    const store = openStore('p-probe-fail');
    const path = worktreePathFor('p-probe-fail', 'co/probe-fail');

    expect(() =>
      slingWorktree(
        store,
        { parent: 'lead-7', branch: 'co/probe-fail', repoCwd: repo, projectId: 'p-probe-fail' },
        {
          provisioner: () => {},
          probe: () => {
            throw new Error('probe exploded');
          },
        },
      ),
    ).toThrow(/probe exploded/);

    expect(store.getWorktree('co/probe-fail')).toBeUndefined();
    expect(store.getBaseline('co/probe-fail')).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    expect(branchExists(repo, 'co/probe-fail')).toBe(false);
  });

  it('cleans up the git worktree and branch when provisioning fails after worktree add', () => {
    const repo = makeMainRepo();
    const store = openStore('p-provision-fail');
    const path = worktreePathFor('p-provision-fail', 'co/provision-fail');

    expect(() =>
      slingWorktree(
        store,
        {
          parent: 'lead-7',
          branch: 'co/provision-fail',
          repoCwd: repo,
          projectId: 'p-provision-fail',
        },
        {
          provisioner: () => {
            throw new Error('provision exploded');
          },
          probe: knownProbe,
        },
      ),
    ).toThrow(/provision exploded/);

    expect(store.getWorktree('co/provision-fail')).toBeUndefined();
    expect(store.getBaseline('co/provision-fail')).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    expect(branchExists(repo, 'co/provision-fail')).toBe(false);
  });

  it('surfaces cleanup failures alongside the original setup failure', () => {
    const store = openStore('p-cleanup-aggregate');
    const calls: string[] = [];
    const gitExec: GitExec = (_cwd, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'branch' && args[1] === '-D') {
        throw new Error('branch cleanup failed');
      }
    };
    const gitReader: GitReader = (_cwd, args) => {
      if (args[0] === 'symbolic-ref') return null;
      return 'a'.repeat(40);
    };

    try {
      slingWorktree(
        store,
        {
          parent: 'lead-7',
          branch: 'co/cleanup-aggregate',
          repoCwd: '/fake-repo',
          projectId: 'p-cleanup-aggregate',
        },
        {
          gitReader,
          gitExec,
          provisioner: () => {
            throw new Error('provision exploded');
          },
          probe: knownProbe,
        },
      );
      throw new Error('expected slingWorktree to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect(error).toHaveProperty('message', expect.stringContaining('provision exploded'));
      expect(error).toHaveProperty('message', expect.stringContaining('branch cleanup failed'));
      expect((error as AggregateError).errors).toHaveLength(2);
    }

    expect(calls).toContain('branch -D co/cleanup-aggregate');
  });

  it('cleans up the git worktree and branch when the durable store record fails', () => {
    const repo = makeMainRepo();
    const path = worktreePathFor('p-store-fail', 'co/store-fail');
    const store = {
      recordWorktreeAndBaseline: () => {
        throw new Error('store exploded');
      },
    } as unknown as WorktreeStore;

    expect(() =>
      slingWorktree(
        store,
        {
          parent: 'lead-7',
          branch: 'co/store-fail',
          repoCwd: repo,
          projectId: 'p-store-fail',
        },
        { provisioner: () => {}, probe: knownProbe },
      ),
    ).toThrow(/store exploded/);

    expect(existsSync(path)).toBe(false);
    expect(branchExists(repo, 'co/store-fail')).toBe(false);
  });

  it('rejects a non-co/ branch and an empty parent fail-loud (Principle 9)', () => {
    const repo = makeMainRepo();
    const store = openStore('p-reject');
    expect(() =>
      slingWorktree(store, {
        parent: 'lead-7',
        branch: 'feature',
        repoCwd: repo,
        projectId: 'p-reject',
      }),
    ).toThrow(/must start with 'co\//);
    expect(() =>
      slingWorktree(store, { parent: '', branch: 'co/x', repoCwd: repo, projectId: 'p-reject' }),
    ).toThrow(/parent/i);
  });
});

describe('worktreePathFor — injective, bounded under program-data', () => {
  it('keeps branch /-segments nested (injective) and refuses traversal', () => {
    const a = worktreePathFor('p', 'co/a');
    const b = worktreePathFor('p', 'co/b');
    expect(a).not.toBe(b);
    expect(a.startsWith(join(projectDataDir('p'), 'worktrees'))).toBe(true);
    expect(() => worktreePathFor('p', 'co/../escape')).toThrow(/traversal|escape/i);
  });
});

// ---------------------------------------------------------------------------
// Persona-pinning (AC-L6a-7): worktree persona pin via fake GitExec
// ---------------------------------------------------------------------------

describe('slingWorktree — persona identity pinning (AC-L6a-7)', () => {
  let cfgStores: ConfigStore[] = [];

  afterEach(() => {
    for (const c of cfgStores) c.close();
    cfgStores = [];
  });

  function openCfg(): ConfigStore {
    const c = openConfigStore();
    cfgStores.push(c);
    return c;
  }

  /** A fake GitReader that resolves refs to a constant sha so slingWorktree can run headlessly. */
  const fakeGitReader: GitReader = (_cwd, args) => {
    const joined = args.join(' ');
    if (joined.includes('symbolic-ref')) return null;
    if (joined.includes('rev-parse') || joined.includes('main')) return 'abc123sha';
    return 'main';
  };

  /** A recording fake GitExec: captures all calls without executing real git. */
  function makeRecordingExec(): { exec: GitExec; calls: Array<[string, string[]]> } {
    const calls: Array<[string, string[]]> = [];
    const exec: GitExec = (cwd, args) => {
      calls.push([cwd, [...args]]);
    };
    return { exec, calls };
  }

  it('issues git config --worktree user.email and user.name on the sandbox when persona is configured', () => {
    const cfg = openCfg();
    cfg.setGlobal(IDENTITY_PERSONA_KEY, { name: 'Persona', email: 'persona@noreply.github.com' });
    cfg.close();
    cfgStores.pop();

    const { exec, calls } = makeRecordingExec();
    const store = openWorktreeStore('p-pin');
    stores.push(store);

    slingWorktree(
      store,
      { parent: 'lead-7', branch: 'co/pin', repoCwd: '/fake-repo', projectId: 'p-pin' },
      { gitReader: fakeGitReader, gitExec: exec, provisioner: () => {}, probe: () => [] },
    );

    // Verify that user.email and user.name were set on the SANDBOX path (not repoCwd).
    const extensionCall = calls.find(
      (c) => c[0] === '/fake-repo' && c[1].join(' ') === 'config extensions.worktreeConfig true',
    );
    const emailCall = calls.find(
      (c) => c[1][0] === 'config' && c[1][1] === '--worktree' && c[1][2] === 'user.email',
    );
    const nameCall = calls.find(
      (c) => c[1][0] === 'config' && c[1][1] === '--worktree' && c[1][2] === 'user.name',
    );

    expect(extensionCall).toBeDefined();
    expect(emailCall).toBeDefined();
    expect(emailCall![1]).toEqual([
      'config',
      '--worktree',
      'user.email',
      'persona@noreply.github.com',
    ]);
    expect(nameCall).toBeDefined();
    expect(nameCall![1]).toEqual(['config', '--worktree', 'user.name', 'Persona']);

    // The sandbox path (cwd for those calls) must NOT be the repoCwd.
    expect(emailCall![0]).not.toBe('/fake-repo');
    expect(nameCall![0]).not.toBe('/fake-repo');
    // Both must target the same worktree sandbox path.
    expect(emailCall![0]).toBe(nameCall![0]);
  });

  it('pins persona in the worktree-local config without changing the source repo user identity', () => {
    const repo = makeMainRepo();
    rawGit(repo, 'config', 'user.email', 'source@example.com');
    rawGit(repo, 'config', 'user.name', 'Source User');

    const cfg = openCfg();
    cfg.setGlobal(IDENTITY_PERSONA_KEY, { name: 'Persona', email: 'persona@noreply.github.com' });
    cfg.close();
    cfgStores.pop();

    const store = openWorktreeStore('p-real-pin');
    stores.push(store);
    const result = slingWorktree(
      store,
      { parent: 'lead-7', branch: 'co/real-pin', repoCwd: repo, projectId: 'p-real-pin' },
      { probe: () => [] },
    );

    expect(rawGit(repo, 'config', '--get', 'user.email')).toBe('source@example.com');
    expect(rawGit(repo, 'config', '--get', 'user.name')).toBe('Source User');
    expect(rawGit(repo, 'config', '--get', 'extensions.worktreeConfig')).toBe('true');
    expect(rawGit(result.worktreePath, 'config', '--worktree', '--get', 'user.email')).toBe(
      'persona@noreply.github.com',
    );
    expect(rawGit(result.worktreePath, 'config', '--worktree', '--get', 'user.name')).toBe(
      'Persona',
    );
  });

  it('cleans up the git worktree and branch when persona pinning fails after worktree add', () => {
    const repo = makeMainRepo();
    const path = worktreePathFor('p-pin-fail', 'co/pin-fail');
    const cfg = openCfg();
    cfg.setGlobal(IDENTITY_PERSONA_KEY, { name: 'Persona', email: 'persona@noreply.github.com' });
    cfg.close();
    cfgStores.pop();

    const store = openWorktreeStore('p-pin-fail');
    stores.push(store);
    const gitExec: GitExec = (cwd, args) => {
      if (args[0] === 'config' && args[1] === '--worktree' && args[2] === 'user.email') {
        throw new Error('pin exploded');
      }
      defaultGitExec(cwd, args);
    };

    expect(() =>
      slingWorktree(
        store,
        { parent: 'lead-7', branch: 'co/pin-fail', repoCwd: repo, projectId: 'p-pin-fail' },
        { gitExec, probe: () => [] },
      ),
    ).toThrow(/pin exploded/);

    expect(store.getWorktree('co/pin-fail')).toBeUndefined();
    expect(store.getBaseline('co/pin-fail')).toBeUndefined();
    expect(existsSync(path)).toBe(false);
    expect(branchExists(repo, 'co/pin-fail')).toBe(false);
  });

  it('makes NO git config calls when identity.persona is not configured', () => {
    // No config seeded.
    const { exec, calls } = makeRecordingExec();
    const store = openWorktreeStore('p-no-pin');
    stores.push(store);

    slingWorktree(
      store,
      { parent: 'lead-7', branch: 'co/no-pin', repoCwd: '/fake-repo', projectId: 'p-no-pin' },
      { gitReader: fakeGitReader, gitExec: exec, provisioner: () => {}, probe: () => [] },
    );

    const configCalls = calls.filter((c) => c[1][0] === 'config');
    expect(configCalls).toHaveLength(0);
  });

  it('validates malformed persona config before creating the worktree branch', () => {
    const cfg = openCfg();
    cfg.setGlobal(IDENTITY_PERSONA_KEY, { name: '', email: 'persona@noreply.github.com' });
    cfg.close();
    cfgStores.pop();

    const { exec, calls } = makeRecordingExec();
    const store = openWorktreeStore('p-bad-persona');
    stores.push(store);

    expect(() =>
      slingWorktree(
        store,
        {
          parent: 'lead-7',
          branch: 'co/bad-persona',
          repoCwd: '/fake-repo',
          projectId: 'p-bad-persona',
        },
        { gitReader: fakeGitReader, gitExec: exec, provisioner: () => {}, probe: () => [] },
      ),
    ).toThrow(/identity\.persona|persona/i);

    expect(calls).toHaveLength(0);
    expect(store.getWorktree('co/bad-persona')).toBeUndefined();
    expect(store.getBaseline('co/bad-persona')).toBeUndefined();
  });

  it('validates malformed provision config before creating the worktree branch', () => {
    const cfg = openCfg();
    cfg.setGlobal(WORKTREE_PROVISION_CONFIG_KEY, { node_modules: 'teleport' });
    cfg.close();
    cfgStores.pop();

    const { exec, calls } = makeRecordingExec();
    const store = openWorktreeStore('p-bad-provision');
    stores.push(store);

    expect(() =>
      slingWorktree(
        store,
        {
          parent: 'lead-7',
          branch: 'co/bad-provision',
          repoCwd: '/fake-repo',
          projectId: 'p-bad-provision',
        },
        { gitReader: fakeGitReader, gitExec: exec, probe: () => [] },
      ),
    ).toThrow(/worktree\.provision|malformed/i);

    expect(calls).toHaveLength(0);
    expect(store.getWorktree('co/bad-provision')).toBeUndefined();
    expect(store.getBaseline('co/bad-provision')).toBeUndefined();
  });
});
