/**
 * L7-LOOP (Stage 10 · P1) — the Conductor DAEMON: the motor that turns the box of landed L7/L8
 * components into a running `co`.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 * THE FINDING THIS CURES (Stage 9): every Conductor *component* landed as a tested unit — the engine
 * ({@link ConductorEngine}: `runCycle`/`ensureHosted`/`runOneTurn`/`steer`/`tickClarifyTimeouts`),
 * the watchdog-reconcile loop ({@link ReconcileLoop}), and holistic recovery (`recoverProjectStore`)
 * — but NOTHING composed them into a running process. There was no daemon, no loop, no caller. This
 * module is that motor: a deterministic run-loop that, each {@link ConductorDaemon.tick}, reconstructs
 * the live set from recovered state, drives ≤1 engine turn, and on a configurable cadence runs the
 * clarify-timeout tick + the watchdog-reconcile sweep.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * SEAM-INJECTED + DETERMINISTIC (AC-S10-1), exactly like the components it drives: every external
 * dependency enters as a constructor seam, and there is NO wall clock in the testable path. `now()` is
 * injected DATA (the deterministic log-ordering mark for each tick outcome — never `Date.now()`); the
 * engine and the reconcile loop carry their OWN injected clocks. Same injected `now()` sequence + same
 * FakePty script ⇒ same sequence of tick outcomes. The real `setInterval` cadence + real `NodePtyHost`
 * panes are the `[host-live]` glue (see `host.ts`), never in this testable path.
 *
 * RECOVERY MODEL (P1 scope). `tick()` reads the RUNNING set (`selectAllSessions` — sessions with a
 * `session.created` and no `session.ended`) and joins it to the roster (`selectAllAgents`) to rebuild
 * each {@link HostedIdentity}. Sessions are MINTED at spawn time (P2 spawn-from-placement), not here —
 * the daemon DRIVES already-hosted agents: a warm agent (the engine hosted it this run) is reused with
 * no relaunch (single launch authority, MNR-5). Re-LAUNCHING a crashed provider into a fresh pane
 * (cold-restart re-dispatch) is the `[host-live]` / L8-LIVE operator handoff; the daemon reconstructs
 * the recovered live set so that handoff has its inputs, but never relaunches a real binary in-sandbox.
 *
 * REGISTERS ZERO AGENT MCP TOOLS (Principle 4 + D4 — the Conductor is never agent-callable). It is a
 * class, not a tool. The running {@link ConductorDaemon.engine} and {@link ConductorDaemon.reconcile}
 * are exposed as public members so P3's operator control/observe surface can build ON the loop — the
 * engine is never hidden behind it.
 */
import {
  openRosterStore,
  openSessionStore,
  recoverProjectStore,
  type AgentRecord,
  type DeliveredMail,
  type ProjectId,
  type ReconcileLoop,
  type ReconcileTickResult,
  type RosterStore,
  type SessionRecord,
  type SessionStore,
} from '@co/core';
import type { ConductorEngine, CycleOutcome } from './engine.js';
import type { HostedIdentity } from '../live-session-host.js';

/**
 * The daemon's constructor seams. Required seams (`engine`, `reconcile`, `projectId`, `now`,
 * `reconcileEvery`) have no default so the determinism boundary stays explicit; the recovery + store
 * openers default to the real `@co/core` functions (a test injects fixtures / spies).
 */
export interface ConductorDaemonDeps {
  /**
   * The running engine — the single-turn cycle + MNR-5 launch authority. Exposed publicly on the
   * daemon so P3 builds its control/observe surface on top (never hidden behind the loop).
   */
  readonly engine: ConductorEngine;
  /**
   * The watchdog-reconcile loop. Its seams (`runningAgents`/`livenessInputFor`/`now`/`onBreak`/
   * `markStuck`) are wired by the constructor of this daemon (host-side: the recovered RUNNING set +
   * hosted-pane trace + `kill(pid,0)`; sandbox: synthesized). The daemon only drives `tick()` on
   * cadence — the bounded silent-stop escalation (detect → nudge → STUCK) lives in the loop itself.
   */
  readonly reconcile: ReconcileLoop;
  /** The project whose live set this daemon drives. */
  readonly projectId: ProjectId;
  /**
   * Monotonic ms source — the `observedAt` stamped on each {@link DaemonTickOutcome} for deterministic
   * host-log ordering. DATA, never a wall clock (a real `Date.now()` would break replay). REQUIRED so a
   * real clock can never sneak into the testable path; the cadence itself is a TICK COUNTER, not time.
   */
  readonly now: () => number;
  /**
   * The reconcile/clarify cadence: every Nth tick fires `tickClarifyTimeouts` + `reconcile.tick()`.
   * `1` ⇒ every tick. Must be a positive integer (fails loud otherwise — Principle 9).
   */
  readonly reconcileEvery: number;
  /** Holistic recovery on start. Default: {@link recoverProjectStore} (rebuild every read-model). */
  readonly recover?: (projectId: ProjectId) => void;
  /** Opens the durable session store for the RUNNING set. Default: {@link openSessionStore}. */
  readonly openSessions?: (projectId: ProjectId) => SessionStore;
  /** Opens the roster store to join role/sub-role/parent onto each session. Default: {@link openRosterStore}. */
  readonly openRoster?: (projectId: ProjectId) => RosterStore;
  /**
   * Stage 10 P3 (§3c) — the OPERATOR-CONTROL candidate-skip predicate. Consulted when the daemon builds
   * its candidate set; an agent for which this returns `true` is FILTERED OUT (not driven this tick). The
   * daemon-backed router wires its paused ∪ stuck sets here (so `pause` actually takes effect and an
   * `unstick`'d agent is driven again). ADDITIVE: the default never skips, so P1's loop is byte-for-byte
   * unchanged when no router is wired. (Spec's illustrative name was `isPaused`; it also gates STUCK, so
   * the accurate name is `isSkipped`.)
   */
  readonly isSkipped?: (projectId: ProjectId, agent: string) => boolean;
}

/**
 * The outcome of ONE deterministic {@link ConductorDaemon.tick} — a small structured record for tests
 * and host logging. Carries the rich {@link CycleOutcome} (for P3 / host inspection) plus scalar
 * mirrors (`selected`, `cadenceFired`) that are replay-stable for determinism assertions.
 */
export interface DaemonTickOutcome {
  /** The injected-time mark for this tick (deterministic ordering; never a wall clock). */
  readonly observedAt: number;
  /** 1-based tick counter (the cadence is `tick % reconcileEvery === 0`). */
  readonly tick: number;
  /** Size of the reconstructed live set (candidates) this tick. */
  readonly candidateCount: number;
  /** The engine's ≤1-turn outcome, or `null` when no candidate was eligible. */
  readonly cycle: CycleOutcome | null;
  /** The agent the engine selected + drove this tick, or `null` when none was eligible. */
  readonly selected: string | null;
  /** True iff this was a cadence tick (clarify-timeout + reconcile sweep both ran). */
  readonly cadenceFired: boolean;
  /** The clarify-timeouts forwarded this tick (empty unless `cadenceFired`). */
  readonly clarifyForwarded: readonly DeliveredMail[];
  /** The reconcile sweep result, or `null` unless `cadenceFired`. */
  readonly reconcile: ReconcileTickResult | null;
}

/**
 * The Conductor daemon. Drives the engine + reconcile loop in a deterministic, seam-injected loop.
 * Stateful only in its tick counter; the warm panes live in the engine, the per-agent watchdogs in the
 * reconcile loop. NOT a tool and NOT agent-callable (Principle D4).
 */
export class ConductorDaemon {
  /** The running engine — exposed so P3 builds the operator control/observe surface on top of it. */
  readonly engine: ConductorEngine;
  /** The watchdog-reconcile loop — exposed for host introspection (e.g. `reconcile.tracked`). */
  readonly reconcile: ReconcileLoop;
  readonly projectId: ProjectId;
  private readonly now: () => number;
  private readonly reconcileEvery: number;
  private readonly recoverFn: (projectId: ProjectId) => void;
  private readonly openSessions: (projectId: ProjectId) => SessionStore;
  private readonly openRoster: (projectId: ProjectId) => RosterStore;
  private readonly isSkipped: (projectId: ProjectId, agent: string) => boolean;
  private tickCount = 0;
  private recovered = false;

  constructor(deps: ConductorDaemonDeps) {
    if (!Number.isInteger(deps.reconcileEvery) || deps.reconcileEvery < 1) {
      throw new Error(
        `ConductorDaemon: reconcileEvery must be a positive integer, got ${deps.reconcileEvery} ` +
          '(the reconcile/clarify cadence is "every Nth tick"; Principle 9 — fail loud).',
      );
    }
    this.engine = deps.engine;
    this.reconcile = deps.reconcile;
    this.projectId = deps.projectId;
    this.now = deps.now;
    this.reconcileEvery = deps.reconcileEvery;
    this.recoverFn = deps.recover ?? recoverProjectStore;
    this.openSessions = deps.openSessions ?? openSessionStore;
    this.openRoster = deps.openRoster ?? openRosterStore;
    this.isSkipped = deps.isSkipped ?? (() => false);
  }

  /** How many ticks have run (for host introspection / tests). */
  get ticks(): number {
    return this.tickCount;
  }

  /**
   * Recover on start (AC-S10-1, step 1): rebuild every read-model from the event log alone
   * ({@link recoverProjectStore} — no repo dependency, byte-equal to pre-crash), then reconstruct the
   * live set and return it. Idempotent-guarded so a host that calls `recover()` then `tick()` recovers
   * exactly once. Returns the reconstructed live set (the recovered {@link HostedIdentity}s) so the
   * host (and the AC test) can observe what the daemon will drive.
   */
  recover(): readonly HostedIdentity[] {
    this.recoverFn(this.projectId);
    this.recovered = true;
    return this.buildCandidates();
  }

  /**
   * Reconstruct the live set: read the RUNNING sessions (the `sessions` read-model holds exactly the
   * not-yet-ended sessions — `session.ended` deletes the row) and join them by `agentId` to the roster
   * to fill `role/subRole/parent`, yielding one {@link HostedIdentity} per running agent. Uses the
   * typed `@co/core` store facades (the adapter never opens the store / `node:sqlite` directly —
   * AC-L2-1 layering); each facade is a pure read-model read (no writes, no event appends).
   *
   * A session with no roster record is a corrupt/partial recovered state — FAIL LOUD (Principle 9),
   * never silently drop it (a dropped agent would never be driven again). The engine's `selectEligible`
   * does the "WAITING + outstanding actionable" filtering; the daemon just supplies the full live set,
   * MINUS any agent the operator-control surface suppresses ({@link ConductorDaemonDeps.isSkipped} — a
   * paused or STUCK agent; §3c). Filtering a suppressed agent out of candidates is what makes `pause`
   * actually take effect (not a silent no-op) and lets `unstick` re-drive a reverted agent next tick.
   */
  buildCandidates(): readonly HostedIdentity[] {
    const sessions = this.openSessions(this.projectId);
    try {
      const roster = this.openRoster(this.projectId);
      try {
        const byId = new Map<string, AgentRecord>(roster.listAgents().map((a) => [a.agentId, a]));
        return sessions
          .listSessions()
          .map((session) => this.toIdentity(session, byId))
          .filter((identity) => !this.isSkipped(this.projectId, identity.agent));
      } finally {
        roster.close();
      }
    } finally {
      sessions.close();
    }
  }

  /** Join one running {@link SessionRecord} to its roster record into a {@link HostedIdentity}. */
  private toIdentity(
    session: SessionRecord,
    roster: ReadonlyMap<string, AgentRecord>,
  ): HostedIdentity {
    const agent = roster.get(session.agentId);
    if (agent == null) {
      throw new Error(
        `ConductorDaemon: running session for agent '${session.agentId}' has no roster record in ` +
          `project '${this.projectId}' — corrupt/partial recovered state. Refusing to drop it ` +
          '(Principle 9 — fail loud, never silently drop a live agent).',
      );
    }
    return {
      agent: session.agentId,
      role: agent.role,
      ...(agent.subRole != null ? { subRole: agent.subRole } : {}),
      parent: agent.parent,
      pane: session.pane,
      projectId: this.projectId,
      cwd: session.cwd,
      provider: session.provider,
      resume: session.resume,
    };
  }

  /**
   * One deterministic tick (the unit tests drive). In order (AC-S10-1, steps 2–3):
   *   1. reconstruct the live set ({@link buildCandidates});
   *   2. `engine.runCycle(candidates)` — select a WAITING+actionable agent, ensure its pane (warm
   *      reuse else launch), inject, drive EXACTLY ONE turn, yield (the pane stays warm);
   *   3. on cadence (every `reconcileEvery` ticks): `engine.tickClarifyTimeouts(candidates)` AND
   *      `reconcile.tick()` — the deferred clarify-timeout forward + the bounded silent-stop sweep.
   *
   * Recovery runs lazily on the first tick if `recover()` was not called explicitly. Returns the
   * structured {@link DaemonTickOutcome}. The engine never treats `runCycle`'s idle/turn-end as "done"
   * — completion stays keyed to `co_finish`/`worker_done`; the reconcile sweep is what catches an agent
   * that went idle WITHOUT signalling completion (the canonical silent-stop bug).
   */
  async tick(): Promise<DaemonTickOutcome> {
    if (!this.recovered) this.recover();
    this.tickCount += 1;
    const observedAt = this.now();

    const candidates = this.buildCandidates();
    const cycle = await this.engine.runCycle(candidates);

    const cadenceFired = this.tickCount % this.reconcileEvery === 0;
    let clarifyForwarded: readonly DeliveredMail[] = [];
    let reconcile: ReconcileTickResult | null = null;
    if (cadenceFired) {
      clarifyForwarded = await this.engine.tickClarifyTimeouts(candidates);
      reconcile = await this.reconcile.tick();
    }

    return {
      observedAt,
      tick: this.tickCount,
      candidateCount: candidates.length,
      cycle,
      selected: cycle?.hosted.identity.agent ?? null,
      cadenceFired,
      clarifyForwarded,
      reconcile,
    };
  }
}
