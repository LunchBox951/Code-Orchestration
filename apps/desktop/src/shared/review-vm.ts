import { MAIL_REVIEW_REQUEST, MAIL_REVIEW_RESPONSE, OPERATOR } from '@co/core';
import type {
  DeliveredMail,
  OperatorMailRef,
  ReplyDraft,
  ReviewContext,
  ReviewVerdictValue,
} from '@co/core';

export interface ReviewRow {
  readonly reviewId: string;
  readonly seq: number;
  readonly sender: string;
  readonly subject: string;
  readonly ts: number;
}

export type SelectedContext =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly value: ReviewContext }
  | null;

export interface VerdictComposer {
  readonly active: boolean;
  readonly verdict: ReviewVerdictValue;
  readonly body: string;
  readonly pending: boolean;
}

export interface ReviewState {
  readonly pending: readonly ReviewRow[];
  readonly selectedReviewId: string | null;
  readonly context: SelectedContext;
  readonly composer: VerdictComposer;
}

type MaybePromise<T> = T | Promise<T>;

export interface ReviewVMDeps {
  readonly onFetchReviewContext?: (reviewId: string) => void;
  readonly onSubmitVerdict?: (target: OperatorMailRef, draft: ReplyDraft) => MaybePromise<void>;
}

const BLANK_COMPOSER: VerdictComposer = {
  active: false,
  verdict: 'PASS',
  body: '',
  pending: false,
};

function extractReviewId(mail: DeliveredMail): string | null {
  if (mail.idempotencyKey?.startsWith('review-request:')) {
    return mail.idempotencyKey.slice('review-request:'.length);
  }
  const match = /\breviewId:\s*(\S+)/.exec(mail.body);
  return match?.[1] ?? null;
}

function deriveRows(inbox: readonly DeliveredMail[]): readonly ReviewRow[] {
  const rows: ReviewRow[] = [];
  for (const m of inbox) {
    if (m.type !== MAIL_REVIEW_REQUEST || m.resolved === true) continue;
    const reviewId = extractReviewId(m);
    if (reviewId == null) continue;
    rows.push({ reviewId, seq: m.seq, sender: m.sender, subject: m.subject, ts: m.ts });
  }
  return rows;
}

function hasReviewEvidence(context: SelectedContext): boolean {
  return (
    context?.status === 'loaded' &&
    context.value.kind === 'resolved' &&
    context.value.diff.kind === 'patch' &&
    context.value.criteria.kind === 'criteria'
  );
}

export class ReviewVM {
  private _state: ReviewState = {
    pending: [],
    selectedReviewId: null,
    context: null,
    composer: { ...BLANK_COMPOSER },
  };
  private readonly listeners = new Set<(state: ReviewState) => void>();
  private readonly cbFetchReviewContext: ((reviewId: string) => void) | undefined;
  private readonly cbSubmitVerdict:
    | ((target: OperatorMailRef, draft: ReplyDraft) => MaybePromise<void>)
    | undefined;

  constructor(deps: ReviewVMDeps = {}) {
    this.cbFetchReviewContext = deps.onFetchReviewContext;
    this.cbSubmitVerdict = deps.onSubmitVerdict;
  }

  get state(): ReviewState {
    return this._state;
  }

  update(operatorInbox: readonly DeliveredMail[]): void {
    const pending = deriveRows(operatorInbox);
    let { selectedReviewId, context } = this._state;
    if (selectedReviewId != null && !pending.some((r) => r.reviewId === selectedReviewId)) {
      selectedReviewId = null;
      context = null;
    }
    this._state = { ...this._state, pending, selectedReviewId, context };
    this.emit();
  }

  selectReview(reviewId: string): void {
    this._state = {
      ...this._state,
      selectedReviewId: reviewId,
      context: { status: 'loading' },
      composer: { ...BLANK_COMPOSER },
    };
    this.emit();
    this.cbFetchReviewContext?.(reviewId);
  }

  setReviewContext(reviewId: string, value: ReviewContext): void {
    if (reviewId !== this._state.selectedReviewId) return;
    this._state = { ...this._state, context: { status: 'loaded', value } };
    this.emit();
  }

  beginVerdict(verdict: ReviewVerdictValue): void {
    if (this._state.composer.pending) return;
    this._state = {
      ...this._state,
      composer: { active: true, verdict, body: '', pending: false },
    };
    this.emit();
  }

  updateComposerBody(text: string): void {
    if (this._state.composer.pending) return;
    this._state = { ...this._state, composer: { ...this._state.composer, body: text } };
    this.emit();
  }

  cancelVerdict(): void {
    if (this._state.composer.pending) return;
    this._state = { ...this._state, composer: { ...BLANK_COMPOSER } };
    this.emit();
  }

  async submitVerdict(): Promise<void> {
    const c = this._state.composer;
    if (!c.active || c.pending) return;
    if (!hasReviewEvidence(this._state.context)) return;

    const { selectedReviewId } = this._state;
    if (selectedReviewId == null) return;

    const row = this._state.pending.find((r) => r.reviewId === selectedReviewId);
    if (row == null) return;

    const { verdict } = c;
    if (verdict === 'ISSUES' && c.body.trim() === '') return;

    const { seq } = row;
    const body =
      verdict === 'PASS' ? (c.body.trim() ? `PASS\n${c.body}` : 'PASS') : `ISSUES\n${c.body}`;
    const idempotencyKey = `desktop-reply:${OPERATOR}:${seq}:${MAIL_REVIEW_RESPONSE}`;
    const target: OperatorMailRef = { seq, recipient: OPERATOR };
    const draft: ReplyDraft = {
      type: MAIL_REVIEW_RESPONSE,
      subject: `Review ${verdict}`,
      body,
      reviewVerdict: verdict,
      idempotencyKey,
    };

    this._state = { ...this._state, composer: { ...c, pending: true } };
    this.emit();

    try {
      await this.cbSubmitVerdict?.(target, draft);
      this._state = { ...this._state, composer: { ...BLANK_COMPOSER } };
      this.emit();
    } catch (error) {
      this._state = { ...this._state, composer: { ...this._state.composer, pending: false } };
      this.emit();
      throw error;
    }
  }

  subscribe(listener: (state: ReviewState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const state = this._state;
    for (const listener of [...this.listeners]) listener(state);
  }
}
