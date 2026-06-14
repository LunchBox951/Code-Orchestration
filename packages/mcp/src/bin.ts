#!/usr/bin/env node
import { serve } from './serve.js';
import { runServeConductor } from './conductor/host.js';
import { runHostProofCommand } from './conductor/host-proof.js';
import { runSocketBridgeCommand } from './conductor/real-transport.js';

/**
 * The `co-mcp` executable. Three modes:
 *   - default (no subcommand): the stdio MCP server — the real headless AGENT surface.
 *   - `serve <projectId>`: the OPERATOR-only Conductor launch (`co serve`, D6) — drives the
 *     deterministic daemon on a real cadence with real panes. The Conductor is never agent-callable
 *     (Principle 4 + D4); this lives in `@co/mcp` because the daemon needs the MCP SDK (`@co/cli`
 *     depends only on `@co/core`).
 *   - `host-proof <provider>`: the OPERATOR-only P4 live-proof harness (`co-mcp host-proof claude`).
 *     Runs the scripted host-proof driver (spawn → inject → turn → steer → SIGKILL → recover)
 *     against the given provider. OPERATOR-ONLY — never agent-callable (Principle 4 + D4).
 *   - `bridge <socketPath>`: provider-side stdio bridge. The real provider launches this as its MCP
 *     server; it connects stdio to the Conductor-owned Unix socket for the pane's hosted session.
 *
 * A fatal startup error (missing identity / project id, unregistered worktree, transport failure)
 * fails loud to stderr and exits non-zero — never a silent degrade (Principle 9). stdout is reserved
 * for the MCP protocol stream.
 */
const [mode, ...rest] = process.argv.slice(2);
const main =
  mode === 'serve'
    ? runServeConductor(rest)
    : mode === 'host-proof'
      ? runHostProofCommand(rest)
      : mode === 'bridge'
        ? runSocketBridgeCommand(rest)
        : serve();
main.catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
