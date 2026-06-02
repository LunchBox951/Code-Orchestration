import { assertNever } from '../assert-never.js';
import {
  MAIL_APPROVAL,
  MAIL_APPROVAL_RESPONSE,
  OPERATOR,
  type ApprovalDecision,
  type DeliveredMail,
  type MailEnvelope,
} from './events.js';
import type { MailStore } from './mail-store.js';

/**
 * The outward-action gate (AC-L1-5, spec §C). `approval` is a first-class actionable
 * type; a recorded `approval_response` decision then gates a (synthetic, at L1) OUTWARD
 * action: blocked while pending, run on approve, refused on decline. The outcome is
 * derived from the LOG (the rebuildable inbox projection), never a wall-clock / mutable
 * flag, so a discard+replay reproduces it (freeze #4). The general parent-resolver
 * (a coordinator's escalation parent = @operator for every class) is W5; this module
 * holds only the narrow outward-approval-class terminal-recipient rule (operator Q3).
 */

/** The replay-safe outcome of an approval, derived from its in-thread response (if any). */
export type ApprovalOutcome = 'pending' | 'approved' | 'declined';

/**
 * Derive an approval's outcome from the log. The closing `approval_response` answers the
 * approval (its `causationId` is the approval's seq) and, because a reply always routes
 * back to the asker, lands in the approval SENDER's inbox. No response yet → `pending`;
 * otherwise its `decision` gives `approved` / `declined`. Reads only the rebuildable
 * inbox projection, so the outcome survives a projection rebuild (AC-L1-5 replay-safe).
 */
export function approvalOutcome(mail: MailStore, approval: DeliveredMail): ApprovalOutcome {
  const response = mail
    .inbox(approval.sender)
    .find((m) => m.type === MAIL_APPROVAL_RESPONSE && m.causationId === String(approval.seq));
  const decision: ApprovalDecision | undefined = response?.decision;
  switch (decision) {
    case undefined:
      return 'pending';
    case 'approve':
      return 'approved';
    case 'decline':
      return 'declined';
    default:
      return assertNever(decision);
  }
}

/**
 * Gate a (synthetic, at L1) OUTWARD action behind a recorded approval (AC-L1-5): run it
 * only once `approved`; BLOCK it (throw) while `pending`; REFUSE it (throw) on `declined`.
 * Fail-loud either way (Principle 9) — an ungated outward action is never silently
 * allowed. Real outward-action instances (issue-filing, PR-open) are L3/L5/L6; the L1
 * exercise wraps a test spy.
 */
export function gateOutwardAction<T>(outcome: ApprovalOutcome, action: () => T): T {
  switch (outcome) {
    case 'approved':
      return action();
    case 'pending':
      throw new Error('approval gate: outward action BLOCKED — approval is still pending');
    case 'declined':
      throw new Error('approval gate: outward action REFUSED — approval was declined');
    default:
      return assertNever(outcome);
  }
}

/** A request to bless a genuinely-outward / irreversible action — addressed to @operator. */
export interface OutwardApprovalRequest {
  readonly from: string;
  readonly subject: string;
  readonly body: string;
  readonly idempotencyKey?: string;
}

/**
 * Address a genuinely-outward / irreversible approval. Operator Q3 + freeze #5: such an
 * approval ALWAYS terminates at {@link OPERATOR} (the operator is the primary interaction
 * point for outward/irreversible actions). Encoding the rule as the builder for outward
 * approvals means one cannot be misaddressed to a peer. The GENERAL parent-resolver
 * (coordinator → @operator for every escalation class) is W5; this holds only the narrow
 * outward-approval-class terminal-recipient rule. (Internal merge/push/PR gating is L5's
 * reviewer, NOT approval-mail.)
 */
export function outwardApprovalEnvelope(req: OutwardApprovalRequest): MailEnvelope {
  return {
    type: MAIL_APPROVAL,
    to: OPERATOR,
    from: req.from,
    subject: req.subject,
    body: req.body,
    ...(req.idempotencyKey != null ? { idempotencyKey: req.idempotencyKey } : {}),
  };
}
