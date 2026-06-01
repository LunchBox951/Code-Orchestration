# Research: Runtime Substrate

**Status: open.** This is the keystone decision parked pending evidence (Principle 16 —
decisions-deferred; see [`../PRINCIPLES.md`](../PRINCIPLES.md)). Everything *substrate-independent*
is already settled across `.goals/`; this file collects the questions that genuinely wait on the
runtime substrate, so the deferral is explicit and every "waits on the research" reference in the
design resolves to one place.

## The operator directive (the fixed anchor)

Agents run as the **authentic interactive `claude`/`codex`** in a **real terminal emulator (pty)** —
like a Linux console — with `co`'s flow layered on top via the **MCP backend + input-injection**.

- **NOT** headless one-shot (`claude -p` / `codex exec`) — that was the prototype, now retired
  (Principle 2 — authentic-terminal).
- **NOT** tmux.

The runtime engine that drives these sessions is the **Conductor** (`.goals/CORE-CONCEPTS.md`,
`.goals/EVENT-ROUTER.md`) — named and role-fixed, mechanism-deferred.

## Open questions (substrate-dependent)

Harvested from every topic that flagged a deferral:

1. **Turn execution** (CORE-CONCEPTS, EVENT-ROUTER) — how does the Conductor run *one turn* of a
   long-lived interactive session? Programmatic mail-injection into a live pty; detecting turn/idle
   boundaries (knowing when a turn is "done").
2. **Spawn & transport** (DISPATCH, PROVIDERS) — how is a placed agent actually launched and hosted?
   Codex `exec` vs `app_server`; the equivalent Claude session-hosting path; subscription auth in an
   interactive (not headless) session.
3. **Live-session recovery** (STATE-and-RECOVERY) — can a provider session `--resume`? How much
   in-flight context survives a host restart? (Record recovery is already substrate-independent; only
   *live*-session reconciliation waits here.)
4. **Liveness / watchdog** (HEALTH-and-DIAGNOSTICS, PERMISSIONS) — how to distinguish a truly dead or
   zombie session from a slow turn; the break-detection signals (e.g. "turn ending without a finish")
   the reactive protocol-monitor rides on.
5. **Block-enforcement layer** (PERMISSIONS) — are the hard blocks enforced via the host harness'
   permission system or via `co`'s own PreToolUse hooks? (The block *list* is settled; the
   enforcement *layer* is partly substrate-dependent.)
6. **Agent-console reliability** (TUI) — making the live terminal-emulator pane reliable:
   mail-injection, turn/idle detection, subscription auth, startup handling.
7. **Implementation stack** — *language settled: TypeScript* (one core, thin MCP/app/CLI adapters;
   `node-pty` + `xterm.js` for the authentic-terminal keystone) — see
   [`language-and-stack.md`](language-and-stack.md). Still open: the **desktop-app shell**
   (Electron vs. Tauri-with-a-Node-sidecar), which stays coupled to whatever the questions above
   resolve to.

## Method

Decide by **evidence at spec-execution time** — probe the actual provider session APIs and
transports, validate against the directive above, then commit. Measure before building.

> When a question here is resolved, fold the answer back into its home topic's substrate-dependent
> half and update this file's status.
