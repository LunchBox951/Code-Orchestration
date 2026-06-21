import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  OPERATOR,
  MAIL_ESCALATION,
  MAIL_REVIEW_REQUEST,
  mailKind,
  completionPredicate,
  type MailEnvelope,
  type DeliveredMail,
} from '../mail/events.js';
import { openMailStore, type MailStore } from '../mail/mail-store.js';
import { InProcessDelivery } from '../mail/delivery.js';
import { MailProjector } from '../mail/mail-projector.js';
import { openProjectStore } from '../store/sqlite-store.js';
import type { ConfigStore } from '../config/config-store.js';
import type { SpecStore } from '../specs/specs-store.js';
import { openWorktreeStore, type WorktreeStore } from '../worktrees/worktree-store.js';
import { buildCoreRegistry } from '../tools/core-registry.js';
import { invokeTool } from '../tools/invoke.js';
import type { ToolContext } from '../tools/context.js';
import { openReviewStore, type ReviewStore } from './review-store.js';
import { CoReviewGate } from './merge.js';
import type { ReviewScope } from './ladder.js';
import { acquireMergeSlot, releaseMergeSlot } from './serialize.js';
import {
  resolveReviewerKind,
  reviewRequestOutcome,
  reviewRequestEnvelope,
  buildHumanReviewVerdict,
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
    clearGlobal: () => undefined,
    clearProjectOverride: () => undefined,
    resolveLayers: () => ({ global: {}, project: overrides }),
    close: () => undefined,
  };
}

const TARGET = 'co/l5-review-gate';
const BRANCH = 'co/l5-phase-e';
const FAKE_SHA = 'a'.repeat(40);
const SPEC_REF = 'spec:human-review-task#locked';
const lockedSpecs: Pick<SpecStore, 'getSpec'> = {
  getSpec: (taskId) => ({
    taskId,
    title: 'Locked human review spec',
    goal: 'exercise human review',
    criteria: [{ text: 'human review has displayable criteria', verify: 'pnpm test' }],
    body: '',
    state: 'locked',
    draftedTs: 1,
    lockedBy: OPERATOR,
    lockedTs: 2,
  }),
};

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

function recordHumanRequest(
  reviews: ReviewStore,
  reviewId: string,
  requestedBy = 'lead',
  target = TARGET,
  branch = BRANCH,
  scope: ReviewScope = 'pr_merge',
): void {
  reviews.recordReviewRequested({
    reviewId,
    target,
    branch,
    scope,
    requestedBy,
    reviewerKind: 'human',
    specRefKind: 'criteria',
    specRefRef: SPEC_REF,
  });
}

function requestHumanReviewMail(
  mail: MailStore,
  reviews: ReviewStore,
  params: {
    readonly reviewId: string;
    readonly requestedBy?: string;
    readonly target?: string;
    readonly branch?: string;
    readonly scope?: ReviewScope;
    readonly subject?: string;
    readonly body?: string;
  },
): DeliveredMail {
  const requestedBy = params.requestedBy ?? 'lead-1';
  const target = params.target ?? TARGET;
  const branch = params.branch ?? BRANCH;
  const scope = params.scope ?? 'pr_merge';
  return mail.requestHumanReview(
    {
      type: MAIL_REVIEW_REQUEST,
      to: OPERATOR,
      from: requestedBy,
      subject: params.subject ?? `review requested: '${branch}' into '${target}'`,
      body:
        params.body ?? `Please review this branch. (scope: ${scope}, reviewId: ${params.reviewId})`,
      idempotencyKey: `review-request:${params.reviewId}`,
    },
    {
      reviewId: params.reviewId,
      target,
      branch,
      requestedBy,
      scope,
      reviewerKind: 'human',
      specRefKind: 'criteria',
      specRefRef: SPEC_REF,
    },
  ).mail;
}

function injectLegacyMail(projectId: string, envelope: MailEnvelope): DeliveredMail {
  const store = openProjectStore(projectId);
  try {
    return new InProcessDelivery(projectId, store, [new MailProjector()]).deliver(envelope);
  } finally {
    store.close();
  }
}

function replyWithHumanVerdict(
  mail: MailStore,
  reviews: ReviewStore,
  requestMail: DeliveredMail,
  params: { readonly reviewId: string; readonly verdict: 'PASS' | 'ISSUES'; readonly body: string },
): DeliveredMail {
  return mail.replyWithReviewVerdict(
    requestMail,
    {
      type: 'review_response',
      subject: 're: review?',
      body: params.body,
      from: OPERATOR,
      reviewVerdict: params.verdict,
    },
    buildHumanReviewVerdict(reviews, {
      reviewId: params.reviewId,
      target: TARGET,
      branch: BRANCH,
      verdict: params.verdict,
      body: params.body,
    }),
  );
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
    const reviews = openReviewStore('p-hr-pending');
    reviewStores.push(reviews);
    const req = requestHumanReviewMail(mail, reviews, {
      reviewId: 'rev-hr-outcome-pending',
      requestedBy: 'lead',
      subject: 'review?',
      body: 'please',
    });
    expect(req.recipient).toBe(OPERATOR);
    expect(req.kind).toBe('actionable');

    const reqRow = mail.inbox(OPERATOR).find((m) => m.seq === req.seq)!;
    expect(reviewRequestOutcome(mail, reqRow)).toBe('pending');
    expect(mail.outstandingCount(OPERATOR)).toBe(1);
  });

  it('returns "PASS" once the operator replies with reviewVerdict: PASS', () => {
    const mail = openMailStore('p-hr-pass');
    mailStores.push(mail);
    const reviews = openReviewStore('p-hr-pass');
    reviewStores.push(reviews);
    const req = requestHumanReviewMail(mail, reviews, {
      reviewId: 'rev-hr-outcome-pass',
      requestedBy: 'lead',
      subject: 'review?',
      body: 'please',
    });
    const reqRow = mail.inbox(OPERATOR).find((m) => m.seq === req.seq)!;

    replyWithHumanVerdict(mail, reviews, reqRow, {
      reviewId: 'rev-hr-outcome-pass',
      verdict: 'PASS',
      body: 'looks good',
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
    const reviews = openReviewStore('p-hr-issues');
    reviewStores.push(reviews);
    const req = requestHumanReviewMail(mail, reviews, {
      reviewId: 'rev-hr-outcome-issues',
      requestedBy: 'lead',
      subject: 'review?',
      body: 'please',
    });
    const reqRow = mail.inbox(OPERATOR).find((m) => m.seq === req.seq)!;

    replyWithHumanVerdict(mail, reviews, reqRow, {
      reviewId: 'rev-hr-outcome-issues',
      verdict: 'ISSUES',
      body: 'missing tests',
    });

    const afterReply = mail.inbox(OPERATOR).find((m) => m.seq === req.seq)!;
    expect(reviewRequestOutcome(mail, afterReply)).toBe('ISSUES');
    expect(afterReply.resolved).toBe(true);
  });

  it('ignores a review_response not sent by the holder (@operator) back to the requester', () => {
    const projectId = 'p-hr-spoof';
    const mail = openMailStore(projectId);
    mailStores.push(mail);
    const reviews = openReviewStore(projectId);
    reviewStores.push(reviews);
    const req = requestHumanReviewMail(mail, reviews, {
      reviewId: 'rev-hr-outcome-spoof',
      requestedBy: 'lead',
      subject: 'review?',
      body: 'please',
    });
    // A spoofed review_response from an intruder — must not resolve the request.
    injectLegacyMail(projectId, {
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
  it('requires a durable human review.requested row before recording a verdict', () => {
    const reviews = openReviewStore('p-hr-verdict-requires-request');
    reviewStores.push(reviews);

    expect(() =>
      recordHumanVerdict(reviews, {
        reviewId: 'rev-human-missing-request',
        target: TARGET,
        branch: BRANCH,
        verdict: 'PASS',
      }),
    ).toThrow(/review\.requested|human review_request/i);
  });

  it('a human PASS verdict is recorded and found by getVerdict', () => {
    const reviews = openReviewStore('p-hr-verdict-pass');
    reviewStores.push(reviews);
    recordHumanRequest(reviews, 'rev-human-1');

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
    recordHumanRequest(reviews, 'rev-human-pr');

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
    recordHumanRequest(reviews, 'rev-human-pr-push');
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
      specs: lockedSpecs,
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
      specRef: SPEC_REF,
    });

    const persistedRequest = reviews.getReviewRequest(TARGET, BRANCH);
    expect(persistedRequest?.scope).toBe('pr_merge');
    const requestMail = mail.inbox(OPERATOR).find((m) => m.type === 'review_request')!;
    replyWithHumanVerdict(mail, reviews, requestMail, {
      reviewId: persistedRequest!.reviewId,
      verdict: 'PASS',
      body: 'passes',
    });
    const outcome = reviewRequestOutcome(mail, requestMail);
    if (outcome !== 'PASS') throw new Error(`expected human PASS, got ${outcome}`);

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

  it('co_mail_send review_response is refused and cannot unblock push', async () => {
    const projectId = 'p-hr-mail-send-reentry';
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
      specs: lockedSpecs,
      config: fakeConfig({ 'review.pr_merge.reviewer': 'human' }),
      resolveMode: () => 'offline',
    });
    requestGate.triggerReview({
      reviewId: 'rev-human-mail-send',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-1',
      scope: 'pr_merge',
      projectId,
      specRef: SPEC_REF,
    });
    const requestMail = mail.inbox(OPERATOR).find((m) => m.type === 'review_request')!;
    const registry = buildCoreRegistry();
    const ctx: ToolContext = {
      agent: OPERATOR,
      projectId,
      cwd: '/repo',
      mail,
      registry: { resolve: () => projectId } as never,
      reviews,
      worktrees,
    };

    await expect(
      invokeTool(registry, ctx, 'co_mail_send', {
        type: 'review_response',
        in_reply_to: requestMail.seq,
        subject: 're: review requested',
        body: 'passes',
        review_verdict: 'PASS',
      }),
    ).rejects.toThrow(/schema validation/i);

    expect(reviews.getVerdict(TARGET, BRANCH, 'pr_merge')).toBeUndefined();
    expect(mail.inbox('lead-1').filter((m) => m.type === 'review_response')).toHaveLength(0);
    expect(mail.inbox(OPERATOR).find((m) => m.seq === requestMail.seq)?.resolved).toBe(false);
    const git = recordingGitExec();
    const publishGate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'owner',
      gitExec: git.exec,
    });
    expect(() =>
      publishGate.push({ branch: BRANCH, into: TARGET, projectId, repoCwd: '/repo' }),
    ).toThrow(/no review verdict is recorded|PASS/i);
    expect(git.calls).toEqual([]);
  });

  it('co_mail_send review_response does not reply if atomic review verdict validation fails', async () => {
    const projectId = 'p-hr-mail-send-record-fail';
    const reviews = openReviewStore(projectId);
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore(projectId);
    worktreeStores.push(worktrees);
    const mail = openMailStore(projectId);
    mailStores.push(mail);
    const requestMail = injectLegacyMail(projectId, {
      type: MAIL_REVIEW_REQUEST,
      to: OPERATOR,
      from: 'lead-1',
      subject: `review requested: '${BRANCH}' into '${TARGET}'`,
      body: 'Please review this branch. (scope: pr_merge, reviewId: rev-human-mail-send-record-fail)',
      idempotencyKey: 'review-request:rev-human-mail-send-record-fail',
    });
    const fakeRequest = {
      reviewId: 'rev-human-mail-send-record-fail',
      target: TARGET,
      branch: BRANCH,
      scope: 'pr_merge' as const,
      reviewerKind: 'human' as const,
      requestedBy: 'lead-1',
      requestedTs: 1,
      specRef: { kind: 'no-locked-spec' as const },
    };
    const failingReviews: ReviewStore = {
      ...reviews,
      getReviewRequest: () => fakeRequest,
      getReviewRequestById: () => fakeRequest,
    };
    const registry = buildCoreRegistry();
    const ctx: ToolContext = {
      agent: OPERATOR,
      projectId,
      cwd: '/repo',
      mail,
      registry: { resolve: () => projectId } as never,
      reviews: failingReviews,
      worktrees,
    };

    await expect(
      invokeTool(registry, ctx, 'co_mail_send', {
        type: 'review_response',
        in_reply_to: requestMail.seq,
        subject: 're: review requested',
        body: 'passes',
        review_verdict: 'PASS',
      }),
    ).rejects.toThrow(/schema validation/i);

    expect(reviews.getVerdict(TARGET, BRANCH, 'pr_merge')).toBeUndefined();
    expect(mail.inbox('lead-1').filter((m) => m.type === 'review_response')).toHaveLength(0);
    expect(mail.inbox(OPERATOR).find((m) => m.seq === requestMail.seq)?.resolved).toBe(false);
    expect(mail.outstandingCount(OPERATOR)).toBe(1);
  });

  it('co_mail_send review_response rejects idempotency-keyed replies before recording verdicts', async () => {
    const projectId = 'p-hr-mail-send-idem-mismatch';
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
      specs: lockedSpecs,
      config: fakeConfig({ 'review.pr_merge.reviewer': 'human' }),
      resolveMode: () => 'offline',
    });
    requestGate.triggerReview({
      reviewId: 'rev-human-mail-send-idem-mismatch',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-1',
      scope: 'pr_merge',
      projectId,
      specRef: SPEC_REF,
    });
    const requestMail = mail.inbox(OPERATOR).find((m) => m.type === 'review_request')!;
    const registry = buildCoreRegistry();
    const ctx: ToolContext = {
      agent: OPERATOR,
      projectId,
      cwd: '/repo',
      mail,
      registry: { resolve: () => projectId } as never,
      reviews,
      worktrees,
    };

    await expect(
      invokeTool(registry, ctx, 'co_mail_send', {
        type: 'review_response',
        in_reply_to: requestMail.seq,
        subject: 're: review requested',
        body: 'passes',
        review_verdict: 'PASS',
        idempotency_key: 'human-review-response:idem-mismatch',
      }),
    ).rejects.toThrow(/schema validation/i);

    expect(reviews.getVerdict(TARGET, BRANCH, 'pr_merge')).toBeUndefined();
    expect(mail.inbox('lead-1').filter((m) => m.type === 'review_response')).toHaveLength(0);
  });

  it('co_mail_send review_response refuses cross-request idempotency attempts before side effects', async () => {
    const projectId = 'p-hr-mail-send-idem-cross-request';
    const reviews = openReviewStore(projectId);
    reviewStores.push(reviews);
    const mail = openMailStore(projectId);
    mailStores.push(mail);
    const firstBranch = 'co/first-review';
    const secondBranch = 'co/second-review';
    const firstMail = requestHumanReviewMail(mail, reviews, {
      reviewId: 'rev-human-idem-first',
      target: `${TARGET}-first`,
      branch: firstBranch,
      requestedBy: 'lead-1',
    });
    requestHumanReviewMail(mail, reviews, {
      reviewId: 'rev-human-idem-second',
      target: `${TARGET}-second`,
      branch: secondBranch,
      requestedBy: 'lead-1',
    });
    const registry = buildCoreRegistry();
    const ctx: ToolContext = {
      agent: OPERATOR,
      projectId,
      cwd: '/repo',
      mail,
      registry: { resolve: () => projectId } as never,
      reviews,
    };

    await expect(
      invokeTool(registry, ctx, 'co_mail_send', {
        type: 'review_response',
        in_reply_to: firstMail.seq,
        subject: 're: first',
        body: 'passes',
        review_verdict: 'PASS',
        idempotency_key: 'human-review-response:cross-request',
      }),
    ).rejects.toThrow(/schema validation/i);

    expect(reviews.getVerdict(`${TARGET}-first`, firstBranch, 'pr_merge')).toBeUndefined();
    expect(reviews.getVerdict(`${TARGET}-second`, secondBranch, 'pr_merge')).toBeUndefined();
    expect(mail.inbox('lead-1').filter((m) => m.type === 'review_response')).toHaveLength(0);
  });

  it('co_mail_send review_response refuses body-changing idempotency attempts before side effects', async () => {
    const projectId = 'p-hr-mail-send-idem-same-verdict';
    const reviews = openReviewStore(projectId);
    reviewStores.push(reviews);
    const mail = openMailStore(projectId);
    mailStores.push(mail);
    const requestMail = requestHumanReviewMail(mail, reviews, {
      reviewId: 'rev-human-idem-same-verdict',
      requestedBy: 'lead-1',
    });
    const registry = buildCoreRegistry();
    const ctx: ToolContext = {
      agent: OPERATOR,
      projectId,
      cwd: '/repo',
      mail,
      registry: { resolve: () => projectId } as never,
      reviews,
    };

    await expect(
      invokeTool(registry, ctx, 'co_mail_send', {
        type: 'review_response',
        in_reply_to: requestMail.seq,
        subject: 're: review requested',
        body: 'first blocker',
        review_verdict: 'ISSUES',
        idempotency_key: 'human-review-response:same-verdict',
      }),
    ).rejects.toThrow(/schema validation/i);

    expect(reviews.getVerdict(TARGET, BRANCH, 'pr_merge')).toBeUndefined();
    expect(mail.inbox('lead-1').filter((m) => m.type === 'review_response')).toHaveLength(0);
  });

  it('co_mail_send review_response refuses exact idempotency retries before side effects', async () => {
    const projectId = 'p-hr-mail-send-idem-exact';
    const reviews = openReviewStore(projectId);
    reviewStores.push(reviews);
    const mail = openMailStore(projectId);
    mailStores.push(mail);
    const requestMail = requestHumanReviewMail(mail, reviews, {
      reviewId: 'rev-human-idem-exact',
      requestedBy: 'lead-1',
    });
    const registry = buildCoreRegistry();
    const ctx: ToolContext = {
      agent: OPERATOR,
      projectId,
      cwd: '/repo',
      mail,
      registry: { resolve: () => projectId } as never,
      reviews,
    };

    await expect(
      invokeTool(registry, ctx, 'co_mail_send', {
        type: 'review_response',
        in_reply_to: requestMail.seq,
        subject: 're: review requested',
        body: 'passes',
        review_verdict: 'PASS',
        idempotency_key: 'human-review-response:exact',
      }),
    ).rejects.toThrow(/schema validation/i);

    expect(reviews.getVerdict(TARGET, BRANCH, 'pr_merge')).toBeUndefined();
    expect(mail.inbox('lead-1').filter((m) => m.type === 'review_response')).toHaveLength(0);
  });

  it('mail-store review verdict replies treat exact same-key retries as no-ops after resolution', () => {
    const projectId = 'p-hr-mail-store-idem-exact';
    const reviews = openReviewStore(projectId);
    reviewStores.push(reviews);
    const mail = openMailStore(projectId);
    mailStores.push(mail);
    const requestMail = requestHumanReviewMail(mail, reviews, {
      reviewId: 'rev-human-store-idem-exact',
      requestedBy: 'lead-1',
    });
    const draft = {
      type: 'review_response' as const,
      subject: 're: review requested',
      body: 'passes',
      from: OPERATOR,
      reviewVerdict: 'PASS' as const,
      idempotencyKey: 'human-review-response:store-exact',
    };
    const verdict = buildHumanReviewVerdict(reviews, {
      reviewId: 'rev-human-store-idem-exact',
      target: TARGET,
      branch: BRANCH,
      verdict: 'PASS',
      body: 'passes',
    });

    const first = mail.replyWithReviewVerdict(requestMail, draft, verdict);
    const second = mail.replyWithReviewVerdict(requestMail, draft, verdict);

    expect(second).toEqual(first);
    expect(mail.inbox('lead-1').filter((m) => m.type === 'review_response')).toHaveLength(1);
  });

  it('mail-store human review requests require a matching review_request envelope', () => {
    const projectId = 'p-hr-mail-store-request-envelope';
    const mail = openMailStore(projectId);
    mailStores.push(mail);
    const request = {
      reviewId: 'rev-human-request-envelope',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-1',
      scope: 'pr_merge' as const,
      reviewerKind: 'human' as const,
    };

    expect(() =>
      mail.requestHumanReview(
        {
          type: 'chat',
          to: OPERATOR,
          from: 'lead-1',
          subject: 'not a review request',
          body: 'stuck',
          idempotencyKey: 'review-request:rev-human-request-envelope',
        },
        request,
      ),
    ).toThrow(/review_request/i);
    expect(() =>
      mail.requestHumanReview(
        {
          type: MAIL_REVIEW_REQUEST,
          to: OPERATOR,
          from: 'lead-2',
          subject: 'review requested',
          body: 'wrong sender',
          idempotencyKey: 'review-request:rev-human-request-envelope',
        },
        request,
      ),
    ).toThrow(/requestedBy|sender/i);
    expect(() =>
      mail.requestHumanReview(
        {
          type: MAIL_REVIEW_REQUEST,
          to: OPERATOR,
          from: 'lead-1',
          subject: 'review requested',
          body: 'wrong key',
          idempotencyKey: 'review-request:another',
        },
        request,
      ),
    ).toThrow(/idempotency/i);
  });

  it('mail-store human review requests reject conflicting idempotency state', () => {
    const projectId = 'p-hr-mail-store-request-idem-conflict';
    const mail = openMailStore(projectId);
    mailStores.push(mail);
    injectLegacyMail(projectId, {
      type: MAIL_REVIEW_REQUEST,
      to: OPERATOR,
      from: 'lead-1',
      subject: 'legacy review request',
      body: 'partial legacy state',
      idempotencyKey: 'review-request:rev-human-idem-conflict',
    });

    expect(() =>
      mail.requestHumanReview(
        {
          type: MAIL_REVIEW_REQUEST,
          to: OPERATOR,
          from: 'lead-1',
          subject: 'review requested',
          body: 'new request',
          idempotencyKey: 'review-request:rev-human-idem-conflict',
        },
        {
          reviewId: 'rev-human-idem-conflict',
          target: TARGET,
          branch: BRANCH,
          requestedBy: 'lead-1',
          scope: 'pr_merge',
          reviewerKind: 'human',
        },
      ),
    ).toThrow(/idempotency|existing/i);
    expect(mail.inbox(OPERATOR).filter((m) => m.type === MAIL_REVIEW_REQUEST)).toHaveLength(1);
  });

  it('mail-store human review requests reject legacy duplicate reviewIds before side effects', () => {
    const projectId = 'p-hr-mail-store-legacy-duplicate-review-id';
    const reviews = openReviewStore(projectId);
    reviewStores.push(reviews);
    recordHumanRequest(reviews, 'rev-human-legacy-dup', 'lead-1', TARGET, 'co/original');
    const raw = openProjectStore(projectId);
    try {
      raw.transaction((tx) => {
        (tx.raw as DatabaseSync).exec('DROP TABLE review_request_ids');
      });
    } finally {
      raw.close();
    }
    const mail = openMailStore(projectId);
    mailStores.push(mail);

    expect(() =>
      mail.requestHumanReview(
        {
          type: MAIL_REVIEW_REQUEST,
          to: OPERATOR,
          from: 'lead-1',
          subject: 'review requested',
          body: 'new request',
          idempotencyKey: 'review-request:rev-human-legacy-dup',
        },
        {
          reviewId: 'rev-human-legacy-dup',
          target: TARGET,
          branch: 'co/another',
          requestedBy: 'lead-1',
          scope: 'pr_merge',
          reviewerKind: 'human',
        },
      ),
    ).toThrow(/duplicate reviewId.*already belongs/i);
    expect(mail.inbox(OPERATOR).filter((m) => m.type === MAIL_REVIEW_REQUEST)).toHaveLength(0);
    expect(reviews.getReviewRequest(TARGET, 'co/another')).toBeUndefined();
  });

  it('human review trigger refuses a different reviewId while the first request is pending', () => {
    const projectId = 'p-hr-pending-rerequest';
    const reviews = openReviewStore(projectId);
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore(projectId);
    worktreeStores.push(worktrees);
    const mail = openMailStore(projectId);
    mailStores.push(mail);
    const gate = new CoReviewGate({
      reviews,
      worktrees,
      mail,
      specs: lockedSpecs,
      resolveMode: () => 'offline',
      config: fakeConfig({ 'review.pr_merge.reviewer': 'human' }),
    });

    gate.triggerReview({
      reviewId: 'rev-human-pending-1',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-1',
      scope: 'pr_merge',
      projectId,
      specRef: SPEC_REF,
    });

    expect(() =>
      gate.triggerReview({
        reviewId: 'rev-human-pending-2',
        target: TARGET,
        branch: BRANCH,
        requestedBy: 'lead-1',
        scope: 'pr_merge',
        projectId,
        specRef: SPEC_REF,
      }),
    ).toThrow(/pending|active review request/i);
    expect(mail.inbox(OPERATOR).filter((m) => m.type === MAIL_REVIEW_REQUEST)).toHaveLength(1);
    expect(reviews.getReviewRequest(TARGET, BRANCH)?.reviewId).toBe('rev-human-pending-1');
  });

  it('mail-store review verdict replies require the durable request mail and matching response payload', () => {
    const projectId = 'p-hr-mail-store-reply-envelope';
    const reviews = openReviewStore(projectId);
    reviewStores.push(reviews);
    const mail = openMailStore(projectId);
    mailStores.push(mail);
    const requestMail = requestHumanReviewMail(mail, reviews, {
      reviewId: 'rev-human-store-reply-envelope',
      requestedBy: 'lead-1',
    });
    const chatMail = mail.send({
      type: 'chat',
      to: OPERATOR,
      from: 'lead-1',
      subject: 'not the review request',
      body: 'hello',
    });
    const verdict = buildHumanReviewVerdict(reviews, {
      reviewId: 'rev-human-store-reply-envelope',
      target: TARGET,
      branch: BRANCH,
      verdict: 'PASS',
      body: 'passes',
    });

    expect(() =>
      mail.replyWithReviewVerdict(
        chatMail,
        {
          type: 'review_response',
          subject: 're: review requested',
          body: 'passes',
          from: OPERATOR,
          reviewVerdict: 'PASS',
        },
        verdict,
      ),
    ).toThrow(/review_request/i);
    expect(() =>
      mail.replyWithReviewVerdict(
        requestMail,
        {
          type: 'chat',
          subject: 're: review requested',
          body: 'passes',
          from: OPERATOR,
          reviewVerdict: 'PASS',
        },
        verdict,
      ),
    ).toThrow(/review_response/i);
    expect(() =>
      mail.replyWithReviewVerdict(
        requestMail,
        {
          type: 'review_response',
          subject: 're: review requested',
          body: 'passes',
          from: OPERATOR,
          reviewVerdict: 'ISSUES',
        },
        verdict,
      ),
    ).toThrow(/review_verdict/i);
    expect(reviews.getVerdict(TARGET, BRANCH, 'pr_merge')).toBeUndefined();
    expect(mail.inbox('lead-1').filter((m) => m.type === 'review_response')).toHaveLength(0);
  });

  it('mail-store generic reply refuses review_response mail', () => {
    const projectId = 'p-hr-mail-store-generic-review-response';
    const reviews = openReviewStore(projectId);
    reviewStores.push(reviews);
    const mail = openMailStore(projectId);
    mailStores.push(mail);
    const requestMail = requestHumanReviewMail(mail, reviews, {
      reviewId: 'rev-generic-review-response',
      requestedBy: 'lead-1',
      subject: 'review requested',
      body: 'please review',
    });

    expect(() =>
      mail.reply(requestMail, {
        type: 'review_response',
        subject: 're: review requested',
        body: 'passes',
        from: OPERATOR,
        reviewVerdict: 'PASS',
      }),
    ).toThrow(/replyWithReviewVerdict|review_response/i);
  });

  it('mail-store generic send refuses review_request and review_response mail', () => {
    const projectId = 'p-hr-mail-store-generic-review-send';
    const mail = openMailStore(projectId);
    mailStores.push(mail);

    expect(() =>
      mail.send({
        type: MAIL_REVIEW_REQUEST,
        to: OPERATOR,
        from: 'lead-1',
        subject: 'review requested',
        body: 'please review',
        idempotencyKey: 'review-request:rev-generic-review-send',
      }),
    ).toThrow(/requestHumanReview|review_request/i);
    expect(() =>
      mail.send({
        type: 'review_response',
        to: 'lead-1',
        from: OPERATOR,
        subject: 're: review requested',
        body: 'passes',
        correlationId: '1',
        causationId: '1',
        reviewVerdict: 'PASS',
      }),
    ).toThrow(/replyWithReviewVerdict|review_response/i);
  });

  it('mail-store generic resolve refuses review_request and review_response mail', () => {
    const projectId = 'p-hr-mail-store-generic-review-resolve';
    const mail = openMailStore(projectId);
    mailStores.push(mail);
    const heldForRequest = mail.send({
      type: MAIL_ESCALATION,
      to: 'lead-1',
      from: OPERATOR,
      subject: 'blocked',
      body: 'needs action',
    });
    const heldForResponse = mail.send({
      type: MAIL_ESCALATION,
      to: 'lead-1',
      from: 'worker-1',
      subject: 'blocked',
      body: 'needs action',
    });

    expect(() =>
      mail.resolve(heldForRequest, {
        type: MAIL_REVIEW_REQUEST,
        to: OPERATOR,
        from: 'lead-1',
        subject: 'review requested',
        body: 'please review',
        causationId: String(heldForRequest.seq),
        correlationId: String(heldForRequest.seq),
      }),
    ).toThrow(/requestHumanReview|review_request/i);
    expect(() =>
      mail.resolve(heldForResponse, {
        type: 'review_response',
        to: 'worker-1',
        from: 'lead-1',
        subject: 're: review requested',
        body: 'passes',
        causationId: String(heldForResponse.seq),
        correlationId: String(heldForResponse.seq),
        reviewVerdict: 'PASS',
      }),
    ).toThrow(/replyWithReviewVerdict|review_response/i);
    expect(mail.inbox(OPERATOR).filter((m) => m.type === MAIL_REVIEW_REQUEST)).toHaveLength(0);
    expect(mail.inbox('worker-1').filter((m) => m.type === 'review_response')).toHaveLength(0);
  });

  it('mail-store review verdict replies require reviewer provenance to match the response sender', () => {
    const projectId = 'p-hr-mail-store-reply-reviewer-provenance';
    const reviews = openReviewStore(projectId);
    reviewStores.push(reviews);
    const mail = openMailStore(projectId);
    mailStores.push(mail);
    const requestMail = mail.requestHumanReview(
      {
        type: MAIL_REVIEW_REQUEST,
        to: OPERATOR,
        from: 'lead-1',
        subject: 'review requested',
        body: 'please review',
        idempotencyKey: 'review-request:rev-human-reviewer-provenance',
      },
      {
        reviewId: 'rev-human-reviewer-provenance',
        target: TARGET,
        branch: BRANCH,
        requestedBy: 'lead-1',
        scope: 'pr_merge',
        reviewerKind: 'human',
      },
    ).mail;
    const verdict = buildHumanReviewVerdict(reviews, {
      reviewId: 'rev-human-reviewer-provenance',
      target: TARGET,
      branch: BRANCH,
      verdict: 'PASS',
      body: 'passes',
    });

    expect(() =>
      mail.replyWithReviewVerdict(
        requestMail,
        {
          type: 'review_response',
          subject: 're: review requested',
          body: 'passes',
          from: 'operator-proxy',
          reviewVerdict: 'PASS',
        },
        verdict,
      ),
    ).toThrow(/sender|reviewer/i);
  });

  it('mail-store refuses to retract review request and response mail', () => {
    const projectId = 'p-hr-mail-store-review-retract';
    const reviews = openReviewStore(projectId);
    reviewStores.push(reviews);
    const mail = openMailStore(projectId);
    mailStores.push(mail);
    const requestMail = mail.requestHumanReview(
      {
        type: MAIL_REVIEW_REQUEST,
        to: OPERATOR,
        from: 'lead-1',
        subject: 'review requested',
        body: 'please review',
        idempotencyKey: 'review-request:rev-human-retract',
      },
      {
        reviewId: 'rev-human-retract',
        target: TARGET,
        branch: BRANCH,
        requestedBy: 'lead-1',
        scope: 'pr_merge',
        reviewerKind: 'human',
      },
    ).mail;
    const verdict = buildHumanReviewVerdict(reviews, {
      reviewId: 'rev-human-retract',
      target: TARGET,
      branch: BRANCH,
      verdict: 'PASS',
      body: 'passes',
    });
    const responseMail = mail.replyWithReviewVerdict(
      requestMail,
      {
        type: 'review_response',
        subject: 're: review requested',
        body: 'passes',
        from: OPERATOR,
        reviewVerdict: 'PASS',
        idempotencyKey: 'review-response:rev-human-retract',
      },
      verdict,
    );

    expect(() => mail.retract('lead-1', requestMail.seq)).toThrow(/review_request|review mail/i);
    expect(() => mail.retract(OPERATOR, responseMail.seq)).toThrow(/review_response|review mail/i);
    expect(mail.inbox(OPERATOR).some((m) => m.seq === requestMail.seq)).toBe(true);
    expect(reviews.getVerdict(TARGET, BRANCH, 'pr_merge')?.verdict).toBe('PASS');
  });

  it('co_mail_send review_response refuses verdicts before resolving review requests', async () => {
    const projectId = 'p-hr-mail-send-resolved-request';
    const reviews = openReviewStore(projectId);
    reviewStores.push(reviews);
    const mail = openMailStore(projectId);
    mailStores.push(mail);
    const requestMail = requestHumanReviewMail(mail, reviews, {
      reviewId: 'rev-human-resolved-request',
      requestedBy: 'lead-1',
    });
    const registry = buildCoreRegistry();
    const ctx: ToolContext = {
      agent: OPERATOR,
      projectId,
      cwd: '/repo',
      mail,
      registry: { resolve: () => projectId } as never,
      reviews,
    };

    await expect(
      invokeTool(registry, ctx, 'co_mail_send', {
        type: 'review_response',
        in_reply_to: requestMail.seq,
        subject: 're: review requested',
        body: 'passes',
        review_verdict: 'PASS',
      }),
    ).rejects.toThrow(/schema validation/i);

    expect(reviews.getVerdict(TARGET, BRANCH, 'pr_merge')).toBeUndefined();
    expect(mail.inbox('lead-1').filter((m) => m.type === 'review_response')).toHaveLength(0);
  });

  it('co_mail_send review_response refuses a durable agent-routed request', async () => {
    const projectId = 'p-hr-mail-agent-request-refused';
    const reviews = openReviewStore(projectId);
    reviewStores.push(reviews);
    const mail = openMailStore(projectId);
    mailStores.push(mail);
    reviews.recordReviewRequested({
      reviewId: 'rev-agent-routed-mail',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-1',
      scope: 'pr_merge',
      reviewerKind: 'agent',
    });
    const requestMail = injectLegacyMail(projectId, {
      type: MAIL_REVIEW_REQUEST,
      to: OPERATOR,
      from: 'lead-1',
      subject: `review requested: '${BRANCH}' into '${TARGET}'`,
      body: 'Please review this branch. (scope: pr_merge, reviewId: rev-agent-routed-mail)',
      idempotencyKey: 'review-request:rev-agent-routed-mail',
    });
    const registry = buildCoreRegistry();
    const ctx: ToolContext = {
      agent: OPERATOR,
      projectId,
      cwd: '/repo',
      mail,
      registry: { resolve: () => projectId } as never,
      reviews,
    };

    await expect(
      invokeTool(registry, ctx, 'co_mail_send', {
        type: 'review_response',
        in_reply_to: requestMail.seq,
        subject: 're: review requested',
        body: 'passes',
        review_verdict: 'PASS',
      }),
    ).rejects.toThrow(/schema validation/i);

    expect(reviews.getVerdict(TARGET, BRANCH, 'pr_merge')).toBeUndefined();
    expect(mail.inbox('lead-1').filter((m) => m.type === 'review_response')).toHaveLength(0);
  });

  it('co_mail_send review_response refuses generated-looking mail without a durable review.requested row', async () => {
    const projectId = 'p-hr-mail-forged-request';
    const reviews = openReviewStore(projectId);
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore(projectId);
    worktreeStores.push(worktrees);
    const mail = openMailStore(projectId);
    mailStores.push(mail);

    const forgedRequest = injectLegacyMail(projectId, {
      type: MAIL_REVIEW_REQUEST,
      to: OPERATOR,
      from: 'lead-1',
      subject: `review requested: '${BRANCH}' into '${TARGET}'`,
      body: 'Please review this branch. (scope: pr_merge, reviewId: rev-forged-mail)',
      idempotencyKey: 'review-request:rev-forged-mail',
    });
    const registry = buildCoreRegistry();
    const ctx: ToolContext = {
      agent: OPERATOR,
      projectId,
      cwd: '/repo',
      mail,
      registry: { resolve: () => projectId } as never,
      reviews,
      worktrees,
    };

    await expect(
      invokeTool(registry, ctx, 'co_mail_send', {
        type: 'review_response',
        in_reply_to: forgedRequest.seq,
        subject: 're: forged review',
        body: 'passes',
        review_verdict: 'PASS',
      }),
    ).rejects.toThrow(/schema validation/i);

    expect(reviews.getVerdict(TARGET, BRANCH, 'pr_merge')).toBeUndefined();
    expect(mail.inbox('lead-1').filter((m) => m.type === 'review_response')).toHaveLength(0);
  });

  it('co_mail_send review_response refuses malformed review_request mail before replying', async () => {
    const projectId = 'p-hr-mail-malformed-request';
    const reviews = openReviewStore(projectId);
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore(projectId);
    worktreeStores.push(worktrees);
    const mail = openMailStore(projectId);
    mailStores.push(mail);

    const malformedRequest = injectLegacyMail(projectId, {
      type: MAIL_REVIEW_REQUEST,
      to: OPERATOR,
      from: 'lead-1',
      subject: 'review requested',
      body: 'Please review this branch.',
    });
    const registry = buildCoreRegistry();
    const ctx: ToolContext = {
      agent: OPERATOR,
      projectId,
      cwd: '/repo',
      mail,
      registry: { resolve: () => projectId } as never,
      reviews,
      worktrees,
    };

    await expect(
      invokeTool(registry, ctx, 'co_mail_send', {
        type: 'review_response',
        in_reply_to: malformedRequest.seq,
        subject: 're: malformed review',
        body: 'passes',
        review_verdict: 'PASS',
      }),
    ).rejects.toThrow(/schema validation/i);

    expect(mail.inbox('lead-1').filter((m) => m.type === 'review_response')).toHaveLength(0);
  });

  it('co_mail_send review_response to a review_request requires an injected review store', async () => {
    const projectId = 'p-hr-mail-send-no-review-store';
    const mail = openMailStore(projectId);
    mailStores.push(mail);

    const requestMail = injectLegacyMail(projectId, {
      type: MAIL_REVIEW_REQUEST,
      to: OPERATOR,
      from: 'lead-1',
      subject: `review requested: '${BRANCH}' into '${TARGET}'`,
      body: 'Please review this branch. (scope: pr_merge, reviewId: rev-no-review-store)',
    });
    const registry = buildCoreRegistry();
    const ctx: ToolContext = {
      agent: OPERATOR,
      projectId,
      cwd: '/repo',
      mail,
      registry: { resolve: () => projectId } as never,
    };

    await expect(
      invokeTool(registry, ctx, 'co_mail_send', {
        type: 'review_response',
        in_reply_to: requestMail.seq,
        subject: 're: review',
        body: 'passes',
        review_verdict: 'PASS',
      }),
    ).rejects.toThrow(/schema validation/i);

    expect(mail.inbox('lead-1').filter((m) => m.type === 'review_response')).toHaveLength(0);
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
      reviewerKind: 'human',
      specRefKind: 'criteria',
      specRefRef: SPEC_REF,
    });
    reviews.recordReviewRequested({
      reviewId: 'rev-pr-new',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-1',
      scope: 'pr_merge',
      reviewerKind: 'human',
      specRefKind: 'criteria',
      specRefRef: SPEC_REF,
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
    recordHumanRequest(reviews, 'rev-human-2');

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

  it('a human ISSUES verdict releases this branch active review slot', () => {
    const reviews = openReviewStore('p-hr-verdict-issues-release');
    reviewStores.push(reviews);
    acquireMergeSlot(reviews, TARGET, BRANCH);
    recordHumanRequest(reviews, 'rev-human-issues-release');

    recordHumanVerdict(reviews, {
      reviewId: 'rev-human-issues-release',
      target: TARGET,
      branch: BRANCH,
      verdict: 'ISSUES',
      body: 'needs another pass',
    });

    expect(reviews.getVerdict(TARGET, BRANCH)?.verdict).toBe('ISSUES');
    expect(reviews.activeSerialized(TARGET)).toBeUndefined();
  });

  it('a human ISSUES verdict is not recorded if active slot release fails', () => {
    const reviews = openReviewStore('p-hr-verdict-issues-release-fail');
    reviewStores.push(reviews);
    recordHumanRequest(reviews, 'rev-human-issues-release-fail');
    let recordCalled = false;
    const failingReviews: ReviewStore = {
      ...reviews,
      recordVerdictAndRelease: () => {
        throw new Error('verdict/release store unavailable');
      },
      recordVerdict: (verdict) => {
        recordCalled = true;
        return reviews.recordVerdict(verdict);
      },
    };

    expect(() =>
      recordHumanVerdict(failingReviews, {
        reviewId: 'rev-human-issues-release-fail',
        target: TARGET,
        branch: BRANCH,
        verdict: 'ISSUES',
        body: 'needs another pass',
      }),
    ).toThrow(/verdict\/release store unavailable/);

    expect(recordCalled).toBe(false);
    expect(reviews.getVerdict(TARGET, BRANCH)).toBeUndefined();
  });

  it('a human ISSUES with no body falls back to a non-empty blocker summary', () => {
    const reviews = openReviewStore('p-hr-verdict-issues-nobody');
    reviewStores.push(reviews);
    recordHumanRequest(reviews, 'rev-human-3');

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
      specs: lockedSpecs,
      config,
    });

    const result = gate.triggerReview({
      reviewId: 'rev-42',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-1',
      scope: 'worker_merge',
      projectId: 'p-hr-trigger',
      specRef: SPEC_REF,
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
    expect(reviewReq!.body).toContain('Open the Reviews view');
    expect(reviewReq!.body).not.toContain('Reply with a review_response');
    expect(reviewReq!.kind).toBe('actionable');
    expect(reviewReq!.resolved).toBe(false);
    expect(mail.outstandingCount(OPERATOR)).toBe(1);
  });

  it('human scope: duplicate request with the same canonical fields does not send duplicate mail', () => {
    const reviews = openReviewStore('p-hr-trigger-dup');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-hr-trigger-dup');
    worktreeStores.push(worktrees);
    const mail = openMailStore('p-hr-trigger-dup');
    mailStores.push(mail);

    const gate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'offline',
      mail,
      specs: lockedSpecs,
      config: fakeConfig({ 'review.worker_merge.reviewer': 'human' }),
    });

    const input = {
      reviewId: 'rev-dup-human',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-1',
      scope: 'worker_merge' as const,
      projectId: 'p-hr-trigger-dup',
      specRef: SPEC_REF,
    };
    const first = gate.triggerReview(input);
    const second = gate.triggerReview(input);

    expect(second).toEqual(first);
    expect(mail.inbox(OPERATOR).filter((m) => m.type === MAIL_REVIEW_REQUEST)).toHaveLength(1);
    expect(mail.outstandingCount(OPERATOR)).toBe(1);
  });

  it('human scope: idempotent retry repairs a missing serialized slot', () => {
    const reviews = openReviewStore('p-hr-trigger-dup-repair-slot');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-hr-trigger-dup-repair-slot');
    worktreeStores.push(worktrees);
    const mail = openMailStore('p-hr-trigger-dup-repair-slot');
    mailStores.push(mail);

    const gate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'offline',
      mail,
      specs: lockedSpecs,
      config: fakeConfig({ 'review.worker_merge.reviewer': 'human' }),
    });
    const input = {
      reviewId: 'rev-dup-human-repair-slot',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-1',
      scope: 'worker_merge' as const,
      projectId: 'p-hr-trigger-dup-repair-slot',
      specRef: SPEC_REF,
    };
    gate.triggerReview(input);
    releaseMergeSlot(reviews, TARGET, BRANCH);
    expect(reviews.activeSerialized(TARGET)).toBeUndefined();

    const retry = gate.triggerReview(input);

    expect(retry.reviewId).toBe(input.reviewId);
    expect(reviews.activeSerialized(TARGET)).toBe(BRANCH);
    expect(mail.inbox(OPERATOR).filter((m) => m.type === MAIL_REVIEW_REQUEST)).toHaveLength(1);
  });

  it('human scope: pending review holds the target slot and blocks competing branches', () => {
    const reviews = openReviewStore('p-hr-trigger-serializes-target');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-hr-trigger-serializes-target');
    worktreeStores.push(worktrees);
    const mail = openMailStore('p-hr-trigger-serializes-target');
    mailStores.push(mail);

    const gate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'offline',
      mail,
      specs: lockedSpecs,
      config: fakeConfig({ 'review.worker_merge.reviewer': 'human' }),
    });

    gate.triggerReview({
      reviewId: 'rev-human-serializes-target',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-1',
      scope: 'worker_merge',
      projectId: 'p-hr-trigger-serializes-target',
      specRef: SPEC_REF,
    });

    expect(reviews.activeSerialized(TARGET)).toBe(BRANCH);
    expect(() =>
      gate.triggerReview({
        reviewId: 'rev-human-serializes-target-other',
        target: TARGET,
        branch: 'co/l5-phase-other',
        requestedBy: 'lead-1',
        scope: 'worker_merge',
        projectId: 'p-hr-trigger-serializes-target',
        specRef: SPEC_REF,
      }),
    ).toThrow(/active reviewer\/merge|serialize/);
    expect(mail.inbox(OPERATOR).filter((m) => m.type === MAIL_REVIEW_REQUEST)).toHaveLength(1);
  });

  it('human scope: verdict releases the slot acquired by the real request path', () => {
    const reviews = openReviewStore('p-hr-trigger-release-real-slot');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-hr-trigger-release-real-slot');
    worktreeStores.push(worktrees);
    const mail = openMailStore('p-hr-trigger-release-real-slot');
    mailStores.push(mail);

    const gate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'offline',
      mail,
      specs: lockedSpecs,
      config: fakeConfig({ 'review.worker_merge.reviewer': 'human' }),
    });

    gate.triggerReview({
      reviewId: 'rev-human-release-real-slot',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-1',
      scope: 'worker_merge',
      projectId: 'p-hr-trigger-release-real-slot',
      specRef: SPEC_REF,
    });
    expect(reviews.activeSerialized(TARGET)).toBe(BRANCH);

    recordHumanVerdict(reviews, {
      reviewId: 'rev-human-release-real-slot',
      target: TARGET,
      branch: BRANCH,
      verdict: 'ISSUES',
      body: 'needs another pass',
    });

    expect(reviews.getVerdict(TARGET, BRANCH)?.verdict).toBe('ISSUES');
    expect(reviews.activeSerialized(TARGET)).toBeUndefined();
  });

  it('human scope: retry repairs an existing durable request that has no review_request mail', () => {
    const reviews = openReviewStore('p-hr-trigger-repair-mail');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-hr-trigger-repair-mail');
    worktreeStores.push(worktrees);
    const mail = openMailStore('p-hr-trigger-repair-mail');
    mailStores.push(mail);
    reviews.recordReviewRequested({
      reviewId: 'rev-repair-human-mail',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-1',
      scope: 'worker_merge',
      reviewerKind: 'human',
      specRefKind: 'criteria',
      specRefRef: SPEC_REF,
    });

    const gate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'offline',
      mail,
      specs: lockedSpecs,
      config: fakeConfig({ 'review.worker_merge.reviewer': 'human' }),
    });

    const result = gate.triggerReview({
      reviewId: 'rev-repair-human-mail',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-1',
      scope: 'worker_merge',
      projectId: 'p-hr-trigger-repair-mail',
      specRef: SPEC_REF,
    });

    expect(result.reviewId).toBe('rev-repair-human-mail');
    expect(mail.inbox(OPERATOR).filter((m) => m.type === MAIL_REVIEW_REQUEST)).toHaveLength(1);
    expect(mail.outstandingCount(OPERATOR)).toBe(1);
  });

  it('human scope: idempotent request retry with changed fields is refused', () => {
    const mail = openMailStore('p-hr-trigger-idempotent-mismatch');
    mailStores.push(mail);
    const envelope = {
      type: MAIL_REVIEW_REQUEST,
      to: OPERATOR,
      from: 'lead-1',
      subject: 'review?',
      body: 'Please review this branch. (scope: worker_merge, reviewId: rev-idem-mismatch)',
      idempotencyKey: 'review-request:rev-idem-mismatch',
    } satisfies MailEnvelope;
    const request = {
      reviewId: 'rev-idem-mismatch',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-1',
      scope: 'worker_merge' as const,
      reviewerKind: 'human' as const,
      specRefKind: 'criteria' as const,
      specRefRef: SPEC_REF,
    };

    mail.requestHumanReview(envelope, request);

    expect(() =>
      mail.requestHumanReview(envelope, {
        ...request,
        scope: 'pr_merge',
      }),
    ).toThrow(/duplicate reviewId.*scope|idempotency_key.*conflicts/i);
    expect(mail.inbox(OPERATOR).filter((m) => m.type === MAIL_REVIEW_REQUEST)).toHaveLength(1);
  });

  it('human scope: duplicate reviewId with mismatched fields is refused before side effects', () => {
    const reviews = openReviewStore('p-hr-trigger-dup-mismatch');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-hr-trigger-dup-mismatch');
    worktreeStores.push(worktrees);
    const mail = openMailStore('p-hr-trigger-dup-mismatch');
    mailStores.push(mail);

    const gate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'offline',
      mail,
      specs: lockedSpecs,
      config: fakeConfig({ 'review.worker_merge.reviewer': 'human' }),
    });

    gate.triggerReview({
      reviewId: 'rev-dup-human-mismatch',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-1',
      scope: 'worker_merge',
      projectId: 'p-hr-trigger-dup-mismatch',
      specRef: SPEC_REF,
    });

    expect(() =>
      gate.triggerReview({
        reviewId: 'rev-dup-human-mismatch',
        target: TARGET,
        branch: BRANCH,
        requestedBy: 'lead-2',
        scope: 'worker_merge',
        projectId: 'p-hr-trigger-dup-mismatch',
        specRef: SPEC_REF,
      }),
    ).toThrow(/duplicate reviewId.*requestedBy/i);
    expect(mail.inbox(OPERATOR).filter((m) => m.type === MAIL_REVIEW_REQUEST)).toHaveLength(1);
  });

  it('human scope: cross-target duplicate reviewId is refused before sending mail', () => {
    const reviews = openReviewStore('p-hr-trigger-dup-cross-target');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-hr-trigger-dup-cross-target');
    worktreeStores.push(worktrees);
    const mail = openMailStore('p-hr-trigger-dup-cross-target');
    mailStores.push(mail);

    reviews.recordReviewRequested({
      reviewId: 'rev-dup-human-cross-target',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-1',
      scope: 'worker_merge',
      reviewerKind: 'human',
      specRefKind: 'criteria',
      specRefRef: SPEC_REF,
    });

    const gate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'offline',
      mail,
      specs: lockedSpecs,
      config: fakeConfig({ 'review.worker_merge.reviewer': 'human' }),
    });

    expect(() =>
      gate.triggerReview({
        reviewId: 'rev-dup-human-cross-target',
        target: 'co/another-target',
        branch: 'co/another-branch',
        requestedBy: 'lead-1',
        scope: 'worker_merge',
        projectId: 'p-hr-trigger-dup-cross-target',
        specRef: SPEC_REF,
      }),
    ).toThrow(/duplicate reviewId.*already belongs/i);
    expect(mail.inbox(OPERATOR).filter((m) => m.type === MAIL_REVIEW_REQUEST)).toHaveLength(0);
  });

  it('human scope: records no review_request mail or slot if the atomic request write fails', () => {
    const reviews = openReviewStore('p-hr-trigger-record-fail');
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore('p-hr-trigger-record-fail');
    worktreeStores.push(worktrees);
    const mail = openMailStore('p-hr-trigger-record-fail');
    mailStores.push(mail);
    const failingMail: MailStore = {
      ...mail,
      requestHumanReview: () => {
        throw new Error('review request store unavailable');
      },
    };

    const gate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'offline',
      mail: failingMail,
      specs: lockedSpecs,
      config: fakeConfig({ 'review.worker_merge.reviewer': 'human' }),
    });

    expect(() =>
      gate.triggerReview({
        reviewId: 'rev-human-record-fail',
        target: TARGET,
        branch: BRANCH,
        requestedBy: 'lead-1',
        scope: 'worker_merge',
        projectId: 'p-hr-trigger-record-fail',
        specRef: SPEC_REF,
      }),
    ).toThrow(/review request store unavailable/);

    expect(mail.inbox(OPERATOR).filter((m) => m.type === MAIL_REVIEW_REQUEST)).toHaveLength(0);
    expect(mail.sentBy('lead-1').filter((m) => m.type === MAIL_REVIEW_REQUEST)).toHaveLength(0);
    expect(reviews.getReviewRequest(TARGET, BRANCH)).toBeUndefined();
    expect(reviews.activeSerialized(TARGET)).toBeUndefined();
  });

  it('human scope: retry after a failed atomic request sends visible mail', () => {
    const projectId = 'p-hr-trigger-record-fail-retry';
    const reviews = openReviewStore(projectId);
    reviewStores.push(reviews);
    const worktrees = openWorktreeStore(projectId);
    worktreeStores.push(worktrees);
    const mail = openMailStore(projectId);
    mailStores.push(mail);
    const failingMail: MailStore = {
      ...mail,
      requestHumanReview: () => {
        throw new Error('review request store unavailable once');
      },
    };

    const failingGate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'offline',
      mail: failingMail,
      specs: lockedSpecs,
      config: fakeConfig({ 'review.worker_merge.reviewer': 'human' }),
    });
    const input = {
      reviewId: 'rev-human-record-fail-retry',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-1',
      scope: 'worker_merge' as const,
      projectId,
      specRef: SPEC_REF,
    };
    expect(() => failingGate.triggerReview(input)).toThrow(/review request store unavailable once/);
    expect(mail.inbox(OPERATOR).filter((m) => m.type === MAIL_REVIEW_REQUEST)).toHaveLength(0);
    expect(mail.sentBy('lead-1').filter((m) => m.type === MAIL_REVIEW_REQUEST)).toHaveLength(0);
    expect(reviews.getReviewRequest(TARGET, BRANCH)).toBeUndefined();
    expect(reviews.activeSerialized(TARGET)).toBeUndefined();

    const retryGate = new CoReviewGate({
      reviews,
      worktrees,
      resolveMode: () => 'offline',
      mail,
      specs: lockedSpecs,
      config: fakeConfig({ 'review.worker_merge.reviewer': 'human' }),
    });
    retryGate.triggerReview(input);

    const visibleRequests = mail.inbox(OPERATOR).filter((m) => m.type === MAIL_REVIEW_REQUEST);
    expect(visibleRequests).toHaveLength(1);
    expect(visibleRequests[0]!.retracted).toBe(false);
    expect(mail.outstandingCount(OPERATOR)).toBe(1);
    expect(mail.sentBy('lead-1').filter((m) => m.type === MAIL_REVIEW_REQUEST)).toHaveLength(1);
    expect(reviews.getReviewRequest(TARGET, BRANCH)?.reviewId).toBe(input.reviewId);
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
      specs: lockedSpecs,
      config,
    });

    gate.triggerReview({
      reviewId: 'rev-43',
      target: TARGET,
      branch: BRANCH,
      requestedBy: 'lead-1',
      scope: 'worker_merge',
      projectId: 'p-hr-no-placement',
      specRef: SPEC_REF,
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
