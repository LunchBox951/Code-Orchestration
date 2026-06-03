import { z } from 'zod';
import type { NewEvent } from '../store/types.js';
import type { SchemaMap } from '../replay/decode.js';
import type { UpcasterRegistry } from '../replay/upcaster.js';

/**
 * L1 mail bus events live in the PROJECT store (one per registered project), so
 * the owning envelope `projectId` is the real project id (the store owner) — unlike
 * the L0 registry/config events, which live in the GLOBAL store under `@global`.
 *
 * The recipient stream is encoded in the event SCOPE using the L0 `${entity}:${id}`
 * pattern — each recipient is its own stream:
 *   - to a worker:    scope = 'mail:lead-7'
 *   - to the operator: scope = 'mail:@operator'
 *
 * Reserved-field activation (spec §3.3.1): the four L0 reserved envelope fields
 * carry live mail meaning — `actor` = sender, `correlationId` = thread id,
 * `causationId` = triggering event, `idempotencyKey` = dedupe. They live on the
 * EVENT ({@link NewEvent}), NOT in the zod payload.
 */

/** The single non-agent participant (mirrors L0's `@global` sentinel). Operator Q2: one for v1. */
export const OPERATOR = '@operator';

/** Scope prefix shared by every recipient stream; the suffix is the recipient address. */
export const MAIL_SCOPE_PREFIX = 'mail:';

/**
 * Seed mail types declared AND flowed across W2–W3. Each is declared only where it
 * is also flowed: declaring a type without a live flow would be exactly the banned
 * stub (W6 asserts this). W2 seeded the two informational prose types; W3 adds the
 * first actionable/informational threaded pair (`clarify_request` is answered by a
 * `clarify_response`). Later workers extend the enum through the open registries
 * below (a `Map` entry per type), never by editing a central switch.
 */
export const MAIL_CHAT = 'chat' as const;
export const MAIL_OPERATOR_MESSAGE = 'operator_message' as const;
export const MAIL_CLARIFY_REQUEST = 'clarify_request' as const;
export const MAIL_CLARIFY_RESPONSE = 'clarify_response' as const;
/**
 * W4 adds the first-class `approval` actionable + its `approval_response` closer
 * (freeze #8). `approval` asks the recipient to bless an outward action; the response
 * carries a structured `decision` (approve|decline) — the first NON-`{subject, body}`
 * payload, which is why {@link validateEnvelope} now parses against each type's own
 * schema. The gate ({@link DeliveredMail.decision} → `approvalOutcome`) reads the
 * recorded decision to allow/refuse the action (AC-L1-5).
 */
export const MAIL_APPROVAL = 'approval' as const;
export const MAIL_APPROVAL_RESPONSE = 'approval_response' as const;
/**
 * W5 adds the first-class `escalation` actionable (AC-L1-6) — the never-drop upward
 * protocol. It carries the shared `{subject, body}` prose (a readable problem summary +
 * context) and is **discharged only when its holder acts** in-thread: forwarding it UP
 * (a new `escalation` to the holder's parent) OR resolving it DOWN (any in-thread reply
 * back to the asker). It has NO dedicated response type. Down-resolve reuses the holder's
 * in-thread follow-up; forward-up is discharged by the internal {@link EVENT_MAIL_FORWARD}
 * receipt emitted by the validated forward seam.
 */
export const MAIL_ESCALATION = 'escalation' as const;
/**
 * L3-C activates `worker_done` — the deferred type a worker emits when it finishes through the gate.
 * It is INFORMATIONAL (bus-visible, non-sticky — freeze #3): `co_finish` sends it from the finishing
 * agent to the parent the sling recorded, carrying the shared `{subject, body}` prose (the commit +
 * test summary). It demands no response, so it registers NO completion predicate; the durable,
 * structured finish facts L5 consumes live in the worktree store's finish record, not in this ping.
 */
export const MAIL_WORKER_DONE = 'worker_done' as const;

/** Registered seed-type enum — `send` rejects any type not in here (freeze #2, #5). */
export const MAIL_TYPES = [
  MAIL_CHAT,
  MAIL_OPERATOR_MESSAGE,
  MAIL_CLARIFY_REQUEST,
  MAIL_CLARIFY_RESPONSE,
  MAIL_APPROVAL,
  MAIL_APPROVAL_RESPONSE,
  MAIL_ESCALATION,
  MAIL_WORKER_DONE,
] as const;
export type MailType = (typeof MAIL_TYPES)[number];

/**
 * The internal read-receipt event (freeze #4 — event-sourced read-state). Dotted
 * like L0's `config.set` to mark it INFRASTRUCTURE, NOT a sendable message: it is
 * deliberately NOT a member of {@link MAIL_TYPES} (so `send` keeps rejecting it and
 * W6's no-stub assertion — which iterates `MAIL_TYPES` — never sees it), yet it gets
 * a schema in {@link mailSchemas} so `decode` validates it on read/replay. A
 * `markRead`/`view` appends one; the projector folds it to set a row's `read` flag,
 * keeping "informational clears on view" a pure function of the log (rebuild-safe).
 */
export const EVENT_MAIL_READ = 'mail.read' as const;

/**
 * The internal forward-receipt event. This is infrastructure, not a sendable mail type:
 * `forwardEscalation` writes it after the upward escalation mail is persisted, and the
 * projector folds it to discharge the old holder's action. Keeping forwarding as a replayed
 * receipt prevents an arbitrary caused `escalation` mail from masquerading as a valid forward.
 */
export const EVENT_MAIL_FORWARD = 'mail.forwarded' as const;

/**
 * The internal retract-receipt event (a tombstone — Principle 14). Dotted like
 * {@link EVENT_MAIL_READ} to mark it INFRASTRUCTURE, NOT a sendable message: it is
 * deliberately NOT a member of {@link MAIL_TYPES} (so `send` keeps rejecting it and the
 * no-stub assertion — which iterates `MAIL_TYPES` — never sees it), yet it gets a schema in
 * {@link mailSchemas} so `decode` validates it on read/replay. Only the original SENDER may
 * append one (the {@link import('./delivery.js').Delivery} seam enforces ownership); the
 * projector folds it to set the target row's `retracted` flag, which drops the mail from the
 * recipient's `inbox()` and from the outstanding-action projection — but the row + log event
 * persist (never deleted), so the withdrawal is recoverable and replay-safe.
 */
export const EVENT_MAIL_RETRACTED = 'mail.retracted' as const;

/** Current payload schema version — v1; no upcasters yet (see {@link mailUpcasters}). */
export const MAIL_EVENT_V = 1;

/**
 * Informational prose payload, shared by the two seed types: a short `subject`
 * plus a free-form prose `body` (kept a string — these are informational, not
 * actionable structured types; W3+ introduce richer payloads through the registry).
 */
export const mailMessageSchema = z.object({
  subject: z.string(),
  body: z.string(),
});
export type MailMessage = z.infer<typeof mailMessageSchema>;

/**
 * The `approval_response` payload: the shared prose plus a structured `decision`
 * (freeze #8). This is the first mail payload that is NOT just `{subject, body}`, so
 * {@link validateEnvelope} validates each envelope against ITS OWN schema (from
 * {@link mailSchemas}) rather than always {@link mailMessageSchema}. The decision is
 * carried on the wire by {@link MailEnvelope.decision} and persisted log-derived onto
 * {@link DeliveredMail.decision} so the outward-action gate can read it (AC-L1-5).
 */
export const approvalResponseSchema = mailMessageSchema.extend({
  decision: z.enum(['approve', 'decline']),
});
export type ApprovalResponse = z.infer<typeof approvalResponseSchema>;
/** The decision an `approval_response` carries: bless the action or refuse it. */
export type ApprovalDecision = ApprovalResponse['decision'];

/**
 * Every mail payload extends `{subject, body}`; `approval_response` additionally
 * carries a `decision`. {@link validateEnvelope} returns this union (the parsed,
 * schema-valid payload for the envelope's type).
 */
export type MailPayload = MailMessage | ApprovalResponse;

/**
 * The read-receipt payload: the `seq` of the viewed mail. A non-negative integer
 * because it names a store seq (the inbox PK). It is the only field — the recipient
 * is carried by the event SCOPE (`mail:<recipient>`), like every other mail event.
 */
export const mailReadSchema = z.object({
  seq: z.number().int().nonnegative(),
});
export type MailRead = z.infer<typeof mailReadSchema>;

/**
 * The forward-receipt payload: the held actionable `seq` plus the parent recipient the holder
 * forwarded to. The holder is carried by the event scope/actor (`mail:<holder>`).
 */
export const mailForwardSchema = z.object({
  seq: z.number().int().nonnegative(),
  forwardedTo: z.string().min(1),
});
export type MailForward = z.infer<typeof mailForwardSchema>;

/**
 * The retract-receipt payload: the `seq` of the withdrawn mail (a non-negative integer
 * naming the inbox PK). It is the only field — the retracting sender is carried by the
 * event SCOPE/actor (`mail:<sender>`), mirroring {@link mailReadSchema}.
 */
export const mailRetractSchema = z.object({
  seq: z.number().int().nonnegative(),
});
export type MailRetract = z.infer<typeof mailRetractSchema>;

/**
 * Current-version schema per mail event type — validated on append AND on read
 * (decode). Most {@link MAIL_TYPES} members share the {@link mailMessageSchema}
 * `{subject, body}` payload (a question / an answer / prose); `approval_response`
 * carries the richer {@link approvalResponseSchema} (W4's structured `decision`).
 * {@link EVENT_MAIL_READ} gets its own schema HERE but is NOT in `MAIL_TYPES` — it is
 * folded by the projector yet can never be `send`-ed (freeze #4). Same for
 * {@link EVENT_MAIL_FORWARD}, which is the replay-safe receipt for a validated forward path.
 */
export const mailSchemas: SchemaMap = new Map<string, z.ZodType>([
  [MAIL_CHAT, mailMessageSchema],
  [MAIL_OPERATOR_MESSAGE, mailMessageSchema],
  [MAIL_CLARIFY_REQUEST, mailMessageSchema],
  [MAIL_CLARIFY_RESPONSE, mailMessageSchema],
  [MAIL_APPROVAL, mailMessageSchema],
  [MAIL_APPROVAL_RESPONSE, approvalResponseSchema],
  [MAIL_ESCALATION, mailMessageSchema], // {subject, body}: a readable problem summary + context
  [MAIL_WORKER_DONE, mailMessageSchema], // {subject, body}: the finish's commit + test summary
  [EVENT_MAIL_READ, mailReadSchema],
  [EVENT_MAIL_FORWARD, mailForwardSchema],
  [EVENT_MAIL_RETRACTED, mailRetractSchema], // infrastructure tombstone; never a MAIL_TYPES member
]);

/** No payload migrations at v1 (an empty chain is the identity upcast). */
export const mailUpcasters: UpcasterRegistry = new Map();

/**
 * What a caller hands to `send` (the wire-level mail). Addressing is minimal
 * (freeze #3): `to`/`from` are opaque non-empty strings; the only sentinel is
 * {@link OPERATOR}. No roster/identity validation (that is L6). The reserved
 * fields are optional on the wire and land on the event envelope, not the payload.
 */
export interface MailEnvelope {
  readonly type: MailType;
  readonly to: string; // recipient — opaque agent id or OPERATOR
  readonly from: string; // sender — opaque agent id (→ event.actor)
  readonly subject: string;
  readonly body: string;
  readonly correlationId?: string; // thread id
  readonly causationId?: string; // triggering event
  readonly idempotencyKey?: string; // dedupe key
  readonly decision?: ApprovalDecision; // structured payload field — ONLY `approval_response` uses it
}

/**
 * A persisted, read-back mail item — the shape `inbox()` returns and `Delivery`
 * yields. Its identity is the store `seq` (the event's global order). The
 * threading columns are carried now even though threading SEMANTICS arrive in W3,
 * so the read-model schema is stable.
 */
export interface DeliveredMail {
  readonly seq: number; // identity = the mail event's store seq
  readonly recipient: string; // derived from the event scope
  readonly sender: string; // from event.actor
  readonly type: MailType;
  readonly subject: string;
  readonly body: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly idempotencyKey?: string;
  readonly ts: number; // the persisted event ts (freeze #6 — never wall-clock on read)
  // ── W3 read-model state (all log-derived; additive so W2's inbox shape holds) ──
  readonly kind?: MailKind; // actionable | informational (from the kind registry)
  readonly read?: boolean; // an informational item "clears on view" via a read-receipt
  readonly resolved?: boolean; // an actionable item is resolved by an in-thread closing event
  readonly retracted?: boolean; // the sender withdrew it (tombstone); dropped from inbox/outstanding
  // ── W4 read-model state (log-derived) ──
  readonly decision?: ApprovalDecision; // set for `approval_response` rows; the gate reads it
}

/** A recipient's stream scope: `mail:<recipient>`. */
export function mailScope(recipient: string): string {
  return MAIL_SCOPE_PREFIX + recipient;
}

/**
 * Derive the recipient from an event scope: `mail:lead-7` → `lead-7`. Fails loud
 * (Principle 9) on an unexpected scope rather than silently folding into the wrong
 * inbox (mirrors L0 `configLayerForScope`).
 */
export function mailRecipientForScope(scope: string): string {
  if (!scope.startsWith(MAIL_SCOPE_PREFIX)) {
    throw new Error(`mail: unexpected scope '${scope}' (want '${MAIL_SCOPE_PREFIX}…')`);
  }
  const recipient = scope.slice(MAIL_SCOPE_PREFIX.length);
  if (recipient.length === 0) {
    throw new Error(`mail: empty recipient in scope '${scope}'`);
  }
  return recipient;
}

/** Reject any type not in the registered seed enum — no ad-hoc/free-form types (freeze #2). */
export function assertMailType(type: string): asserts type is MailType {
  if (!(MAIL_TYPES as readonly string[]).includes(type)) {
    throw new Error(`mail: unknown type '${type}' (registered: ${MAIL_TYPES.join(', ')})`);
  }
}

/** Reject an empty/missing address fail-loud (freeze #3); no roster validation (that is L6). */
export function assertAddress(field: 'to' | 'from', value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`mail: '${field}' must be a non-empty string`);
  }
}

/**
 * Validate an envelope (type ∈ enum, non-empty addressing, schema-valid payload)
 * and return the parsed payload. Shared by `send` (freeze #8 — validate before the
 * seam) and {@link makeMailEvent} (so the builder is self-validating, like L0's
 * `make*Event`). Idempotent, so calling it on both paths is safe.
 *
 * It parses against the type's OWN schema ({@link mailSchemas}) — built additively in
 * W4 so a structured type (`approval_response`) can carry more than `{subject, body}`
 * while every existing type keeps its `{subject, body}` contract (and tests) unchanged.
 */
export function validateEnvelope(envelope: MailEnvelope): MailPayload {
  assertMailType(envelope.type);
  assertAddress('to', envelope.to);
  assertAddress('from', envelope.from);
  if (envelope.type === MAIL_APPROVAL && envelope.to !== OPERATOR) {
    throw new Error(`mail: approval must be addressed to ${OPERATOR}`);
  }
  const schema = mailSchemas.get(envelope.type);
  if (schema == null) {
    // A registered MAIL_TYPES member with no schema is a programming error (Principle 9).
    throw new Error(`mail: no schema registered for type '${envelope.type}'`);
  }
  // The candidate payload = the shared prose fields plus any type-specific wire field.
  // Only `approval_response` reads `decision`; the (non-strict) `{subject, body}`
  // schemas strip it, so an existing type is unaffected by a stray decision.
  const candidate: Record<string, unknown> = {
    subject: envelope.subject,
    body: envelope.body,
    ...(envelope.decision != null ? { decision: envelope.decision } : {}),
  };
  return schema.parse(candidate) as MailPayload;
}

/**
 * Build + validate a mail `NewEvent` for `projectId` (payload validated before
 * append; reserved fields populated per freeze #2). The recipient stream is the
 * scope; the sender is `actor`.
 */
export function makeMailEvent(projectId: string, envelope: MailEnvelope): NewEvent {
  const payload = validateEnvelope(envelope);
  return {
    projectId,
    scope: mailScope(envelope.to),
    type: envelope.type,
    v: MAIL_EVENT_V,
    payload,
    actor: envelope.from,
    ...(envelope.correlationId != null ? { correlationId: envelope.correlationId } : {}),
    ...(envelope.causationId != null ? { causationId: envelope.causationId } : {}),
    ...(envelope.idempotencyKey != null ? { idempotencyKey: envelope.idempotencyKey } : {}),
  };
}

/**
 * Build + validate a read-receipt {@link EVENT_MAIL_READ} event: `recipient` viewed
 * the mail at `seq`. The recipient is the stream scope (so the receipt lives in the
 * same stream as the mail) and the `actor` (the viewer). The payload carries only the
 * viewed `seq`; the projector folds it to set that row's `read` flag.
 */
export function makeMailReadEvent(projectId: string, recipient: string, seq: number): NewEvent {
  assertAddress('to', recipient);
  return {
    projectId,
    scope: mailScope(recipient),
    type: EVENT_MAIL_READ,
    v: MAIL_EVENT_V,
    payload: mailReadSchema.parse({ seq }),
    actor: recipient,
  };
}

/**
 * Build + validate a retract-receipt {@link EVENT_MAIL_RETRACTED} event: `sender` withdrew
 * the mail at `seq`. The sender is the stream scope (so the tombstone lives in the same
 * stream form as a read-receipt) and the `actor`. The payload carries only the withdrawn
 * `seq`; the projector folds it to set that row's `retracted` flag. Ownership (only the
 * original sender may retract) is enforced at the {@link import('./delivery.js').Delivery}
 * seam before this is appended (mirrors `markRead` going through the seam).
 */
export function makeMailRetractEvent(projectId: string, sender: string, seq: number): NewEvent {
  assertAddress('from', sender);
  return {
    projectId,
    scope: mailScope(sender),
    type: EVENT_MAIL_RETRACTED,
    v: MAIL_EVENT_V,
    payload: mailRetractSchema.parse({ seq }),
    actor: sender,
    causationId: String(seq),
  };
}

/**
 * Build + validate a forward-receipt {@link EVENT_MAIL_FORWARD} event: `holder` forwarded the
 * actionable mail at `seq` to `forwardedTo`. The projector verifies that the matching upward
 * escalation mail exists in the same replayed log before it marks the held item resolved.
 */
export function makeMailForwardEvent(
  projectId: string,
  holder: string,
  seq: number,
  forwardedTo: string,
): NewEvent {
  assertAddress('to', holder);
  assertAddress('to', forwardedTo);
  return {
    projectId,
    scope: mailScope(holder),
    type: EVENT_MAIL_FORWARD,
    v: MAIL_EVENT_V,
    payload: mailForwardSchema.parse({ seq, forwardedTo }),
    actor: holder,
    causationId: String(seq),
  };
}

// ── Actionability classification (freeze #2) — a generic registry, not a switch ──

/** Whether a mail type demands a response (`actionable`) or is purely informational. */
export type MailKind = 'actionable' | 'informational';

/**
 * The kind registry: later workers EXTEND it by adding their type's entry (no central
 * switch to edit). Seeded for W2/W3's four types — `clarify_request` is the only
 * actionable one (it must be answered); the rest are informational.
 */
export const mailKinds: ReadonlyMap<MailType, MailKind> = new Map<MailType, MailKind>([
  [MAIL_CLARIFY_REQUEST, 'actionable'],
  [MAIL_CLARIFY_RESPONSE, 'informational'],
  [MAIL_CHAT, 'informational'],
  [MAIL_OPERATOR_MESSAGE, 'informational'],
  [MAIL_APPROVAL, 'actionable'], // asks the recipient to bless an outward action
  [MAIL_APPROVAL_RESPONSE, 'informational'], // the recorded decision; closes the approval
  [MAIL_ESCALATION, 'actionable'], // the holder must resolve-or-forward it (never drop)
  [MAIL_WORKER_DONE, 'informational'], // a worker finished; bus-visible, demands no response
]);

/**
 * Classify a mail type. A type missing from {@link mailKinds} is a programming error
 * (a type was added to `MAIL_TYPES` without classifying it), so fail loud rather than
 * silently default (Principle 9 — no-silent-failures).
 */
export function mailKind(type: MailType): MailKind {
  const kind = mailKinds.get(type);
  if (kind == null) {
    throw new Error(`mail: no kind registered for type '${type}' (extend mailKinds)`);
  }
  return kind;
}

// ── Completion-predicate registry (freeze #6) — generic Map<MailType, predicate> ──

/**
 * Decides whether `closer` (a later mail in the SAME thread) resolves the actionable
 * `item`. Pinned signature — W4/W5 reuse it verbatim. Threading is by the root
 * message's `seq` (freeze #7): a reply sets `correlationId` = the thread id and
 * `causationId` = the `seq` of the message it answers.
 */
export type CompletionPredicate = (item: DeliveredMail, closer: DeliveredMail) => boolean;

function causedBy(item: DeliveredMail, closer: DeliveredMail): boolean {
  return closer.causationId === String(item.seq);
}

function sentByHolder(item: DeliveredMail, closer: DeliveredMail): boolean {
  return closer.sender === item.recipient;
}

function sentBackToRequester(item: DeliveredMail, closer: DeliveredMail): boolean {
  return closer.recipient === item.sender;
}

function inSameThread(item: DeliveredMail, closer: DeliveredMail): boolean {
  return closer.correlationId === (item.correlationId ?? String(item.seq));
}

/**
 * The completion-predicate registry: every ACTIONABLE type registers a predicate;
 * informational types register NONE. Later workers light up by adding an entry — the
 * projector consults this generically, so it never needs a per-type switch. Seeded
 * with `clarify_request`'s predicate: the holder answers the requester with a
 * `clarify_response`. Forwarding is folded by the internal {@link EVENT_MAIL_FORWARD}
 * receipt, so a raw caused `escalation` cannot clear an item by itself.
 */
export const completionPredicates: ReadonlyMap<MailType, CompletionPredicate> = new Map<
  MailType,
  CompletionPredicate
>([
  [
    MAIL_CLARIFY_REQUEST,
    (item, closer) =>
      sentByHolder(item, closer) &&
      causedBy(item, closer) &&
      inSameThread(item, closer) &&
      closer.type === MAIL_CLARIFY_RESPONSE &&
      sentBackToRequester(item, closer),
  ],
  [
    // An `approval` is resolved by an in-thread `approval_response` answering it (freeze
    // #6) — EITHER decision resolves the actionable (the decision has been made); the
    // gate reads {@link DeliveredMail.decision} to allow/refuse. Only the approval holder
    // can answer, and the answer must route back to the requester.
    MAIL_APPROVAL,
    (item, closer) =>
      closer.type === MAIL_APPROVAL_RESPONSE &&
      sentByHolder(item, closer) &&
      sentBackToRequester(item, closer) &&
      inSameThread(item, closer) &&
      causedBy(item, closer),
  ],
  [
    // The UNIFIED resolve-or-forward model (AC-L1-6). An escalation `E` held by `R`
    // (`E.recipient === R`) is discharged precisely when ITS HOLDER produces an in-thread
    // follow-up CAUSED by it. Resolution DOWN is a holder reply to the asker. Forward UP is
    // not accepted as a raw `escalation` closer; the validated forward path emits
    // `mail.forwarded`, which the projector folds after verifying the forwarded escalation
    // exists in the log. Caused mail from the holder to anyone else must stay sticky.
    MAIL_ESCALATION,
    (item, closer) =>
      sentByHolder(item, closer) &&
      causedBy(item, closer) &&
      inSameThread(item, closer) &&
      closer.type !== MAIL_ESCALATION &&
      sentBackToRequester(item, closer),
  ],
]);

/** The completion predicate for `type`, or `undefined` for an informational type. */
export function completionPredicate(type: MailType): CompletionPredicate | undefined {
  return completionPredicates.get(type);
}
