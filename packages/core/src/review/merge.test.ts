import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertRepoPristine } from '../config/pristine.js';
import { MAIL_ESCALATION } from '../mail/events.js';
import { openMailStore, type MailStore } from '../mail/mail-store.js';
import type { GhExec, RepoMode } from '../worktrees/repo-mode.js';
import { openWorktreeStore, type WorktreeStore } from '../worktrees/worktree-store.js';
import { openReviewStore, type ReviewStore } from './review-store.js';
import { CoReviewGate } from './merge.js';

// AC-L5-1, AC-L5-3 — the gated merge core (CoReviewGate). The merge refuses unless a PASS verdict is
// recorded + honest-verification clears it; with a clean PASS it merges in owner/offline. Gating logic
// is proven headless with a fake git; the real git enactment is proven against a temp repo.

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let repoDirs: string[] = [];
let worktreeStores: WorktreeStore[] = [];
let mailStores: MailStore[] = [];
let reviewStores: ReviewStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  repoDirs = [];
  worktreeStores = [];
  mailStores = [];
  reviewStores = [];
  const dir = mkdtempSync(join(tmpdir(), 'co-merge-data-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const w of worktreeStores) w.close();
  for (const m of mailStores) m.close();
  for (const r of reviewStores) r.close();
  for (const dir of [...dataDirs, ...repoDirs]) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
  repoDirs = [];
  worktreeStores = [];
  mailStores = [];
  reviewStores = [];
});

/** A fake GitExec recording each git invocation, so the gating is testable with no real repo. */
function recordingGitExec(): {
  calls: string[][];
  exec: (cwd: string, args: readonly string[]) => void;
} {
  const calls: string[][] = [];
  return { calls, exec: (_cwd, args) => void calls.push([...args]) };
}

const TARGET = 'co/l5-review-gate';
const BRANCH = 'co/l5-phase-a';
const FAKE_SHA = 'a'.repeat(40);
const mergeReq = {
  branch: BRANCH,
  into: TARGET,
  summary: 'land L5 phase A',
  projectId: 'p-merge',
  repoCwd: '/repo',
};

/** Seed baseline + finish with clean (all-passing) test data, and record a PASS verdict with a marker. */
function recordPass(reviews: ReviewStore, worktrees: WorktreeStore): void {
  worktrees.recordWorktreeAndBaseline(
    { branch: BRANCH, baseRef: TARGET, baseSha: FAKE_SHA, path: '/tmp/fake', parent: 'lead-1' },
    {
      branch: BRANCH,
      baseRef: TARGET,
      baseSha: FAKE_SHA,
      tests: [{ name: 'test-a', passed: true }],
    },
  );
  worktrees.recordFinish({
    branch: BRANCH,
    baseSha: FAKE_SHA,
    commitSha: 'b'.repeat(40),
    tests: [{ name: 'test-a', passed: true }],
  });
  reviews.recordVerdict({
    reviewId: 'rev-1',
    target: TARGET,
    branch: BRANCH,
    reviewer: 'rev-7',
    verdict: 'PASS',
    blockers: [],
    suggestions: [],
    verification: { commands_run: ['pnpm test'], suite_result: 'pass', baseline_compared: true },
  });
}

/** A gate wired with a fake git + a pinned mode (no real git / no remote detection). */
function fakeGate(
  reviews: ReviewStore,
  worktrees: WorktreeStore,
  mode: RepoMode,
  git = recordingGitExec(),
): { gate: CoReviewGate; git: ReturnType<typeof recordingGitExec> } {
  const gate = new CoReviewGate({
    reviews,
    worktrees,
    resolveMode: () => mode,
    gitExec: git.exec,
    headReader: () => 'c'.repeat(40),
  });
  return { gate, git };
}

describe('CoReviewGate.merge — the PASS gate (AC-L5-1)', () => {
  it('refuses a merge when NO verdict is recorded (owner mode), without touching git', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    const { gate, git } = fakeGate(reviews, worktrees, 'owner');
    expect(() => gate.merge(mergeReq)).toThrow(/no review verdict is recorded/);
    expect(git.calls).toEqual([]); // refused before any git op.
  });

  it('refuses a merge when the recorded verdict is ISSUES, without touching git', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    reviews.recordVerdict({
      reviewId: 'rev-1',
      target: TARGET,
      branch: BRANCH,
      reviewer: 'rev-7',
      verdict: 'ISSUES',
      blockers: [{ summary: 'a test regressed' }],
      suggestions: [],
    });
    const { gate, git } = fakeGate(reviews, worktrees, 'owner');
    expect(() => gate.merge(mergeReq)).toThrow(/is ISSUES \(1 blocker\(s\)\), not PASS/);
    expect(git.calls).toEqual([]);
  });

  it.each(['owner', 'offline'] as const)(
    'merges on a recorded PASS in %s mode (checkout target + --no-ff merge), referencing PASS',
    (mode) => {
      const reviews = openReviewStore('p-merge');
      reviewStores.push(reviews);
      const worktrees = openWorktreeStore('p-merge');
      worktreeStores.push(worktrees);
      recordPass(reviews, worktrees);
      const { gate, git } = fakeGate(reviews, worktrees, mode);
      const result = gate.merge(mergeReq);
      expect(result.merged).toBe(true);
      expect(result.commitSha).toBe('c'.repeat(40));
      expect(result.mode).toBe(mode);
      expect(result.commitMessage).toBe(`merge(${BRANCH}): land L5 phase A  [reviewed: PASS]`);
      expect(git.calls).toEqual([
        ['checkout', TARGET],
        ['merge', '--no-ff', '-m', result.commitMessage, BRANCH],
      ]);
    },
  );

  it('renders an optional body into the merge message', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    recordPass(reviews, worktrees);
    const { gate } = fakeGate(reviews, worktrees, 'offline');
    const result = gate.merge({ ...mergeReq, body: 'Foundational review/ module.' });
    expect(result.commitMessage).toBe(
      `merge(${BRANCH}): land L5 phase A  [reviewed: PASS]\n\nFoundational review/ module.`,
    );
  });

  it('refuses contributor mode (fork→PR publishing is Phase C), without touching git', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    recordPass(reviews, worktrees);
    const { gate, git } = fakeGate(reviews, worktrees, 'contributor');
    expect(() => gate.merge(mergeReq)).toThrow(/contributor publishing is Phase C/);
    expect(git.calls).toEqual([]);
  });

  it('gates per (target, branch): a PASS on a DIFFERENT target does not unlock this merge', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    reviews.recordVerdict({
      reviewId: 'rev-1',
      target: 'co/other-target',
      branch: BRANCH,
      reviewer: 'rev-7',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'pass', baseline_compared: true },
    });
    const { gate } = fakeGate(reviews, worktrees, 'owner');
    expect(() => gate.merge(mergeReq)).toThrow(/no review verdict is recorded/);
  });
});

describe('CoReviewGate.merge — honest-verification (AC-L5-3)', () => {
  it('refuses the merge when a regression (pass→fail) is present in the finish run', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    // Baseline: test-a passes. Finish: test-a fails (regression).
    worktrees.recordWorktreeAndBaseline(
      { branch: BRANCH, baseRef: TARGET, baseSha: FAKE_SHA, path: '/tmp/fake', parent: 'lead-1' },
      {
        branch: BRANCH,
        baseRef: TARGET,
        baseSha: FAKE_SHA,
        tests: [{ name: 'test-a', passed: true }],
      },
    );
    worktrees.recordFinish({
      branch: BRANCH,
      baseSha: FAKE_SHA,
      commitSha: 'b'.repeat(40),
      tests: [{ name: 'test-a', passed: false }], // regression: was passing
    });
    reviews.recordVerdict({
      reviewId: 'rev-1',
      target: TARGET,
      branch: BRANCH,
      reviewer: 'rev-7',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'fail', baseline_compared: true },
    });
    const { gate } = fakeGate(reviews, worktrees, 'offline');
    expect(() => gate.merge(mergeReq)).toThrow(
      /regression.*a PASS cannot sit on a non-baseline failure/,
    );
  });

  it('refuses the merge when a new failure (absent from baseline) is present', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    // Baseline: only test-a. Finish: test-a passes, test-b (new) fails.
    worktrees.recordWorktreeAndBaseline(
      { branch: BRANCH, baseRef: TARGET, baseSha: FAKE_SHA, path: '/tmp/fake', parent: 'lead-1' },
      {
        branch: BRANCH,
        baseRef: TARGET,
        baseSha: FAKE_SHA,
        tests: [{ name: 'test-a', passed: true }],
      },
    );
    worktrees.recordFinish({
      branch: BRANCH,
      baseSha: FAKE_SHA,
      commitSha: 'b'.repeat(40),
      tests: [
        { name: 'test-a', passed: true },
        { name: 'test-b', passed: false }, // new failure (absent from baseline)
      ],
    });
    reviews.recordVerdict({
      reviewId: 'rev-1',
      target: TARGET,
      branch: BRANCH,
      reviewer: 'rev-7',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'fail', baseline_compared: true },
    });
    const { gate } = fakeGate(reviews, worktrees, 'offline');
    expect(() => gate.merge(mergeReq)).toThrow(/regression/);
  });

  it('refuses the merge when the PASS carries no verification marker (PASS-without-marker)', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    // Seed clean baseline + finish, but PASS has no verification marker (recorded directly, bypassing tool).
    worktrees.recordWorktreeAndBaseline(
      { branch: BRANCH, baseRef: TARGET, baseSha: FAKE_SHA, path: '/tmp/fake', parent: 'lead-1' },
      {
        branch: BRANCH,
        baseRef: TARGET,
        baseSha: FAKE_SHA,
        tests: [{ name: 'test-a', passed: true }],
      },
    );
    worktrees.recordFinish({
      branch: BRANCH,
      baseSha: FAKE_SHA,
      commitSha: 'b'.repeat(40),
      tests: [{ name: 'test-a', passed: true }],
    });
    // Record PASS directly (bypasses tool-level check) with NO verification marker.
    reviews.recordVerdict({
      reviewId: 'rev-1',
      target: TARGET,
      branch: BRANCH,
      reviewer: 'rev-7',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
    });
    const { gate } = fakeGate(reviews, worktrees, 'offline');
    expect(() => gate.merge(mergeReq)).toThrow(/PASS-without-marker/);
  });

  it('allows a PASS over only baseline failures (fail→fail), flags result + escalates', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    const mail = openMailStore('p-merge');
    mailStores.push(mail);

    // Baseline: test-a passes, test-b fails. Finish: test-a passes, test-b still fails (fail→fail).
    worktrees.recordWorktreeAndBaseline(
      { branch: BRANCH, baseRef: TARGET, baseSha: FAKE_SHA, path: '/tmp/fake', parent: 'lead-1' },
      {
        branch: BRANCH,
        baseRef: TARGET,
        baseSha: FAKE_SHA,
        tests: [
          { name: 'test-a', passed: true },
          { name: 'test-b', passed: false },
        ],
      },
    );
    worktrees.recordFinish({
      branch: BRANCH,
      baseSha: FAKE_SHA,
      commitSha: 'b'.repeat(40),
      tests: [
        { name: 'test-a', passed: true },
        { name: 'test-b', passed: false }, // fail→fail: baseline failure (pre-existing)
      ],
    });
    reviews.recordVerdict({
      reviewId: 'rev-1',
      target: TARGET,
      branch: BRANCH,
      reviewer: 'rev-7',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'fail', baseline_compared: true },
    });

    const parentResolver = { parentOf: () => 'coordinator-1' };
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      mail,
      parentResolver,
      agentId: 'lead-1',
      resolveMode: () => 'offline',
      gitExec: recordingGitExec().exec,
      headReader: () => 'c'.repeat(40),
    });

    const result = gate.merge(mergeReq);
    // Merge proceeds but with the flag and escalation.
    expect(result.merged).toBe(true);
    expect(result.baselineFailures).toEqual(['test-b']);
    expect(result.escalated).toBe(true);

    // Exactly one escalation mail is emitted to the parent (coordinator-1).
    const inboxCoord = mail.inbox('coordinator-1');
    const escalations = inboxCoord.filter((m) => m.type === MAIL_ESCALATION);
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.subject).toContain(`baseline failure`);
    expect(escalations[0]!.subject).toContain(BRANCH);
  });

  it('does NOT escalate on a clean PASS (zero escalations to parent)', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    const mail = openMailStore('p-merge');
    mailStores.push(mail);

    recordPass(reviews, worktrees);
    const parentResolver = { parentOf: () => 'coordinator-1' };
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      mail,
      parentResolver,
      agentId: 'lead-1',
      resolveMode: () => 'offline',
      gitExec: recordingGitExec().exec,
      headReader: () => 'c'.repeat(40),
    });

    const result = gate.merge(mergeReq);
    expect(result.merged).toBe(true);
    expect(result.baselineFailures).toBeUndefined();
    expect(result.escalated).toBeUndefined();

    // Zero escalation mails — a clean PASS must not trigger spurious escalations.
    const escalations = mail.inbox('coordinator-1').filter((m) => m.type === MAIL_ESCALATION);
    expect(escalations).toHaveLength(0);
  });

  it('refuses loud when baseline is missing for a recorded PASS (Principle 9)', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    // No baseline or finish recorded — only the verdict.
    reviews.recordVerdict({
      reviewId: 'rev-1',
      target: TARGET,
      branch: BRANCH,
      reviewer: 'rev-7',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'pass', baseline_compared: true },
    });
    const { gate } = fakeGate(reviews, worktrees, 'offline');
    expect(() => gate.merge(mergeReq)).toThrow(/baseline.*record is missing/);
  });
});

describe('CoReviewGate.triggerReview — records a review request', () => {
  it('records a review.requested and returns the recorded facts', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    const { gate } = fakeGate(reviews, worktrees, 'owner');
    const res = gate.triggerReview({
      reviewId: 'rev-1',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-2',
    });
    expect(res.reviewId).toBe('rev-1');
    expect(res.requestedTs).toBeGreaterThan(0);
    expect(reviews.getReviewRequest(TARGET, BRANCH)?.requestedBy).toBe('lead-2');
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
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    recordPass(reviews, worktrees);
    const { gate } = fakeGate(reviews, worktrees, 'owner');
    // The fake git does not touch the repo; the verdict read + message render are program-data only.
    const result = assertRepoPristine(repo, () => gate.merge({ ...mergeReq, repoCwd: repo }));
    expect(result.merged).toBe(true);
    expect(existsSync(join(repo, '.co'))).toBe(false);
  });
});

// ── CoReviewGate.push — PASS gate + push enactment (AC-L5-6) ─────────────────────────────────────
describe('CoReviewGate.push — PASS gate + push enactment', () => {
  const pushReq = {
    branch: BRANCH,
    into: TARGET,
    projectId: 'p-merge',
    repoCwd: '/repo',
  };

  it('refuses a push when NO verdict is recorded (owner mode), without touching git', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    const { gate, git } = fakeGate(reviews, worktrees, 'owner');
    expect(() => gate.push(pushReq)).toThrow(/no review verdict is recorded/);
    expect(git.calls).toEqual([]);
  });

  it('refuses a push when the verdict is ISSUES, without touching git', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    reviews.recordVerdict({
      reviewId: 'rev-1',
      target: TARGET,
      branch: BRANCH,
      reviewer: 'rev-7',
      verdict: 'ISSUES',
      blockers: [{ summary: 'regression' }],
      suggestions: [],
    });
    const { gate, git } = fakeGate(reviews, worktrees, 'owner');
    expect(() => gate.push(pushReq)).toThrow(/is ISSUES/);
    expect(git.calls).toEqual([]);
  });

  it('owner mode: pushes the integration branch (into) on a recorded PASS', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    recordPass(reviews, worktrees);
    const { gate, git } = fakeGate(reviews, worktrees, 'owner');
    const result = gate.push(pushReq);
    expect(result.pushed).toBe(true);
    expect(result.mode).toBe('owner');
    expect(result.remote).toBe('origin');
    expect(git.calls).toEqual([['push', 'origin', TARGET]]);
  });

  it('contributor mode: pushes the feature branch (branch) on a recorded PASS', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    recordPass(reviews, worktrees);
    const { gate, git } = fakeGate(reviews, worktrees, 'contributor');
    const result = gate.push(pushReq);
    expect(result.pushed).toBe(true);
    expect(result.mode).toBe('contributor');
    expect(git.calls).toEqual([['push', 'origin', BRANCH]]);
  });

  it('offline mode: refuses push (push capability is false — AC-L5-6)', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    recordPass(reviews, worktrees);
    const { gate, git } = fakeGate(reviews, worktrees, 'offline');
    expect(() => gate.push(pushReq)).toThrow(/push capability is false/);
    expect(git.calls).toEqual([]);
  });
});

// ── CoReviewGate.prMerge — PASS gate + PR creation + renderPrMessage (AC-L5-6) ──────────────────
describe('CoReviewGate.prMerge — PASS gate + PR creation via renderPrMessage', () => {
  function recordingGhExec(): { calls: string[][]; exec: GhExec } {
    const calls: string[][] = [];
    return {
      calls,
      exec: (_cwd, args) => {
        calls.push([...args]);
        return 'https://fake/pr/42';
      },
    };
  }

  const prIntent = {
    why: 'Needed to land L5 Phase C.',
    whatChanged: 'Added strictness ladder + co_push / co_pr_merge.',
    verification: 'pnpm test: 838 passed.',
    conventions: 'Conventional Commits, DCO sign-off.',
  };

  const prReq = {
    branch: BRANCH,
    into: TARGET,
    title: 'feat(review): add strictness ladder + gated push/PR',
    intent: prIntent,
    projectId: 'p-merge',
    repoCwd: '/repo',
  };

  it('refuses a PR when NO verdict is recorded, without touching gh', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    const gh = recordingGhExec();
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'contributor',
      gitExec: recordingGitExec().exec,
      headReader: () => 'c'.repeat(40),
      ghExec: gh.exec,
    });
    expect(() => gate.prMerge(prReq)).toThrow(/no review verdict is recorded/);
    expect(gh.calls).toEqual([]);
  });

  it('offline mode: refuses PR (pr capability is false — AC-L5-6)', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    recordPass(reviews, worktrees);
    const gh = recordingGhExec();
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'offline',
      gitExec: recordingGitExec().exec,
      headReader: () => 'c'.repeat(40),
      ghExec: gh.exec,
    });
    expect(() => gate.prMerge(prReq)).toThrow(/PR capability is false/);
    expect(gh.calls).toEqual([]);
  });

  it('contributor mode: creates PR using renderPrMessage for the description (Principle 3)', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    recordPass(reviews, worktrees);
    const gh = recordingGhExec();
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'contributor',
      gitExec: recordingGitExec().exec,
      headReader: () => 'c'.repeat(40),
      ghExec: gh.exec,
    });
    const result = gate.prMerge(prReq);
    expect(result.prUrl).toBe('https://fake/pr/42');
    expect(result.mode).toBe('contributor');
    // The description is provider-deterministic — renderPrMessage output, never a prose blob.
    expect(result.prDescription).toContain('## Why');
    expect(result.prDescription).toContain('## What changed');
    expect(result.prDescription).toContain('## Verification');
    expect(result.prDescription).toContain('## Conventions');
    expect(result.prDescription).toContain('Needed to land L5 Phase C.');
    // gh was called with the rendered description as --body, not the raw intent fields.
    const ghCall = gh.calls[0];
    expect(ghCall).toBeDefined();
    const bodyIdx = ghCall!.indexOf('--body');
    expect(bodyIdx).toBeGreaterThanOrEqual(0);
    expect(ghCall![bodyIdx + 1]).toContain('## Why');
  });

  it('owner mode: creates PR on a recorded PASS', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    recordPass(reviews, worktrees);
    const gh = recordingGhExec();
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'owner',
      gitExec: recordingGitExec().exec,
      headReader: () => 'c'.repeat(40),
      ghExec: gh.exec,
    });
    const result = gate.prMerge(prReq);
    expect(result.prUrl).toBe('https://fake/pr/42');
    expect(result.mode).toBe('owner');
  });
});

// ── AC-L5-3 baseline-failure escalation via push + prMerge (never silent) ────────────────────────
describe('CoReviewGate.push + prMerge — baseline-failure escalation (AC-L5-3)', () => {
  /** Seed a baseline with one failing test, finish keeping it failing, record a PASS. */
  function recordBaselineFailurePass(reviews: ReviewStore, worktrees: WorktreeStore): void {
    worktrees.recordWorktreeAndBaseline(
      { branch: BRANCH, baseRef: TARGET, baseSha: FAKE_SHA, path: '/tmp/fake', parent: 'lead-1' },
      {
        branch: BRANCH,
        baseRef: TARGET,
        baseSha: FAKE_SHA,
        tests: [
          { name: 'test-a', passed: true },
          { name: 'test-b', passed: false }, // pre-existing failure in baseline
        ],
      },
    );
    worktrees.recordFinish({
      branch: BRANCH,
      baseSha: FAKE_SHA,
      commitSha: 'b'.repeat(40),
      tests: [
        { name: 'test-a', passed: true },
        { name: 'test-b', passed: false }, // fail→fail: baseline failure (pre-existing)
      ],
    });
    reviews.recordVerdict({
      reviewId: 'rev-1',
      target: TARGET,
      branch: BRANCH,
      reviewer: 'rev-7',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'fail', baseline_compared: true },
    });
  }

  it('push: allows and flags + escalates a PASS carrying baseline failures (AC-L5-3)', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    const mail = openMailStore('p-merge');
    mailStores.push(mail);

    recordBaselineFailurePass(reviews, worktrees);
    const parentResolver = { parentOf: () => 'coordinator-1' };
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      mail,
      parentResolver,
      agentId: 'lead-1',
      resolveMode: () => 'owner',
      gitExec: recordingGitExec().exec,
      headReader: () => 'c'.repeat(40),
    });
    const result = gate.push({
      branch: BRANCH,
      into: TARGET,
      projectId: 'p-merge',
      repoCwd: '/repo',
    });
    expect(result.pushed).toBe(true);
    expect(result.baselineFailures).toEqual(['test-b']);
    expect(result.escalated).toBe(true);
    const escalations = mail.inbox('coordinator-1').filter((m) => m.type === 'escalation');
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.subject).toContain('baseline failure');
  });

  it('prMerge: allows and flags + escalates a PASS carrying baseline failures (AC-L5-3)', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    const mail = openMailStore('p-merge');
    mailStores.push(mail);

    recordBaselineFailurePass(reviews, worktrees);
    const parentResolver = { parentOf: () => 'coordinator-1' };
    const ghExec: GhExec = () => 'https://fake/pr/1';
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      mail,
      parentResolver,
      agentId: 'lead-1',
      resolveMode: () => 'contributor',
      gitExec: recordingGitExec().exec,
      headReader: () => 'c'.repeat(40),
      ghExec,
    });
    const result = gate.prMerge({
      branch: BRANCH,
      into: TARGET,
      title: 'feat: land phase',
      intent: { why: 'w', whatChanged: 'wc', verification: 'v', conventions: 'c' },
      projectId: 'p-merge',
      repoCwd: '/repo',
    });
    expect(result.prUrl).toBe('https://fake/pr/1');
    expect(result.baselineFailures).toEqual(['test-b']);
    expect(result.escalated).toBe(true);
    const escalations = mail.inbox('coordinator-1').filter((m) => m.type === 'escalation');
    expect(escalations).toHaveLength(1);
  });

  it('push: does NOT escalate on a clean PASS (zero escalations to parent)', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    const mail = openMailStore('p-merge');
    mailStores.push(mail);

    recordPass(reviews, worktrees);
    const parentResolver = { parentOf: () => 'coordinator-1' };
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      mail,
      parentResolver,
      agentId: 'lead-1',
      resolveMode: () => 'owner',
      gitExec: recordingGitExec().exec,
      headReader: () => 'c'.repeat(40),
    });
    const result = gate.push({
      branch: BRANCH,
      into: TARGET,
      projectId: 'p-merge',
      repoCwd: '/repo',
    });
    expect(result.pushed).toBe(true);
    expect(result.baselineFailures).toBeUndefined();
    expect(result.escalated).toBeUndefined();
    const escalations = mail.inbox('coordinator-1').filter((m) => m.type === 'escalation');
    expect(escalations).toHaveLength(0);
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
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge-real');
    worktreeStores.push(worktrees);

    worktrees.recordWorktreeAndBaseline(
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: FAKE_SHA,
        path: '/tmp/fake',
        parent: 'lead-1',
      },
      {
        branch: 'co/feature',
        baseRef: 'main',
        baseSha: FAKE_SHA,
        tests: [{ name: 'test-a', passed: true }],
      },
    );
    worktrees.recordFinish({
      branch: 'co/feature',
      baseSha: FAKE_SHA,
      commitSha: 'b'.repeat(40),
      tests: [{ name: 'test-a', passed: true }],
    });
    reviews.recordVerdict({
      reviewId: 'rev-1',
      target: 'main',
      branch: 'co/feature',
      reviewer: 'rev-7',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'pass', baseline_compared: true },
    });
    const gate = new CoReviewGate({ reviews, worktrees, resolveMode: () => 'offline' });
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
  });

  it('refuses the real merge without a recorded PASS (no merge commit is created)', () => {
    const repo = initRepo();
    const headBefore = git(repo, ['rev-parse', 'HEAD']);
    const reviews = openReviewStore('p-merge-real');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge-real');
    worktreeStores.push(worktrees);
    const gate = new CoReviewGate({ reviews, worktrees, resolveMode: () => 'offline' });
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
  });
});
