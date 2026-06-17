import { MAIL_REVIEW_RESPONSE, OPERATOR, mailKind } from '@co/core';
import type {
  ApprovalDecision,
  ApprovalReply,
  DeliveredMail,
  MailCardView,
  MailKind,
  MailType,
  OperatorMailRef,
  RendererRegistry,
  ReplyDraft,
  ReviewVerdictValue,
} from '@co/core';

export interface MailRow {
  readonly seq: number;
  readonly type: MailType;
  readonly subject: string;
  readonly sender: string;
  readonly recipient: string;
  readonly ts: number;
  readonly renderedBody: string;
  /** The structured per-type card (key/value fields + body) the detail pane paints generically (SF-6). */
  readonly card: MailCardView;
  readonly kind: MailKind;
  readonly read: boolean;
  readonly resolved: boolean;
  readonly idempotencyKey?: string;
  readonly decision?: ApprovalDecision;
  readonly reviewVerdict?: ReviewVerdictValue;
}

export interface ComposerState {
  readonly active: boolean;
  readonly targetSeq: number | null;
  readonly targetRecipient: string | null;
  readonly type: MailType;
  readonly subject: string;
  readonly body: string;
  readonly pending: boolean;
  readonly idempotencyKey: string | null;
}

export interface MailState {
  readonly activeBus: string;
  readonly tab: 'inbox' | 'outbox';
  readonly inbox: readonly MailRow[];
  readonly outbox: readonly MailRow[];
  readonly selected: MailRow | null;
  readonly composer: ComposerState;
}

const BLANK_COMPOSER: ComposerState = {
  active: false,
  targetSeq: null,
  targetRecipient: null,
  type: 'clarify_response',
  subject: '',
  body: '',
  pending: false,
  idempotencyKey: null,
};

const INITIAL_STATE: MailState = {
  activeBus: OPERATOR,
  tab: 'inbox',
  inbox: [],
  outbox: [],
  selected: null,
  composer: BLANK_COMPOSER,
};

function replyIdempotencyKey(targetRecipient: string, targetSeq: number, type: MailType): string {
  return `desktop-reply:${targetRecipient}:${targetSeq}:${type}`;
}

type MaybePromise<T> = T | Promise<T>;

export interface MailVMDeps {
  readonly registry: RendererRegistry;
  readonly initialBus?: string;
  readonly onMarkRead?: (recipient: string, seq: number) => void;
  readonly onReply?: (target: OperatorMailRef, draft: ReplyDraft) => MaybePromise<void>;
  readonly onApprove?: (approvalSeq: number, reply: ApprovalReply) => MaybePromise<void>;
  readonly onSelectBus?: (busId: string) => void;
}

/**
 * Pure headless view-model for the Mail view (mirrors DashboardVM shape).
 * Inputs are injected via update(); intents fire injected callbacks so the main
 * process can route them through the P1 client (single writer — MNR #2).
 */
export class MailVM {
  private _state: MailState;
  private readonly registry: RendererRegistry;
  private readonly cbMarkRead: ((r: string, seq: number) => void) | undefined;
  private readonly cbReply: ((t: OperatorMailRef, d: ReplyDraft) => MaybePromise<void>) | undefined;
  private readonly cbApprove: ((seq: number, r: ApprovalReply) => MaybePromise<void>) | undefined;
  private readonly cbSelectBus: ((busId: string) => void) | undefined;
  private readonly listeners = new Set<(state: MailState) => void>();
  private _rawInbox: readonly DeliveredMail[] = [];
  private _rawOutbox: readonly DeliveredMail[] = [];
  private _selectedSeq: number | null = null;

  constructor(deps: MailVMDeps) {
    this.registry = deps.registry;
    this.cbMarkRead = deps.onMarkRead;
    this.cbReply = deps.onReply;
    this.cbApprove = deps.onApprove;
    this.cbSelectBus = deps.onSelectBus;
    this._state =
      deps.initialBus != null
        ? { ...INITIAL_STATE, activeBus: deps.initialBus }
        : { ...INITIAL_STATE };
  }

  get state(): MailState {
    return this._state;
  }

  /** Replace the displayed inbox/outbox with fresh data and re-derive state. */
  update(inbox: readonly DeliveredMail[], outbox: readonly DeliveredMail[]): void {
    this._rawInbox = inbox;
    this._rawOutbox = outbox;
    this.recompute();
    this.emit();
  }

  /** Switch the active bus; fires onSelectBus so the main process re-fetches mail. */
  selectBus(busId: string): void {
    if (this._state.composer.pending) return;
    this._rawInbox = [];
    this._rawOutbox = [];
    this._state = {
      ...this._state,
      activeBus: busId,
      selected: null,
      tab: 'inbox',
      inbox: [],
      outbox: [],
      composer: { ...BLANK_COMPOSER },
    };
    this._selectedSeq = null;
    this.emit();
    this.cbSelectBus?.(busId);
  }

  /** Switch inbox/outbox tab; clears the selection. */
  selectTab(tab: 'inbox' | 'outbox'): void {
    if (this._state.composer.pending) return;
    this._state = { ...this._state, tab, selected: null, composer: { ...BLANK_COMPOSER } };
    this._selectedSeq = null;
    this.emit();
  }

  /**
   * Select a mail item. If the item is informational and this is the operator's
   * own inbox (not an agent-bus view), fires onMarkRead (MNR #1: actionables stay
   * sticky; agent-bus views are read-only).
   */
  selectMail(seq: number): void {
    if (this._state.composer.pending) return;
    const currentList = this._state.tab === 'inbox' ? this._rawInbox : this._rawOutbox;
    const raw = currentList.find((m) => m.seq === seq);
    if (raw == null) return;

    const row = this.toRow(raw);
    this._selectedSeq = seq;
    this._state = { ...this._state, selected: row, composer: { ...BLANK_COMPOSER } };
    this.emit();

    // MNR #1: only fire markRead for informational mail in @operator's own inbox.
    // Never clear actionables on view; never markRead an agent-bus view (read-only).
    if (
      this._state.tab === 'inbox' &&
      this._state.activeBus === OPERATOR &&
      row.kind === 'informational' &&
      raw.read !== true
    ) {
      this.cbMarkRead?.(OPERATOR, seq);
    }
  }

  /** Open the reply composer pre-filled for the target mail. */
  openComposer(
    targetSeq: number,
    targetRecipient: string,
    replyType: MailType,
    subject: string,
  ): void {
    if (this._state.composer.pending) return;
    this._state = {
      ...this._state,
      composer: {
        active: true,
        targetSeq,
        targetRecipient,
        type: replyType,
        subject,
        body: '',
        pending: false,
        idempotencyKey: replyIdempotencyKey(targetRecipient, targetSeq, replyType),
      },
    };
    this.emit();
  }

  updateComposerField(field: 'type' | 'subject' | 'body', value: string): void {
    if (this._state.composer.pending) return;
    const current = this._state.composer;
    const nextType = field === 'type' ? (value as MailType) : current.type;
    this._state = {
      ...this._state,
      composer: {
        ...current,
        [field]: value as MailType,
        idempotencyKey:
          current.targetRecipient != null && current.targetSeq != null
            ? replyIdempotencyKey(current.targetRecipient, current.targetSeq, nextType)
            : current.idempotencyKey,
      },
    };
    this.emit();
  }

  closeComposer(): void {
    if (this._state.composer.pending) return;
    this.resetComposer();
  }

  private resetComposer(): void {
    this._state = { ...this._state, composer: { ...BLANK_COMPOSER } };
    this.emit();
  }

  /** Submit the reply composer — awaits onReply then closes. No-op if composer inactive. */
  async submitReply(): Promise<void> {
    const c = this._state.composer;
    if (!c.active || c.pending || c.targetSeq == null || c.targetRecipient == null) return;
    if (c.type === MAIL_REVIEW_RESPONSE) return;
    const idempotencyKey =
      c.idempotencyKey ?? replyIdempotencyKey(c.targetRecipient, c.targetSeq, c.type);
    this._state = {
      ...this._state,
      composer: { ...c, pending: true, idempotencyKey },
    };
    this.emit();
    try {
      await this.cbReply?.(
        { seq: c.targetSeq, recipient: c.targetRecipient },
        {
          type: c.type,
          subject: c.subject,
          body: c.body,
          idempotencyKey,
        },
      );
      if (this._state.composer.idempotencyKey === idempotencyKey) {
        this.resetComposer();
      }
    } catch (error) {
      if (this._state.composer.idempotencyKey === idempotencyKey) {
        this._state = {
          ...this._state,
          composer: { ...this._state.composer, pending: false },
        };
        this.emit();
      }
      throw error;
    }
  }

  /** Quick-approve an approval mail with default prose (fires onApprove). */
  async approve(approvalSeq: number): Promise<void> {
    if (this._state.composer.pending) return;
    await this.cbApprove?.(approvalSeq, {
      decision: 'approve',
      subject: 'Approved',
      body: 'Approved.',
    });
  }

  /** Quick-decline an approval mail with default prose (fires onApprove). */
  async decline(approvalSeq: number): Promise<void> {
    if (this._state.composer.pending) return;
    await this.cbApprove?.(approvalSeq, {
      decision: 'decline',
      subject: 'Declined',
      body: 'Declined.',
    });
  }

  /** Approve with custom prose from the composer (awaits onApprove then closes composer). */
  async approveWithComposer(approvalSeq: number): Promise<void> {
    await this.submitApprovalComposer(approvalSeq, 'approve', 'Approved', 'Approved.');
  }

  /** Decline with custom prose from the composer (awaits onApprove then closes composer). */
  async declineWithComposer(approvalSeq: number): Promise<void> {
    await this.submitApprovalComposer(approvalSeq, 'decline', 'Declined', 'Declined.');
  }

  private async submitApprovalComposer(
    approvalSeq: number,
    decision: ApprovalDecision,
    defaultSubject: string,
    defaultBody: string,
  ): Promise<void> {
    const c = this._state.composer;
    if (c.pending) return;
    const idempotencyKey =
      c.idempotencyKey ??
      (c.targetRecipient != null && c.targetSeq != null
        ? replyIdempotencyKey(c.targetRecipient, c.targetSeq, c.type)
        : null);
    if (c.active) {
      this._state = {
        ...this._state,
        composer: { ...c, pending: true, idempotencyKey },
      };
      this.emit();
    }
    try {
      await this.cbApprove?.(approvalSeq, {
        decision,
        subject: c.subject || defaultSubject,
        body: c.body || defaultBody,
      });
      if (c.active && this._state.composer.idempotencyKey === idempotencyKey) {
        this.resetComposer();
      }
    } catch (error) {
      if (c.active && this._state.composer.idempotencyKey === idempotencyKey) {
        this._state = {
          ...this._state,
          composer: { ...this._state.composer, pending: false },
        };
        this.emit();
      }
      throw error;
    }
  }

  subscribe(listener: (state: MailState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private toRow(mail: DeliveredMail): MailRow {
    return {
      seq: mail.seq,
      type: mail.type,
      subject: mail.subject,
      sender: mail.sender,
      recipient: mail.recipient,
      ts: mail.ts,
      renderedBody: this.registry.render(mail),
      card: this.registry.renderCard(mail),
      kind: mailKind(mail.type),
      read: mail.read ?? false,
      resolved: mail.resolved ?? false,
      ...(mail.idempotencyKey != null ? { idempotencyKey: mail.idempotencyKey } : {}),
      ...(mail.decision != null ? { decision: mail.decision } : {}),
      ...(mail.reviewVerdict != null ? { reviewVerdict: mail.reviewVerdict } : {}),
    };
  }

  private recompute(): void {
    const inbox = this._rawInbox.map((m) => this.toRow(m));
    const outbox = this._rawOutbox.map((m) => this.toRow(m));

    // Keep the selected item fresh if it still exists in the current list.
    let selected = this._state.selected;
    if (this._selectedSeq != null) {
      const currentRaw = this._state.tab === 'inbox' ? this._rawInbox : this._rawOutbox;
      const raw = currentRaw.find((m) => m.seq === this._selectedSeq);
      selected = raw != null ? this.toRow(raw) : null;
      if (raw == null) this._selectedSeq = null;
    }

    this._state = { ...this._state, inbox, outbox, selected };
  }

  private emit(): void {
    const state = this._state;
    for (const listener of [...this.listeners]) listener(state);
  }
}
