import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  buildCoreRegistry,
  createToolRegistry,
  invokeTool,
  toolInputShape,
  toolOutputShape,
  type ToolContext,
  type ToolSpec,
} from '@co/core';

/** Server identity advertised to MCP clients on initialize. */
const SERVER_NAME = 'co';
const SERVER_TITLE = 'co orchestration tools';
/** Kept in lockstep with packages/mcp/package.json `version`. */
const SERVER_VERSION = '0.0.0';

export interface CoMcpServerOptions {
  /**
   * The tools to offer. Defaults to {@link buildCoreRegistry}().list() — the canonical
   * `co_*` tools. Phase D passes a role-scoped subset here; the exposed tool list is ALWAYS
   * exactly these specs (1:1 with the registry — nothing added, nothing dropped).
   */
  readonly tools?: readonly ToolSpec[];
  /**
   * Builds the {@link ToolContext} for an invocation. Injected so the server is testable headless
   * (a fixed context over a temp store) and so L7 can own live, per-session identity-injection.
   * The MOUNT supplies identity; a tool never invents who is calling (mcp-tools.md). The default
   * stdio entry ({@link defaultContextFactory}) resolves agent+project+mail from env/cwd.
   */
  contextFactory: () => ToolContext | Promise<ToolContext>;
}

/**
 * Build an MCP server that mounts core's tool registry onto the MCP protocol. THIN: it adds no
 * orchestration logic — every tool dispatches into `@co/core` via {@link invokeTool}, which is the
 * single I/O-validation + dispatch seam (the schemas are the single syntax source, Principle 5).
 * Transport-agnostic: this server is independent of how a live session is hosted (stdio now; the
 * L7 pty session-host is a typed stub — see live-session-host.ts).
 *
 * For each offered {@link ToolSpec} it registers a tool carrying the spec's title, description and
 * its zod input/output schemas (mounted via core's `toolInputShape`/`toolOutputShape`, so the
 * adapter stays zod-free — AC-L2-1), and a handler that builds a `ToolContext` via `contextFactory`
 * and returns the structured result both as `structuredContent` (typed) and as a JSON text block
 * (for clients that read `content`).
 */
export function createCoMcpServer(opts: CoMcpServerOptions): McpServer {
  const tools = opts.tools ?? buildCoreRegistry().list();

  // A registry built from exactly the offered specs, so `invokeTool` dispatches by name with full
  // input/output validation. No tool-name switch lives here (that would be orchestration logic in
  // the adapter, AC-L2-1) — dispatch is entirely core's `invokeTool`.
  const registry = createToolRegistry();
  for (const spec of tools) registry.register(spec);

  const server = new McpServer({
    name: SERVER_NAME,
    title: SERVER_TITLE,
    version: SERVER_VERSION,
  });

  for (const spec of tools) {
    server.registerTool(
      spec.name,
      {
        title: spec.title,
        description: spec.description,
        inputSchema: toolInputShape(spec),
        outputSchema: toolOutputShape(spec),
      },
      async (args: unknown) => {
        const ctx = await opts.contextFactory();
        const structured = await invokeTool(registry, ctx, spec.name, args);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(structured) }],
          structuredContent: structured as Record<string, unknown>,
        };
      },
    );
  }

  return server;
}
