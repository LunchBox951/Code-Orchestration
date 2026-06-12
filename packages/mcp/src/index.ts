// The thin MCP agent surface (L2-B2). `@co/mcp` mounts core's canonical tool registry onto the
// MCP protocol and dispatches every tool through `@co/core`'s `invokeTool` — it holds NO
// orchestration logic (AC-L2-1). The server is transport-agnostic (stdio today via `serve`). This
// module also exports the real `LiveSessionHostImpl` — per-pane authoritative identity injection over
// the co surface (sandbox-tested); only binding that live MCP server to a provider's pty transport
// remains host-side runtime wiring (Stage-9 D).
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
