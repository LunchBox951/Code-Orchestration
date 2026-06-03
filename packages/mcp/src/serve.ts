import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createCoMcpServer } from './server.js';
import { defaultContextFactory } from './context.js';

/**
 * Run the co MCP server over stdio — the real headless agent surface. Builds the server with the
 * default env/cwd-derived {@link defaultContextFactory} (which fails loud on a missing identity or
 * an unregistered worktree, before the transport connects) and connects it to the SDK's
 * {@link StdioServerTransport}. Returns once connected; the transport then serves until stdin
 * closes. Transport-agnostic: the live pty session-host is a separate L7 seam (live-session-host.ts).
 */
export async function serve(): Promise<void> {
  const server = createCoMcpServer({ contextFactory: defaultContextFactory() });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
