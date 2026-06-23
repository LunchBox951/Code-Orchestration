/**
 * Issue #91 bridge — operator `approve` of a spec-lock request → `co_spec_lock`.
 *
 * The spec LOCK step (draft→locked) used to be reachable ONLY through the operator-only verb
 * `co_spec_lock`. When a coordinator instead asks for the lock via an `approval` mail and the
 * operator replies "approve", that recorded `approval_response` was DECOUPLED from the lock: nothing
 * flipped the spec to `locked`, so it stayed `draft` and `co_plan_ingest` stayed blocked.
 *
 * This module closes that gap with the same idiom issue-filing uses (`issue-file:<id>`): a
 * self-identifying, idempotency-keyed approval (`spec-lock:<taskId>`) built on
 * {@link outwardApprovalEnvelope} (so it is @operator-terminal by construction), plus ONE shared
 * primitive — {@link applyApprovalLockSideEffect} — that, on an approve answering such a mail, runs
 * the existing {@link lockSpec} path. lockSpec performs the D3 `validateCriteria` gate BEFORE
 * `recordLock`, so a decoupled approve can never bypass the fuzzy-criteria refusal, and the lock is
 * always recorded as {@link OPERATOR} (the operator authored the approve). A non-lock approval
 * (issue-file, PR-open, free-form) carries no `spec-lock:` key and is a strict no-op on specs.
 *
 * Layering note: this lives in `specs/` (not `mail/approval.ts`) because it depends on the spec
 * store + {@link lockSpec} (L6b); putting it in the lower mail layer would invert the dependency.
 */
import {
  MAIL_APPROVAL,
  OPERATOR,
  type ApprovalDecision,
  type DeliveredMail,
  type MailEnvelope,
} from '../mail/events.js';
import { outwardApprovalEnvelope } from '../mail/approval.js';
import { lockSpec } from './lock-spec.js';
import type { SpecRecord } from './events.js';
import type { SpecStore } from './specs-store.js';

/** Prefix of a spec-lock approval's idempotency key (mirrors issue-filing's `issue-file:`). */
const SPEC_LOCK_APPROVAL_PREFIX = 'spec-lock:';

/** The idempotency key for task `taskId`'s one-and-only spec-lock approval. */
export function specLockApprovalKey(taskId: string): string {
  return SPEC_LOCK_APPROVAL_PREFIX + taskId;
}

/**
 * Parse a spec-lock approval key back to its `taskId`, or `undefined` when `key` is not a
 * spec-lock key (e.g. an `issue-file:` key, or no key at all). An empty task id is rejected.
 */
export function taskIdFromSpecLockApprovalKey(key: string | undefined): string | undefined {
  if (key == null || !key.startsWith(SPEC_LOCK_APPROVAL_PREFIX)) return undefined;
  const taskId = key.slice(SPEC_LOCK_APPROVAL_PREFIX.length);
  return taskId.length > 0 ? taskId : undefined;
}

/**
 * Render the human-readable criteria preview an operator sees before blessing a lock — the exact
 * criteria that are about to be frozen. A draft with no criteria yields an explicit note (the D3
 * gate will refuse such a lock, but the preview should not be empty/misleading).
 */
function renderCriteriaPreview(spec: SpecRecord): string {
  if (spec.criteria.length === 0) return '(no acceptance criteria recorded yet)';
  return spec.criteria
    .map((c, i) => {
      const verify = c.verify != null && c.verify.length > 0 ? c.verify : '(no verify command)';
      return `${i + 1}. ${c.text}\n   verify: ${verify}`;
    })
    .join('\n');
}

/**
 * Build the self-identifying spec-lock approval mail for `spec` — addressed to @operator by
 * construction ({@link outwardApprovalEnvelope}), keyed `spec-lock:<taskId>` so retries never
 * double-ask, carrying a preview of the criteria being frozen. The matching key is what lets the
 * responder resolve WHICH spec to lock with zero new mail-schema fields.
 */
export function buildSpecLockApprovalEnvelope(opts: {
  readonly from: string;
  readonly taskId: string;
  readonly spec: SpecRecord;
}): MailEnvelope {
  const { from, taskId, spec } = opts;
  return outwardApprovalEnvelope({
    from,
    subject: `Lock spec for ${taskId}: freeze acceptance criteria`,
    body:
      `Approve to lock the spec for task '${taskId}' — its acceptance criteria are frozen for ` +
      `review (only a draft can be locked; fuzzy criteria are refused). Criteria to freeze:\n\n` +
      `${renderCriteriaPreview(spec)}`,
    idempotencyKey: specLockApprovalKey(taskId),
  });
}

/**
 * The one shared bridge both responders (operator-IPC `handleApprove` and the stdio `co_mail_send`
 * reply branch) call so they cannot drift. Returns `undefined` unless `approval` is a spec-lock
 * approval (`type === approval` AND its idempotency key parses to a taskId). On `approve` it runs
 * {@link lockSpec} as {@link OPERATOR} — which runs the D3 `validateCriteria` gate BEFORE recording
 * — and returns the locked record; a genuine fuzzy-criteria refusal propagates (the caller surfaces
 * it). On `decline` it records nothing and returns `undefined`. If the spec is already `locked` (an
 * idempotent replay/retry of the same approve), the non-draft refusal is swallowed and the current
 * record is returned rather than thrown.
 */
export function applyApprovalLockSideEffect(
  specs: SpecStore,
  approval: DeliveredMail,
  decision: ApprovalDecision,
): SpecRecord | undefined {
  if (approval.type !== MAIL_APPROVAL) return undefined;
  const taskId = taskIdFromSpecLockApprovalKey(approval.idempotencyKey);
  if (taskId == null) return undefined;
  if (decision === 'decline') return undefined;

  const current = specs.getSpec(taskId);
  // Idempotent replay: an already-locked spec is a no-op (return the locked record, never throw).
  if (current != null && current.state === 'locked') return current;

  // lockSpec runs the D3 fuzzy-criteria gate before recordLock; a real refusal propagates.
  return lockSpec(specs, taskId, OPERATOR);
}
