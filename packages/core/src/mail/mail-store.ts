import type { DatabaseSync } from 'node:sqlite';
import { decode } from '../replay/decode.js';
import { applyEvent, type Projector } from '../replay/projector.js';
import {
  activeSerializedFromEvents,
  assertReviewIdAvailableInDb,
  prepareReviewVerdictForDb,
} from '../review/review-store.js';
import { openProjectStore } from '../store/sqlite-store.js';
import type { StoreTx, StoredEvent } from '../store/types.js';
import {
  makeMergeSerializedEvent,
  makeReviewRequestedEvent,
  makeReviewVerdictEvent,
  reviewSchemas,
  reviewUpcasters,
  type ReviewRequested,
  type ReviewRequestRecord,
  type ReviewVerdictRecorded,
} from '../review/events.js';
import {
  ensureReviewTables,
  ReviewProjector,
  selectReviewRequest,
} from '../review/review-projector.js';
import {
  MAIL_REVIEW_REQUEST,
  MAIL_REVIEW_RESPONSE,
  makeMailEvent,
  mailSchemas,
  mailUpcasters,
  validateEnvelope,
  type ApprovalDecision,
  type DeliveredMail,
  type MailEnvelope,
  type MailType,
  type ReviewVerdictValue,
} from './events.js';
import { InProcessDelivery, type Delivery } from './delivery.js';
import {
  MailProjector,
  countOutstanding,
  ensureInboxTable,
  forwardSourceForSeq,
  inboxForRecipient,
  outstandingForRecipient,
  selectMailByIdempotencyKey,
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
  readonly reviewVerdict?: ReviewVerdictValue; // ONLY a `review_response` reply carries it (L5-E)
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
  /**
   * Request a human review as one durable operation: acquire the target slot, record
   * `review.requested`, and deliver the actionable `review_request` mail together.
   */
  requestHumanReview(
    envelope: MailEnvelope,
    request: ReviewRequested,
  ): { readonly mail: DeliveredMail; readonly request: ReviewRequestRecord };
  /**
   * Reply to a human `review_request` and record the corresponding review verdict atomically.
   * This is intentionally narrower than `reply`: the review_response resolves actionable mail and
   * re-enters the review gate, so both read models must commit or roll back together.
   */
  replyWithReviewVerdict(
    toMail: DeliveredMail,
    draft: ReplyDraft,
    verdict: ReviewVerdictRecorded,
  ): DeliveredMail;
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
  /** Retract `sender`'s mail at `seq` (event-sourced tombstone); only the original sender may. */
  retract(sender: string, seq: number): DeliveredMail;
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
  const reviewProjectors: readonly Projector[] = [new ReviewProjector()];
  const delivery = opts?.delivery ?? new InProcessDelivery(projectId, store, projectors);

  // Freeze #8: validate the envelope HERE, then hand it to the seam. The builder
  // re-validates (defense for direct callers); both share validateEnvelope, so the
  // rules can't drift. Shared by `send` and `reply`.
  function assertNotReviewMail(envelope: MailEnvelope, source: string): void {
    if (envelope.type === MAIL_REVIEW_REQUEST) {
      throw new Error(
        `${source}: review_request must be recorded through requestHumanReview so the ` +
          'review.requested row and actionable mail commit atomically.',
      );
    }
    if (envelope.type === MAIL_REVIEW_RESPONSE) {
      throw new Error(
        `${source}: review_response must be recorded through replyWithReviewVerdict so the ` +
          'review verdict and mail response commit atomically.',
      );
    }
  }

  function assertSameHumanReviewRequest(
    existing: ReviewRequestRecord,
    requested: ReviewRequested,
    source: string,
  ): void {
    const requestedScope = requested.scope ?? 'worker_merge';
    if (existing.scope !== requestedScope) {
      throw new Error(
        `${source}: duplicate reviewId '${requested.reviewId}' conflicts on scope: stored ` +
          `'${existing.scope}', requested '${requestedScope}'.`,
      );
    }
    if (existing.requestedBy !== requested.requestedBy) {
      throw new Error(
        `${source}: duplicate reviewId '${requested.reviewId}' conflicts on requestedBy: stored ` +
          `'${existing.requestedBy}', requested '${requested.requestedBy}'.`,
      );
    }
    const requestedReviewerKind = requested.reviewerKind ?? 'agent';
    if (existing.reviewerKind !== requestedReviewerKind) {
      throw new Error(
        `${source}: duplicate reviewId '${requested.reviewId}' conflicts on reviewerKind: stored ` +
          `'${existing.reviewerKind}', requested '${requestedReviewerKind}'.`,
      );
    }
    const requestedSpecKind = requested.specRefKind ?? 'no-locked-spec';
    const requestedSpecRef = requested.specRefRef;
    if (
      existing.specRef.kind !== requestedSpecKind ||
      (existing.specRef.kind === 'criteria' && existing.specRef.ref !== requestedSpecRef)
    ) {
      const stored =
        existing.specRef.kind === 'criteria'
          ? `criteria:${existing.specRef.ref}`
          : existing.specRef.kind;
      const incoming =
        requestedSpecKind === 'criteria' ? `criteria:${requestedSpecRef ?? ''}` : requestedSpecKind;
      throw new Error(
        `${source}: duplicate reviewId '${requested.reviewId}' conflicts on specRef: stored ` +
          `'${stored}', requested '${incoming}'.`,
      );
    }
  }

  function doSend(envelope: MailEnvelope): DeliveredMail {
    validateEnvelope(envelope);
    assertNotReviewMail(envelope, 'mail send');
    return delivery.deliver(envelope);
  }

  function buildReplyEnvelope(toMail: DeliveredMail, draft: ReplyDraft): MailEnvelope {
    const envelope: MailEnvelope = {
      type: draft.type,
      to: toMail.sender,
      from: draft.from ?? toMail.recipient,
      subject: draft.subject,
      body: draft.body,
      correlationId: toMail.correlationId ?? String(toMail.seq),
      causationId: String(toMail.seq),
      ...(draft.idempotencyKey != null ? { idempotencyKey: draft.idempotencyKey } : {}),
      ...(draft.decision != null ? { decision: draft.decision } : {}),
      ...(draft.reviewVerdict != null ? { reviewVerdict: draft.reviewVerdict } : {}),
    };
    validateEnvelope(envelope);
    return envelope;
  }

  function reviewRequestIdempotencyKey(reviewId: string): string {
    return `review-request:${reviewId}`;
  }

  function applyStored(tx: StoreTx, stored: StoredEvent) {
    if (projectors.some((p) => p.handles(stored.type))) {
      applyEvent(tx, decode(stored, mailUpcasters, mailSchemas), projectors);
      return;
    }
    applyEvent(tx, decode(stored, reviewUpcasters, reviewSchemas), reviewProjectors);
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
      if (current.retracted) {
        throw new Error(`mail reply: mail seq=${toMail.seq} was retracted`);
      }
      if (draft.type === MAIL_REVIEW_RESPONSE) {
        throw new Error(
          'mail reply: review_response must be recorded through replyWithReviewVerdict so ' +
            'the review verdict and mail response commit atomically.',
        );
      }
      // Thread id = the root message's seq (freeze #7): inherit the answered mail's
      // thread if it has one, else the answered mail IS the root. `causationId`
      // always points at the message being answered, so a response matches its
      // request and is never orphaned.
      const envelope = buildReplyEnvelope(current, draft);
      return doSend(envelope);
    },

    requestHumanReview(
      envelope: MailEnvelope,
      request: ReviewRequested,
    ): { readonly mail: DeliveredMail; readonly request: ReviewRequestRecord } {
      validateEnvelope(envelope);
      if (envelope.type !== MAIL_REVIEW_REQUEST) {
        throw new Error(
          `mail human review request: expected review_request envelope, got '${envelope.type}'.`,
        );
      }
      if (envelope.from !== request.requestedBy) {
        throw new Error(
          `mail human review request: envelope sender '${envelope.from}' must match ` +
            `requestedBy '${request.requestedBy}'.`,
        );
      }
      const expectedIdempotencyKey = reviewRequestIdempotencyKey(request.reviewId);
      if (envelope.idempotencyKey !== expectedIdempotencyKey) {
        throw new Error(
          `mail human review request: expected idempotency_key '${expectedIdempotencyKey}', got ` +
            `'${envelope.idempotencyKey ?? '<none>'}'.`,
        );
      }
      if (request.reviewerKind !== 'human') {
        throw new Error(
          `mail human review request: review '${request.reviewId}' must be routed to ` +
            `reviewerKind=human, got '${request.reviewerKind ?? 'agent'}'.`,
        );
      }
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureInboxTable(db);
        ensureReviewTables(db);
        if (envelope.idempotencyKey != null) {
          const existing = selectMailByIdempotencyKey(db, envelope.idempotencyKey, {
            recipient: envelope.to,
            sender: envelope.from,
            type: envelope.type,
          });
          if (existing) {
            const existingRequest = selectReviewRequest(db, request.target, request.branch);
            if (existingRequest != null && existingRequest.reviewId === request.reviewId) {
              assertSameHumanReviewRequest(existingRequest, request, 'mail human review request');
              return { mail: existing, request: existingRequest };
            }
            throw new Error(
              `mail human review request: idempotency_key '${envelope.idempotencyKey}' already ` +
                'belongs to existing mail without the matching durable review.requested row.',
            );
          }
        }
        assertReviewIdAvailableInDb(db, request.reviewId, request.target, request.branch);
        const active = activeSerializedFromEvents(db, request.target);
        if (active !== undefined && active !== request.branch) {
          throw new Error(
            `mail human review request: refused — '${active}' is the active reviewer/merge for ` +
              `'${request.target}'.`,
          );
        }
        const events = [
          ...(active === undefined
            ? [
                makeMergeSerializedEvent(projectId, {
                  target: request.target,
                  branch: request.branch,
                }),
              ]
            : []),
          makeReviewRequestedEvent(projectId, request),
          makeMailEvent(projectId, envelope),
        ];
        const stored = tx.append(events);
        for (const event of stored) applyStored(tx, event);
        const record = selectReviewRequest(db, request.target, request.branch);
        if (!record) {
          throw new Error(
            `mail human review request: review request row missing after projection ` +
              `(target='${request.target}', branch='${request.branch}')`,
          );
        }
        const delivered = selectMailBySeq(db, stored.at(-1)!.seq);
        if (!delivered) {
          throw new Error(
            `mail human review request: inbox row missing after projection ` +
              `(seq=${stored.at(-1)!.seq})`,
          );
        }
        return { mail: delivered, request: record };
      });
    },

    replyWithReviewVerdict(
      toMail: DeliveredMail,
      draft: ReplyDraft,
      verdict: ReviewVerdictRecorded,
    ): DeliveredMail {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureInboxTable(db);
        ensureReviewTables(db);
        const current = selectMailBySeq(db, toMail.seq);
        if (!current) {
          throw new Error(`mail review reply: no persisted mail seq=${toMail.seq}`);
        }
        if (current.retracted) {
          throw new Error(`mail review reply: mail seq=${toMail.seq} was retracted`);
        }
        if (current.type !== MAIL_REVIEW_REQUEST) {
          throw new Error(
            `mail review reply: mail seq=${current.seq} is '${current.type}', not review_request.`,
          );
        }
        const expectedRequestKey = reviewRequestIdempotencyKey(verdict.reviewId);
        if (current.idempotencyKey !== expectedRequestKey) {
          throw new Error(
            `mail review reply: review_request mail ${current.seq} must carry idempotency_key ` +
              `'${expectedRequestKey}', got '${current.idempotencyKey ?? '<none>'}'.`,
          );
        }
        if (draft.type !== MAIL_REVIEW_RESPONSE) {
          throw new Error(
            `mail review reply: expected review_response draft, got '${draft.type}'.`,
          );
        }
        if (draft.reviewVerdict !== verdict.verdict) {
          throw new Error(
            `mail review reply: review_response review_verdict '${draft.reviewVerdict ?? '<none>'}' ` +
              `does not match recorded verdict '${verdict.verdict}'.`,
          );
        }
        if (draft.from != null && draft.from !== current.recipient) {
          throw new Error(
            `mail review reply: review_response sender '${draft.from}' must match request ` +
              `recipient '${current.recipient}'.`,
          );
        }
        const envelope = buildReplyEnvelope(current, draft);
        if (verdict.reviewer !== envelope.from) {
          throw new Error(
            `mail review reply: verdict reviewer '${verdict.reviewer}' must match ` +
              `review_response sender '${envelope.from}'.`,
          );
        }
        if (envelope.idempotencyKey != null) {
          const existing = selectMailByIdempotencyKey(db, envelope.idempotencyKey, {
            recipient: envelope.to,
            sender: envelope.from,
            type: envelope.type,
          });
          if (existing) {
            if (existing.causationId !== String(current.seq)) {
              throw new Error(
                `mail review reply: idempotency_key '${envelope.idempotencyKey}' already ` +
                  `belongs to review_request mail ${existing.causationId ?? '<unknown>'}; ` +
                  `it cannot answer mail ${current.seq}.`,
              );
            }
            if (existing.reviewVerdict !== draft.reviewVerdict) {
              throw new Error(
                `mail review reply: idempotent review_response retry for mail ${current.seq} ` +
                  `changes review_verdict from '${existing.reviewVerdict ?? '<none>'}' to ` +
                  `'${draft.reviewVerdict ?? '<none>'}'.`,
              );
            }
            if (existing.subject !== draft.subject || existing.body !== draft.body) {
              throw new Error(
                `mail review reply: idempotent review_response retry for mail ${current.seq} ` +
                  'changes subject/body.',
              );
            }
            return existing;
          }
        }
        if (current.resolved) {
          throw new Error(`mail review reply: mail seq=${toMail.seq} is already resolved`);
        }
        const request = selectReviewRequest(db, verdict.target, verdict.branch);
        if (request == null) {
          throw new Error(
            `mail review reply: review_request mail ${current.seq} has no matching ` +
              'review.requested row.',
          );
        }
        if (request.reviewerKind !== 'human') {
          throw new Error(
            `mail review reply: review_request mail ${current.seq} is not a human ` +
              `review_request (reviewerKind=${request.reviewerKind}).`,
          );
        }
        if (request.requestedBy !== current.sender) {
          throw new Error(
            `mail review reply: review_request mail ${current.seq} requestedBy ` +
              `'${request.requestedBy}' does not match mail sender '${current.sender}'.`,
          );
        }
        if (request.reviewId !== verdict.reviewId) {
          throw new Error(
            `mail review reply: review_request mail ${current.seq} is for reviewId ` +
              `'${verdict.reviewId}', but the latest durable request is '${request.reviewId}'.`,
          );
        }

        const preparedVerdict = prepareReviewVerdictForDb(db, verdict, 'mail review reply');
        const events = [makeReviewVerdictEvent(projectId, preparedVerdict)];
        if (preparedVerdict.verdict === 'ISSUES') {
          const active = activeSerializedFromEvents(db, preparedVerdict.target);
          if (active !== undefined && active !== preparedVerdict.branch) {
            throw new Error(
              `mail review reply: '${preparedVerdict.branch}' does not hold the merge slot ` +
                `for '${preparedVerdict.target}' (active holder: ${active}).`,
            );
          }
          if (active === preparedVerdict.branch) {
            events.push(
              makeMergeSerializedEvent(projectId, {
                target: preparedVerdict.target,
                branch: preparedVerdict.branch,
              }),
            );
          }
        }
        events.push(makeMailEvent(projectId, envelope));
        const stored = tx.append(events);
        for (const event of stored) applyStored(tx, event);

        const delivered = selectMailBySeq(db, stored.at(-1)!.seq);
        if (!delivered) {
          throw new Error(
            `mail review reply: inbox row missing after projection (seq=${stored.at(-1)!.seq})`,
          );
        }
        return delivered;
      });
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
      assertNotReviewMail(envelope, 'mail resolve');
      for (const relay of relays ?? []) {
        validateEnvelope(relay);
        assertNotReviewMail(relay, 'mail resolve');
      }
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

    retract(sender: string, seq: number): DeliveredMail {
      if (!delivery.retract) {
        throw new Error('mail: the configured Delivery does not support retract (tombstone seam)');
      }
      return delivery.retract(sender, seq);
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
