import type { DatabaseSync } from 'node:sqlite';
import type { Projector } from '../replay/projector.js';
import type { StoredEvent, StoreTx } from '../store/types.js';
import {
  EVENT_MAIL_READ,
  MAIL_TYPES,
  completionPredicate,
  mailKind,
  mailRecipientForScope,
  type DeliveredMail,
  type MailMessage,
  type MailRead,
  type MailType,
} from './events.js';

/**
 * The `inbox` read-model. Identity of a mail = its store `seq` (PK). `recipient`
 * is derived from the event scope and `sender` from `actor`; the threading columns
 * (`correlation_id`/`causation_id`/`idempotency_key`) carry the L0 reserved fields.
 * `ts` is the PERSISTED event ts — never wall-clock on read (freeze #6).
 *
 * W3 state columns (all log-derived, so a `rebuildAll` reproduces them byte-identical
 * — AC-L1-3 / AC-L0-2):
 *   - `kind`      — actionable | informational, from the kind registry at fold time.
 *   - `read`      — set by a {@link EVENT_MAIL_READ} read-receipt; "informational
 *                   clears on view" without any mutable-only state.
 *   - `resolved`  — set when a closing event in the same thread satisfies this
 *                   actionable item's completion predicate (freeze #4 — un-loseable:
 *                   viewing does NOT resolve; only a real closing event does).
 *   - `thread_id` — the root message's seq as a string (`correlation_id ?? seq`),
 *                   so resolution matches request↔response within a thread (freeze #7).
 *
 * Indexes: `recipient` for `inbox(recipient)`, `idempotency_key` for the dedupe
 * lookup, `thread_id` for in-thread resolution, and `(recipient, kind, resolved)`
 * for the outstanding-action projection (SF-4).
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
    ts              INTEGER NOT NULL,
    kind            TEXT NOT NULL,
    read            INTEGER NOT NULL DEFAULT 0,
    resolved        INTEGER NOT NULL DEFAULT 0,
    thread_id       TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_inbox_recipient_seq ON inbox (recipient, seq);
  CREATE INDEX IF NOT EXISTS idx_inbox_idempotency_key ON inbox (idempotency_key);
  CREATE INDEX IF NOT EXISTS idx_inbox_thread ON inbox (thread_id);
  CREATE INDEX IF NOT EXISTS idx_inbox_outstanding ON inbox (recipient, kind, resolved);
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
  'seq, recipient, sender, type, subject, body, correlation_id, causation_id, idempotency_key, ts, kind, read, resolved';

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
    kind: String(row.kind) as DeliveredMail['kind'],
    read: Number(row.read) === 1,
    resolved: Number(row.resolved) === 1,
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
 * A recipient's OUTSTANDING actions (SF-4): actionable items addressed to them whose
 * completion predicate is not yet satisfied (`resolved = 0`). Resolved actionable
 * items and read informational items are NOT outstanding.
 */
export function outstandingForRecipient(db: DatabaseSync, recipient: string): DeliveredMail[] {
  ensureInboxTable(db);
  const rows = db
    .prepare(
      `SELECT ${INBOX_COLUMNS} FROM inbox
       WHERE recipient = ? AND kind = 'actionable' AND resolved = 0
       ORDER BY seq`,
    )
    .all(recipient);
  return rows.map(rowToDeliveredMail);
}

/** Count of a recipient's outstanding actions — the {@link outstandingForRecipient} cardinality. */
export function countOutstanding(db: DatabaseSync, recipient: string): number {
  ensureInboxTable(db);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM inbox
       WHERE recipient = ? AND kind = 'actionable' AND resolved = 0`,
    )
    .get(recipient) as { n: number };
  return Number(row.n);
}

/** Open (unresolved) actionable items in `threadId`, excluding `excludeSeq` (the closer itself). */
function openActionableInThread(
  db: DatabaseSync,
  threadId: string,
  excludeSeq: number,
): DeliveredMail[] {
  const rows = db
    .prepare(
      `SELECT ${INBOX_COLUMNS} FROM inbox
       WHERE thread_id = ? AND kind = 'actionable' AND resolved = 0 AND seq != ?
       ORDER BY seq`,
    )
    .all(threadId, excludeSeq);
  return rows.map(rowToDeliveredMail);
}

/** Thread id = the root message's seq (freeze #7): a reply's `correlationId`, else its own `seq`. */
function threadIdOf(event: StoredEvent): string {
  return event.correlationId ?? String(event.seq);
}

/**
 * Folds mail events AND read-receipts into the `inbox` read-model, in the SAME tx as
 * the append so the log and the projection commit atomically; carries NO wall-clock
 * field (freeze #6 — it persists the event ts).
 *
 * `handles()` covers every {@link MAIL_TYPES} member (so later workers light up by
 * registering their type, not by editing this projector) plus {@link EVENT_MAIL_READ}.
 *
 * Resolution is generic (freeze #6): after inserting a mail row, it consults the
 * completion-predicate registry for any OPEN actionable item in the same thread and
 * marks it resolved if the predicate fires — never a hardcoded "if response then
 * resolve request" switch, so W4/W5 light up by registering a predicate.
 */
export class MailProjector implements Projector {
  readonly name = 'inbox';

  handles(type: string): boolean {
    return type === EVENT_MAIL_READ || (MAIL_TYPES as readonly string[]).includes(type);
  }

  reset(tx: StoreTx): void {
    const db = tx.raw as DatabaseSync;
    ensureInboxTable(db);
    db.exec('DELETE FROM inbox');
  }

  apply(tx: StoreTx, event: StoredEvent): void {
    const db = tx.raw as DatabaseSync;
    ensureInboxTable(db);
    if (event.type === EVENT_MAIL_READ) {
      this.applyReadReceipt(db, event);
      return;
    }
    this.applyMail(db, event);
  }

  /** Insert a mail row, then resolve any open actionable item its arrival closes. */
  private applyMail(db: DatabaseSync, event: StoredEvent): void {
    // Every mail carries a sender (`send` validates `from` non-empty); fail loud
    // rather than fold a senderless row (Principle 9).
    if (event.actor == null) {
      throw new Error(`mail projector: event seq=${event.seq} has no actor (sender)`);
    }
    const recipient = mailRecipientForScope(event.scope);
    const { subject, body } = event.payload as MailMessage;
    const type = event.type as MailType; // guaranteed ∈ MAIL_TYPES by handles()
    const threadId = threadIdOf(event);
    db.prepare(
      `INSERT INTO inbox
         (seq, recipient, sender, type, subject, body, correlation_id, causation_id,
          idempotency_key, ts, kind, read, resolved, thread_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)`,
    ).run(
      event.seq,
      recipient,
      event.actor,
      type,
      subject,
      body,
      event.correlationId ?? null,
      event.causationId ?? null,
      event.idempotencyKey ?? null,
      event.ts,
      mailKind(type),
      threadId,
    );

    // Generic resolution: this freshly-folded mail is a potential closer. For each
    // open actionable item in its thread, ask that item's registered predicate
    // whether this closer resolves it (freeze #4/#6 — the projector never hardcodes
    // the request/response pairing).
    const closer = selectMailBySeq(db, event.seq);
    if (!closer) {
      throw new Error(`mail projector: inbox row missing after insert (seq=${event.seq})`);
    }
    for (const item of openActionableInThread(db, threadId, event.seq)) {
      const predicate = completionPredicate(item.type);
      if (predicate && predicate(item, closer)) {
        db.prepare('UPDATE inbox SET resolved = 1 WHERE seq = ?').run(item.seq);
      }
    }
  }

  /** Fold a read-receipt: set the target row's `read` flag (idempotent; rebuild-safe). */
  private applyReadReceipt(db: DatabaseSync, event: StoredEvent): void {
    const recipient = mailRecipientForScope(event.scope);
    const { seq } = event.payload as MailRead;
    db.prepare('UPDATE inbox SET read = 1 WHERE seq = ? AND recipient = ?').run(seq, recipient);
  }
}
