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

// ─── Live overlay (Stage 10 P3 — CTL-OBS) ───────────────────────────────────────
//
// The STATIC snapshot above is pure read-model — the cross-process CLI can read it NOW. The LIVE
// half below is the part ONLY the running engine can answer ("who is warm right now / paused / stuck /
// stopped") — so it enters as an injected {@link LiveStateProvider} seam, filled by `@co/mcp` in the
// daemon process. The merge ({@link queryLiveObservability}) lives HERE (transport-agnostic,
// cli-callable) so the same logic serves the in-process daemon today and the deferred cross-process IPC
// binding later.

/**
 * The per-agent LIVE overlay — the slice of an agent's state that ONLY the running engine knows. The
 * static read-models hold roster/cost; they cannot say which agent currently has a WARM pane, nor the
 * operator-control state (paused / stuck / stopped). One {@link LiveStateProvider} fills these in the daemon
 * process; a pure-static read leaves them at their cold defaults.
 */
export interface LiveAgentState {
  /** The agent this overlay describes (joins to {@link AgentRecord.agentId}). */
  readonly agentId: string;
  /** True iff the engine currently HOSTS a warm pane for this agent (warm vs cold). */
  readonly hosted: boolean;
  /** The agent's outstanding actionable (unresolved) mail count — what would drive its next turn. */
  readonly outstandingMail: number;
  /** True iff the operator-control surface has PAUSED this agent (the daemon skips it). */
  readonly paused: boolean;
  /** True iff the watchdog has escalated this agent to STUCK (awaiting `unstick`/`revertStuck`). */
  readonly stuck: boolean;
  /** True iff the operator stopped this agent; it is suppressed until Re-wake clears stopped state. */
  readonly stopped: boolean;
}

/**
 * The seam that fills the LIVE half of observability. ONLY the running engine (+ its control surface)
 * can answer "which agents are warm / paused / stuck / stopped right now", so `@co/mcp` injects this in-process;
 * the cross-process CLI cannot fill it (deferred IPC) and reads the pure-static {@link queryObservability}
 * instead. Transport-agnostic: a plain interface, no I/O or wire shape.
 */
export interface LiveStateProvider {
  /**
   * The live overlay for the given roster agents — one entry per requested `agentId`, in order. The
   * merge supplies the FULL roster (not just the warm set), so even a COLD agent (no warm pane) still
   * reports its outstanding-mail count.
   */
  liveStates(agentIds: readonly string[]): readonly LiveAgentState[];
}

/** A roster agent joined with its live overlay + cost rollup — one per-agent row of a live snapshot. */
export interface AgentLiveView {
  readonly agentId: string;
  /** Operator-provided display name, when one was recorded in the roster. */
  readonly name?: string;
  readonly role: AgentRecord['role'];
  /** Present only when the roster records a sub-role (exactOptionalPropertyTypes-safe). */
  readonly subRole?: AgentRecord['subRole'];
  readonly parent: string;
  /** Warm (engine-hosted) vs cold. */
  readonly hosted: boolean;
  /** Outstanding actionable (unresolved) mail count. */
  readonly outstandingMail: number;
  readonly paused: boolean;
  readonly stuck: boolean;
  readonly stopped: boolean;
  /** This agent's cost rollup total in USD, or 0 when none is recorded. */
  readonly costUsd: number;
}

/**
 * A LIVE observability snapshot: the full static rollup PLUS a per-agent live overlay. Distinguishable
 * from a pure {@link ObservabilitySnapshot} by the `agents` live views (hosted / paused / stuck /
 * stopped / outstanding) — the part that needs the running engine. Built by {@link queryLiveObservability} in the
 * daemon process; the deferred cross-process IPC binding will ship this same shape to the CLI/app.
 */
export interface LiveObservabilitySnapshot {
  /** The pure-static rollup (roster / plans / reviews / cost) — exactly what the CLI reads cross-process. */
  readonly snapshot: ObservabilitySnapshot;
  /** The per-agent live overlay merged onto the roster (the live half — engine-filled). */
  readonly agents: readonly AgentLiveView[];
}

/**
 * Query the LIVE observability snapshot for `projectId`: the static rollup ({@link queryObservability})
 * MERGED with the engine-filled {@link LiveStateProvider} overlay. Pure composition — the only I/O is
 * the static read inside `queryObservability` and whatever the injected provider reads; this function
 * adds none. Roster is authoritative for identity (every hosted agent has a roster record), so the merge
 * iterates the roster and joins each agent's live overlay + its `kind: 'agent'` cost rollup.
 */
export function queryLiveObservability(
  projectId: string,
  live: LiveStateProvider,
): LiveObservabilitySnapshot {
  const snapshot = queryObservability(projectId);
  const overlay = live.liveStates(snapshot.agents.map((a) => a.agentId));
  const byId = new Map(overlay.map((s) => [s.agentId, s]));
  const costByAgent = new Map(
    snapshot.costRollups.filter((c) => c.kind === 'agent').map((c) => [c.id, c.totalCostUsd]),
  );
  const agents: AgentLiveView[] = snapshot.agents.map((a) => {
    const l = byId.get(a.agentId);
    return {
      agentId: a.agentId,
      ...(a.name != null ? { name: a.name } : {}),
      role: a.role,
      ...(a.subRole != null ? { subRole: a.subRole } : {}),
      parent: a.parent,
      hosted: l?.hosted ?? false,
      outstandingMail: l?.outstandingMail ?? 0,
      paused: l?.paused ?? false,
      stuck: l?.stuck ?? false,
      stopped: l?.stopped ?? false,
      costUsd: costByAgent.get(a.agentId) ?? 0,
    };
  });
  return { snapshot, agents };
}
