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
   * Deliver a down-resolution and optional relays atomically, returning the response row AND every
   * delivered relay row. {@link resolve} is the {@link Delivery}-interface wrapper that returns just
   * the response; {@link LiveDelivery} uses this richer form so it can wake/inject each relay recipient
   * — a relay is a NEW item delivered to a (possibly WAITING) recipient, e.g. the answer flowing back
   * down to the original clarify asker, so it must be woken like any other delivery (freeze #3 / duty 2).
   */
  resolveWithRelays(
    held: DeliveredMail,
    envelope: MailEnvelope,
    relays: readonly MailEnvelope[] = [],
  ): { response: DeliveredMail; relays: readonly DeliveredMail[] } {
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
          `InProcessDelivery.resolveWithRelays: no unresolved escalation seq=${held.seq} ` +
            `(or it was retracted) ` +
            `for holder '${held.recipient}'`,
        );
      }
      assertResolutionEnvelope(currentHeld, envelope);

      const [storedResponse] = tx.append([makeMailEvent(this.projectId, envelope)]);
      applyEvent(tx, decode(storedResponse!, mailUpcasters, mailSchemas), this.projectors);

      const relayRows: DeliveredMail[] = [];
      for (const relay of relays) {
        const [storedRelay] = tx.append([makeMailEvent(this.projectId, relay)]);
        applyEvent(tx, decode(storedRelay!, mailUpcasters, mailSchemas), this.projectors);
        const relayRow = selectMailBySeq(db, storedRelay!.seq);
        if (!relayRow) {
          throw new Error(
            `InProcessDelivery.resolveWithRelays: relay row missing after projection (seq=${storedRelay!.seq})`,
          );
        }
        relayRows.push(relayRow);
      }

      const response = selectMailBySeq(db, storedResponse!.seq);
      if (!response) {
        throw new Error(
          `InProcessDelivery.resolveWithRelays: inbox row missing after projection (seq=${storedResponse!.seq})`,
        );
      }
      return { response, relays: relayRows };
    });
  }

  /**
   * Deliver a down-resolution and optional relay atomically (the {@link Delivery} seam). Returns the
   * resolution response row; any relays are persisted in the SAME transaction. See
   * {@link resolveWithRelays} for the form that also returns the relay rows (used by
   * {@link LiveDelivery} to wake/inject each relay recipient).
   */
  resolve(
    held: DeliveredMail,
    envelope: MailEnvelope,
    relays: readonly MailEnvelope[] = [],
  ): DeliveredMail {
    return this.resolveWithRelays(held, envelope, relays).response;
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
 * Wake a WAITING recipient so it takes a turn on its newly-delivered mail. The turn lifecycle is L6
 * and the real wake is host-side integration, so it is an INJECTED seam here — sandbox-testable, and
 * `delivery.ts` stays decoupled from L6/pty. Synchronous: it only signals; it does not await a turn.
 */
export type WakeRecipient = (recipient: string) => void;

/**
 * Inject an unread *actionable* mail into the recipient's LIVE pty session. Wired in production to
 * `injectMail` on the recipient's `Pane` (resolved via the B0 session record's pane↔agent map); an
 * INJECTED seam here so `delivery.ts` never statically imports `pty/` and stays sandbox-testable.
 */
export type InjectToRecipient = (recipient: string, mail: DeliveredMail) => void;

export interface LiveDeliveryOptions {
  readonly wake: WakeRecipient;
  readonly injectToRecipient: InjectToRecipient;
}

/**
 * Whether a just-delivered mail is the kind that must be PUSHED into a live session: an `actionable`
 * item that is still outstanding (not already read / resolved / retracted). Informational mail is
 * persisted + the recipient is woken, but never injected (it demands no response).
 */
function isInjectableActionable(mail: DeliveredMail): boolean {
  return mail.kind === 'actionable' && !mail.read && !mail.resolved && !mail.retracted;
}

/**
 * The L7 Conductor-side delivery (replaces the former `LiveDeliveryStub`). Its three duties:
 *   1. **Persist Conductor-side** — the store-write half is IDENTICAL to {@link InProcessDelivery}, so
 *      we DELEGATE to a composed instance (same projectId/store/projectors) rather than re-implement
 *      the transaction logic (freeze #3 — one writer). "Conductor-side" just means this runs in the
 *      Conductor process, never a worker sandbox; composition satisfies that.
 *   2. **Wake the WAITING recipient** — via the injected {@link WakeRecipient} seam, on every operation
 *      that delivers a NEW item to a recipient: `deliver`, `forward`, and `resolve` — the last waking
 *      BOTH the resolution response AND every relay recipient (each relay is its own new-item delivery,
 *      e.g. an answer flowing back down to the original asker). Receipts (`markRead`/`retract`) deliver
 *      nothing new, so they persist only — no wake.
 *   3. **Inject unread actionable mail into the recipient's live pty** — via the injected
 *      {@link InjectToRecipient} seam, for each woken item that is an outstanding `actionable`
 *      ({@link isInjectableActionable}) — including an actionable `resolve` relay. Informational mail
 *      and receipts are never injected.
 *
 * Decoupling: `wake` and `injectToRecipient` are constructor-injected callbacks; this module does NOT
 * import `pty/`. Wiring the seams to real panes is host-side integration, not this sandbox's job.
 */
export class LiveDelivery implements Delivery {
  private readonly inner: InProcessDelivery;

  constructor(
    projectId: string,
    store: Store,
    projectors: readonly Projector[],
    private readonly opts: LiveDeliveryOptions,
  ) {
    this.inner = new InProcessDelivery(projectId, store, projectors);
  }

  deliver(envelope: MailEnvelope): DeliveredMail {
    const delivered = this.inner.deliver(envelope);
    this.wakeAndMaybeInject(delivered);
    return delivered;
  }

  forward(held: DeliveredMail, envelope: MailEnvelope): DeliveredMail {
    const delivered = this.inner.forward(held, envelope);
    this.wakeAndMaybeInject(delivered);
    return delivered;
  }

  resolve(
    held: DeliveredMail,
    envelope: MailEnvelope,
    relays: readonly MailEnvelope[] = [],
  ): DeliveredMail {
    // The resolution response AND every relay are NEW items delivered to (possibly WAITING) recipients
    // — wake each, and inject the outstanding-actionable ones (e.g. an answer relayed back down to the
    // original asker). A relay delivered to a WAITING agent that was NOT woken was the gap (review #193).
    const { response, relays: relayRows } = this.inner.resolveWithRelays(held, envelope, relays);
    this.wakeAndMaybeInject(response);
    for (const relayRow of relayRows) this.wakeAndMaybeInject(relayRow);
    return response;
  }

  markRead(recipient: string, seq: number): DeliveredMail {
    // A read-receipt delivers nothing new — persist only (no wake, no injection).
    return this.inner.markRead(recipient, seq);
  }

  retract(sender: string, seq: number): DeliveredMail {
    // A retract-receipt is a tombstone — persist only (no wake, no injection).
    return this.inner.retract(sender, seq);
  }

  private wakeAndMaybeInject(delivered: DeliveredMail): void {
    this.opts.wake(delivered.recipient);
    if (isInjectableActionable(delivered)) {
      this.opts.injectToRecipient(delivered.recipient, delivered);
    }
  }
}
