import { describe, it, expect, vi } from 'vitest';
import { MAIL_REVIEW_REQUEST, MAIL_REVIEW_RESPONSE, OPERATOR } from '@co/core';
import type { DeliveredMail, OperatorMailRef, ReplyDraft, ReviewContext } from '@co/core';
import { ReviewVM } from './review-vm.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeReviewMail(overrides: Partial<DeliveredMail> = {}): DeliveredMail {
  return {
    seq: 1,
    recipient: OPERATOR,
    sender: 'lead-1',
    type: MAIL_REVIEW_REQUEST,
    subject: "review requested: 'feature' into 'main'",
    body: 'Please review this branch.',
    ts: 1000,
    idempotencyKey: 'review-request:rev-abc',
    resolved: false,
    ...overrides,
  } as DeliveredMail;
}

function makeOtherMail(overrides: Partial<DeliveredMail> = {}): DeliveredMail {
  return {
    seq: 99,
    recipient: OPERATOR,
    sender: 'other-agent',
    type: 'chat',
    subject: 'Hello',
    body: 'just a note',
    ts: 2000,
    ...overrides,
  } as DeliveredMail;
}

const RESOLVED_CTX: ReviewContext = {
  kind: 'resolved',
  reviewId: 'rev-abc',
  branch: 'feature',
  target: 'main',
  scope: 'pr_merge',
  diff: { kind: 'patch', patch: 'diff --git ...' },
  criteria: { kind: 'criteria', specRef: 'spec.md', criteria: [{ text: 'It works' }] },
};

// ── update — filtering and row derivation ─────────────────────────────────────

describe('ReviewVM — update', () => {
  it('keeps only unresolved review_request mail', () => {
    const vm = new ReviewVM();
    vm.update([
      makeReviewMail({ seq: 1, idempotencyKey: 'review-request:rev-1' }),
      makeReviewMail({ seq: 2, idempotencyKey: 'review-request:rev-2', resolved: true }),
      makeOtherMail({ seq: 3 }),
      makeReviewMail({ seq: 4, idempotencyKey: 'review-request:rev-4' }),
    ]);
    expect(vm.state.pending).toHaveLength(2);
    expect(vm.state.pending.map((r) => r.reviewId)).toEqual(['rev-1', 'rev-4']);
  });

  it('extracts reviewId from idempotencyKey prefix', () => {
    const vm = new ReviewVM();
    vm.update([makeReviewMail({ seq: 5, idempotencyKey: 'review-request:rev-xyz' })]);
    expect(vm.state.pending[0]?.reviewId).toBe('rev-xyz');
  });

  it('falls back to body reviewId: token when idempotencyKey is absent', () => {
    const vm = new ReviewVM();
    vm.update([
      makeReviewMail({
        seq: 6,
        idempotencyKey: undefined,
        body: 'Please review this. reviewId: rev-body-123 scope: pr_merge',
      }),
    ]);
    expect(vm.state.pending[0]?.reviewId).toBe('rev-body-123');
  });

  it('drops rows with no extractable reviewId', () => {
    const vm = new ReviewVM();
    vm.update([makeReviewMail({ seq: 7, idempotencyKey: undefined, body: 'no id in here' })]);
    expect(vm.state.pending).toHaveLength(0);
  });

  it('maps seq/sender/subject/ts from the mail', () => {
    const vm = new ReviewVM();
    vm.update([
      makeReviewMail({
        seq: 42,
        sender: 'lead-42',
        subject: 'review requested: branch',
        ts: 9999,
        idempotencyKey: 'review-request:rev-42',
      }),
    ]);
    const row = vm.state.pending[0]!;
    expect(row.seq).toBe(42);
    expect(row.sender).toBe('lead-42');
    expect(row.subject).toBe('review requested: branch');
    expect(row.ts).toBe(9999);
  });

  it('clears selection when selected review is removed from inbox', () => {
    const vm = new ReviewVM();
    vm.update([makeReviewMail({ seq: 1, idempotencyKey: 'review-request:rev-1' })]);
    vm.selectReview('rev-1');
    expect(vm.state.selectedReviewId).toBe('rev-1');

    vm.update([]); // inbox cleared
    expect(vm.state.selectedReviewId).toBeNull();
    expect(vm.state.context).toBeNull();
  });

  it('keeps selection when selected review still exists', () => {
    const vm = new ReviewVM();
    vm.update([makeReviewMail({ seq: 1, idempotencyKey: 'review-request:rev-1' })]);
    vm.selectReview('rev-1');
    vm.update([
      makeReviewMail({ seq: 1, idempotencyKey: 'review-request:rev-1' }),
      makeReviewMail({ seq: 2, idempotencyKey: 'review-request:rev-2' }),
    ]);
    expect(vm.state.selectedReviewId).toBe('rev-1');
  });
});

// ── selectReview ─────────────────────────────────────────────────────────────

describe('ReviewVM — selectReview', () => {
  it('sets context to loading and fires onFetchReviewContext', () => {
    const onFetch = vi.fn();
    const vm = new ReviewVM({ onFetchReviewContext: onFetch });
    vm.update([makeReviewMail({ seq: 1, idempotencyKey: 'review-request:rev-abc' })]);
    vm.selectReview('rev-abc');
    expect(vm.state.selectedReviewId).toBe('rev-abc');
    expect(vm.state.context).toEqual({ status: 'loading' });
    expect(onFetch).toHaveBeenCalledWith('rev-abc');
  });

  it('resets the composer when selecting a review', () => {
    const vm = new ReviewVM();
    vm.update([makeReviewMail({ seq: 1, idempotencyKey: 'review-request:rev-abc' })]);
    vm.selectReview('rev-abc');
    vm.beginVerdict('ISSUES');
    vm.selectReview('rev-abc');
    expect(vm.state.composer.active).toBe(false);
  });
});

// ── setReviewContext ──────────────────────────────────────────────────────────

describe('ReviewVM — setReviewContext', () => {
  it('transitions context to loaded for the selected review', () => {
    const vm = new ReviewVM();
    vm.update([makeReviewMail({ seq: 1, idempotencyKey: 'review-request:rev-abc' })]);
    vm.selectReview('rev-abc');
    vm.setReviewContext('rev-abc', RESOLVED_CTX);
    const ctx = vm.state.context;
    expect(ctx?.status).toBe('loaded');
    if (ctx?.status === 'loaded') expect(ctx.value).toEqual(RESOLVED_CTX);
  });

  it('ignores a stale response for a different reviewId', () => {
    const vm = new ReviewVM();
    vm.update([makeReviewMail({ seq: 1, idempotencyKey: 'review-request:rev-abc' })]);
    vm.selectReview('rev-abc');
    vm.setReviewContext('rev-OTHER', RESOLVED_CTX);
    expect(vm.state.context?.status).toBe('loading');
  });

  it('stores not-found context without throwing', () => {
    const vm = new ReviewVM();
    vm.update([makeReviewMail({ seq: 1, idempotencyKey: 'review-request:rev-abc' })]);
    vm.selectReview('rev-abc');
    const ctx: ReviewContext = { kind: 'not-found', reviewId: 'rev-abc' };
    expect(() => vm.setReviewContext('rev-abc', ctx)).not.toThrow();
    const loaded = vm.state.context;
    expect(loaded?.status).toBe('loaded');
    if (loaded?.status === 'loaded') expect(loaded.value).toEqual(ctx);
  });

  it('stores conductor-down context without throwing', () => {
    const vm = new ReviewVM();
    vm.update([makeReviewMail({ seq: 1, idempotencyKey: 'review-request:rev-abc' })]);
    vm.selectReview('rev-abc');
    const ctx: ReviewContext = { kind: 'conductor-down', reviewId: 'rev-abc' };
    expect(() => vm.setReviewContext('rev-abc', ctx)).not.toThrow();
    const loaded = vm.state.context;
    if (loaded?.status === 'loaded') expect(loaded.value.kind).toBe('conductor-down');
  });

  it('stores resolved context with diff:unavailable without throwing', () => {
    const vm = new ReviewVM();
    vm.update([makeReviewMail({ seq: 1, idempotencyKey: 'review-request:rev-abc' })]);
    vm.selectReview('rev-abc');
    const ctx: ReviewContext = {
      ...RESOLVED_CTX,
      diff: { kind: 'unavailable', reason: 'worktree-missing' },
    };
    expect(() => vm.setReviewContext('rev-abc', ctx)).not.toThrow();
    const loaded = vm.state.context;
    if (loaded?.status === 'loaded' && loaded.value.kind === 'resolved') {
      expect(loaded.value.diff.kind).toBe('unavailable');
    }
  });

  it('stores resolved context with criteria:no-locked-spec without throwing', () => {
    const vm = new ReviewVM();
    vm.update([makeReviewMail({ seq: 1, idempotencyKey: 'review-request:rev-abc' })]);
    vm.selectReview('rev-abc');
    const ctx: ReviewContext = {
      ...RESOLVED_CTX,
      criteria: { kind: 'no-locked-spec' },
    };
    expect(() => vm.setReviewContext('rev-abc', ctx)).not.toThrow();
    const loaded = vm.state.context;
    if (loaded?.status === 'loaded' && loaded.value.kind === 'resolved') {
      expect(loaded.value.criteria.kind).toBe('no-locked-spec');
    }
  });
});

// ── verdict lifecycle ─────────────────────────────────────────────────────────

describe('ReviewVM — verdict lifecycle', () => {
  it('beginVerdict opens composer with the given verdict', () => {
    const vm = new ReviewVM();
    vm.beginVerdict('PASS');
    expect(vm.state.composer).toMatchObject({
      active: true,
      verdict: 'PASS',
      body: '',
      pending: false,
    });
  });

  it('updateComposerBody sets the body', () => {
    const vm = new ReviewVM();
    vm.beginVerdict('ISSUES');
    vm.updateComposerBody('missing tests');
    expect(vm.state.composer.body).toBe('missing tests');
  });

  it('cancelVerdict resets the composer when not pending', () => {
    const vm = new ReviewVM();
    vm.beginVerdict('PASS');
    vm.cancelVerdict();
    expect(vm.state.composer.active).toBe(false);
  });
});

// ── submitVerdict — PASS ───────────────────────────────────────────────────────

describe('ReviewVM — submitVerdict PASS', () => {
  it('fires onSubmitVerdict with correct target and draft', async () => {
    let capturedTarget: OperatorMailRef | undefined;
    let capturedDraft: ReplyDraft | undefined;
    const onSubmit = vi.fn(async (target: OperatorMailRef, draft: ReplyDraft) => {
      capturedTarget = target;
      capturedDraft = draft;
    });
    const vm = new ReviewVM({ onSubmitVerdict: onSubmit });
    vm.update([makeReviewMail({ seq: 7, idempotencyKey: 'review-request:rev-abc' })]);
    vm.selectReview('rev-abc');
    vm.setReviewContext('rev-abc', RESOLVED_CTX);
    vm.beginVerdict('PASS');

    await vm.submitVerdict();

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(capturedTarget).toEqual({ seq: 7, recipient: OPERATOR });
    expect(capturedDraft?.type).toBe(MAIL_REVIEW_RESPONSE);
    expect(capturedDraft?.reviewVerdict).toBe('PASS');
    expect(capturedDraft?.idempotencyKey).toBe(
      `desktop-reply:${OPERATOR}:7:${MAIL_REVIEW_RESPONSE}`,
    );
    expect(capturedDraft?.body).toContain('PASS');
  });

  it('resets composer after successful submit', async () => {
    const vm = new ReviewVM({ onSubmitVerdict: vi.fn() });
    vm.update([makeReviewMail({ seq: 1, idempotencyKey: 'review-request:rev-abc' })]);
    vm.selectReview('rev-abc');
    vm.beginVerdict('PASS');
    await vm.submitVerdict();
    expect(vm.state.composer.active).toBe(false);
    expect(vm.state.composer.pending).toBe(false);
  });
});

// ── submitVerdict — ISSUES ────────────────────────────────────────────────────

describe('ReviewVM — submitVerdict ISSUES', () => {
  it('fires onSubmitVerdict with ISSUES verdict and blocker body', async () => {
    let capturedTarget: OperatorMailRef | undefined;
    let capturedDraft: ReplyDraft | undefined;
    const onSubmit = vi.fn(async (target: OperatorMailRef, draft: ReplyDraft) => {
      capturedTarget = target;
      capturedDraft = draft;
    });
    const vm = new ReviewVM({ onSubmitVerdict: onSubmit });
    vm.update([makeReviewMail({ seq: 3, idempotencyKey: 'review-request:rev-abc' })]);
    vm.selectReview('rev-abc');
    vm.setReviewContext('rev-abc', RESOLVED_CTX);
    vm.beginVerdict('ISSUES');
    vm.updateComposerBody('missing unit tests for the new path');

    await vm.submitVerdict();

    expect(onSubmit).toHaveBeenCalledOnce();
    expect(capturedTarget).toEqual({ seq: 3, recipient: OPERATOR });
    expect(capturedDraft?.reviewVerdict).toBe('ISSUES');
    expect(capturedDraft?.body).toContain('ISSUES');
    expect(capturedDraft?.body).toContain('missing unit tests for the new path');
    expect(capturedDraft?.idempotencyKey).toBe(
      `desktop-reply:${OPERATOR}:3:${MAIL_REVIEW_RESPONSE}`,
    );
  });

  it('does NOT submit when ISSUES body is empty', async () => {
    const onSubmit = vi.fn();
    const vm = new ReviewVM({ onSubmitVerdict: onSubmit });
    vm.update([makeReviewMail({ seq: 1, idempotencyKey: 'review-request:rev-abc' })]);
    vm.selectReview('rev-abc');
    vm.beginVerdict('ISSUES');
    // body is empty — should not submit
    await vm.submitVerdict();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does NOT submit when ISSUES body is only whitespace', async () => {
    const onSubmit = vi.fn();
    const vm = new ReviewVM({ onSubmitVerdict: onSubmit });
    vm.update([makeReviewMail({ seq: 1, idempotencyKey: 'review-request:rev-abc' })]);
    vm.selectReview('rev-abc');
    vm.beginVerdict('ISSUES');
    vm.updateComposerBody('   ');
    await vm.submitVerdict();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

// ── submitVerdict — pending guard ─────────────────────────────────────────────

describe('ReviewVM — pending guard', () => {
  it('sets pending=true while the submit is in flight', async () => {
    let resolveFn!: () => void;
    const inflightPromise = new Promise<void>((res) => {
      resolveFn = res;
    });
    const vm = new ReviewVM({ onSubmitVerdict: () => inflightPromise });
    vm.update([makeReviewMail({ seq: 1, idempotencyKey: 'review-request:rev-abc' })]);
    vm.selectReview('rev-abc');
    vm.beginVerdict('PASS');

    const submitPromise = vm.submitVerdict();
    expect(vm.state.composer.pending).toBe(true);

    // A second submitVerdict call is a no-op while pending
    const onSubmit2 = vi.fn();
    const vm2 = new ReviewVM({ onSubmitVerdict: onSubmit2 });
    vm2.update([makeReviewMail({ seq: 1, idempotencyKey: 'review-request:rev-abc' })]);
    vm2.selectReview('rev-abc');
    vm2.beginVerdict('PASS');
    // manually set pending=true by starting a submit
    let resolve2!: () => void;
    const p2 = new Promise<void>((res) => {
      resolve2 = res;
    });
    const vm2WithPending = new ReviewVM({ onSubmitVerdict: () => p2 });
    vm2WithPending.update([makeReviewMail({ seq: 1, idempotencyKey: 'review-request:rev-abc' })]);
    vm2WithPending.selectReview('rev-abc');
    vm2WithPending.beginVerdict('PASS');
    const firstSubmit = vm2WithPending.submitVerdict();
    expect(vm2WithPending.state.composer.pending).toBe(true);
    // cancelVerdict is a no-op while pending
    vm2WithPending.cancelVerdict();
    expect(vm2WithPending.state.composer.pending).toBe(true);
    resolve2();
    await firstSubmit;

    resolveFn();
    await submitPromise;
    expect(vm.state.composer.pending).toBe(false);
  });
});

// ── submitVerdict — error path ────────────────────────────────────────────────

describe('ReviewVM — error path', () => {
  it('restores pending=false and rethrows on error', async () => {
    const err = new Error('network failure');
    const vm = new ReviewVM({ onSubmitVerdict: () => Promise.reject(err) });
    vm.update([makeReviewMail({ seq: 1, idempotencyKey: 'review-request:rev-abc' })]);
    vm.selectReview('rev-abc');
    vm.beginVerdict('PASS');

    await expect(vm.submitVerdict()).rejects.toThrow('network failure');
    expect(vm.state.composer.pending).toBe(false);
    expect(vm.state.composer.active).toBe(true);
  });
});

// ── subscribe ─────────────────────────────────────────────────────────────────

describe('ReviewVM — subscribe', () => {
  it('notifies listeners on state changes', () => {
    const vm = new ReviewVM();
    const states: unknown[] = [];
    vm.subscribe((s) => states.push(s));
    vm.update([makeReviewMail({ seq: 1, idempotencyKey: 'review-request:rev-abc' })]);
    expect(states).toHaveLength(1);
  });

  it('unsubscribe stops notifications', () => {
    const vm = new ReviewVM();
    const states: unknown[] = [];
    const unsub = vm.subscribe((s) => states.push(s));
    unsub();
    vm.update([makeReviewMail({ seq: 1, idempotencyKey: 'review-request:rev-abc' })]);
    expect(states).toHaveLength(0);
  });
});
