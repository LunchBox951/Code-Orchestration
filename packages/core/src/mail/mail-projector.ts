import type { DatabaseSync } from 'node:sqlite';
import type { Projector } from '../replay/projector.js';
import type { StoredEvent, StoreTx } from '../store/types.js';
import {
  MAIL_CHAT,
  MAIL_OPERATOR_MESSAGE,
  mailRecipientForScope,
  type DeliveredMail,
  type MailMessage,
  type MailType,
} from './events.js';

/**
 * The `inbox` read-model. Identity of a mail = its store `seq` (PK). `recipient`
 * is derived from the event scope and `sender` from `actor`; the threading columns
 * (`correlation_id`/`causation_id`/`idempotency_key`) are carried now even though
 * threading SEMANTICS land in W3, so the schema is stable. `ts` is the PERSISTED
 * event ts — never wall-clock on read (freeze #6). An index on `idempotency_key`
 * makes the dedupe check cheap; one on `recipient` makes `inbox(recipient)` cheap.
 */
const CREATE_INBOX_TABLE = `
  CREATE TABLE IF NOT EXISTS inbox (
    seq             INTEGER PRIMARY KEY,
    recipient       TEXT NOT NULL,
    sender          TEXT NOT NULL,
    type            TEXT NOT NULL,
    subject         TEXT NOT NULL,
    body            TEXT NOT NULL,
    correlation_id  TEXT,
    causation_id    TEXT,
    idempotency_key TEXT,
    ts              INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_inbox_recipient_seq ON inbox (recipient, seq);
  CREATE INDEX IF NOT EXISTS idx_inbox_idempotency_key ON inbox (idempotency_key);
`;

/**
 * Defensive create of the `inbox` read-model. Called from the projector's
 * reset/apply AND every read path, so a freshly opened store can be queried before
 * any write has happened.
 */
export function ensureInboxTable(db: DatabaseSync): void {
  db.exec(CREATE_INBOX_TABLE);
}

/** Columns selected for every read, in `inbox` order — mapped by name in {@link rowToDeliveredMail}. */
const INBOX_COLUMNS =
  'seq, recipient, sender, type, subject, body, correlation_id, causation_id, idempotency_key, ts';

/** Map a raw `inbox` row (loosely typed at the SQLite boundary) to a {@link DeliveredMail}. */
export function rowToDeliveredMail(row: Record<string, unknown>): DeliveredMail {
  return {
    seq: Number(row.seq),
    recipient: String(row.recipient),
    sender: String(row.sender),
    type: String(row.type) as MailType,
    subject: String(row.subject),
    body: String(row.body),
    ...(row.correlation_id != null ? { correlationId: String(row.correlation_id) } : {}),
    ...(row.causation_id != null ? { causationId: String(row.causation_id) } : {}),
    ...(row.idempotency_key != null ? { idempotencyKey: String(row.idempotency_key) } : {}),
    ts: Number(row.ts),
  };
}

/** A recipient's chronological inbox: `WHERE recipient = ? ORDER BY seq`. */
export function inboxForRecipient(db: DatabaseSync, recipient: string): DeliveredMail[] {
  ensureInboxTable(db);
  const rows = db
    .prepare(`SELECT ${INBOX_COLUMNS} FROM inbox WHERE recipient = ? ORDER BY seq`)
    .all(recipient);
  return rows.map(rowToDeliveredMail);
}

/** The mail at `seq`, or undefined. Used to return the just-delivered item in its read shape. */
export function selectMailBySeq(db: DatabaseSync, seq: number): DeliveredMail | undefined {
  ensureInboxTable(db);
  const row = db.prepare(`SELECT ${INBOX_COLUMNS} FROM inbox WHERE seq = ?`).get(seq);
  return row ? rowToDeliveredMail(row as Record<string, unknown>) : undefined;
}

/** The earliest mail with `idempotencyKey`, or undefined — the dedupe lookup (freeze #6). */
export function selectMailByIdempotencyKey(
  db: DatabaseSync,
  idempotencyKey: string,
): DeliveredMail | undefined {
  ensureInboxTable(db);
  const row = db
    .prepare(`SELECT ${INBOX_COLUMNS} FROM inbox WHERE idempotency_key = ? ORDER BY seq LIMIT 1`)
    .get(idempotencyKey);
  return row ? rowToDeliveredMail(row as Record<string, unknown>) : undefined;
}

/**
 * Folds the informational seed types (`chat`, `operator_message`) into the `inbox`
 * read-model, in the SAME tx as the append so the log and the projection commit
 * atomically. Both seed types share the {@link MailMessage} payload, so `apply`
 * needs no discriminated switch — `handles()` already guarantees the type. Carries
 * NO wall-clock field (freeze #6 — it persists the event ts).
 */
export class MailProjector implements Projector {
  readonly name = 'inbox';

  handles(type: string): boolean {
    return type === MAIL_CHAT || type === MAIL_OPERATOR_MESSAGE;
  }

  reset(tx: StoreTx): void {
    const db = tx.raw as DatabaseSync;
    ensureInboxTable(db);
    db.exec('DELETE FROM inbox');
  }

  apply(tx: StoreTx, event: StoredEvent): void {
    const db = tx.raw as DatabaseSync;
    ensureInboxTable(db);
    // Every mail carries a sender (`send` validates `from` non-empty); fail loud
    // rather than fold a senderless row (Principle 9).
    if (event.actor == null) {
      throw new Error(`mail projector: event seq=${event.seq} has no actor (sender)`);
    }
    const recipient = mailRecipientForScope(event.scope);
    const { subject, body } = event.payload as MailMessage;
    db.prepare(
      `INSERT INTO inbox
         (seq, recipient, sender, type, subject, body, correlation_id, causation_id, idempotency_key, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.seq,
      recipient,
      event.actor,
      event.type,
      subject,
      body,
      event.correlationId ?? null,
      event.causationId ?? null,
      event.idempotencyKey ?? null,
      event.ts,
    );
  }
}
