/**
 * L7-LOOP (Stage 10 · P1) — the `[host-live]` runner + the `co serve` operator launch (the thin glue
 * over the deterministic {@link ConductorDaemon}).
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 * THIS IS THE ONLY `[host-live]` CODE IN THE PHASE. The daemon core (daemon.ts) is the HARD,
 * sandbox-proven requirement; this module drives its `tick()` on a REAL cadence (`setInterval`) with
 * REAL panes ({@link NodePtyHost}) and a real `now`/`quietWindow`. It is built and unit-tested with
 * `FakePty` + a CONTROLLABLE scheduler (the cadence loop, re-entrancy guard, and lifecycle are proven),
 * but it is NEVER executed against a real `claude`/`codex` binary in-sandbox. The operator entry wires
 * scoped provider MCP paths; direct `serveConductor` callers must inject `makeTransport` or hit the
 * fail-loud default seam.
 *
 * REGISTERS ZERO AGENT MCP TOOLS (Principle 4 + D4). `co serve` is an OPERATOR-only launch (blessed
 * name, D6); it is exposed from the `@co/mcp` package (the daemon needs the MCP SDK, and `@co/cli`
 * depends only on `@co/core`), via the `co-mcp serve` bin mode — NOT by adding a `@co/mcp` dependency
 * to `@co/cli`.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 */
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import {
  NodePtyHost,
  openRegistry,
  openSessionStore,
  openWorktreeStore,
  queryLiveObservability,
  QUIET_WINDOW_MS,
  type BreakSignal,
  type LiveObservabilitySnapshot,
  type MarkStuck,
  type ProjectId,
  type PtyHost,
  type RunningAgent,
} from '@co/core';
import { ReconcileLoop } from '@co/core';
import { ConductorEngine, type TransportPair } from './engine.js';
import { ConductorDaemon, type DaemonTickOutcome } from './daemon.js';
import { DaemonBackedAgentRouter } from './agent-router.js';
import { EngineLiveStateProvider } from './live-observe.js';
import type { HostedIdentity } from '../live-session-host.js';
import { EngineReviewerSpawnGate } from './reviewer-gate.js';
import { type CoMcpPaths } from './placement-launch.js';
import { createSocketBridgeTransportPair } from './real-transport.js';
import { defaultCoMcpPaths, type HostLaunchPathOptions } from './host-launch-paths.js';

// ── The cadence scheduler seam (injected so the loop is FakePty-unit-testable) ──────────────────────

/** An opaque interval handle (the real `setInterval` returns one; a fake scheduler returns a token). */
export type IntervalHandle = object;

/** The cadence scheduler — global timers in production, a controllable fake in the sandbox test. */
export interface IntervalScheduler {
  readonly setInterval: (callback: () => void, ms: number) => IntervalHandle;
  readonly clearInterval: (handle: IntervalHandle) => void;
}

/** The real scheduler over Node's global timers (the `[host-live]` cadence). */
export const defaultScheduler: IntervalScheduler = {
  setInterval: (callback, ms) => setInterval(callback, ms) as unknown as IntervalHandle,
  clearInterval: (handle) =>
    clearInterval(handle as unknown as Parameters<typeof clearInterval>[0]),
};

// ── The operator control/observe surface (Stage 10 P3 — CTL-OBS) ────────────────────────────────────

/**
 * The transport-agnostic operator surface for a running Conductor: CONTROL via the daemon-backed router
 * (unstick/pause/stop/steer act on live agents) and OBSERVE via a live snapshot (static rollup ⊕ engine
 * overlay). Built by {@link serveConductor} in the daemon process; the deferred cross-process IPC binding
 * (separate CLI → `co serve`) ships these same calls over the wire next stage. Registers ZERO agent MCP
 * tools — operator-only methods, never agent-callable (Principle 4 + D4).
 */
export interface ConductorControlSurface {
  /** The daemon-backed router — `revertStuck`/`rewake`/`pause`/`stop` (+ `resume`/`steer`) on live agents. */
  readonly router: DaemonBackedAgentRouter;
  /** Snapshot the LIVE observability view (roster/cost ⊕ hosted/paused/stuck/outstanding-mail). */
  readonly observe: () => LiveObservabilitySnapshot;
}

// ── The cadence runner ──────────────────────────────────────────────────────────────────────────────

/** Constructor seams for the host runner. */
export interface ConductorHostRunnerDeps {
  /** The deterministic daemon this runner drives. */
  readonly daemon: ConductorDaemon;
  /** The wall-clock cadence in ms between `tick()`s (the real `setInterval` period). */
  readonly intervalMs: number;
  /** The cadence scheduler. Default: {@link defaultScheduler} (Node global timers). */
  readonly scheduler?: IntervalScheduler;
  /** Host log seam: each completed tick outcome (for the operator surface / metrics). */
  readonly onTick?: (outcome: DaemonTickOutcome) => void;
  /** Fail-loud seam: a tick that threw (e.g. the un-wired `[host-live]` transport). Never swallowed. */
  readonly onError?: (error: unknown) => void;
  /** Called by {@link ConductorHostRunner.stop} so callers can close resources tied to the runner's lifetime. */
  readonly onStop?: () => void | Promise<void>;
  /**
   * The operator control/observe surface (P3). Optional: the cadence runner works without it (existing
   * callers/tests are unchanged); {@link serveConductor} always wires it so the operator can control +
   * observe the running conductor via {@link ConductorHostRunner.control}.
   */
  readonly control?: ConductorControlSurface;
}

/**
 * Drives {@link ConductorDaemon.tick} on a real cadence. Re-entrancy-guarded: if a tick is still in
 * flight when the next beat fires, that beat is SKIPPED (ticks never overlap or stack — a slow turn
 * must not pile up concurrent cycles). Lifecycle is `start()` (recover + arm) → beats → `stop()`
 * (disarm). The cadence + guard + lifecycle are sandbox-proven over `FakePty` + a controllable
 * scheduler; the real timers are the only un-exercised host-live part.
 */
export class ConductorHostRunner {
  private readonly daemon: ConductorDaemon;
  private readonly intervalMs: number;
  private readonly scheduler: IntervalScheduler;
  private readonly onTick: ((outcome: DaemonTickOutcome) => void) | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly onStop: (() => void | Promise<void>) | undefined;
  /** The operator control/observe surface (P3), present when built by {@link serveConductor}. */
  readonly control: ConductorControlSurface | undefined;
  private handle: IntervalHandle | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(deps: ConductorHostRunnerDeps) {
    this.daemon = deps.daemon;
    this.intervalMs = deps.intervalMs;
    this.scheduler = deps.scheduler ?? defaultScheduler;
    this.onTick = deps.onTick;
    this.onError = deps.onError;
    this.onStop = deps.onStop;
    this.control = deps.control;
  }

  /** Whether the cadence is currently armed. */
  get started(): boolean {
    return this.handle != null;
  }

  /**
   * Recover on start (the daemon rebuilds every read-model + reconstructs the live set), then arm the
   * cadence. Returns the recovered live set so the host can log/observe what it will drive. Fails loud
   * on a double-start (the cadence must have a single owner).
   */
  start(): readonly HostedIdentity[] {
    if (this.stopped) {
      throw new Error('ConductorHostRunner.start: runner has already been stopped.');
    }
    if (this.handle != null) {
      throw new Error(
        'ConductorHostRunner.start: already started (Principle 9 — refuse a double-arm).',
      );
    }
    const live = this.daemon.recover();
    this.handle = this.scheduler.setInterval(() => void this.beat(), this.intervalMs);
    return live;
  }

  /** Disarm the cadence (idempotent) and invoke the stop hook (e.g. to close owned resources). */
  async stop(): Promise<void> {
    if (this.handle != null) {
      this.scheduler.clearInterval(this.handle);
      this.handle = null;
    }
    if (this.stopped) return;
    this.stopped = true;
    await this.inFlight;
    await this.onStop?.();
  }

  /** One cadence beat: run a tick unless a prior one is still in flight; report the outcome / error. */
  private async beat(): Promise<void> {
    if (this.inFlight != null) return; // a prior tick is still running — skip this beat (no overlap)
    const run = this.runBeat();
    this.inFlight = run;
    try {
      await run;
    } finally {
      if (this.inFlight === run) this.inFlight = null;
    }
  }

  private async runBeat(): Promise<void> {
    try {
      const outcome = await this.daemon.tick();
      this.onTick?.(outcome);
    } catch (error) {
      if (this.onError != null) this.onError(error);
      else console.error('[co serve] tick error:', error);
    }
  }
}

// ── The real host-live seams (`co serve`) ───────────────────────────────────────────────────────────

/** A real monotonic ms clock for the engine/reconcile/daemon time seams (never the wall clock). */
export const monotonicNowMs = (): number => performance.now();

/** A real byte-quiet window: resolves after {@link QUIET_WINDOW_MS}, cleared + resolved on abort. */
export function realQuietWindow(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, QUIET_WINDOW_MS);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportServeControlDiagnostic(
  onError: ((error: unknown) => void) | undefined,
  error: Error,
): void {
  if (onError != null) {
    onError(error);
  } else {
    console.error('[co serve] control error:', error);
  }
}

/**
 * The default `[host-live]` transport seam: binding the co MCP surface to a real pty-bound provider
 * transport is an explicit host-live seam for direct `serveConductor` callers. Throws a clear message
 * (mirrors the `co unstick` router seam) so tests and custom hosts never silently fabricate transport.
 */
export const hostLiveTransportRequired: (identity?: HostedIdentity) => TransportPair = () => {
  throw new Error(
    '[host-live] co serve: binding the co MCP surface to a real pty-bound provider transport is the ' +
      'operator handoff — inject `makeTransport` with the live pty transport pair. The deterministic ' +
      'daemon core + its sandbox tests are complete; this is the only un-wired host-live seam.',
  );
};

/**
 * The recovered RUNNING set the watchdog observes, restricted to agents this process currently HOSTS
 * (a warm pane to read). An orphan with no live pane is skipped — re-attaching to it (the live OS probe
 * + re-dispatch) is `[host-live]` / L8-LIVE, not this in-process observation.
 */
function liveRunningAgents(projectId: ProjectId, engine: ConductorEngine): readonly RunningAgent[] {
  const sessions = openSessionStore(projectId);
  try {
    return sessions.listSessions().flatMap((session) => {
      const hosted = engine.getHosted(projectId, session.agentId);
      return hosted != null
        ? [{ agentId: session.agentId, pane: hosted.pane, provider: session.provider }]
        : [];
    });
  } finally {
    sessions.close();
  }
}

/** Options for {@link serveConductor}. The genuinely host-live seams carry honest defaults. */
export interface ServeConductorOptions {
  /** The project whose live set the conductor drives. */
  readonly projectId: ProjectId;
  /** Wall-clock cadence between ticks (ms). Default: 1000. */
  readonly intervalMs?: number;
  /** Reconcile/clarify cadence: every Nth tick. Default: 5. */
  readonly reconcileEvery?: number;
  /** Pane host. Default: a real {@link NodePtyHost} (lazy node-pty import — host-side only). */
  readonly pty?: PtyHost;
  /** The pty-bound provider transport seam. Default: {@link hostLiveTransportRequired} (operator handoff). */
  readonly makeTransport?: (identity: HostedIdentity) => TransportPair;
  /** Monotonic ms clock. Default: {@link monotonicNowMs}. */
  readonly now?: () => number;
  /** Byte-quiet window seam. Default: {@link realQuietWindow}. */
  readonly quietWindow?: (signal: AbortSignal) => Promise<void>;
  /** The cadence scheduler. Default: {@link defaultScheduler}. */
  readonly scheduler?: IntervalScheduler;
  /** Per-tick host log seam. Default: none. */
  readonly onTick?: (outcome: DaemonTickOutcome) => void;
  /** Per-tick error seam (fail-loud surface). Default: none. */
  readonly onError?: (error: unknown) => void;
  /** Watchdog break-signal seam (router surfaces STUCK-and-surfaced). Default: none. */
  readonly onBreak?: BreakSignal;
  /** Watchdog STUCK-escalation seam (`co unstick` reverts). Default: none. */
  readonly markStuck?: MarkStuck;
  /** Whether to arm the cadence immediately. Default: true (an operator launch runs). */
  readonly autoStart?: boolean;
  /**
   * Co MCP + CLI binary paths for the `EngineReviewerSpawnGate` (P2 / AC-S10-2 / RG-4). When
   * provided, a live `EngineReviewerSpawnGate` is wired into every hosted session's ctx so `co_merge`
   * calls can trigger live reviewer spawns. When absent, no spawn gate is wired (headless path).
   *
   * [host-live] The real binary paths bind here at `co serve` time. For sandbox proofs, inject
   * fixture paths (clone `TEST_MCP_PATHS` from `placement-launch.test.ts`).
   */
  readonly coMcpPaths?: CoMcpPaths;
}

/**
 * Build the full Conductor host stack and (by default) start it: a real {@link ConductorEngine} (real
 * panes + cadence), the watchdog {@link ReconcileLoop} (running set = the agents this process hosts;
 * the live OS liveness probe is the `[host-live]` handoff, so it skips), the deterministic
 * {@link ConductorDaemon}, and the {@link ConductorHostRunner}. Every genuinely host-live seam is
 * injectable; the defaults let `co serve` recover + idle-tick and fail loud ONLY when it must bind a
 * real provider transport. Returns the (started) runner.
 */
export async function serveConductor(opts: ServeConductorOptions): Promise<ConductorHostRunner> {
  const projectId = opts.projectId;
  const now = opts.now ?? monotonicNowMs;
  const pty = opts.pty ?? (await NodePtyHost.create());

  // P2 / AC-S10-2 — lazy reviewer-spawn gate: breaks the construction cycle (gate wraps engine).
  // [host-live] isolatedHomeDirFor: per-agent isolated home dir under the project data dir.
  let spawnGate: EngineReviewerSpawnGate | undefined;
  let ownedWtStore: ReturnType<typeof openWorktreeStore> | undefined;
  let isolatedHomeDirFor: ((agent: string) => string) | undefined;
  if (opts.coMcpPaths != null) {
    const registry = openRegistry();
    const dataDir = registry.dataDirFor(projectId);
    registry.close();
    isolatedHomeDirFor = (agent: string): string => join(dataDir, 'isolated', agent);
  }
  const makeTransport =
    opts.makeTransport ??
    ((identity: HostedIdentity): TransportPair => {
      if (opts.coMcpPaths == null || isolatedHomeDirFor == null) return hostLiveTransportRequired();
      const isolatedHomeDir = isolatedHomeDirFor(identity.agent);
      const socketPath = opts.coMcpPaths.coMcpBridgeSocketPath?.(isolatedHomeDir, identity.agent);
      if (socketPath == null) {
        throw new Error(
          '[host-live] co serve: coMcpPaths.coMcpBridgeSocketPath is required when co serve owns ' +
            'the real provider MCP bridge transport.',
        );
      }
      return createSocketBridgeTransportPair(socketPath);
    });
  const engine = new ConductorEngine({
    pty,
    makeTransport,
    now,
    quietWindow: opts.quietWindow ?? realQuietWindow,
    reviewerSpawnGate: () => spawnGate,
  });
  if (opts.coMcpPaths != null) {
    ownedWtStore = openWorktreeStore(projectId);
    spawnGate = new EngineReviewerSpawnGate(
      engine,
      ownedWtStore,
      isolatedHomeDirFor!,
      opts.coMcpPaths,
    );
  }

  // P3 (CTL-OBS) — the operator control/observe surface, backed by the running engine.
  const router = new DaemonBackedAgentRouter({
    engine,
    projectId,
    onStopUnhosted: (agent) =>
      reportServeControlDiagnostic(
        opts.onError,
        new Error(`co serve: stop requested for '${agent}' but it is not hosted.`),
      ),
    onStopError: (agent, error) =>
      reportServeControlDiagnostic(
        opts.onError,
        new Error(`co serve: stop teardown for '${agent}' failed: ${errorMessage(error)}`),
      ),
  });
  const liveProvider = new EngineLiveStateProvider({ engine, projectId, router });

  const reconcile = new ReconcileLoop({
    runningAgents: () => liveRunningAgents(projectId, engine),
    // [host-live]: the per-agent hosted-pane trace + `kill(pid, 0)` probe is the operator handoff;
    // until it is wired, the loop skips (it never fabricates a liveness verdict — Principle 9).
    livenessInputFor: () => undefined,
    now,
    onBreak: opts.onBreak ?? (() => {}),
    // P3 §3a/§3d — the router IS the host-side markStuck owner: a watchdog escalation lands in its
    // STUCK set (so the daemon then skips the agent until `unstick`), and ALSO fans out to any
    // operator-supplied markStuck seam (surfacing). `co unstick`'s revertStuck+rewake clear it.
    markStuck: (agent) => {
      router.markStuck(agent);
      opts.markStuck?.(agent);
    },
  });

  const daemon = new ConductorDaemon({
    engine,
    reconcile,
    projectId,
    now,
    reconcileEvery: opts.reconcileEvery ?? 5,
    // P3 §3c — honor `pause`/STUCK: filter the router's suppressed agents out of candidate selection.
    isSkipped: (pid, agent) => router.shouldSkip(pid, agent),
  });

  const wtStoreForStop = ownedWtStore;
  const runner = new ConductorHostRunner({
    daemon,
    intervalMs: opts.intervalMs ?? 1000,
    control: { router, observe: () => queryLiveObservability(projectId, liveProvider) },
    ...(opts.scheduler != null ? { scheduler: opts.scheduler } : {}),
    ...(opts.onTick != null ? { onTick: opts.onTick } : {}),
    ...(opts.onError != null ? { onError: opts.onError } : {}),
    onStop: async () => {
      try {
        await router.drain();
        await engine.closeAll();
      } finally {
        wtStoreForStop?.close();
      }
    },
  });

  if (opts.autoStart !== false) runner.start();
  return runner;
}

/** Default host-live MCP path resolution for `co serve`, including provider auth materialization. */
export function defaultServeCoMcpPaths(
  opts: Omit<HostLaunchPathOptions, 'includeProviderAuth'> = {},
): CoMcpPaths {
  return defaultCoMcpPaths({ ...opts, includeProviderAuth: true });
}

/**
 * The `co-mcp serve <projectId>` operator entry: launch the Conductor for a project and keep the
 * process alive on the cadence, surfacing ticks + errors to stderr (stdout is reserved). SIGINT/SIGTERM
 * disarm the cadence and exit. Fails loud (Principle 9) on a missing project id.
 */
export async function runServeConductor(argv: readonly string[]): Promise<void> {
  const projectId = argv[0];
  if (projectId == null || projectId.trim().length === 0) {
    throw new Error(
      'co serve: a project id is required (usage: `co-mcp serve <projectId>`). The Conductor drives ' +
        'one project’s live set.',
    );
  }
  const runner = await serveConductor({
    projectId,
    coMcpPaths: defaultServeCoMcpPaths(),
    onTick: (o) =>
      console.error(
        `[co serve] tick ${o.tick} candidates=${o.candidateCount} ` +
          `cold=${o.coldCandidates.length} selected=${o.selected ?? '-'} cadence=${o.cadenceFired}`,
      ),
    onError: (err) => console.error('[co serve] tick error:', err),
  });
  const shutdown = (): void => {
    void runner
      .stop()
      .then(() => {
        process.exitCode = 0;
      })
      .catch((error) => {
        console.error('[co serve] shutdown error:', error);
        process.exitCode = 1;
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
