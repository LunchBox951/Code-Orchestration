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
 *      {@link gateOutwardAction}: BLOCKED while pending, run on approve, REFUSED on decline.
 *      Nothing posts without the recorded approve, and successful `issue.filed` records make retries
 *      idempotent (Principle 7/8 — fail loud, Principle 9).
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
import { MAIL_APPROVAL, OPERATOR, type DeliveredMail, type MailEnvelope } from '../mail/events.js';
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
 * A stable, machine-matchable marker embedded in every posted issue body, keyed by issueId. It is
 * the search-before-create idempotency signal (#7 §5 #9): on a retry after a crash between
 * `gh issue create` and the durable `issue.filed` record, the filer finds the already-posted issue
 * by this marker and reuses it instead of double-posting. Carries no secret (the issueId is a
 * co-internal slug), so it is appended after the scrub pass.
 */
export function issueBodyMarker(issueId: string): string {
  return `<!-- co-issue-id: ${issueId} -->`;
}

/**
 * Render the outward issue body from the record: the captured detail plus the probable-cause
 * report, scrubbed, with the {@link issueBodyMarker} appended. This is both the approval preview
 * and the posted body — one artifact (the operator approves byte-for-byte what is posted, marker
 * included).
 */
export function renderIssueBody(issue: IssueRecord): string {
  const sections = [issue.detail.trim()];
  if (issue.probableCause != null) {
    sections.push(`## Probable cause\n\n${issue.probableCause.trim()}`);
  }
  sections.push(`---\n_Filed via co (issue ${issue.issueId}, captured by an agent)._`);
  return `${scrubIssueText(sections.join('\n\n'))}\n\n${issueBodyMarker(issue.issueId)}`;
}

/**
 * Build the per-post approval mail for filing `issue` — addressed to @operator by construction
 * ({@link outwardApprovalEnvelope}), idempotency-keyed per issue so retries never double-ask,
 * carrying the scrubbed outward artifact as its subject/body.
 */
export function buildIssueFilingApproval(opts: {
  readonly from: string;
  readonly issue: IssueRecord;
  readonly title?: string;
}): MailEnvelope {
  const { from, issue, title } = opts;
  return outwardApprovalEnvelope({
    from,
    subject: scrubIssueText(title ?? issue.summary),
    body: renderIssueBody(issue),
    idempotencyKey: issueFilingApprovalKey(issue.issueId),
  });
}

/**
 * The previously-sent filing approval for `issueId`, regardless of which owner-tier agent sent it,
 * or undefined. Reads @operator's rebuildable inbox projection so a lead retry cannot double-ask
 * after a coordinator already requested the same idempotency-keyed approval.
 */
export function findIssueFilingApproval(
  mail: MailStore,
  _agent: string,
  issueId: string,
  opts: { readonly senderAllowed?: (sender: string) => boolean } = {},
): DeliveredMail | undefined {
  const key = issueFilingApprovalKey(issueId);
  return mail.inbox(OPERATOR).find((m) => {
    if (m.type !== MAIL_APPROVAL || m.idempotencyKey !== key || m.retracted === true) {
      return false;
    }
    return opts.senderAllowed?.(m.sender) ?? true;
  });
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

/** The `-R owner/repo` flag for a `co`-destination filing, or `[]` for the target repo. */
function destinationRepoFlag(destination: IssueDestination, coRepoSlug?: string): string[] {
  return destination === 'co' && coRepoSlug != null && coRepoSlug.trim().length > 0
    ? ['-R', coRepoSlug]
    : [];
}

/**
 * Search-before-create (#7 §5 #9): list recent issues in the destination and return the URL of one
 * already carrying this issue's {@link issueBodyMarker}, or undefined. Best-effort and read-only —
 * a list failure or unparseable output returns undefined (we fall through to create rather than
 * fail the filing). The recent-issue listing (not GitHub search) avoids search-index lag, so a
 * just-posted issue is found on an immediate crash-retry.
 */
function findAlreadyPostedIssue(opts: {
  readonly ghExec: GhExec;
  readonly cwd: string;
  readonly destination: IssueDestination;
  readonly coRepoSlug?: string;
  readonly issueId: string;
}): string | undefined {
  const args = [
    'issue',
    'list',
    ...destinationRepoFlag(opts.destination, opts.coRepoSlug),
    '--state',
    'all',
    '--limit',
    '100',
    '--json',
    'url,body',
  ];
  let raw: string;
  try {
    raw = opts.ghExec(opts.cwd, args).trim();
  } catch {
    return undefined;
  }
  if (raw.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const marker = issueBodyMarker(opts.issueId);
  for (const entry of parsed) {
    if (entry != null && typeof entry === 'object') {
      const { url, body } = entry as { url?: unknown; body?: unknown };
      if (typeof body === 'string' && body.includes(marker) && typeof url === 'string') {
        return url;
      }
    }
  }
  return undefined;
}

/**
 * Enact the outward filing through the approval gate: {@link gateOutwardAction} BLOCKS a pending
 * approval, REFUSES a declined one, and runs the posting on approve. To stay idempotent across a
 * crash between the post and the durable `issue.filed` record (#7 §5 #9), it SEARCHES for an
 * already-posted issue (by {@link issueBodyMarker}) before creating, and reuses it if found.
 * Returns the posted issue ref (the URL `gh` prints); the caller records that ref as the durable
 * idempotency marker.
 */
export function fileIssueOutward(opts: {
  readonly outcome: ApprovalOutcome;
  readonly ghExec: GhExec;
  readonly cwd: string;
  readonly destination: IssueDestination;
  readonly coRepoSlug?: string;
  readonly issueId: string;
  readonly title: string;
  readonly body: string;
}): string {
  const args = ghIssueCreateArgs(opts);
  return gateOutwardAction(opts.outcome, () => {
    const existingUrl = findAlreadyPostedIssue(opts);
    if (existingUrl != null) return existingUrl;
    return opts.ghExec(opts.cwd, args).trim();
  });
}
