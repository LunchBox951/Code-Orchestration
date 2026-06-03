import type { DatabaseSync } from 'node:sqlite';
import { openProjectStore } from '../store/sqlite-store.js';
import type { Projector } from '../replay/projector.js';
import {
  validateEnvelope,
  type ApprovalDecision,
  type DeliveredMail,
  type MailEnvelope,
  type MailType,
} from './events.js';
import { InProcessDelivery, type Delivery } from './delivery.js';
import {
  MailProjector,
  countOutstanding,
  forwardSourceForSeq,
  inboxForRecipient,
  outstandingForRecipient,
  selectMailBySeq,
  sentByForSender,
} from './mail-projector.js';

/**
 * A reply draft (freeze #7): the new message's type + prose. `to`/`correlationId`/
 * `causationId` are derived from the mail being answered, so a reply can never
 * orphan. `from` defaults to the answered mail's recipient (the natural replier);
 * override it only when a third party replies on their behalf.
 */
export interface ReplyDraft {
  readonly type: MailType;
  readonly subject: string;
  readonly body: string;
  readonly from?: string;
  readonly idempotencyKey?: string;
  readonly decision?: ApprovalDecision; // ONLY an `approval_response` reply carries it (W4)
}

/**
 * The headless mail bus over a single project store (AC-L1-1..4). `send` is typed,
 * schema-validated and idempotent, and routes through the {@link Delivery} seam
 * (never a direct store write). `reply` threads correctly (freeze #7). `markRead`
 * event-sources read-state (freeze #4). `inbox` is a plain chronological read;
 * `outstanding`/`outstandingCount` project a recipient's unresolved actions (SF-4).
 */
export interface MailStore {
  /** Validate + idempotently deliver an envelope through the Delivery seam. */
  send(envelope: MailEnvelope): DeliveredMail;
  /** Reply to `toMail`, filling `to`/`correlationId`/`causationId` so it threads (freeze #7). */
  reply(toMail: DeliveredMail, draft: ReplyDraft): DeliveredMail;
  /** Forward a held actionable item upward, emitting the mail plus a replayed forward receipt. */
  forward(held: DeliveredMail, envelope: MailEnvelope): DeliveredMail;
  /** Resolve a held escalation down, optionally relaying a final answer, as one durable operation. */
  resolve(
    held: DeliveredMail,
    envelope: MailEnvelope,
    relays?: readonly MailEnvelope[],
  ): DeliveredMail;
  /** Mark `recipient`'s mail at `seq` read (event-sourced); informational mail "clears on view". */
  markRead(recipient: string, seq: number): DeliveredMail;
  /** Headless chronological read of a recipient's inbox. */
  inbox(recipient: string): readonly DeliveredMail[];
  /** Chronological read of every mail an agent SENT (by sender), for by-sender derivations (W5 'waiting'). */
  sentBy(sender: string): readonly DeliveredMail[];
  /** Internal replay-derived link: the held item that produced a forwarded escalation, if any. */
  forwardSource(forwardedSeq: number): DeliveredMail | undefined;
  /** A recipient's unresolved actionable items (SF-4). */
  outstanding(recipient: string): readonly DeliveredMail[];
  /** Count of a recipient's unresolved actionable items (SF-4). */
  outstandingCount(recipient: string): number;
  /** Close the underlying project store. */
  close(): void;
}

/** Optional wiring for {@link openMailStore}; mainly the injectable delivery seam (for tests). */
export interface MailStoreOptions {
  /**
   * Override the delivery seam. Defaults to {@link InProcessDelivery} over this
   * store. Injecting a double proves the bus routes through the seam — i.e. L7 can
   * swap the writer Conductor-side without touching the facade.
   */
  delivery?: Delivery;
}

/**
 * Open the project mail bus: open the PROJECT store, wire the mail projector + an
 * in-process delivery, and return the {@link MailStore} facade. Delivery is
 * injectable (default {@link InProcessDelivery}) so L7 can replace the writer.
 */
export function openMailStore(projectId: string, opts?: MailStoreOptions): MailStore {
  const store = openProjectStore(projectId);
  const projectors: readonly Projector[] = [new MailProjector()];
  const delivery = opts?.delivery ?? new InProcessDelivery(projectId, store, projectors);

  // Freeze #8: validate the envelope HERE, then hand it to the seam. The builder
  // re-validates (defense for direct callers); both share validateEnvelope, so the
  // rules can't drift. Shared by `send` and `reply`.
  function doSend(envelope: MailEnvelope): DeliveredMail {
    validateEnvelope(envelope);
    return delivery.deliver(envelope);
  }

  return {
    send: doSend,

    reply(toMail: DeliveredMail, draft: ReplyDraft): DeliveredMail {
      const current = store.transaction((tx) =>
        selectMailBySeq(tx.raw as DatabaseSync, toMail.seq),
      );
      if (!current) {
        throw new Error(`mail reply: no persisted mail seq=${toMail.seq}`);
      }
      // Thread id = the root message's seq (freeze #7): inherit the answered mail's
      // thread if it has one, else the answered mail IS the root. `causationId`
      // always points at the message being answered, so a response matches its
      // request and is never orphaned.
      const envelope: MailEnvelope = {
        type: draft.type,
        to: current.sender,
        from: draft.from ?? current.recipient,
        subject: draft.subject,
        body: draft.body,
        correlationId: current.correlationId ?? String(current.seq),
        causationId: String(current.seq),
        ...(draft.idempotencyKey != null ? { idempotencyKey: draft.idempotencyKey } : {}),
        ...(draft.decision != null ? { decision: draft.decision } : {}),
      };
      return doSend(envelope);
    },

    forward(held: DeliveredMail, envelope: MailEnvelope): DeliveredMail {
      validateEnvelope(envelope);
      if (!delivery.forward) {
        throw new Error('mail: the configured Delivery does not support forward receipts');
      }
      return delivery.forward(held, envelope);
    },

    resolve(
      held: DeliveredMail,
      envelope: MailEnvelope,
      relays?: readonly MailEnvelope[],
    ): DeliveredMail {
      validateEnvelope(envelope);
      for (const relay of relays ?? []) validateEnvelope(relay);
      if (!delivery.resolve) {
        throw new Error('mail: the configured Delivery does not support atomic resolution');
      }
      return delivery.resolve(held, envelope, relays);
    },

    markRead(recipient: string, seq: number): DeliveredMail {
      if (!delivery.markRead) {
        throw new Error(
          'mail: the configured Delivery does not support markRead (read-state seam)',
        );
      }
      return delivery.markRead(recipient, seq);
    },

    inbox(recipient: string): readonly DeliveredMail[] {
      return store.transaction((tx) => inboxForRecipient(tx.raw as DatabaseSync, recipient));
    },

    sentBy(sender: string): readonly DeliveredMail[] {
      return store.transaction((tx) => sentByForSender(tx.raw as DatabaseSync, sender));
    },

    forwardSource(forwardedSeq: number): DeliveredMail | undefined {
      return store.transaction((tx) => forwardSourceForSeq(tx.raw as DatabaseSync, forwardedSeq));
    },

    outstanding(recipient: string): readonly DeliveredMail[] {
      return store.transaction((tx) => outstandingForRecipient(tx.raw as DatabaseSync, recipient));
    },

    outstandingCount(recipient: string): number {
      return store.transaction((tx) => countOutstanding(tx.raw as DatabaseSync, recipient));
    },

    close(): void {
      store.close();
    },
  };
}
