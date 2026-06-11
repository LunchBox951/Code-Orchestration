import { z } from 'zod';
import type { ToolSpec } from '../registry.js';
import { assertToolCallerRole } from '../caller-auth.js';
import { BASE_ROLES } from '../scoping.js';
import { researchRecordOutputShape, researchRecordToOutput } from './research-record-output.js';

const researchGetInput = z
  .object({
    research_id: z.string().min(1).describe('The research id to look up.'),
  })
  .strict();
type ResearchGetInput = z.infer<typeof researchGetInput>;

const researchGetOutput = z.object({
  found: z.boolean().describe('Whether a finalized research record exists for this id.'),
  research_id: z.string().describe('The research id that was looked up.'),
  question: researchRecordOutputShape.question.optional(),
  requested_by: researchRecordOutputShape.requested_by.optional(),
  researcher: researchRecordOutputShape.researcher.optional(),
  kind: researchRecordOutputShape.kind.optional(),
  map: researchRecordOutputShape.map,
  answer: researchRecordOutputShape.answer,
  finalized_ts: researchRecordOutputShape.finalized_ts.optional(),
});
type ResearchGetOutput = z.infer<typeof researchGetOutput>;

/**
 * `co_research_get` (L6b H): read a finalized research record — the requester (and any later
 * agent) reads the durable map/answer instead of re-searching (context economy, research.md).
 * Offered to every role, mirroring `co_spec_get`'s broad read surface. A structured not-found is
 * returned for absent ids (never a throw — absence is an answer).
 */
export const researchGetTool: ToolSpec<ResearchGetInput, ResearchGetOutput> = {
  name: 'co_research_get',
  title: 'Read a finalized research result',
  description:
    'Read a finalized research record (locator map or cited answer) by id. Use this to consume a ' +
    "researcher's durable result instead of re-searching. Returns found=false when no record " +
    'exists for the id.',
  inputSchema: researchGetInput,
  outputSchema: researchGetOutput,
  handler: (ctx, input): ResearchGetOutput => {
    if (!ctx.research) {
      throw new Error(
        'co_research_get: the mount did not inject a research store (ctx.research absent).',
      );
    }
    if (!ctx.roster) {
      throw new Error(
        'co_research_get: the mount did not inject a roster store (ctx.roster absent).',
      );
    }
    assertToolCallerRole('co_research_get', ctx.roster, ctx.agent, BASE_ROLES);

    const rec = ctx.research.getResearch(input.research_id);
    if (rec == null) {
      return { found: false, research_id: input.research_id };
    }
    return { found: true, ...researchRecordToOutput(rec) };
  },
};
