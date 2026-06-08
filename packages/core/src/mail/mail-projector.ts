import type { DatabaseSync } from 'node:sqlite';
import type { Projector } from '../replay/projector.js';
import type { StoredEvent, StoreTx } from '../store/types.js';
import {
  EVENT_MAIL_FORWARD,
  EVENT_MAIL_READ,
  EVENT_MAIL_RETRACTED,
  MAIL_APPROVAL_RESPONSE,
  MAIL_CLARIFY_REQUEST,
  MAIL_ESCALATION,
  MAIL_REVIEW_RESPONSE,
  MAIL_TYPES,
  completionPredicate,
  mailKind,
  mailRecipientForScope,
  type ApprovalDecision,
  type ApprovalResponse,
  type DeliveredMail,
  type MailForward,
  type MailMessage,
  type MailRead,
  type MailRetract,
  type MailType,
  type ReviewResponse,
} from './events.js';
import type { Verdict } from '../review/verdict.js';

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
 *                   actionable item's completion predicate, or when a replay-verified
 *                   {@link EVENT_MAIL_FORWARD} receipt proves the item was forwarded up
 *                   (freeze #4 — un-loseable: viewing does NOT resolve; only a real
 *                   closing event or validated forward does).
 *   - `thread_id` — the root message's seq as a string (`correlation_id ?? seq`),
 *                   so resolution matches request↔response within a thread (freeze #7).
 *   - `decision`  — nullable; the approve/decline an `approval_response` carries (W4).
 *                   Log-derived from the payload, so the outward-action gate reads it
 *                   replay-safely; NULL for every other type.
 *   - `retracted` — set by a {@link EVENT_MAIL_RETRACTED} tombstone (only the original
 *                   sender can append one). A retracted mail drops out of `inbox()` and the
 *                   outstanding-action projection, but its row + log event persist
 *                   (Principle 14 — recoverable, replay-safe).
 *
 * Indexes: `recipient` for `inbox(recipient)`, idempotency scope for the dedupe lookup,
 * `thread_id` for in-thread resolution, and `(recipient, kind, resolved)` for the
 * outstanding-action projection (SF-4).
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
    thread_id       TEXT NOT NULL,
    decision        TEXT,
    retracted       INTEGER NOT NULL DEFAULT 0,
    review_verdict  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_inbox_recipient_seq ON inbox (recipient, seq);
  CREATE INDEX IF NOT EXISTS idx_inbox_idempotency_scope
    ON inbox (idempotency_key, recipient, sender, type);
  CREATE INDEX IF NOT EXISTS idx_inbox_thread ON inbox (thread_id);
  CREATE INDEX IF NOT EXISTS idx_inbox_outstanding ON inbox (recipient, kind, resolved);
  CREATE INDEX IF NOT EXISTS idx_inbox_sender ON inbox (sender);

  CREATE TABLE IF NOT EXISTS inbox_forward_links (
    forwarded_seq INTEGER PRIMARY KEY,
    held_seq      INTEGER NOT NULL,
    holder        TEXT NOT NULL,
    forwarded_to  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_inbox_forward_links_held ON inbox_forward_links (held_seq);
`;

/**
 * Defensive create of the `inbox` read-model. Called from the projector's
 * reset/apply AND every read path, so a freshly opened store can be queried before
 * any write has happened.
 */
export function ensureInboxTable(db: DatabaseSync): void {
  db.exec(CREATE_INBOX_TABLE);
  addMissingInboxColumn(db, 'retracted', 'INTEGER NOT NULL DEFAULT 0');
  addMissingInboxColumn(db, 'review_verdict', 'TEXT');
}

function addMissingInboxColumn(db: DatabaseSync, column: string, definition: string): void {
  const columns = db.prepare('PRAGMA table_info(inbox)').all() as Array<{ readonly name: string }>;
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE inbox ADD COLUMN ${column} ${definition}`);
  }
}

/** Columns selected for every read, in `inbox` order — mapped by name in {@link rowToDeliveredMail}. */
const INBOX_COLUMNS =
  'seq, recipient, sender, type, subject, body, correlation_id, causation_id, idempotency_key, ts, kind, read, resolved, decision, retracted, review_verdict';

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
    retracted: Number(row.retracted) === 1,
    ...(row.decision != null ? { decision: String(row.decision) as ApprovalDecision } : {}),
    ...(row.review_verdict != null ? { reviewVerdict: String(row.review_verdict) as Verdict } : {}),
  };
}

/**
 * A recipient's chronological inbox: `WHERE recipient = ? ORDER BY seq`. Retracted mail is
 * excluded — a withdrawn message is no longer in the inbox (its tombstone row still persists
 * for recovery/replay; see {@link EVENT_MAIL_RETRACTED}).
 */
export function inboxForRecipient(db: DatabaseSync, recipient: string): DeliveredMail[] {
  ensureInboxTable(db);
  const rows = db
    .prepare(
      `SELECT ${INBOX_COLUMNS} FROM inbox WHERE recipient = ? AND retracted = 0 ORDER BY seq`,
    )
    .all(recipient);
  return rows.map(rowToDeliveredMail);
}

/** The mail at `seq`, or undefined. Used to return the just-delivered item in its read shape. */
export function selectMailBySeq(db: DatabaseSync, seq: number): DeliveredMail | undefined {
  ensureInboxTable(db);
  const row = db.prepare(`SELECT ${INBOX_COLUMNS} FROM inbox WHERE seq = ?`).get(seq);
  return row ? rowToDeliveredMail(row as Record<string, unknown>) : undefined;
}

/** The operation boundary for idempotent send dedupe (freeze #6). */
export interface IdempotencyScope {
  readonly recipient: string;
  readonly sender: string;
  readonly type: MailType;
}

/** The earliest mail with `idempotencyKey` in `scope`, or undefined — the dedupe lookup. */
export function selectMailByIdempotencyKey(
  db: DatabaseSync,
  idempotencyKey: string,
  scope: IdempotencyScope,
): DeliveredMail | undefined {
  ensureInboxTable(db);
  const row = db
    .prepare(
      `SELECT ${INBOX_COLUMNS} FROM inbox
       WHERE idempotency_key = ? AND recipient = ? AND sender = ? AND type = ?
       ORDER BY seq LIMIT 1`,
    )
    .get(idempotencyKey, scope.recipient, scope.sender, scope.type);
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
       WHERE recipient = ? AND kind = 'actionable' AND resolved = 0 AND retracted = 0
       ORDER BY seq`,
    )
    .all(recipient);
  return rows.map(rowToDeliveredMail);
}

/**
 * All mail a given agent SENT (matched on `sender` = the event `actor`), chronological.
 * Unlike {@link inboxForRecipient} (keyed by RECIPIENT), this is keyed by SENDER, so an
 * agent can find the actionable items IT RAISED — e.g. the W5 'awaiting reply' query.
 */
export function sentByForSender(db: DatabaseSync, sender: string): DeliveredMail[] {
  ensureInboxTable(db);
  const rows = db
    .prepare(`SELECT ${INBOX_COLUMNS} FROM inbox WHERE sender = ? ORDER BY seq`)
    .all(sender);
  return rows.map(rowToDeliveredMail);
}

/** The held item that produced forwarded escalation `forwardedSeq`, if it came through the forward seam. */
export function forwardSourceForSeq(
  db: DatabaseSync,
  forwardedSeq: number,
): DeliveredMail | undefined {
  ensureInboxTable(db);
  const link = db
    .prepare('SELECT held_seq FROM inbox_forward_links WHERE forwarded_seq = ?')
    .get(forwardedSeq) as { held_seq: number } | undefined;
  return link ? selectMailBySeq(db, Number(link.held_seq)) : undefined;
}

/** Count of a recipient's outstanding actions — the {@link outstandingForRecipient} cardinality. */
export function countOutstanding(db: DatabaseSync, recipient: string): number {
  ensureInboxTable(db);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM inbox
       WHERE recipient = ? AND kind = 'actionable' AND resolved = 0 AND retracted = 0`,
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
         AND retracted = 0
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
 * registering their type, not by editing this projector) plus infrastructure receipts
 * {@link EVENT_MAIL_READ} and {@link EVENT_MAIL_FORWARD}.
 *
 * Resolution is generic (freeze #6): after inserting a mail row, it consults the
 * completion-predicate registry for any OPEN actionable item in the same thread and
 * marks it resolved if the predicate fires — never a hardcoded "if response then
 * resolve request" switch, so W4/W5 light up by registering a predicate.
 */
export class MailProjector implements Projector {
  readonly name = 'inbox';

  handles(type: string): boolean {
    return (
      type === EVENT_MAIL_READ ||
      type === EVENT_MAIL_FORWARD ||
      type === EVENT_MAIL_RETRACTED ||
      (MAIL_TYPES as readonly string[]).includes(type)
    );
  }

  reset(tx: StoreTx): void {
    const db = tx.raw as DatabaseSync;
    ensureInboxTable(db);
    db.exec('DELETE FROM inbox');
    db.exec('DELETE FROM inbox_forward_links');
  }

  apply(tx: StoreTx, event: StoredEvent): void {
    const db = tx.raw as DatabaseSync;
    ensureInboxTable(db);
    if (event.type === EVENT_MAIL_READ) {
      this.applyReadReceipt(db, event);
      return;
    }
    if (event.type === EVENT_MAIL_FORWARD) {
      this.applyForwardReceipt(db, event);
      return;
    }
    if (event.type === EVENT_MAIL_RETRACTED) {
      this.applyRetractReceipt(db, event);
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
    // Only `approval_response` carries a structured decision; persist it log-derived so
    // the outward-action gate reads it replay-safely. NULL for every other type.
    const decision: ApprovalDecision | null =
      type === MAIL_APPROVAL_RESPONSE ? (event.payload as ApprovalResponse).decision : null;
    // Only `review_response` carries a structured reviewVerdict; persist it log-derived so
    // the human-review gate reads it replay-safely (AC-L5-5). NULL for every other type.
    const reviewVerdict: Verdict | null =
      type === MAIL_REVIEW_RESPONSE ? (event.payload as ReviewResponse).reviewVerdict : null;
    db.prepare(
      `INSERT INTO inbox
         (seq, recipient, sender, type, subject, body, correlation_id, causation_id,
          idempotency_key, ts, kind, read, resolved, thread_id, decision, review_verdict)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
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
      decision,
      reviewVerdict,
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

  /**
   * Fold a retract-receipt: set the target row's `retracted` flag (idempotent; rebuild-safe).
   * The receipt's scope/actor IS the original sender, so we match on `sender` (mirrors how the
   * read-receipt matches on `recipient`) — a tombstone can only mark a mail the actor sent.
   * The row is NOT deleted (Principle 14); `inbox()`/`outstanding()` exclude it by `retracted`.
   */
  private applyRetractReceipt(db: DatabaseSync, event: StoredEvent): void {
    const sender = mailRecipientForScope(event.scope);
    const { seq } = event.payload as MailRetract;
    db.prepare('UPDATE inbox SET retracted = 1 WHERE seq = ? AND sender = ?').run(seq, sender);
  }

  /**
   * Fold a forward-receipt: first prove the holder really sent an escalation caused by the held
   * item to the recorded parent, then discharge the old holder's actionable item.
   */
  private applyForwardReceipt(db: DatabaseSync, event: StoredEvent): void {
    const holder = mailRecipientForScope(event.scope);
    if (event.actor !== holder) {
      throw new Error(
        `mail projector: forward receipt seq=${event.seq} actor '${event.actor ?? '<none>'}' ` +
          `does not match holder '${holder}'`,
      );
    }

    const { seq, forwardedTo } = event.payload as MailForward;
    const item = selectMailBySeq(db, seq);
    if (!item || item.recipient !== holder || item.kind !== 'actionable' || item.retracted) {
      throw new Error(
        `mail projector: forward receipt seq=${event.seq} names non-actionable, retracted, or missing ` +
          `item ${seq} for holder '${holder}'`,
      );
    }
    if (item.type !== MAIL_ESCALATION && item.type !== MAIL_CLARIFY_REQUEST) {
      throw new Error(
        `mail projector: forward receipt seq=${event.seq} cannot forward '${item.type}' items`,
      );
    }

    const forwarded = db
      .prepare(
        `SELECT seq FROM inbox
         WHERE sender = ? AND recipient = ? AND type = ? AND causation_id = ? AND correlation_id = ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(holder, forwardedTo, MAIL_ESCALATION, String(seq), item.correlationId ?? String(seq)) as
      | { seq: number }
      | undefined;
    if (!forwarded) {
      throw new Error(
        `mail projector: forward receipt seq=${event.seq} has no matching escalation ` +
          `from '${holder}' to '${forwardedTo}' caused by ${seq}`,
      );
    }

    const duplicate = db
      .prepare('SELECT forwarded_seq FROM inbox_forward_links WHERE held_seq = ?')
      .get(seq);
    if (duplicate) {
      throw new Error(`mail projector: item ${seq} already has a forward receipt`);
    }

    db.prepare(
      `UPDATE inbox
       SET resolved = 1
       WHERE seq = ? AND recipient = ? AND kind = 'actionable'`,
    ).run(seq, holder);
    db.prepare(
      `INSERT INTO inbox_forward_links (forwarded_seq, held_seq, holder, forwarded_to)
       VALUES (?, ?, ?, ?)`,
    ).run(Number(forwarded.seq), seq, holder, forwardedTo);
  }
}
