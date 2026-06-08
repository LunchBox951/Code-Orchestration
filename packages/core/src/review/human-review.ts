import { assertNever } from '../assert-never.js';
import {
  MAIL_REVIEW_REQUEST,
  MAIL_REVIEW_RESPONSE,
  OPERATOR,
  type DeliveredMail,
  type MailEnvelope,
} from '../mail/events.js';
import type { MailStore } from '../mail/mail-store.js';
import { openConfigStore } from '../config/config-store.js';
import type { ReviewScope } from './ladder.js';
import type { ReviewStore } from './review-store.js';
import type { Verdict } from './verdict.js';

/**
 * The config-cascade key for a scope's reviewer kind: `review.<scope>.reviewer`.
 * A value of `'human'` routes the gate to the human-review path; anything else (or absent)
 * defaults to `'agent'`. Mirrors {@link import('../worktrees/repo-mode.js').REPO_MODE_CONFIG_KEY}.
 */
export function reviewReviewerKey(scope: ReviewScope): string {
  return `review.${scope}.reviewer`;
}

/**
 * Resolve the effective reviewer kind for a scope in a project. Reads `review.<scope>.reviewer`
 * from the config cascade (`resolveEffective(projectId)`); defaults to `'agent'` if absent or
 * not exactly `'human'`. Injectable config allows headless tests to prove the branching without
 * a real config store, mirroring {@link import('../worktrees/repo-mode.js').resolveRepoMode}.
 */
export function resolveReviewerKind(
  config: { resolveEffective(projectId: string): Record<string, unknown> },
  projectId: string,
  scope: ReviewScope,
): 'agent' | 'human' {
  const raw = config.resolveEffective(projectId)[reviewReviewerKey(scope)];
  return raw === 'human' ? 'human' : 'agent';
}

/**
 * Open a config store and resolve the reviewer kind. Convenience wrapper used by the gate when
 * no injectable config is provided (mirrors `resolveRepoMode`'s `deps.config ?? openConfigStore()`).
 */
export function resolveReviewerKindFromConfig(
  projectId: string,
  scope: ReviewScope,
): 'agent' | 'human' {
  const config = openConfigStore();
  try {
    return resolveReviewerKind(config, projectId, scope);
  } finally {
    config.close();
  }
}

// ── Log-derived outcome (the approvalOutcome twin for the review path) ────────────────────────────

/** The replay-safe outcome of a human review request, derived from its in-thread response (if any). */
export type ReviewRequestOutcome = 'pending' | 'PASS' | 'ISSUES';

/**
 * Derive a `review_request`'s outcome from the log. The closing `review_response` answers the request
 * (its `causationId` is the request's seq) and, because a reply routes back to the asker, lands in the
 * request SENDER's inbox. No response yet → `pending`; otherwise its `reviewVerdict` gives `PASS` /
 * `ISSUES`. Reads only the rebuildable inbox projection — replay-safe (AC-L5-5).
 *
 * Mirrors {@link import('../mail/approval.js').approvalOutcome} exactly.
 */
export function reviewRequestOutcome(
  mail: MailStore,
  request: DeliveredMail,
): ReviewRequestOutcome {
  const stored = mail.inbox(request.recipient).find((m) => m.seq === request.seq);
  if (!stored || stored.type !== MAIL_REVIEW_REQUEST) {
    throw new Error('reviewRequestOutcome: expected a persisted review_request mail item');
  }
  const threadId = stored.correlationId ?? String(stored.seq);
  const response = mail
    .inbox(stored.sender)
    .find(
      (m) =>
        m.type === MAIL_REVIEW_RESPONSE &&
        m.sender === stored.recipient &&
        m.recipient === stored.sender &&
        m.correlationId === threadId &&
        m.causationId === String(stored.seq),
    );
  const verdict: Verdict | undefined = response?.reviewVerdict;
  switch (verdict) {
    case undefined:
      return 'pending';
    case 'PASS':
      return 'PASS';
    case 'ISSUES':
      return 'ISSUES';
    default:
      return assertNever(verdict);
  }
}

// ── Envelope builder (the outwardApprovalEnvelope twin for the review path) ──────────────────────

/** A request for a human to review a scope — always addressed to @operator (AC-L5-5). */
export interface ReviewRequestEnvelopeParams {
  readonly from: string;
  readonly subject: string;
  readonly body: string;
  readonly correlationId?: string;
  readonly idempotencyKey?: string;
}

/**
 * Build a `review_request` envelope addressed to {@link OPERATOR} (operator-terminal by construction,
 * like `outwardApprovalEnvelope` — AC-L5-5). Encoding the rule as the builder means a review request
 * can never be misaddressed to a peer.
 */
export function reviewRequestEnvelope(params: ReviewRequestEnvelopeParams): MailEnvelope {
  return {
    type: MAIL_REVIEW_REQUEST,
    to: OPERATOR,
    from: params.from,
    subject: params.subject,
    body: params.body,
    ...(params.correlationId != null ? { correlationId: params.correlationId } : {}),
    ...(params.idempotencyKey != null ? { idempotencyKey: params.idempotencyKey } : {}),
  };
}

// ── Re-entry: record a human verdict in the ReviewStore ──────────────────────────────────────────

/** Parameters for recording a human PASS/ISSUES verdict, resolved from a `review_response`. */
export interface HumanVerdictParams {
  readonly reviewId: string;
  readonly target: string;
  readonly branch: string;
  readonly verdict: Verdict;
  /** The prose blockers the human provided (used as a single blocker summary on ISSUES). */
  readonly body?: string;
}

/**
 * Re-enter the gate with a human verdict: record a `review.verdict` in the {@link ReviewStore} so
 * `co_merge`'s `getVerdict` finds it **exactly** like an agent verdict — the same merge/kickback path.
 *
 * For a human **PASS**, a {@link import('./verdict.js').VerificationMarker} representing the human
 * review is attached (`commands_run: ['human-review']`, `suite_result: 'pass'`,
 * `baseline_compared: false`) so the verdict is structurally well-formed. The gate's honest-verify at
 * `co_merge` still re-derives truth from the baseline/finish events, so a human PASS sitting on a real
 * regression is still refused (correct — the gate is reviewer-agnostic, AC-L5-5).
 *
 * For a human **ISSUES**, the prose blockers ride in `body` (v1 — a single-line summary suffices to
 * drive the gate; the human's full prose is in the mail body which the operator can read).
 */
export function recordHumanVerdict(reviews: ReviewStore, params: HumanVerdictParams): void {
  reviews.recordVerdict({
    reviewId: params.reviewId,
    target: params.target,
    branch: params.branch,
    reviewer: OPERATOR,
    verdict: params.verdict,
    blockers:
      params.verdict === 'ISSUES'
        ? [
            {
              summary:
                params.body != null && params.body.length > 0
                  ? params.body
                  : 'human ISSUES verdict',
            },
          ]
        : [],
    suggestions: [],
    verification: {
      commands_run: ['human-review'],
      suite_result: params.verdict === 'PASS' ? 'pass' : 'fail',
      baseline_compared: false,
    },
  });
}

// ── L9 stub: operator-facing review presentation seam ────────────────────────────────────────────

/**
 * The L9 operator-facing review presentation seam — the diff viewer / gate UI the human reviewer
 * uses to inspect work and submit a verdict. At v1, the headless path (actionable `review_request`
 * mail + `recordHumanVerdict` for verdict acceptance) is all that is needed to test AC-L5-5; the
 * rich UI is L9.
 *
 * This is a TYPED stub marking that seam — copied from {@link import('../worktrees/cleanup-gate.js').CleanupGateStub}'s
 * pattern: it fails loud (Principle 9) rather than being a silent no-op, because a silent stub is
 * exactly the fallback that hides prototype gaps. Nothing in L5 calls it — it exists so the L9
 * plug-point is a real, typed boundary rather than an absence (Principle 7 — gated-by-default).
 */
export interface HumanReviewGate {
  /**
   * Present the diff and review context for a branch to the operator. Returns `never`: L9 owns the
   * rendering + the interactive verdict submission; this signature marks the seam only.
   */
  presentReview(branch: string, target: string): never;
  /**
   * Accept a verdict from the operator and re-enter the gate. Returns `never`: the full acceptance
   * flow (parsing, validation, mail-send, recordHumanVerdict) is L9; v1 tests the headless path via
   * {@link reviewRequestOutcome} + {@link recordHumanVerdict} directly.
   */
  acceptVerdict(branch: string, verdict: Verdict): never;
}

/**
 * The L9 STUB gate. Every method fails loud (Principle 9) until L9 owns the operator review UI —
 * never a silent no-op.
 */
export class HumanReviewGateStub implements HumanReviewGate {
  // L9 PLUG-POINT (operator review presentation). The production gate must, per method:
  //  (1) presentReview — render the diff + review facts (branch, scope, blockers) in the operator UI;
  //  (2) acceptVerdict — parse the operator's verdict, validate it, send a `review_response` mail,
  //      and call recordHumanVerdict to re-enter the gate.
  // Until then every method fails loud (Principle 9).
  presentReview(): never {
    throw new Error(
      'HumanReviewGate.presentReview: the operator-facing review UI is not implemented ' +
        '(deferred to L9): present the diff, branch facts, and review context for interactive ' +
        'verdict submission. The headless seam (review_request mail + recordHumanVerdict) covers v1.',
    );
  }
  acceptVerdict(): never {
    throw new Error(
      'HumanReviewGate.acceptVerdict: the interactive verdict-acceptance flow is not implemented ' +
        '(deferred to L9): parse the operator verdict, send a review_response mail, and call ' +
        'recordHumanVerdict to re-enter the gate. The headless path drives this at v1.',
    );
  }
}
