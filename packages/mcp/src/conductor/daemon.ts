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
  OPERATOR,
  openRosterStore,
  openSessionStore,
  openWorktreeStore,
  recoverProjectStore,
  type AgentRecord,
  type DeliveredMail,
  type ProjectId,
  type ReconcileLoop,
  type ReconcileTickResult,
  type RosterStore,
  type SessionRecord,
  type SessionStore,
  type WorktreeStore,
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
   * Stage 14 P1 — opens the worktree store to resolve a cold-start ROOT coordinator's provisioned cwd
   * (the start primitive recorded the worktree keyed to the root's agent id). Default: {@link openWorktreeStore}.
   */
  readonly openWorktrees?: (projectId: ProjectId) => WorktreeStore;
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
  /**
   * Stage 14 P1 — root coordinators COLD-STARTED this tick: a registered-but-unhosted root
   * (`coordinator` / parent `@operator`) the daemon launched (minting its session) so it becomes
   * drivable. Empty on every tick that launches no root (the common case).
   */
  readonly coldStarted: readonly string[];
  /**
   * Stage 15 P-E (AC-S15-2 / ST-2) — cold recovered NON-root agents RE-WARMED this tick: agents whose
   * recovered session was COLD in this engine process and that the daemon drove back through the single
   * launch authority ({@link ConductorEngine.ensureHosted}). Symmetric to {@link coldStarted} (which is
   * roots); each id appears at most ONCE across the daemon's lifetime (a warm agent is never re-warmed).
   * Empty on every tick that re-warms nothing (the common case once the recovered set is warm).
   */
  readonly reWarmed: readonly string[];
  /**
   * Recovered RUNNING sessions STILL cold in this engine process after this tick's re-warm — therefore
   * not driven. Post-{@link reWarmed}: a re-warmed non-root agent has left this set (it is now warm); a
   * recovered ROOT-with-session remains here (re-warm is non-root — root handling is the cold-start
   * path's, unchanged).
   */
  readonly coldCandidates: readonly string[];
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
  private readonly openWorktrees: (projectId: ProjectId) => WorktreeStore;
  private readonly isSkipped: (projectId: ProjectId, agent: string) => boolean;
  private tickCount = 0;
  private recovered = false;
  /**
   * Stage 15 (review-375 GUARD) — recovered NON-root agents whose per-tick re-warm via the single launch
   * authority THREW (`ensureHosted → hostSession → recordSession` refuses a recovered agent that still
   * owns its durable session row: "already has an active session"). Tracked so the daemon attempts each
   * at most ONCE and never churns a pane every tick. In-memory only — a fresh daemon legitimately
   * re-attempts once; deterministic (no wall clock).
   */
  private readonly reWarmFailed = new Set<string>();

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
    this.openWorktrees = deps.openWorktrees ?? openWorktreeStore;
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
   * One deterministic tick (the unit tests drive). In order (AC-S10-1 steps 2–3, + AC-S14-1 step 0):
   *   0. ROOT COLD-START ({@link coldStartRootCoordinators}): discover a registered-but-unhosted ROOT
   *      coordinator (the start primitive registered it + provisioned its worktree but minted NO
   *      session) and LAUNCH it via the engine's single launch authority — which MINTS its session, so
   *      the rebuilt live set below includes it and `runCycle` drives its FIRST turn THIS tick;
   *   1. reconstruct the live set ({@link buildCandidates});
   *   1a. RE-WARM ({@link reWarmRecoveredAgents}, Stage 15 P-E / AC-S15-2): drive every COLD recovered
   *      NON-root agent back through the SAME single launch authority — generalizing step 0's cold-start
   *      to the recovered non-root set — so a re-warmed agent joins `drivable` and can take its first
   *      turn THIS tick;
   *   2. `engine.runCycle(drivable)` — select a WAITING+actionable WARM agent, reuse its pane,
   *      inject, drive EXACTLY ONE turn, yield (the pane stays warm);
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

    // Step 0 (AC-S14-1): cold-start any registered-but-unhosted ROOT coordinator BEFORE building the
    // candidate set, so a freshly-started root (no session yet) is hosted + minted in time to be
    // selected + driven THIS tick. GATED to the root — a recovered child session is never cold-launched.
    const coldStarted = await this.coldStartRootCoordinators();

    const candidates = this.buildCandidates();
    // Step 1a (AC-S15-2 / ST-2): RE-WARM the cold recovered NON-root agents through the SAME single
    // launch authority (engine.ensureHosted) BEFORE building `drivable`, so a re-warmed agent joins it
    // THIS tick — mirroring step 0's root cold-start. Selection only (the real binary relaunch stays
    // host glue); the isHosted gate + ensureHosted's MNR-5 throw + the sequential await re-warm a cold
    // agent AT MOST ONCE.
    const reWarmed = await this.reWarmRecoveredAgents(candidates);

    // Recovered sessions are durable inputs, not launch authority. A fresh daemon can reconstruct them
    // for reconcile/reattach handoff; panes warm in THIS engine process (INCLUDING any just re-warmed
    // above) are drivable. What stays cold is a recovered ROOT-with-session (re-warm is non-root).
    const drivable = candidates.filter((identity) =>
      this.engine.isHosted(identity.projectId, identity.agent),
    );
    const coldCandidates = candidates
      .filter((identity) => !this.engine.isHosted(identity.projectId, identity.agent))
      .map((identity) => identity.agent);
    const cycle = await this.engine.runCycle(drivable);

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
      coldStarted,
      reWarmed,
      coldCandidates,
      cycle,
      selected: cycle?.hosted.identity.agent ?? null,
      cadenceFired,
      clarifyForwarded,
      reconcile,
    };
  }

  /**
   * Stage 14 P1 (AC-S14-1) — ROOT COLD-START. Discover every ROOT coordinator that is
   * registered-but-unhosted — `role === 'coordinator'` AND `parent === '@operator'`, with NO live
   * session and not already warm in this engine — and LAUNCH each via {@link ConductorEngine.ensureHosted}
   * (the same launch authority the reviewer spawn-gate uses). `ensureHosted` mints the root's
   * `session.created` (via `hostSession`), so after this returns the root is in the live set and
   * drivable. Returns the ids cold-started this tick (for the {@link DaemonTickOutcome} + host log).
   *
   * GATE (must-not-regress): only a ROOT coordinator is cold-started. A recovered CHILD session (e.g.
   * an implementer that is cold in this engine process) is NEVER cold-launched — it stays a cold
   * candidate, exactly as before. Re-launching a crashed child into a fresh pane is the `[host-live]`
   * operator handoff, not this in-process cold-start.
   *
   * Launch details stay behind the engine's injected `spawnSpecFor`: sandbox callers can keep a
   * minimal spec, while `co-mcp serve` supplies the isolated MCP bridge/config spec in `host.ts`.
   * No wall clock — discovery is pure store reads and the launch carries the daemon's injected seams.
   */
  private async coldStartRootCoordinators(): Promise<readonly string[]> {
    const roots = this.discoverColdStartRoots();
    const started: string[] = [];
    for (const identity of roots) {
      await this.engine.ensureHosted(identity);
      started.push(identity.agent);
    }
    return started;
  }

  /**
   * Stage 15 P-E (AC-S15-2 / ST-2) — RE-WARM the cold recovered NON-root agents. GENERALIZES the root
   * cold-start ({@link coldStartRootCoordinators}) to the recovered live set: after a daemon restart the
   * RUNNING set is reconstructed (each agent's durable {@link HostedIdentity} — pane/cwd/provider/resume
   * recovered from its session record) but the NON-root agents (implementers/leads) are COLD in this
   * fresh engine process — today only reported in {@link DaemonTickOutcome.coldCandidates}, never driven.
   * This drives each back through the engine's SINGLE launch authority ({@link ConductorEngine.ensureHosted},
   * MNR-5) — the SAME authority the root cold-start and the reviewer spawn-gate use, NEVER a second
   * launcher (a second dispatch path would reintroduce the prototype's duplicate-dispatch worktree race).
   * Called BEFORE `runCycle`, so a re-warmed agent joins the drivable set and can take its first turn
   * THIS tick (mirroring step 0).
   *
   * GATES (each upholds a HARD constraint), applied per candidate in {@link buildCandidates} order:
   *   - ALREADY WARM ({@link ConductorEngine.isHosted}) ⇒ skip: never re-launch a warm pane (single
   *     launch authority). This also excludes a root just cold-started in step 0. The `isHosted` gate
   *     keeps `ensureHosted`'s MNR-5 already-hosted throw unreached on the happy path.
   *   - ROOT ({@link isRootIdentity}) ⇒ skip: a root with no session is cold-started in step 0; a
   *     recovered root WITH a session stays a cold candidate — re-warm is NON-root, so root handling is
   *     left exactly as-is.
   *   - SKIPPED: a paused/STUCK agent is already filtered out of `candidates` by {@link buildCandidates}
   *     (the {@link ConductorDaemonDeps.isSkipped} seam), so it never reaches this loop.
   *
   * NO DOUBLE-DISPATCH: the loop is sequential and `ensureHosted` marks the agent hosted, so once
   * re-warmed an agent is `isHosted` on the next tick and is skipped — re-warmed AT MOST ONCE, never
   * twice in one tick (the candidates are distinct agents) nor again on a later tick. NO wall clock —
   * selection is the pure `candidates` order ({@link buildCandidates} → session creation order); the
   * same injected `now()` + same recovered state ⇒ the same re-warm selection (replay-stable).
   *
   * GUARD (review-375): the per-tick `ensureHosted` is wrapped. In production a recovered agent still
   * owns its durable session row, so the launch authority THROWS (`recordSession`: "already has an active
   * session"; the real session-reconciling relaunch is deferred [host-live] glue). An UNCAUGHT throw here
   * would reject the whole tick — starving `runCycle` — and spawn+kill a pane every tick. So a throw is
   * caught and the agent recorded in {@link reWarmFailed}: attempted at most once, then left a cold
   * candidate. The tick ALWAYS proceeds to `runCycle`.
   *
   * SELECTION ONLY: the real binary relaunch (re-spawning the crashed provider, reconciling its existing
   * session row) stays `[host-live]` glue, exactly as this module's docstring notes — this is the
   * in-sandbox SELECTION that drives that handoff. Returns the ids re-warmed this tick (for the
   * {@link DaemonTickOutcome.reWarmed} mirror + host log).
   */
  private async reWarmRecoveredAgents(
    candidates: readonly HostedIdentity[],
  ): Promise<readonly string[]> {
    const reWarmed: string[] = [];
    for (const identity of candidates) {
      if (this.engine.isHosted(identity.projectId, identity.agent)) continue; // warm — single launch authority
      if (this.isRootIdentity(identity)) continue; // roots stay with the cold-start path (re-warm is non-root)
      const key = `${identity.projectId}\0${identity.agent}`;
      if (this.reWarmFailed.has(key)) continue; // already refused — never churn a pane every tick (review-375)
      try {
        await this.engine.ensureHosted(identity);
        reWarmed.push(identity.agent);
      } catch {
        // GUARD (review-375): the recovered agent still owns its durable session row, so the single
        // launch authority refuses it (`ensureHosted → hostSession → recordSession`: "already has an
        // active session"). The real session-reconciling relaunch is [host-live] glue (deferred). Catch
        // so a throw can NEVER stall `runCycle` or churn a pane every tick; record it so the agent is
        // attempted at most once and stays a cold candidate, exactly as before P-E.
        this.reWarmFailed.add(key);
      }
    }
    return reWarmed;
  }

  /**
   * A ROOT coordinator: `role === 'coordinator'` parented at the {@link OPERATOR} — the same predicate
   * {@link discoverColdStartRoots} gates the cold-start on. Re-warm excludes roots (root handling is the
   * cold-start path's, left unchanged); a recovered root-with-session is therefore never re-warmed.
   */
  private isRootIdentity(identity: HostedIdentity): boolean {
    return identity.role === 'coordinator' && identity.parent === OPERATOR;
  }

  /**
   * Resolve the launch {@link HostedIdentity} of every registered-but-unhosted ROOT coordinator that is
   * READY to cold-start. The root has no session yet, so discovery is roster-based (joined to the
   * live-session set + the engine's warm set to exclude already-hosted roots) and then gated on a LIVE
   * PROVISIONED WORKTREE keyed to the root's agent id (the cwd to host into, mirroring the reviewer
   * spawn-gate lookup).
   *
   * The worktree is the readiness signal: the start primitive provisions it BEFORE registering the
   * root, so a genuine operator-started root always has one. A coordinator with NO live worktree is NOT
   * a launchable root (e.g. a roster PARENT-ANCESTOR the chain recorded, or a finished root whose
   * sandbox was torn down) — it is skipped, never cold-launched. This is not a silent drop of a live
   * agent: such a coordinator has no pane to drive and no work sandbox to host into.
   */
  private discoverColdStartRoots(): readonly HostedIdentity[] {
    const roster = this.openRoster(this.projectId);
    try {
      const sessions = this.openSessions(this.projectId);
      try {
        const live = new Set(sessions.listSessions().map((session) => session.agentId));
        const roots = roster
          .listAgents()
          .filter(
            (agent) =>
              agent.role === 'coordinator' &&
              agent.parent === OPERATOR &&
              !live.has(agent.agentId) &&
              !this.engine.isHosted(this.projectId, agent.agentId) &&
              !this.isSkipped(this.projectId, agent.agentId),
          );
        if (roots.length === 0) return [];
        const worktrees = this.openWorktrees(this.projectId);
        try {
          const live2 = worktrees.listWorktrees();
          const identities: HostedIdentity[] = [];
          for (const agent of roots) {
            const worktree = live2.find((w) => !w.removed && w.agent === agent.agentId);
            if (worktree == null) continue; // not a launchable root — see method docstring.
            identities.push(this.toRootIdentity(agent, worktree.path));
          }
          return identities;
        } finally {
          worktrees.close();
        }
      } finally {
        sessions.close();
      }
    } finally {
      roster.close();
    }
  }

  /**
   * Build a root coordinator's launch {@link HostedIdentity}: cwd = its provisioned worktree path,
   * `pane = pane-<id>`, provider `claude`, resume `{ provider:'claude', sessionId:<id> }`.
   */
  private toRootIdentity(agent: AgentRecord, cwd: string): HostedIdentity {
    return {
      agent: agent.agentId,
      role: agent.role,
      ...(agent.subRole != null ? { subRole: agent.subRole } : {}),
      parent: agent.parent,
      pane: `pane-${agent.agentId}`,
      projectId: this.projectId,
      cwd,
      provider: 'claude',
      resume: { provider: 'claude', sessionId: agent.agentId },
    };
  }
}
