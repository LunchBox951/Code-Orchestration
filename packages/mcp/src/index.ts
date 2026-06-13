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
