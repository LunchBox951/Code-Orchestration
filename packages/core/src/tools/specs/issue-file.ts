import { z } from 'zod';
import type { ToolSpec } from '../registry.js';
import { assertToolCallerRole } from '../caller-auth.js';
import { approvalOutcome } from '../../mail/approval.js';
import { openConfigStore } from '../../config/config-store.js';
import {
  ISSUE_CO_REPO_KEY,
  assertIssueDestinationAllowed,
  buildIssueFilingApproval,
  fileIssueOutward,
  findIssueFilingApproval,
} from '../../issues/filing.js';
import { ISSUE_PUBLISH_KEY, resolveIssueOptIns } from '../../issues/opt-in.js';
import { defaultGhExec, resolveRepoMode } from '../../worktrees/repo-mode.js';
import { issueRecordOutputSchema, issueRecordToOutput } from './issue-record-output.js';

const issueFileInput = z
  .object({
    issue_id: z.string().min(1).describe('The diagnosed issue to file outward.'),
    title: z
      .string()
      .min(1)
      .optional()
      .describe('Optional issue title override; defaults to the captured summary (scrubbed).'),
  })
  .strict();
type IssueFileInput = z.infer<typeof issueFileInput>;

const issueFileOutput = z.object({
  status: z
    .enum(['approval_requested', 'filed'])
    .describe(
      "'approval_requested' = the per-post approval mail was sent to @operator and nothing was " +
        "posted; re-invoke after the operator responds. 'filed' = the issue is posted outward.",
    ),
  approval_seq: z
    .number()
    .int()
    .optional()
    .describe('The per-post approval mail seq (present once an approval exists).'),
  posted_ref: z
    .string()
    .optional()
    .describe('The posted issue reference, e.g. the GitHub URL (present when filed).'),
  issue: issueRecordOutputSchema.describe('The issue record after this operation.'),
});
type IssueFileOutput = z.infer<typeof issueFileOutput>;

/**
 * `co_issue_file` (L6b G, the `file` step — the only OUTWARD verb in the pipeline): post a
 * diagnosed issue to GitHub under a recorded **per-post approval**. The first invocation sends
 * ONE idempotency-keyed `approval` mail to @operator carrying the scrubbed artifact (what the
 * operator approves is what posts) and reports `approval_requested`. Re-invocations route the
 * recorded decision through `gateOutwardAction`: BLOCKED loud while pending, REFUSED loud on
 * decline, and `gh issue create` on approve — then the `issue.filed` event records the approval
 * seq + posted ref for the audit trail. Once that durable filing record exists, re-invocation is
 * idempotent and never re-runs `gh`.
 *
 * Gates, in order: coordinator/lead caller → `issues.publish` opt-in (OFF by default) →
 * pipeline order (diagnosed only) → destination vs repo mode (no target filing in Offline) →
 * the per-post approval. All `gh` I/O rides the injectable `ctx.ghExec` seam.
 */
export const issueFileTool: ToolSpec<IssueFileInput, IssueFileOutput> = {
  name: 'co_issue_file',
  title: 'File an issue outward (per-post approved)',
  description:
    'File a diagnosed issue as a real GitHub issue — gated on the issues.publish opt-in AND a ' +
    'per-post @operator approval. The first call sends the approval request (scrubbed preview) and ' +
    'returns approval_requested; once the operator approves, calling again posts via gh and records ' +
    'the filing. A pending approval blocks; a declined approval refuses. Only a coordinator or lead ' +
    'may file.',
  inputSchema: issueFileInput,
  outputSchema: issueFileOutput,
  handler: (ctx, input): IssueFileOutput => {
    if (!ctx.issues) {
      throw new Error(
        'co_issue_file: the mount did not inject an issue store (ctx.issues absent).',
      );
    }
    if (!ctx.roster) {
      throw new Error(
        'co_issue_file: the mount did not inject a roster store (ctx.roster absent).',
      );
    }
    assertToolCallerRole('co_issue_file', ctx.roster, ctx.agent, ['coordinator', 'lead']);

    const config = openConfigStore();
    let coRepoSlug: string | undefined;
    let mode;
    try {
      const optIns = resolveIssueOptIns(ctx.projectId, config);
      if (!optIns.publish) {
        throw new Error(
          `co_issue_file: outward publishing is not enabled for this project — set the ` +
            `'${ISSUE_PUBLISH_KEY}' config key to true (with issues.capture) to opt in. All ` +
            'issue-pipeline layers are OFF by default.',
        );
      }
      const effective = config.resolveEffective(ctx.projectId);
      const rawSlug = effective[ISSUE_CO_REPO_KEY];
      coRepoSlug = typeof rawSlug === 'string' ? rawSlug : undefined;
      mode = resolveRepoMode(ctx.projectId, ctx.cwd, { config });
    } finally {
      config.close();
    }

    const issue = ctx.issues.getIssue(input.issue_id);
    if (issue == null) {
      throw new Error(`co_issue_file: no issue record for '${input.issue_id}' — capture it first.`);
    }

    // Idempotent terminal read: an already-filed issue reports its filing; gh never re-runs.
    if (issue.state === 'filed' || issue.state === 'self_assigned') {
      return {
        status: 'filed',
        ...(issue.approvalSeq != null ? { approval_seq: issue.approvalSeq } : {}),
        ...(issue.postedRef != null ? { posted_ref: issue.postedRef } : {}),
        issue: issueRecordToOutput(issue),
      };
    }
    if (issue.state !== 'diagnosed') {
      throw new Error(
        `co_issue_file: issue '${input.issue_id}' is in state '${issue.state}' — it must be ` +
          'diagnosed before filing (the pipeline is detect → diagnose → dedup → file).',
      );
    }

    assertIssueDestinationAllowed(issue.destination, mode);

    // The per-post approval (idempotency-keyed — retries never double-ask the operator).
    const existing = findIssueFilingApproval(ctx.mail, ctx.agent, issue.issueId, {
      senderAllowed: (sender) => {
        const record = ctx.roster!.getAgent(sender);
        return record?.role === 'coordinator' || record?.role === 'lead';
      },
    });
    if (existing == null) {
      const sent = ctx.mail.send(
        buildIssueFilingApproval({
          from: ctx.agent,
          issue,
          title: input.title ?? issue.summary,
        }),
      );
      return {
        status: 'approval_requested',
        approval_seq: sent.seq,
        issue: issueRecordToOutput(issue),
      };
    }

    // gateOutwardAction semantics: BLOCKED (pending) / REFUSED (declined) throw loud; approved
    // runs gh and yields the posted ref. The existing issue.filed record is the durable idempotency
    // marker; after it exists, the terminal read above prevents a second gh run.
    const outcome = approvalOutcome(ctx.mail, existing);
    const postedRef = fileIssueOutward({
      outcome,
      ghExec: ctx.ghExec ?? defaultGhExec,
      cwd: ctx.cwd,
      destination: issue.destination,
      ...(coRepoSlug != null ? { coRepoSlug } : {}),
      issueId: issue.issueId,
      title: existing.subject,
      body: existing.body,
    });

    const filed = ctx.issues.recordFiling({
      issueId: issue.issueId,
      filedBy: ctx.agent,
      approvalSeq: existing.seq,
      postedRef,
    });
    return {
      status: 'filed',
      approval_seq: existing.seq,
      posted_ref: postedRef,
      issue: issueRecordToOutput(filed),
    };
  },
};
