/**
 * L6b E1 event definitions for the durable plan record. Lives in the PROJECT store (one per
 * registered project). Pure ORCHESTRATION state stored in program-data only (Principle 12 —
 * pristine-repo).
 *
 * One stream per plan, keyed by the `plan:<taskId>` scope pattern. Five event types model the
 * plan lifecycle: draft → phase-status transitions → phase-verified → replan audit trail →
 * task-completed (the terminal close, recorded once every phase has merged).
 */
import { z } from 'zod';
import type { NewEvent } from '../store/types.js';
import type { SchemaMap } from '../replay/decode.js';
import type { UpcasterRegistry } from '../replay/upcaster.js';
import { criterionSchema, type Criterion } from '../specs/criteria-schema.js';

/** Current payload schema version — v1; no upcasters yet. */
export const PLANS_EVENT_V = 1;

export const EVENT_PLAN_DRAFTED = 'plan.drafted' as const;
export const EVENT_PHASE_STATUS_CHANGED = 'phase.status.changed' as const;
export const EVENT_PHASE_VERIFIED = 'phase.verified' as const;
export const EVENT_PLAN_REPLANNED = 'plan.replanned' as const;
export const EVENT_TASK_COMPLETED = 'task.completed' as const;

/** Scope prefix for the per-plan event stream; suffix is the task id. */
export const PLAN_SCOPE_PREFIX = 'plan:';

/** The per-plan stream scope: `plan:<taskId>`. */
export function planScope(taskId: string): string {
  return PLAN_SCOPE_PREFIX + taskId;
}

export const PHASE_STATUSES = ['planned', 'building', 'review', 'verified', 'merged'] as const;
export type PhaseStatus = (typeof PHASE_STATUSES)[number];
export const phaseStatusSchema = z.enum(PHASE_STATUSES);

/** A phase DAG node as stored in `plan.drafted` and `plan.replanned`. */
export const phaseNodeSchema = z
  .object({
    phaseId: z.string().min(1),
    name: z.string().min(1),
    owner: z.string().optional(),
    deps: z.array(z.string()),
    criteria: z.array(criterionSchema),
  })
  .strict();
export type PhaseNode = z.infer<typeof phaseNodeSchema>;

/** The `plan.drafted` payload. */
export const planDraftedSchema = z
  .object({
    taskId: z.string().min(1),
    goal: z.string().min(1),
    taskCriteria: z.array(criterionSchema),
    phases: z.array(phaseNodeSchema),
  })
  .strict();
export type PlanDrafted = z.infer<typeof planDraftedSchema>;

/** The `phase.status.changed` payload. */
export const phaseStatusChangedSchema = z
  .object({
    taskId: z.string().min(1),
    phaseId: z.string().min(1),
    status: phaseStatusSchema,
  })
  .strict();
export type PhaseStatusChanged = z.infer<typeof phaseStatusChangedSchema>;

/** The `phase.verified` payload — the mechanical suite outcome for a phase. */
export const phaseVerifiedSchema = z
  .object({
    taskId: z.string().min(1),
    phaseId: z.string().min(1),
    baselineSha: z.string().min(1),
    pass: z.boolean(),
  })
  .strict();
export type PhaseVerified = z.infer<typeof phaseVerifiedSchema>;

/** The `plan.replanned` payload — amends the DAG with an audit trail. */
export const planReplannedSchema = z
  .object({
    taskId: z.string().min(1),
    reason: z.string().min(1),
    phases: z.array(phaseNodeSchema),
  })
  .strict();
export type PlanReplanned = z.infer<typeof planReplannedSchema>;

/**
 * The `task.completed` payload — the terminal close of a task's plan (recorded once every phase has
 * merged). The payload is JUST the task id; the completion timestamp comes from `event.ts` on replay
 * (freeze #6 — never a wall clock), so there is no `ts` in the payload.
 */
export const taskCompletedSchema = z
  .object({
    taskId: z.string().min(1),
  })
  .strict();
export type TaskCompleted = z.infer<typeof taskCompletedSchema>;

/** Current-version schema map for plan events — validated on append AND on read (decode). */
export const plansSchemas: SchemaMap = new Map<string, z.ZodType>([
  [EVENT_PLAN_DRAFTED, planDraftedSchema],
  [EVENT_PHASE_STATUS_CHANGED, phaseStatusChangedSchema],
  [EVENT_PHASE_VERIFIED, phaseVerifiedSchema],
  [EVENT_PLAN_REPLANNED, planReplannedSchema],
  [EVENT_TASK_COMPLETED, taskCompletedSchema],
]);

/** No payload migrations at v1 (an empty chain is the identity upcast). */
export const plansUpcasters: UpcasterRegistry = new Map();

/** A phase record in the read model. */
export interface PhaseRecord {
  readonly phaseId: string;
  readonly name: string;
  readonly owner?: string;
  readonly deps: readonly string[];
  readonly criteria: readonly Criterion[];
  readonly status: PhaseStatus;
  readonly verifiedPass?: boolean;
  readonly baselineSha?: string;
}

/**
 * A persisted, read-back plan record — the read-model shape the plan store facade returns.
 * Timestamps come from `event.ts` on replay (freeze #6 — never wall-clock).
 */
export interface PlanRecord {
  readonly taskId: string;
  readonly goal: string;
  readonly taskCriteria: readonly Criterion[];
  readonly phases: readonly PhaseRecord[];
  readonly draftedTs: number;
  readonly replanCount: number;
  /** The `event.ts` of the `task.completed` close, or absent while the task is still open. */
  readonly completedTs?: number;
}

export function makePlanDraftedEvent(projectId: string, rec: PlanDrafted, actor: string): NewEvent {
  const payload = planDraftedSchema.parse(rec);
  return {
    projectId,
    scope: planScope(payload.taskId),
    type: EVENT_PLAN_DRAFTED,
    v: PLANS_EVENT_V,
    payload,
    actor,
  };
}

export function makePhaseStatusChangedEvent(
  projectId: string,
  rec: PhaseStatusChanged,
  actor: string,
): NewEvent {
  const payload = phaseStatusChangedSchema.parse(rec);
  return {
    projectId,
    scope: planScope(payload.taskId),
    type: EVENT_PHASE_STATUS_CHANGED,
    v: PLANS_EVENT_V,
    payload,
    actor,
  };
}

export function makePhaseVerifiedEvent(
  projectId: string,
  rec: PhaseVerified,
  actor: string,
): NewEvent {
  const payload = phaseVerifiedSchema.parse(rec);
  return {
    projectId,
    scope: planScope(payload.taskId),
    type: EVENT_PHASE_VERIFIED,
    v: PLANS_EVENT_V,
    payload,
    actor,
  };
}

export function makePlanReplannedEvent(
  projectId: string,
  rec: PlanReplanned,
  actor: string,
): NewEvent {
  const payload = planReplannedSchema.parse(rec);
  return {
    projectId,
    scope: planScope(payload.taskId),
    type: EVENT_PLAN_REPLANNED,
    v: PLANS_EVENT_V,
    payload,
    actor,
  };
}

export function makeTaskCompletedEvent(
  projectId: string,
  rec: TaskCompleted,
  actor: string,
): NewEvent {
  const payload = taskCompletedSchema.parse(rec);
  return {
    projectId,
    scope: planScope(payload.taskId),
    type: EVENT_TASK_COMPLETED,
    v: PLANS_EVENT_V,
    payload,
    actor,
  };
}
