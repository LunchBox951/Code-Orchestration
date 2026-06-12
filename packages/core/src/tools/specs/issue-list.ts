import { z } from 'zod';
import type { ToolSpec } from '../registry.js';
import { assertToolCallerRole } from '../caller-auth.js';
import { BASE_ROLES } from '../scoping.js';
import { ISSUE_DESTINATIONS } from '../../issues/events.js';
import { issueRecordOutputSchema, issueRecordToOutput } from './issue-record-output.js';

const issueListInput = z
  .object({
    destination: z
      .enum(ISSUE_DESTINATIONS)
      .optional()
      .describe("Optional filter: only issues for this destination ('target' or 'co')."),
    state: z
      .enum(['captured', 'diagnosed', 'filed', 'self_assigned'])
      .optional()
      .describe('Optional filter: only issues in this pipeline state.'),
  })
  .strict();
type IssueListInput = z.infer<typeof issueListInput>;

const issueListOutput = z.object({
  issues: z
    .array(issueRecordOutputSchema)
    .describe('The matching issue records, in capture order.'),
});
type IssueListOutput = z.infer<typeof issueListOutput>;

/**
 * `co_issue_list` (L6b G): read-only visibility over the local issue records — the `dedup` step's
 * query surface ("search existing issues; file only if no relevant one exists"). Offered to every
 * role; no opt-in gate because reading local records is harmless and an agent must be able to
 * check for duplicates before capturing.
 */
export const issueListTool: ToolSpec<IssueListInput, IssueListOutput> = {
  name: 'co_issue_list',
  title: 'List captured issues',
  description:
    'List the durable local issue records, optionally filtered by destination or pipeline state. ' +
    'Use this before capturing (the dedup step) and to follow an issue through ' +
    'detect → diagnose → file.',
  inputSchema: issueListInput,
  outputSchema: issueListOutput,
  handler: (ctx, input): IssueListOutput => {
    if (!ctx.issues) {
      throw new Error(
        'co_issue_list: the mount did not inject an issue store (ctx.issues absent).',
      );
    }
    if (!ctx.roster) {
      throw new Error(
        'co_issue_list: the mount did not inject a roster store (ctx.roster absent).',
      );
    }
    assertToolCallerRole('co_issue_list', ctx.roster, ctx.agent, BASE_ROLES);

    const issues = ctx.issues
      .listIssues()
      .filter((rec) => input.destination == null || rec.destination === input.destination)
      .filter((rec) => input.state == null || rec.state === input.state)
      .map(issueRecordToOutput);
    return { issues };
  },
};
