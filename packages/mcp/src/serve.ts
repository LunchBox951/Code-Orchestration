import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createCoMcpServer } from './server.js';
import { defaultContextFactory, toolsFromEnv } from './context.js';

/**
 * Run the co MCP server over stdio — the real headless agent surface. The offered toolset is SCOPED
 * to the mount's `CO_ROLE` ({@link toolsFromEnv}; `undefined` ⇒ the full registry), and identity is
 * derived from the env/cwd via {@link defaultContextFactory} (which fails loud on a missing identity
 * or an unregistered worktree, before the transport connects). Connects to the SDK's
 * {@link StdioServerTransport}; returns once connected, then the transport serves until stdin closes.
 * Transport-agnostic: the live pty session-host is a separate L7 seam (live-session-host.ts).
 */
export async function serve(): Promise<void> {
  const server = createCoMcpServer({
    tools: toolsFromEnv(),
    contextFactory: defaultContextFactory(),
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
