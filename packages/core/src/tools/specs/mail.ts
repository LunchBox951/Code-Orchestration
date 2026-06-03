import { z } from 'zod';
import { MAIL_TYPES, type DeliveredMail } from '../../mail/events.js';
import type { ToolSpec } from '../registry.js';
import { deliveredMailSchema, toWireMail, type WireMail } from './wire.js';

// The caller's identity is ALWAYS `ctx.agent` — a tool never takes `from`/`sender` as input
// (an agent can only act as itself). Every input field carries a .describe() (Principle 5 —
// the schemas are the single syntax source the MCP surface and the phase-D check read).

// ── co_mail_send ──────────────────────────────────────────────────────────────
const mailSendInput = z.object({
  to: z
    .string()
    .optional()
    .describe(
      'Recipient agent id (or @operator). Required for a NEW message; ignored when replying ' +
        '(the recipient is derived from the answered mail).',
    ),
  type: z
    .enum(MAIL_TYPES)
    .describe('The mail type (a registered MailType, e.g. clarify_request, escalation, chat).'),
  subject: z.string().describe('Short subject line for the message.'),
  body: z.string().describe('The message body (free-form prose).'),
  in_reply_to: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('The seq of a mail in YOUR inbox to thread this reply onto; omit to start anew.'),
  idempotency_key: z
    .string()
    .optional()
    .describe('Optional dedupe key; a repeat send with the same key collapses to the first.'),
  decision: z
    .enum(['approve', 'decline'])
    .optional()
    .describe('Only for an approval_response reply: approve or decline the requested action.'),
});
type MailSendInput = z.infer<typeof mailSendInput>;

export const mailSendTool: ToolSpec<MailSendInput, WireMail> = {
  name: 'co_mail_send',
  title: 'Send mail',
  description:
    'Send a new typed message to another agent, or thread a reply onto a mail in your inbox. ' +
    'You always send as yourself; replies derive recipient and threading from the answered mail.',
  inputSchema: mailSendInput,
  outputSchema: deliveredMailSchema,
  handler: (ctx, input): WireMail => {
    let delivered: DeliveredMail;
    if (input.in_reply_to != null) {
      // Reply: load the answered mail from the CALLER's inbox (the caller must be its
      // recipient) and thread through `reply`, which derives to/correlationId/causationId so
      // the reply can never orphan (freeze #7). `to` is irrelevant on a reply.
      const answered = ctx.mail.inbox(ctx.agent).find((m) => m.seq === input.in_reply_to);
      if (!answered) {
        throw new Error(
          `co_mail_send: cannot reply to mail ${input.in_reply_to} — it is not in ` +
            `${ctx.agent}'s inbox (you must be its recipient).`,
        );
      }
      delivered = ctx.mail.reply(answered, {
        type: input.type,
        subject: input.subject,
        body: input.body,
        from: ctx.agent,
        ...(input.idempotency_key != null ? { idempotencyKey: input.idempotency_key } : {}),
        ...(input.decision != null ? { decision: input.decision } : {}),
      });
    } else {
      if (input.to == null || input.to.length === 0) {
        throw new Error(
          'co_mail_send: `to` is required for a new message (omit it only when replying via in_reply_to).',
        );
      }
      // L1 validateEnvelope enforces type∈enum, non-empty addressing, and approval→@operator;
      // its throw surfaces as the tool error.
      delivered = ctx.mail.send({
        type: input.type,
        to: input.to,
        from: ctx.agent,
        subject: input.subject,
        body: input.body,
        ...(input.idempotency_key != null ? { idempotencyKey: input.idempotency_key } : {}),
        ...(input.decision != null ? { decision: input.decision } : {}),
      });
    }
    return toWireMail(delivered);
  },
};

// ── co_mail_inbox ─────────────────────────────────────────────────────────────
const mailInboxInput = z.object({
  unread_only: z
    .boolean()
    .optional()
    .describe(
      'When true, return only mail still needing attention: unresolved actionables or unread informational mail.',
    ),
});
type MailInboxInput = z.infer<typeof mailInboxInput>;

const mailListOutput = z.object({
  mail: z.array(deliveredMailSchema).describe('The matching mail, oldest first (by seq).'),
});
type MailListOutput = z.infer<typeof mailListOutput>;

export const mailInboxTool: ToolSpec<MailInboxInput, MailListOutput> = {
  name: 'co_mail_inbox',
  title: 'Read inbox',
  description:
    'Read your inbox (the mail addressed to you), oldest first. Optionally narrow to mail that ' +
    'still needs your attention. Retracted mail is never shown.',
  inputSchema: mailInboxInput,
  outputSchema: mailListOutput,
  handler: (ctx, input): MailListOutput => {
    let mail = ctx.mail.inbox(ctx.agent);
    if (input.unread_only) {
      mail = mail.filter((m) => (m.kind === 'actionable' ? !m.resolved : !m.read));
    }
    return { mail: mail.map(toWireMail) };
  },
};

// ── co_mail_get ───────────────────────────────────────────────────────────────
const mailGetInput = z.object({
  id: z
    .number()
    .int()
    .nonnegative()
    .describe('The seq of the mail to fetch; you must be its sender or its recipient.'),
});
type MailGetInput = z.infer<typeof mailGetInput>;

const mailOneOutput = z.object({
  mail: deliveredMailSchema.describe('The requested mail.'),
});
type MailOneOutput = z.infer<typeof mailOneOutput>;

export const mailGetTool: ToolSpec<MailGetInput, MailOneOutput> = {
  name: 'co_mail_get',
  title: 'Get one mail',
  description:
    'Fetch a single mail by its seq. Visible only if you sent it or received it — there is no ' +
    'cross-agent peeking.',
  inputSchema: mailGetInput,
  outputSchema: mailOneOutput,
  handler: (ctx, input): MailOneOutput => {
    const visible = [...ctx.mail.inbox(ctx.agent), ...ctx.mail.sentBy(ctx.agent)];
    const found = visible.find((m) => m.seq === input.id);
    if (!found) {
      throw new Error(`co_mail_get: mail ${input.id} not found or not visible to ${ctx.agent}`);
    }
    return { mail: toWireMail(found) };
  },
};

// ── co_mail_thread ────────────────────────────────────────────────────────────
const mailThreadInput = z.object({
  thread_id: z
    .string()
    .describe('The thread id (the root mail seq as a string) whose visible mail to return.'),
});
type MailThreadInput = z.infer<typeof mailThreadInput>;

export const mailThreadTool: ToolSpec<MailThreadInput, MailListOutput> = {
  name: 'co_mail_thread',
  title: 'Read a thread',
  description:
    'Return every mail in a thread that is visible to you (you sent or received it), ordered ' +
    'oldest first. A root mail with no thread id belongs to the thread named by its own seq.',
  inputSchema: mailThreadInput,
  outputSchema: mailListOutput,
  handler: (ctx, input): MailListOutput => {
    const bySeq = new Map<number, DeliveredMail>();
    for (const m of [...ctx.mail.inbox(ctx.agent), ...ctx.mail.sentBy(ctx.agent)]) {
      const threadId = m.correlationId ?? String(m.seq);
      if (threadId === input.thread_id) bySeq.set(m.seq, m);
    }
    const mail = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    return { mail: mail.map(toWireMail) };
  },
};

// ── co_mail_ack ───────────────────────────────────────────────────────────────
const mailAckInput = z.object({
  ids: z
    .array(z.number().int().nonnegative())
    .describe('The seqs of mail you received to mark read (acknowledged).'),
});
type MailAckInput = z.infer<typeof mailAckInput>;

const mailAckOutput = z.object({
  acked: z.array(deliveredMailSchema).describe('The mail just marked read, in the given order.'),
});
type MailAckOutput = z.infer<typeof mailAckOutput>;

export const mailAckTool: ToolSpec<MailAckInput, MailAckOutput> = {
  name: 'co_mail_ack',
  title: 'Acknowledge mail',
  description:
    'Mark one or more of your received mails as read (the event-sourced read-receipt). ' +
    'Acknowledging informational mail clears it; it never resolves an actionable item.',
  inputSchema: mailAckInput,
  outputSchema: mailAckOutput,
  handler: (ctx, input): MailAckOutput => {
    // markRead only requires that the mail belongs to the caller (by recipient); acking a
    // RETRACTED tombstone therefore succeeds and just sets `read` on a row already hidden from
    // inbox()/unread counts — a benign no-op on visibility at L2 (review #68). The live L7
    // delivery seam may want to reject acking a withdrawn mail; left as an L7 consideration.
    const acked = input.ids.map((id) => ctx.mail.markRead(ctx.agent, id));
    return { acked: acked.map(toWireMail) };
  },
};

// ── co_mail_retract ───────────────────────────────────────────────────────────
const mailRetractInput = z.object({
  id: z
    .number()
    .int()
    .nonnegative()
    .describe('The seq of a mail YOU sent to withdraw; only the original sender may retract it.'),
});
type MailRetractInput = z.infer<typeof mailRetractInput>;

export const mailRetractTool: ToolSpec<MailRetractInput, MailOneOutput> = {
  name: 'co_mail_retract',
  title: 'Retract mail',
  description:
    'Withdraw a mail you sent. The message becomes a tombstone — it drops out of the ' +
    "recipient's inbox and outstanding actions, but the record persists (it is never deleted).",
  inputSchema: mailRetractInput,
  outputSchema: mailOneOutput,
  handler: (ctx, input): MailOneOutput => {
    return { mail: toWireMail(ctx.mail.retract(ctx.agent, input.id)) };
  },
};
