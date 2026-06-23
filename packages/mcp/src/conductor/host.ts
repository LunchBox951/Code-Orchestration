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
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open as openFile, readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  GH_AUTH_TOKEN_COMMANDS,
  GH_AUTH_TOKEN_TIMEOUT_MS,
  NodePtyHost,
  OPERATOR,
  ghCommandPathEnv,
  githubHttpsCredentialEnv,
  resolveGhTokenFromEnv,
  defaultGitExec,
  defaultGitRawReader,
  defaultGitReader,
  assertDeleteAgentSubtreePreflight,
  deleteAgentSubtree,
  descendantsLeafFirst,
  isMissingBranchDeleteError,
  openArchiveStore,
  openDispatchStore,
  openMailStore,
  openRegistry,
  openReviewStore,
  openRosterStore,
  openSessionStore,
  openSpecStore,
  openWorktreeStore,
  createProviderUsageSource,
  defaultUsageSourceFactory,
  hasMeasuredCostField,
  parseClaudeTranscriptTurnCost,
  parseCodexTokenCount,
  queryLiveObservability,
  readLatestCodexTokenCountReadout,
  readLatestCodexRateLimits,
  reapExpiredArchives,
  waitingItems,
  openCodexLogsDb,
  resolveBudgetCap,
  QUIET_WINDOW_MS,
  type ArchiveEntry,
  type BreakSignal,
  type CodexTurnCost,
  type CodexTokenCountReadout,
  type CostRecorded,
  type DispatchStore,
  type InjectNudgeFn,
  type LiveObservabilitySnapshot,
  type MarkStuck,
  type ProjectId,
  type PtyHost,
  type ReviewContext,
  type RunningAgent,
  type TranscriptTail,
  type GitExec,
  type Provider,
  type ProviderAccount,
  type ProviderUsageSource,
  type UsageSourceFactory,
} from '@co/core';
import { ReconcileLoop } from '@co/core';
import {
  ConductorEngine,
  type CollectionDiagnostic,
  type TransportPair,
  type TurnCostCapture,
  type ToolActivityCapture,
} from './engine.js';
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
import {
  injectCaptureOptions,
  openHostLiveCapture,
  type HostLiveCapture,
} from './host-live-capture.js';

export { GH_AUTH_TOKEN_COMMANDS, GH_AUTH_TOKEN_TIMEOUT_MS } from '@co/core';

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
   * fires with `(agentId, generation, chunk)` on every new pane chunk. Returns an unsubscribe fn. The
   * operator-IPC server subscribes this to forward each chunk outward as the `transcript:push`
   * notification.
   */
  readonly onTranscript: (
    listener: (agentId: string, generation: number, chunk: string, offset: number) => void,
  ) => () => void;
  /**
   * Stage 13 R-A (reviewContext) — resolve `reviewId`'s review context (diff + criteria + refs) for the
   * in-app Review view. Async (it shells `git diff`); a READ — opens no long-lived handles, records NO
   * events. DEGRADES EXPLICITLY (Principle 9) — every failure mode is a named state, never a throw.
   */
  readonly reviewContext: (reviewId: string) => Promise<ReviewContext>;
  /**
   * B3 (deleteAgent) — tear down a coordinator's entire subtree: release all warm panes, clear router
   * suppression, then cascade-delete the durable roster/worktree/session/archive via the core primitive.
   * Fails loud (Principle 9) on unresolvable repoCwd; lets AggregateError from the core propagate so
   * the IPC layer surfaces partial-failure detail to the operator.
   */
  readonly deleteAgent: (agentId: string) => Promise<void>;
  /**
   * #131 (reclaimChild) — GRANULAR reclaim of a SINGLE leaf child: release its warm pane, clear router
   * suppression, then tear down just that agent's durable roster row / worktree / branch / session via
   * the same leaf-safe core primitive (`deleteAgentSubtree` on a childless leaf removes exactly that
   * agent — archiving an unmerged branch, removing the worktree, ending the session, freeing the
   * dispatch slot, so the active-child cap drops automatically). REFUSES (fails loud, Principle 9) a
   * child that still has descendants — the caller must use {@link deleteAgent} for a whole subtree.
   */
  readonly reclaimChild: (childId: string) => Promise<void>;
  /**
   * B5 (listArchive) — list archived (unmerged) branches. A READ; the app-side facade can fall back
   * to the static archive store when the socket is down (mirrors observe; never hangs, never throws).
   */
  readonly listArchive: () => Promise<readonly ArchiveEntry[]>;
  /**
   * B5 (restoreArchive) — un-archive `id`: remove the archive record so the reaper skips it. The
   * branch STAYS (no git delete). A control verb — fails loud when down (Principle 9).
   */
  readonly restoreArchive: (id: string) => Promise<void>;
  /**
   * B5 (purgeArchive) — hard-purge `id`: `git branch -D <branch>` then remove the archive record.
   * A control verb — fails loud when down (Principle 9).
   */
  readonly purgeArchive: (id: string) => Promise<void>;
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

export interface ConductorHostRunnerStopOptions {
  /** Wait for any active daemon/watchdog tick before running stop hooks. Default: true. */
  readonly waitForInFlight?: boolean;
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
  async stop(options: ConductorHostRunnerStopOptions = {}): Promise<void> {
    if (this.handle != null) {
      this.scheduler.clearInterval(this.handle);
      this.handle = null;
    }
    if (this.stopped) return;
    this.stopped = true;
    const waitForInFlight = options.waitForInFlight ?? true;
    if (waitForInFlight) {
      await this.inFlight;
      await this.watchdogInFlight;
    }
    await this.onStop?.();
  }

  /** Run one cadence beat and resolve only after that beat has completed. */
  async step(): Promise<void> {
    if (this.stopped) {
      throw new Error('ConductorHostRunner.step: runner has already been stopped.');
    }
    await this.beat({ rethrowTickErrors: true });
  }

  /**
   * One cadence beat: run a daemon tick unless a prior one is still in flight. If a turn is still
   * active, run only the reconcile watchdog so wedged sessions are still detected on cadence.
   */
  private async beat(options: { readonly rethrowTickErrors?: boolean } = {}): Promise<void> {
    if (this.inFlight != null) {
      this.runOverlapWatchdogBeat();
      return;
    }
    const run = this.runBeat(options.rethrowTickErrors === true);
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

  private async runBeat(rethrowTickErrors = false): Promise<void> {
    try {
      const outcome = await this.daemon.tick();
      this.onTick?.(outcome);
    } catch (error) {
      if (this.onError != null) this.onError(error);
      else console.error('[co-mcp serve] tick error:', error);
      if (rethrowTickErrors) throw error;
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

/**
 * [host-live capture · #78] Heuristic: does a pane chunk look like an interactive MCP-tool / command
 * approval prompt? Best-effort needle scan (case-insensitive) — only used by the armed capture harness
 * to flag-and-record a real prompt for later inspection; never gates any control flow.
 */
export function looksLikeApprovalPrompt(chunk: string): boolean {
  const lower = chunk.toLowerCase();
  return (
    (lower.includes('approve') || lower.includes('allow') || lower.includes('permission')) &&
    (lower.includes('tool') ||
      lower.includes('mcp') ||
      lower.includes('y/n') ||
      lower.includes('(y)') ||
      lower.includes('yes/no'))
  );
}

/**
 * [host-live capture · #67-adjacent] Extract candidate status lines from a pane chunk — non-empty
 * lines mentioning a usage/limit/reset token the sampler would parse. Best-effort; armed-capture only.
 */
export function statusLineCandidates(chunk: string): string[] {
  return chunk
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && /\b(usage|limit|reset|tokens?|%|context)\b/iu.test(line));
}

/**
 * [host-live capture · usage sample] Wrap the normal passive usage source when capture is armed so a
 * real dispatcher read records the exact snapshot it consumed. Unarmed capture gets no wrapper.
 */
export function hostLiveCaptureUsageSourceFactory(
  capture: HostLiveCapture | undefined,
  baseFactory: UsageSourceFactory = defaultUsageSourceFactory,
): UsageSourceFactory | undefined {
  if (capture?.armed !== true) return undefined;
  return (account: ProviderAccount): ProviderUsageSource => {
    const source = baseFactory(account);
    return {
      async read(provider) {
        const snapshot = await source.read(provider);
        capture.captureUsageSample({
          provider: snapshot.provider,
          account: snapshot.account,
          source: snapshot.source,
          raw: snapshot,
        });
        return snapshot;
      },
    };
  };
}

// ── PR-B COLLECTION — cost + tool-usage capture seams wired onto the real engine ───────────────────
//
// These are the PRODUCTION emitters the prior round left UNWIRED. `makeTurnCostCapture` is bound to the
// engine's `captureTurnCost`; `makeToolActivityRecorder` to its `onToolActivity`. Both open the project
// {@link DispatchStore} per call and record over L0 (program-data only — AC9/P12), and both are
// FAIL-SOFT: a thrown reader/record is swallowed (the engine also guards), so collection can never fail
// a live turn or MCP call. The provider readers are INJECTABLE seams so the wiring is hermetically
// testable (the integration test injects fixture readers + a temp store); the defaults are the real ones.

/** Per-turn provider usage readers (Claude transcript JSONL / Codex token_count) — injectable for tests. */
interface ClaudeTranscriptReadout {
  readonly jsonl: string;
  readonly path?: string;
  readonly sourceId?: string;
}

type ClaudeTranscriptRead = string | ClaudeTranscriptReadout;

type CodexTokenCountRead = unknown | CodexTokenCountReadout;

export interface TurnCostReaderDeps {
  /** Read the agent's isolated Claude transcript JSONL (the `usage` source). Default: read under isolated home. */
  readonly readClaudeTranscript?: (
    identity: HostedIdentity,
    latestSourceId?: string,
  ) => Promise<ClaudeTranscriptRead | undefined>;
  /** Read the agent's Codex `token_count` payload from `logs_2.sqlite`. Default: open it read-only. */
  readonly readCodexTokenCount?: (
    identity: HostedIdentity,
    latestSourceId?: string,
  ) => Promise<CodexTokenCountRead | undefined>;
  /** Open the project dispatch store. Default: {@link openDispatchStore}. */
  readonly openDispatch?: (projectId: ProjectId) => DispatchStore;
  /** Resolve the agent's task id from its identity. Default: the agent id (one task per agent in v1). */
  readonly taskFor?: (identity: HostedIdentity) => string;
}

/** Default task resolver — v1 files cost under the agent's own id (one logical task per agent). */
function defaultTaskFor(identity: HostedIdentity): string {
  return identity.agent;
}

/**
 * Lower a parsed provider per-turn usage onto a {@link CostRecorded}, or undefined when there is nothing
 * to record (so the caller records NOTHING — never a vacuous all-zero observation). PURE + exported so
 * the field mapping is unit-testable in isolation (the exact transcript/sqlite field names are the
 * `needsLiveVerification` contract).
 */
export function claudeTurnCostToObservation(
  identity: HostedIdentity,
  task: string,
  turn: number,
  cost: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadInputTokens?: number;
    readonly cacheCreationInputTokens?: number;
    readonly costUsd?: number;
  },
  sourceId?: string,
): CostRecorded | undefined {
  const obs: CostRecorded = {
    provider: 'claude',
    agent: identity.agent,
    task,
    turn,
    ...(sourceId !== undefined ? { source_id: sourceId } : {}),
    ...(cost.inputTokens !== undefined ? { input_tokens: cost.inputTokens } : {}),
    ...(cost.outputTokens !== undefined ? { output_tokens: cost.outputTokens } : {}),
    ...(cost.cacheReadInputTokens !== undefined
      ? { cache_read_input_tokens: cost.cacheReadInputTokens }
      : {}),
    ...(cost.cacheCreationInputTokens !== undefined
      ? { cache_creation_input_tokens: cost.cacheCreationInputTokens }
      : {}),
    ...(cost.costUsd !== undefined ? { cost_usd: cost.costUsd } : {}),
  };
  return hasMeasuredCostField(obs) ? obs : undefined;
}

/** Lower a parsed Codex per-turn usage onto a {@link CostRecorded} (tokens / usage-% — no dollars). */
export function codexTurnCostToObservation(
  identity: HostedIdentity,
  task: string,
  turn: number,
  cost: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
    readonly usedPct?: number;
  },
  sourceId?: string,
): CostRecorded | undefined {
  const obs: CostRecorded = {
    provider: 'codex',
    agent: identity.agent,
    task,
    turn,
    ...(sourceId !== undefined ? { source_id: sourceId } : {}),
    ...(cost.inputTokens !== undefined ? { input_tokens: cost.inputTokens } : {}),
    ...(cost.outputTokens !== undefined ? { output_tokens: cost.outputTokens } : {}),
    ...(cost.totalTokens !== undefined ? { total_tokens: cost.totalTokens } : {}),
    ...(cost.usedPct !== undefined ? { used_pct: cost.usedPct } : {}),
  };
  return hasMeasuredCostField(obs) ? obs : undefined;
}

/**
 * The per-agent last SESSION-CUMULATIVE Codex token reading, kept so a cumulative `total_token_usage`
 * payload can be recorded as the PER-TURN DELTA (this turn's cumulative minus the previous one). Codex's
 * `total_token_usage` is a running session total; recording it verbatim per turn would over-count
 * massively once {@link CostProjector} sums the observations. `usedPct` is a point-in-time gauge (not
 * additive) and is NOT delta-d.
 */
interface CodexCumulativeReading {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

/**
 * Resolve a parsed Codex {@link CodexTurnCost} into the PER-TURN delta to record, updating `lastByAgent`.
 * For a per-turn (`cumulative: false`) reading the counts are already the delta — pass them through. For
 * a session-cumulative (`cumulative: true`) reading, subtract the previous cumulative for this agent and
 * store the new cumulative; a non-positive delta (no new tokens since last turn, or a session reset that
 * lowered the total) records nothing for those fields. `usedPct` is passed through untouched (it is a
 * gauge, not a sum).
 */
function codexPerTurnDelta(
  agent: string,
  parsed: CodexTurnCost,
  lastByAgent: Map<string, CodexCumulativeReading>,
  priorCumulative: CodexCumulativeReading | undefined,
): {
  readonly cost: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    usedPct?: number;
  };
  readonly cumulative?: CodexCumulativeReading;
} {
  if (!parsed.cumulative) {
    const cost = {
      ...(parsed.inputTokens !== undefined ? { inputTokens: parsed.inputTokens } : {}),
      ...(parsed.outputTokens !== undefined ? { outputTokens: parsed.outputTokens } : {}),
      ...(parsed.totalTokens !== undefined ? { totalTokens: parsed.totalTokens } : {}),
      ...(parsed.usedPct !== undefined ? { usedPct: parsed.usedPct } : {}),
    };
    const cumulative = advanceCumulativeReading(lastByAgent.get(agent) ?? priorCumulative, cost);
    if (cumulative !== undefined) lastByAgent.set(agent, cumulative);
    return { cost, ...(cumulative !== undefined ? { cumulative } : {}) };
  }
  const prev = lastByAgent.get(agent) ?? priorCumulative;
  const current: CodexCumulativeReading = {
    ...(parsed.inputTokens !== undefined ? { inputTokens: parsed.inputTokens } : {}),
    ...(parsed.outputTokens !== undefined ? { outputTokens: parsed.outputTokens } : {}),
    ...(parsed.totalTokens !== undefined ? { totalTokens: parsed.totalTokens } : {}),
  };
  lastByAgent.set(agent, current);
  if (prev != null && cumulativeReadingReset(current, prev)) {
    return {
      cost: {
        ...(current.inputTokens !== undefined ? { inputTokens: current.inputTokens } : {}),
        ...(current.outputTokens !== undefined ? { outputTokens: current.outputTokens } : {}),
        ...(current.totalTokens !== undefined ? { totalTokens: current.totalTokens } : {}),
        ...(parsed.usedPct !== undefined ? { usedPct: parsed.usedPct } : {}),
      },
      cumulative: current,
    };
  }
  return {
    cost: {
      ...positiveDelta('inputTokens', current.inputTokens, prev?.inputTokens),
      ...positiveDelta('outputTokens', current.outputTokens, prev?.outputTokens),
      ...positiveDelta('totalTokens', current.totalTokens, prev?.totalTokens),
      ...(parsed.usedPct !== undefined ? { usedPct: parsed.usedPct } : {}),
    },
    cumulative: current,
  };
}

function advanceCumulativeReading(
  previous: CodexCumulativeReading | undefined,
  delta: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
  },
): CodexCumulativeReading | undefined {
  const next: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  } = {
    ...(previous?.inputTokens !== undefined ? { inputTokens: previous.inputTokens } : {}),
    ...(previous?.outputTokens !== undefined ? { outputTokens: previous.outputTokens } : {}),
    ...(previous?.totalTokens !== undefined ? { totalTokens: previous.totalTokens } : {}),
  };
  if (delta.inputTokens !== undefined)
    next.inputTokens = (next.inputTokens ?? 0) + delta.inputTokens;
  if (delta.outputTokens !== undefined) {
    next.outputTokens = (next.outputTokens ?? 0) + delta.outputTokens;
  }
  if (delta.totalTokens !== undefined)
    next.totalTokens = (next.totalTokens ?? 0) + delta.totalTokens;
  return Object.keys(next).length > 0 ? next : undefined;
}

function cumulativeReadingReset(
  current: CodexCumulativeReading,
  previous: CodexCumulativeReading,
): boolean {
  return (
    lowerThanPrevious(current.inputTokens, previous.inputTokens) ||
    lowerThanPrevious(current.outputTokens, previous.outputTokens) ||
    lowerThanPrevious(current.totalTokens, previous.totalTokens)
  );
}

function lowerThanPrevious(current: number | undefined, previous: number | undefined): boolean {
  return current !== undefined && previous !== undefined && current < previous;
}

/** The positive per-turn delta for one cumulative field, or `{}` when there is no new usage to record. */
function positiveDelta(
  key: 'inputTokens' | 'outputTokens' | 'totalTokens',
  current: number | undefined,
  previous: number | undefined,
): { inputTokens?: number; outputTokens?: number; totalTokens?: number } {
  if (current === undefined) return {};
  const delta = current - (previous ?? 0);
  return delta > 0 ? { [key]: delta } : {};
}

/**
 * Default Claude transcript reader. Claude Code, run with CLAUDE_CONFIG_DIR = the agent's isolated home,
 * writes its session transcript under `${isolatedHome}/projects/<slugified-cwd>/<session-uuid>.jsonl`
 * — each assistant message line carrying `message.usage` ({ input_tokens, output_tokens,
 * cache_read_input_tokens, cache_creation_input_tokens }). NOTHING in co writes a
 * `co-transcript-<agent>.jsonl`, so the prior reader targeted a path that never existed (a dead seam).
 *
 * This globs every `projects/**\/*.jsonl` under the isolated home, picks the NEWEST by mtime (the file
 * the most-recent turn appended to), and returns its contents for {@link parseClaudeTranscriptTurnCost}.
 * FAIL-SOFT: a missing tree / unreadable file / no transcript resolves `undefined` (record nothing) and
 * never throws the turn.
 *
 * needsLiveVerification: this now targets the REAL `projects/**\/*.jsonl` tree Claude Code writes; the
 * exact per-line `message.usage` field mapping still needs a real `claude` run to confirm end-to-end.
 */
const defaultReadClaudeTranscript = (
  isolatedHomeDirFor: ((agent: string) => string) | undefined,
): ((
  identity: HostedIdentity,
  latestSourceId?: string,
) => Promise<ClaudeTranscriptReadout | undefined>) => {
  return async (identity, latestSourceId) => {
    if (isolatedHomeDirFor == null) return undefined;
    const previous = parseClaudeJsonlSourceId(latestSourceId);
    if (previous !== undefined) {
      const read = await readClaudeTranscriptFromCursor(previous);
      if (read !== undefined) return read ?? undefined;
    }
    const home = isolatedHomeDirFor(identity.agent).replace(/\/+$/u, '');
    const newest = await newestClaudeTranscriptPath(join(home, 'projects'));
    if (newest == null) return undefined;
    return readWholeClaudeTranscript(newest);
  };
};

async function readClaudeTranscriptFromCursor(previous: {
  readonly path: string;
  readonly offset: number;
}): Promise<ClaudeTranscriptReadout | null | undefined> {
  let info: { readonly size: number };
  try {
    info = await stat(previous.path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined; // cursor file gone (benign)
    throw err; // real failure → captureTurnCost's caller routes it through onCollectionError (Principle 9)
  }
  if (info.size > previous.offset) {
    const text = await readFileRange(previous.path, previous.offset, info.size);
    const complete = completeJsonlPrefix(text);
    if (complete.byteLength <= 0) return null;
    const offset = previous.offset + complete.byteLength;
    return {
      path: previous.path,
      jsonl: complete.jsonl,
      sourceId: claudeJsonlSourceId(previous.path, offset),
    };
  }
  if (info.size < previous.offset) return readWholeClaudeTranscript(previous.path);
  const newestPeer = await newestClaudeTranscriptPath(dirname(previous.path), { recursive: false });
  return newestPeer !== undefined && newestPeer !== previous.path
    ? readWholeClaudeTranscript(newestPeer)
    : null;
}

async function readWholeClaudeTranscript(
  path: string,
): Promise<ClaudeTranscriptReadout | undefined> {
  try {
    const text = await readFile(path, 'utf8');
    const complete = completeJsonlPrefix(text);
    return {
      path,
      jsonl: complete.jsonl,
      sourceId: claudeJsonlSourceId(path, complete.byteLength),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined; // file vanished (benign)
    throw err; // real failure → captureTurnCost's caller routes it through onCollectionError (Principle 9)
  }
}

async function readFileRange(path: string, start: number, end: number): Promise<string> {
  const handle = await openFile(path, 'r');
  try {
    const buffer = Buffer.alloc(Math.max(0, end - start));
    let totalRead = 0;
    while (totalRead < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        totalRead,
        buffer.length - totalRead,
        start + totalRead,
      );
      if (bytesRead === 0) break;
      totalRead += bytesRead;
    }
    if (totalRead < buffer.length) return buffer.subarray(0, totalRead).toString('utf8');
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

function completeJsonlPrefix(text: string): {
  readonly jsonl: string;
  readonly byteLength: number;
} {
  let jsonl = '';
  let byteLength = 0;
  const segments = text.match(/[^\n]*(?:\n|$)/gu) ?? [];
  for (const segment of segments) {
    if (segment.length === 0) continue;
    const endsWithNewline = segment.endsWith('\n');
    const line = segment.replace(/\r?\n$/u, '');
    if (!endsWithNewline && line.trim().length > 0) {
      try {
        JSON.parse(line);
      } catch {
        break;
      }
    }
    jsonl += segment;
    byteLength += Buffer.byteLength(segment, 'utf8');
  }
  return { jsonl, byteLength };
}

/**
 * Recursively find the newest-by-mtime `*.jsonl` under `projectsDir` (Claude Code's per-cwd transcript
 * tree). Tolerates a missing/vanished entry (ENOENT — the benign "no usage yet" case) but rethrows any
 * other readdir/stat failure so a persistent real fault (perms/IO) reaches the onCollectionError seam
 * (Principle 9 — no silent failures).
 */
async function newestClaudeTranscriptPath(
  projectsDir: string,
  opts: { readonly recursive?: boolean } = {},
): Promise<string | undefined> {
  const recursive = opts.recursive ?? true;
  let newest: { path: string; mtimeMs: number } | undefined;
  const walk = async (current: string): Promise<void> => {
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return; // dir not created yet (benign)
      throw err; // real failure → captureTurnCost's caller routes it through onCollectionError (Principle 9)
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (recursive) await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        try {
          const info = await stat(full);
          if (newest == null || info.mtimeMs > newest.mtimeMs) {
            newest = { path: full, mtimeMs: info.mtimeMs };
          }
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') continue; // entry vanished (benign)
          throw err; // real failure → captureTurnCost's caller routes it through onCollectionError (Principle 9)
        }
      }
    }
  };
  await walk(projectsDir);
  return newest?.path;
}

/** Default Codex token_count reader: open the per-agent isolated `logs_2.sqlite` read-only. */
const defaultReadCodexTokenCount = (
  isolatedHomeDirFor: ((agent: string) => string) | undefined,
): ((
  identity: HostedIdentity,
  latestSourceId?: string,
) => Promise<CodexTokenCountRead | undefined>) => {
  return async (identity, latestSourceId) => {
    if (isolatedHomeDirFor == null) return undefined;
    const home = isolatedHomeDirFor(identity.agent).replace(/\/+$/u, '');
    const path = `${home}/logs_2.sqlite`;
    try {
      const db = openCodexLogsDb(path);
      try {
        const afterSourceId = codexLogSourceIdFromCostSourceId(latestSourceId);
        return readLatestCodexTokenCountReadout(
          db,
          afterSourceId !== undefined ? { afterSourceId } : {},
        );
      } finally {
        db.close();
      }
    } catch (err) {
      // node:sqlite throws ERR_SQLITE_ERROR (not an ENOENT ErrnoException) for a read-only open of a
      // missing db — errcode 14 (SQLITE_CANTOPEN) is the benign "logs_2.sqlite not created yet" case.
      if ((err as { readonly errcode?: number })?.errcode === 14) return undefined;
      throw err; // corrupt/locked/perms db → captureTurnCost's caller routes it through onCollectionError (Principle 9)
    }
  };
};

/**
 * Build a hosted-session usage source factory scoped to the pane's isolated home. Claude statusLine
 * collection writes `${isolatedHome}/co-statusline.json`; reading it here keeps passive usage refreshes
 * identity-scoped instead of depending on daemon-global `CO_CLAUDE_STATUSLINE_PATH`.
 */
export function makeHostedUsageSourceFactory(
  identity: HostedIdentity,
  isolatedHomeDirFor: (agent: string) => string,
): UsageSourceFactory {
  return (account) => {
    if (identity.provider === 'claude' && account.provider === 'claude') {
      const statusLinePath = join(
        isolatedHomeDirFor(identity.agent).replace(/\/+$/u, ''),
        'co-statusline.json',
      );
      return createProviderUsageSource('claude', {
        account: account.account,
        cli: async () => {
          throw new Error('hosted Claude usage source skips daemon-global auth preflight');
        },
        readStatusLine: async () => JSON.parse(await readFile(statusLinePath, 'utf8')),
      });
    }
    if (identity.provider === 'codex' && account.provider === 'codex') {
      const logsPath = join(
        isolatedHomeDirFor(identity.agent).replace(/\/+$/u, ''),
        'logs_2.sqlite',
      );
      return createProviderUsageSource('codex', {
        account: account.account,
        cli: async () => {
          throw new Error('hosted Codex usage source skips daemon-global doctor preflight');
        },
        readRateLimits: async () => {
          const db = openCodexLogsDb(logsPath);
          try {
            return readLatestCodexRateLimits(db);
          } finally {
            db.close();
          }
        },
        sessionRollout: async () => undefined,
      });
    }
    return defaultUsageSourceFactory(account);
  };
}

/**
 * Build the engine's `captureTurnCost` closure for `projectId`. On each non-errored turn it reads the
 * provider's per-turn usage, lowers it onto a {@link CostRecorded}, and records it (with any configured
 * budget cap so the near-budget observability signal still fires). Missing usage ⇒ records nothing.
 * FAIL-SOFT: any throw is swallowed (the engine guards too). Exported + seam-injectable so the
 * production wiring is hermetically testable.
 */
export function makeTurnCostCapture(
  projectId: ProjectId,
  deps: TurnCostReaderDeps & { readonly isolatedHomeDirFor?: (agent: string) => string } = {},
): (capture: TurnCostCapture) => Promise<void> {
  const openDispatch = deps.openDispatch ?? openDispatchStore;
  const taskFor = deps.taskFor ?? defaultTaskFor;
  const readClaude =
    deps.readClaudeTranscript ?? defaultReadClaudeTranscript(deps.isolatedHomeDirFor);
  const readCodex = deps.readCodexTokenCount ?? defaultReadCodexTokenCount(deps.isolatedHomeDirFor);
  // Per-agent cumulative-token memory, lives for the lifetime of this capture closure (one per project,
  // built once in serveConductor) so Codex's session-cumulative `total_token_usage` is delta-d per turn.
  const codexLastCumulative = new Map<string, CodexCumulativeReading>();
  return async ({ identity, turn }: TurnCostCapture): Promise<void> => {
    const task = taskFor(identity);
    const latestSourceId = latestCostSourceId(
      openDispatch,
      projectId,
      identity.provider,
      identity.agent,
      task,
    );
    const obs = await readTurnCostObservation(
      identity,
      task,
      turn,
      readClaude,
      readCodex,
      codexLastCumulative,
      latestSourceId,
    );
    if (obs == null) return; // no usage observed — record nothing (never a fabricated zero).
    const store = openDispatch(projectId);
    try {
      const budget = resolveBudgetCap(projectId);
      const durableTurn = store.nextCostTurn(obs.provider, obs.agent, obs.task, obs.turn);
      store.recordCost(durableTurn === obs.turn ? obs : { ...obs, turn: durableTurn }, budget);
    } finally {
      store.close();
    }
  };
}

function latestCostSourceId(
  openDispatch: (projectId: ProjectId) => DispatchStore,
  projectId: ProjectId,
  provider: Provider,
  agent: string,
  task: string,
): string | undefined {
  const store = openDispatch(projectId);
  try {
    return store.latestCostSourceId(provider, agent, task);
  } finally {
    store.close();
  }
}

function normalizeClaudeTranscriptRead(
  readout: ClaudeTranscriptRead | undefined,
): ClaudeTranscriptReadout | undefined {
  if (readout === undefined) return undefined;
  return typeof readout === 'string' ? { jsonl: readout } : readout;
}

function unreadClaudeTranscriptSlice(
  readout: ClaudeTranscriptReadout,
  latestSourceId: string | undefined,
): { readonly jsonl: string; readonly sourceId: string } {
  if (readout.sourceId !== undefined) {
    return { jsonl: readout.jsonl, sourceId: readout.sourceId };
  }
  if (readout.path === undefined) {
    return {
      jsonl: readout.jsonl,
      sourceId: `claude-hash:v1:${hashText(readout.jsonl)}`,
    };
  }
  const previous = parseClaudeJsonlSourceId(latestSourceId);
  const allBytes = Buffer.from(readout.jsonl, 'utf8');
  const startOffset =
    previous !== undefined && previous.path === readout.path
      ? Math.min(previous.offset, allBytes.length)
      : 0;
  const complete = completeJsonlPrefix(allBytes.subarray(startOffset).toString('utf8'));
  return {
    jsonl: complete.jsonl,
    sourceId: claudeJsonlSourceId(readout.path, startOffset + complete.byteLength),
  };
}

function claudeJsonlSourceId(path: string, line: number): string {
  return `claude-jsonl:v1:${Buffer.from(path).toString('base64url')}:${line}`;
}

function parseClaudeJsonlSourceId(
  sourceId: string | undefined,
): { readonly path: string; readonly offset: number } | undefined {
  if (sourceId === undefined) return undefined;
  const match = /^claude-jsonl:v1:([^:]+):(\d+)$/u.exec(sourceId);
  if (!match) return undefined;
  return {
    path: Buffer.from(match[1]!, 'base64url').toString('utf8'),
    offset: Number(match[2]),
  };
}

function normalizeCodexTokenRead(
  readout: CodexTokenCountRead | undefined,
): CodexTokenCountReadout | undefined {
  if (readout === undefined) return undefined;
  if (isCodexTokenCountReadout(readout)) return readout;
  return {
    payload: readout,
    sourceId: `codex-hash:v1:${hashText(JSON.stringify(readout))}`,
  };
}

function isCodexTokenCountReadout(value: unknown): value is CodexTokenCountReadout {
  return (
    typeof value === 'object' &&
    value !== null &&
    'payload' in value &&
    typeof (value as { readonly sourceId?: unknown }).sourceId === 'string'
  );
}

function codexCostSourceId(
  baseSourceId: string,
  cumulative: CodexCumulativeReading | undefined,
): string {
  return (
    `codex-source:v1:${baseSourceId}:` +
    `${cumulative?.inputTokens ?? ''}:${cumulative?.outputTokens ?? ''}:${cumulative?.totalTokens ?? ''}`
  );
}

function codexLogSourceIdFromCostSourceId(sourceId: string | undefined): string | undefined {
  if (sourceId === undefined) return undefined;
  const match = /^codex-source:v1:(.*):[^:]*:[^:]*:[^:]*$/u.exec(sourceId);
  if (match) return match[1];
  const old = /^codex-cumulative:v1:(.*):[^:]*:[^:]*:[^:]*$/u.exec(sourceId);
  if (old) return old[1];
  const turn = /^codex-turn:v1:(.*)$/u.exec(sourceId);
  return turn?.[1];
}

function parseCodexCumulativeSourceId(
  sourceId: string | undefined,
): CodexCumulativeReading | undefined {
  if (sourceId === undefined) return undefined;
  const match =
    /^codex-source:v1:.*:([^:]*):([^:]*):([^:]*)$/u.exec(sourceId) ??
    /^codex-cumulative:v1:.*:([^:]*):([^:]*):([^:]*)$/u.exec(sourceId);
  if (!match) return undefined;
  return {
    ...sourceNumber('inputTokens', match[1]!),
    ...sourceNumber('outputTokens', match[2]!),
    ...sourceNumber('totalTokens', match[3]!),
  };
}

function sourceNumber(
  key: 'inputTokens' | 'outputTokens' | 'totalTokens',
  raw: string,
): CodexCumulativeReading {
  if (raw.length === 0) return {};
  const value = Number(raw);
  return Number.isFinite(value) ? { [key]: value } : {};
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

async function readTurnCostObservation(
  identity: HostedIdentity,
  task: string,
  turn: number,
  readClaude: (
    identity: HostedIdentity,
    latestSourceId?: string,
  ) => Promise<ClaudeTranscriptRead | undefined>,
  readCodex: (
    identity: HostedIdentity,
    latestSourceId?: string,
  ) => Promise<CodexTokenCountRead | undefined>,
  codexLastCumulative: Map<string, CodexCumulativeReading>,
  latestSourceId: string | undefined,
): Promise<CostRecorded | undefined> {
  const provider: Provider = identity.provider;
  if (provider === 'claude') {
    const readout = normalizeClaudeTranscriptRead(await readClaude(identity, latestSourceId));
    if (readout == null) return undefined;
    const sliced = unreadClaudeTranscriptSlice(readout, latestSourceId);
    if (sliced.jsonl.trim().length === 0) return undefined;
    const parsed = parseClaudeTranscriptTurnCost(sliced.jsonl);
    return parsed
      ? claudeTurnCostToObservation(identity, task, turn, parsed, sliced.sourceId)
      : undefined;
  }
  const readout = normalizeCodexTokenRead(await readCodex(identity, latestSourceId));
  if (readout == null) return undefined;
  const parsed = parseCodexTokenCount(readout.payload);
  if (!parsed) return undefined;
  // Codex `total_token_usage` is session-cumulative — record only the per-turn DELTA so cost_rollup's
  // SUM across turns reflects real per-turn spend, not a cumulative-of-cumulatives over-count.
  const priorCumulative = parseCodexCumulativeSourceId(latestSourceId);
  const perTurn = codexPerTurnDelta(identity.agent, parsed, codexLastCumulative, priorCumulative);
  const sourceId = codexCostSourceId(readout.sourceId, perTurn.cumulative);
  return codexTurnCostToObservation(identity, task, turn, perTurn.cost, sourceId);
}

/**
 * Build the engine's `onToolActivity` closure for `projectId`: record one durable `tool.invoked` per
 * completed (`end`) tool call into the per-agent tool-usage projection. Only `end` events are recorded
 * (a `start`/`end` pair is one call). A non-`ok` end is a tool error; an `ok` `co_*` end is a productive
 * call. FAIL-SOFT — a thrown record never breaks the live MCP call path.
 */
export function makeToolActivityRecorder(
  projectId: ProjectId,
  deps: {
    readonly openDispatch?: (projectId: ProjectId) => DispatchStore;
    readonly taskFor?: (i: HostedIdentity) => string;
  } = {},
): (capture: ToolActivityCapture) => void {
  const openDispatch = deps.openDispatch ?? openDispatchStore;
  const taskFor = deps.taskFor ?? defaultTaskFor;
  return ({ identity, turn, activity }: ToolActivityCapture): void => {
    if (activity.phase !== 'end') return; // one record per completed call (start/end is one call).
    const store = openDispatch(projectId);
    try {
      // NOT-YET-DERIVED: `redundant_read` / `permission_ask` are deliberately left unset — the
      // ToolActivityEvent seam carries no such signal yet (only phase/tool/ok/durationMs), so both
      // rollup columns stay 0 ("no signal yet observed", NOT "zero friction confirmed"). See
      // tool-usage-projector.ts. (stillNeedsLive.)
      store.recordToolInvoked({
        agent: identity.agent,
        task: taskFor(identity),
        tool: activity.tool,
        turn,
        ok: activity.ok === true,
        ...(activity.durationMs !== undefined ? { duration_ms: activity.durationMs } : {}),
      });
    } finally {
      store.close();
    }
  };
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

function collectionDiagnosticError(diagnostic: CollectionDiagnostic): Error {
  const tool = diagnostic.kind === 'tool' ? `/${diagnostic.activity?.tool ?? 'unknown-tool'}` : '';
  return new Error(
    `co-mcp serve: ${diagnostic.kind}${tool} collection failed for ` +
      `'${diagnostic.identity.agent}' turn ${diagnostic.turn}: ${errorMessage(diagnostic.error)}`,
    { cause: diagnostic.error },
  );
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
  /** Mutating git seam for delete/purge/reaper control paths. Defaults to production git. */
  readonly gitExec?: GitExec;
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
  /**
   * [host-live capture] The observation harness (#77/#78). When armed (operator set
   * `CO_HOST_LIVE_CAPTURE=<dir>`), its `onPasteEcho` is spread into every hosted turn's
   * `injectOptions` so a real provider's composer echo is recorded — finalizing the codex
   * collapsed-paste PLACEHOLDER. INERT by default ({@link openHostLiveCapture} returns a no-op when
   * the env is unset), so production carries no overhead. {@link runServeConductor} always wires it,
   * so it arms on a real run — it is NOT test-only.
   */
  readonly hostLiveCapture?: HostLiveCapture;
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
  const gitExec = opts.gitExec ?? defaultGitExec;
  const pty = opts.pty ?? (await NodePtyHost.create());

  // P2 / AC-S10-2 — lazy placement-spawn gate: breaks the construction cycle (gate wraps engine).
  // [host-live] isolatedHomeDirFor: per-agent isolated home dir under the project data dir.
  let spawnGate: EngineReviewerSpawnGate | undefined;
  let ownedWtStore: ReturnType<typeof openWorktreeStore> | undefined;
  let isolatedHomeDirFor: ((agent: string) => string) | undefined;
  // The project data dir backs both the per-pane isolated homes (P2) and the operator-IPC socket
  // (Stage 11 P1) — derive it once when either is needed.
  // repoCwd is the project's registered repo working directory; resolved once here for the reaper
  // tick (Principle 9: deleteAgent resolves it per-call so it can fail loud on unregistered projects).
  let dataDir: string | undefined;
  let repoCwdForReaper: string | undefined;
  {
    const registry = openRegistry();
    try {
      if (opts.coMcpPaths != null || opts.operatorIpc != null) {
        dataDir = registry.dataDirFor(projectId);
      }
      repoCwdForReaper = registry.pathFor(projectId) ?? undefined;
    } finally {
      registry.close();
    }
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
      // Give the SERVER side the same diagnostics log the provider's bridge writes
      // (`${isolatedHomeDir}/mcp/bridge.log`, matching buildHostedLaunchSpec's CO_MCP_BRIDGE_LOG).
      // Without it the prod transport logged no server_start/server_listening/server_recv, so an
      // MCP-surface failure (F1) was invisible — only the bridge's one-sided `start` line existed.
      const bridgeLogPath = `${isolatedHomeDir.replace(/\/+$/u, '')}/mcp/bridge.log`;
      return createSocketBridgeTransportPair(socketPath, bridgeLogPath);
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
  // [host-live capture] Spread the armed capture's onPasteEcho into every hosted turn's injectOptions
  // so a real provider's composer echo is recorded (#77). Inert (adds nothing) when unarmed.
  const injectCapture =
    opts.hostLiveCapture != null ? injectCaptureOptions(opts.hostLiveCapture) : {};
  // PR-B COLLECTION — bind the production cost + tool-usage emitters onto the engine. Both record into
  // the project DispatchStore (program-data only); both are fail-soft. Bound here, on the real engine,
  // so a live `co-mcp serve` run actually records (the prior round left these seams DEAD).
  const captureTurnCost = makeTurnCostCapture(projectId, {
    ...(isolatedHomeDirFor != null ? { isolatedHomeDirFor } : {}),
  });
  const recordToolActivity = makeToolActivityRecorder(projectId);
  // COMPOSE the two usage-source wirings so neither feature is dropped at the single engine sink:
  //  - #81 provides per-identity isolated provider readers (the pane's own statusLine/transcript), and
  //  - #84 wraps a base reader so an armed host-live capture records the exact snapshot consumed.
  // For an isolated run, wrap #81's per-identity base in #84's capture wrapper (capture-over-isolated);
  // for the non-isolated run, fall back to the static capture-over-default factory below.
  const usageSourceFactoryFor =
    isolatedHomeDirFor != null
      ? (identity: HostedIdentity): UsageSourceFactory => {
          const base = makeHostedUsageSourceFactory(identity, isolatedHomeDirFor);
          return hostLiveCaptureUsageSourceFactory(opts.hostLiveCapture, base) ?? base;
        }
      : undefined;
  const usageSourceFactory = hostLiveCaptureUsageSourceFactory(opts.hostLiveCapture);
  const engine = new ConductorEngine({
    pty,
    makeTransport,
    now,
    quietWindow: opts.quietWindow ?? realQuietWindow,
    reviewerSpawnGate: () => spawnGate,
    captureTurnCost,
    onToolActivity: recordToolActivity,
    ...(usageSourceFactoryFor != null ? { usageSourceFactoryFor } : {}),
    onCollectionError: (diagnostic) =>
      reportServeControlDiagnostic(opts.onError, collectionDiagnosticError(diagnostic)),
    ...(spawnSpecFor != null ? { spawnSpecFor } : {}),
    ...('onPasteEcho' in injectCapture ? { injectOptions: injectCapture } : {}),
    ...(usageSourceFactory != null ? { usageSourceFactory } : {}),
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

  // [host-live capture] MCP-approval observation point (#78): scan each hosted pane's transcript for
  // an interactive approval prompt and record an excerpt, so a real run reveals whether the config
  // pre-grant + launch flag actually suppress the codex MCP-tool prompt. Subscribes ONLY when armed
  // (inert by default — zero overhead). The unsubscribe is torn down with the engine on stop.
  if (opts.hostLiveCapture?.armed === true) {
    const capture = opts.hostLiveCapture;
    engine.onTranscript((pid, agentId, _generation, chunk, _offset, provider) => {
      if (pid !== projectId) return;
      // #78 — an interactive MCP-tool approval prompt in the pane stream means the pre-grant did NOT
      // suppress it (the codex pane would deadlock). Record an excerpt so the real prompt is captured.
      if (looksLikeApprovalPrompt(chunk)) {
        capture.captureMcpApproval({
          agent: agentId,
          provider,
          tool: 'unknown', // the specific tool is not in the raw pane stream; the excerpt has context
          paneExcerpt: chunk.slice(0, 2048),
          promptDetected: true,
        });
      }
      // #67-adjacent — capture a Claude status line as the usage sampler would see it, so the parse
      // format is verified against a real binary.
      if (provider === 'claude') {
        for (const line of statusLineCandidates(chunk)) {
          capture.captureClaudeStatusLine({ agent: agentId, rawLine: line });
        }
      }
    });
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
  const assertReclaimableChildLeaf = (childId: string): void => {
    assertDeleteAgentSubtreePreflight(projectId, childId);
    const roster = openRosterStore(projectId);
    try {
      const agent = roster.getAgent(childId);
      if (agent == null) {
        throw new Error(`co-mcp serve: reclaimChild: child agent '${childId}' not found.`);
      }
      if (agent.parent === OPERATOR) {
        throw new Error(
          `co-mcp serve: reclaimChild: '${childId}' is a root/operator-owned agent — ` +
            'refusing a granular child reclaim. Use deleteAgent to tear down a root subtree.',
        );
      }
      const descendants = descendantsLeafFirst(roster.listAgents(), childId);
      if (descendants.length > 0) {
        throw new Error(
          `co-mcp serve: reclaimChild: '${childId}' still has ${descendants.length} ` +
            `descendant(s) — refusing a granular reclaim. Use deleteAgent to tear down the whole subtree.`,
        );
      }
    } finally {
      roster.close();
    }
  };
  const control: ConductorControlSurface = {
    router,
    observe: () => queryLiveObservability(projectId, liveProvider),
    // Stage 12 C-P1 (TRANSCRIPT-SEAM) — back the transcript accessors with the running engine, closing
    // over THIS project: the tail is the engine's bounded per-agent buffer; onTranscript filters the
    // engine's global stream down to this project before handing `(agentId, generation, chunk)` to the
    // listener.
    transcriptTail: (agentId) => engine.transcriptTailSnapshot(projectId, agentId),
    onTranscript: (listener) =>
      engine.onTranscript((pid, agent, generation, chunk, offset) => {
        if (pid === projectId) listener(agent, generation, chunk, offset);
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
    // B3 (deleteAgent) — compose hook: suppress daemon selection, release warm panes, then cascade-delete
    // the durable subtree. Suppression is cleared only after durable teardown succeeds, so a failed delete
    // cannot cold-start a surviving agent. Each call opens the registry to resolve repoCwd (Principle 9:
    // fail loud if the project is not registered). AggregateError from deleteAgentSubtree propagates.
    deleteAgent: async (agentId: string): Promise<void> => {
      // Resolve repoCwd per call: open + close the registry (mirrors the reviewContext store pattern).
      const registry = openRegistry();
      let repoCwd: string;
      try {
        const p = registry.pathFor(projectId);
        if (p == null) {
          throw new Error(
            `co-mcp serve: deleteAgent: project '${projectId}' is not registered — cannot resolve repoCwd.`,
          );
        }
        repoCwd = p;
      } finally {
        registry.close();
      }

      // Compute the leaf-first id list (descendants + root) from the roster.
      assertDeleteAgentSubtreePreflight(projectId, agentId);
      const roster = openRosterStore(projectId);
      let ids: string[];
      try {
        const agents = roster.listAgents();
        if (roster.getAgent(agentId) == null) {
          throw new Error(`co-mcp serve: deleteAgent: root agent '${agentId}' not found.`);
        }
        ids = [...descendantsLeafFirst(agents, agentId).map((a) => a.agentId), agentId];
      } finally {
        roster.close();
      }

      // Suppress every id before releasing panes. If durable teardown fails, these ids stay suppressed so
      // the daemon does not cold-start any surviving roster row.
      for (const id of ids) router.recordStopped(id);

      // Release every warm pane — error-isolated so one rejecting `hosted.session.close()` cannot strand
      // the remaining releases OR the durable teardown below (mirrors the best-effort spirit of
      // `engine.closeAll`). Collect any failures and surface them after the durable teardown still runs
      // (never silently swallowed — Principle 9).
      const releaseErrors: Error[] = [];
      for (const id of ids) {
        try {
          await engine.release(projectId, id, {});
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          releaseErrors.push(err);
          reportServeControlDiagnostic(
            opts.onError,
            new Error(`co-mcp serve: deleteAgent: pane release for '${id}' failed: ${err.message}`),
          );
        }
      }

      // Durable cascade teardown via the core primitive (roster/worktree/session/archive, leaf-first).
      // Runs REGARDLESS of pane-release failures — the durable teardown must not be stranded.
      // AggregateError on partial failure — Principle 9: let it propagate to the IPC layer.
      try {
        deleteAgentSubtree(projectId, agentId, {
          repoCwd,
          nowMs: Date.now(),
          gitExec,
          gitReader: defaultGitReader,
        });
      } catch (teardownError) {
        // Combine the teardown failure with any collected pane-release errors so the operator sees both.
        const teardownErrors =
          teardownError instanceof AggregateError
            ? teardownError.errors
            : [teardownError instanceof Error ? teardownError : new Error(String(teardownError))];
        throw new AggregateError(
          [...releaseErrors, ...teardownErrors],
          'co-mcp serve: deleteAgent: teardown failure',
          { cause: teardownError },
        );
      }

      // The durable subtree is gone; clear stale suppression so future agent ids are not poisoned.
      for (const id of ids) router.unstop(id);

      // The durable teardown succeeded; surface any pane-release errors that were collected.
      if (releaseErrors.length > 0) {
        throw new AggregateError(
          releaseErrors,
          'co-mcp serve: deleteAgent: pane release(s) failed (durable teardown completed)',
        );
      }
    },
    // #131 (reclaimChild) — GRANULAR reclaim of a SINGLE leaf child. Mirrors deleteAgent's compose
    // order (suppress → release pane → durable teardown → clear suppression) but refuses a non-leaf
    // and runs the core primitive on JUST the one childless agent. deleteAgentSubtree is leaf-safe:
    // on a childless leaf the teardown order is `[child]`, so it removes exactly that agent (archives
    // an unmerged branch, removes the worktree, ends the session, frees the dispatch slot, removes the
    // roster row) — the active-child cap then drops automatically. Siblings are untouched.
    reclaimChild: async (childId: string): Promise<void> => {
      // Resolve repoCwd per call (mirrors deleteAgent / reviewContext).
      const registry = openRegistry();
      let repoCwd: string;
      try {
        const p = registry.pathFor(projectId);
        if (p == null) {
          throw new Error(
            `co-mcp serve: reclaimChild: project '${projectId}' is not registered — cannot resolve repoCwd.`,
          );
        }
        repoCwd = p;
      } finally {
        registry.close();
      }

      // Guard: reclaim is only for non-root child leaves. A child with live descendants must go through
      // deleteAgent (whole subtree) — reclaiming just the parent would orphan its children.
      assertReclaimableChildLeaf(childId);
      if (engine.isTurnInFlight(projectId, childId)) {
        throw new Error(
          `co-mcp serve: reclaimChild: '${childId}' has an in-flight turn — refusing to ` +
            'delete durable state while the agent can still produce side effects. Stop it and retry ' +
            'after the turn yields.',
        );
      }

      // Suppress before releasing the pane so a failed teardown cannot cold-start the surviving row.
      router.recordStopped(childId);

      // Release the single warm pane — error-isolated so a rejecting close cannot strand the durable
      // teardown below (mirrors deleteAgent's best-effort spirit; surfaced after teardown — Principle 9).
      const releaseErrors: Error[] = [];
      try {
        await engine.release(projectId, childId, {});
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        releaseErrors.push(err);
        reportServeControlDiagnostic(
          opts.onError,
          new Error(
            `co-mcp serve: reclaimChild: pane release for '${childId}' failed: ${err.message}`,
          ),
        );
      }

      // A turn can finish work while release is being requested. Re-read the durable roster immediately
      // before deletion so a child that stopped being a leaf is refused instead of cascade-deleted.
      assertReclaimableChildLeaf(childId);

      // Durable leaf teardown via the core primitive. Runs REGARDLESS of pane-release failures.
      try {
        deleteAgentSubtree(projectId, childId, {
          repoCwd,
          nowMs: Date.now(),
          gitExec,
          gitReader: defaultGitReader,
        });
      } catch (teardownError) {
        const teardownErrors =
          teardownError instanceof AggregateError
            ? teardownError.errors
            : [teardownError instanceof Error ? teardownError : new Error(String(teardownError))];
        throw new AggregateError(
          [...releaseErrors, ...teardownErrors],
          'co-mcp serve: reclaimChild: teardown failure',
          { cause: teardownError },
        );
      }

      // The leaf is gone; clear stale suppression so a future reused id is not poisoned.
      router.unstop(childId);

      if (releaseErrors.length > 0) {
        throw new AggregateError(
          releaseErrors,
          'co-mcp serve: reclaimChild: pane release failed (durable teardown completed)',
        );
      }
    },
    // B5 (listArchive) — list all archived branch records; open/close per call (mirrors reviewContext).
    listArchive: async (): Promise<readonly ArchiveEntry[]> => {
      const archive = openArchiveStore(projectId);
      try {
        return archive.listRecords().map((r) => ({
          id: r.id,
          name: r.name,
          branch: r.branch,
          baseRef: r.baseRef,
          deletedAt: r.deletedAt,
          expiresAt: r.expiresAt,
        }));
      } finally {
        archive.close();
      }
    },
    // B5 (restoreArchive) — remove the archive record so the reaper skips it; branch stays.
    // Verify the branch still exists first; otherwise keep the archive handle for retry/recovery.
    restoreArchive: async (id: string): Promise<void> => {
      const archive = openArchiveStore(projectId);
      try {
        const rec = archive.getRecord(id);
        if (rec == null) return;
        const registry = openRegistry();
        let repoCwd: string;
        try {
          const p = registry.pathFor(projectId);
          if (p == null) {
            throw new Error(
              `co-mcp serve: restoreArchive: project '${projectId}' is not registered — cannot resolve repoCwd.`,
            );
          }
          repoCwd = p;
        } finally {
          registry.close();
        }
        try {
          gitExec(repoCwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${rec.branch}`]);
        } catch (gitError) {
          const error = new Error(
            `co-mcp serve: restoreArchive: git rev-parse failed for archived branch ` +
              `'${rec.branch}'; keeping archive record '${id}'.`,
            { cause: gitError },
          );
          reportServeControlDiagnostic(opts.onError, error);
          throw error;
        }
        archive.removeRecord(id);
      } finally {
        archive.close();
      }
    },
    // B5 (purgeArchive) — hard-purge: git branch -D <branch> then remove the archive record.
    // repoCwd is resolved per call from the registry, exactly as deleteAgent (Principle 9: fail loud).
    purgeArchive: async (id: string): Promise<void> => {
      const registry = openRegistry();
      let repoCwd: string;
      try {
        const p = registry.pathFor(projectId);
        if (p == null) {
          throw new Error(
            `co-mcp serve: purgeArchive: project '${projectId}' is not registered — cannot resolve repoCwd.`,
          );
        }
        repoCwd = p;
      } finally {
        registry.close();
      }
      const archive = openArchiveStore(projectId);
      try {
        const rec = archive.getRecord(id);
        // Idempotent: an unknown id (getRecord → null) makes removeRecord a benign no-op — a stale or
        // double purge is NOT an error. When the record exists, `git branch -D` must succeed before the
        // archive record is removed; otherwise the operator loses the retry/restore handle.
        if (rec != null) {
          try {
            gitExec(repoCwd, ['branch', '-D', rec.branch]);
          } catch (gitError) {
            if (isMissingBranchDeleteError(gitError, rec.branch)) {
              archive.removeRecord(id);
              return;
            }
            reportServeControlDiagnostic(
              opts.onError,
              new Error(
                `co-mcp serve: purgeArchive: git branch -D '${rec.branch}' failed: ${errorMessage(gitError)}`,
              ),
            );
            throw gitError;
          }
          archive.removeRecord(id);
        }
      } finally {
        archive.close();
      }
    },
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
    unsubTranscript = control.onTranscript((agentId, generation, chunk, offset) =>
      server.pushTranscript(agentId, generation, chunk, offset),
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
    ...(isolatedHomeDirFor != null ? { codexHomeFor: isolatedHomeDirFor } : {}),
    // P3 §3c — honor `pause`/STUCK: filter the router's suppressed agents out of candidate selection.
    isSkipped: (pid, agent) => router.shouldSkip(pid, agent),
  });

  const wtStoreForStop = ownedWtStore;
  // B3 (reaper) — throttled archive reaper: runs at most once every 60 ticks. Uses repoCwdForReaper
  // resolved at serve-setup time. A missing repoCwd (unregistered project) is benign — skip silently.
  // Errors are caught + logged: a reaper failure must never crash the tick (Principle 9 inverse — the
  // tick loop itself is load-bearing; diagnostic issues must not take it down).
  let reaperTickCount = 0;
  const REAPER_EVERY_N_TICKS = 60;

  // Forward each tick as the operator-IPC `tick` push (D6 — the whole fresh snapshot) while still
  // honoring any caller `onTick`. Also runs the throttled archive reaper when repoCwdForReaper is
  // known. Built when any of these are present; existing callers without IPC/onTick/repoCwd are
  // unchanged (undefined → the runner skips the hook entirely).
  const onTick =
    ipcServer != null || opts.onTick != null || repoCwdForReaper != null
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
          // B3 (reaper) — opportunistic archive purge, throttled to once per N ticks.
          reaperTickCount++;
          if (reaperTickCount % REAPER_EVERY_N_TICKS === 0 && repoCwdForReaper != null) {
            try {
              reapExpiredArchives(projectId, Date.now(), {
                repoCwd: repoCwdForReaper,
                gitExec,
              });
            } catch (reaperError) {
              reportServeControlDiagnostic(
                opts.onError,
                new Error(`co-mcp serve: archive reaper error: ${errorMessage(reaperError)}`),
              );
            }
          }
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
        router.close();
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

// ── GitHub auth provisioning for the daemon (RC-2/3/4) ──────────────────────────────────────────────
//
// The gated publish (`co_push`/`co_pr_merge`) and remote detection run DAEMON-side, inheriting the
// daemon's `process.env`. A GUI-launched desktop app inherits no shell exports and there is no
// Connect-GitHub UI, so the token must be SOURCED (from the operator's existing `gh auth login`) and
// the env PROVISIONED so both `gh` and `git push https` authenticate. See {@link githubHttpsCredentialEnv}.

/** Resolved `gh auth token` output plus the command that produced it. */
export interface GhAuthTokenResolution {
  readonly token: string;
  readonly command: string;
}

/** Runs `gh auth token`, returning the operator's token or undefined (gh absent / logged out). */
export type GhAuthTokenRunner = (env: NodeJS.ProcessEnv) => GhAuthTokenResolution | undefined;

/** Resolves a usable `gh` command for later daemon seams that intentionally invoke bare `gh`. */
export type GhCommandResolver = (env: NodeJS.ProcessEnv) => string | undefined;

/** Sync spawn seam for the gh runner — injectable so the real runner is testable without a real gh. */
export type GhSpawnSync = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => { readonly status: number | null; readonly stdout?: string };

const realGhSpawn: GhSpawnSync = (command, args, env) => {
  const res = spawnSync(command, [...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
    timeout: GH_AUTH_TOKEN_TIMEOUT_MS,
  });
  return { status: res.status, stdout: typeof res.stdout === 'string' ? res.stdout : undefined };
};

/**
 * Build a {@link GhCommandResolver} over a spawn seam: try `gh --version` on PATH, then common
 * absolute locations. This is separate from token resolution so an explicit env token can still make
 * the selected `gh` binary available to later repo/publish seams.
 */
export function makeGhCommandResolver(spawn: GhSpawnSync = realGhSpawn): GhCommandResolver {
  return (env) => {
    for (const cmd of GH_AUTH_TOKEN_COMMANDS) {
      try {
        const res = spawn(cmd, ['--version'], env);
        if (res.status === 0) return cmd;
      } catch {
        // ENOENT / spawn failure → try the next candidate; a missing gh is "not resolved".
      }
    }
    return undefined;
  };
}

/** The real {@link GhCommandResolver} (timeout-bounded real spawnSync). */
export const defaultGhCommandResolver: GhCommandResolver = makeGhCommandResolver();

/**
 * Build a {@link GhAuthTokenRunner} over a spawn seam: try `gh` on PATH, then common absolute paths
 * (a GUI launch often has a minimal PATH). Never throws — any spawn failure / non-zero / timeout is
 * treated as "no token" and falls through to the next candidate, ultimately `undefined`.
 */
export function makeGhAuthTokenRunner(spawn: GhSpawnSync = realGhSpawn): GhAuthTokenRunner {
  return (env) => {
    for (const cmd of GH_AUTH_TOKEN_COMMANDS) {
      try {
        const res = spawn(cmd, ['auth', 'token'], env);
        if (res.status === 0) {
          const token = res.stdout?.trim();
          if (token != null && token.length > 0) return { token, command: cmd };
        }
      } catch {
        // ENOENT / spawn failure → try the next candidate; a missing/failed gh is "no token".
      }
    }
    return undefined;
  };
}

/** The real {@link GhAuthTokenRunner} (timeout-bounded real spawnSync). */
export const defaultGhAuthTokenRunner: GhAuthTokenRunner = makeGhAuthTokenRunner();

/**
 * Resolve a GitHub token for the daemon: explicit env (`CO_GH_TOKEN` > `GH_TOKEN` > `GITHUB_TOKEN`,
 * via the shared {@link resolveGhTokenFromEnv} policy) wins; otherwise fall back to the operator's
 * existing login via `gh auth token`. So a self-hosting operator authenticates GitHub with the
 * standard one-time `gh auth login` — no co-specific UI needed.
 */
export function resolveGhToken(
  env: NodeJS.ProcessEnv = process.env,
  runner: GhAuthTokenRunner = defaultGhAuthTokenRunner,
): string | undefined {
  const explicit = resolveGhTokenFromEnv(env);
  if (explicit != null) return explicit;
  return runner(env)?.token;
}

function resolveGhAuth(
  env: NodeJS.ProcessEnv,
  runner: GhAuthTokenRunner,
  commandResolver: GhCommandResolver,
): GhAuthTokenResolution | undefined {
  const explicit = resolveGhTokenFromEnv(env);
  if (explicit != null) return { token: explicit, command: commandResolver(env) ?? 'gh' };
  return runner(env);
}

/**
 * Source a GitHub token and provision `env` (the daemon's `process.env`) so BOTH `gh` and
 * `git push https://github.com` authenticate (RC-2/3/4). Mutates `env` in place so every daemon-side
 * git/gh seam inherits it. Returns the token, or undefined when none is available (the daemon still
 * runs; remote publish/detection then fail LOUD per Principle 9 rather than hanging).
 */
export function resolveAndApplyDaemonGithubAuth(
  env: NodeJS.ProcessEnv = process.env,
  runner: GhAuthTokenRunner = defaultGhAuthTokenRunner,
  commandResolver: GhCommandResolver = defaultGhCommandResolver,
): string | undefined {
  const auth = resolveGhAuth(env, runner, commandResolver);
  if (auth == null) return undefined;
  Object.assign(env, githubHttpsCredentialEnv(auth.token, env));
  Object.assign(env, ghCommandPathEnv(auth.command, env));
  return auth.token;
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
  let repoCwd: string;
  const registry = openRegistry();
  try {
    const registeredPath = registry.pathFor(projectId);
    if (registeredPath == null) {
      throw new Error(
        `co-mcp serve: unknown project id '${projectId}'. Pass the registered project id for this repo.`,
      );
    }
    repoCwd = registeredPath;
  } finally {
    registry.close();
  }
  // The daemon has no operator at its stdin, so git must NEVER block on an interactive credential
  // prompt — even on the no-token path (Principle 9 fail-loud: error out, do not hang). Set this
  // unconditionally; githubHttpsCredentialEnv also sets it when a token is provisioned.
  process.env['GIT_TERMINAL_PROMPT'] = '0';
  // RC-2/3/4: provision GitHub auth onto the daemon env BEFORE building coMcpPaths so (a) the
  // daemon-side git/gh publish + detection authenticate, and (b) defaultServeCoMcpPaths() picks up the
  // now-set GH_TOKEN for the pane (defense-in-depth). Sourced from explicit env or the operator's
  // existing `gh auth login`. Surface the result LOUDLY so a logged-out operator is never left guessing.
  const ghToken = resolveAndApplyDaemonGithubAuth();
  console.error(
    ghToken != null
      ? '[co-mcp serve] GitHub auth: configured — gh + remote HTTPS pushes will authenticate to github.com.'
      : '[co-mcp serve] GitHub auth: NONE — run `gh auth login` (or set CO_GH_TOKEN); remote publish ' +
          '(co_push / co_pr_merge) will fail until then. Offline/owner-local co_merge still works.',
  );
  // [host-live capture] Arm the observation harness when CO_HOST_LIVE_CAPTURE=<dir> is set, so a single
  // real run records the codex paste-preview bytes / MCP-approval prompt / status-line / usage sample
  // that finalize the PLACEHOLDER constants. INERT (zero overhead) when the env is unset.
  const hostLiveCapture = openHostLiveCapture(process.env, undefined, {
    forbiddenRoot: repoCwd,
    onError: (error) => console.error(`[co-mcp serve] ${error.message}`),
  });
  if (hostLiveCapture.armed) {
    console.error(
      `[co-mcp serve] host-live capture: ARMED — recording observations to ` +
        `${hostLiveCapture.dir} (#77/#78 placeholder finalization).`,
    );
  }
  const runner = await serveConductor({
    projectId,
    coMcpPaths: defaultServeCoMcpPaths(),
    hostLiveCapture,
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
