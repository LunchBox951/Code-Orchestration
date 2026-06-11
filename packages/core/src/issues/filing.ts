/**
 * L6b G outward filing gate — the `file` step of the pipeline and the FIRST real consumer of
 * L1's outward-approval machinery (`mail/approval.ts` anticipated exactly this:
 * "Real outward-action instances (issue-filing, PR-open) are L3/L5/L6").
 *
 * The shape of the gate (specs-and-issues.md §"File — with per-post approval"):
 *
 *   1. The filing agent sends ONE `approval` mail to @operator per issue (idempotency-keyed),
 *      whose subject/body are the SCRUBBED outward artifact — what the operator approves is
 *      byte-for-byte what would be posted.
 *   2. The recorded `approval_response` decision then gates the actual `gh issue create` through
 *      {@link gateOutwardAction}: BLOCKED while pending, run once on approve, REFUSED on decline.
 *      Nothing posts without the recorded approve (Principle 7/8 — fail loud, Principle 9).
 *
 * Destination gating rides the repo-relationship modes (worktrees/repo-mode.ts): `target`
 * filings need a remote, so Offline mode refuses; `co` filings go to `co`'s own public repo
 * (the `issues.coRepo` config key) and do not depend on the target repo's remote. All `gh` I/O
 * is behind the injectable {@link GhExec} seam — `pnpm test` performs NO real network operations.
 */
import {
  gateOutwardAction,
  outwardApprovalEnvelope,
  type ApprovalOutcome,
} from '../mail/approval.js';
import { MAIL_APPROVAL, type DeliveredMail, type MailEnvelope } from '../mail/events.js';
import type { MailStore } from '../mail/mail-store.js';
import type { GhExec, RepoMode } from '../worktrees/repo-mode.js';
import type { IssueDestination, IssueRecord } from './events.js';
import { scrubIssueText } from './scrub.js';

/** Config key: the `owner/repo` slug `co`-destination issues are filed against. */
export const ISSUE_CO_REPO_KEY = 'issues.coRepo' as const;

/** Prefix of the per-issue filing-approval idempotency key. */
const ISSUE_FILING_APPROVAL_PREFIX = 'issue-file:';

/** The idempotency key for issue `issueId`'s one-and-only filing approval. */
export function issueFilingApprovalKey(issueId: string): string {
  return ISSUE_FILING_APPROVAL_PREFIX + issueId;
}

/**
 * Render the outward issue body from the record: the captured detail plus the probable-cause
 * report, scrubbed. This is both the approval preview and the posted body — one artifact.
 */
export function renderIssueBody(issue: IssueRecord): string {
  const sections = [issue.detail.trim()];
  if (issue.probableCause != null) {
    sections.push(`## Probable cause\n\n${issue.probableCause.trim()}`);
  }
  sections.push(`---\n_Filed via co (issue ${issue.issueId}, captured by an agent)._`);
  return scrubIssueText(sections.join('\n\n'));
}

/**
 * Build the per-post approval mail for filing `issue` — addressed to @operator by construction
 * ({@link outwardApprovalEnvelope}), idempotency-keyed per issue so retries never double-ask,
 * carrying the scrubbed outward artifact as its body.
 */
export function buildIssueFilingApproval(opts: {
  readonly from: string;
  readonly issue: IssueRecord;
}): MailEnvelope {
  const { from, issue } = opts;
  return outwardApprovalEnvelope({
    from,
    subject: scrubIssueText(`file issue (${issue.destination}): ${issue.summary}`),
    body: renderIssueBody(issue),
    idempotencyKey: issueFilingApprovalKey(issue.issueId),
  });
}

/**
 * The previously-sent filing approval for `issueId` from `agent`, or undefined. Reads the
 * rebuildable by-sender projection, so the lookup (like the outcome) survives a replay.
 */
export function findIssueFilingApproval(
  mail: MailStore,
  agent: string,
  issueId: string,
): DeliveredMail | undefined {
  const key = issueFilingApprovalKey(issueId);
  return mail
    .sentBy(agent)
    .find((m) => m.type === MAIL_APPROVAL && m.idempotencyKey === key && m.retracted !== true);
}

/**
 * Gate the destination on the repo-relationship mode: a `target` filing posts to the target
 * repo's own tracker, which requires a remote — Offline mode refuses loud (Principle 9). A `co`
 * filing goes to `co`'s public repo and is mode-independent.
 */
export function assertIssueDestinationAllowed(destination: IssueDestination, mode: RepoMode): void {
  if (destination === 'target' && mode === 'offline') {
    throw new Error(
      'issue filing: cannot file against the target repo in offline mode — there is no remote. ' +
        "Capture stays local; set destination 'co' for co-tooling friction.",
    );
  }
}

/** Build the `gh issue create` argv for a destination. Fails loud on a missing co repo slug. */
export function ghIssueCreateArgs(opts: {
  readonly destination: IssueDestination;
  readonly coRepoSlug?: string;
  readonly title: string;
  readonly body: string;
}): readonly string[] {
  const repoFlag: string[] = [];
  if (opts.destination === 'co') {
    if (opts.coRepoSlug == null || opts.coRepoSlug.trim().length === 0) {
      throw new Error(
        `issue filing: destination 'co' needs the '${ISSUE_CO_REPO_KEY}' config key (an ` +
          "'owner/repo' slug) — refusing to guess where co's issues live.",
      );
    }
    repoFlag.push('-R', opts.coRepoSlug);
  }
  return ['issue', 'create', ...repoFlag, '--title', opts.title, '--body', opts.body];
}

/**
 * Enact the outward filing through the approval gate: {@link gateOutwardAction} BLOCKS a pending
 * approval, REFUSES a declined one, and runs `gh issue create` exactly once on approve.
 * Returns the posted issue ref (the URL `gh` prints).
 */
export function fileIssueOutward(opts: {
  readonly outcome: ApprovalOutcome;
  readonly ghExec: GhExec;
  readonly cwd: string;
  readonly destination: IssueDestination;
  readonly coRepoSlug?: string;
  readonly title: string;
  readonly body: string;
}): string {
  const args = ghIssueCreateArgs(opts);
  return gateOutwardAction(opts.outcome, () => opts.ghExec(opts.cwd, args).trim());
}
