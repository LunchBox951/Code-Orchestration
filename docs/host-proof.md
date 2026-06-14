# Conductor Host-Proof Runbook (P4)

This document is the operator guide for the `[host-live]` phase of the Stage 10 P4 acceptance
criteria. It describes the one-command proof that the Conductor's end-to-end plumbing works against
a **real** `claude` or `codex` binary on the operator's host.

Everything in this runbook executes on the **operator's host machine** — not in a sandbox. The
in-sandbox proof (AC-S10-4 items 1–4) runs automatically as part of `pnpm test`.

---

## Prerequisites

1. `co` and `co-mcp` built (`pnpm build` in the repo root) and resolvable from the shell. If `co`
   is not on `$PATH`, set `CO_CLI_COMMAND=/absolute/path/to/co` before running Codex-backed proofs.
2. A registered project (`co doctor` should show `ok` for program-data-integrity).
3. The target provider (`claude` or `codex`) installed and authenticated:
   - Claude: `claude auth status --json` shows `logged_in: true`.
   - Codex: `codex doctor --json` shows `authenticated: true`.

## Running `co doctor --live`

Verify provider compatibility before the full proof:

```sh
co doctor --live
```

This wires `defaultProviderProbe` — the metadata-only probe (`claude --version`,
`claude auth status --json`, `codex --version`, `codex doctor --json`) — into the structural health
suite. All four checks run; the `provider-compatibility` check reports each provider's version and
capabilities. Expected output:

```
co doctor — healthy
  [ok] program-data-integrity      Live projections are consistent with the event log.
  [ok] project-memory-validity     CLAUDE.md and AGENTS.md are both present.
  [ok] mcp-surface-completeness    All declared MCP tools are complete (no stubs).
  [ok] provider-compatibility      All monitored providers are compatible (claude: version=...; codex: version=...).
```

A `warn` on `provider-compatibility` (version skew) means the binary is usable but not at the
pinned version; the proof can still proceed. A `fail` means a required capability is missing —
fix the provider installation before continuing.

## Running the host-proof driver

Run from the project root (CWD must be a registered project — `co doctor` confirms this):

```sh
co-mcp host-proof claude
# or
co-mcp host-proof codex
```

The `projectId` is resolved automatically from the current working directory (same lookup as
`co doctor`). To override, pass it explicitly: `co-mcp host-proof claude <projectId>`.

This runs the scripted host-proof driver against the real binary:

1. **Scoped MCP config** — writes a per-proof provider config that launches
   `co-mcp bridge <socket>` as the provider's stdio MCP server. The bridge connects back to the
   Conductor-owned engine session for this pane; identity is still injected server-side by the
   engine, not trusted from provider env.
2. **Spawn** — launches the provider in a pty via `NodePtyHost.create()`.
3. **Bind + drive to ready** — the engine binds the MCP socket before awaiting provider startup,
   while `driveToReady` captures startup bytes from spawn time.
4. **Inject 1 mail** — creates a nonce-bearing `clarify_request` to the proof agent and injects it.
5. **1 turn** — runs `engine.runOneTurn`, observes byte output, detects idle boundary.
6. **Mail route proof** — the real provider must call `co_mail_send` to `@operator` and echo the
   nonce in the subject or body; stale or wrong-sender mail does not count.
7. **Steer live pane** — sends an interrupt steer while the pane is still warm and before crash
   simulation.
8. **SIGKILL** — sends `SIGKILL` to the provider pane, simulating a crash.
9. **Recover** — calls `recoverProjectStore` to rebuild all read-models from the event log.
10. **Reconstruct** — calls `listSessions()` to show the session record survived the crash.

### Expected output

```
[co host-proof] running against claude in project 'proj-abc123'…
[co host-proof] result:
  turnRan=true
  turnIdle=true
  turnError=-
  mailRouted=true
  sessionReconstructed=true
  steerCompleted=true
  steerMidTurn=true
  recoveredSessions=1
[co host-proof] PASS — all proof steps completed.
```

### Pass criteria

| Step | Pass condition |
|------|---------------|
| Turn ran | `turnRan=true` (no error during `runOneTurn`) |
| Turn idle | `turnIdle=true` (byte-quiescence reached) |
| Mail routed | `mailRouted=true` (the real provider called scoped `co_mail_send` and echoed the proof nonce to the parent inbox) |
| Recovery | `sessionReconstructed=true` (agent session in recovered state) |
| Steer | `steerCompleted=true` (interrupt key sent before crash simulation) |
| Mid-turn steer | `steerMidTurn=true` (interrupt was sent before the turn promise settled) |

If any step fails, `co-mcp host-proof` exits non-zero with a descriptive error.

Each run creates a unique `host-proof-*` agent id and nonce-bearing proof mail. The event log keeps
the durable audit trail, but the live session projection is cleaned up when the proof closes its
engine. The proof does not reuse a stable agent id because stale mail from prior runs must never
satisfy the current nonce.

## Running `co serve` and observing the daemon

For a longer-running proof:

```sh
co-mcp serve <projectId>
```

Starts the `ConductorHostRunner` on a 1-second cadence. On each tick it logs:

```
[co serve] tick 1 candidates=1 cold=0 selected=impl-abc123 cadence=false
[co serve] tick 2 candidates=1 cold=1 selected=- cadence=false
```

`cold=1 selected=-` means recovery found a RUNNING session record but this `co serve` process has
not reattached a warm pane for it, so the daemon reports the cold candidate instead of injecting a
turn. A mail injection on the next beat requires a warm hosted pane (`selected=<agent>` on a prior
tick, or an agent this process has launched/hosted through the normal placement path).

After an agent is warm/hosted, send it mail to trigger an injection on the next tick:

```sh
co mail send --to impl-abc123 --type operator_message --subject "steer" --body "continue"
```

The daemon picks it up on the next beat and runs one turn.

## Troubleshooting

| Symptom | Likely cause |
|---------|-------------|
| `CO_CLI_COMMAND must be absolute` | Codex hook CLI path was supplied as a relative command |
| `recoverProjectStore` fails | Corrupt event store — run `co doctor` to diagnose |
| `driveToReady` timeout | Provider startup slower than expected — increase `quietWindow` |
| `turnRan=false` | `injectMail` echo mismatch — check provider prompt format |
| `mailRouted=false` | Provider did not call scoped `co_mail_send`, or the reply omitted the proof nonce |

---

*Ladders to v1 acceptance criteria: SF-1 (self-hosting loop), SF-2 (live steer), ST-2/ST-3 (crash recovery and replay), PV-2 (operator-verifiable proof).*
