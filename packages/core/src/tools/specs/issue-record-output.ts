import { z } from 'zod';
import { ISSUE_DESTINATIONS, type IssueRecord } from '../../issues/events.js';

/**
 * The structured output schema for a returned issue RECORD — shared by every issue verb
 * (`co_issue_capture`, `co_issue_list`, `co_issue_diagnose`, `co_issue_file`). A ZodObject so the
 * completeness gate's structured-output check passes.
 */
export const issueRecordOutputSchema = z.object({
  issue_id: z.string().describe('The issue id (the issue stream key).'),
  summary: z.string().describe('The one-line friction summary.'),
  detail: z.string().describe('The captured detail / reproduction notes.'),
  destination: z
    .enum(ISSUE_DESTINATIONS)
    .describe("Where the issue belongs: 'target' (the repo being worked on) or 'co' (co itself)."),
  captured_by: z.string().describe('The agent that captured the friction.'),
  state: z
    .enum(['captured', 'diagnosed', 'filed', 'self_assigned'])
    .describe('The pipeline state of the issue after this operation.'),
  probable_cause: z
    .string()
    .optional()
    .describe('The probable-cause report (present once diagnosed).'),
  diagnosed_by: z
    .string()
    .optional()
    .describe('The diagnostic researcher (present once diagnosed).'),
  filed_by: z.string().optional().describe('The agent that filed the issue (present once filed).'),
  approval_seq: z
    .number()
    .int()
    .optional()
    .describe('The per-post approval mail seq the filing was gated on (present once filed).'),
  posted_ref: z
    .string()
    .optional()
    .describe('The posted issue reference, e.g. the GitHub URL (present once filed).'),
  assignee: z.string().optional().describe('The self-assignee (present once self-assigned).'),
  captured_ts: z.number().int().describe('The event timestamp when the issue was captured.'),
  diagnosed_ts: z
    .number()
    .int()
    .optional()
    .describe('The event timestamp when the issue was diagnosed.'),
  filed_ts: z.number().int().optional().describe('The event timestamp when the issue was filed.'),
  self_assigned_ts: z
    .number()
    .int()
    .optional()
    .describe('The event timestamp when the issue was self-assigned.'),
});
export type IssueRecordOutput = z.infer<typeof issueRecordOutputSchema>;

/** Project a durable {@link IssueRecord} into the structured tool output. */
export function issueRecordToOutput(rec: IssueRecord): IssueRecordOutput {
  return {
    issue_id: rec.issueId,
    summary: rec.summary,
    detail: rec.detail,
    destination: rec.destination,
    captured_by: rec.capturedBy,
    state: rec.state,
    ...(rec.probableCause != null ? { probable_cause: rec.probableCause } : {}),
    ...(rec.diagnosedBy != null ? { diagnosed_by: rec.diagnosedBy } : {}),
    ...(rec.filedBy != null ? { filed_by: rec.filedBy } : {}),
    ...(rec.approvalSeq != null ? { approval_seq: rec.approvalSeq } : {}),
    ...(rec.postedRef != null ? { posted_ref: rec.postedRef } : {}),
    ...(rec.assignee != null ? { assignee: rec.assignee } : {}),
    captured_ts: rec.capturedTs,
    ...(rec.diagnosedTs != null ? { diagnosed_ts: rec.diagnosedTs } : {}),
    ...(rec.filedTs != null ? { filed_ts: rec.filedTs } : {}),
    ...(rec.selfAssignedTs != null ? { self_assigned_ts: rec.selfAssignedTs } : {}),
  };
}
