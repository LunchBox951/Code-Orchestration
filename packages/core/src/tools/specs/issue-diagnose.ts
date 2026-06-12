import { z } from 'zod';
import type { ToolSpec } from '../registry.js';
import { assertToolCallerRole } from '../caller-auth.js';
import { ISSUE_CAPTURE_KEY, resolveIssueOptIns } from '../../issues/opt-in.js';
import { issueRecordOutputSchema, issueRecordToOutput } from './issue-record-output.js';

const issueDiagnoseInput = z
  .object({
    issue_id: z.string().min(1).describe('The captured issue to attach the diagnosis to.'),
    probable_cause: z
      .string()
      .min(1)
      .describe(
        'The probable-cause report — not just a symptom. For a co bug, derived from co behavior ' +
          "+ co's public source (what keeps the report scrubbable).",
      ),
  })
  .strict();
type IssueDiagnoseInput = z.infer<typeof issueDiagnoseInput>;

const issueDiagnoseOutput = z.object({
  issue: issueRecordOutputSchema.describe('The diagnosed issue record.'),
});
type IssueDiagnoseOutput = z.infer<typeof issueDiagnoseOutput>;

/**
 * `co_issue_diagnose` (L6b G, the `diagnose` step): a researcher (the `researcher:diagnostic`
 * sub-role's job) records a probable-cause report against a captured issue. Researcher-only —
 * the pipeline's diagnose step is explicitly a researcher mandate (specs-and-issues.md §2).
 * Gated on the pipeline's `issues.capture` opt-in like every local step.
 */
export const issueDiagnoseTool: ToolSpec<IssueDiagnoseInput, IssueDiagnoseOutput> = {
  name: 'co_issue_diagnose',
  title: 'Diagnose a captured issue',
  description:
    'Attach a probable-cause report to a captured issue (the diagnose step of the issue pipeline). ' +
    'Only a researcher may diagnose — investigate the relevant source and report a cause, not just ' +
    'a symptom. The issue must be in the captured state.',
  inputSchema: issueDiagnoseInput,
  outputSchema: issueDiagnoseOutput,
  handler: (ctx, input): IssueDiagnoseOutput => {
    if (!ctx.issues) {
      throw new Error(
        'co_issue_diagnose: the mount did not inject an issue store (ctx.issues absent).',
      );
    }
    if (!ctx.roster) {
      throw new Error(
        'co_issue_diagnose: the mount did not inject a roster store (ctx.roster absent).',
      );
    }
    assertToolCallerRole('co_issue_diagnose', ctx.roster, ctx.agent, ['researcher']);

    const optIns = resolveIssueOptIns(ctx.projectId);
    if (!optIns.capture) {
      throw new Error(
        `co_issue_diagnose: the issue pipeline is not enabled for this project — set the ` +
          `'${ISSUE_CAPTURE_KEY}' config key to true to opt in.`,
      );
    }

    const rec = ctx.issues.recordDiagnosis({
      issueId: input.issue_id,
      probableCause: input.probable_cause,
      diagnosedBy: ctx.agent,
    });
    return { issue: issueRecordToOutput(rec) };
  },
};
