# Conductor Host-Proof Runbook (P4)

This document is the operator guide for the `[host-live]` phase of the Stage 10 P4 acceptance
criteria. It describes the one-command proof that the Conductor's end-to-end plumbing works against
a **real** `claude` or `codex` binary on the operator's host.

Everything in this runbook executes on the **operator's host machine** — not in a sandbox. The
in-sandbox proof (AC-S10-4 items 1–4) runs automatically as part of `pnpm test`.

---

## Prerequisites

1. `co` built and on `$PATH` (`pnpm build` in the repo root, then `dist/` or symlink).
2. A registered project (`co doctor` should show `ok` for program-data-integrity).
3. The target provider (`claude` or `codex`) installed and authenticated:
   - Claude: `claude auth status --json` shows `logged_in: true`.
   - Codex: `codex doctor --json` shows `authenticated: true`.
4. At least one actionable mail in `@operator`'s inbox for the project (the driver reads from
   `@operator`'s outstanding queue):
   ```
   co mail send --to @operator --type operator_message --subject "host-proof test" --body "prove it"
   ```
   (Or seed it manually with `co mail send` before running the proof.)

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
co doctor — ok
  ✓  program-data-integrity      Live projections are consistent with the event log.
  ✓  project-memory-validity     CLAUDE.md and AGENTS.md are both present.
  ✓  mcp-surface-completeness    All declared MCP tools are complete (no stubs).
  ✓  provider-compatibility      All monitored providers are compatible (claude: version=…; codex: version=…).
```

A `warn` on `provider-compatibility` (version skew) means the binary is usable but not at the
pinned version; the proof can still proceed. A `fail` means a required capability is missing —
fix the provider installation before continuing.

## Running the host-proof driver

```sh
co-mcp host-proof claude
# or
co-mcp host-proof codex
```

This runs the scripted host-proof driver against the real binary:

1. **Spawn** — launches the provider in a pty via `NodePtyHost.create()`.
2. **Drive to ready** — `driveToReady` waits for the provider's startup interstitial.
3. **Inject 1 mail** — injects the first outstanding actionable item from `@operator`'s inbox.
4. **1 turn** — runs `engine.runOneTurn`, observes byte output, detects idle boundary.
5. **SIGKILL** — sends `SIGKILL` to the provider pane, simulating a crash.
6. **Recover** — calls `recoverProjectStore` to rebuild all read-models from the event log.
7. **Reconstruct** — calls `listSessions()` to show the session record survived the crash.
8. **Steer** — sends an interrupt steer to the (now-dead) hosted pane.

### Expected output

```
[co host-proof] running against claude in project 'proj-abc123'…
[co host-proof] result:
  turnRan=true
  turnIdle=true
  mailRouted=true
  sessionReconstructed=true
  steerCompleted=true
  recoveredSessions=1
[co host-proof] PASS — all proof steps completed.
```

### Pass criteria

| Step | Pass condition |
|------|---------------|
| Turn ran | `turnRan=true` (no error during `runOneTurn`) |
| Turn idle | `turnIdle=true` (byte-quiescence reached) |
| Mail routed | `mailRouted=true` (agent called `co_mail_send`; `LiveDelivery` routed it to parent's inbox) |
| Recovery | `sessionReconstructed=true` (agent session in recovered state) |
| Steer | `steerCompleted=true` (interrupt key sent without error) |

If any step fails, `co-mcp host-proof` exits non-zero with a descriptive error.

## Running `co serve` and observing the daemon

For a longer-running proof:

```sh
co-mcp serve <projectId>
```

Starts the `ConductorHostRunner` on a 1-second cadence. On each tick it logs:

```
[co serve] tick 1 candidates=1 selected=impl-abc123 cadence=false
[co serve] tick 2 candidates=1 selected=- cadence=false
```

Send a mail to a hosted agent to trigger an injection on the next tick:

```sh
co mail send --to impl-abc123 --type operator_message --subject "steer" --body "continue"
```

The daemon picks it up on the next beat and runs one turn.

## Troubleshooting

| Symptom | Likely cause |
|---------|-------------|
| `[host-live] co serve: binding the co MCP surface…` | `makeTransport` not injected (expected in serve; host-proof wires it) |
| `recoverProjectStore` fails | Corrupt event store — run `co doctor` to diagnose |
| `driveToReady` timeout | Provider startup slower than expected — increase `quietWindow` |
| `turnRan=false` | `injectMail` echo mismatch — check provider prompt format |

---

*Ladders to v1 acceptance criteria: SH-1 (self-host proof), SH-2 (operator-verifiable), SH-3 (crash-safe recovery).*
