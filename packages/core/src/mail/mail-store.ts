import type { DatabaseSync } from 'node:sqlite';
import { openProjectStore } from '../store/sqlite-store.js';
import type { Projector } from '../replay/projector.js';
import { validateEnvelope, type DeliveredMail, type MailEnvelope } from './events.js';
import { InProcessDelivery, type Delivery } from './delivery.js';
import { MailProjector, inboxForRecipient } from './mail-projector.js';

/**
 * The headless mail bus over a single project store (AC-L1-1, AC-L1-2). `send`
 * is typed, schema-validated and idempotent, and routes through the {@link Delivery}
 * seam (never a direct store write); `inbox` is a plain chronological read of a
 * recipient's mail (read-state/actionable semantics are W3).
 */
export interface MailStore {
  /** Validate + idempotently deliver an envelope through the Delivery seam. */
  send(envelope: MailEnvelope): DeliveredMail;
  /** Headless chronological read of a recipient's inbox. */
  inbox(recipient: string): readonly DeliveredMail[];
  /** Close the underlying project store. */
  close(): void;
}

/** Optional wiring for {@link openMailStore}; mainly the injectable delivery seam (for tests). */
export interface MailStoreOptions {
  /**
   * Override the delivery seam. Defaults to {@link InProcessDelivery} over this
   * store. Injecting a double proves `send` routes through the seam — i.e. L7 can
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

  return {
    send(envelope: MailEnvelope): DeliveredMail {
      // Freeze #8: validate the envelope HERE, then hand it to the seam. The
      // builder re-validates (defense for direct callers); both share
      // validateEnvelope, so the rules can't drift.
      validateEnvelope(envelope);
      return delivery.deliver(envelope);
    },

    inbox(recipient: string): readonly DeliveredMail[] {
      return store.transaction((tx) => inboxForRecipient(tx.raw as DatabaseSync, recipient));
    },

    close(): void {
      store.close();
    },
  };
}
