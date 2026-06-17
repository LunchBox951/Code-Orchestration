/**
 * The L6b E1 durable plan record store. Opens the PROJECT store, wires the
 * {@link PlansProjector}, and exposes a typed {@link PlanStore} facade.
 *
 * Note: the store does NOT import `validateCriteria` — criteria validation is the tool-layer
 * ingestion gate (`co_plan_ingest`), not a store concern. This mirrors how the F1 spec store
 * left the lock-validator to the F2 tool.
 */
import type { DatabaseSync } from 'node:sqlite';
import { decode } from '../replay/decode.js';
import { applyEvent, type Projector } from '../replay/projector.js';
import { openProjectStore } from '../store/sqlite-store.js';
import type { Criterion } from '../specs/criteria-schema.js';
import {
  makePlanDraftedEvent,
  makePhaseStatusChangedEvent,
  makePhaseVerifiedEvent,
  makePlanReplannedEvent,
  makeTaskCompletedEvent,
  plansSchemas,
  plansUpcasters,
  type PhaseNode,
  type PhaseStatus,
  type PlanRecord,
} from './events.js';
import {
  PlansProjector,
  ensurePlansTables,
  selectAllPlans,
  selectPlan,
} from './plans-projector.js';

export interface PlanStore {
  /** Record a plan draft (append `plan.drafted` + fold); returns the read-back record. */
  recordDraft(rec: {
    taskId: string;
    goal: string;
    taskCriteria: readonly Criterion[];
    phases: readonly PhaseNode[];
    actor: string;
  }): PlanRecord;
  /** Record a phase status change (append `phase.status.changed` + fold); returns the plan. */
  changePhaseStatus(
    taskId: string,
    phaseId: string,
    status: PhaseStatus,
    actor: string,
  ): PlanRecord;
  /** Record a phase verified outcome (append `phase.verified` + fold); returns the plan. */
  recordPhaseVerified(
    taskId: string,
    phaseId: string,
    baselineSha: string,
    pass: boolean,
    actor: string,
  ): PlanRecord;
  /** Record a replan (append `plan.replanned` + fold); returns the amended plan. */
  recordReplan(
    taskId: string,
    reason: string,
    phases: readonly PhaseNode[],
    actor: string,
  ): PlanRecord;
  /** Record a task completion (append `task.completed` + fold); returns the completed plan. */
  recordTaskCompleted(taskId: string, actor: string): PlanRecord;
  /** The plan record for `taskId`, or undefined. */
  getPlan(taskId: string): PlanRecord | undefined;
  /** Every recorded plan, in stable order (by drafted_ts then task_id). */
  listPlans(): readonly PlanRecord[];
  /** Close the underlying project store. */
  close(): void;
}

/**
 * Open the project plan store: open the PROJECT store, wire the {@link PlansProjector}, and
 * return the {@link PlanStore} facade. Safe alongside other stores on the same per-project
 * `store.db` — `node:sqlite` is synchronous/single-threaded; the plan store owns distinct
 * scopes (`plan:`) and distinct read-model tables (`plans`, `plan_phases`).
 */
export function openPlanStore(projectId: string): PlanStore {
  const store = openProjectStore(projectId);
  const projectors: readonly Projector[] = [new PlansProjector()];

  return {
    recordDraft(rec): PlanRecord {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensurePlansTables(db);
        const existing = selectPlan(db, rec.taskId);
        if (existing != null) {
          const planEvent = {
            taskId: rec.taskId,
            goal: rec.goal,
            taskCriteria: [...rec.taskCriteria],
            phases: rec.phases.map((p) => ({
              phaseId: p.phaseId,
              name: p.name,
              ...(p.owner != null ? { owner: p.owner } : {}),
              deps: [...p.deps],
              criteria: [...p.criteria],
            })),
          };
          const existingPhasesSerialized = JSON.stringify(
            existing.phases.map((p) => ({
              phaseId: p.phaseId,
              name: p.name,
              owner: p.owner,
              deps: p.deps,
              criteria: p.criteria,
            })),
          );
          const newPhasesSerialized = JSON.stringify(
            planEvent.phases.map((p) => ({
              phaseId: p.phaseId,
              name: p.name,
              owner: p.owner,
              deps: p.deps,
              criteria: p.criteria,
            })),
          );
          if (
            existing.goal === rec.goal &&
            JSON.stringify(existing.taskCriteria) === JSON.stringify(rec.taskCriteria) &&
            existingPhasesSerialized === newPhasesSerialized
          ) {
            return existing;
          }
          throw new Error(
            `openPlanStore.recordDraft: plan '${rec.taskId}' already exists with different content — refusing conflicting re-draft`,
          );
        }
        const [stored] = tx.append([
          makePlanDraftedEvent(
            projectId,
            {
              taskId: rec.taskId,
              goal: rec.goal,
              taskCriteria: [...rec.taskCriteria],
              phases: rec.phases.map((p) => ({
                phaseId: p.phaseId,
                name: p.name,
                ...(p.owner != null ? { owner: p.owner } : {}),
                deps: [...p.deps],
                criteria: [...p.criteria],
              })),
            },
            rec.actor,
          ),
        ]);
        applyEvent(tx, decode(stored!, plansUpcasters, plansSchemas), projectors);
        const row = selectPlan(db, rec.taskId);
        if (!row) {
          throw new Error(
            `openPlanStore.recordDraft: row missing after projection (taskId='${rec.taskId}')`,
          );
        }
        return row;
      });
    },

    changePhaseStatus(
      taskId: string,
      phaseId: string,
      status: PhaseStatus,
      actor: string,
    ): PlanRecord {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensurePlansTables(db);
        const [stored] = tx.append([
          makePhaseStatusChangedEvent(projectId, { taskId, phaseId, status }, actor),
        ]);
        applyEvent(tx, decode(stored!, plansUpcasters, plansSchemas), projectors);
        const row = selectPlan(db, taskId);
        if (!row) {
          throw new Error(
            `openPlanStore.changePhaseStatus: row missing after projection (taskId='${taskId}')`,
          );
        }
        return row;
      });
    },

    recordPhaseVerified(
      taskId: string,
      phaseId: string,
      baselineSha: string,
      pass: boolean,
      actor: string,
    ): PlanRecord {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensurePlansTables(db);
        const [stored] = tx.append([
          makePhaseVerifiedEvent(projectId, { taskId, phaseId, baselineSha, pass }, actor),
        ]);
        applyEvent(tx, decode(stored!, plansUpcasters, plansSchemas), projectors);
        const row = selectPlan(db, taskId);
        if (!row) {
          throw new Error(
            `openPlanStore.recordPhaseVerified: row missing after projection (taskId='${taskId}')`,
          );
        }
        return row;
      });
    },

    recordReplan(
      taskId: string,
      reason: string,
      phases: readonly PhaseNode[],
      actor: string,
    ): PlanRecord {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensurePlansTables(db);
        const [stored] = tx.append([
          makePlanReplannedEvent(
            projectId,
            {
              taskId,
              reason,
              phases: phases.map((p) => ({
                phaseId: p.phaseId,
                name: p.name,
                ...(p.owner != null ? { owner: p.owner } : {}),
                deps: [...p.deps],
                criteria: [...p.criteria],
              })),
            },
            actor,
          ),
        ]);
        applyEvent(tx, decode(stored!, plansUpcasters, plansSchemas), projectors);
        const row = selectPlan(db, taskId);
        if (!row) {
          throw new Error(
            `openPlanStore.recordReplan: row missing after projection (taskId='${taskId}')`,
          );
        }
        return row;
      });
    },

    recordTaskCompleted(taskId: string, actor: string): PlanRecord {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensurePlansTables(db);
        const existing = selectPlan(db, taskId);
        if (existing == null) {
          throw new Error(
            `openPlanStore.recordTaskCompleted: task.completed for unknown plan '${taskId}' — draft it first`,
          );
        }
        if (existing.completedTs != null) {
          return existing;
        }
        const [stored] = tx.append([makeTaskCompletedEvent(projectId, { taskId }, actor)]);
        applyEvent(tx, decode(stored!, plansUpcasters, plansSchemas), projectors);
        const row = selectPlan(db, taskId);
        if (!row) {
          throw new Error(
            `openPlanStore.recordTaskCompleted: row missing after projection (taskId='${taskId}')`,
          );
        }
        return row;
      });
    },

    getPlan(taskId: string): PlanRecord | undefined {
      return store.transaction((tx) => selectPlan(tx.raw as DatabaseSync, taskId));
    },

    listPlans(): readonly PlanRecord[] {
      return store.transaction((tx) => selectAllPlans(tx.raw as DatabaseSync));
    },

    close(): void {
      store.close();
    },
  };
}
