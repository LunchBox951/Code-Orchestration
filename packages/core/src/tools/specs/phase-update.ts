import { z } from 'zod';
import type { ToolSpec } from '../registry.js';
import { assertToolCallerRole } from '../caller-auth.js';
import {
  planRecordOutputSchema,
  planRecordToOutput,
  type PlanRecordOutput,
} from './plan-record-output.js';

// The statuses a coordinator may TRANSITION a phase to. 'planned' is the initial draft state only —
// it is never set via an update (a phase never regresses to un-planned), so it is excluded here.
const updatableStatusSchema = z.enum(['building', 'review', 'verified', 'merged']);

const verifiedInput = z
  .object({
    baseline_sha: z
      .string()
      .min(1)
      .describe('The integration baseline sha the phase was verified against (the gate point).'),
    pass: z
      .boolean()
      .describe(
        'Whether the phase verification — the gated lead→integration merge review — passed.',
      ),
  })
  .strict();

const phaseUpdateInput = z
  .object({
    task_id: z
      .string()
      .min(1)
      .describe('The task id whose plan this phase belongs to (the plan stream key).'),
    phase_id: z
      .string()
      .min(1)
      .describe('The explicit phase id (DAG node key) to update — co_merge stays phase-agnostic.'),
    status: updatableStatusSchema
      .optional()
      .describe(
        'Optional new phase status (building | review | verified | merged). Records a ' +
          'phase.status.changed for the explicit phase.',
      ),
    verified: verifiedInput
      .optional()
      .describe(
        'Optional phase.verified outcome (baseline_sha + pass) — the mechanical/gated-review suite ' +
          'result recorded at the point the phase merge lands.',
      ),
  })
  .strict();
type PhaseUpdateInput = z.infer<typeof phaseUpdateInput>;

/**
 * `co_phase_update` (L6b / Stage 15 P-D): the minimal COORDINATOR-only phase-recorder that drives the
 * autonomous multi-phase loop. It records a `phase.status.changed` and/or a `phase.verified` for an
 * EXPLICIT `(task_id, phase_id)` (program-data only, Principle 12 — never the repo). This is the seam
 * `co_merge` deliberately does NOT have: `co_merge` is phase-agnostic (it never sees a phase id), so
 * the coordinator names the phase here — recording `phase.verified(pass)` at the point the gated
 * lead→integration merge lands (Principle 10 / RG-4: the gated review IS the phase verification) and
 * advancing the phase status `building → verified → merged`.
 *
 * At least one of `status` / `verified` is required (loud-fail otherwise — Principle 9). The plan and
 * phase are pre-validated for a clean error. The recorders just append events; timestamps come from
 * `event.ts` on replay (freeze #6 — never a wall clock).
 */
export const phaseUpdateTool: ToolSpec<PhaseUpdateInput, PlanRecordOutput> = {
  name: 'co_phase_update',
  title: 'Update a phase',
  description:
    'Record a phase status change and/or a phase.verified outcome for an explicit (task_id, phase_id) ' +
    'in a plan. The coordinator names the phase here (co_merge stays phase-agnostic): it advances a ' +
    'phase building → verified → merged and records the gated-review pass as the phase verification. ' +
    'Requires at least one of status/verified; refuses an unknown plan/phase or a non-coordinator ' +
    'caller. Only a coordinator may update a phase.',
  inputSchema: phaseUpdateInput,
  outputSchema: planRecordOutputSchema,
  handler: (ctx, input): PlanRecordOutput => {
    if (!ctx.plans) {
      throw new Error('co_phase_update: the mount did not inject a plan store (ctx.plans absent).');
    }
    if (!ctx.roster) {
      throw new Error(
        'co_phase_update: the mount did not inject a roster store (ctx.roster absent).',
      );
    }
    assertToolCallerRole('co_phase_update', ctx.roster, ctx.agent, ['coordinator']);

    if (input.status == null && input.verified == null) {
      throw new Error(
        'co_phase_update: at least one of `status` or `verified` is required (nothing to record).',
      );
    }

    // Pre-validate the plan + phase exist for a clean error (the store would also throw, but a
    // tool-level check yields a clearer message — Principle 9).
    const plan = ctx.plans.getPlan(input.task_id);
    if (plan == null) {
      throw new Error(`co_phase_update: no plan recorded for task '${input.task_id}'.`);
    }
    if (!plan.phases.some((p) => p.phaseId === input.phase_id)) {
      throw new Error(`co_phase_update: no phase '${input.phase_id}' in plan '${input.task_id}'.`);
    }

    // Record verified BEFORE the status change so the returned record reflects both (each recorder
    // re-reads the full plan after its fold, so the last call's result carries every prior write).
    let rec = plan;
    if (input.verified != null) {
      rec = ctx.plans.recordPhaseVerified(
        input.task_id,
        input.phase_id,
        input.verified.baseline_sha,
        input.verified.pass,
        ctx.agent,
      );
    }
    if (input.status != null) {
      rec = ctx.plans.changePhaseStatus(input.task_id, input.phase_id, input.status, ctx.agent);
    }
    return planRecordToOutput(rec);
  },
};
