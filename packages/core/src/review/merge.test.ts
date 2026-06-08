import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertRepoPristine } from '../config/pristine.js';
import type { RepoMode } from '../worktrees/repo-mode.js';
import { openReviewStore, type ReviewStore } from './review-store.js';
import { CoReviewGate } from './merge.js';

// AC-L5-1 — the gated merge core (CoReviewGate). The merge refuses unless a PASS verdict is recorded
// for the branch on the target; with a PASS it merges in owner/offline. Gating logic is proven headless
// with a fake git; the real git enactment is proven against a temp repo.

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let repoDirs: string[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  repoDirs = [];
  const dir = mkdtempSync(join(tmpdir(), 'co-merge-data-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const dir of [...dataDirs, ...repoDirs]) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
  repoDirs = [];
});

/** A fake GitExec recording each git invocation, so the gating is testable with no real repo. */
function recordingGitExec(): {
  calls: string[][];
  exec: (cwd: string, args: readonly string[]) => void;
} {
  const calls: string[][] = [];
  return { calls, exec: (_cwd, args) => void calls.push([...args]) };
}

/** A gate wired with a fake git + a pinned mode (no real git / no remote detection). */
function fakeGate(
  reviews: ReviewStore,
  mode: RepoMode,
  git = recordingGitExec(),
): { gate: CoReviewGate; git: ReturnType<typeof recordingGitExec> } {
  const gate = new CoReviewGate({
    reviews,
    resolveMode: () => mode,
    gitExec: git.exec,
    headReader: () => 'c'.repeat(40),
  });
  return { gate, git };
}

const TARGET = 'co/l5-review-gate';
const BRANCH = 'co/l5-phase-a';
const mergeReq = {
  branch: BRANCH,
  into: TARGET,
  summary: 'land L5 phase A',
  projectId: 'p-merge',
  repoCwd: '/repo',
};

function recordPass(reviews: ReviewStore): void {
  reviews.recordVerdict({
    reviewId: 'rev-1',
    target: TARGET,
    branch: BRANCH,
    reviewer: 'rev-7',
    verdict: 'PASS',
    blockers: [],
    suggestions: [],
  });
}

describe('CoReviewGate.merge — the PASS gate (AC-L5-1)', () => {
  it('refuses a merge when NO verdict is recorded (owner mode), without touching git', () => {
    const reviews = openReviewStore('p-merge');
    try {
      const { gate, git } = fakeGate(reviews, 'owner');
      expect(() => gate.merge(mergeReq)).toThrow(/no review verdict is recorded/);
      expect(git.calls).toEqual([]); // refused before any git op.
    } finally {
      reviews.close();
    }
  });

  it('refuses a merge when the recorded verdict is ISSUES, without touching git', () => {
    const reviews = openReviewStore('p-merge');
    try {
      reviews.recordVerdict({
        reviewId: 'rev-1',
        target: TARGET,
        branch: BRANCH,
        reviewer: 'rev-7',
        verdict: 'ISSUES',
        blockers: [{ summary: 'a test regressed' }],
        suggestions: [],
      });
      const { gate, git } = fakeGate(reviews, 'owner');
      expect(() => gate.merge(mergeReq)).toThrow(/is ISSUES \(1 blocker\(s\)\), not PASS/);
      expect(git.calls).toEqual([]);
    } finally {
      reviews.close();
    }
  });

  it.each(['owner', 'offline'] as const)(
    'merges on a recorded PASS in %s mode (checkout target + --no-ff merge), referencing PASS',
    (mode) => {
      const reviews = openReviewStore('p-merge');
      try {
        recordPass(reviews);
        const { gate, git } = fakeGate(reviews, mode);
        const result = gate.merge(mergeReq);
        expect(result.merged).toBe(true);
        expect(result.commitSha).toBe('c'.repeat(40));
        expect(result.mode).toBe(mode);
        expect(result.commitMessage).toBe(`merge(${BRANCH}): land L5 phase A  [reviewed: PASS]`);
        expect(git.calls).toEqual([
          ['checkout', TARGET],
          ['merge', '--no-ff', '-m', result.commitMessage, BRANCH],
        ]);
      } finally {
        reviews.close();
      }
    },
  );

  it('renders an optional body into the merge message', () => {
    const reviews = openReviewStore('p-merge');
    try {
      recordPass(reviews);
      const { gate } = fakeGate(reviews, 'offline');
      const result = gate.merge({ ...mergeReq, body: 'Foundational review/ module.' });
      expect(result.commitMessage).toBe(
        `merge(${BRANCH}): land L5 phase A  [reviewed: PASS]\n\nFoundational review/ module.`,
      );
    } finally {
      reviews.close();
    }
  });

  it('refuses contributor mode (fork→PR publishing is Phase C), without touching git', () => {
    const reviews = openReviewStore('p-merge');
    try {
      recordPass(reviews);
      const { gate, git } = fakeGate(reviews, 'contributor');
      expect(() => gate.merge(mergeReq)).toThrow(/contributor publishing is Phase C/);
      expect(git.calls).toEqual([]);
    } finally {
      reviews.close();
    }
  });

  it('gates per (target, branch): a PASS on a DIFFERENT target does not unlock this merge', () => {
    const reviews = openReviewStore('p-merge');
    try {
      reviews.recordVerdict({
        reviewId: 'rev-1',
        target: 'co/other-target',
        branch: BRANCH,
        reviewer: 'rev-7',
        verdict: 'PASS',
        blockers: [],
        suggestions: [],
      });
      const { gate } = fakeGate(reviews, 'owner');
      expect(() => gate.merge(mergeReq)).toThrow(/no review verdict is recorded/);
    } finally {
      reviews.close();
    }
  });
});

describe('CoReviewGate.triggerReview — records a review request', () => {
  it('records a review.requested and returns the recorded facts', () => {
    const reviews = openReviewStore('p-merge');
    try {
      const { gate } = fakeGate(reviews, 'owner');
      const res = gate.triggerReview({
        reviewId: 'rev-1',
        target: TARGET,
        branch: BRANCH,
        requestedBy: 'lead-2',
      });
      expect(res.reviewId).toBe('rev-1');
      expect(res.requestedTs).toBeGreaterThan(0);
      expect(reviews.getReviewRequest(TARGET, BRANCH)?.requestedBy).toBe('lead-2');
    } finally {
      reviews.close();
    }
  });
});

describe('AC-L5-1 / Principle 12 — the gated merge writes no orchestration file into the repo', () => {
  /** A throwaway repo-like tree (a tracked file + a `.git/HEAD`). */
  function makeRepoLike(): string {
    const dir = mkdtempSync(join(tmpdir(), 'co-merge-repo-'));
    repoDirs.push(dir);
    writeFileSync(join(dir, 'README.md'), 'hello\n');
    return dir;
  }

  it('a full merge cycle (fake git) leaves the repo byte-pristine — orchestration goes to program-data', () => {
    const repo = makeRepoLike();
    const reviews = openReviewStore('p-merge');
    try {
      recordPass(reviews);
      const { gate } = fakeGate(reviews, 'owner');
      // The fake git does not touch the repo; the verdict read + message render are program-data only.
      const result = assertRepoPristine(repo, () => gate.merge({ ...mergeReq, repoCwd: repo }));
      expect(result.merged).toBe(true);
      expect(existsSync(join(repo, '.co'))).toBe(false);
    } finally {
      reviews.close();
    }
  });
});

// ── Real git: the actual owner/offline merge enactment against a temp repo ───────────────────────
describe('CoReviewGate.merge — real git enactment (AC-L5-1)', () => {
  function git(repo: string, args: readonly string[]): string {
    // stderr ignored so git's "Switched to branch …" chatter does not pollute test output.
    return execFileSync('git', args, {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  }

  /** A real git repo: `main` with one commit, plus a `co/feature` branch with a second commit. */
  function initRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'co-merge-realrepo-'));
    repoDirs.push(dir);
    git(dir, ['init', '-b', 'main']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'CO Test']);
    git(dir, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(dir, 'README.md'), 'base\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'chore: init']);
    git(dir, ['checkout', '-b', 'co/feature']);
    writeFileSync(join(dir, 'feature.txt'), 'feature work\n');
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'feat: add feature']);
    git(dir, ['checkout', 'main']);
    return dir;
  }

  it('merges the reviewed branch into the target with a real --no-ff merge commit (offline)', () => {
    const repo = initRepo();
    const reviews = openReviewStore('p-merge-real');
    try {
      reviews.recordVerdict({
        reviewId: 'rev-1',
        target: 'main',
        branch: 'co/feature',
        reviewer: 'rev-7',
        verdict: 'PASS',
        blockers: [],
        suggestions: [],
      });
      const gate = new CoReviewGate({ reviews, resolveMode: () => 'offline' });
      const result = gate.merge({
        branch: 'co/feature',
        into: 'main',
        summary: 'land the feature',
        projectId: 'p-merge-real',
        repoCwd: repo,
      });

      expect(result.merged).toBe(true);
      expect(result.mode).toBe('offline');
      expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(result.commitMessage).toContain('[reviewed: PASS]');

      // The merge really landed: HEAD on main is a 2-parent merge commit carrying the rendered message,
      // and the feature file is now present on main.
      expect(git(repo, ['rev-parse', 'HEAD'])).toBe(result.commitSha);
      expect(git(repo, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ')).toHaveLength(3);
      expect(git(repo, ['log', '-1', '--format=%B'])).toContain('[reviewed: PASS]');
      expect(existsSync(join(repo, 'feature.txt'))).toBe(true);

      // Pristine (Principle 12): the merge wrote git history only — no orchestration file in the tree.
      expect(existsSync(join(repo, '.co'))).toBe(false);
      expect(git(repo, ['status', '--porcelain'])).toBe('');
    } finally {
      reviews.close();
    }
  });

  it('refuses the real merge without a recorded PASS (no merge commit is created)', () => {
    const repo = initRepo();
    const headBefore = git(repo, ['rev-parse', 'HEAD']);
    const reviews = openReviewStore('p-merge-real');
    try {
      const gate = new CoReviewGate({ reviews, resolveMode: () => 'offline' });
      expect(() =>
        gate.merge({
          branch: 'co/feature',
          into: 'main',
          summary: 'land the feature',
          projectId: 'p-merge-real',
          repoCwd: repo,
        }),
      ).toThrow(/no review verdict is recorded/);
      // HEAD is unchanged — the gate refused before any git op.
      expect(git(repo, ['rev-parse', 'HEAD'])).toBe(headBefore);
    } finally {
      reviews.close();
    }
  });
});
