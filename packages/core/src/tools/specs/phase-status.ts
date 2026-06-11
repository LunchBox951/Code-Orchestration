import { z } from 'zod';
import type { ToolSpec } from '../registry.js';
import { assertToolCallerRole } from '../caller-auth.js';
import { phaseStatusSchema } from '../../plans/events.js';
import {
  foldTaskReadiness,
  type PhaseReadinessInput,
  type PhaseWorkerInput,
} from '../../plans/readiness.js';
import { branchMerged, resolveAgentBranch } from '../../plans/worker-branch.js';

const phaseStatusInput = z
  .object({
    task_id: z
      .string()
      .min(1)
      .describe('The task id whose plan readiness to report (the plan stream key).'),
  })
  .strict();
type PhaseStatusInput = z.infer<typeof phaseStatusInput>;

const phaseReadinessOutput = z
  .object({
    phase_id: z.string().describe('The phase id (DAG node key).'),
    status: phaseStatusSchema.describe(
      'The phase lifecycle status (planned | building | review | verified | merged).',
    ),
    ready: z
      .boolean()
      .describe(
        'True iff every non-reviewer worker branch is merged AND the phase has a green phase.verified.',
      ),
    reasons_not_ready: z
      .array(z.string())
      .describe('One human-readable reason per unmet readiness condition; empty when ready.'),
  })
  .strict();

const phaseStatusOutput = z
  .object({
    task_id: z.string().describe('The task id this readiness report is for.'),
    ready: z.boolean().describe('Task-level rollup: true iff every phase in the plan is ready.'),
    phases: z.array(phaseReadinessOutput).describe('Per-phase readiness, in plan (DAG) order.'),
  })
  .strict();
type PhaseStatusOutput = z.infer<typeof phaseStatusOutput>;

/**
 * `co_phase_status` (L6b E3/D5): the coordinator/lead READ-ONLY verb that reports whether each phase
 * of a task's plan — and the task as a whole — is ready. It records NOTHING (no events): it assembles
 * each phase's worker list + `verifiedPass` from the already-injected stores and runs the pure
 * {@link foldTaskReadiness} fold.
 *
 * Worker assembly + branch-resolution CONVENTION:
 *   - A phase's workers are the roster children of the phase's `owner` (its Lead): every agent whose
 *     `parent === phase.owner`. A phase with no `owner` has no workers (readiness then rests solely on
 *     `verifiedPass`).
 *   - Each worker's `role` comes from its `AgentRecord`. Reviewers are carried through; the fold
 *     excludes them from completion accounting (INVARIANT 1).
 *   - A worker's branch is resolved via the worktree record assigned to it
 *     ({@link resolveAgentBranch}); the phase's integration target is the owner's own branch (resolved
 *     the same way). `branchMerged` is `true` iff a `PASS` verdict is recorded for
 *     `(owner branch, worker branch)` ({@link branchMerged}) — completion is the merge fact, never a
 *     process-state (INVARIANT 2).
 *
 * Scoped to: coordinator, lead.
 */
export const phaseStatusTool: ToolSpec<PhaseStatusInput, PhaseStatusOutput> = {
  name: 'co_phase_status',
  title: 'Report phase readiness',
  description:
    'Report, read-only, whether each phase of a task plan — and the task overall — is ready. A phase ' +
    'is ready iff every non-reviewer worker branch is merged AND the phase has a green phase.verified ' +
    'record. Reviewers are excluded from completion accounting, and a worker is complete when its ' +
    'branch is merged (never by its process-state). Records nothing. Only a coordinator or lead may call it.',
  inputSchema: phaseStatusInput,
  outputSchema: phaseStatusOutput,
  handler: (ctx, input): PhaseStatusOutput => {
    if (!ctx.plans) {
      throw new Error('co_phase_status: the mount did not inject a plan store (ctx.plans absent).');
    }
    if (!ctx.roster) {
      throw new Error(
        'co_phase_status: the mount did not inject a roster store (ctx.roster absent).',
      );
    }
    if (!ctx.reviews) {
      throw new Error(
        'co_phase_status: the mount did not inject a review store (ctx.reviews absent).',
      );
    }
    if (!ctx.worktrees) {
      throw new Error(
        'co_phase_status: the mount did not inject a worktree store (ctx.worktrees absent).',
      );
    }
    assertToolCallerRole('co_phase_status', ctx.roster, ctx.agent, ['coordinator', 'lead']);

    const plan = ctx.plans.getPlan(input.task_id);
    if (plan == null) {
      throw new Error(`co_phase_status: no plan recorded for task '${input.task_id}'.`);
    }

    const { roster, reviews, worktrees } = ctx;
    const statusByPhase = new Map(plan.phases.map((p) => [p.phaseId, p.status]));

    const phaseInputs: PhaseReadinessInput[] = plan.phases.map((phase) => {
      // The phase's integration target is the owner's (Lead's) own branch; worker branches merge into
      // it. With no owner there are no workers to account for.
      const ownerBranch =
        phase.owner != null ? resolveAgentBranch(worktrees, phase.owner) : undefined;
      const workers: PhaseWorkerInput[] =
        phase.owner == null
          ? []
          : roster
              .listAgents()
              .filter((a) => a.parent === phase.owner)
              .map((a) => {
                const branch = resolveAgentBranch(worktrees, a.agentId);
                return {
                  workerId: a.agentId,
                  role: a.role,
                  branchMerged: branchMerged(reviews, ownerBranch, branch),
                };
              });
      return { phaseId: phase.phaseId, workers, verifiedPass: phase.verifiedPass };
    });

    const task = foldTaskReadiness(phaseInputs);

    return {
      task_id: input.task_id,
      ready: task.ready,
      phases: task.phases.map((p) => ({
        phase_id: p.phaseId,
        status: statusByPhase.get(p.phaseId)!,
        ready: p.ready,
        reasons_not_ready: p.reasonsNotReady,
      })),
    };
  },
};
