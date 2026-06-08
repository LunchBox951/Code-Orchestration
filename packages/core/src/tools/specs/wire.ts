import { z } from 'zod';
import type { DeliveredMail } from '../../mail/events.js';

/**
 * The shared wire projection of a {@link DeliveredMail} for tool I/O. A faithful, STRUCTURED
 * (not prose-blob) view: `seq, recipient, sender, type, subject, body, ts` plus the optional
 * log-derived fields. Field names are snake_case for consistency with the prototype's tool
 * surface; {@link toWireMail} maps from the core camelCase `DeliveredMail`. The internal
 * `idempotencyKey` (a dedupe detail) is deliberately omitted.
 */
export const deliveredMailSchema = z.object({
  seq: z.number().int().describe('Stable identity of the mail — its event-store sequence number.'),
  recipient: z.string().describe('The agent (or @operator) the mail was addressed to.'),
  sender: z.string().describe('The agent that sent the mail.'),
  type: z.string().describe('The mail type (a registered MailType, e.g. clarify_request, chat).'),
  subject: z.string().describe('The subject line.'),
  body: z.string().describe('The message body (prose).'),
  ts: z.number().describe('The persisted event timestamp (never re-stamped on read).'),
  correlation_id: z
    .string()
    .optional()
    .describe('Thread id — the root mail seq as a string; groups a request with its replies.'),
  causation_id: z
    .string()
    .optional()
    .describe('The seq of the mail this one was caused by (a reply points at what it answers).'),
  kind: z
    .enum(['actionable', 'informational'])
    .optional()
    .describe('Whether the mail demands a response (actionable) or is purely informational.'),
  read: z.boolean().optional().describe('True once the recipient has acknowledged (read) it.'),
  resolved: z
    .boolean()
    .optional()
    .describe('True once an actionable item has been closed by an in-thread reply.'),
  retracted: z.boolean().optional().describe('True once the sender has withdrawn it (tombstone).'),
  decision: z
    .enum(['approve', 'decline'])
    .optional()
    .describe('For an approval_response only: the recorded approve/decline decision.'),
  review_verdict: z
    .enum(['PASS', 'ISSUES'])
    .optional()
    .describe('For a review_response only: the recorded PASS/ISSUES verdict.'),
});

/** The validated structured shape of a single mail in tool output. */
export type WireMail = z.infer<typeof deliveredMailSchema>;

/**
 * Project a core {@link DeliveredMail} (camelCase) to the snake_case wire shape. Optional
 * fields are included only when present, so the structured output stays faithful to the log.
 */
export function toWireMail(m: DeliveredMail): WireMail {
  return {
    seq: m.seq,
    recipient: m.recipient,
    sender: m.sender,
    type: m.type,
    subject: m.subject,
    body: m.body,
    ts: m.ts,
    ...(m.correlationId != null ? { correlation_id: m.correlationId } : {}),
    ...(m.causationId != null ? { causation_id: m.causationId } : {}),
    ...(m.kind != null ? { kind: m.kind } : {}),
    ...(m.read != null ? { read: m.read } : {}),
    ...(m.resolved != null ? { resolved: m.resolved } : {}),
    ...(m.retracted != null ? { retracted: m.retracted } : {}),
    ...(m.decision != null ? { decision: m.decision } : {}),
    ...(m.reviewVerdict != null ? { review_verdict: m.reviewVerdict } : {}),
  };
}
