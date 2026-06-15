# Research → Decision: Language & Implementation Stack

**Status: FULLY DECIDED — language TypeScript; desktop shell Electron.** The *language* half
was settled 2026-06-01 (`runtime-substrate.md` open question #7). The *shell framework*
sub-question is now resolved: **the shell is Electron** (decided Stage 11, 2026-06-15 —
see *Shell decision* below). Both halves closed; Principle 16 — decisions-deferred satisfied.

**Decided:** 2026-06-01.

---

## Decision

**The implementation language is TypeScript.** One language end-to-end: a single shared
**core library**, consumed by three thin adapters — the agent **MCP server**, the operator
**desktop app**, and the power-user **CLI** — realizing the "one core, thin adapters" mandate
(Principle 4 — one-agent-surface; [`../architecture/mcp-tools.md`](../architecture/mcp-tools.md)) inside a
single module graph with no cross-language seam.

The runtime is Node.js. The desktop shell is **Electron** (see *Shell decision* below for rationale).

## How the decision was reached

Four independent analyses, deliberately structured to avoid a single line of reasoning:

- Three background agents were each asked the same question — *"what language should we use?"* —
  while **forbidden a different strong candidate**: one could not pick Python, one could not pick
  Rust, one could not pick Go. Each read [`../README.md`](../README.md) and reasoned from the corpus
  under [`../architecture/`](../architecture/) independently.
- A fourth, **unconstrained** analysis ran in parallel.

**All four converged on TypeScript.** Removing Python → TS won; removing Rust → TS won; removing
Go → TS won; with no constraint → TS won. TypeScript dominates regardless of which single rival
is deleted from the field.

> **Honest methodological caveat.** No analysis was forbidden *TypeScript itself*, so the field
> was never forced to mount the strongest possible **anti-TS** case. The runner-up data points at
> **Rust**. The convergence is strong (TS survives the deletion of any one competitor), but the
> "if not TS, then what?" question was not adversarially stress-tested. Re-open this note before
> committing capital if that contrarian view is wanted.

## Why TypeScript — tied to the requirements

The decision is dominated by the project's hardest, highest-risk, explicitly-parked requirement:
**the agent console** — a *real* xterm-style terminal emulator hosting the **authentic interactive
`claude`/`codex` pty session** inside a desktop pane, with input-injection and turn/idle detection
(Principle 2 — authentic-terminal; [`../architecture/tui.md`](../architecture/tui.md),
[`../architecture/event-router.md`](../architecture/event-router.md), and `runtime-substrate.md` Q1/Q6).

1. **It de-risks the keystone before a line is written.** `node-pty` + `xterm.js` is the most
   battle-tested pty-hosting + terminal-rendering pair in existence — the exact combination VS
   Code's integrated terminal and Hyper ship. The scariest part of the substrate research becomes
   *integration against mature libraries*, not *invention in a thin-prior-art ecosystem*.
2. **MCP is TS-native.** The reference MCP SDK is TypeScript, so the sole agent surface
   (Principle 4 — one-agent-surface) is idiomatic and stays in lockstep with the protocol the
   providers themselves speak. The providers (`claude`/Codex) are Node, easing the still-open
   session-hosting/transport probes (`runtime-substrate.md` Q2).
3. **"One core, thin adapters" with zero serialization seams.** The Electron main process, the MCP
   server, and the CLI all `import` the same core module — logic *cannot* drift
   ([`../architecture/mcp-tools.md`](../architecture/mcp-tools.md)).
4. **Node's async event loop fits the Conductor.** Supervising many concurrent pty sessions, the
   typed mail bus, watchdog liveness, and the rate-limit balancer
   ([`../architecture/dispatch.md`](../architecture/dispatch.md),
   [`../architecture/cost-and-usage.md`](../architecture/cost-and-usage.md)) is pure I/O multiplexing — Node's
   wheelhouse, with no CPU-bound hot path in the design to fight it.
5. **Typed envelopes are cheap and safe.** The mail bus, MCP schemas, specs, and event-sourced
   records ([`../architecture/mail-bus.md`](../architecture/mail-bus.md),
   [`../architecture/state-and-recovery.md`](../architecture/state-and-recovery.md)) are JSON contracts; one
   Zod schema serves runtime validation, static types, **and** JSON-Schema generation for the
   self-describing surface (Principle 5 — self-describing).

## Known costs (accepted, with mitigations)

- **Electron footprint** — bundled Chromium + memory, multiplied by many live terminal panes.
  *Mitigation:* lazy panes; keep the core in Electron's main process and expose only a narrow
  contextBridge surface to the sandboxed renderer.
- **No compiler-enforced safety floor** for a system whose promise is *no silent failures /
  recoverable* (Principles 9, 14). *Mitigation:* `strict` mode + runtime schema validation (Zod) at
  every adapter/MCP boundary — discipline, not the type system alone.
- **Native-addon packaging** — `node-pty` needs per-platform prebuilds across Linux/macOS/Windows;
  the program-data store uses Electron's bundled `node:sqlite`, not `better-sqlite3`
  ([`../architecture/worktrees.md`](../architecture/worktrees.md),
  [`../architecture/init-and-config.md`](../architecture/init-and-config.md) auto-update).
- **Single-threaded by default** — large diff/event-replay must move to worker threads or it stalls
  the loop.

## Alternatives considered (and why not)

- **Rust (Tauri)** — the serious runner-up (named by two of three constrained analyses). Compile-time
  safety + fearless concurrency map beautifully onto "everything is an event, never drop" (Principles
  9, 14), and Tauri ships a lean single binary. **Rejected because:** Tauri still pushes TypeScript
  for the UI, yielding a *two-language* build with an FFI/IPC seam through the exact boundary the
  design wants seamless; and it would force pioneering the riskiest feature (embedded interactive
  terminal) in the ecosystem with the least prior art — buying down risks (memory safety, raw
  throughput) this I/O-bound, subscription-rate-limited workload does not actually have.
- **Go** — strong concurrency, single static binary, clean `gh`/subprocess integration. **Rejected
  because:** the weakest desktop-GUI / embedded-terminal story of any systems candidate — it sinks on
  the one requirement that defines the product.
- **Python** — the prototype's language (`/home/Projects/Claude-Orchestrator`, Python 3.11 / Textual /
  Rich / `anthropic`); lowest migration friction, team already fluent. **Rejected because:** the
  rewrite is a deliberate pivot *away* from the headless/Textual-TUI model toward a desktop GUI with
  embedded terminals — Python's weakest area; staying would likely force a polyglot UI anyway,
  forfeiting the single-core advantage that is the whole point. (Notably, Python was *available* to
  two of three constrained analyses and to the unconstrained one — and none chose it.)

## Shell decision (Stage 11 — 2026-06-15)

**The desktop shell is Electron.** Rationale:

1. **Zero seam.** Electron's main process IS Node, so it `import`s the same `@co/core` +
   `@co/mcp` with no serialization boundary, FFI, or sidecar — the "one core, thin adapters"
   mandate (Principle 4) is satisfied by construction.
2. **Battle-tested pty home.** `node-pty` + `xterm.js` is the exact combination VS Code's
   integrated terminal and Hyper ship. The authentic-terminal keystone (Principle 2) becomes
   integration against mature libraries, not pioneering thin prior art.
3. **`node:sqlite` built-in.** Electron 36+ bundles Node 22.x (≥22.5), which includes
   `node:sqlite` natively — the program-data store works in-process in the main process
   with no extra native-addon packaging.
4. **Tauri would add Rust + a Node sidecar.** Tauri pushes TypeScript for the UI but Rust for
   the shell, yielding a two-language build with an IPC seam at the exact boundary the design
   wants seamless. Forcing a Node sidecar for `@co/core` / pty access taxes the v1 keystone to
   optimize distribution — a v1 non-goal.

> Reading order & project framing: [`../README.md`](../README.md).
> This decision is also recorded in `runtime-substrate.md` item 7 and `v1-acceptance-criteria.md` SF-5.
