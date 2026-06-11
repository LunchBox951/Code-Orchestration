import { z } from 'zod';
import type { ToolSpec } from '../registry.js';
import type { SpecRecord } from '../../specs/events.js';

const specGetInput = z
  .object({
    task_id: z.string().min(1).describe('The task id of the spec to retrieve.'),
  })
  .strict();
type SpecGetInput = z.infer<typeof specGetInput>;

const criterionOutputSchema = z.object({
  text: z.string().describe('The concrete, checkable outcome.'),
  verify: z.string().optional().describe('The wired verification command, if set.'),
});

const specGetOutput = z.object({
  found: z.boolean().describe('True when a spec record exists for the requested task id.'),
  task_id: z.string().describe('The queried task id.'),
  title: z.string().optional().describe('The spec title (present when found=true).'),
  goal: z.string().optional().describe('The spec goal statement (present when found=true).'),
  criteria: z
    .array(criterionOutputSchema)
    .optional()
    .describe('The acceptance criteria (present when found=true).'),
  body: z.string().optional().describe('The full spec body text (present when found=true).'),
  state: z
    .enum(['draft', 'locked', 'archived'])
    .optional()
    .describe('The lifecycle state of the spec (present when found=true).'),
  locked_by: z.string().optional().describe('Who locked this spec (present when state=locked).'),
  drafted_ts: z
    .number()
    .int()
    .optional()
    .describe('The event timestamp when this spec was drafted (present when found=true).'),
  locked_ts: z.number().int().optional().describe('The event timestamp when this spec was locked.'),
  archived_ts: z
    .number()
    .int()
    .optional()
    .describe('The event timestamp when this spec was archived.'),
});
type SpecGetOutput = z.infer<typeof specGetOutput>;

function recordToOutput(rec: SpecRecord): SpecGetOutput {
  return {
    found: true,
    task_id: rec.taskId,
    title: rec.title,
    goal: rec.goal,
    criteria: rec.criteria.map((c) => ({
      text: c.text,
      ...(c.verify != null ? { verify: c.verify } : {}),
    })),
    body: rec.body,
    state: rec.state,
    ...(rec.lockedBy != null ? { locked_by: rec.lockedBy } : {}),
    drafted_ts: rec.draftedTs,
    ...(rec.lockedTs != null ? { locked_ts: rec.lockedTs } : {}),
    ...(rec.archivedTs != null ? { archived_ts: rec.archivedTs } : {}),
  };
}

/**
 * `co_spec_get` (F4 fix): any agent can query a spec by task id without touching the filesystem.
 * Returns the full SpecRecord when found, or a structured not-found result when absent.
 * Loud-fails when `ctx.specs` is absent (Principle 9 — the mount assembles the context).
 *
 * Scoped to: UNIVERSAL (all five roles offer it — a locked spec must be queryable by any agent).
 */
export const specGetTool: ToolSpec<SpecGetInput, SpecGetOutput> = {
  name: 'co_spec_get',
  title: 'Get a spec record',
  description:
    'Retrieve a spec record by task id. Returns the full spec (title, goal, criteria, body, ' +
    'lifecycle state, and timestamps) when found, or a structured not-found result (found=false) ' +
    'when absent. Use this to read a locked spec without touching the filesystem.',
  inputSchema: specGetInput,
  outputSchema: specGetOutput,
  handler: (ctx, input): SpecGetOutput => {
    if (!ctx.specs) {
      throw new Error('co_spec_get: the mount did not inject a spec store (ctx.specs absent).');
    }
    const rec = ctx.specs.getSpec(input.task_id);
    if (rec == null) {
      return { found: false, task_id: input.task_id };
    }
    return recordToOutput(rec);
  },
};
