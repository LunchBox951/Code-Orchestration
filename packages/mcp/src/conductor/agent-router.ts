/**
 * Stage 10 P3 (CTL-OBS · §3a) — the DAEMON-BACKED `AgentRouterSeam`: the real, live-agent
 * implementation of the operator control verbs that the CLI's `HOST_LIVE_ROUTER` only THREW for.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 * THE FINDING THIS CURES (Stage 9): `unstick`/`pause`/`stop` were typed seams that, with no Conductor
 * running, threw `[host-live]` — they never acted on a live agent. This class wires them to the running
 * {@link ConductorEngine} + a small in-memory control-state tracker, so in the daemon process they
 * actually kill/release a pane, pause selection, and re-wake a STUCK agent. Stage 11's operator-IPC
 * binding drives this transport-agnostic API from the desktop app.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * The verbs need COMPOSITION (there is no 1:1 engine method):
 *   - `stop`        → `engine.release` the warm pane (kills + tears down; no further turns);
 *                     fail-loud-tolerant.
 *   - `pause`       → record in the PAUSED set; the daemon's candidate filter ({@link shouldSkip}) skips it.
 *   - `revertStuck` → clear the STUCK set (the inverse of {@link markStuck}); the agent is eligible again.
 *   - `rewake`      → clear any remaining STUCK skip so the next daemon tick re-selects it (no queue —
 *                     the daemon re-reads the live set each tick).
 *   - plus operator `steer` (NOT part of the void seam) → delegate to {@link ConductorEngine.steer}.
 *
 * This class is project-scoped (one per `co-mcp serve` project). It registers ZERO agent MCP tools — it is a
 * class of OPERATOR methods, never agent-callable (Principle 4 + D4). The STUCK set is the host-side
 * `markStuck`/`revertStuck` owner: `serveConductor` wires {@link markStuck} into the `ReconcileLoop`.
 */
import { type AgentRouterSeam, type ProjectId, type Steer } from '@co/core';
import type { ConductorEngine } from './engine.js';

/** Constructor seams for {@link DaemonBackedAgentRouter}. */
export interface DaemonBackedAgentRouterDeps {
  /** The running engine the verbs act on (warm-pane lookup, release, steer). */
  readonly engine: ConductorEngine;
  /** The project this router controls. The void seam verbs key by `agentId` within this project. */
  readonly projectId: ProjectId;
  /**
   * Surface a `stop` applied to an agent with NO warm pane (nothing to kill). Recorded — never a silent
   * multi-hour reap (Principle 9): the stop is still tracked, the operator is informed. Default: none.
   */
  readonly onStopUnhosted?: (agentId: string) => void;
  /**
   * Surface a failure in the async pane-release that follows a `stop` (pane kill or MCP-session
   * teardown). Best-effort diagnostic callbacks must not prevent teardown. Default: none.
   */
  readonly onStopError?: (agentId: string, error: unknown) => void;
}

/**
 * The live, daemon-backed {@link AgentRouterSeam}. Holds three in-memory sets — PAUSED (operator), STUCK
 * (watchdog), STOPPED (operator) — and composes the engine primitives to act on warm panes. The
 * {@link AgentRouterSeam} verbs are sync + `void` (the seam's contract); the richer operator surface
 * ({@link resume}, {@link steer}, {@link markStuck}) is added as sibling methods.
 */
export class DaemonBackedAgentRouter implements AgentRouterSeam {
  private readonly engine: ConductorEngine;
  private readonly projectId: ProjectId;
  private readonly onStopUnhosted: ((agentId: string) => void) | undefined;
  private readonly onStopError: ((agentId: string, error: unknown) => void) | undefined;
  /** Agents the operator PAUSED — the daemon SKIPS these when selecting candidates (§3c). */
  private readonly paused = new Set<string>();
  /** Agents the watchdog escalated to STUCK — also skipped, until `revertStuck`/`rewake`. */
  private readonly stuck = new Set<string>();
  /** Agents the operator STOPPED — recorded so a not-hosted stop is never a silent no-op. */
  private readonly stopped = new Set<string>();
  /** In-flight async stop teardowns (pane release) — awaitable via {@link drain} for deterministic shutdown/tests. */
  private readonly pending = new Set<Promise<void>>();

  constructor(deps: DaemonBackedAgentRouterDeps) {
    this.engine = deps.engine;
    this.projectId = deps.projectId;
    this.onStopUnhosted = deps.onStopUnhosted;
    this.onStopError = deps.onStopError;
  }

  // ── AgentRouterSeam — the core seam (sync, void) ───────────────────────────────────────────────

  /** Revert the STUCK flip (the inverse of {@link markStuck}). After this the agent is eligible again. */
  revertStuck(agentId: string): void {
    this.stuck.delete(agentId);
  }

  /**
   * Re-wake: clear any STUCK skip so the next daemon tick re-selects this agent if it has outstanding
   * actionable mail. There is no separate wake queue — the daemon re-reads the live set every tick, so
   * "re-wake" is simply "stop filtering it out". Defensive: clears STUCK even if `revertStuck` ran first
   * (idempotent), curing the stalled-`unstick` multi-hour-reap (MNR #4) — never a silent no-op.
   */
  rewake(agentId: string): void {
    this.stuck.delete(agentId);
  }

  /** Pause: record the agent so the daemon SKIPS it when building candidates (§3c). Undo with {@link resume}. */
  pause(agentId: string): void {
    this.paused.add(agentId);
  }

  /**
   * Stop: release the agent's warm pane — the agent receives no further turns.
   * FAIL-LOUD-TOLERANT: an agent with no warm pane is RECORDED (and surfaced via {@link onStopUnhosted}),
   * never silently reaped and never a throw (an operator stop must not crash the daemon). Idempotent;
   * a stopped agent is also cleared from the paused/stuck skip sets. `engine.release` removes the warm-pane
   * ledger SYNCHRONOUSLY (before its first `await`), so {@link ConductorEngine.isHosted} flips false the
   * instant this returns; the awaited tail is just the MCP-session teardown, tracked for {@link drain}.
   */
  stop(agentId: string): void {
    this.stopped.add(agentId);
    this.paused.delete(agentId);
    this.stuck.delete(agentId);
    const hosted = this.engine.getHosted(this.projectId, agentId);
    if (hosted == null) {
      this.reportStopUnhosted(agentId);
      return;
    }
    const p = this.engine
      .release(this.projectId, agentId, {
        onPaneKillError: (error) => this.reportStopError(agentId, error),
      })
      .catch((error) => this.reportStopError(agentId, error))
      .finally(() => {
        this.pending.delete(p);
      });
    this.pending.add(p);
  }

  // ── Operator-control surface — NOT part of AgentRouterSeam ──────────────────────────────────────

  /** Resume a paused agent — the daemon drives it again next tick. (The pause/resume counterpart.) */
  resume(agentId: string): void {
    this.paused.delete(agentId);
  }

  /**
   * The host-side `markStuck` owner: flip an agent into STUCK. `serveConductor` wires this into the
   * {@link import('@co/core').ReconcileLoop}'s `markStuck` seam, so a watchdog escalation lands here and
   * the daemon then SKIPS the agent until {@link revertStuck}/{@link rewake} (what `unstick` calls).
   */
  markStuck(agentId: string): void {
    this.stuck.add(agentId);
  }

  /**
   * Operator STEER of a warm pane mid-turn (SF-2). Delegates to {@link ConductorEngine.steer}, which
   * injects into the warm pane WITHOUT teardown and throws fail-loud (Principle 9) if the agent is not
   * hosted (steering never spawns or relaunches). Async — unlike the void seam verbs.
   */
  async steer(agentId: string, steer: Steer): Promise<void> {
    await this.engine.steer(this.projectId, agentId, steer);
  }

  // ── The daemon candidate-skip predicate (§3c) + observability accessors ─────────────────────────

  /**
   * The daemon's candidate-skip predicate: skip an agent iff it belongs to this router's project AND is
   * PAUSED, STUCK, or STOPPED. Wired as {@link import('./daemon.js').ConductorDaemonDeps.isSkipped}.
   * Project-scoped by construction; the `projectId` argument is checked so a foreign project's agents are
   * never skipped.
   */
  shouldSkip(projectId: ProjectId, agentId: string): boolean {
    return (
      projectId === this.projectId &&
      (this.paused.has(agentId) || this.stuck.has(agentId) || this.stopped.has(agentId))
    );
  }

  /** Whether `agentId` is currently paused (for the live-observe overlay + tests). */
  isPaused(agentId: string): boolean {
    return this.paused.has(agentId);
  }

  /** Whether `agentId` is currently STUCK (for the live-observe overlay + tests). */
  isStuck(agentId: string): boolean {
    return this.stuck.has(agentId);
  }

  /** Whether `agentId` has been stopped (recorded even when it had no warm pane). */
  isStopped(agentId: string): boolean {
    return this.stopped.has(agentId);
  }

  /** Await every in-flight async stop teardown — for deterministic shutdown and tests. */
  async drain(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  private reportStopError(agentId: string, error: unknown): void {
    try {
      this.onStopError?.(agentId, error);
    } catch {
      /* diagnostic callback failed; teardown must still complete */
    }
  }

  private reportStopUnhosted(agentId: string): void {
    try {
      this.onStopUnhosted?.(agentId);
    } catch {
      /* diagnostic callback failed; stop is still recorded */
    }
  }
}
