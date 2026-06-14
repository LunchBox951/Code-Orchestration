#!/usr/bin/env node
import { serve } from './serve.js';
import { runServeConductor } from './conductor/host.js';

/**
 * The `co-mcp` executable. Two modes:
 *   - default (no subcommand): the stdio MCP server — the real headless AGENT surface.
 *   - `serve <projectId>`: the OPERATOR-only Conductor launch (`co serve`, D6) — drives the
 *     deterministic daemon on a real cadence with real panes. The Conductor is never agent-callable
 *     (Principle 4 + D4); this lives in `@co/mcp` because the daemon needs the MCP SDK (`@co/cli`
 *     depends only on `@co/core`).
 *
 * A fatal startup error (missing identity / project id, unregistered worktree, transport failure)
 * fails loud to stderr and exits non-zero — never a silent degrade (Principle 9). stdout is reserved
 * for the MCP protocol stream.
 */
const [mode, ...rest] = process.argv.slice(2);
const main = mode === 'serve' ? runServeConductor(rest) : serve();
main.catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
