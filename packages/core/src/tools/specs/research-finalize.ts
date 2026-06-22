import { z } from 'zod';
import type { ToolSpec } from '../registry.js';
import { assertToolCallerRole } from '../caller-auth.js';
import { RESEARCH_KINDS } from '../../research/events.js';
import {
  checkLocatorMap,
  citedAnswerSchema,
  locatorMapSchema,
} from '../../research/map-contract.js';
import {
  researchRecordOutputSchema,
  researchRecordToOutput,
  type ResearchRecordOutput,
} from './research-record-output.js';

const researchFinalizeInput = z
  .object({
    research_id: z
      .string()
      .min(1)
      .describe('A new unique id for this research result (the research stream key).'),
    question: z.string().min(1).describe('The scoped question this research answers.'),
    requested_by: z.string().min(1).describe('The agent the result is for (the requester).'),
    kind: z
      .enum(RESEARCH_KINDS)
      .describe("The result kind: 'map' (a locator map) or 'answer' (a cited answer)."),
    map: locatorMapSchema
      .optional()
      .describe(
        "The locator map (required when kind is 'map'): files + a one-line why each + key " +
          'symbols + a suggested read order. Pointers, not a content dump.',
      ),
    answer: citedAnswerSchema
      .optional()
      .describe(
        "The cited answer (required when kind is 'answer'): the clean conclusion + citations.",
      ),
  })
  .strict();
type ResearchFinalizeInput = z.infer<typeof researchFinalizeInput>;

/**
 * `co_research_finalize` (L6b H): a researcher durably records its finished result — a locator
 * map or a cited answer — as queryable program-data (the heir to the prototype's
 * `research-report`). The map contract is validated structurally (one-line whys via the schema;
 * read-order coherence + path uniqueness via {@link checkLocatorMap}) so a content dump cannot
 * be finalized as a "map". Researcher-only; the finalizing agent is recorded as the researcher.
 *
 * Research *dispatch* (spawning the researcher) is L7's Conductor — at L6b a researcher is
 * driven headless/by tests, and the record it finalizes is what every later agent reads.
 *
 * Description rationale (kept out of the .describe() syntax surface): the map contract is enforced,
 * so incoherent read orders, duplicate paths, multi-line whys, and citation-free answers are
 * rejected — the point is that a result later agents read instead of re-searching is structurally
 * trustworthy.
 */
export const researchFinalizeTool: ToolSpec<ResearchFinalizeInput, ResearchRecordOutput> = {
  name: 'co_research_finalize',
  title: 'Finalize a research result',
  description:
    'Durably record your finished research result — a locator map or a cited answer — so the ' +
    'requester and later agents read it instead of re-searching. Researcher-only.',
  inputSchema: researchFinalizeInput,
  outputSchema: researchRecordOutputSchema,
  handler: (ctx, input): ResearchRecordOutput => {
    if (!ctx.research) {
      throw new Error(
        'co_research_finalize: the mount did not inject a research store (ctx.research absent).',
      );
    }
    if (!ctx.roster) {
      throw new Error(
        'co_research_finalize: the mount did not inject a roster store (ctx.roster absent).',
      );
    }
    assertToolCallerRole('co_research_finalize', ctx.roster, ctx.agent, ['researcher']);

    if (input.kind === 'map' && input.map != null) {
      const violations = checkLocatorMap(input.map);
      if (violations.length > 0) {
        const enumerated = violations.map((v) => `  - ${v.reason}`).join('\n');
        throw new Error(
          `co_research_finalize: refusing to finalize '${input.research_id}' — ` +
            `${violations.length} map violation(s):\n${enumerated}`,
        );
      }
    }

    const rec = ctx.research.recordFinalize({
      researchId: input.research_id,
      question: input.question,
      requestedBy: input.requested_by,
      researcher: ctx.agent,
      kind: input.kind,
      ...(input.map != null ? { map: input.map } : {}),
      ...(input.answer != null ? { answer: input.answer } : {}),
    });
    return researchRecordToOutput(rec);
  },
};
