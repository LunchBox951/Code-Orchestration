/**
 * Stage 9 P6 (L8-OBS) — Observability rollup. A unified snapshot of the four key operational
 * dimensions, assembled from the existing read-models (NO new event types — pure projections):
 *
 *   - roster / states    — selectAllAgents (roster projector)
 *   - phase status       — selectAllPlans (plans projector, includes phase status per plan)
 *   - review status      — all reviews table rows (review projector)
 *   - cost               — selectAllCostRollups (cost projector)
 *
 * Operator-only: NOT an agent MCP tool. No ToolSpec is registered here; the completeness gate
 * stays green by construction. The P7 CLI renders this snapshot for the operator.
 */
import type { DatabaseSync } from 'node:sqlite';
import { openProjectStore } from '../store/sqlite-store.js';
import { selectAllAgents } from '../roles/roster-projector.js';
import { selectAllPlans } from '../plans/plans-projector.js';
import { selectAllCostRollups } from '../dispatch/cost-projector.js';
import { ensureReviewTables } from '../review/review-projector.js';
import type { AgentRecord } from '../roles/events.js';
import type { PlanRecord } from '../plans/events.js';
import type { CostRollup } from '../dispatch/events.js';
import type { ReviewScope } from '../review/ladder.js';
import type { Verdict } from '../review/verdict.js';

// ─── Review summary ───────────────────────────────────────────────────────────

/**
 * A lightweight summary of one review row — enough for the operator dashboard without
 * materializing the full {@link ReviewVerdictRecord} (which requires full JSON parsing
 * of blockers/suggestions/verification). Pure read from the reviews projection table.
 */
export interface ReviewSummary {
  readonly target: string;
  readonly branch: string;
  readonly scope: ReviewScope;
  readonly verdict: Verdict | undefined;
  readonly strikes: number;
  readonly serialized: boolean;
  readonly overridden: boolean;
}

function rowToReviewSummary(row: Record<string, unknown>): ReviewSummary {
  return {
    target: String(row.target),
    branch: String(row.branch),
    scope: (row.scope != null ? String(row.scope) : 'worker_merge') as ReviewScope,
    verdict: row.verdict != null ? (String(row.verdict) as Verdict) : undefined,
    strikes: Number(row.strikes ?? 0),
    serialized: Boolean(row.serialized),
    overridden: Boolean(row.overridden),
  };
}

/** All review rows in the projection table, in a deterministic order (target, branch). */
function selectAllReviews(db: DatabaseSync): ReviewSummary[] {
  ensureReviewTables(db);
  const rows = db
    .prepare(
      'SELECT target, branch, scope, verdict, strikes, serialized, overridden ' +
        'FROM reviews ORDER BY target, branch',
    )
    .all();
  return rows.map((r) => rowToReviewSummary(r as Record<string, unknown>));
}

// ─── Snapshot type ────────────────────────────────────────────────────────────

/**
 * A point-in-time observability snapshot over the four operational dimensions.
 * Every field is a pure read-model read — no writes, no events, no I/O beyond the store.
 */
export interface ObservabilitySnapshot {
  /** All registered agents with their role, sub-role, and parent (roster projector). */
  readonly agents: readonly AgentRecord[];
  /** All plan records including per-phase status (plans projector). */
  readonly plans: readonly PlanRecord[];
  /** All review lifecycle rows (review projector). */
  readonly reviews: readonly ReviewSummary[];
  /** All per-agent and per-task cost rollup totals (cost projector). */
  readonly costRollups: readonly CostRollup[];
}

// ─── Public query ─────────────────────────────────────────────────────────────

/**
 * Query the unified observability snapshot for `projectId`. Pure read-model reads — no writes,
 * no event appends, no decode/replay. Opens and immediately closes the project store.
 */
export function queryObservability(projectId: string): ObservabilitySnapshot {
  const store = openProjectStore(projectId);
  try {
    return store.transaction((tx) => {
      const db = tx.raw as DatabaseSync;
      return {
        agents: selectAllAgents(db),
        plans: selectAllPlans(db),
        reviews: selectAllReviews(db),
        costRollups: selectAllCostRollups(db),
      };
    });
  } finally {
    store.close();
  }
}
