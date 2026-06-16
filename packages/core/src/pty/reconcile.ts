/**
 * Stage 9 P4 (L8-WDOG) — the silent-stop watchdog-RECONCILE loop (THE canonical-bug cure).
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS (AC-S9-4 / the #1 prototype pain): a worker stops WITHOUT signalling completion — it
 * ends its TURN (goes idle) but never sent `co_finish`/`worker_done` — and the orchestrator leaves it
 * sitting idle FOREVER ("silent stop"). This loop is the cure. One {@link ReconcileLoop.tick} scans the
 * recorded RUNNING set, observes each running agent's liveness, and drives the per-agent
 * {@link LivenessWatchdog} escalation in a BOUNDED window: a silent-stopped (or wedged / dead) agent is
 * detected → NUDGED → and if it stays broken → escalated to STUCK-and-surfaced. Never a multi-hour reap.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * DESIGN (PURE + seam-injected, exactly like {@link classifyLiveness}/{@link LivenessWatchdog}): every
 * external dependency enters as a constructor seam, so the whole loop is sandbox-testable with NO MCP
 * SDK, NO live provider, and NO wall clock.
 *   1. {@link ReconcileSeams.runningAgents} — the recovered RUNNING set. Host wires P3's
 *      `selectAllSessions` (sessions with `session.created` and no `session.ended`); the sandbox test
 *      synthesizes it (and may build a real recovered store to prove the P3 hand-off end-to-end).
 *   2. {@link ReconcileSeams.livenessInputFor} — per-agent {@link LivenessInput}. In sandbox the TEST
 *      synthesizes the canonical "idle, no `worker_done`, pty-quiet" trace; host-side the engine supplies
 *      it from the hosted pane (trace) + an OS `kill(pid, 0)` `pidAlive` probe — `[host-live]`. Returning
 *      `undefined` SKIPS an agent the host cannot observe this tick (e.g. an orphan with no live pane
 *      post-crash — the live re-attach / OS probe is `[host-live]`, and live re-dispatch is L8-LIVE).
 *   3. Drive {@link LivenessWatchdog.assess} — ONE watchdog per agent, PERSISTED across ticks (keyed by
 *      agent id) so a repeat break ESCALATES: `silent_stop` ⇒ nudge then (on persistence) STUCK; `wedged`
 *      ⇒ straight to STUCK (a frozen pane cannot echo a nudge); `dead` ⇒ the break-signal once (the reap
 *      signal the runtime acts on). Completion stays keyed to `co_finish`/`worker_done` (the classifier's
 *      `sawCompletionVerb`), **NEVER** turn-end — an "idle ⇒ done" shortcut would silently drop the real
 *      work Claude auto-backgrounds while ending its turn.
 *   4. {@link ReconcileSeams.now} — the `observedAt` clock seam. Time is DATA, never a wall clock, so the
 *      8 s wedge / 2.5 s idle boundaries are driven exactly (deterministic / replay-safe).
 *
 * THE BOUNDED WINDOW. Boundedness is structural, not a timer: (a) the classifier's named thresholds —
 * {@link WEDGE_MS} (8 s) and the C2 idle window — gate detection, and (b) the escalation reaches STUCK in
 * just TWO observations (detect+nudge, then persist+STUCK). At any host tick cadence the whole
 * detect → nudge → STUCK cycle completes in tens of seconds, never hours. The host owns ONLY the tick
 * cadence (a `setInterval` over `tick()` — `[host-live]` glue); the policy that bounds the window lives
 * here and in the watchdog.
 *
 * INTEGRATION (kept thin; `[host-live]`): the Conductor calls `tick()` on its cadence, wiring the real
 * `livenessInputFor` (hosted-pane trace + `kill(pid, 0)`) and the real `markStuck`/`onBreak` (the router
 * STUCK state + the operator-facing surfacing). This module registers ZERO agent MCP tools — it is a
 * loop, not a tool.
 */
import type { Pane } from './pty-host.js';
import type { Provider } from './startup-classifier.js';
import {
  LivenessWatchdog,
  type LivenessConfig,
  type LivenessInput,
  type LivenessVerdict,
  type BreakSignal,
  type MarkStuck,
  type InjectNudgeFn,
} from './liveness-watchdog.js';

/**
 * One entry in the recovered RUNNING set the loop reconciles. The host builds these from P3's
 * `selectAllSessions` (one `SessionRecord` per not-yet-ended session) joined to its live hosted panes;
 * the sandbox test builds them directly over a {@link FakePty} pane. `pane` is the nudge target the
 * per-agent watchdog needs; `provider` (from the session record) gates the classifier's provider-specific
 * idle interpretation (the codex OSC0 edge).
 */
export interface RunningAgent {
  /** The agent whose session is still RUNNING (no `session.ended`). */
  readonly agentId: string;
  /** The agent's live pane — where a gentle corrective nudge is injected. */
  readonly pane: Pane;
  /** The session's provider, merged into the per-agent classifier config when present. */
  readonly provider?: Provider;
}

/**
 * The `livenessInputFor` seam: observe one running agent's {@link LivenessInput} for this tick. Returns
 * `undefined` to SKIP an agent the host cannot observe right now (e.g. an orphan with no live pane
 * post-crash — obtaining its input is `[host-live]`). In sandbox the test synthesizes the input.
 */
export type LivenessProbe = (agent: RunningAgent) => LivenessInput | undefined;

/** Constructor-injected reconcile seams — every external dependency, so the loop stays PURE. */
export interface ReconcileSeams {
  /** The recovered RUNNING set (host: P3 `selectAllSessions`; sandbox: synthesized). */
  readonly runningAgents: () => readonly RunningAgent[];
  /** Per-agent liveness observation (sandbox: synthesized; host: hosted-pane trace + `kill(pid,0)` `[host-live]`). */
  readonly livenessInputFor: LivenessProbe;
  /** The `observedAt` clock — DATA, never a wall clock (deterministic / replay-safe). */
  readonly now: () => number;
  /** Break-signal seam: the router surfaces the detected break (the "surfaced" half of STUCK-and-surfaced). */
  readonly onBreak: BreakSignal;
  /** STUCK-escalation seam: the runtime router flips the agent into STUCK (`co unstick` reverts). */
  readonly markStuck: MarkStuck;
  /** Nudge-injector override (defaults, per watchdog, to the real catalog injector). */
  readonly injectNudge?: InjectNudgeFn;
}

/** Per-agent outcome of one reconcile tick: the agent and the {@link LivenessVerdict} it was assessed to. */
export interface ReconcileAssessment {
  readonly agent: string;
  readonly verdict: LivenessVerdict;
}

/**
 * A per-agent failure during a tick (e.g. a nudge injection that threw). SURFACED, never swallowed
 * (Principle 9 — fail loud): it is returned so the host logs it, while the rest of the sweep still
 * completes — one agent's pane-write failure must NOT starve the others' bounded liveness checks.
 */
export interface ReconcileError {
  readonly agent: string;
  readonly error: unknown;
}

/** The result of one {@link ReconcileLoop.tick}: what was assessed, skipped, and what failed. */
export interface ReconcileTickResult {
  /** The single `observedAt` this tick was judged at (from {@link ReconcileSeams.now}). */
  readonly observedAt: number;
  /** Every agent assessed this tick, with its verdict. */
  readonly assessed: readonly ReconcileAssessment[];
  /** Agents skipped because the host could not observe them this tick (`livenessInputFor` ⇒ undefined). */
  readonly skipped: readonly string[];
  /** Per-agent failures, surfaced (not swallowed) so the sweep completes for everyone else. */
  readonly errors: readonly ReconcileError[];
}

/**
 * The watchdog-reconcile loop. Holds ONE persisted {@link LivenessWatchdog} per running agent (keyed by
 * agent id) so a break that survives one tick escalates to STUCK on the next — the bounded escalation the
 * canonical silent-stop bug needs. Stateless apart from that per-agent watchdog map; `tick()` is the unit
 * the host calls on its own cadence.
 */
export class ReconcileLoop {
  private readonly seams: ReconcileSeams;
  private readonly config: LivenessConfig;
  /** One watchdog per RUNNING agent, persisted across ticks so a repeat break escalates. */
  private readonly watchdogs = new Map<string, LivenessWatchdog>();
  /** Reconcile ticks are serialized so overlap watchdog beats cannot race cadence reconciles. */
  private inFlight: Promise<ReconcileTickResult> | undefined;

  constructor(seams: ReconcileSeams, config: LivenessConfig = {}) {
    this.seams = seams;
    this.config = config;
  }

  /** How many agents are currently tracked (one persisted watchdog each) — for host introspection/tests. */
  get tracked(): number {
    return this.watchdogs.size;
  }

  /**
   * Run one reconcile pass over the recovered RUNNING set. Snapshots the set and a single `observedAt`,
   * drops watchdogs for agents that have left the set (finished / session ended), then drives each
   * agent's persisted watchdog with its observed input. Per-agent failures are isolated + surfaced so
   * the whole sweep always completes.
   */
  async tick(): Promise<ReconcileTickResult> {
    if (this.inFlight !== undefined) return this.inFlight;
    const run = this.runTick();
    this.inFlight = run;
    try {
      return await run;
    } finally {
      if (this.inFlight === run) this.inFlight = undefined;
    }
  }

  private async runTick(): Promise<ReconcileTickResult> {
    const running = this.seams.runningAgents();
    const observedAt = this.seams.now();

    // Drop watchdogs for agents no longer RUNNING (their session ended / they finished). A departed
    // agent must not keep an escalation episode alive — and a recycled id starts a fresh episode.
    const runningIds = new Set(running.map((a) => a.agentId));
    for (const id of [...this.watchdogs.keys()]) {
      if (!runningIds.has(id)) this.watchdogs.delete(id);
    }

    const assessed: ReconcileAssessment[] = [];
    const skipped: string[] = [];
    const errors: ReconcileError[] = [];

    for (const agent of running) {
      const input = this.seams.livenessInputFor(agent);
      if (input === undefined) {
        // Unobservable this tick (e.g. an orphan with no live pane — the live OS probe is `[host-live]`).
        // Skip gracefully; a later tick may observe it. Recorded so the host can act (L8-LIVE re-dispatch).
        skipped.push(agent.agentId);
        continue;
      }
      const watchdog = this.watchdogFor(agent);
      const config: LivenessConfig =
        agent.provider !== undefined ? { ...this.config, provider: agent.provider } : this.config;
      try {
        const verdict = await watchdog.assess(agent.agentId, input, observedAt, config);
        assessed.push({ agent: agent.agentId, verdict });
      } catch (error) {
        // The watchdog emits its break-signal BEFORE the nudge, so the diagnosis is never lost even when
        // the nudge throws here. Surface the failure and move on — the break still escalates next tick.
        errors.push({ agent: agent.agentId, error });
      }
    }

    return { observedAt, assessed, skipped, errors };
  }

  /** The persisted watchdog for `agent`, created on first sight over the agent's live pane + shared seams. */
  private watchdogFor(agent: RunningAgent): LivenessWatchdog {
    let watchdog = this.watchdogs.get(agent.agentId);
    if (watchdog === undefined) {
      watchdog = new LivenessWatchdog({
        pane: agent.pane,
        onBreak: this.seams.onBreak,
        markStuck: this.seams.markStuck,
        // Conditionally spread so an absent override falls back to the watchdog's real catalog injector
        // (exactOptionalPropertyTypes: never pass an explicit `undefined`).
        ...(this.seams.injectNudge !== undefined ? { injectNudge: this.seams.injectNudge } : {}),
      });
      this.watchdogs.set(agent.agentId, watchdog);
    }
    return watchdog;
  }
}
