import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ConfigStore } from '../config/config-store.js';
import { assertRepoPristine } from '../config/pristine.js';
import { openDispatchStore } from '../dispatch/dispatch-store.js';
import { MAIL_ESCALATION } from '../mail/events.js';
import { openMailStore, type MailStore } from '../mail/mail-store.js';
import { openProjectStore } from '../store/sqlite-store.js';
import type { GhExec, RepoMode } from '../worktrees/repo-mode.js';
import { openWorktreeStore, type WorktreeStore } from '../worktrees/worktree-store.js';
import type { ReviewScope } from './ladder.js';
import { openReviewStore, type ReviewStore } from './review-store.js';
import { CoReviewGate, ReviewerSpawnGateStub } from './merge.js';
import { acquireMergeSlot } from './serialize.js';

/** A fake config returning a fixed effective config for any projectId (mirrors human-review.test.ts). */
function fakeConfig(overrides: Record<string, unknown> = {}): ConfigStore {
  return {
    setGlobal: () => undefined,
    setProjectOverride: () => undefined,
    resolveEffective: () => overrides,
    close: () => undefined,
  };
}

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
function recordPass(
  reviews: ReviewStore,
  worktrees: WorktreeStore,
  scope: ReviewScope = 'worker_merge',
): void {
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
    scope,
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

  it('refuses local merge in contributor mode and points at the gated push/PR path', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    recordPass(reviews, worktrees);
    const { gate, git } = fakeGate(reviews, worktrees, 'contributor');
    expect(() => gate.merge(mergeReq)).toThrow(/gated co_push \/ co_pr_merge path/);
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
      scope: 'pr_merge',
      reviewer: 'rev-7',
      verdict: 'ISSUES',
      blockers: [{ summary: 'regression' }],
      suggestions: [],
    });
    const { gate, git } = fakeGate(reviews, worktrees, 'owner');
    expect(() => gate.push(pushReq)).toThrow(/is ISSUES/);
    expect(git.calls).toEqual([]);
  });

  it('refuses a push when only a worker-scope PASS is recorded', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    recordPass(reviews, worktrees);
    const { gate, git } = fakeGate(reviews, worktrees, 'owner');
    expect(() => gate.push(pushReq)).toThrow(/pr_merge.*PASS/i);
    expect(git.calls).toEqual([]);
  });

  it('refuses a push after a new review is requested until a fresh pr_merge PASS is recorded', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    recordPass(reviews, worktrees, 'pr_merge');
    reviews.recordReviewRequested({
      reviewId: 'rev-2',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-1',
    });
    const { gate, git } = fakeGate(reviews, worktrees, 'owner');
    expect(() => gate.push(pushReq)).toThrow(/no review verdict is recorded/);
    expect(git.calls).toEqual([]);
  });

  it('owner mode: pushes the integration branch (into) on a recorded PASS', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    recordPass(reviews, worktrees, 'pr_merge');
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
    recordPass(reviews, worktrees, 'pr_merge');
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
    recordPass(reviews, worktrees, 'pr_merge');
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
    recordPass(reviews, worktrees, 'pr_merge');
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

  it('prMerge refuses a worker-scope PASS for the same target and branch', () => {
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
    expect(() => gate.prMerge(prReq)).toThrow(/pr_merge.*PASS/i);
    expect(gh.calls).toEqual([]);
  });

  it('prMerge refuses after a new review is requested until a fresh pr_merge PASS is recorded', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    recordPass(reviews, worktrees, 'pr_merge');
    reviews.recordReviewRequested({
      reviewId: 'rev-2',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-1',
    });
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

  it('contributor mode: creates PR using renderPrMessage for the description (Principle 3)', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    recordPass(reviews, worktrees, 'pr_merge');
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
    recordPass(reviews, worktrees, 'pr_merge');
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
  function recordBaselineFailurePass(
    reviews: ReviewStore,
    worktrees: WorktreeStore,
    scope: ReviewScope = 'worker_merge',
  ): void {
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
      scope,
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

    recordBaselineFailurePass(reviews, worktrees, 'pr_merge');
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

    recordBaselineFailurePass(reviews, worktrees, 'pr_merge');
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

    recordPass(reviews, worktrees, 'pr_merge');
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

// ── Audited operator override (AC-L5-6) ──────────────────────────────────────────────────────────
describe('CoReviewGate.merge — audited operator override (AC-L5-6)', () => {
  it('operator_override WITHOUT a reason is refused loud (Principle 9), before any git op', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    const { gate, git } = fakeGate(reviews, worktrees, 'owner');
    expect(() => gate.merge({ ...mergeReq, operatorOverride: true })).toThrow(
      /operator_override requires a non-empty reason/,
    );
    expect(() => gate.merge({ ...mergeReq, operatorOverride: true, reason: '   ' })).toThrow(
      /non-empty reason/,
    );
    expect(git.calls).toEqual([]);
  });

  it('operator_override WITH a reason bypasses the PASS gate, records review.override, stamps the marker', () => {
    const reviews = openReviewStore('p-merge-override');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge-override');
    worktreeStores.push(worktrees);
    // NO recorded PASS exists — the override is the explicit escape hatch around a missing verdict.
    const { gate, git } = fakeGate(reviews, worktrees, 'offline');
    const result = gate.merge({
      ...mergeReq,
      projectId: 'p-merge-override',
      operatorOverride: true,
      reason: 'hotfix: prod down',
    });
    expect(result.merged).toBe(true);
    expect(result.overridden).toBe(true);
    expect(result.overrideReason).toBe('hotfix: prod down');
    expect(result.commitMessage).toBe(
      `merge(${BRANCH}): land L5 phase A  [reviewed: override — hotfix: prod down]`,
    );
    expect(git.calls).toEqual([
      ['checkout', TARGET],
      ['merge', '--no-ff', '-m', result.commitMessage, BRANCH],
    ]);

    // The override is durably audited in the read-model (overridden flag + reason + who).
    const probe = openProjectStore('p-merge-override');
    try {
      const row = probe.transaction((tx) =>
        (tx.raw as DatabaseSync)
          .prepare(
            'SELECT overridden, override_reason, override_by FROM reviews WHERE target = ? AND branch = ?',
          )
          .get(TARGET, BRANCH),
      ) as Record<string, unknown>;
      expect(row.overridden).toBe(1);
      expect(row.override_reason).toBe('hotfix: prod down');
      expect(row.override_by).toBe('co.review-gate');
    } finally {
      probe.close();
    }
  });

  it('override still runs honest-verify FOR THE RECORD: a regression is escalated, never refused', () => {
    const reviews = openReviewStore('p-merge-ovr-reg');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge-ovr-reg');
    worktreeStores.push(worktrees);
    const mail = openMailStore('p-merge-ovr-reg');
    mailStores.push(mail);
    // baseline passes, finish regresses — a real regression a normal PASS gate would refuse.
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
      tests: [{ name: 'test-a', passed: false }],
    });
    const git = recordingGitExec();
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'owner',
      gitExec: git.exec,
      headReader: () => 'c'.repeat(40),
      mail,
      agentId: 'lead-9',
      parentResolver: { parentOf: () => 'coordinator-1' },
    });
    const result = gate.merge({
      ...mergeReq,
      projectId: 'p-merge-ovr-reg',
      operatorOverride: true,
      reason: 'accept known regression',
    });
    expect(result.merged).toBe(true); // the override proceeds DESPITE the regression.
    expect(result.overridden).toBe(true);
    expect(result.escalated).toBe(true);
    const esc = mail.inbox('coordinator-1').filter((m) => m.type === MAIL_ESCALATION);
    expect(esc).toHaveLength(1);
    expect(esc[0]!.body).toContain('test-a');
  });
});

// ── Merge-time teardown trigger ordering (AC-L5-7) ───────────────────────────────────────────────
describe('CoReviewGate.merge — merge-time teardown trigger ordering (AC-L5-7)', () => {
  it('tears the sandbox down AFTER the merge git calls (ordering proven by a shared event log)', () => {
    const reviews = openReviewStore('p-merge-td');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge-td');
    worktreeStores.push(worktrees);
    recordPass(reviews, worktrees);
    const events: string[] = [];
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'offline',
      gitExec: (_cwd, args) => void events.push(`git:${args[0]}`),
      headReader: () => 'c'.repeat(40),
      teardown: { teardown: (branch) => void events.push(`teardown:${branch}`) },
    });
    const result = gate.merge(mergeReq);
    expect(result.merged).toBe(true);
    expect(result.toreDown).toBe(true);
    // Teardown fires LAST — after the merge is recorded (never before — the review-finalize cure).
    expect(events).toEqual(['git:checkout', 'git:merge', `teardown:${BRANCH}`]);
  });

  it('a teardown FAILURE never masks the recorded merge (merged stays true; toreDown=false)', () => {
    const reviews = openReviewStore('p-merge-td-fail');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge-td-fail');
    worktreeStores.push(worktrees);
    recordPass(reviews, worktrees);
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'offline',
      gitExec: recordingGitExec().exec,
      headReader: () => 'c'.repeat(40),
      teardown: {
        teardown: () => {
          throw new Error('worktree remove failed (deleted cwd)');
        },
      },
    });
    const result = gate.merge(mergeReq);
    expect(result.merged).toBe(true);
    expect(result.toreDown).toBe(false);
  });
});

// ── Per-target serialization through the gate (AC-L5-7) ──────────────────────────────────────────
describe('CoReviewGate.merge — per-target serialization (AC-L5-7)', () => {
  it('refuses a merge while another branch holds the target slot (the second waits)', () => {
    const reviews = openReviewStore('p-merge-ser');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge-ser');
    worktreeStores.push(worktrees);
    recordPass(reviews, worktrees);
    // Another branch already holds the merge slot for TARGET (it is mid-merge / queued ahead).
    acquireMergeSlot(reviews, TARGET, 'co/other-branch');
    const { gate, git } = fakeGate(reviews, worktrees, 'offline');
    expect(() => gate.merge(mergeReq)).toThrow(/is the active reviewer\/merge/);
    expect(git.calls).toEqual([]); // serialized — refused before any git op.
  });

  it('a normal merge releases the slot so the next merge into the target can proceed', () => {
    const reviews = openReviewStore('p-merge-ser2');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge-ser2');
    worktreeStores.push(worktrees);
    recordPass(reviews, worktrees);
    const { gate } = fakeGate(reviews, worktrees, 'offline');
    gate.merge(mergeReq);
    // The slot is free again after the merge landed + the slot was released.
    expect(reviews.activeSerialized(TARGET)).toBeUndefined();
  });
});

// ── Agent reviewer placement via L4 (AC-L5-11) + the L7 spawn stub ───────────────────────────────
describe('CoReviewGate.triggerReview — agent reviewer placement (AC-L5-11)', () => {
  it('an agent review RESOLVES + RECORDS a placement.decided keyed on the scope reviewer role; never launches', () => {
    const reviews = openReviewStore('p-place');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-place');
    worktreeStores.push(worktrees);
    const dispatch = openDispatchStore('p-place');
    try {
      const gate = new CoReviewGate({
        reviews,
        worktrees,
        resolveMode: () => 'offline',
        config: fakeConfig(),
        dispatch,
        nowMs: 0,
      });
      gate.triggerReview({
        reviewId: 'rev-1',
        target: TARGET,
        branch: BRANCH,
        requestedBy: 'lead-1',
        scope: 'pr_merge',
        projectId: 'p-place',
      });
      const placements = dispatch.readPlacements();
      expect(placements).toHaveLength(1);
      expect(placements[0]!.role).toBe('reviewer:pr'); // pr_merge → reviewer:pr (default profile).
      // No usage seeded ⇒ no healthy candidate ⇒ a WAITING decision is recorded (never a launch).
      expect(placements[0]!.kind).toBe('waiting');
    } finally {
      dispatch.close();
    }
  });

  it('is deterministic — identical injected inputs ⇒ identical placement decision', () => {
    function run(projectId: string): { role: string; kind: string } {
      const reviews = openReviewStore(projectId);
      reviewStores.push(reviews);
      const worktrees = openWorktreeStore(projectId);
      worktreeStores.push(worktrees);
      const dispatch = openDispatchStore(projectId);
      try {
        const gate = new CoReviewGate({
          reviews,
          worktrees,
          resolveMode: () => 'offline',
          config: fakeConfig(),
          dispatch,
          nowMs: 1_000,
        });
        gate.triggerReview({
          reviewId: 'rev-det',
          target: TARGET,
          branch: BRANCH,
          requestedBy: 'lead-1',
          scope: 'worker_merge',
          projectId,
        });
        const p = dispatch.readPlacements()[0]!;
        return { role: p.role, kind: p.kind };
      } finally {
        dispatch.close();
      }
    }
    const a = run('p-place-det-a');
    const b = run('p-place-det-b');
    expect(a).toEqual(b);
    expect(a).toEqual({ role: 'reviewer', kind: 'waiting' });
  });

  it('reviewer_profiles config overrides the scope→reviewer-role map', () => {
    const reviews = openReviewStore('p-place-cfg');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-place-cfg');
    worktreeStores.push(worktrees);
    const dispatch = openDispatchStore('p-place-cfg');
    try {
      const config = fakeConfig({ reviewer_profiles: { pr_merge: 'reviewer:senior' } });
      const gate = new CoReviewGate({
        reviews,
        worktrees,
        resolveMode: () => 'offline',
        config,
        dispatch,
        nowMs: 0,
      });
      gate.triggerReview({
        reviewId: 'rev-cfg',
        target: TARGET,
        branch: BRANCH,
        requestedBy: 'lead-1',
        scope: 'pr_merge',
        projectId: 'p-place-cfg',
      });
      expect(dispatch.readPlacements()[0]!.role).toBe('reviewer:senior');
    } finally {
      dispatch.close();
    }
  });

  it('no dispatch store wired ⇒ no placement recorded (backward-compatible agent path)', () => {
    const reviews = openReviewStore('p-place-none');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-place-none');
    worktreeStores.push(worktrees);
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'offline',
      config: fakeConfig(),
    });
    const res = gate.triggerReview({
      reviewId: 'rev-none',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-1',
      scope: 'worker_merge',
      projectId: 'p-place-none',
    });
    expect(res.reviewId).toBe('rev-none'); // request recorded; nothing launched, nothing thrown.
  });

  it('the reviewer SPAWN is the L7 stub — it fails loud, and the gate never calls it', () => {
    // The stub (like CleanupGateStub / HumanReviewGateStub) always throws regardless of arguments —
    // it marks the L7 plug-point; L5 records the placement but never launches.
    expect(() => new ReviewerSpawnGateStub().spawn()).toThrow(/not implemented \(deferred to L7\)/);
  });
});

// ── #135 nit: the human-path mail guard fails loud (Principle 9) ─────────────────────────────────
describe('CoReviewGate.triggerReview — #135 human-path mail guard', () => {
  it('a human review requested WITHOUT a mail store fails loud and records nothing', () => {
    const reviews = openReviewStore('p-135');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-135');
    worktreeStores.push(worktrees);
    recordPass(reviews, worktrees);
    const config = fakeConfig({ 'review.worker_merge.reviewer': 'human' });
    const gate = new CoReviewGate({ reviews, worktrees, resolveMode: () => 'offline', config }); // NO mail
    expect(() =>
      gate.triggerReview({
        reviewId: 'rev-135',
        target: TARGET,
        branch: BRANCH,
        requestedBy: 'lead-1',
        scope: 'worker_merge',
        projectId: 'p-135',
      }),
    ).toThrow(/no mail store is wired/);
    expect(reviews.getReviewRequest(TARGET, BRANCH)).toBeUndefined();
    expect(reviews.getVerdict(TARGET, BRANCH)?.reviewId).toBe('rev-1');
  });
});
