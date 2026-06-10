import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openConfigStore } from '../config/config-store.js';
import { assertRepoPristine } from '../config/pristine.js';
import {
  REPO_MODE_CONFIG_KEY,
  detectRepoMode,
  resolveRepoMode,
  repoModeCapabilities,
  detectHostConventions,
  CoRepoModeGate,
  type RemoteSignals,
  type RemoteProbe,
  type RepoMode,
  type GhExec,
} from './repo-mode.js';

// AC-L3-4 / AC-L5-1: repo modes = auto-detect (a recorded-signal table → each expected mode) +
// override-beats-detection (project-override wins, persisted per project) + the Offline push/PR-disabled
// capability + a minimal Contributor host-convention probe + the L5 enactment gate (CoRepoModeGate:
// owner/offline merge real; contributor fork→PR + the rich parse deferred). Detection is read-only over
// the repo; persistence is the config cascade (program-data), provable pristine.

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let repoDirs: string[] = [];

/** Make a fresh program-data dir, point CO_DATA_DIR at it, and track it for cleanup. */
function useDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-mode-data-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
  return dir;
}

/** A fresh empty temp dir (tracked for cleanup) used as a stand-in repo cwd. */
function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-mode-repo-'));
  repoDirs.push(dir);
  return dir;
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  repoDirs = [];
  useDataDir();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const dir of [...dataDirs, ...repoDirs]) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
  repoDirs = [];
});

/** A {@link RemoteProbe} returning a fixed recorded signals row, regardless of cwd. */
function cannedProbe(signals: RemoteSignals): RemoteProbe {
  return () => signals;
}

// ── 1) Auto-detection: the recorded-signal table → each expected mode (the D2 order) ─────────────
describe('detectRepoMode — D2 order, from a recorded signals table (AC-L3-4)', () => {
  // Each row: the recorded signals → the mode they must detect. This IS the table the AC checks.
  const table: ReadonlyArray<{ name: string; signals: RemoteSignals; expected: RepoMode }> = [
    {
      name: 'no remote → offline',
      signals: { hasRemote: false, isForkOfDifferentOwner: false, canPush: false },
      expected: 'offline',
    },
    {
      name: 'fork of a different owner → contributor',
      signals: { hasRemote: true, isForkOfDifferentOwner: true, canPush: false },
      expected: 'contributor',
    },
    {
      name: 'push access (not a different-owner fork) → owner',
      signals: { hasRemote: true, isForkOfDifferentOwner: false, canPush: true },
      expected: 'owner',
    },
    {
      name: 'remote, no fork, no push access → contributor',
      signals: { hasRemote: true, isForkOfDifferentOwner: false, canPush: false },
      expected: 'contributor',
    },
    {
      name: 'a different-owner fork wins over push access → contributor',
      signals: { hasRemote: true, isForkOfDifferentOwner: true, canPush: true },
      expected: 'contributor',
    },
    {
      name: 'no remote wins even if other signals are set → offline',
      signals: { hasRemote: false, isForkOfDifferentOwner: true, canPush: true },
      expected: 'offline',
    },
  ];

  for (const row of table) {
    it(row.name, () => {
      expect(detectRepoMode(row.signals)).toBe(row.expected);
    });
  }

  it('covers every mode at least once (the table is not vacuous)', () => {
    const modes = new Set(table.map((r) => r.expected));
    expect(modes).toEqual(new Set<RepoMode>(['owner', 'contributor', 'offline']));
  });
});

// ── 2) Resolution: override beats detection; persisted per project ───────────────────────────────
describe('resolveRepoMode — override beats detection, persisted per project (AC-L3-4)', () => {
  it('auto-detects when there is no override (falls through to the prober)', () => {
    const cfg = openConfigStore();
    try {
      // Prober says owner; no repo.mode override is set ⇒ detection wins.
      const probe = cannedProbe({ hasRemote: true, isForkOfDifferentOwner: false, canPush: true });
      expect(resolveRepoMode('p-alpha', '/x', { probe, config: cfg })).toBe('owner');
    } finally {
      cfg.close();
    }
  });

  it('a repo.mode project-override WINS over the prober', () => {
    const cfg = openConfigStore();
    try {
      cfg.setProjectOverride('p-alpha', REPO_MODE_CONFIG_KEY, 'offline');
      // Prober would detect owner, but the override pins offline.
      const probe = cannedProbe({ hasRemote: true, isForkOfDifferentOwner: false, canPush: true });
      expect(resolveRepoMode('p-alpha', '/x', { probe, config: cfg })).toBe('offline');
    } finally {
      cfg.close();
    }
  });

  it('a project-override beats a GLOBAL repo.mode (cascade precedence: project wins)', () => {
    const cfg = openConfigStore();
    try {
      cfg.setGlobal(REPO_MODE_CONFIG_KEY, 'owner');
      cfg.setProjectOverride('p-alpha', REPO_MODE_CONFIG_KEY, 'contributor');
      const probe = cannedProbe({
        hasRemote: false,
        isForkOfDifferentOwner: false,
        canPush: false,
      });
      // Project override (contributor) wins over both the global (owner) and detection (offline).
      expect(resolveRepoMode('p-alpha', '/x', { probe, config: cfg })).toBe('contributor');
    } finally {
      cfg.close();
    }
  });

  it('a global repo.mode applies to a project without its own override', () => {
    const cfg = openConfigStore();
    try {
      cfg.setGlobal(REPO_MODE_CONFIG_KEY, 'contributor');
      const probe = cannedProbe({ hasRemote: true, isForkOfDifferentOwner: false, canPush: true });
      // No project override ⇒ the global override (contributor) still beats detection (owner).
      expect(resolveRepoMode('p-beta', '/x', { probe, config: cfg })).toBe('contributor');
    } finally {
      cfg.close();
    }
  });

  it('fails loud on a malformed override instead of falling through to detection', () => {
    const cfg = openConfigStore();
    try {
      cfg.setProjectOverride('p-alpha', REPO_MODE_CONFIG_KEY, 'not-a-mode');
      const probe = cannedProbe({
        hasRemote: false,
        isForkOfDifferentOwner: false,
        canPush: false,
      });
      expect(() => resolveRepoMode('p-alpha', '/x', { probe, config: cfg })).toThrow(
        /repo\.mode.*not-a-mode.*owner.*contributor.*offline/i,
      );
    } finally {
      cfg.close();
    }
  });

  it('the override PERSISTS per project across a config-store reopen (program-data, no repo write)', () => {
    // Set the override, close the store (simulate process exit) — no repo is involved at all.
    const cfg1 = openConfigStore();
    cfg1.setProjectOverride('p-alpha', REPO_MODE_CONFIG_KEY, 'owner');
    cfg1.close();

    // A fresh store on the same on-disk program-data still resolves the pinned mode, even though the
    // prober would detect offline. Persistence is the per-project config layer — never the repo.
    const probe = cannedProbe({ hasRemote: false, isForkOfDifferentOwner: false, canPush: false });
    const cfg2 = openConfigStore();
    try {
      expect(resolveRepoMode('p-alpha', '/x', { probe, config: cfg2 })).toBe('owner');
      // A different project on the same store sees NO override ⇒ detection (offline).
      expect(resolveRepoMode('p-other', '/x', { probe, config: cfg2 })).toBe('offline');
    } finally {
      cfg2.close();
    }
  });

  it('opens its own config store when none is injected (default dependency wiring)', () => {
    // No `config` dep: resolveRepoMode opens + closes the global store itself. With an override set
    // out-of-band on the same program-data dir, the default path must read it.
    const cfg = openConfigStore();
    cfg.setProjectOverride('p-alpha', REPO_MODE_CONFIG_KEY, 'contributor');
    cfg.close();

    const probe = cannedProbe({ hasRemote: true, isForkOfDifferentOwner: false, canPush: true });
    expect(resolveRepoMode('p-alpha', '/x', { probe })).toBe('contributor');
  });
});

// ── 3) Offline disables push/PR — the tested L3 capability invariant ─────────────────────────────
describe('repoModeCapabilities — Offline disables push/PR (AC-L3-4)', () => {
  it('offline → { push: false, pr: false }', () => {
    expect(repoModeCapabilities('offline')).toEqual({ push: false, pr: false });
  });

  it('owner → push allowed (to default branch), pr allowed (optional)', () => {
    expect(repoModeCapabilities('owner')).toEqual({ push: true, pr: true });
  });

  it('contributor → push allowed (to fork), pr allowed (required)', () => {
    expect(repoModeCapabilities('contributor')).toEqual({ push: true, pr: true });
  });

  it('ONLY offline refuses push/PR (the invariant, stated as a property)', () => {
    const modes: RepoMode[] = ['owner', 'contributor', 'offline'];
    for (const mode of modes) {
      const caps = repoModeCapabilities(mode);
      const refused = !caps.push && !caps.pr;
      expect(refused).toBe(mode === 'offline');
    }
  });
});

// ── 4) Minimal Contributor host-convention detection (D3) ────────────────────────────────────────
describe('detectHostConventions — minimal PR-template + sign-off signals (D3, AC-L3-4)', () => {
  it('detects a PR template at .github/PULL_REQUEST_TEMPLATE.md', () => {
    const repo = tempRepo();
    mkdirSync(join(repo, '.github'), { recursive: true });
    writeFileSync(join(repo, '.github', 'PULL_REQUEST_TEMPLATE.md'), '## Description\n');
    expect(detectHostConventions(repo).hasPrTemplate).toBe(true);
  });

  it('detects a root-level PULL_REQUEST_TEMPLATE.md', () => {
    const repo = tempRepo();
    writeFileSync(join(repo, 'PULL_REQUEST_TEMPLATE.md'), '## Checklist\n');
    expect(detectHostConventions(repo).hasPrTemplate).toBe(true);
  });

  it('detects a sign-off requirement from a CONTRIBUTING.md mentioning Signed-off-by', () => {
    const repo = tempRepo();
    writeFileSync(
      join(repo, 'CONTRIBUTING.md'),
      'All commits must carry a `Signed-off-by` trailer (DCO).\n',
    );
    expect(detectHostConventions(repo).requiresSignOff).toBe(true);
  });

  it('reports both false for a bare repo with neither signal', () => {
    const repo = tempRepo();
    writeFileSync(join(repo, 'README.md'), '# hello\n');
    expect(detectHostConventions(repo)).toEqual({ hasPrTemplate: false, requiresSignOff: false });
  });

  it('does NOT flag a CONTRIBUTING.md that says nothing about sign-off (no rich parse, no false positive)', () => {
    const repo = tempRepo();
    writeFileSync(join(repo, 'CONTRIBUTING.md'), 'Run the tests, open a PR, be kind.\n');
    expect(detectHostConventions(repo).requiresSignOff).toBe(false);
  });

  it('is injectable for the sign-off scan (testable without a fixture tree)', () => {
    const conventions = detectHostConventions('/no/such/repo', (path) =>
      path.endsWith('CONTRIBUTING.md') ? 'Please use --signoff on every commit.' : null,
    );
    expect(conventions.requiresSignOff).toBe(true);
  });
});

// ── 5) The L5 enactment gate (CoRepoModeGate): owner+offline merge real; contributor/rich-parse deferred ─
describe('CoRepoModeGate — the L5 merge enactment (owner + offline real; the rest loud-fail)', () => {
  /** A fake GitExec that records each git invocation, so the enactment is testable with no real repo. */
  function recordingGitExec(): {
    calls: string[][];
    exec: (cwd: string, args: readonly string[]) => void;
  } {
    const calls: string[][] = [];
    return { calls, exec: (_cwd, args) => void calls.push([...args]) };
  }

  const req = {
    branch: 'co/l5-phase-a',
    into: 'co/l5-review-gate',
    message: 'merge(co/l5-phase-a): land phase A  [reviewed: PASS]',
    repoCwd: '/repo',
  };

  it.each(['owner', 'offline'] as const)(
    'enactPublish in %s mode checks out the target and --no-ff --signoff merges the reviewed branch',
    (mode) => {
      const git = recordingGitExec();
      const result = new CoRepoModeGate().enactPublish(req, mode, {
        gitExec: git.exec,
        headReader: () => 'c'.repeat(40),
      });
      expect(result).toEqual({ merged: true, commitSha: 'c'.repeat(40), mode });
      expect(git.calls).toEqual([
        ['checkout', 'co/l5-review-gate'],
        ['merge', '--no-ff', '--signoff', '-m', req.message, 'co/l5-phase-a'],
      ]);
    },
  );

  it('enactPublish in contributor mode points at the available gated push/PR path', () => {
    const git = recordingGitExec();
    expect(() =>
      new CoRepoModeGate().enactPublish(req, 'contributor', { gitExec: git.exec }),
    ).toThrow(/gated co_push \/ co_pr_merge path/);
    expect(git.calls).toEqual([]); // it refuses BEFORE touching git.
  });

  it('enactPublish rejects unsafe publish refs before invoking git', () => {
    const gate = new CoRepoModeGate();
    for (const unsafe of [
      { ...req, into: '--detach' },
      { ...req, branch: '--force' },
      { ...req, into: ':main' },
      { ...req, branch: '+co/l5-phase-a' },
      { ...req, into: 'HEAD~1' },
      { ...req, into: '@{-1}' },
      { ...req, branch: 'main..topic' },
      { ...req, into: 'HEAD' },
      { ...req, into: 'origin/main' },
      { ...req, into: 'upstream/main' },
      { ...req, into: 'refs/heads/main' },
      { ...req, branch: 'a'.repeat(40) },
    ]) {
      const git = recordingGitExec();
      expect(() => gate.enactPublish(unsafe, 'owner', { gitExec: git.exec })).toThrow(
        /safe branch name/,
      );
      expect(git.calls).toEqual([]);
    }
  });

  it('parseHostConventions throws (the rich CONTRIBUTING/PR-template parse is deferred to L9)', () => {
    // The concrete impl omits the interface's `cwd` param (TS allows it) — it always throws.
    const gate = new CoRepoModeGate();
    expect(() => gate.parseHostConventions()).toThrow(/deferred to L9/);
    expect(() => gate.parseHostConventions()).toThrow(/not implemented/);
  });
});

// ── 6) assertRepoPristine holds around detection / resolution / persistence ──────────────────────
describe('repo modes — assertRepoPristine holds (freeze #1, Principle 12)', () => {
  /** A minimal real git repo with one commit (so the default prober has something to read). */
  function initRepo(): string {
    const repo = tempRepo();
    const run = (args: string[]): void => {
      execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    };
    run(['init', '-q']);
    run(['config', 'user.email', 'test@example.com']);
    run(['config', 'user.name', 'Test']);
    writeFileSync(join(repo, 'README.md'), '# fixture\n');
    run(['add', '.']);
    run(['commit', '-q', '-m', 'init']);
    return repo;
  }

  it('detectRepoMode + repoModeCapabilities do not touch the repo', () => {
    const repo = initRepo();
    const signals: RemoteSignals = {
      hasRemote: false,
      isForkOfDifferentOwner: false,
      canPush: false,
    };
    const out = assertRepoPristine(repo, () => {
      const mode = detectRepoMode(signals);
      return repoModeCapabilities(mode);
    });
    expect(out).toEqual({ push: false, pr: false });
  });

  it('resolveRepoMode (read override + detect) does not touch the repo; persistence is program-data', () => {
    const repo = initRepo();
    const cfg = openConfigStore();
    try {
      // The persistence write (setProjectOverride) lands in program-data, NOT the repo — so the whole
      // resolve-with-override path is pristine over the repo.
      const mode = assertRepoPristine(repo, () => {
        cfg.setProjectOverride('p-alpha', REPO_MODE_CONFIG_KEY, 'contributor');
        const probe = cannedProbe({
          hasRemote: false,
          isForkOfDifferentOwner: false,
          canPush: false,
        });
        return resolveRepoMode('p-alpha', repo, { probe, config: cfg });
      });
      expect(mode).toBe('contributor');
    } finally {
      cfg.close();
    }
  });

  it('the default prober (real git ls-remote) is read-only over the repo', () => {
    const repo = initRepo();
    // The real defaultRemoteProbe runs `git ls-remote origin` + `gh` — both read-only. A repo with no
    // `origin` simply reads as no-remote; the point is the probe writes NOTHING into .git.
    const mode = assertRepoPristine(repo, () => resolveRepoMode('p-alpha', repo));
    // No remote configured ⇒ offline (no override set).
    expect(mode).toBe('offline');
  });

  it('detectHostConventions (read repo files) is read-only over the repo', () => {
    const repo = initRepo();
    mkdirSync(join(repo, '.github'), { recursive: true });
    writeFileSync(join(repo, '.github', 'PULL_REQUEST_TEMPLATE.md'), '## PR\n');
    // Note: writing the template is part of building the fixture; the pristine window wraps only the
    // read below, so the manifest is captured AFTER the fixture write.
    const conventions = assertRepoPristine(repo, () => detectHostConventions(repo));
    expect(conventions.hasPrTemplate).toBe(true);
  });

  it('the pristine guard still throws if a wrapped op DID write the repo (guard is real, not vacuous)', () => {
    const repo = initRepo();
    expect(() =>
      assertRepoPristine(repo, () => {
        // A deliberate repo write — proves the guard would catch a non-pristine detection path.
        writeFileSync(join(repo, 'STRAY.txt'), 'oops');
        return detectRepoMode({ hasRemote: false, isForkOfDifferentOwner: false, canPush: false });
      }),
    ).toThrow(/was modified/);
  });
});

// ── 7) CoRepoModeGate.enactPush — owner/contributor real; offline loud-fails (Phase C) ────────────
describe('CoRepoModeGate.enactPush — push enactment (AC-L5-6)', () => {
  function recordingGitExec(): {
    calls: string[][];
    exec: (cwd: string, args: readonly string[]) => void;
  } {
    const calls: string[][] = [];
    return { calls, exec: (_cwd, args) => void calls.push([...args]) };
  }

  const pushReq = {
    branch: 'co/l5-phase-a',
    into: 'co/l5-review-gate',
    repoCwd: '/repo',
  };

  it('owner mode: pushes the integration branch (into) to origin', () => {
    const git = recordingGitExec();
    const result = new CoRepoModeGate().enactPush(pushReq, 'owner', { gitExec: git.exec });
    expect(result).toEqual({ pushed: true, remote: 'origin', mode: 'owner' });
    expect(git.calls).toEqual([['push', 'origin', 'co/l5-review-gate']]);
  });

  it('owner mode: respects an explicit remote override', () => {
    const git = recordingGitExec();
    const result = new CoRepoModeGate().enactPush({ ...pushReq, remote: 'upstream' }, 'owner', {
      gitExec: git.exec,
    });
    expect(result.remote).toBe('upstream');
    expect(git.calls).toEqual([['push', 'upstream', 'co/l5-review-gate']]);
  });

  it('contributor mode: pushes the feature branch (branch) to origin (fork)', () => {
    const git = recordingGitExec();
    const result = new CoRepoModeGate().enactPush(pushReq, 'contributor', { gitExec: git.exec });
    expect(result).toEqual({ pushed: true, remote: 'origin', mode: 'contributor' });
    expect(git.calls).toEqual([['push', 'origin', 'co/l5-phase-a']]);
  });

  it('offline mode: refuses loud (push capability is false — AC-L5-6, Principle 9)', () => {
    const git = recordingGitExec();
    expect(() => new CoRepoModeGate().enactPush(pushReq, 'offline', { gitExec: git.exec })).toThrow(
      /push capability is false/,
    );
    expect(git.calls).toEqual([]); // refused before any git op
  });

  it('rejects leading-dash remotes and refs before invoking git', () => {
    const gate = new CoRepoModeGate();
    for (const req of [
      { ...pushReq, remote: '--force' },
      { ...pushReq, into: '--force' },
      { ...pushReq, branch: '--force' },
      { ...pushReq, into: ':main' },
      { ...pushReq, into: 'main:other' },
      { ...pushReq, branch: '+main' },
      { ...pushReq, into: 'HEAD~1' },
      { ...pushReq, into: '@{-1}' },
      { ...pushReq, branch: 'main..topic' },
      { ...pushReq, into: 'HEAD' },
      { ...pushReq, into: 'origin/main' },
      { ...pushReq, into: 'upstream/main' },
      { ...pushReq, into: 'refs/heads/main' },
      { ...pushReq, branch: 'a'.repeat(40) },
    ]) {
      const git = recordingGitExec();
      expect(() => gate.enactPush(req, 'owner', { gitExec: git.exec })).toThrow(
        /must (not start with '-'|be a safe branch name)/,
      );
      expect(git.calls).toEqual([]);
    }
  });
});

// ── 8) CoRepoModeGate.enactPrMerge — owner/contributor real; offline loud-fails (Phase C) ─────────
describe('CoRepoModeGate.enactPrMerge — PR creation enactment (AC-L5-6)', () => {
  const FAKE_PR_URL = 'https://github.com/owner/repo/pull/42';

  function recordingGhExec(url = FAKE_PR_URL): {
    calls: string[][];
    exec: GhExec;
  } {
    const calls: string[][] = [];
    return {
      calls,
      exec: (_cwd, args) => {
        calls.push([...args]);
        return url;
      },
    };
  }

  const prReq = {
    branch: 'co/l5-phase-a',
    into: 'co/l5-review-gate',
    title: 'feat: land L5 phase A',
    description: '## Why\n\nbecause\n\n## What changed\n\nstuff',
    repoCwd: '/repo',
  };

  it('owner mode: creates a PR via gh and returns the URL', () => {
    const gh = recordingGhExec();
    const result = new CoRepoModeGate().enactPrMerge(prReq, 'owner', { ghExec: gh.exec });
    expect(result).toEqual({ prUrl: FAKE_PR_URL, mode: 'owner' });
    expect(gh.calls).toHaveLength(1);
    const call = gh.calls[0]!;
    expect(call).toContain('pr');
    expect(call).toContain('create');
    expect(call).toContain('--base');
    expect(call).toContain('co/l5-review-gate');
    expect(call).toContain('--head');
    expect(call).toContain('co/l5-phase-a');
    expect(call).toContain('--title');
    expect(call).toContain('feat: land L5 phase A');
    expect(call).toContain('--body');
  });

  it('contributor mode: creates a PR via gh and returns the URL', () => {
    const gh = recordingGhExec();
    const result = new CoRepoModeGate().enactPrMerge(prReq, 'contributor', { ghExec: gh.exec });
    expect(result).toEqual({ prUrl: FAKE_PR_URL, mode: 'contributor' });
    expect(gh.calls).toHaveLength(1);
  });

  it('contributor mode: calls detectHostConventions (injectable readFile seam)', () => {
    const gh = recordingGhExec();
    let detectCalled = false;
    // readFile returning a sign-off mention: proves detectHostConventions is called with the seam.
    const readFile = (path: string): string | null => {
      detectCalled = true;
      return path.endsWith('CONTRIBUTING.md') ? 'Please Signed-off-by your commits.\n' : null;
    };
    new CoRepoModeGate().enactPrMerge(prReq, 'contributor', { ghExec: gh.exec, readFile });
    expect(detectCalled).toBe(true);
  });

  it('offline mode: refuses loud (pr capability is false — AC-L5-6, Principle 9)', () => {
    const gh = recordingGhExec();
    expect(() => new CoRepoModeGate().enactPrMerge(prReq, 'offline', { ghExec: gh.exec })).toThrow(
      /PR capability is false/,
    );
    expect(gh.calls).toEqual([]); // refused before any gh op
  });

  it('rejects unsafe PR head/base refs before invoking gh', () => {
    const gate = new CoRepoModeGate();
    for (const req of [
      { ...prReq, into: ':main' },
      { ...prReq, into: 'owner:main' },
      { ...prReq, branch: '+co/l5-phase-a' },
      { ...prReq, branch: 'HEAD~1' },
      { ...prReq, into: '@{-1}' },
      { ...prReq, branch: 'main..topic' },
      { ...prReq, into: 'HEAD' },
      { ...prReq, into: 'origin/main' },
      { ...prReq, into: 'upstream/main' },
      { ...prReq, into: 'refs/heads/main' },
      { ...prReq, branch: 'a'.repeat(40) },
    ]) {
      const gh = recordingGhExec();
      expect(() => gate.enactPrMerge(req, 'owner', { ghExec: gh.exec })).toThrow(
        /safe branch name/,
      );
      expect(gh.calls).toEqual([]);
    }
  });
});
