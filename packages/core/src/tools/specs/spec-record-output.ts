import { z } from 'zod';
import type { SpecRecord } from '../../specs/events.js';

/** One acceptance criterion in a returned spec record. */
const criterionOutputSchema = z.object({
  text: z.string().describe('The concrete, checkable outcome.'),
  verify: z.string().optional().describe('The wired verification command, if set.'),
});

/**
 * The structured output schema for a returned spec RECORD — shared by the write verbs `co_spec_draft`
 * and `co_spec_lock` (both return the full {@link SpecRecord}). A ZodObject so the completeness gate's
 * structured-output check passes. (Distinct from `co_spec_get`'s output, which adds a `found` flag for
 * the not-found case; a write verb always returns a real record.)
 */
export const specRecordOutputSchema = z.object({
  task_id: z.string().describe('The task id of the spec.'),
  title: z.string().describe('The spec title.'),
  goal: z.string().describe('The spec goal statement.'),
  criteria: z.array(criterionOutputSchema).describe('The acceptance criteria as recorded.'),
  body: z.string().describe('The full spec body text.'),
  state: z
    .enum(['draft', 'locked', 'archived'])
    .describe('The lifecycle state of the spec after this operation.'),
  locked_by: z.string().optional().describe('Who locked this spec (present when state=locked).'),
  drafted_ts: z.number().int().describe('The event timestamp when this spec was drafted.'),
  locked_ts: z.number().int().optional().describe('The event timestamp when this spec was locked.'),
  archived_ts: z
    .number()
    .int()
    .optional()
    .describe('The event timestamp when this spec was archived.'),
});
export type SpecRecordOutput = z.infer<typeof specRecordOutputSchema>;

/** Project a durable {@link SpecRecord} into the structured tool output. */
export function specRecordToOutput(rec: SpecRecord): SpecRecordOutput {
  return {
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
