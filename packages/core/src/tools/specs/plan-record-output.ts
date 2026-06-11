import { z } from 'zod';
import type { PlanRecord } from '../../plans/events.js';

const criterionOutputSchema = z.object({
  text: z.string().describe('The concrete, checkable outcome.'),
  verify: z.string().optional().describe('The wired verification command, if set.'),
});

const phaseRecordOutputSchema = z.object({
  phase_id: z.string().describe('The phase identifier.'),
  name: z.string().describe('The phase name.'),
  owner: z.string().optional().describe('The Lead that owns the phase, if set.'),
  deps: z.array(z.string()).describe('Phase ids this phase depends on.'),
  criteria: z.array(criterionOutputSchema).describe('Per-phase acceptance criteria.'),
  status: z
    .enum(['planned', 'building', 'review', 'verified', 'merged'])
    .describe('Current phase status.'),
  verified_pass: z.boolean().optional().describe('Whether the phase suite passed verification.'),
  baseline_sha: z.string().optional().describe('The baseline SHA from phase.verified.'),
});

/**
 * The structured output schema for a returned plan RECORD — used by `co_plan_ingest`.
 * A ZodObject so the completeness gate's structured-output check passes.
 */
export const planRecordOutputSchema = z.object({
  task_id: z.string().describe('The task id of the plan.'),
  goal: z.string().describe('The plan goal statement.'),
  task_criteria: z.array(criterionOutputSchema).describe('Task-level acceptance criteria.'),
  phases: z.array(phaseRecordOutputSchema).describe('The phase DAG nodes.'),
  drafted_ts: z.number().int().describe('The event timestamp when this plan was drafted.'),
  replan_count: z.number().int().describe('Number of plan.replanned events applied.'),
});
export type PlanRecordOutput = z.infer<typeof planRecordOutputSchema>;

/** Project a durable {@link PlanRecord} into the structured tool output. */
export function planRecordToOutput(rec: PlanRecord): PlanRecordOutput {
  return {
    task_id: rec.taskId,
    goal: rec.goal,
    task_criteria: rec.taskCriteria.map((c) => ({
      text: c.text,
      ...(c.verify != null ? { verify: c.verify } : {}),
    })),
    phases: rec.phases.map((p) => ({
      phase_id: p.phaseId,
      name: p.name,
      ...(p.owner != null ? { owner: p.owner } : {}),
      deps: [...p.deps],
      criteria: p.criteria.map((c) => ({
        text: c.text,
        ...(c.verify != null ? { verify: c.verify } : {}),
      })),
      status: p.status,
      ...(p.verifiedPass != null ? { verified_pass: p.verifiedPass } : {}),
      ...(p.baselineSha != null ? { baseline_sha: p.baselineSha } : {}),
    })),
    drafted_ts: rec.draftedTs,
    replan_count: rec.replanCount,
  };
}
