import type { DatabaseSync } from 'node:sqlite';
import { decode } from '../replay/decode.js';
import { applyEvent, type Projector } from '../replay/projector.js';
import type { Store } from '../store/types.js';
import {
  MAIL_CLARIFY_REQUEST,
  MAIL_ESCALATION,
  MAIL_REVIEW_REQUEST,
  MAIL_REVIEW_RESPONSE,
  makeMailForwardEvent,
  makeMailEvent,
  makeMailReadEvent,
  makeMailRetractEvent,
  mailSchemas,
  mailUpcasters,
  type DeliveredMail,
  type MailEnvelope,
} from './events.js';
import { ensureInboxTable, selectMailByIdempotencyKey, selectMailBySeq } from './mail-projector.js';

function assertForwardEnvelope(held: DeliveredMail, envelope: MailEnvelope): void {
  if (held.type !== MAIL_ESCALATION && held.type !== MAIL_CLARIFY_REQUEST) {
    throw new Error(`mail forward: cannot forward '${held.type}' items`);
  }
  if (envelope.type !== MAIL_ESCALATION) {
    throw new Error(`mail forward: forwarded mail must be '${MAIL_ESCALATION}'`);
  }
  if (envelope.from !== held.recipient) {
    throw new Error('mail forward: forwarded mail sender must be the held item recipient');
  }
  if (envelope.causationId !== String(held.seq)) {
    throw new Error('mail forward: forwarded mail causationId must reference the held item');
  }
  const expectedThread = held.correlationId ?? String(held.seq);
  if (envelope.correlationId !== expectedThread) {
    throw new Error('mail forward: forwarded mail must stay in the held item thread');
  }
}

function assertResolutionEnvelope(held: DeliveredMail, envelope: MailEnvelope): void {
  if (held.type !== MAIL_ESCALATION) {
    throw new Error(`mail resolve: cannot resolve '${held.type}' items`);
  }
  if (envelope.type === MAIL_ESCALATION) {
    throw new Error('mail resolve: use forward for escalations');
  }
  if (envelope.from !== held.recipient) {
    throw new Error('mail resolve: response sender must be the held item recipient');
  }
  if (envelope.to !== held.sender) {
    throw new Error('mail resolve: response must go back to the held item sender');
  }
  if (envelope.causationId !== String(held.seq)) {
    throw new Error('mail resolve: response causationId must reference the held item');
  }
  const expectedThread = held.correlationId ?? String(held.seq);
  if (envelope.correlationId !== expectedThread) {
    throw new Error('mail resolve: response must stay in the held item thread');
  }
}

/**
 * The delivery seam (freeze #3, regression 5). The bus NEVER writes the store
 * directly — it hands a validated envelope to a `Delivery`, so L7 can place the
 * real writer Conductor-side (never inside a worker sandbox) without reworking the
 * bus. `deliver` persists the mail and makes it visible to `inbox(recipient)`; it is
 * idempotent on `idempotencyKey` within a sender/recipient/type operation boundary.
 *
 * `markRead` is the read-state half of the SAME seam: appending a read-receipt is a
 * store write too, so it must route here for the same reason (freeze #4 — read-state
 * is event-sourced). It is optional only so a minimal `Delivery` test double need not
 * implement it; the facade fails loud if a configured seam omits it.
 */
export interface Delivery {
  deliver(envelope: MailEnvelope): DeliveredMail;
  /** Deliver a validated upward escalation and atomically mark `held` forwarded. */
  forward?(held: DeliveredMail, envelope: MailEnvelope): DeliveredMail;
  /** Deliver a down-resolution and optional relay in one durable operation. */
  resolve?(
    held: DeliveredMail,
    envelope: MailEnvelope,
    relays?: readonly MailEnvelope[],
  ): DeliveredMail;
  /** Append a read-receipt for `recipient`'s mail at `seq`; returns the updated row. */
  markRead?(recipient: string, seq: number): DeliveredMail;
  /** Append a retract-receipt for `sender`'s mail at `seq` (tombstone); returns the updated row. */
  retract?(sender: string, seq: number): DeliveredMail;
}

/**
 * The PROTOTYPE delivery (spec §2 PROTOTYPE). Owns the project store + the mail
 * projectors and runs ONE `store.transaction` per `deliver`:
 *   dedupe-check → append the mail event (reserved fields populated) → fold into
 *   the inbox read-model → return the delivered mail.
 * Synchronous, so `send()` → `inbox(recipient)` shows the mail immediately with no
 * Conductor (the crux that makes every L1 AC testable headless — AC-L1-2).
 */
export class InProcessDelivery implements Delivery {
  constructor(
    private readonly projectId: string,
    private readonly store: Store,
    private readonly projectors: readonly Projector[],
  ) {}

  deliver(envelope: MailEnvelope): DeliveredMail {
    return this.store.transaction((tx) => {
      const db = tx.raw as DatabaseSync;
      ensureInboxTable(db);

      // Idempotent send (freeze #6): a duplicate key collapses to one logical
      // inbox item within the same sender/recipient/type operation boundary —
      // return the existing mail, append NO new event.
      if (envelope.idempotencyKey != null) {
        const existing = selectMailByIdempotencyKey(db, envelope.idempotencyKey, {
          recipient: envelope.to,
          sender: envelope.from,
          type: envelope.type,
        });
        if (existing) return existing;
      }

      // Never-drop (freeze #5): the store transaction throws on a failed persist;
      // we deliberately do NOT swallow it, so a dropped write surfaces as a throw.
      const [stored] = tx.append([makeMailEvent(this.projectId, envelope)]);
      applyEvent(tx, decode(stored!, mailUpcasters, mailSchemas), this.projectors);

      const delivered = selectMailBySeq(db, stored!.seq);
      if (!delivered) {
        throw new Error(
          `InProcessDelivery: inbox row missing after projection (seq=${stored!.seq})`,
        );
      }
      return delivered;
    });
  }

  /**
   * Deliver a forward-up escalation and its internal forward receipt atomically. The receipt
   * discharges `held` only after the projector can see the actual forwarded escalation row.
   */
  forward(held: DeliveredMail, envelope: MailEnvelope): DeliveredMail {
    return this.store.transaction((tx) => {
      const db = tx.raw as DatabaseSync;
      ensureInboxTable(db);

      const currentHeld = selectMailBySeq(db, held.seq);
      if (
        !currentHeld ||
        currentHeld.recipient !== held.recipient ||
        currentHeld.kind !== 'actionable' ||
        currentHeld.resolved ||
        currentHeld.retracted
      ) {
        throw new Error(
          `InProcessDelivery.forward: no unresolved actionable mail seq=${held.seq} ` +
            `(or it was retracted) ` +
            `for holder '${held.recipient}'`,
        );
      }
      assertForwardEnvelope(currentHeld, envelope);

      const [storedForward] = tx.append([makeMailEvent(this.projectId, envelope)]);
      applyEvent(tx, decode(storedForward!, mailUpcasters, mailSchemas), this.projectors);

      const [storedReceipt] = tx.append([
        makeMailForwardEvent(this.projectId, held.recipient, held.seq, envelope.to),
      ]);
      applyEvent(tx, decode(storedReceipt!, mailUpcasters, mailSchemas), this.projectors);

      const delivered = selectMailBySeq(db, storedForward!.seq);
      if (!delivered) {
        throw new Error(
          `InProcessDelivery.forward: inbox row missing after projection (seq=${storedForward!.seq})`,
        );
      }
      return delivered;
    });
  }

  /**
   * Deliver a down-resolution and optional relay atomically. This is used when an upstream answer
   * must both resolve the held escalation and flow back down to the original clarify asker.
   */
  resolve(
    held: DeliveredMail,
    envelope: MailEnvelope,
    relays: readonly MailEnvelope[] = [],
  ): DeliveredMail {
    return this.store.transaction((tx) => {
      const db = tx.raw as DatabaseSync;
      ensureInboxTable(db);

      const currentHeld = selectMailBySeq(db, held.seq);
      if (
        !currentHeld ||
        currentHeld.recipient !== held.recipient ||
        currentHeld.type !== MAIL_ESCALATION ||
        currentHeld.kind !== 'actionable' ||
        currentHeld.resolved ||
        currentHeld.retracted
      ) {
        throw new Error(
          `InProcessDelivery.resolve: no unresolved escalation seq=${held.seq} ` +
            `(or it was retracted) ` +
            `for holder '${held.recipient}'`,
        );
      }
      assertResolutionEnvelope(currentHeld, envelope);

      const [storedResponse] = tx.append([makeMailEvent(this.projectId, envelope)]);
      applyEvent(tx, decode(storedResponse!, mailUpcasters, mailSchemas), this.projectors);

      for (const relay of relays) {
        const [storedRelay] = tx.append([makeMailEvent(this.projectId, relay)]);
        applyEvent(tx, decode(storedRelay!, mailUpcasters, mailSchemas), this.projectors);
      }

      const delivered = selectMailBySeq(db, storedResponse!.seq);
      if (!delivered) {
        throw new Error(
          `InProcessDelivery.resolve: inbox row missing after projection (seq=${storedResponse!.seq})`,
        );
      }
      return delivered;
    });
  }

  /**
   * Append a read-receipt and fold it in the SAME tx (mirrors {@link deliver}). The
   * target mail must already exist for `recipient` — marking a mail that isn't in the
   * recipient's inbox is a programming error, so fail loud (Principle 9) rather than
   * write a dangling receipt. Returns the mail in its updated (`read`) shape.
   */
  markRead(recipient: string, seq: number): DeliveredMail {
    return this.store.transaction((tx) => {
      const db = tx.raw as DatabaseSync;
      ensureInboxTable(db);

      const existing = selectMailBySeq(db, seq);
      if (!existing || existing.recipient !== recipient) {
        throw new Error(
          `InProcessDelivery.markRead: no mail seq=${seq} for recipient '${recipient}'`,
        );
      }

      const [stored] = tx.append([makeMailReadEvent(this.projectId, recipient, seq)]);
      applyEvent(tx, decode(stored!, mailUpcasters, mailSchemas), this.projectors);

      const updated = selectMailBySeq(db, seq);
      if (!updated) {
        throw new Error(
          `InProcessDelivery.markRead: inbox row missing after projection (seq=${seq})`,
        );
      }
      return updated;
    });
  }

  /**
   * Append a retract-receipt and fold it in the SAME tx (mirrors {@link markRead}). Only the
   * ORIGINAL SENDER may retract: the mail at `seq` must exist AND have been sent by `sender`,
   * else fail loud (Principle 9) rather than write a dangling/forged tombstone. The mail is
   * NOT deleted (Principle 14) — the returned row carries `retracted = true` and the mail drops
   * out of the recipient's `inbox()`/`outstanding()`.
   */
  retract(sender: string, seq: number): DeliveredMail {
    return this.store.transaction((tx) => {
      const db = tx.raw as DatabaseSync;
      ensureInboxTable(db);

      const existing = selectMailBySeq(db, seq);
      if (!existing || existing.sender !== sender) {
        throw new Error(`InProcessDelivery.retract: no mail seq=${seq} sent by '${sender}'`);
      }
      if (existing.type === MAIL_REVIEW_REQUEST || existing.type === MAIL_REVIEW_RESPONSE) {
        throw new Error(
          `InProcessDelivery.retract: cannot retract review mail '${existing.type}' seq=${seq}; ` +
            'review request/response mail is tied to review-store side effects.',
        );
      }

      const [stored] = tx.append([makeMailRetractEvent(this.projectId, sender, seq)]);
      applyEvent(tx, decode(stored!, mailUpcasters, mailSchemas), this.projectors);

      const updated = selectMailBySeq(db, seq);
      if (!updated) {
        throw new Error(
          `InProcessDelivery.retract: inbox row missing after projection (seq=${seq})`,
        );
      }
      return updated;
    });
  }
}

/**
 * The L7 STUB delivery (spec §2 STUB). Fails loud (Principle 9) until the
 * Conductor owns delivery.
 */
export class LiveDeliveryStub implements Delivery {
  // L7 PLUG-POINT (Conductor → runtime substrate). The production Delivery must:
  //  (1) persist the mail event Conductor-side — NOT from inside a worker sandbox (freeze #3);
  //  (2) wake the WAITING recipient (turn lifecycle is L6);
  //  (3) inject unread *actionable* mail into the recipient's live pty session; the
  //      mail-vs-session-injection choice for deferred types is the canonical L7 question
  //      (mail-bus.md:68-72). Until then this stub fails loud (Principle 9).
  deliver(): DeliveredMail {
    throw new Error(
      'LiveDeliveryStub.deliver: live (Conductor-side) delivery is not implemented at L1. ' +
        'This is the L7 plug-point: persist the mail Conductor-side (never from a worker sandbox), ' +
        'wake the WAITING recipient, and inject unread actionable mail into its live pty session. ' +
        'Use InProcessDelivery for headless flows.',
    );
  }

  forward(): DeliveredMail {
    throw new Error(
      'LiveDeliveryStub.forward: live (Conductor-side) forwarding is not implemented at L1. ' +
        'This is the L7 plug-point: persist the forwarded mail and its forward receipt ' +
        'Conductor-side in one durable operation. Use InProcessDelivery for headless flows.',
    );
  }

  resolve(): DeliveredMail {
    throw new Error(
      'LiveDeliveryStub.resolve: live (Conductor-side) resolution is not implemented at L1. ' +
        'This is the L7 plug-point: persist the resolution and any required relay ' +
        'Conductor-side in one durable operation. Use InProcessDelivery for headless flows.',
    );
  }

  markRead(): DeliveredMail {
    throw new Error(
      'LiveDeliveryStub.markRead: live (Conductor-side) read-receipts are not implemented at L1. ' +
        'This is the L7 plug-point: append the read-receipt Conductor-side (never from a worker ' +
        'sandbox). Use InProcessDelivery for headless flows.',
    );
  }

  retract(): DeliveredMail {
    throw new Error(
      'LiveDeliveryStub.retract: live (Conductor-side) retraction is not implemented at L1. ' +
        'This is the L7 plug-point: append the retract-receipt tombstone Conductor-side (never ' +
        'from a worker sandbox). Use InProcessDelivery for headless flows.',
    );
  }
}
