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
 * Seed mail types this worker (W2) declares AND flows. Both are informational
 * prose. The full 7-type enum is owned across W2–W5: declaring a type without a
 * live flow here would be exactly the banned stub (W6 asserts this), so we declare
 * ONLY what we flow. Later workers extend the enum through the open registry.
 */
export const MAIL_CHAT = 'chat' as const;
export const MAIL_OPERATOR_MESSAGE = 'operator_message' as const;

/** Registered seed-type enum — `send` rejects any type not in here (freeze #2, #5). */
export const MAIL_TYPES = [MAIL_CHAT, MAIL_OPERATOR_MESSAGE] as const;
export type MailType = (typeof MAIL_TYPES)[number];

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

/** Current-version schema per mail event type — validated on append AND on read (decode). */
export const mailSchemas: SchemaMap = new Map<string, z.ZodType>([
  [MAIL_CHAT, mailMessageSchema],
  [MAIL_OPERATOR_MESSAGE, mailMessageSchema],
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
 */
export function validateEnvelope(envelope: MailEnvelope): MailMessage {
  assertMailType(envelope.type);
  assertAddress('to', envelope.to);
  assertAddress('from', envelope.from);
  return mailMessageSchema.parse({ subject: envelope.subject, body: envelope.body });
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
