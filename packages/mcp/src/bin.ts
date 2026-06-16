#!/usr/bin/env node
import { serve } from './serve.js';
import { renderCoMcpHelp } from './bin-help.js';
import { runServeConductor } from './conductor/host.js';
import { runHostProofCommand } from './conductor/host-proof.js';
import { runSocketBridgeCommand } from './conductor/real-transport.js';
import { runStartSessionCommand } from './conductor/start-session-command.js';
import { runProjectIdCommand } from './conductor/project-id-command.js';

/**
 * The `co-mcp` executable. Three modes:
 *   - default (no subcommand): the stdio MCP server — the real headless AGENT surface.
 *   - `serve <projectId>`: the OPERATOR-only Conductor launch (`co-mcp serve`, D6) — drives the
 *     deterministic daemon on a real cadence with real panes. The Conductor is never agent-callable
 *     (Principle 4 + D4); this lives in `@co/mcp` because the daemon needs the MCP SDK (`@co/cli`
 *     depends only on `@co/core`).
 *   - `host-proof <provider>`: the OPERATOR-only P4 live-proof harness (`co-mcp host-proof claude`).
 *     Runs the scripted host-proof driver (spawn → inject → turn → steer → SIGKILL → recover)
 *     against the given provider. OPERATOR-ONLY — never agent-callable (Principle 4 + D4).
 *   - `bridge <socketPath>`: provider-side stdio bridge. The real provider launches this as its MCP
 *     server; it connects stdio to the Conductor-owned Unix socket for the pane's hosted session.
 *   - `start-session <projectId> (--prompt "…" | --spec <path>)`: the OPERATOR-only Stage 14 P1 entry
 *     (`co-mcp start-session`). Launches a ROOT coordinator from a prompt OR a draft spec — registers it
 *     in the roster + provisions its worktree + seeds the actionable kickoff, but mints no session (the
 *     daemon cold-starts it). OPERATOR-ONLY — never agent-callable (Principle 4 + D4).
 *   - `project-id [repoPath]`: the OPERATOR-only project-id lookup + registration (`co-mcp project-id`).
 *     Registers the repo path in the project registry (idempotent) and prints ONLY the projectId to
 *     stdout. The default repoPath is cwd. OPERATOR-ONLY — never agent-callable (Principle 4 + D4).
 *
 * A fatal startup error (missing identity / project id, unregistered worktree, transport failure)
 * fails loud to stderr and exits non-zero — never a silent degrade (Principle 9). stdout is reserved
 * for the MCP protocol stream, except for explicit `--help` output.
 */
const [mode, ...rest] = process.argv.slice(2);
if (mode === '--help' || mode === '-h' || mode === 'help') {
  console.log(renderCoMcpHelp());
} else {
  const main =
    mode === 'serve'
      ? runServeConductor(rest)
      : mode === 'host-proof'
        ? runHostProofCommand(rest)
        : mode === 'bridge'
          ? runSocketBridgeCommand(rest)
          : mode === 'start-session'
            ? runStartSessionCommand(rest)
            : mode === 'project-id'
              ? runProjectIdCommand(rest)
              : serve();
  main.catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
