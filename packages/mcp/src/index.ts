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
// panes) and the `co serve` operator launch. Built + FakePty-unit-tested; never run against a real
// provider binary in-sandbox (binding a real pty-bound transport is the operator handoff).
export {
  ConductorHostRunner,
  serveConductor,
  runServeConductor,
  defaultScheduler,
  monotonicNowMs,
  realQuietWindow,
  hostLiveTransportRequired,
  type ConductorHostRunnerDeps,
  type ConductorControlSurface,
  type ServeConductorOptions,
  type IntervalScheduler,
  type IntervalHandle,
} from './conductor/host.js';
// L7-CTLOBS (Stage 10 P3) — the transport-agnostic operator CONTROL + OBSERVE surface over the running
// engine: the daemon-backed `AgentRouterSeam` (unstick/pause/stop/steer act on LIVE agents, replacing
// the CLI's `[host-live]` throws) and the engine-backed `LiveStateProvider` (the live half of
// observability). Operator-only — registers ZERO agent MCP tools (Principle 4 + D4). The cross-process
// CLI → daemon IPC binding is deferred to the app stage.
export {
  DaemonBackedAgentRouter,
  type DaemonBackedAgentRouterDeps,
} from './conductor/agent-router.js';
export {
  EngineLiveStateProvider,
  type EngineLiveStateProviderDeps,
} from './conductor/live-observe.js';
