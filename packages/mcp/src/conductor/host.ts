/**
 * L7-LOOP (Stage 10 · P1) — the `[host-live]` runner + the `co-mcp serve` operator launch (the thin
 * glue over the deterministic {@link ConductorDaemon}).
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
 * REGISTERS ZERO AGENT MCP TOOLS (Principle 4 + D4). `co-mcp serve` is an OPERATOR-only launch; it is
 * exposed from the `@co/mcp` package (the daemon needs the MCP SDK, and `@co/cli`
 * depends only on `@co/core`), via the `co-mcp serve` bin mode — NOT by adding a `@co/mcp` dependency
 * to `@co/cli`.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 */
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import {
  NodePtyHost,
  defaultGitRawReader,
  openMailStore,
  openRegistry,
  openReviewStore,
  openRosterStore,
  openSessionStore,
  openSpecStore,
  openWorktreeStore,
  queryLiveObservability,
  waitingItems,
  QUIET_WINDOW_MS,
  type BreakSignal,
  type InjectNudgeFn,
  type LiveObservabilitySnapshot,
  type MarkStuck,
  type ProjectId,
  type PtyHost,
  type ReviewContext,
  type RunningAgent,
  type TranscriptTail,
} from '@co/core';
import { ReconcileLoop } from '@co/core';
import { ConductorEngine, type TransportPair } from './engine.js';
import { ConductorDaemon, type DaemonTickOutcome } from './daemon.js';
import { DaemonBackedAgentRouter } from './agent-router.js';
import { EngineLiveStateProvider } from './live-observe.js';
import type { HostedIdentity } from '../live-session-host.js';
import { EngineReviewerSpawnGate } from './reviewer-gate.js';
import { buildHostedLaunchSpec, type CoMcpPaths } from './placement-launch.js';
import { createSocketBridgeTransportPair } from './real-transport.js';
import { defaultCoMcpPaths, type HostLaunchPathOptions } from './host-launch-paths.js';
import { resolveReviewContext } from './review-context.js';
import { OperatorIpcServer, operatorIpcSocketPath } from '../operator-ipc/server.js';

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
 * overlay). Built by {@link serveConductor} in the daemon process; Stage 11's operator-IPC server ships
 * these same calls over the app → daemon socket. Registers ZERO agent MCP tools — operator-only methods,
 * never agent-callable (Principle 4 + D4).
 */
export interface ConductorControlSurface {
  /** The daemon-backed router — `revertStuck`/`rewake`/`pause`/`stop` (+ `resume`/`steer`) on live agents. */
  readonly router: DaemonBackedAgentRouter;
  /** Snapshot the LIVE observability view (roster/cost ⊕ hosted/paused/stuck/outstanding-mail). */
  readonly observe: () => LiveObservabilitySnapshot;
  /**
   * Stage 12 C-P1 (TRANSCRIPT-SEAM) — `agentId`'s bounded transcript tail (most-recent pane bytes;
   * empty when not hosted / no output yet). Transport-agnostic, no I/O (project implicit, like
   * {@link observe}).
   */
  readonly transcriptTail: (agentId: string) => TranscriptTail;
  /**
   * Stage 12 C-P1 (TRANSCRIPT-SEAM) — subscribe to this project's live transcript stream: `listener`
   * fires with `(agentId, chunk)` on every new pane chunk. Returns an unsubscribe fn. The operator-IPC
   * server subscribes this to forward each chunk outward as the `transcript:push` notification.
   */
  readonly onTranscript: (
    listener: (agentId: string, chunk: string, offset: number) => void,
  ) => () => void;
  /**
   * Stage 13 R-A (reviewContext) — resolve `reviewId`'s review context (diff + criteria + refs) for the
   * in-app Review view. Async (it shells `git diff`); a READ — opens no long-lived handles, records NO
   * events. DEGRADES EXPLICITLY (Principle 9) — every failure mode is a named state, never a throw.
   */
  readonly reviewContext: (reviewId: string) => Promise<ReviewContext>;
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
 * Drives {@link ConductorDaemon.tick} on a real cadence. Re-entrancy-guarded: daemon ticks never
 * overlap or stack, but an overlap beat still runs the watchdog reconcile sweep so an active long turn
 * can be diagnosed as wedged. Lifecycle is `start()` (recover + arm) → beats → `stop()` (disarm). The
 * cadence + guard + lifecycle are sandbox-proven over `FakePty` + a controllable scheduler; the real
 * timers are the only un-exercised host-live part.
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
  private watchdogInFlight: Promise<void> | null = null;
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
    await this.watchdogInFlight;
    await this.onStop?.();
  }

  /**
   * One cadence beat: run a daemon tick unless a prior one is still in flight. If a turn is still
   * active, run only the reconcile watchdog so wedged sessions are still detected on cadence.
   */
  private async beat(): Promise<void> {
    if (this.inFlight != null) {
      this.runOverlapWatchdogBeat();
      return;
    }
    const run = this.runBeat();
    this.inFlight = run;
    try {
      await run;
    } finally {
      if (this.inFlight === run) this.inFlight = null;
    }
  }

  private runOverlapWatchdogBeat(): void {
    if (this.watchdogInFlight != null) return;
    const run = this.daemon.reconcile
      .tick()
      .then(() => undefined)
      .catch((error: unknown) => {
        if (this.onError != null) this.onError(error);
        else console.error('[co-mcp serve] watchdog error:', error);
      });
    this.watchdogInFlight = run;
    run.finally(() => {
      if (this.watchdogInFlight === run) this.watchdogInFlight = null;
    });
  }

  private async runBeat(): Promise<void> {
    try {
      const outcome = await this.daemon.tick();
      this.onTick?.(outcome);
    } catch (error) {
      if (this.onError != null) this.onError(error);
      else console.error('[co-mcp serve] tick error:', error);
    }
  }
}

// ── The real host-live seams (`co-mcp serve`) ───────────────────────────────────────────────────────

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
    console.error('[co-mcp serve] control error:', error);
  }
}

function reportServeControlInfo(message: string): void {
  console.error(`[co-mcp serve] control: ${message}`);
}

/**
 * The default `[host-live]` transport seam: binding the co MCP surface to a real pty-bound provider
 * transport is an explicit host-live seam for direct `serveConductor` callers. Throws a clear message
 * (mirrors the `co unstick` router seam) so tests and custom hosts never silently fabricate transport.
 */
export const hostLiveTransportRequired: (identity?: HostedIdentity) => TransportPair = () => {
  throw new Error(
    '[host-live] co-mcp serve: binding the co MCP surface to a real pty-bound provider transport is the ' +
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

function hasWaitingItems(projectId: ProjectId, agentId: string): boolean {
  const mail = openMailStore(projectId);
  try {
    return waitingItems(mail, agentId).length > 0;
  } finally {
    mail.close();
  }
}

function hasOutstandingActionableMail(projectId: ProjectId, agentId: string): boolean {
  const mail = openMailStore(projectId);
  try {
    return mail.outstanding(agentId).length > 0;
  } finally {
    mail.close();
  }
}

function requiresFinishBeforeYield(projectId: ProjectId, agentId: string): boolean {
  const roster = openRosterStore(projectId);
  try {
    const role = roster.getAgent(agentId)?.role;
    return role == null || role === 'lead' || role === 'implementer';
  } finally {
    roster.close();
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
   * P6 (watchdog-seam) — injectable `kill(pid, 0)` probe for the reconcile watchdog. Returns `true`
   * when the agent's OS process is still alive. Default: `process.kill(pane.pid, 0)` when the pane
   * exposes its PID (NodePtyHost); conservative `true` when no PID is available (FakePty / test
   * doubles where the pane exited-flag is the authoritative dead signal). Inject a fake in sandbox
   * tests — no real OS probe in the testable path.
   */
  readonly pidAliveFor?: (agent: RunningAgent) => boolean;
  /**
   * P6 (watchdog-seam) — injectable nudge injector for the reconcile watchdog's `LivenessWatchdog`
   * instances. Default: the real `defaultInjectNudge` (catalog-driven `injectMail`). Inject a no-op
   * in sandbox tests to avoid the real pane-write+echo-verify cycle (which uses wall-clock timers and
   * never echoes on FakePty, blocking the tick's in-flight promise and starving the next tick).
   */
  readonly injectNudge?: InjectNudgeFn;
  /**
   * Co MCP + CLI binary paths for the `EngineReviewerSpawnGate` placement launcher (P2 / AC-S10-2 /
   * RG-4). When provided, the live gate is wired into every hosted session's ctx so `co_merge` /
   * `co_sling` calls can trigger live reviewer or child spawns. When absent, no spawn gate is wired
   * (headless path).
   *
   * [host-live] The real binary paths bind here at `co-mcp serve` time. For sandbox proofs, inject
   * fixture paths (clone `TEST_MCP_PATHS` from `placement-launch.test.ts`).
   */
  readonly coMcpPaths?: CoMcpPaths;
  /**
   * Stage 11 P1 (OP-IPC) — when set, `co-mcp serve` also starts the cross-process operator-IPC server
   * (the desktop-app binding) on a Unix socket under the project data dir: it forwards a fresh
   * snapshot to a connected app each tick and is closed on runner stop. Absent ⇒ no IPC server (every
   * existing caller/test is unchanged). The socket is operator-uid-only by OS permission; the server
   * registers ZERO agent MCP tools (Principle 4 + D4).
   */
  readonly operatorIpc?: OperatorIpcServeConfig;
}

/** Stage 11 P1 (OP-IPC) — configuration for the operator-IPC server `co-mcp serve` starts. */
export interface OperatorIpcServeConfig {
  /** Override the socket path. Default: {@link operatorIpcSocketPath} under the project data dir. */
  readonly socketPath?: string;
  /** Diagnostic seam for IPC server errors (a push to a vanished client, a transport error). */
  readonly onError?: (error: unknown) => void;
}

/**
 * Build the full Conductor host stack and (by default) start it: a real {@link ConductorEngine} (real
 * panes + cadence), the watchdog {@link ReconcileLoop} (running set = the agents this process hosts;
 * liveness input is derived from the hosted engine state plus the injected/default `pidAliveFor`
 * probe), the deterministic {@link ConductorDaemon}, and the {@link ConductorHostRunner}. Every
 * genuinely host-live seam is injectable; the defaults let `co-mcp serve` recover + idle-tick and fail
 * loud ONLY when it must bind a real provider transport. Returns the (started) runner.
 */
export async function serveConductor(opts: ServeConductorOptions): Promise<ConductorHostRunner> {
  const projectId = opts.projectId;
  const now = opts.now ?? monotonicNowMs;
  const pty = opts.pty ?? (await NodePtyHost.create());

  // P2 / AC-S10-2 — lazy placement-spawn gate: breaks the construction cycle (gate wraps engine).
  // [host-live] isolatedHomeDirFor: per-agent isolated home dir under the project data dir.
  let spawnGate: EngineReviewerSpawnGate | undefined;
  let ownedWtStore: ReturnType<typeof openWorktreeStore> | undefined;
  let isolatedHomeDirFor: ((agent: string) => string) | undefined;
  // The project data dir backs both the per-pane isolated homes (P2) and the operator-IPC socket
  // (Stage 11 P1) — derive it once when either is needed.
  let dataDir: string | undefined;
  if (opts.coMcpPaths != null || opts.operatorIpc != null) {
    const registry = openRegistry();
    dataDir = registry.dataDirFor(projectId);
    registry.close();
  }
  if (opts.coMcpPaths != null && dataDir != null) {
    const resolvedDataDir = dataDir;
    isolatedHomeDirFor = (agent: string): string => join(resolvedDataDir, 'isolated', agent);
  }
  const makeTransport =
    opts.makeTransport ??
    ((identity: HostedIdentity): TransportPair => {
      if (opts.coMcpPaths == null || isolatedHomeDirFor == null) return hostLiveTransportRequired();
      const isolatedHomeDir = isolatedHomeDirFor(identity.agent);
      const socketPath = opts.coMcpPaths.coMcpBridgeSocketPath?.(isolatedHomeDir, identity.agent);
      if (socketPath == null) {
        throw new Error(
          '[host-live] co-mcp serve: coMcpPaths.coMcpBridgeSocketPath is required when co-mcp serve owns ' +
            'the real provider MCP bridge transport.',
        );
      }
      return createSocketBridgeTransportPair(socketPath);
    });
  const spawnSpecFor =
    opts.coMcpPaths != null && isolatedHomeDirFor != null
      ? (() => {
          const coMcpPaths = opts.coMcpPaths;
          const homeFor = isolatedHomeDirFor;
          return (identity: HostedIdentity) =>
            buildHostedLaunchSpec(identity, homeFor(identity.agent), coMcpPaths);
        })()
      : undefined;
  const engine = new ConductorEngine({
    pty,
    makeTransport,
    now,
    quietWindow: opts.quietWindow ?? realQuietWindow,
    reviewerSpawnGate: () => spawnGate,
    ...(spawnSpecFor != null ? { spawnSpecFor } : {}),
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
      reportServeControlInfo(`stop requested for '${agent}' but it is not hosted; recorded.`),
    onStopError: (agent, error) =>
      reportServeControlDiagnostic(
        opts.onError,
        new Error(`co-mcp serve: stop teardown for '${agent}' failed: ${errorMessage(error)}`),
      ),
  });
  const liveProvider = new EngineLiveStateProvider({ engine, projectId, router });
  const control: ConductorControlSurface = {
    router,
    observe: () => queryLiveObservability(projectId, liveProvider),
    // Stage 12 C-P1 (TRANSCRIPT-SEAM) — back the transcript accessors with the running engine, closing
    // over THIS project: the tail is the engine's bounded per-agent buffer; onTranscript filters the
    // engine's global stream down to this project before handing `(agentId, chunk)` to the listener.
    transcriptTail: (agentId) => engine.transcriptTailSnapshot(projectId, agentId),
    onTranscript: (listener) =>
      engine.onTranscript((pid, agent, chunk, offset) => {
        if (pid === projectId) listener(agent, chunk, offset);
      }),
    // Stage 13 R-A (reviewContext) — resolve the in-app Review view's context daemon-side: a pure READ
    // off the project's durable stores ⊕ a real `git diff`. Each store is opened PER CALL and closed by
    // the resolver (mirrors the operator-IPC server's openMail per-write pattern — no leaked handles).
    reviewContext: (reviewId) =>
      resolveReviewContext(
        {
          openReviews: () => openReviewStore(projectId),
          openSpecs: () => openSpecStore(projectId),
          openWorktrees: () => openWorktreeStore(projectId),
          gitReader: defaultGitRawReader,
        },
        reviewId,
      ),
  };

  // Stage 11 P1 (OP-IPC) — the cross-process operator-IPC server, started alongside the cadence
  // runner. It wraps this same `control` surface (+ opens the mail store per write), forwards each
  // tick as a `tick` push (wired below), and is closed on runner stop. Operator-uid-only by socket
  // permission; ZERO agent MCP tools.
  let ipcServer: OperatorIpcServer | undefined;
  let unsubTranscript: (() => void) | undefined;
  if (opts.operatorIpc != null && dataDir != null) {
    ipcServer = new OperatorIpcServer({
      control,
      projectId,
      socketPath: opts.operatorIpc.socketPath ?? operatorIpcSocketPath(dataDir),
      ...(opts.operatorIpc.onError != null ? { onError: opts.operatorIpc.onError } : {}),
    });
    await ipcServer.start();
    // Stage 12 C-P1 (TRANSCRIPT-SEAM) — forward each hosted pane's live bytes outward as the
    // `transcript:push` notification. This is EVENT-DRIVEN (not the tick cadence), so it rides its OWN
    // engine→IPC subscription rather than `onTick`; torn down in onStop alongside the server close.
    const server = ipcServer;
    unsubTranscript = control.onTranscript((agentId, chunk, offset) =>
      server.pushTranscript(agentId, chunk, offset),
    );
  }

  // P6 (watchdog-seam) — the injected pidAlive probe. Default: the real `kill(pid, 0)` OS check when
  // the pane exposes its PID; conservative `true` when no PID is available (FakePty / orphan panes
  // where the `paneExited` flag is the authoritative dead signal). Tests inject a fake.
  const pidAliveFor: (agent: RunningAgent) => boolean =
    opts.pidAliveFor ??
    ((agent: RunningAgent): boolean => {
      const pid = agent.pane.pid;
      if (pid == null) return true; // no PID — conservative: assume alive, rely on paneExited for dead
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });

  const reconcile = new ReconcileLoop({
    runningAgents: () =>
      liveRunningAgents(projectId, engine).filter(
        (agent) => !router.shouldSkip(projectId, agent.agentId),
      ),
    // P6 (watchdog-seam): derive a real LivenessInput from in-process engine state + the injected
    // pidAlive probe. Returns undefined only for orphan agents with no hosted pane (skip — Principle 9).
    livenessInputFor: (agent: RunningAgent) => {
      const obs = engine.livenessObservationFor(projectId, agent.agentId);
      if (obs == null) return undefined; // not hosted — skip (orphan with no live pane)
      return {
        ...obs,
        pidAlive: pidAliveFor(agent),
        hasWaitingItems: hasWaitingItems(projectId, agent.agentId),
        hasOutstandingActionable: hasOutstandingActionableMail(projectId, agent.agentId),
        requiresFinishBeforeYield:
          obs.turnStartedAt !== undefined && requiresFinishBeforeYield(projectId, agent.agentId),
      };
    },
    now,
    onBreak: opts.onBreak ?? (() => {}),
    // P3 §3a/§3d — the router IS the host-side markStuck owner: a watchdog escalation lands in its
    // STUCK set (so the daemon then skips the agent until `unstick`), and ALSO fans out to any
    // operator-supplied markStuck seam (surfacing). `co unstick`'s revertStuck+rewake clear it.
    markStuck: (agent) => {
      router.markStuck(agent);
      opts.markStuck?.(agent);
    },
    // P6 (watchdog-seam): thread the injectable nudge injector to each LivenessWatchdog. Absent →
    // the watchdog defaults to `defaultInjectNudge` (real catalog-driven injectMail). In sandbox
    // tests a no-op is injected so the tick's beat() completes without waiting on real timers.
    ...(opts.injectNudge !== undefined ? { injectNudge: opts.injectNudge } : {}),
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
  // Forward each tick as the operator-IPC `tick` push (D6 — the whole fresh snapshot) while still
  // honoring any caller `onTick`. Built only when either is present, so existing callers are unchanged.
  const onTick =
    ipcServer != null || opts.onTick != null
      ? (outcome: DaemonTickOutcome): void => {
          try {
            opts.onTick?.(outcome);
          } catch (error) {
            reportServeControlDiagnostic(
              opts.onError,
              new Error(`co-mcp serve: onTick hook failed: ${errorMessage(error)}`),
            );
          }
          if (ipcServer != null) ipcServer.pushTick(control.observe());
        }
      : undefined;
  const runner = new ConductorHostRunner({
    daemon,
    intervalMs: opts.intervalMs ?? 1000,
    control,
    ...(opts.scheduler != null ? { scheduler: opts.scheduler } : {}),
    ...(onTick != null ? { onTick } : {}),
    ...(opts.onError != null ? { onError: opts.onError } : {}),
    onStop: async () => {
      unsubTranscript?.(); // C-P1 — stop forwarding transcript pushes before tearing the socket down
      if (ipcServer != null) await ipcServer.close();
      try {
        await router.drain();
        await engine.closeAll();
      } finally {
        wtStoreForStop?.close();
      }
    },
  });

  if (opts.autoStart !== false) {
    try {
      runner.start();
    } catch (error) {
      try {
        await runner.stop();
      } catch (cleanupError) {
        reportServeControlDiagnostic(
          opts.onError,
          new Error(
            `co-mcp serve: cleanup after failed startup failed: ${errorMessage(cleanupError)}`,
          ),
        );
      }
      throw error;
    }
  }
  return runner;
}

/** Default host-live MCP path resolution for `co-mcp serve`, including provider auth materialization. */
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
      'co-mcp serve: a project id is required (usage: `co-mcp serve <projectId>`). The Conductor drives ' +
        'one project’s live set.',
    );
  }
  const registry = openRegistry();
  try {
    if (registry.pathFor(projectId) == null) {
      throw new Error(
        `co-mcp serve: unknown project id '${projectId}'. Pass the registered project id for this repo.`,
      );
    }
  } finally {
    registry.close();
  }
  const runner = await serveConductor({
    projectId,
    coMcpPaths: defaultServeCoMcpPaths(),
    // Stage 11 P1 (OP-IPC) — start the cross-process operator-IPC server so the desktop app can
    // observe + control + write over the Unix socket (operator-uid-only). Errors go to stderr.
    operatorIpc: {
      onError: (err) => console.error('[co-mcp serve] operator-ipc error:', err),
    },
    onTick: (o) =>
      console.error(
        `[co-mcp serve] tick ${o.tick} candidates=${o.candidateCount} ` +
          `cold=${o.coldCandidates.length} rewarmed=${o.reWarmed.length} ` +
          `selected=${o.selected ?? '-'} cadence=${o.cadenceFired}`,
      ),
    onError: (err) => console.error('[co-mcp serve] tick error:', err),
  });
  const shutdown = (): void => {
    void runner
      .stop()
      .then(() => {
        process.exitCode = 0;
      })
      .catch((error) => {
        console.error('[co-mcp serve] shutdown error:', error);
        process.exitCode = 1;
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
