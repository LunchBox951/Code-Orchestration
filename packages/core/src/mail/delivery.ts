import type { DatabaseSync } from 'node:sqlite';
import { decode } from '../replay/decode.js';
import { applyEvent, type Projector } from '../replay/projector.js';
import type { Store } from '../store/types.js';
import {
  makeMailEvent,
  mailSchemas,
  mailUpcasters,
  type DeliveredMail,
  type MailEnvelope,
} from './events.js';
import { ensureInboxTable, selectMailByIdempotencyKey, selectMailBySeq } from './mail-projector.js';

/**
 * The delivery seam (freeze #3, regression 5). `send()` NEVER writes the store
 * directly — it hands a validated envelope to a `Delivery`, so L7 can place the
 * real writer Conductor-side without reworking the bus. `deliver` persists the
 * mail and makes it visible to `inbox(recipient)`; it is idempotent on
 * `idempotencyKey`.
 */
export interface Delivery {
  deliver(envelope: MailEnvelope): DeliveredMail;
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
      // inbox item — return the existing mail, append NO new event.
      if (envelope.idempotencyKey != null) {
        const existing = selectMailByIdempotencyKey(db, envelope.idempotencyKey);
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
}
