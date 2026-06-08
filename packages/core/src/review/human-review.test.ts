import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPERATOR, MAIL_REVIEW_REQUEST, mailKind, completionPredicate } from '../mail/events.js';
import { openMailStore, type MailStore } from '../mail/mail-store.js';
import type { ConfigStore } from '../config/config-store.js';
import { openWorktreeStore, type WorktreeStore } from '../worktrees/worktree-store.js';
import { openReviewStore, type ReviewStore } from './review-store.js';
import { CoReviewGate } from './merge.js';
import type { ReviewScope } from './ladder.js';
import {
  resolveReviewerKind,
  reviewRequestOutcome,
  reviewRequestEnvelope,
  recordHumanVerdict,
} from './human-review.js';

// ── Program-data dir per test ──────────────────────────────────────────────────────────────────────
const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let mailStores: MailStore[] = [];
let reviewStores: ReviewStore[] = [];
let worktreeStores: WorktreeStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  mailStores = [];
  reviewStores = [];
  worktreeStores = [];
  const dir = mkdtempSync(join(tmpdir(), 'co-hr-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const m of mailStores) m.close();
  for (const r of reviewStores) r.close();
  for (const w of worktreeStores) w.close();
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
  mailStores = [];
  reviewStores = [];
  worktreeStores = [];
});

/** A fake config that returns a fixed effective config for any projectId. */
function fakeConfig(overrides: Record<string, unknown> = {}): ConfigStore {
  return {
    setGlobal: () => undefined,
    setProjectOverride: () => undefined,
    resolveEffective: () => overrides,
    close: () => undefined,
  };
}

const TARGET = 'co/l5-review-gate';
const BRANCH = 'co/l5-phase-e';
const FAKE_SHA = 'a'.repeat(40);

/** Seed baseline + finish with clean (all-passing) test data, mirroring merge.test.ts. */
function recordCleanFinish(worktrees: WorktreeStore): void {
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
}

/** A fake git executor recording each invocation, so publish gating stays headless. */
function recordingGitExec(): {
  calls: string[][];
  exec: (cwd: string, args: readonly string[]) => void;
} {
  const calls: string[][] = [];
  return { calls, exec: (_cwd, args) => void calls.push([...args]) };
}

// ── resolveReviewerKind (AC-L5-5 default-agent requirement) ───────────────────────────────────────

describe('resolveReviewerKind — reads review.<scope>.reviewer from config', () => {
  const SCOPE: ReviewScope = 'worker_merge';

  it('returns "agent" when no config is set (default)', () => {
    expect(resolveReviewerKind(fakeConfig(), 'proj-1', SCOPE)).toBe('agent');
  });

  it('returns "human" when review.<scope>.reviewer = "human"', () => {
    expect(
      resolveReviewerKind(fakeConfig({ [`review.${SCOPE}.reviewer`]: 'human' }), 'proj-1', SCOPE),
    ).toBe('human');
  });

  it('returns "agent" for any non-"human" string (ignores unrecognized values)', () => {
    expect(
      resolveReviewerKind(fakeConfig({ [`review.${SCOPE}.reviewer`]: 'bot' }), 'proj-1', SCOPE),
    ).toBe('agent');
    expect(
      resolveReviewerKind(fakeConfig({ [`review.${SCOPE}.reviewer`]: 'Human' }), 'proj-1', SCOPE),
    ).toBe('agent');
  });

  it('is scope-specific: "human" on worker_merge does not affect phase_merge', () => {
    const config = fakeConfig({ 'review.worker_merge.reviewer': 'human' });
    expect(resolveReviewerKind(config, 'proj-1', 'worker_merge')).toBe('human');
    expect(resolveReviewerKind(config, 'proj-1', 'phase_merge')).toBe('agent');
    expect(resolveReviewerKind(config, 'proj-1', 'pr_merge')).toBe('agent');
  });
});

// ── review_request / review_response mail type registration ──────────────────────────────────────

describe('review_request mail type — registered actionable with a predicate', () => {
  it('review_request is actionable with a completion predicate', () => {
    expect(mailKind(MAIL_REVIEW_REQUEST)).toBe('actionable');
    expect(completionPredicate(MAIL_REVIEW_REQUEST)).toBeTypeOf('function');
  });

  it('reviewRequestEnvelope always addresses @operator (operator-terminal by construction)', () => {
    const env = reviewRequestEnvelope({
      from: 'lead-1',
      subject: 'review co/phase-e?',
      body: 'please review',
    });
    expect(env.type).toBe(MAIL_REVIEW_REQUEST);
    expect(env.to).toBe(OPERATOR);
    expect(env.from).toBe('lead-1');
  });

  it('send rejects a review_request addressed to a non-operator recipient', () => {
    const mail = openMailStore('p-hr-peer');
    mailStores.push(mail);
    expect(() =>
      mail.send({
        type: MAIL_REVIEW_REQUEST,
        to: 'lead',
        from: 'worker',
        subject: 's',
        body: 'b',
      }),
    ).toThrow(/review_request.*@operator/i);
  });
});

// ── reviewRequestOutcome (AC-L5-5 — pending→PASS/ISSUES, replay-safe) ────────────────────────────

describe('reviewRequestOutcome — log-derived pending→verdict (approvalOutcome twin)', () => {
  it('returns "pending" before the operator responds', () => {
    const mail = openMailStore('p-hr-pending');
    mailStores.push(mail);
    const req = mail.send(
      reviewRequestEnvelope({ from: 'lead', subject: 'review?', body: 'please' }),
    );
    expect(req.recipient).toBe(OPERATOR);
    expect(req.kind).toBe('actionable');

    const reqRow = mail.inbox(OPERATOR).find((m) => m.seq === req.seq)!;
    expect(reviewRequestOutcome(mail, reqRow)).toBe('pending');
    expect(mail.outstandingCount(OPERATOR)).toBe(1);
  });

  it('returns "PASS" once the operator replies with reviewVerdict: PASS', () => {
    const mail = openMailStore('p-hr-pass');
    mailStores.push(mail);
    const req = mail.send(
      reviewRequestEnvelope({ from: 'lead', subject: 'review?', body: 'please' }),
    );
    const reqRow = mail.inbox(OPERATOR).find((m) => m.seq === req.seq)!;

    mail.reply(reqRow, {
      type: 'review_response',
      subject: 're: review?',
      body: 'looks good',
      reviewVerdict: 'PASS',
    });

    const afterReply = mail.inbox(OPERATOR).find((m) => m.seq === req.seq)!;
    expect(reviewRequestOutcome(mail, afterReply)).toBe('PASS');
    // The review_request is resolved once answered (like approval).
    expect(afterReply.resolved).toBe(true);
    expect(mail.outstandingCount(OPERATOR)).toBe(0);
    // The reviewVerdict is log-derived and appears on the response row in the sender's inbox.
    const resp = mail.inbox('lead').find((m) => m.type === 'review_response')!;
    expect(resp.reviewVerdict).toBe('PASS');
  });

  it('returns "ISSUES" once the operator replies with reviewVerdict: ISSUES', () => {
    const mail = openMailStore('p-hr-issues');
    mailStores.push(mail);
    const req = mail.send(
      reviewRequestEnvelope({ from: 'lead', subject: 'review?', body: 'please' }),
    );
    const reqRow = mail.inbox(OPERATOR).find((m) => m.seq === req.seq)!;

    mail.reply(reqRow, {
      type: 'review_response',
      subject: 're: review?',
      body: 'missing tests',
      reviewVerdict: 'ISSUES',
    });

    const afterReply = mail.inbox(OPERATOR).find((m) => m.seq === req.seq)!;
    expect(reviewRequestOutcome(mail, afterReply)).toBe('ISSUES');
    expect(afterReply.resolved).toBe(true);
  });

  it('ignores a review_response not sent by the holder (@operator) back to the requester', () => {
    const mail = openMailStore('p-hr-spoof');
    mailStores.push(mail);
    const req = mail.send(
      reviewRequestEnvelope({ from: 'lead', subject: 'review?', body: 'please' }),
    );
    // A spoofed review_response from an intruder — must not resolve the request.
    mail.send({
      type: 'review_response',
      to: 'lead',
      from: 'intruder',
      subject: 're',
      body: 'fake pass',
      reviewVerdict: 'PASS',
      correlationId: String(req.seq),
      causationId: String(req.seq),
    });
    const reqRow = mail.inbox(OPERATOR).find((m) => m.seq === req.seq)!;
    expect(reviewRequestOutcome(mail, reqRow)).toBe('pending');
    expect(mail.outstandingCount(OPERATOR)).toBe(1);
  });

  it('throws when called with a non-review_request mail', () => {
    const mail = openMailStore('p-hr-wrong-type');
    mailStores.push(mail);
    const chat = mail.send({ type: 'chat', to: OPERATOR, from: 'lead', subject: 's', body: 'b' });
    const chatRow = mail.inbox(OPERATOR).find((m) => m.seq === chat.seq)!;
    expect(() => reviewRequestOutcome(mail, chatRow)).toThrow(/review_request/i);
  });
});

// ── recordHumanVerdict (AC-L5-5 — re-enters gate identically to agent verdict) ───────────────────

describe('recordHumanVerdict — verdict is found by reviews.getVerdict (same as agent path)', () => {
  it('a human PASS verdict is recorded and found by getVerdict', () => {
    const reviews = openReviewStore('p-hr-verdict-pass');
    reviewStores.push(reviews);

    recordHumanVerdict(reviews, {
      reviewId: 'rev-human-1',
      target: TARGET,
      branch: BRANCH,
      verdict: 'PASS',
    });

    const v = reviews.getVerdict(TARGET, BRANCH);
    expect(v).toBeDefined();
    expect(v!.verdict).toBe('PASS');
    expect(v!.reviewer).toBe(OPERATOR);
    expect(v!.blockers).toHaveLength(0);
    expect(v!.verification?.commands_run).toContain('human-review');
    expect(v!.verification?.suite_result).toBe('pass');
    expect(v!.verification?.baseline_compared).toBe(false);
  });

  it('a human PASS preserves pr_merge scope for publish gates', () => {
    const reviews = openReviewStore('p-hr-verdict-pr-scope');
    reviewStores.push(reviews);

    recordHumanVerdict(reviews, {
      reviewId: 'rev-human-pr',
      target: TARGET,
      branch: BRANCH,
      scope: 'pr_merge',
      verdict: 'PASS',
    });

    const v = reviews.getVerdict(TARGET, BRANCH, 'pr_merge');
    expect(v).toBeDefined();
    expect(v!.scope).toBe('pr_merge');
    expect(v!.reviewer).toBe(OPERATOR);
  });

  it('a human pr_merge PASS satisfies the gated push path', () => {
    const reviews = openReviewStore('p-hr-verdict-pr-push');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-hr-verdict-pr-push');
    worktreeStores.push(worktrees);
    recordCleanFinish(worktrees);
    recordHumanVerdict(reviews, {
      reviewId: 'rev-human-pr-push',
      target: TARGET,
      branch: BRANCH,
      scope: 'pr_merge',
      verdict: 'PASS',
    });

    const git = recordingGitExec();
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'owner',
      gitExec: git.exec,
    });
    expect(
      gate.push({
        branch: BRANCH,
        into: TARGET,
        projectId: 'p-hr-verdict-pr-push',
        repoCwd: '/repo',
      }).pushed,
    ).toBe(true);
    expect(git.calls).toEqual([['push', 'origin', TARGET]]);
  });

  it('a human pr_merge request/reply re-enters with persisted scope and satisfies push', () => {
    const projectId = 'p-hr-request-pr-push';
    const reviews = openReviewStore(projectId);
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore(projectId);
    worktreeStores.push(worktrees);
    const mail = openMailStore(projectId);
    mailStores.push(mail);
    recordCleanFinish(worktrees);

    const requestGate = new CoReviewGate({
      reviews,
      worktrees,
      mail,
      config: fakeConfig({ 'review.pr_merge.reviewer': 'human' }),
      resolveMode: () => 'offline',
    });
    requestGate.triggerReview({
      reviewId: 'rev-human-pr-request',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-1',
      scope: 'pr_merge',
      projectId,
    });

    const persistedRequest = reviews.getReviewRequest(TARGET, BRANCH);
    expect(persistedRequest?.scope).toBe('pr_merge');
    const requestMail = mail.inbox(OPERATOR).find((m) => m.type === 'review_request')!;
    mail.reply(requestMail, {
      type: 'review_response',
      subject: 're: review?',
      body: 'passes',
      reviewVerdict: 'PASS',
    });
    const outcome = reviewRequestOutcome(mail, requestMail);
    if (outcome !== 'PASS') throw new Error(`expected human PASS, got ${outcome}`);
    const response = mail.inbox('lead-1').find((m) => m.type === 'review_response')!;

    recordHumanVerdict(reviews, {
      reviewId: persistedRequest!.reviewId,
      target: persistedRequest!.target,
      branch: persistedRequest!.branch,
      verdict: outcome,
      body: response.body,
    });

    const git = recordingGitExec();
    const publishGate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'owner',
      gitExec: git.exec,
    });
    expect(
      publishGate.push({ branch: BRANCH, into: TARGET, projectId, repoCwd: '/repo' }).pushed,
    ).toBe(true);
    expect(git.calls).toEqual([['push', 'origin', TARGET]]);
  });

  it('does not infer pr_merge scope from a newer request for a stale human response', () => {
    const projectId = 'p-hr-stale-response';
    const reviews = openReviewStore(projectId);
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore(projectId);
    worktreeStores.push(worktrees);
    recordCleanFinish(worktrees);

    reviews.recordReviewRequested({
      reviewId: 'rev-worker-old',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-1',
      scope: 'worker_merge',
    });
    reviews.recordReviewRequested({
      reviewId: 'rev-pr-new',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-1',
      scope: 'pr_merge',
    });

    expect(() =>
      recordHumanVerdict(reviews, {
        reviewId: 'rev-worker-old',
        target: TARGET,
        branch: BRANCH,
        verdict: 'PASS',
      }),
    ).toThrow(/stale review verdict/);

    expect(reviews.getVerdict(TARGET, BRANCH, 'pr_merge')).toBeUndefined();
    expect(reviews.getVerdict(TARGET, BRANCH, 'worker_merge')).toBeUndefined();

    const git = recordingGitExec();
    const pushGate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'owner',
      gitExec: git.exec,
    });
    expect(() =>
      pushGate.push({ branch: BRANCH, into: TARGET, projectId, repoCwd: '/repo' }),
    ).toThrow(/no review verdict is recorded/);
    expect(git.calls).toEqual([]);

    const ghCalls: string[][] = [];
    const prGate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'contributor',
      gitExec: recordingGitExec().exec,
      headReader: () => 'c'.repeat(40),
      ghExec: (_cwd, args) => {
        ghCalls.push([...args]);
        return 'https://fake/pr/stale';
      },
    });
    expect(() =>
      prGate.prMerge({
        branch: BRANCH,
        into: TARGET,
        title: 'feat(review): stale human response test',
        intent: {
          why: 'prove stale review responses cannot publish',
          whatChanged: 'no publish',
          verification: 'test',
          conventions: 'n/a',
        },
        projectId,
        repoCwd: '/repo',
      }),
    ).toThrow(/no review verdict is recorded/);
    expect(ghCalls).toEqual([]);
  });

  it('a human ISSUES verdict is recorded with a blocker derived from body', () => {
    const reviews = openReviewStore('p-hr-verdict-issues');
    reviewStores.push(reviews);

    recordHumanVerdict(reviews, {
      reviewId: 'rev-human-2',
      target: TARGET,
      branch: BRANCH,
      verdict: 'ISSUES',
      body: 'missing tests for the new helper',
    });

    const v = reviews.getVerdict(TARGET, BRANCH);
    expect(v!.verdict).toBe('ISSUES');
    expect(v!.blockers).toHaveLength(1);
    expect(v!.blockers[0]!.summary).toContain('missing tests');
    expect(v!.verification?.suite_result).toBe('fail');
  });

  it('a human ISSUES with no body falls back to a non-empty blocker summary', () => {
    const reviews = openReviewStore('p-hr-verdict-issues-nobody');
    reviewStores.push(reviews);

    recordHumanVerdict(reviews, {
      reviewId: 'rev-human-3',
      target: TARGET,
      branch: BRANCH,
      verdict: 'ISSUES',
    });

    const v = reviews.getVerdict(TARGET, BRANCH);
    expect(v!.blockers).toHaveLength(1);
    expect(v!.blockers[0]!.summary.length).toBeGreaterThan(0);
  });
});

// ── CoReviewGate.triggerReview — human reviewer path (AC-L5-5) ────────────────────────────────────

describe('CoReviewGate.triggerReview — human reviewer path (AC-L5-5)', () => {
  it('human scope: sends sticky actionable review_request to @operator and records review.requested', () => {
    const reviews = openReviewStore('p-hr-trigger');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-hr-trigger');
    worktreeStores.push(worktrees);
    const mail = openMailStore('p-hr-trigger');
    mailStores.push(mail);

    const config = fakeConfig({ [`review.worker_merge.reviewer`]: 'human' });

    const gate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'offline',
      mail,
      config,
    });

    const result = gate.triggerReview({
      reviewId: 'rev-42',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-1',
      scope: 'worker_merge',
      projectId: 'p-hr-trigger',
    });

    // The review.requested record is written.
    expect(result.reviewId).toBe('rev-42');
    expect(reviews.getReviewRequest(TARGET, BRANCH)?.requestedBy).toBe('lead-1');

    // The review_request mail is sent to @operator and is sticky (outstanding).
    const operatorInbox = mail.inbox(OPERATOR);
    const reviewReq = operatorInbox.find((m) => m.type === MAIL_REVIEW_REQUEST);
    expect(reviewReq).toBeDefined();
    expect(reviewReq!.recipient).toBe(OPERATOR);
    expect(reviewReq!.sender).toBe('lead-1');
    expect(reviewReq!.body).toContain('review_verdict');
    expect(reviewReq!.body).not.toContain('reviewVerdict');
    expect(reviewReq!.kind).toBe('actionable');
    expect(reviewReq!.resolved).toBe(false);
    expect(mail.outstandingCount(OPERATOR)).toBe(1);
  });

  it('human scope: no reviewer placement is recorded (agent placement is Phase F only)', () => {
    const reviews = openReviewStore('p-hr-no-placement');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-hr-no-placement');
    worktreeStores.push(worktrees);
    const mail = openMailStore('p-hr-no-placement');
    mailStores.push(mail);

    const config = fakeConfig({ 'review.worker_merge.reviewer': 'human' });
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'offline',
      mail,
      config,
    });

    gate.triggerReview({
      reviewId: 'rev-43',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-1',
      scope: 'worker_merge',
      projectId: 'p-hr-no-placement',
    });

    // No agent-reviewer placement mail (no worker_done, no clarify, etc. — just the review_request).
    const allMail = mail.inbox(OPERATOR);
    expect(allMail.every((m) => m.type === MAIL_REVIEW_REQUEST)).toBe(true);
  });

  it('agent scope (default): records review.requested only, sends NO mail', () => {
    const reviews = openReviewStore('p-hr-agent-scope');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-hr-agent-scope');
    worktreeStores.push(worktrees);
    const mail = openMailStore('p-hr-agent-scope');
    mailStores.push(mail);

    const config = fakeConfig(); // no reviewer override → 'agent'
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'offline',
      mail,
      config,
    });

    gate.triggerReview({
      reviewId: 'rev-44',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-1',
      scope: 'worker_merge',
      projectId: 'p-hr-agent-scope',
    });

    expect(reviews.getReviewRequest(TARGET, BRANCH)?.requestedBy).toBe('lead-1');
    // Agent path: no mail to @operator.
    expect(mail.inbox(OPERATOR)).toHaveLength(0);
  });

  it('no scope/projectId provided: agent path unchanged (backward-compatible)', () => {
    const reviews = openReviewStore('p-hr-compat');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-hr-compat');
    worktreeStores.push(worktrees);

    const gate = new CoReviewGate({ reviews, worktrees, resolveMode: () => 'offline' });
    const result = gate.triggerReview({
      reviewId: 'rev-45',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-1',
    });

    expect(result.reviewId).toBe('rev-45');
    expect(reviews.getReviewRequest(TARGET, BRANCH)?.requestedBy).toBe('lead-1');
  });
});
