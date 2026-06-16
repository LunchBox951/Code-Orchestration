import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ConfigStore } from '../config/config-store.js';
import { assertRepoPristine } from '../config/pristine.js';
import { openDispatchStore, type DispatchStore } from '../dispatch/dispatch-store.js';
import { accountForProvider } from '../dispatch/provider-source.js';
import { MAIL_ESCALATION, MAIL_REVIEW_REQUEST, OPERATOR } from '../mail/events.js';
import { openMailStore, type MailStore } from '../mail/mail-store.js';
import { openProjectStore } from '../store/sqlite-store.js';
import type { GhExec, RepoMode } from '../worktrees/repo-mode.js';
import { openWorktreeStore, type WorktreeStore } from '../worktrees/worktree-store.js';
import type { ReviewScope } from './ladder.js';
import { openReviewStore, type ReviewStore } from './review-store.js';
import { ensureReviewTables } from './review-projector.js';
import { CoReviewGate, ReviewerSpawnGateStub } from './merge.js';
import { acquireMergeSlot, releaseMergeSlot } from './serialize.js';

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
    agentId: OPERATOR,
  });
  return { gate, git };
}

function throwingSendMail(real: MailStore): MailStore {
  return {
    ...real,
    send: () => {
      throw new Error('mail send failed');
    },
    requestHumanReview: () => {
      throw new Error('mail send failed');
    },
  };
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
        ['merge', '--no-ff', '--signoff', '-m', result.commitMessage, BRANCH],
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

    const retry = gate.merge(mergeReq);
    expect(retry.merged).toBe(true);
    expect(mail.inbox('coordinator-1').filter((m) => m.type === MAIL_ESCALATION)).toHaveLength(1);
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

  it('duplicate triggerReview with the same reviewId does not erase an existing verdict', () => {
    const reviews = openReviewStore('p-trigger-duplicate-request');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-trigger-duplicate-request');
    worktreeStores.push(worktrees);
    const { gate } = fakeGate(reviews, worktrees, 'owner');
    gate.triggerReview({
      reviewId: 'rev-dup',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-2',
    });
    reviews.recordVerdict({
      reviewId: 'rev-dup',
      target: TARGET,
      branch: BRANCH,
      reviewer: 'rev-7',
      verdict: 'ISSUES',
      blockers: [{ summary: 'still broken' }],
      suggestions: [],
    });

    gate.triggerReview({
      reviewId: 'rev-dup',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-2',
    });

    expect(reviews.getVerdict(TARGET, BRANCH)?.verdict).toBe('ISSUES');
  });

  it('serializes review requests for the same target before merge time', () => {
    const reviews = openReviewStore('p-trigger-serializes-requests');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-trigger-serializes-requests');
    worktreeStores.push(worktrees);
    const { gate } = fakeGate(reviews, worktrees, 'owner');

    gate.triggerReview({
      reviewId: 'rev-serial-a',
      target: TARGET,
      branch: 'co/a',
      requestedBy: 'lead-2',
    });

    expect(() =>
      gate.triggerReview({
        reviewId: 'rev-serial-b',
        target: TARGET,
        branch: 'co/b',
        requestedBy: 'lead-2',
      }),
    ).toThrow(/active reviewer\/merge/i);
    expect(reviews.getReviewRequest(TARGET, 'co/b')).toBeUndefined();
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
    expect(reviews.serializedBranches(TARGET)).toContain(BRANCH);
    expect(reviews.activeSerialized(TARGET)).toBeUndefined();
  });

  it('refuses a push while another branch holds the target slot', () => {
    const reviews = openReviewStore('p-push-active-other');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-push-active-other');
    worktreeStores.push(worktrees);
    recordPass(reviews, worktrees, 'pr_merge');
    acquireMergeSlot(reviews, TARGET, 'co/other-branch');
    const { gate, git } = fakeGate(reviews, worktrees, 'owner');

    expect(() => gate.push(pushReq)).toThrow(/active reviewer\/merge/);
    expect(git.calls).toEqual([]);
  });

  it('releases a freshly acquired branch slot when push enactment fails', () => {
    const reviews = openReviewStore('p-push-fresh-fail-release');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-push-fresh-fail-release');
    worktreeStores.push(worktrees);
    recordPass(reviews, worktrees, 'pr_merge');
    const { gate } = fakeGate(reviews, worktrees, 'offline');

    expect(() => gate.push(pushReq)).toThrow(/push capability is false/);
    expect(reviews.activeSerialized(TARGET)).toBeUndefined();
  });

  it('preserves a pre-held same-branch slot when push enactment fails', () => {
    const reviews = openReviewStore('p-push-fail-preserve-nonfresh');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-push-fail-preserve-nonfresh');
    worktreeStores.push(worktrees);
    recordPass(reviews, worktrees, 'pr_merge');
    acquireMergeSlot(reviews, TARGET, BRANCH);
    const { gate } = fakeGate(reviews, worktrees, 'offline');

    expect(() => gate.push(pushReq)).toThrow(/push capability is false/);
    expect(reviews.activeSerialized(TARGET)).toBe(BRANCH);
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

  it('contributor mode: holds serialization from push until PR creation', () => {
    const reviews = openReviewStore('p-contributor-push-pr-slot');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-contributor-push-pr-slot');
    worktreeStores.push(worktrees);
    recordPass(reviews, worktrees, 'pr_merge');
    const git = recordingGitExec();
    const ghCalls: string[][] = [];
    const ghExec: GhExec = (_cwd, args) => {
      ghCalls.push([...args]);
      return 'https://fake/pr/42';
    };
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'contributor',
      gitExec: git.exec,
      headReader: () => 'c'.repeat(40),
      ghExec,
    });

    expect(gate.push(pushReq).pushed).toBe(true);
    expect(reviews.activeSerialized(TARGET)).toBe(BRANCH);
    expect(acquireMergeSlot(reviews, TARGET, 'co/other-branch')).toEqual({
      acquired: false,
      queued: true,
      active: BRANCH,
      fresh: false,
    });

    expect(
      gate.prMerge({
        branch: BRANCH,
        into: TARGET,
        title: 'feat(review): add strictness ladder + gated push/PR',
        intent: {
          why: 'Needed to land L5 Phase C.',
          whatChanged: 'Added gated push/PR.',
          verification: 'pnpm test',
          conventions: 'Principle 3 provider-deterministic PR message.',
        },
        projectId: 'p-contributor-push-pr-slot',
        repoCwd: '/repo',
      }).prUrl,
    ).toBe('https://fake/pr/42');
    expect(reviews.activeSerialized(TARGET)).toBeUndefined();
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

  it('operator override is durably audited before push enactment fails', () => {
    const projectId = 'p-push-override-fail';
    const reviews = openReviewStore(projectId);
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore(projectId);
    worktreeStores.push(worktrees);
    const { gate } = fakeGate(reviews, worktrees, 'offline');

    expect(() =>
      gate.push({
        ...pushReq,
        projectId,
        operatorOverride: true,
        reason: 'manual emergency publish',
      }),
    ).toThrow(/push capability is false/);

    const probe = openProjectStore(projectId);
    try {
      const row = probe.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureReviewTables(db);
        return db
          .prepare(
            'SELECT overridden, override_reason, override_by FROM reviews WHERE target = ? AND branch = ?',
          )
          .get(TARGET, BRANCH);
      }) as Record<string, unknown>;
      expect(row.overridden).toBe(1);
      expect(row.override_reason).toBe('manual emergency publish');
      expect(row.override_by).toBe(OPERATOR);
    } finally {
      probe.close();
    }
  });

  it('operator override audit failure prevents push side effects', () => {
    const reviews = openReviewStore('p-push-override-audit-fail');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-push-override-audit-fail');
    worktreeStores.push(worktrees);
    const git = recordingGitExec();
    const gate = new CoReviewGate({
      reviews: {
        ...reviews,
        recordOverride: () => {
          throw new Error('override audit failed');
        },
      },
      worktrees,
      resolveMode: () => 'owner',
      gitExec: git.exec,
      headReader: () => 'c'.repeat(40),
      agentId: OPERATOR,
    });

    expect(() =>
      gate.push({
        ...pushReq,
        projectId: 'p-push-override-audit-fail',
        operatorOverride: true,
        reason: 'manual emergency publish',
      }),
    ).toThrow(/override audit failed/);
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
    const ghCalls: string[][] = [];
    const ghExec: GhExec = (_cwd, args) => {
      ghCalls.push([...args]);
      return 'https://fake/pr/route-preflight';
    };
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'contributor',
      gitExec: recordingGitExec().exec,
      headReader: () => 'c'.repeat(40),
      ghExec,
    });
    expect(() => gate.prMerge(prReq)).toThrow(/no review verdict is recorded/);
    expect(ghCalls).toEqual([]);
  });

  it('offline mode: refuses PR (pr capability is false — AC-L5-6)', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    recordPass(reviews, worktrees, 'pr_merge');
    const ghCalls: string[][] = [];
    const ghExec: GhExec = (_cwd, args) => {
      ghCalls.push([...args]);
      return 'https://fake/pr/route-preflight';
    };
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'offline',
      gitExec: recordingGitExec().exec,
      headReader: () => 'c'.repeat(40),
      ghExec,
    });
    expect(() => gate.prMerge(prReq)).toThrow(/PR capability is false/);
    expect(ghCalls).toEqual([]);
  });

  it('prMerge refuses a worker-scope PASS for the same target and branch', () => {
    const reviews = openReviewStore('p-merge');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge');
    worktreeStores.push(worktrees);
    recordPass(reviews, worktrees);
    const ghCalls: string[][] = [];
    const ghExec: GhExec = (_cwd, args) => {
      ghCalls.push([...args]);
      return 'https://fake/pr/route-preflight';
    };
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'contributor',
      gitExec: recordingGitExec().exec,
      headReader: () => 'c'.repeat(40),
      ghExec,
    });
    expect(() => gate.prMerge(prReq)).toThrow(/pr_merge.*PASS/i);
    expect(ghCalls).toEqual([]);
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
      agentId: OPERATOR,
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
      agentId: OPERATOR,
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
    expect(reviews.serializedBranches(TARGET)).toContain(BRANCH);
    expect(reviews.activeSerialized(TARGET)).toBeUndefined();
  });

  it('refuses PR creation while another branch holds the target slot', () => {
    const reviews = openReviewStore('p-pr-active-other');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-pr-active-other');
    worktreeStores.push(worktrees);
    recordPass(reviews, worktrees, 'pr_merge');
    acquireMergeSlot(reviews, TARGET, 'co/other-branch');
    const gh = recordingGhExec();
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'contributor',
      gitExec: recordingGitExec().exec,
      headReader: () => 'c'.repeat(40),
      ghExec: gh.exec,
      agentId: OPERATOR,
    });

    expect(() => gate.prMerge(prReq)).toThrow(/active reviewer\/merge/);
    expect(gh.calls).toEqual([]);
  });

  it('releases a freshly acquired branch slot when PR creation fails', () => {
    const reviews = openReviewStore('p-pr-fresh-fail-release');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-pr-fresh-fail-release');
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
    expect(reviews.activeSerialized(TARGET)).toBeUndefined();
    expect(gh.calls).toEqual([]);
  });

  it('preserves a pre-held same-branch slot when PR creation fails', () => {
    const reviews = openReviewStore('p-pr-fail-preserve-nonfresh');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-pr-fail-preserve-nonfresh');
    worktreeStores.push(worktrees);
    recordPass(reviews, worktrees, 'pr_merge');
    acquireMergeSlot(reviews, TARGET, BRANCH);
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
    expect(reviews.activeSerialized(TARGET)).toBe(BRANCH);
    expect(gh.calls).toEqual([]);
  });

  it('operator override audit failure prevents PR creation side effects', () => {
    const reviews = openReviewStore('p-pr-override-audit-fail');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-pr-override-audit-fail');
    worktreeStores.push(worktrees);
    const gh = recordingGhExec();
    const gate = new CoReviewGate({
      reviews: {
        ...reviews,
        recordOverride: () => {
          throw new Error('override audit failed');
        },
      },
      worktrees,
      resolveMode: () => 'contributor',
      gitExec: recordingGitExec().exec,
      headReader: () => 'c'.repeat(40),
      ghExec: gh.exec,
      agentId: OPERATOR,
    });

    expect(() =>
      gate.prMerge({
        ...prReq,
        projectId: 'p-pr-override-audit-fail',
        operatorOverride: true,
        reason: 'manual emergency PR',
      }),
    ).toThrow(/override audit failed/);
    expect(gh.calls).toEqual([]);
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

  it('push: does not escalate baseline failures when publish enactment fails', () => {
    const reviews = openReviewStore('p-merge-push-fail-no-esc');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge-push-fail-no-esc');
    worktreeStores.push(worktrees);
    const mail = openMailStore('p-merge-push-fail-no-esc');
    mailStores.push(mail);

    recordBaselineFailurePass(reviews, worktrees, 'pr_merge');
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      mail,
      parentResolver: { parentOf: () => 'coordinator-1' },
      agentId: 'lead-1',
      resolveMode: () => 'offline',
      gitExec: recordingGitExec().exec,
      headReader: () => 'c'.repeat(40),
    });

    expect(() =>
      gate.push({
        branch: BRANCH,
        into: TARGET,
        projectId: 'p-merge-push-fail-no-esc',
        repoCwd: '/repo',
      }),
    ).toThrow(/push capability is false/);
    expect(mail.inbox('coordinator-1').filter((m) => m.type === 'escalation')).toHaveLength(0);
  });

  it('merge: refuses before git when pending escalation cannot resolve a parent', () => {
    const reviews = openReviewStore('p-merge-route-preflight');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge-route-preflight');
    worktreeStores.push(worktrees);
    const mail = openMailStore('p-merge-route-preflight');
    mailStores.push(mail);

    recordBaselineFailurePass(reviews, worktrees);
    const git = recordingGitExec();
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      mail,
      parentResolver: {
        parentOf: () => {
          throw new Error('no agent record for lead-1');
        },
      },
      agentId: 'lead-1',
      resolveMode: () => 'owner',
      gitExec: git.exec,
      headReader: () => 'c'.repeat(40),
    });

    expect(() => gate.merge(mergeReq)).toThrow(/no agent record/);
    expect(git.calls).toEqual([]);
  });

  it('merge: escalation send failure does not mask the landed merge or skip teardown', () => {
    const reviews = openReviewStore('p-merge-escalation-send-fail');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge-escalation-send-fail');
    worktreeStores.push(worktrees);
    const mail = openMailStore('p-merge-escalation-send-fail');
    mailStores.push(mail);

    recordBaselineFailurePass(reviews, worktrees);
    const git = recordingGitExec();
    const teardownCalls: string[] = [];
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      mail: throwingSendMail(mail),
      parentResolver: { parentOf: () => 'coordinator-1' },
      agentId: 'lead-1',
      resolveMode: () => 'owner',
      gitExec: git.exec,
      headReader: () => 'c'.repeat(40),
      teardown: { teardown: (branch) => void teardownCalls.push(branch) },
    });

    const result = gate.merge(mergeReq);
    expect(result.merged).toBe(true);
    expect(result.escalated).toBeUndefined();
    expect(result.escalationFailed).toBe(true);
    expect(result.toreDown).toBe(true);
    expect(git.calls).toHaveLength(2);
    expect(teardownCalls).toEqual([BRANCH]);
  });

  it('push: refuses before git when pending escalation cannot resolve a parent', () => {
    const reviews = openReviewStore('p-push-route-preflight');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-push-route-preflight');
    worktreeStores.push(worktrees);
    const mail = openMailStore('p-push-route-preflight');
    mailStores.push(mail);

    recordBaselineFailurePass(reviews, worktrees, 'pr_merge');
    const git = recordingGitExec();
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      mail,
      parentResolver: {
        parentOf: () => {
          throw new Error('no agent record for lead-1');
        },
      },
      agentId: 'lead-1',
      resolveMode: () => 'owner',
      gitExec: git.exec,
      headReader: () => 'c'.repeat(40),
    });

    expect(() =>
      gate.push({
        branch: BRANCH,
        into: TARGET,
        projectId: 'p-push-route-preflight',
        repoCwd: '/repo',
      }),
    ).toThrow(/no agent record/);
    expect(git.calls).toEqual([]);
  });

  it('push: escalation send failure does not mask the successful push', () => {
    const reviews = openReviewStore('p-push-escalation-send-fail');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-push-escalation-send-fail');
    worktreeStores.push(worktrees);
    const mail = openMailStore('p-push-escalation-send-fail');
    mailStores.push(mail);

    recordBaselineFailurePass(reviews, worktrees, 'pr_merge');
    const git = recordingGitExec();
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      mail: throwingSendMail(mail),
      parentResolver: { parentOf: () => 'coordinator-1' },
      agentId: 'lead-1',
      resolveMode: () => 'owner',
      gitExec: git.exec,
      headReader: () => 'c'.repeat(40),
    });

    const result = gate.push({
      branch: BRANCH,
      into: TARGET,
      projectId: 'p-push-escalation-send-fail',
      repoCwd: '/repo',
    });
    expect(result.pushed).toBe(true);
    expect(result.escalated).toBeUndefined();
    expect(result.escalationFailed).toBe(true);
    expect(git.calls).toEqual([['push', 'origin', TARGET]]);
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

  it('prMerge: does not escalate baseline failures when PR enactment fails', () => {
    const reviews = openReviewStore('p-merge-pr-fail-no-esc');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge-pr-fail-no-esc');
    worktreeStores.push(worktrees);
    const mail = openMailStore('p-merge-pr-fail-no-esc');
    mailStores.push(mail);

    recordBaselineFailurePass(reviews, worktrees, 'pr_merge');
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      mail,
      parentResolver: { parentOf: () => 'coordinator-1' },
      agentId: 'lead-1',
      resolveMode: () => 'offline',
      gitExec: recordingGitExec().exec,
      headReader: () => 'c'.repeat(40),
      ghExec: () => 'https://fake/pr/1',
    });

    expect(() =>
      gate.prMerge({
        branch: BRANCH,
        into: TARGET,
        title: 'feat: land phase',
        intent: { why: 'w', whatChanged: 'wc', verification: 'v', conventions: 'c' },
        projectId: 'p-merge-pr-fail-no-esc',
        repoCwd: '/repo',
      }),
    ).toThrow(/PR capability is false/);
    expect(mail.inbox('coordinator-1').filter((m) => m.type === 'escalation')).toHaveLength(0);
  });

  it('prMerge: refuses before gh when pending escalation cannot resolve a parent', () => {
    const reviews = openReviewStore('p-pr-route-preflight');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-pr-route-preflight');
    worktreeStores.push(worktrees);
    const mail = openMailStore('p-pr-route-preflight');
    mailStores.push(mail);

    recordBaselineFailurePass(reviews, worktrees, 'pr_merge');
    const ghCalls: string[][] = [];
    const ghExec: GhExec = (_cwd, args) => {
      ghCalls.push([...args]);
      return 'https://fake/pr/route-preflight';
    };
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      mail,
      parentResolver: {
        parentOf: () => {
          throw new Error('no agent record for lead-1');
        },
      },
      agentId: 'lead-1',
      resolveMode: () => 'owner',
      gitExec: recordingGitExec().exec,
      headReader: () => 'c'.repeat(40),
      ghExec,
    });

    expect(() =>
      gate.prMerge({
        branch: BRANCH,
        into: TARGET,
        title: 'feat: preflight',
        intent: {
          why: 'needed',
          whatChanged: 'preflight routing',
          verification: 'not run',
          conventions: 'headless',
        },
        projectId: 'p-pr-route-preflight',
        repoCwd: '/repo',
      }),
    ).toThrow(/no agent record/);
    expect(ghCalls).toEqual([]);
  });

  it('prMerge: escalation send failure does not mask the successful PR creation', () => {
    const reviews = openReviewStore('p-pr-escalation-send-fail');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-pr-escalation-send-fail');
    worktreeStores.push(worktrees);
    const mail = openMailStore('p-pr-escalation-send-fail');
    mailStores.push(mail);

    recordBaselineFailurePass(reviews, worktrees, 'pr_merge');
    const ghCalls: string[][] = [];
    const ghExec: GhExec = (_cwd, args) => {
      ghCalls.push([...args]);
      return 'https://fake/pr/escalation-send-fail';
    };
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      mail: throwingSendMail(mail),
      parentResolver: { parentOf: () => 'coordinator-1' },
      agentId: 'lead-1',
      resolveMode: () => 'owner',
      gitExec: recordingGitExec().exec,
      headReader: () => 'c'.repeat(40),
      ghExec,
    });

    const result = gate.prMerge({
      branch: BRANCH,
      into: TARGET,
      title: 'feat: send fail',
      intent: {
        why: 'needed',
        whatChanged: 'preflight routing',
        verification: 'not run',
        conventions: 'headless',
      },
      projectId: 'p-pr-escalation-send-fail',
      repoCwd: '/repo',
    });
    expect(result.prUrl).toBe('https://fake/pr/escalation-send-fail');
    expect(result.escalated).toBeUndefined();
    expect(result.escalationFailed).toBe(true);
    expect(ghCalls).toHaveLength(1);
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
      ['merge', '--no-ff', '--signoff', '-m', result.commitMessage, BRANCH],
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
      expect(row.override_by).toBe(OPERATOR);
    } finally {
      probe.close();
    }
  });

  it('operator_override from a non-operator core caller is refused before audit or git side effects', () => {
    const projectId = 'p-merge-override-non-operator';
    const reviews = openReviewStore(projectId);
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore(projectId);
    worktreeStores.push(worktrees);
    const git = recordingGitExec();
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'offline',
      gitExec: git.exec,
      headReader: () => 'c'.repeat(40),
      agentId: 'lead-1',
    });

    expect(() =>
      gate.merge({
        ...mergeReq,
        projectId,
        operatorOverride: true,
        reason: 'not actually the operator',
      }),
    ).toThrow(/operator_override.*@operator|reserved for @operator/i);
    expect(git.calls).toEqual([]);
    expect(reviews.getVerdict(TARGET, BRANCH)).toBeUndefined();
  });

  it('operator override audit failure prevents merge side effects', () => {
    const reviews = openReviewStore('p-merge-override-audit-fail');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-merge-override-audit-fail');
    worktreeStores.push(worktrees);
    const git = recordingGitExec();
    const gate = new CoReviewGate({
      reviews: {
        ...reviews,
        recordOverride: () => {
          throw new Error('override audit failed');
        },
      },
      worktrees,
      resolveMode: () => 'offline',
      gitExec: git.exec,
      headReader: () => 'c'.repeat(40),
      agentId: OPERATOR,
    });

    expect(() =>
      gate.merge({
        ...mergeReq,
        projectId: 'p-merge-override-audit-fail',
        operatorOverride: true,
        reason: 'hotfix: prod down',
      }),
    ).toThrow(/override audit failed/);
    expect(git.calls).toEqual([]);
  });

  it('operator override is not durably recorded when merge slot acquisition fails', () => {
    const projectId = 'p-merge-override-slot-fail';
    const reviews = openReviewStore(projectId);
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore(projectId);
    worktreeStores.push(worktrees);
    acquireMergeSlot(reviews, TARGET, 'co/other-branch');
    const { gate, git } = fakeGate(reviews, worktrees, 'offline');

    expect(() =>
      gate.merge({
        ...mergeReq,
        projectId,
        operatorOverride: true,
        reason: 'operator accepted slot wait',
      }),
    ).toThrow(/active reviewer\/merge/);
    expect(git.calls).toEqual([]);

    const probe = openProjectStore(projectId);
    try {
      const row = probe.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureReviewTables(db);
        return db
          .prepare('SELECT overridden FROM reviews WHERE target = ? AND branch = ?')
          .get(TARGET, BRANCH);
      });
      expect(row).toBeUndefined();
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
      agentId: OPERATOR,
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

  it('duplicate agent request with the same canonical fields does not record duplicate placement', () => {
    const reviews = openReviewStore('p-place-dup');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-place-dup');
    worktreeStores.push(worktrees);
    const dispatch = openDispatchStore('p-place-dup');
    try {
      const gate = new CoReviewGate({
        reviews,
        worktrees,
        resolveMode: () => 'offline',
        config: fakeConfig(),
        dispatch,
        nowMs: 0,
      });
      const input = {
        reviewId: 'rev-place-dup',
        target: TARGET,
        branch: BRANCH,
        requestedBy: 'lead-1',
        scope: 'pr_merge' as const,
        projectId: 'p-place-dup',
      };
      const first = gate.triggerReview(input);
      const second = gate.triggerReview(input);

      expect(second).toEqual(first);
      expect(dispatch.readPlacements()).toHaveLength(1);
    } finally {
      dispatch.close();
    }
  });

  it('duplicate human request does not add an agent placement after reviewer config changes', () => {
    const reviews = openReviewStore('p-place-human-route-stable');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-place-human-route-stable');
    worktreeStores.push(worktrees);
    const mail = openMailStore('p-place-human-route-stable');
    mailStores.push(mail);
    const dispatch = openDispatchStore('p-place-human-route-stable');
    try {
      const input = {
        reviewId: 'rev-human-route-stable',
        target: TARGET,
        branch: BRANCH,
        requestedBy: 'lead-1',
        scope: 'pr_merge' as const,
        projectId: 'p-place-human-route-stable',
        specRef: 'spec:task-human-route#locked',
      };
      const humanGate = new CoReviewGate({
        reviews,
        worktrees,
        mail,
        resolveMode: () => 'offline',
        config: fakeConfig({ 'review.pr_merge.reviewer': 'human' }),
        dispatch,
        nowMs: 0,
      });
      humanGate.triggerReview(input);
      expect(reviews.getReviewRequest(TARGET, BRANCH)?.reviewerKind).toBe('human');
      expect(mail.inbox(OPERATOR).filter((m) => m.type === MAIL_REVIEW_REQUEST)).toHaveLength(1);

      const agentConfigGate = new CoReviewGate({
        reviews,
        worktrees,
        mail,
        resolveMode: () => 'offline',
        config: fakeConfig({ 'review.pr_merge.reviewer': 'agent' }),
        dispatch,
        nowMs: 0,
      });
      agentConfigGate.triggerReview(input);

      expect(dispatch.readPlacements()).toHaveLength(0);
      expect(mail.inbox(OPERATOR).filter((m) => m.type === MAIL_REVIEW_REQUEST)).toHaveLength(1);
    } finally {
      dispatch.close();
    }
  });

  it('duplicate agent request repairs placement even after reviewer config changes to human', () => {
    const reviews = openReviewStore('p-place-agent-route-stable');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-place-agent-route-stable');
    worktreeStores.push(worktrees);
    const dispatch = openDispatchStore('p-place-agent-route-stable');
    try {
      const input = {
        reviewId: 'rev-agent-route-stable',
        target: TARGET,
        branch: BRANCH,
        requestedBy: 'lead-1',
        scope: 'pr_merge' as const,
        projectId: 'p-place-agent-route-stable',
      };
      const noDispatchGate = new CoReviewGate({
        reviews,
        worktrees,
        resolveMode: () => 'offline',
        config: fakeConfig({ 'review.pr_merge.reviewer': 'agent' }),
        nowMs: 0,
      });
      noDispatchGate.triggerReview(input);
      expect(reviews.getReviewRequest(TARGET, BRANCH)?.reviewerKind).toBe('agent');
      expect(dispatch.readPlacements()).toHaveLength(0);

      const humanConfigGate = new CoReviewGate({
        reviews,
        worktrees,
        resolveMode: () => 'offline',
        config: fakeConfig({ 'review.pr_merge.reviewer': 'human' }),
        dispatch,
        nowMs: 0,
      });
      humanConfigGate.triggerReview(input);

      const placements = dispatch.readPlacements('reviewer:pr@rev-agent-route-stable');
      expect(placements).toHaveLength(1);
      expect(placements[0]!.reviewId).toBe('rev-agent-route-stable');
    } finally {
      dispatch.close();
    }
  });

  it('incompatible stale waiting placement does not suppress the current review placement', () => {
    const reviews = openReviewStore('p-place-stale-waiting');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-place-stale-waiting');
    worktreeStores.push(worktrees);
    const dispatch = openDispatchStore('p-place-stale-waiting');
    try {
      const reviewId = 'rev-place-stale-waiting';
      dispatch.recordPlacement(`reviewer:pr@${reviewId}`, {
        kind: 'waiting',
        role: 'reviewer:pr',
        work_size: 'average',
        reasoning_budget: 'standard',
        review_id: reviewId,
        review_target: 'co/old-target',
        review_branch: BRANCH,
        review_scope: 'pr_merge',
        reason: 'stale incompatible placement',
        maxed_providers: ['claude'],
        maxed_accounts: ['claude:max'],
        unavailable_providers: [],
        unavailable_accounts: [],
      });
      const gate = new CoReviewGate({
        reviews,
        worktrees,
        resolveMode: () => 'offline',
        config: fakeConfig(),
        dispatch,
        nowMs: 0,
      });

      gate.triggerReview({
        reviewId,
        target: TARGET,
        branch: BRANCH,
        requestedBy: 'lead-1',
        scope: 'pr_merge',
        projectId: 'p-place-stale-waiting',
      });

      const placements = dispatch.readPlacements(`reviewer:pr@${reviewId}`);
      expect(placements).toHaveLength(2);
      expect(placements[0]!.reviewTarget).toBe('co/old-target');
      expect(placements[1]!.kind).toBe('waiting');
      expect(placements[1]!.reviewTarget).toBe(TARGET);
      expect(placements[1]!.reviewBranch).toBe(BRANCH);
      expect(placements[1]!.reviewScope).toBe('pr_merge');
    } finally {
      dispatch.close();
    }
  });

  it('duplicate agent request repairs a missing reviewer placement instead of stranding the request', () => {
    const reviews = openReviewStore('p-place-dup-repair');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-place-dup-repair');
    worktreeStores.push(worktrees);
    const dispatch = openDispatchStore('p-place-dup-repair');
    try {
      const input = {
        reviewId: 'rev-place-repair',
        target: TARGET,
        branch: BRANCH,
        requestedBy: 'lead-1',
        scope: 'pr_merge' as const,
        projectId: 'p-place-dup-repair',
      };
      const gateWithoutDispatch = new CoReviewGate({
        reviews,
        worktrees,
        resolveMode: () => 'offline',
        config: fakeConfig(),
        nowMs: 0,
      });
      gateWithoutDispatch.triggerReview(input);
      expect(dispatch.readPlacements()).toHaveLength(0);

      const gateWithDispatch = new CoReviewGate({
        reviews,
        worktrees,
        resolveMode: () => 'offline',
        config: fakeConfig(),
        dispatch,
        nowMs: 0,
      });
      gateWithDispatch.triggerReview(input);

      const placements = dispatch.readPlacements('reviewer:pr@rev-place-repair');
      expect(placements).toHaveLength(1);
      expect(placements[0]!.role).toBe('reviewer:pr');
    } finally {
      dispatch.close();
    }
  });

  it('duplicate agent request does not repair placement after the review already has a verdict', () => {
    const reviews = openReviewStore('p-place-dup-after-verdict');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-place-dup-after-verdict');
    worktreeStores.push(worktrees);
    const dispatch = openDispatchStore('p-place-dup-after-verdict');
    try {
      const input = {
        reviewId: 'rev-place-after-verdict',
        target: TARGET,
        branch: BRANCH,
        requestedBy: 'lead-1',
        scope: 'pr_merge' as const,
        projectId: 'p-place-dup-after-verdict',
      };
      const gateWithoutDispatch = new CoReviewGate({
        reviews,
        worktrees,
        resolveMode: () => 'offline',
        config: fakeConfig(),
        nowMs: 0,
      });
      gateWithoutDispatch.triggerReview(input);
      reviews.recordVerdict({
        reviewId: 'rev-place-after-verdict',
        target: TARGET,
        branch: BRANCH,
        scope: 'pr_merge',
        reviewer: 'reviewer:pr@rev-place-after-verdict',
        verdict: 'PASS',
        blockers: [],
        suggestions: [],
        verification: {
          commands_run: ['pnpm test'],
          suite_result: 'pass',
          baseline_compared: true,
        },
      });

      const gateWithDispatch = new CoReviewGate({
        reviews,
        worktrees,
        resolveMode: () => 'offline',
        config: fakeConfig(),
        dispatch,
        nowMs: 0,
      });
      gateWithDispatch.triggerReview(input);

      expect(dispatch.readPlacements('reviewer:pr@rev-place-after-verdict')).toHaveLength(0);
    } finally {
      dispatch.close();
    }
  });

  it('duplicate request with an existing verdict still rejects mismatched specRef', () => {
    const reviews = openReviewStore('p-place-dup-verdict-specref');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-place-dup-verdict-specref');
    worktreeStores.push(worktrees);
    const input = {
      reviewId: 'rev-place-verdict-specref',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-1',
      scope: 'pr_merge' as const,
      projectId: 'p-place-dup-verdict-specref',
      specRef: 'criteria:a',
    };
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'offline',
      config: fakeConfig(),
      nowMs: 0,
    });
    gate.triggerReview(input);
    reviews.recordVerdict({
      reviewId: 'rev-place-verdict-specref',
      target: TARGET,
      branch: BRANCH,
      scope: 'pr_merge',
      reviewer: 'reviewer:pr@rev-place-verdict-specref',
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
      verification: { commands_run: ['pnpm test'], suite_result: 'pass', baseline_compared: true },
    });

    expect(() =>
      gate.triggerReview({
        ...input,
        specRef: 'criteria:b',
      }),
    ).toThrow(/conflicts on specRef/i);
  });

  it('duplicate agent request refuses placement repair when the request no longer owns the target slot', () => {
    const reviews = openReviewStore('p-place-dup-stale-slot');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-place-dup-stale-slot');
    worktreeStores.push(worktrees);
    const dispatch = openDispatchStore('p-place-dup-stale-slot');
    try {
      const input = {
        reviewId: 'rev-place-stale-slot',
        target: TARGET,
        branch: BRANCH,
        requestedBy: 'lead-1',
        scope: 'pr_merge' as const,
        projectId: 'p-place-dup-stale-slot',
      };
      const gateWithoutDispatch = new CoReviewGate({
        reviews,
        worktrees,
        resolveMode: () => 'offline',
        config: fakeConfig(),
        nowMs: 0,
      });
      gateWithoutDispatch.triggerReview(input);
      releaseMergeSlot(reviews, TARGET, BRANCH);
      acquireMergeSlot(reviews, TARGET, 'co/other-branch');

      const gateWithDispatch = new CoReviewGate({
        reviews,
        worktrees,
        resolveMode: () => 'offline',
        config: fakeConfig(),
        dispatch,
        nowMs: 0,
      });

      expect(() => gateWithDispatch.triggerReview(input)).toThrow(/active reviewer\/merge|stale/i);
      expect(dispatch.readPlacements('reviewer:pr@rev-place-stale-slot')).toHaveLength(0);
    } finally {
      dispatch.close();
    }
  });

  it('duplicate agent request retries a waiting reviewer placement when capacity becomes available', () => {
    const reviews = openReviewStore('p-place-dup-waiting-retry');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-place-dup-waiting-retry');
    worktreeStores.push(worktrees);
    const dispatch = openDispatchStore('p-place-dup-waiting-retry');
    try {
      const input = {
        reviewId: 'rev-place-waiting-retry',
        target: TARGET,
        branch: BRANCH,
        requestedBy: 'lead-1',
        scope: 'pr_merge' as const,
        projectId: 'p-place-dup-waiting-retry',
      };
      const firstGate = new CoReviewGate({
        reviews,
        worktrees,
        resolveMode: () => 'offline',
        config: fakeConfig(),
        dispatch,
        nowMs: 0,
      });
      firstGate.triggerReview(input);
      expect(
        dispatch.readPlacements('reviewer:pr@rev-place-waiting-retry').map((p) => p.kind),
      ).toEqual(['waiting']);

      dispatch.recordSnapshot({
        provider: 'claude',
        account: accountForProvider('claude'),
        available: true,
        source: 'test',
        sampled_at: '1970-01-01T00:00:00.000Z',
        windows: [{ kind: 'five_hour', used_pct: 1, reset_at: '1970-01-01T05:00:00.000Z' }],
      });

      const retryGate = new CoReviewGate({
        reviews,
        worktrees,
        resolveMode: () => 'offline',
        config: fakeConfig(),
        dispatch,
        nowMs: 1,
      });
      retryGate.triggerReview(input);

      expect(
        dispatch.readPlacements('reviewer:pr@rev-place-waiting-retry').map((p) => p.kind),
      ).toEqual(['waiting', 'placed']);
    } finally {
      dispatch.close();
    }
  });

  it('duplicate agent request keeps the original waiting reviewer role when capacity later recovers', () => {
    const reviews = openReviewStore('p-place-dup-waiting-config-retry');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-place-dup-waiting-config-retry');
    worktreeStores.push(worktrees);
    const dispatch = openDispatchStore('p-place-dup-waiting-config-retry');
    try {
      const input = {
        reviewId: 'rev-place-waiting-config-retry',
        target: TARGET,
        branch: BRANCH,
        requestedBy: 'lead-1',
        scope: 'pr_merge' as const,
        projectId: 'p-place-dup-waiting-config-retry',
      };
      const firstGate = new CoReviewGate({
        reviews,
        worktrees,
        resolveMode: () => 'offline',
        config: fakeConfig({ reviewer_profiles: { pr_merge: 'reviewer:bugfix' } }),
        dispatch,
        nowMs: 0,
      });
      firstGate.triggerReview(input);
      expect(
        dispatch
          .readPlacements('reviewer:bugfix@rev-place-waiting-config-retry')
          .map((p) => p.kind),
      ).toEqual(['waiting']);

      dispatch.recordSnapshot({
        provider: 'claude',
        account: accountForProvider('claude'),
        available: true,
        source: 'test',
        sampled_at: '1970-01-01T00:00:00.000Z',
        windows: [{ kind: 'five_hour', used_pct: 1, reset_at: '1970-01-01T05:00:00.000Z' }],
      });

      const retryGate = new CoReviewGate({
        reviews,
        worktrees,
        resolveMode: () => 'offline',
        config: fakeConfig({ reviewer_profiles: { pr_merge: 'reviewer:pr' } }),
        dispatch,
        nowMs: 1,
      });
      retryGate.triggerReview(input);

      expect(
        dispatch
          .readPlacements('reviewer:bugfix@rev-place-waiting-config-retry')
          .map((p) => p.kind),
      ).toEqual(['waiting', 'placed']);
      expect(dispatch.readPlacements('reviewer:pr@rev-place-waiting-config-retry')).toHaveLength(0);
    } finally {
      dispatch.close();
    }
  });

  it('duplicate agent request reuses the durable reviewer placement after reviewer_profiles changes', () => {
    const reviews = openReviewStore('p-place-dup-config-change');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-place-dup-config-change');
    worktreeStores.push(worktrees);
    const dispatch = openDispatchStore('p-place-dup-config-change');
    try {
      const input = {
        reviewId: 'rev-place-config-change',
        target: TARGET,
        branch: BRANCH,
        requestedBy: 'lead-1',
        scope: 'pr_merge' as const,
        projectId: 'p-place-dup-config-change',
      };
      const initialGate = new CoReviewGate({
        reviews,
        worktrees,
        resolveMode: () => 'offline',
        config: fakeConfig({ reviewer_profiles: { pr_merge: 'reviewer:bugfix' } }),
        dispatch,
        nowMs: 0,
      });
      initialGate.triggerReview(input);
      expect(dispatch.readPlacements('reviewer:bugfix@rev-place-config-change')).toHaveLength(1);

      const retryGate = new CoReviewGate({
        reviews,
        worktrees,
        resolveMode: () => 'offline',
        config: fakeConfig({ reviewer_profiles: { pr_merge: 'reviewer:pr' } }),
        dispatch,
        nowMs: 0,
      });
      retryGate.triggerReview(input);

      expect(dispatch.readPlacements()).toHaveLength(1);
      expect(dispatch.readPlacements('reviewer:bugfix@rev-place-config-change')).toHaveLength(1);
      expect(dispatch.readPlacements('reviewer:pr@rev-place-config-change')).toHaveLength(0);
    } finally {
      dispatch.close();
    }
  });

  it('cross-target duplicate reviewId is refused before reviewer placement side effects', () => {
    const reviews = openReviewStore('p-place-dup-cross-target');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-place-dup-cross-target');
    worktreeStores.push(worktrees);
    const dispatch = openDispatchStore('p-place-dup-cross-target');
    try {
      reviews.recordReviewRequested({
        reviewId: 'rev-cross-target',
        target: TARGET,
        branch: BRANCH,
        requestedBy: 'lead-1',
        scope: 'pr_merge',
      });
      const gate = new CoReviewGate({
        reviews,
        worktrees,
        resolveMode: () => 'offline',
        config: fakeConfig(),
        dispatch,
        nowMs: 0,
      });

      expect(() =>
        gate.triggerReview({
          reviewId: 'rev-cross-target',
          target: 'co/another-target',
          branch: 'co/another-branch',
          requestedBy: 'lead-1',
          scope: 'pr_merge',
          projectId: 'p-place-dup-cross-target',
        }),
      ).toThrow(/duplicate reviewId.*already belongs/i);
      expect(dispatch.readPlacements()).toHaveLength(0);
      expect(reviews.getReviewRequest('co/another-target', 'co/another-branch')).toBeUndefined();
    } finally {
      dispatch.close();
    }
  });

  it('records placement before request creation so placement failures do not clear prior verdicts', () => {
    const reviews = openReviewStore('p-place-fail');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-place-fail');
    worktreeStores.push(worktrees);
    recordPass(reviews, worktrees, 'pr_merge');
    const realDispatch = openDispatchStore('p-place-fail');
    const dispatch: DispatchStore = {
      ...realDispatch,
      recordPlacementWithReviewRequest: () => {
        throw new Error('placement store unavailable');
      },
    };
    try {
      const gate = new CoReviewGate({
        reviews,
        worktrees,
        resolveMode: () => 'offline',
        config: fakeConfig(),
        dispatch,
        nowMs: 0,
      });

      expect(() =>
        gate.triggerReview({
          reviewId: 'rev-place-fail',
          target: TARGET,
          branch: BRANCH,
          requestedBy: 'lead-1',
          scope: 'pr_merge',
          projectId: 'p-place-fail',
        }),
      ).toThrow(/placement store unavailable/);
      expect(reviews.getVerdict(TARGET, BRANCH, 'pr_merge')?.reviewId).toBe('rev-1');
      expect(reviews.getReviewRequest(TARGET, BRANCH)).toBeUndefined();
      expect(reviews.activeSerialized(TARGET)).toBeUndefined();
    } finally {
      realDispatch.close();
    }
  });

  it('records agent placement and review request atomically', () => {
    const projectId = 'p-place-request-fail-bound';
    const reviews = openReviewStore(projectId);
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore(projectId);
    worktreeStores.push(worktrees);
    const dispatch = openDispatchStore(projectId);
    const failingDispatch: DispatchStore = {
      ...dispatch,
      recordPlacementWithReviewRequest: () => {
        throw new Error('review request store unavailable');
      },
    };
    try {
      const gate = new CoReviewGate({
        reviews,
        worktrees,
        resolveMode: () => 'offline',
        config: fakeConfig(),
        dispatch: failingDispatch,
        nowMs: 0,
      });

      expect(() =>
        gate.triggerReview({
          reviewId: 'rev-place-request-fail-bound',
          target: TARGET,
          branch: BRANCH,
          requestedBy: 'lead-1',
          scope: 'pr_merge',
          projectId,
        }),
      ).toThrow(/review request store unavailable/);

      expect(dispatch.readPlacements()).toHaveLength(0);
      expect(reviews.getReviewRequest(TARGET, BRANCH)).toBeUndefined();

      reviews.recordReviewRequested({
        reviewId: 'rev-place-request-fail-bound',
        target: 'co/another-target',
        branch: 'co/another-branch',
        requestedBy: 'lead-1',
        scope: 'pr_merge',
      });
      expect(reviews.getReviewRequest('co/another-target', 'co/another-branch')?.reviewId).toBe(
        'rev-place-request-fail-bound',
      );
    } finally {
      dispatch.close();
    }
  });

  it('failed re-review setup does not release a slot this branch already held', () => {
    const reviews = openReviewStore('p-place-fail-existing-slot');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-place-fail-existing-slot');
    worktreeStores.push(worktrees);
    recordPass(reviews, worktrees, 'pr_merge');
    acquireMergeSlot(reviews, TARGET, BRANCH);
    const realDispatch = openDispatchStore('p-place-fail-existing-slot');
    const dispatch: DispatchStore = {
      ...realDispatch,
      recordPlacementWithReviewRequest: () => {
        throw new Error('placement store unavailable');
      },
    };
    try {
      const gate = new CoReviewGate({
        reviews,
        worktrees,
        resolveMode: () => 'offline',
        config: fakeConfig(),
        dispatch,
        nowMs: 0,
      });

      expect(() =>
        gate.triggerReview({
          reviewId: 'rev-place-existing-slot-fail',
          target: TARGET,
          branch: BRANCH,
          requestedBy: 'lead-1',
          scope: 'pr_merge',
          projectId: 'p-place-fail-existing-slot',
        }),
      ).toThrow(/placement store unavailable/);
      expect(reviews.getVerdict(TARGET, BRANCH, 'pr_merge')?.reviewId).toBe('rev-1');
      expect(reviews.getReviewRequest(TARGET, BRANCH)).toBeUndefined();
      expect(reviews.activeSerialized(TARGET)).toBe(BRANCH);
    } finally {
      realDispatch.close();
    }
  });

  it('failed request setup does not release a same-branch slot acquired elsewhere', () => {
    const reviews = openReviewStore('p-place-fail-nonfresh-slot');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-place-fail-nonfresh-slot');
    worktreeStores.push(worktrees);
    acquireMergeSlot(reviews, TARGET, BRANCH);
    let released = false;
    const nonFreshReviews: ReviewStore = {
      ...reviews,
      acquireSerialized: (slot) => ({
        acquired: true,
        queued: false,
        active: slot.branch,
        fresh: false,
      }),
      releaseSerialized: (slot) => {
        released = true;
        reviews.releaseSerialized(slot);
      },
      recordReviewRequested: () => {
        throw new Error('request store unavailable');
      },
    };
    const gate = new CoReviewGate({
      reviews: nonFreshReviews,
      worktrees,
      resolveMode: () => 'offline',
      config: fakeConfig(),
    });

    expect(() =>
      gate.triggerReview({
        reviewId: 'rev-place-nonfresh-slot-fail',
        target: TARGET,
        branch: BRANCH,
        requestedBy: 'lead-1',
        scope: 'pr_merge',
        projectId: 'p-place-fail-nonfresh-slot',
      }),
    ).toThrow(/request store unavailable/);
    expect(released).toBe(false);
    expect(reviews.activeSerialized(TARGET)).toBe(BRANCH);
  });

  it('duplicate agent request with mismatched fields is refused before placement', () => {
    const reviews = openReviewStore('p-place-dup-mismatch');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-place-dup-mismatch');
    worktreeStores.push(worktrees);
    const dispatch = openDispatchStore('p-place-dup-mismatch');
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
        reviewId: 'rev-place-dup-mismatch',
        target: TARGET,
        branch: BRANCH,
        requestedBy: 'lead-1',
        scope: 'pr_merge',
        projectId: 'p-place-dup-mismatch',
      });

      expect(() =>
        gate.triggerReview({
          reviewId: 'rev-place-dup-mismatch',
          target: TARGET,
          branch: BRANCH,
          requestedBy: 'lead-1',
          scope: 'worker_merge',
          projectId: 'p-place-dup-mismatch',
        }),
      ).toThrow(/duplicate reviewId.*scope/i);
      expect(dispatch.readPlacements()).toHaveLength(1);
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

  it('reviewer_profiles config overrides the scope→reviewer-role map with shipped reviewer roles', () => {
    const reviews = openReviewStore('p-place-cfg');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-place-cfg');
    worktreeStores.push(worktrees);
    const dispatch = openDispatchStore('p-place-cfg');
    try {
      const config = fakeConfig({ reviewer_profiles: { pr_merge: 'reviewer:bugfix' } });
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
      expect(dispatch.readPlacements()[0]!.role).toBe('reviewer:bugfix');
    } finally {
      dispatch.close();
    }
  });

  it('reviewer_profiles config rejects unknown reviewer sub-roles', () => {
    const reviews = openReviewStore('p-place-cfg-bad');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-place-cfg-bad');
    worktreeStores.push(worktrees);
    const dispatch = openDispatchStore('p-place-cfg-bad');
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
      expect(() =>
        gate.triggerReview({
          reviewId: 'rev-cfg-bad',
          target: TARGET,
          branch: BRANCH,
          requestedBy: 'lead-1',
          scope: 'pr_merge',
          projectId: 'p-place-cfg-bad',
        }),
      ).toThrow(/unknown reviewer sub-role/i);
      expect(dispatch.readPlacements()).toHaveLength(0);
      expect(reviews.getReviewRequest(TARGET, BRANCH)).toBeUndefined();
    } finally {
      dispatch.close();
    }
  });

  it('reviewer_profiles config rejects unknown review scope keys', () => {
    const reviews = openReviewStore('p-place-cfg-scope-bad');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-place-cfg-scope-bad');
    worktreeStores.push(worktrees);
    const dispatch = openDispatchStore('p-place-cfg-scope-bad');
    try {
      const config = fakeConfig({ reviewer_profiles: { 'pr-merg': 'reviewer:pr' } });
      const gate = new CoReviewGate({
        reviews,
        worktrees,
        resolveMode: () => 'offline',
        config,
        dispatch,
        nowMs: 0,
      });
      expect(() =>
        gate.triggerReview({
          reviewId: 'rev-cfg-scope-bad',
          target: TARGET,
          branch: BRANCH,
          requestedBy: 'lead-1',
          scope: 'pr_merge',
          projectId: 'p-place-cfg-scope-bad',
        }),
      ).toThrow(/unknown reviewer_profiles scope/i);
      expect(dispatch.readPlacements()).toHaveLength(0);
      expect(reviews.getReviewRequest(TARGET, BRANCH)).toBeUndefined();
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

// ── Nit 3 (P9 fix): fireSpawn is loud by default — never a silent discard ─────────────────────────
describe('CoReviewGate.fireSpawn — spawn errors are surfaced, never silent (Principle 9)', () => {
  /** Build a gate with a dispatch store, a healthy snapshot for a placed placement, and a spawn gate that rejects. */
  function makeGateWithRejectingSpawn(
    projectId: string,
    onSpawnError?: (agentId: string, err: unknown) => void,
  ): CoReviewGate {
    const reviews = openReviewStore(projectId);
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore(projectId);
    worktreeStores.push(worktrees);
    const dispatch = openDispatchStore(projectId);
    // Seed a healthy provider snapshot so the dispatch policy returns 'placed' (not 'waiting').
    dispatch.recordSnapshot({
      provider: 'claude',
      account: accountForProvider('claude'),
      available: true,
      source: 'test',
      sampled_at: '1970-01-01T00:00:00.000Z',
      windows: [{ kind: 'five_hour', used_pct: 0.1, reset_at: '1970-01-01T05:00:00.000Z' }],
    });
    // close via afterEach — open it but track via a local try/finally in the caller
    mailStores.push({ close: () => dispatch.close() } as unknown as Parameters<
      typeof mailStores.push
    >[0]);
    return new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'offline',
      config: fakeConfig(),
      dispatch,
      nowMs: 0,
      reviewerSpawnGate: { spawn: () => Promise.reject(new Error('spawn failed in test')) },
      ...(onSpawnError != null ? { onSpawnError } : {}),
    });
  }

  it('surfaces spawn failure to stderr by DEFAULT when onSpawnError is absent (Principle 9 — never silent)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const gate = makeGateWithRejectingSpawn('p-spawn-loud-default');
      gate.triggerReview({
        reviewId: 'rev-spawn-default',
        target: TARGET,
        branch: BRANCH,
        requestedBy: 'lead-1',
        scope: 'worker_merge',
        projectId: 'p-spawn-loud-default',
      });
      // Drain the microtask queue so the fire-and-forget rejection handler runs.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.calls[0]![0]).toMatch(
        /reviewer spawn for .* failed \(no onSpawnError injected\)/,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('routes spawn failure to onSpawnError (not console.error) when the handler is injected', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const errors: Array<{ agentId: string; err: unknown }> = [];
    try {
      const gate = makeGateWithRejectingSpawn('p-spawn-handler', (agentId, err) => {
        errors.push({ agentId, err });
      });
      gate.triggerReview({
        reviewId: 'rev-spawn-handler',
        target: TARGET,
        branch: BRANCH,
        requestedBy: 'lead-1',
        scope: 'worker_merge',
        projectId: 'p-spawn-handler',
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(errors).toHaveLength(1);
      expect(errors[0]!.agentId).toContain('reviewer');
      expect((errors[0]!.err as Error).message).toBe('spawn failed in test');
      expect(consoleSpy).not.toHaveBeenCalled(); // handler injected → no stderr fallback
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

// ── #135 nit: the human-path mail guard fails loud (Principle 9) ─────────────────────────────────
describe('CoReviewGate.triggerReview — #135 human-path mail guard', () => {
  it('a human review without locked criteria fails loud and records nothing', () => {
    const reviews = openReviewStore('p-human-no-spec');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-human-no-spec');
    worktreeStores.push(worktrees);
    const mail = openMailStore('p-human-no-spec');
    mailStores.push(mail);
    const config = fakeConfig({ 'review.worker_merge.reviewer': 'human' });
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      mail,
      resolveMode: () => 'offline',
      config,
    });

    expect(() =>
      gate.triggerReview({
        reviewId: 'rev-human-no-spec',
        target: TARGET,
        branch: BRANCH,
        requestedBy: 'lead-1',
        scope: 'worker_merge',
        projectId: 'p-human-no-spec',
      }),
    ).toThrow(/locked acceptance criteria|spec_ref/i);
    expect(reviews.getReviewRequest(TARGET, BRANCH)).toBeUndefined();
    expect(mail.inbox(OPERATOR).filter((m) => m.type === MAIL_REVIEW_REQUEST)).toHaveLength(0);
  });

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
        specRef: 'spec:task-mail-guard#locked',
      }),
    ).toThrow(/no mail store is wired/);
    expect(reviews.getReviewRequest(TARGET, BRANCH)).toBeUndefined();
    expect(reviews.getVerdict(TARGET, BRANCH)?.reviewId).toBe('rev-1');
  });

  it('a human review whose mail delivery fails preserves the previous verdict and request row', () => {
    const reviews = openReviewStore('p-human-mail-fail');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-human-mail-fail');
    worktreeStores.push(worktrees);
    const mail = openMailStore('p-human-mail-fail');
    mailStores.push(mail);
    recordPass(reviews, worktrees);
    const config = fakeConfig({ 'review.worker_merge.reviewer': 'human' });
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      mail: throwingSendMail(mail),
      resolveMode: () => 'offline',
      config,
    });

    expect(() =>
      gate.triggerReview({
        reviewId: 'rev-human-mail-fail',
        target: TARGET,
        branch: BRANCH,
        requestedBy: 'lead-1',
        scope: 'worker_merge',
        projectId: 'p-human-mail-fail',
        specRef: 'spec:task-mail-fail#locked',
      }),
    ).toThrow(/mail send failed/i);

    expect(reviews.getReviewRequest(TARGET, BRANCH)).toBeUndefined();
    const previous = reviews.getVerdict(TARGET, BRANCH);
    expect(previous?.reviewId).toBe('rev-1');
    expect(previous?.verdict).toBe('PASS');
  });
});
