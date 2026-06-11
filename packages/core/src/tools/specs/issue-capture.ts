import { z } from 'zod';
import type { ToolSpec } from '../registry.js';
import { assertToolCallerRole } from '../caller-auth.js';
import { BASE_ROLES } from '../scoping.js';
import { ISSUE_DESTINATIONS } from '../../issues/events.js';
import { ISSUE_CAPTURE_KEY, resolveIssueOptIns } from '../../issues/opt-in.js';
import { issueRecordOutputSchema, issueRecordToOutput } from './issue-record-output.js';

const issueCaptureInput = z
  .object({
    issue_id: z
      .string()
      .min(1)
      .describe('A new unique id for this issue (the issue stream key), e.g. "iss-<short-hash>".'),
    summary: z
      .string()
      .min(1)
      .describe('A one-line summary of the friction — this is what dedup matches on.'),
    detail: z
      .string()
      .describe('What happened, with enough reproduction detail for a diagnostic researcher.'),
    destination: z
      .enum(ISSUE_DESTINATIONS)
      .describe(
        "Where the friction belongs: 'target' = a real bug in the repo being worked on; " +
          "'co' = co's own tooling misbehaved.",
      ),
  })
  .strict();
type IssueCaptureInput = z.infer<typeof issueCaptureInput>;

const issueCaptureOutput = z.object({
  deduped: z
    .boolean()
    .describe(
      'True when an existing record already covers this friction — the returned issue is that ' +
        'record and nothing new was created (the dedup step).',
    ),
  issue: issueRecordOutputSchema.describe('The captured (or matched existing) issue record.'),
});
type IssueCaptureOutput = z.infer<typeof issueCaptureOutput>;

/**
 * `co_issue_capture` (L6b G, the `detect` step): record a friction point as a durable, LOCAL
 * issue record. Gated on the `issues.capture` opt-in (OFF by default — a stranger repo never
 * auto-captures), and the gate runs BEFORE any write so a disabled pipeline touches nothing
 * (robust-on-read-only-state). Dedups against existing records by summary + destination before
 * creating. Offered to every role — friction can hit anyone (specs-and-issues.md).
 */
export const issueCaptureTool: ToolSpec<IssueCaptureInput, IssueCaptureOutput> = {
  name: 'co_issue_capture',
  title: 'Capture a friction issue',
  description:
    'Capture friction you hit while working as a durable local issue record (the detect step of the ' +
    'issue pipeline). Requires the issues.capture opt-in. Dedups by summary + destination: if an ' +
    'existing record already covers the friction it is returned with deduped=true instead of ' +
    'creating a duplicate. Capture is local — filing outward is a separate, separately-gated verb.',
  inputSchema: issueCaptureInput,
  outputSchema: issueCaptureOutput,
  handler: (ctx, input): IssueCaptureOutput => {
    if (!ctx.issues) {
      throw new Error(
        'co_issue_capture: the mount did not inject an issue store (ctx.issues absent).',
      );
    }
    if (!ctx.roster) {
      throw new Error(
        'co_issue_capture: the mount did not inject a roster store (ctx.roster absent).',
      );
    }
    assertToolCallerRole('co_issue_capture', ctx.roster, ctx.agent, BASE_ROLES);

    // Opt-in BEFORE any write: a disabled pipeline must not touch the store (Principle 9 — the
    // refusal is loud; robustness — nothing is half-written when capture is off).
    const optIns = resolveIssueOptIns(ctx.projectId);
    if (!optIns.capture) {
      throw new Error(
        `co_issue_capture: issue capture is not enabled for this project — set the ` +
          `'${ISSUE_CAPTURE_KEY}' config key to true to opt in (all issue-pipeline layers are ` +
          'OFF by default).',
      );
    }

    const duplicate = ctx.issues.findDuplicate({
      summary: input.summary,
      destination: input.destination,
    });
    if (duplicate != null && duplicate.issueId !== input.issue_id) {
      return { deduped: true, issue: issueRecordToOutput(duplicate) };
    }

    const rec = ctx.issues.recordCapture({
      issueId: input.issue_id,
      summary: input.summary,
      detail: input.detail,
      destination: input.destination,
      capturedBy: ctx.agent,
    });
    return { deduped: false, issue: issueRecordToOutput(rec) };
  },
};
