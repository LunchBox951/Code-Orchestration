// The thin MCP agent surface (L2-B2). `@co/mcp` mounts core's canonical tool registry onto the
// MCP protocol and dispatches every tool through `@co/core`'s `invokeTool` — it holds NO
// orchestration logic (AC-L2-1). The server is transport-agnostic (stdio today via `serve`). This
// module also exports the real `LiveSessionHostImpl` — per-pane authoritative identity injection over
// the co surface (sandbox-tested). Stage 9 D owns spawn-from-placement / self-launch; the Stage 8
// host-live proof binds this surface to real provider sessions.
export { createCoMcpServer, type CoMcpServerOptions } from './server.js';
export { serve } from './serve.js';
export {
  defaultContextFactory,
  openContextStores,
  type ExplicitIdentity,
  CO_AGENT_ENV,
  CO_ROLE_ENV,
  CO_PARENT_ENV,
  CO_PROJECT_ID_ENV,
  CO_MCP_BRIDGE_LOG_ENV,
} from './context.js';
export {
  type LiveSessionHost,
  type HostedIdentity,
  type HostedSession,
  LiveSessionHostImpl,
} from './live-session-host.js';
// L7-ENG (Stage 9 P1a) — the Conductor ENGINE: the single-turn cycle that drives the landed L7
// components (host/spawn/driveToReady/bind/injectMail/detectTurnEnd) + the MNR-5 launch authority.
// FROZEN public interface for P1b (mail-routing/liveness) + P2 (spawn-from-placement) to compose onto.
export {
  ConductorEngine,
  selectEligible,
  type ConductorEngineDeps,
  type TransportPair,
  type HostedPane,
  type TurnOutcome,
  type CycleOutcome,
} from './conductor/engine.js';
// L7-LOOP (Stage 10 P1) — the Conductor DAEMON: the deterministic run-loop that turns the box of
// landed L7/L8 components into a running `co` (recover → reconstruct the live set → drive ≤1 turn → on
// cadence run the clarify-timeout tick + watchdog-reconcile sweep). NOT a tool, never agent-callable
// (D4). The engine/reconcile are public so P3's operator control/observe surface builds ON the loop.
export {
  ConductorDaemon,
  type ConductorDaemonDeps,
  type DaemonTickOutcome,
} from './conductor/daemon.js';
// L7-LOOP [host-live] glue — the real-cadence runner (`setInterval` over `tick()` + `NodePtyHost`
// panes) and the `co-mcp serve` operator launch. Built + FakePty-unit-tested; never run against a real
// provider binary in-sandbox (binding a real pty-bound transport is the operator handoff).
export {
  ConductorHostRunner,
  serveConductor,
  runServeConductor,
  defaultScheduler,
  monotonicNowMs,
  realQuietWindow,
  hostLiveTransportRequired,
  // GitHub-auth provisioning seams (RC-2/3/4) — re-exported so the desktop adapter can REUSE the
  // single-sourced `gh auth token` resolver (its GUI auto-prime fallback) instead of duplicating it.
  makeGhAuthTokenRunner,
  defaultGhAuthTokenRunner,
  makeGhCommandResolver,
  defaultGhCommandResolver,
  resolveGhToken,
  resolveAndApplyDaemonGithubAuth,
  type ConductorHostRunnerDeps,
  type ConductorHostRunnerStopOptions,
  type ConductorControlSurface,
  type ServeConductorOptions,
  type OperatorIpcServeConfig,
  type IntervalScheduler,
  type IntervalHandle,
  type GhAuthTokenResolution,
  type GhAuthTokenRunner,
  type GhCommandResolver,
  type GhSpawnSync,
} from './conductor/host.js';
// L7-CTLOBS (Stage 10 P3) — the transport-agnostic operator CONTROL + OBSERVE surface over the running
// engine: the daemon-backed `AgentRouterSeam` (unstick/pause/stop/steer act on LIVE agents, replacing
// the CLI's `[host-live]` throws) and the engine-backed `LiveStateProvider` (the live half of
// observability). Operator-only — registers ZERO agent MCP tools (Principle 4 + D4). Stage 11's
// operator-IPC binding now carries this surface across the app → daemon boundary.
export {
  DaemonBackedAgentRouter,
  type DaemonBackedAgentRouterDeps,
} from './conductor/agent-router.js';
export {
  EngineLiveStateProvider,
  type EngineLiveStateProviderDeps,
} from './conductor/live-observe.js';
// Stage 11 P1 (OP-IPC) — the cross-process operator-IPC binding the desktop app drives. The SERVER
// (started by `co-mcp serve`) wraps the `ConductorControlSurface` + a `MailStore` over a Unix-socket
// JSON-RPC channel and pushes a per-tick snapshot; the CLIENT is the app-facing degradation FACADE
// (live overlay when up, static `queryObservability` fall-back when down; control + writes need the
// socket). Operator-uid-only by socket permission; registers ZERO agent MCP tools (Principle 4 + D4).
export {
  OperatorIpcServer,
  operatorIpcSocketPath,
  type OperatorIpcServerDeps,
} from './operator-ipc/server.js';
export {
  OperatorIpcClient,
  OperatorIpcConnection,
  ConductorUnavailableError,
  type OperatorIpcClientDeps,
} from './operator-ipc/client.js';
// LIVE worker BENCHMARK (gated behind CO_LIVE_E2E) — hosts a REAL implementer agent in a real node-pty
// through CO's socket-bridge MCP surface, gives it a real coding task, and OBJECTIVELY grades the
// artifact it produces. Builds from the SAME resolveHostLiveSeams wiring path the host-proof uses. The
// fidelity is derived from the resolved node-pty host (never the flag). See docs/worker-benchmark.md.
export {
  runWorkerBenchmark,
  buildWorkerSpawnSpec,
  type WorkerBenchmarkOptions,
  type WorkerBenchmarkResult,
  type ScoredWorkerBenchmarkResult,
  type WorkerBenchmarkStopReason,
  type WorkerScores,
} from './conductor/worker-benchmark.js';
// MULTI-LEVEL ORCHESTRATION BENCHMARK (the v1 centerpiece) — drives the full coordinator → lead → 2
// implementers → merge-up chain for an OrchestrationScenario, automates the operator gates, and grades the
// merged integration branch by EXECUTING it against the scenario's hidden oracle. Switchable sandbox↔live
// via the injected automation seam; fidelity is DERIVED from the resolved pty host (never a flag). The
// pure helpers (done-detector, metrics aggregation, fidelity derivation, grader) are exported for
// no-pty unit testing. See docs/orchestration-benchmark.md.
export {
  runOrchestrationBenchmark,
  deriveRunFidelity,
  detectChainCompletion,
  aggregateAgentMetrics,
  aggregateMergeOutcomes,
  countImplementerBranchesMergedUp,
  gradeIntegrationBranch,
  ORCH_BENCH_DEFAULTS,
  ORCH_BENCH_TASK_ID,
  CO_BENCH_MAX_TICKS_ENV,
  CO_BENCH_WALLCLOCK_MS_ENV,
  CO_BENCH_PER_STEP_MS_ENV,
  type OrchestrationBenchmarkOptions,
  type OrchestrationAutomation,
  type AutomationDriveInput,
  type AutomationDriveResult,
  type AgentTurnSample,
  type OrchestrationStopReason,
  type OpenBenchEcon,
} from './conductor/orchestration-benchmark.js';
