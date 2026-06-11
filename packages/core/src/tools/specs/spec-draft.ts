import { z } from 'zod';
import type { ToolSpec } from '../registry.js';
import { assertToolCallerRole } from '../caller-auth.js';
import { validateCriteria } from '../../plans/criteria.js';
import type { Criterion } from '../../specs/criteria-schema.js';
import {
  specRecordOutputSchema,
  specRecordToOutput,
  type SpecRecordOutput,
} from './spec-record-output.js';

const criterionInputSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .describe(
        'The concrete, checkable acceptance outcome, e.g. "expired tokens rejected (401)".',
      ),
    verify: z
      .string()
      .optional()
      .describe(
        'The wired verification command that proves this criterion, e.g. "pnpm vitest run packages/core/x". ' +
          'Required by the draft validator.',
      ),
  })
  .strict();

const specDraftInput = z
  .object({
    task_id: z
      .string()
      .min(1)
      .describe('The task id this spec is drafted for (the spec stream key).'),
    title: z.string().min(1).describe('A short human title for the spec.'),
    goal: z.string().min(1).describe('The spec goal statement — what the work must achieve.'),
    criteria: z
      .array(criterionInputSchema)
      .describe(
        'The acceptance criteria — each a checkable outcome with a wired verification command. ' +
          'Drafting requires lockable criteria so a spec cannot enter a dead-end fuzzy draft state.',
      ),
    body: z.string().describe('The full spec body text.'),
  })
  .strict();
type SpecDraftInput = z.infer<typeof specDraftInput>;

/**
 * `co_spec_draft` (L6b F2): the coordinator verb that drafts a spec record into the durable spec store
 * (program-data only, Principle 12 — never the repo). Draft runs the same criterion validator as
 * lock so a spec cannot enter a dead-end fuzzy draft state. Loud-fails when
 * `ctx.specs`/`ctx.roster` are absent (Principle 9 — the mount assembles the context).
 *
 * Scoped to: coordinator (the spec owner). The drafting agent is recorded as the record's actor.
 */
export const specDraftTool: ToolSpec<SpecDraftInput, SpecRecordOutput> = {
  name: 'co_spec_draft',
  title: 'Draft a spec',
  description:
    'Draft a spec record (title, goal, acceptance criteria, body) into the durable spec store under a ' +
    'task id. Drafting requires wired, non-vacuous criteria so the record can be locked later. ' +
    'Only a coordinator may draft a spec.',
  inputSchema: specDraftInput,
  outputSchema: specRecordOutputSchema,
  handler: (ctx, input): SpecRecordOutput => {
    if (!ctx.specs) {
      throw new Error('co_spec_draft: the mount did not inject a spec store (ctx.specs absent).');
    }
    if (!ctx.roster) {
      throw new Error(
        'co_spec_draft: the mount did not inject a roster store (ctx.roster absent).',
      );
    }
    assertToolCallerRole('co_spec_draft', ctx.roster, ctx.agent, ['coordinator']);

    const criteria: Criterion[] = input.criteria.map((c) =>
      c.verify != null ? { text: c.text, verify: c.verify } : { text: c.text },
    );
    const violations = validateCriteria(criteria);
    if (violations.length > 0) {
      const enumerated = violations
        .map((v) => `  - criterion ${v.index} ("${v.text}"): ${v.reason}`)
        .join('\n');
      throw new Error(
        `co_spec_draft: refusing to draft '${input.task_id}' — ${violations.length} criterion ` +
          `violation(s); draft criteria must be lockable:\n${enumerated}`,
      );
    }
    const rec = ctx.specs.recordDraft({
      taskId: input.task_id,
      title: input.title,
      goal: input.goal,
      criteria,
      body: input.body,
      actor: ctx.agent,
    });
    return specRecordToOutput(rec);
  },
};
