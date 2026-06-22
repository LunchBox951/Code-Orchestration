# Conductor Host-Proof Runbook (P4)

This document is the operator guide for the `[host-live]` phase of the Stage 10 P4 acceptance
criteria. It describes the one-command proof that the Conductor's end-to-end plumbing works against
a **real** `claude` or `codex` binary on the operator's host.

Everything in this runbook executes on the **operator's host machine** — not in a sandbox. The
in-sandbox proof (AC-S10-4 items 1–4) runs automatically as part of `pnpm test`.

> **Companion:** the [worker benchmark](worker-benchmark.md) (`pnpm test:live`) reuses the same
> host-live seam bundle but goes further than this scripted plumbing proof — it hosts a real
> _implementer_ that writes code with its own tools and then objectively grades the artifact. Use this
> host-proof for the fastest plumbing check; use the worker benchmark to measure real work.

---

## Proof fidelity: one `runProof({fake|claude|codex})` driver

The in-sandbox proof and this operator proof are the **same driver** — `runProof` in
`packages/mcp/src/conductor/host-proof.ts` — differing only by the resolved seam bundle:

- **`runProof('fake')`** resolves a `FakePty` + the in-sandbox `FakeProvider` (a scripted
  startup → spinner → quiet timeline that also drives the MCP client to call `co_mail_send`), an
  in-memory transport, and an injected counter clock / quiet window. This is what `pnpm test` runs.
  Its result is tagged **`fidelity: 'sandbox-fake'`**.
- **`runProof('claude')` / `runProof('codex')`** resolve the host-live bundle — a real `NodePtyHost`
  (node-pty), the socket-bridge transport, and real timers — exactly what `co-mcp host-proof <provider>`
  runs below. Its result is tagged **`fidelity: 'host-live'`**.

`fidelity` is **derived from the resolved pty host, never passed in**: a `FakePty` ⇒ `sandbox-fake`,
a `NodePtyHost` ⇒ `host-live`, and any mismatch (e.g. a non-`FakePty` resolved for `fake` mode, or a
host matching neither) throws (Principle 9 — fail-loud). A `fake` run can therefore **never** be
mislabeled `host-live`.

> **A green `fake` run is NOT host-live evidence.** `sandbox-fake` proves the harness wiring — that
> the spawn → inject → turn → route → steer → SIGKILL → recover sequence is correctly composed. It
> does **not** prove a real `claude`/`codex` binary reached `ready` and routed mail through a real pty
> (Principle 2 — authentic-terminal). Only a `host-live` result is SH-1 evidence.

`assertHostLiveProof(result)` is the **forward gate** for this distinction: it throws unless
`result.fidelity === 'host-live'`. There is no programmatic SH-1-evidence sink today (this command
prints to stderr and exits; SH-1 evidence is the manual bundle in [`sh1-runbook.md`](sh1-runbook.md)),
so any **future** SH-1-evidence recorder MUST call `assertHostLiveProof` before recording a result as
host-live / SH-1 evidence.

---

## Prerequisites

1. `co` and `co-mcp` built (`pnpm build` in the repo root) and resolvable from the shell. If `co`
   is not on `$PATH`, set `CO_CLI_COMMAND=/absolute/path/to/co` before running Codex-backed proofs.
2. A registered project (`co doctor` should show `ok` for program-data-integrity).
3. The target provider for `co-mcp host-proof <provider>` installed and authenticated:
   - Claude: `claude auth status --json` shows `logged_in: true`.
   - Codex: `codex doctor --json` shows `authenticated: true`.
4. For the `co doctor --live` preflight, **both** monitored providers (`claude` and `codex`) must
   be installed and authenticated. `doctor --live` probes the whole monitored provider set; run the
   provider-specific `co-mcp host-proof <provider>` command when you only need to prove one target.

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
4. **Inject route-proof mail** — creates a nonce-bearing `clarify_request` to the proof agent and
   injects it.
5. **Route-proof turn** — runs `engine.runOneTurn`, observes byte output, and detects the idle
   boundary for the route-proof turn.
6. **Mail route proof** — the real provider must call `co_mail_send` to `@operator` and echo the
   nonce in the subject or body; stale or wrong-sender mail does not count.
7. **Steer-proof turn** — seeds a second no-tools steer mail, waits until that mail is submitted
   into the same warm pane, then sends an interrupt steer before that second turn settles.
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
| Turn ran | `turnRan=true` (no error during the route-proof `runOneTurn`) |
| Turn idle | `turnIdle=true` (the route-proof turn reached byte-quiescence) |
| Mail routed | `mailRouted=true` (the real provider called scoped `co_mail_send` and echoed the proof nonce to the parent inbox) |
| Recovery | `sessionReconstructed=true` (agent session in recovered state) |
| Steer | `steerCompleted=true` (interrupt key sent before crash simulation) |
| Mid-turn steer | `steerMidTurn=true` (interrupt was sent after the steer-proof mail was submitted and before that second turn promise settled) |

If any step fails, `co-mcp host-proof` exits non-zero with a descriptive error.

Each run creates a unique `host-proof-*` agent id and nonce-bearing proof mail. The event log keeps
the durable audit trail, but the live session projection is cleaned up when the proof closes its
engine. The proof does not reuse a stable agent id because stale mail from prior runs must never
satisfy the current nonce.

## SH-5 companion check — blocked raw publish deny

The `host-proof` command proves host-live routing/steer/recovery. `SH-5` also needs a real-provider
permission-hook capture because a green sandbox block-list is not host-live evidence. Run this
companion check once per provider during the same live session:

1. Open a real hosted Claude/Codex pane in the Agents Console.
2. Ask the agent to attempt an inert raw publish command and **do not approve any permission prompt**:

   ```sh
   git push --dry-run origin HEAD:refs/heads/co-sh5-deny-proof
   ```

3. Capture the pane transcript showing the command was denied before execution by the hosted
   permission hook / nudge path.
4. Confirm the remote has no `co-sh5-deny-proof` ref and attach both artifacts to the acceptance
   evidence.

Pass condition: the raw command fails closed in the provider pane before any git network mutation.
Failure condition: the command reaches git execution, asks for human approval instead of being
blocked, or mutates a remote ref. Repeat with a `gh pr create` / `gh pr merge` shape if the run's
scope specifically exercises PR publication.

## Running `co-mcp serve <projectId>` and observing the daemon

For a longer-running proof:

```sh
co-mcp serve <projectId>
```

Starts the `ConductorHostRunner` on a 1-second cadence. On each tick it logs:

```
[co-mcp serve] tick 1 candidates=1 cold=0 selected=impl-abc123 cadence=false
[co-mcp serve] tick 2 candidates=1 cold=1 selected=- cadence=false
```

`cold=1 selected=-` means recovery found a RUNNING session record but this `co-mcp serve` process
has not reattached a warm pane for it, so the daemon reports the cold candidate instead of injecting
a turn. A mail injection on the next beat requires a warm hosted pane (`selected=<agent>` on a prior
tick, or an agent this process has launched/hosted through the normal placement path).

After an agent is warm/hosted, send it mail to trigger an injection on the next tick:

```sh
co mail send --to impl-abc123 --type operator_message --subject "steer" --body "continue"
```

The daemon picks it up on the next beat and runs one turn.

### Recording host-live capture evidence

`co-mcp serve` can record the real provider bytes needed to finalize the live-readiness placeholders
for #77/#78. Set `CO_HOST_LIVE_CAPTURE` to an **absolute path outside the repository** before
starting the daemon:

```sh
mkdir -p /tmp/co-host-live-capture
CO_HOST_LIVE_CAPTURE=/tmp/co-host-live-capture co-mcp serve <projectId>
```

When armed, the daemon logs the resolved capture directory and writes JSONL files such as
`paste-echo.jsonl`, `mcp-approval.jsonl`, `claude-status-line.jsonl`, and `usage-sample.jsonl`.
These files contain raw, unredacted pane bytes that may include secrets, tokens, or environment
values, so treat them as sensitive (the capture dir is created owner-only, `0o700`/`0o600`). Inspect
and attach the relevant excerpts to the issue or PR, but do not commit them to the repo. Relative
paths and paths inside the repo are rejected to preserve Principle 12 — pristine-repo.

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
