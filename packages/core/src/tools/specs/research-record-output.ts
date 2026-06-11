import { z } from 'zod';
import { RESEARCH_KINDS, type ResearchRecord } from '../../research/events.js';
import { citedAnswerSchema, locatorMapSchema } from '../../research/map-contract.js';

/**
 * The structured output fields for a returned research RECORD — shared by `co_research_finalize`
 * (which returns the record it wrote) and `co_research_get` (which adds a `found` flag). The map
 * and answer ride their full contract schemas so a reader gets the same shape the writer proved.
 */
export const researchRecordOutputShape = {
  research_id: z.string().describe('The research id (the research stream key).'),
  question: z.string().describe('The scoped question this research answered.'),
  requested_by: z.string().describe('The agent that requested the research.'),
  researcher: z.string().describe('The researcher that finalized the result.'),
  kind: z
    .enum(RESEARCH_KINDS)
    .describe("The result kind: 'map' (a locator map) or 'answer' (a cited answer)."),
  map: locatorMapSchema.optional().describe("The locator map (present when kind is 'map')."),
  answer: citedAnswerSchema
    .optional()
    .describe("The cited answer (present when kind is 'answer')."),
  finalized_ts: z.number().int().describe('The event timestamp when the research was finalized.'),
} as const;

export const researchRecordOutputSchema = z.object(researchRecordOutputShape);
export type ResearchRecordOutput = z.infer<typeof researchRecordOutputSchema>;

/** Project a durable {@link ResearchRecord} into the structured tool output. */
export function researchRecordToOutput(rec: ResearchRecord): ResearchRecordOutput {
  return {
    research_id: rec.researchId,
    question: rec.question,
    requested_by: rec.requestedBy,
    researcher: rec.researcher,
    kind: rec.kind,
    ...(rec.map != null ? { map: rec.map } : {}),
    ...(rec.answer != null ? { answer: rec.answer } : {}),
    finalized_ts: rec.finalizedTs,
  };
}
