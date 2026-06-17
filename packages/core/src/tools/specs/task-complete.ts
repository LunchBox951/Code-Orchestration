import { z } from 'zod';
import type { ToolSpec } from '../registry.js';
import { assertToolCallerRole } from '../caller-auth.js';
import {
  planRecordOutputSchema,
  planRecordToOutput,
  type PlanRecordOutput,
} from './plan-record-output.js';

const taskCompleteInput = z
  .object({
    task_id: z
      .string()
      .min(1)
      .describe('The task id whose plan is fully merged and ready to close (the plan stream key).'),
  })
  .strict();
type TaskCompleteInput = z.infer<typeof taskCompleteInput>;

/**
 * `co_task_complete` (L6b / Stage 15 P-D): the COORDINATOR-only verb that closes a task by recording
 * the terminal `task.completed` plan event (program-data only, Principle 12 — never the repo). It is
 * the last step of the autonomous multi-phase loop: after the final phase's gated merge lands and the
 * coordinator records that phase `merged`, it completes the task.
 *
 * SAFETY GATE (deterministic, Principle 9 — fail loud): it REFUSES unless EVERY phase status is
 * `merged` AND has a green `phase.verified` record. This makes premature completion impossible — a
 * task whose plan still has an un-merged or unverified phase cannot be closed. The check is a pure
 * store read (no clock); the event's completion timestamp comes from `event.ts` on replay (freeze #6
 * — never a wall clock).
 */
export const taskCompleteTool: ToolSpec<TaskCompleteInput, PlanRecordOutput> = {
  name: 'co_task_complete',
  title: 'Complete a task',
  description:
    'Close a task by recording its terminal task.completed plan event — the last step of the ' +
    'autonomous multi-phase loop, once the final phase has merged. Refuses unless every phase of the ' +
    "task's plan is 'merged' (deterministic safety against premature completion), there is no plan " +
    'recorded, or the caller is not a coordinator. Only a coordinator may complete a task.',
  inputSchema: taskCompleteInput,
  outputSchema: planRecordOutputSchema,
  handler: (ctx, input): PlanRecordOutput => {
    if (!ctx.plans) {
      throw new Error(
        'co_task_complete: the mount did not inject a plan store (ctx.plans absent).',
      );
    }
    if (!ctx.roster) {
      throw new Error(
        'co_task_complete: the mount did not inject a roster store (ctx.roster absent).',
      );
    }
    assertToolCallerRole('co_task_complete', ctx.roster, ctx.agent, ['coordinator']);

    const plan = ctx.plans.getPlan(input.task_id);
    if (plan == null) {
      throw new Error(`co_task_complete: no plan recorded for task '${input.task_id}'.`);
    }
    // GATE: refuse unless EVERY phase has merged — never close a task with work still outstanding.
    const unmerged = plan.phases.filter((p) => p.status !== 'merged');
    if (unmerged.length > 0) {
      const detail = unmerged.map((p) => `'${p.phaseId}' (${p.status})`).join(', ');
      throw new Error(
        `co_task_complete: refusing to complete task '${input.task_id}' — ${unmerged.length} ` +
          `phase(s) not 'merged': ${detail}. Every phase must merge before the task can close.`,
      );
    }

    const unverified = plan.phases.filter((p) => p.verifiedPass !== true);
    if (unverified.length > 0) {
      const detail = unverified
        .map((p) => `'${p.phaseId}' (${p.verifiedPass === false ? 'failed' : 'missing'})`)
        .join(', ');
      throw new Error(
        `co_task_complete: refusing to complete task '${input.task_id}' — ${unverified.length} ` +
          `phase(s) not verified green: ${detail}. Every phase must have phase.verified(pass=true) ` +
          'before the task can close.',
      );
    }

    const rec = ctx.plans.recordTaskCompleted(input.task_id, ctx.agent);
    return planRecordToOutput(rec);
  },
};
