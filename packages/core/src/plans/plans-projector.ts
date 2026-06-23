import type { DatabaseSync } from 'node:sqlite';
import { assertNever } from '../assert-never.js';
import { assertPlanReadyToComplete } from './completion-gate.js';
import type { Projector } from '../replay/projector.js';
import type { StoredEvent, StoreTx } from '../store/types.js';
import type { Criterion } from '../specs/criteria-schema.js';
import {
  EVENT_PHASE_STATUS_CHANGED,
  EVENT_PHASE_VERIFIED,
  EVENT_PLAN_DRAFTED,
  EVENT_PLAN_REPLANNED,
  EVENT_TASK_COMPLETED,
  type PhaseRecord,
  type PhaseStatus,
  type PhaseStatusChanged,
  type PhaseVerified,
  type PlanDrafted,
  type PlanRecord,
  type PlanReplanned,
  type PhaseNode,
  type TaskCompleted,
} from './events.js';

const CREATE_PLANS_TABLE = `
  CREATE TABLE IF NOT EXISTS plans (
    task_id       TEXT PRIMARY KEY,
    goal          TEXT NOT NULL,
    task_criteria TEXT NOT NULL,
    drafted_ts    INTEGER NOT NULL,
    replan_count  INTEGER NOT NULL DEFAULT 0,
    completed_ts  INTEGER
  );
`;

const CREATE_PLAN_PHASES_TABLE = `
  CREATE TABLE IF NOT EXISTS plan_phases (
    task_id      TEXT NOT NULL,
    phase_id     TEXT NOT NULL,
    ordinal      INTEGER NOT NULL,
    name         TEXT NOT NULL,
    owner        TEXT,
    deps         TEXT NOT NULL,
    criteria     TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'planned',
    verified_pass INTEGER,
    baseline_sha TEXT,
    PRIMARY KEY (task_id, phase_id)
  );
`;

/** Defensive create of the plans read-model tables — called on reset/apply AND every read path. */
export function ensurePlansTables(db: DatabaseSync): void {
  db.exec(CREATE_PLANS_TABLE);
  db.exec(CREATE_PLAN_PHASES_TABLE);
  const columns = db.prepare(`PRAGMA table_info(plan_phases)`).all() as Array<{
    name: string;
  }>;
  if (!columns.some((c) => c.name === 'ordinal')) {
    db.exec(`ALTER TABLE plan_phases ADD COLUMN ordinal INTEGER NOT NULL DEFAULT 0`);
  }
  const planColumns = db.prepare(`PRAGMA table_info(plans)`).all() as Array<{
    name: string;
  }>;
  if (!planColumns.some((c) => c.name === 'completed_ts')) {
    db.exec(`ALTER TABLE plans ADD COLUMN completed_ts INTEGER`);
  }
}

const PLAN_COLUMNS = 'task_id, goal, task_criteria, drafted_ts, replan_count, completed_ts';
const PHASE_COLUMNS =
  'task_id, phase_id, ordinal, name, owner, deps, criteria, status, verified_pass, baseline_sha';

function rowToPhaseRecord(row: Record<string, unknown>): PhaseRecord {
  return {
    phaseId: String(row.phase_id),
    name: String(row.name),
    ...(row.owner != null ? { owner: String(row.owner) } : {}),
    deps: JSON.parse(String(row.deps)) as readonly string[],
    criteria: JSON.parse(String(row.criteria)) as readonly Criterion[],
    status: String(row.status) as PhaseStatus,
    ...(row.verified_pass != null ? { verifiedPass: Boolean(row.verified_pass) } : {}),
    ...(row.baseline_sha != null ? { baselineSha: String(row.baseline_sha) } : {}),
  };
}

function selectPhases(db: DatabaseSync, taskId: string): PhaseRecord[] {
  const rows = db
    .prepare(
      `SELECT ${PHASE_COLUMNS} FROM plan_phases WHERE task_id = ? ORDER BY ordinal, phase_id`,
    )
    .all(taskId);
  return rows.map((r) => rowToPhaseRecord(r as Record<string, unknown>));
}

function rowToPlanRecord(db: DatabaseSync, row: Record<string, unknown>): PlanRecord {
  return {
    taskId: String(row.task_id),
    goal: String(row.goal),
    taskCriteria: JSON.parse(String(row.task_criteria)) as readonly Criterion[],
    phases: selectPhases(db, String(row.task_id)),
    draftedTs: Number(row.drafted_ts),
    replanCount: Number(row.replan_count),
    ...(row.completed_ts != null ? { completedTs: Number(row.completed_ts) } : {}),
  };
}

/** The plan record for `taskId`, or undefined. */
export function selectPlan(db: DatabaseSync, taskId: string): PlanRecord | undefined {
  ensurePlansTables(db);
  const row = db.prepare(`SELECT ${PLAN_COLUMNS} FROM plans WHERE task_id = ?`).get(taskId);
  return row ? rowToPlanRecord(db, row as Record<string, unknown>) : undefined;
}

/** All plan records, in stable order: by `drafted_ts` then `task_id` for tie-breaks. */
export function selectAllPlans(db: DatabaseSync): PlanRecord[] {
  ensurePlansTables(db);
  const rows = db.prepare(`SELECT ${PLAN_COLUMNS} FROM plans ORDER BY drafted_ts, task_id`).all();
  return rows.map((r) => rowToPlanRecord(db, r as Record<string, unknown>));
}

function sameDraft(existing: PlanRecord, rec: PlanDrafted): boolean {
  return (
    existing.goal === rec.goal &&
    JSON.stringify(existing.taskCriteria) === JSON.stringify(rec.taskCriteria) &&
    JSON.stringify(
      existing.phases.map((p) => ({
        phaseId: p.phaseId,
        name: p.name,
        owner: p.owner,
        deps: p.deps,
        criteria: p.criteria,
      })),
    ) ===
      JSON.stringify(
        rec.phases.map((p) => ({
          phaseId: p.phaseId,
          name: p.name,
          owner: p.owner,
          deps: p.deps,
          criteria: p.criteria,
        })),
      )
  );
}

interface PreservedPhaseState {
  readonly status: PhaseStatus;
  readonly deps: readonly string[];
  readonly criteria: readonly Criterion[];
  readonly verifiedPass?: boolean;
  readonly baselineSha?: string;
}

function samePhaseVerificationContract(
  preserved: PreservedPhaseState | undefined,
  phase: PhaseNode,
): preserved is PreservedPhaseState {
  return (
    preserved != null &&
    JSON.stringify(preserved.deps) === JSON.stringify(phase.deps) &&
    JSON.stringify(preserved.criteria) === JSON.stringify(phase.criteria)
  );
}

function upsertPhases(
  db: DatabaseSync,
  taskId: string,
  phases: readonly PhaseNode[],
  preservedPhaseState: ReadonlyMap<string, PreservedPhaseState> = new Map(),
): void {
  db.prepare(`DELETE FROM plan_phases WHERE task_id = ?`).run(taskId);
  phases.forEach((phase, ordinal) => {
    const preserved = preservedPhaseState.get(phase.phaseId);
    const preserveState = samePhaseVerificationContract(preserved, phase);
    db.prepare(
      `INSERT INTO plan_phases
       (task_id, phase_id, ordinal, name, owner, deps, criteria, status, verified_pass, baseline_sha)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      taskId,
      phase.phaseId,
      ordinal,
      phase.name,
      phase.owner ?? null,
      JSON.stringify(phase.deps),
      JSON.stringify(phase.criteria),
      preserveState ? preserved.status : 'planned',
      preserveState && preserved.verifiedPass != null ? (preserved.verifiedPass ? 1 : 0) : null,
      preserveState ? preserved.baselineSha ?? null : null,
    );
  });
}

function assertPlanOpenForFold(eventType: string, plan: PlanRecord): void {
  if (plan.completedTs != null) {
    throw new Error(
      `plans: ${eventType} for plan '${plan.taskId}' after task.completed — task.completed is terminal`,
    );
  }
}

interface PlanDraftedEvent extends StoredEvent {
  readonly type: typeof EVENT_PLAN_DRAFTED;
  readonly payload: PlanDrafted;
}
interface PhaseStatusChangedEvent extends StoredEvent {
  readonly type: typeof EVENT_PHASE_STATUS_CHANGED;
  readonly payload: PhaseStatusChanged;
}
interface PhaseVerifiedEvent extends StoredEvent {
  readonly type: typeof EVENT_PHASE_VERIFIED;
  readonly payload: PhaseVerified;
}
interface PlanReplannedEvent extends StoredEvent {
  readonly type: typeof EVENT_PLAN_REPLANNED;
  readonly payload: PlanReplanned;
}
interface TaskCompletedEvent extends StoredEvent {
  readonly type: typeof EVENT_TASK_COMPLETED;
  readonly payload: TaskCompleted;
}
type PlanEvent =
  | PlanDraftedEvent
  | PhaseStatusChangedEvent
  | PhaseVerifiedEvent
  | PlanReplannedEvent
  | TaskCompletedEvent;

/**
 * Folds plan events into the `plans` and `plan_phases` read-model tables. Enforces lifecycle
 * with loud-fail on illegal transitions (Principle 9). `event.ts` is used for all timestamps
 * (never wall-clock — freeze #6).
 */
export class PlansProjector implements Projector {
  readonly name = 'plans';

  handles(type: string): boolean {
    return (
      type === EVENT_PLAN_DRAFTED ||
      type === EVENT_PHASE_STATUS_CHANGED ||
      type === EVENT_PHASE_VERIFIED ||
      type === EVENT_PLAN_REPLANNED ||
      type === EVENT_TASK_COMPLETED
    );
  }

  reset(tx: StoreTx): void {
    const db = tx.raw as DatabaseSync;
    ensurePlansTables(db);
    db.exec('DELETE FROM plan_phases');
    db.exec('DELETE FROM plans');
  }

  apply(tx: StoreTx, event: StoredEvent): void {
    const db = tx.raw as DatabaseSync;
    ensurePlansTables(db);
    const planEvent = event as PlanEvent;
    const type = planEvent.type;
    switch (type) {
      case EVENT_PLAN_DRAFTED: {
        const { taskId, goal, taskCriteria, phases } = planEvent.payload;
        const existing = selectPlan(db, taskId);
        if (existing != null) {
          if (sameDraft(existing, planEvent.payload)) {
            assertPlanOpenForFold('plan.drafted', existing);
            return;
          }
          throw new Error(
            `plans: plan '${taskId}' already exists with different content — refusing conflicting re-draft`,
          );
        }
        db.prepare(
          `INSERT INTO plans (task_id, goal, task_criteria, drafted_ts, replan_count)
           VALUES (?, ?, ?, ?, 0)`,
        ).run(taskId, goal, JSON.stringify(taskCriteria), event.ts);
        upsertPhases(db, taskId, phases);
        return;
      }
      case EVENT_PHASE_STATUS_CHANGED: {
        const { taskId, phaseId, status } = planEvent.payload;
        const existing = selectPlan(db, taskId);
        if (existing == null) {
          throw new Error(
            `plans: phase.status.changed for unknown plan '${taskId}' — draft it first`,
          );
        }
        assertPlanOpenForFold('phase.status.changed', existing);
        const phaseExists = db
          .prepare(`SELECT 1 FROM plan_phases WHERE task_id = ? AND phase_id = ?`)
          .get(taskId, phaseId);
        if (phaseExists == null) {
          throw new Error(
            `plans: phase.status.changed for unknown phaseId '${phaseId}' in plan '${taskId}'`,
          );
        }
        db.prepare(`UPDATE plan_phases SET status = ? WHERE task_id = ? AND phase_id = ?`).run(
          status,
          taskId,
          phaseId,
        );
        return;
      }
      case EVENT_PHASE_VERIFIED: {
        const { taskId, phaseId, baselineSha, pass } = planEvent.payload;
        const existing = selectPlan(db, taskId);
        if (existing == null) {
          throw new Error(`plans: phase.verified for unknown plan '${taskId}' — draft it first`);
        }
        assertPlanOpenForFold('phase.verified', existing);
        const phaseExists = db
          .prepare(`SELECT 1 FROM plan_phases WHERE task_id = ? AND phase_id = ?`)
          .get(taskId, phaseId);
        if (phaseExists == null) {
          throw new Error(
            `plans: phase.verified for unknown phaseId '${phaseId}' in plan '${taskId}'`,
          );
        }
        db.prepare(
          `UPDATE plan_phases SET verified_pass = ?, baseline_sha = ? WHERE task_id = ? AND phase_id = ?`,
        ).run(pass ? 1 : 0, baselineSha, taskId, phaseId);
        return;
      }
      case EVENT_PLAN_REPLANNED: {
        const { taskId, phases } = planEvent.payload;
        const existing = selectPlan(db, taskId);
        if (existing == null) {
          throw new Error(`plans: plan.replanned for unknown plan '${taskId}' — draft it first`);
        }
        assertPlanOpenForFold('plan.replanned', existing);
        db.prepare(`UPDATE plans SET replan_count = replan_count + 1 WHERE task_id = ?`).run(
          taskId,
        );
        const preservedPhaseState = new Map(
          existing.phases.map((phase) => [
            phase.phaseId,
            {
              status: phase.status,
              deps: phase.deps,
              criteria: phase.criteria,
              ...(phase.verifiedPass != null ? { verifiedPass: phase.verifiedPass } : {}),
              ...(phase.baselineSha != null ? { baselineSha: phase.baselineSha } : {}),
            },
          ]),
        );
        upsertPhases(db, taskId, phases, preservedPhaseState);
        return;
      }
      case EVENT_TASK_COMPLETED: {
        const { taskId } = planEvent.payload;
        const existing = selectPlan(db, taskId);
        if (existing == null) {
          throw new Error(`plans: task.completed for unknown plan '${taskId}' — draft it first`);
        }
        if (existing.completedTs != null) {
          return;
        }
        assertPlanReadyToComplete('plans', existing);
        // `event.ts` is the completion mark (freeze #6 — never a wall clock).
        db.prepare(`UPDATE plans SET completed_ts = ? WHERE task_id = ?`).run(event.ts, taskId);
        return;
      }
      default:
        return assertNever(type);
    }
  }
}
