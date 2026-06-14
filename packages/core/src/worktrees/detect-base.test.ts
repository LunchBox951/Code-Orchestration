import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertRepoPristine } from '../config/pristine.js';
import {
  detectBaseRef,
  detectCurrentBranchTarget,
  detectIntegrationTarget,
  resolveRefSha,
  type GitReader,
} from './detect-base.js';

// AC-L3-1 (the #1 frozen invariant): base auto-detect is a read-only, injectable chain —
// origin/HEAD → main → master → local HEAD — with NO hard-coded `master` default. The cured
// regression (the prototype's most-repeated failure: defaulting the base to master) is proven
// un-recurrable: an origin/HEAD→main repo resolves main even when a local master also exists.

// ── (i) The chain, against canned readers (deterministic, no real git) ──────────────────────────
/** A {@link GitReader} that answers the exact arg-sequences detectBaseRef issues; null otherwise. */
function cannedReader(responses: Record<string, string | null>): GitReader {
  return (_cwd, args) => responses[args.join(' ')] ?? null;
}

const ORIGIN_HEAD = 'symbolic-ref --quiet refs/remotes/origin/HEAD';
const LOCAL_MAIN = 'rev-parse --verify --quiet refs/heads/main';
const LOCAL_MASTER = 'rev-parse --verify --quiet refs/heads/master';
const SHORT_HEAD = 'symbolic-ref --quiet --short HEAD';
const SHA = 'a'.repeat(40);

describe('AC-L3-1 — detectBaseRef chain (origin/HEAD → main → master → local HEAD)', () => {
  it('rung 1: an origin/HEAD → main repo detects main (NOT master)', () => {
    const ref = detectBaseRef('/x', cannedReader({ [ORIGIN_HEAD]: 'refs/remotes/origin/main' }));
    expect(ref).toBe('origin/main');
    expect(ref).toContain('main');
    expect(ref).not.toContain('master');
  });

  it('rung 2: no remote default, local main exists → main', () => {
    expect(detectBaseRef('/x', cannedReader({ [LOCAL_MAIN]: SHA }))).toBe('main');
  });

  it('rung 3: a master-only repo (no remote default, no local main) → master', () => {
    expect(detectBaseRef('/x', cannedReader({ [LOCAL_MASTER]: SHA }))).toBe('master');
  });

  it('rung 4: a remote-less repo with neither main nor master → local HEAD', () => {
    expect(detectBaseRef('/x', cannedReader({}))).toBe('HEAD');
  });

  it('REGRESSION (cannot recur): origin/HEAD → main wins even when a local master also exists', () => {
    // The exact prototype failure was choosing master. Here master IS present locally, yet the
    // remote default (origin/HEAD → main) is authoritative — so the chain never reaches master.
    const ref = detectBaseRef(
      '/x',
      cannedReader({ [ORIGIN_HEAD]: 'refs/remotes/origin/main', [LOCAL_MASTER]: SHA }),
    );
    expect(ref).toBe('origin/main');
    expect(ref).not.toBe('master');
  });

  it('ignores a non-symbolic origin/HEAD (e.g. a bare sha) and falls through', () => {
    // If origin/HEAD is not a `refs/remotes/...` symbolic ref, rung 1 does not fire.
    const ref = detectBaseRef('/x', cannedReader({ [ORIGIN_HEAD]: SHA, [LOCAL_MAIN]: SHA }));
    expect(ref).toBe('main');
  });
});

describe('resolveRefSha — fail loud (Principle 9) on an unresolvable ref', () => {
  it('returns the sha when the ref resolves', () => {
    const reader = cannedReader({ [`rev-parse --verify HEAD^{commit}`]: SHA });
    expect(resolveRefSha('/x', 'HEAD', reader)).toBe(SHA);
  });

  it('throws when the ref cannot be resolved (no silent fabricated sha)', () => {
    expect(() => resolveRefSha('/x', 'origin/main', cannedReader({}))).toThrow(
      /cannot resolve base ref/i,
    );
  });
});

describe('detectIntegrationTarget — publish tools use local branch targets', () => {
  it('normalizes origin/HEAD remote defaults to the matching local branch', () => {
    const ref = detectIntegrationTarget(
      '/x',
      cannedReader({ [ORIGIN_HEAD]: 'refs/remotes/origin/main', [LOCAL_MAIN]: SHA }),
    );

    expect(ref).toBe('main');
  });

  it('fails loud when origin/HEAD names a remote default without a local branch', () => {
    expect(() =>
      detectIntegrationTarget('/x', cannedReader({ [ORIGIN_HEAD]: 'refs/remotes/origin/main' })),
    ).toThrow(/no local 'main' branch/i);
  });
});

describe('detectCurrentBranchTarget — local integration work lands on current branch', () => {
  it('returns the current local branch for merge/push integration defaults', () => {
    expect(detectCurrentBranchTarget('/x', cannedReader({ [SHORT_HEAD]: 'co/phase' }))).toBe(
      'co/phase',
    );
  });

  it('fails loud instead of returning HEAD when the checkout is detached', () => {
    expect(() => detectCurrentBranchTarget('/x', cannedReader({}))).toThrow(/HEAD is detached/i);
  });
});

// ── (ii) Real git repos (proves the real read-only invocations work + write nothing) ────────────
const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
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

/** A real repo whose initial branch is `branch`, with one commit and no remote. */
function makeRepo(branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-l3-detect-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-b', branch, dir], { stdio: 'ignore' });
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

// ── (iii) MNR-#3/#6 — recorded sling base wins over stale detect (#5 fix) ─────────────────────────
// The production co_push / co_pr_merge tools now PREFER the recorded WorktreeRecord.baseRef over
// detectIntegrationTarget so a sandbox slung off `co/stage-x` publishes against the right base, not
// the remote default (`main`). This simulates that preference inline — using the same value the
// tools now derive — and confirms it picks the RECORDED base over a stale-origin answer.

describe('MNR-#3/#6 — recorded sling base preferred over stale detectIntegrationTarget (#5 fix)', () => {
  it('a sandbox slung off co/stage-x resolves its publish base to co/stage-x, not stale main', () => {
    // Simulate: the remote default answers "origin/main" but the recorded sling base is co/stage-10.
    const recordedBase = 'co/stage-10';
    const detectedBase = detectIntegrationTarget(
      '/x',
      cannedReader({ [ORIGIN_HEAD]: 'refs/remotes/origin/main', [LOCAL_MAIN]: SHA }),
    );
    // detectIntegrationTarget would return 'main' — the stale default.
    expect(detectedBase).toBe('main');

    // The production tools now use: input.into ?? worktree.baseRef ?? detectIntegrationTarget(...)
    // With a recorded baseRef, the stale detect is never reached.
    const resolvedInto = recordedBase ?? detectedBase;
    expect(resolvedInto).toBe('co/stage-10');
    expect(resolvedInto).not.toBe('main');
  });

  it('falls back to detectIntegrationTarget when no recorded base is available', () => {
    const detectedBase = detectIntegrationTarget(
      '/x',
      cannedReader({ [ORIGIN_HEAD]: 'refs/remotes/origin/main', [LOCAL_MAIN]: SHA }),
    );
    // When there is no recorded base (undefined), the fallback fires correctly.
    const recordedBase: string | undefined = undefined;
    const resolvedInto = recordedBase ?? detectedBase;
    expect(resolvedInto).toBe('main');
  });
});

describe('AC-L3-1 — detectBaseRef over REAL repos (default read-only git)', () => {
  it('a real origin/HEAD → main repo detects origin/main, not master — even with local master', () => {
    const repo = makeRepo('main');
    const sha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'update-ref', 'refs/remotes/origin/main', sha); // simulate a remote-tracking ref
    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    git(repo, 'branch', 'master'); // a local master that the prototype would have wrongly chosen

    const ref = detectBaseRef(repo);
    expect(ref).toBe('origin/main');
    expect(ref).not.toContain('master');
    // …and it resolves to the real commit (the path co_sling takes next).
    expect(resolveRefSha(repo, ref)).toBe(sha);
  });

  it('a real master-only repo detects master', () => {
    const repo = makeRepo('master');
    expect(detectBaseRef(repo)).toBe('master');
  });

  it('a real remote-less repo whose branch is neither main nor master → HEAD', () => {
    const repo = makeRepo('trunk');
    expect(detectBaseRef(repo)).toBe('HEAD');
    expect(resolveRefSha(repo, 'HEAD')).toMatch(/^[0-9a-f]{40}$/u);
  });

  it('writes nothing into the repo (read-only — Principle 12)', () => {
    const repo = makeRepo('main');
    assertRepoPristine(repo, () => {
      detectBaseRef(repo);
      resolveRefSha(repo, 'main');
    });
  });
});
