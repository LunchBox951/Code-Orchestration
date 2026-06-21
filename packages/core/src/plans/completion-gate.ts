import type { PlanRecord } from './events.js';

/**
 * The single task-completion readiness gate. Extracted so the store, the projector, and the
 * co_task_complete tool share ONE definition instead of three byte-identical copies that could drift
 * (packages/core is the single source of truth). Refuses task.completed unless EVERY phase has merged
 * AND verified green. Pure + side-effect-free; `operation` is the caller's label, used as the message
 * prefix so each surface keeps its own voice.
 */
export function assertPlanReadyToComplete(operation: string, plan: PlanRecord): void {
  const unmerged = plan.phases.filter((p) => p.status !== 'merged');
  if (unmerged.length > 0) {
    const detail = unmerged.map((p) => `'${p.phaseId}' (${p.status})`).join(', ');
    throw new Error(
      `${operation}: refusing task.completed for plan '${plan.taskId}' — ${unmerged.length} ` +
        `phase(s) not 'merged': ${detail}. Every phase must merge before the task can close.`,
    );
  }
  const unverified = plan.phases.filter((p) => p.verifiedPass !== true);
  if (unverified.length > 0) {
    const detail = unverified
      .map((p) => `'${p.phaseId}' (${p.verifiedPass === false ? 'failed' : 'missing'})`)
      .join(', ');
    throw new Error(
      `${operation}: refusing task.completed for plan '${plan.taskId}' — ${unverified.length} ` +
        `phase(s) not verified green: ${detail}. Every phase must have phase.verified(pass=true) ` +
        'before the task can close.',
    );
  }
}
