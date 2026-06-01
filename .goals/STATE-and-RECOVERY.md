# State, Persistence & Recovery

## Claude Orchestrator

All runtime state lives in a local **SQLite database** (`.co/state.db`) with a
versioned, migration-based schema. Core tables: `agents`, `turns`, `mail`,
`reviews`, `phases`, `specs`, `events`, `kickbacks`.

Everything is an **event** — the system records a durable event stream that can be
inspected and replayed.

- **`co status`** — show all active agents + phases (JSON available, task-scoped).
- **`co inspect <agent>`** — deep inspection of a single agent.
- **`co tail <agent> [--follow]`** — stream an agent's turn-log output.
- **`co log <agent> [--turn N]`** — show one turn's log (latest by default).
- **`co replay`** — replay recorded events, filterable by task / agent / limit.
- **`co attach [task]`** — re-attach the TUI to a running task.
- **`co mail`** — inspect the mail bus (by agent, unread-only, limited).

### Recovery & cleanup

- **`co unstick <agent>`** — flip a STUCK agent (or `--force` a RUNNING zombie)
  back to WAITING so the router picks it up; records a `state.unstuck.manual` event
  with an optional `--reason`.
- **`co pause <agent>`** — suspend a running agent.
- **`co stop` / `co kill <agent>`** — terminate an agent. `--clean` also removes
  the worktree; `--soft` is a DB-only stop; `--continue` is an operator-only
  non-terminal Coordinator stop that signals the turn, sets WAITING, and forces a
  fresh next turn.
- **`co cleanup --task`** — report (dry-run default) or, with `--yes`, remove
  landed task branches and artifacts after proving the branches merged into base.
- **`co nuke --all | --task`** — wipe runtime state.

### Background reliability

- A **watchdog** marks orphaned RUNNING turn rows as errored after a configurable
  stale age (default 6h) — for recovering after a crash/restart, not as a live
  kill-switch.
- An **idle** mechanism and a **task router** handle waking and stepping agents.

## Code Orchestration

**State leaves the repo.** The single biggest change: nothing orchestration-related lives in the
target repo anymore (Principle 12 — pristine-repo). The prototype's in-repo `.co/state.db` — the thing that bloated
every repository — is gone. All runtime state lives in the **app's program-data, keyed per project**
(see WORKTREES on the path-based registry and INIT-and-CONFIG on global-vs-repo config). The repo
stays pristine; the state follows the project, not the working tree.

**Everything is still an event** (Principle 14 — recoverable). The durable record is authoritative: agents, turns,
mail, reviews, phases, specs, and events are all recorded, inspectable, and replayable, and the
system can always be reconstructed from that record. Whether the store is pure event-sourcing or
mutable state tables alongside an append-only event log is a *stack-time* mechanism choice (it rides
on the still-undecided stack); the **invariant** — recoverable from its own record — is what's fixed
here.

**State is local-only, per machine.** Each machine keeps its own program-data; nothing syncs across
machines, and that's deliberate (YAGNI). Live agents are host-bound anyway — a running interactive
session can't migrate — and the cross-machine pain that actually bit (a provider binary updated on
one computer but not the other) is a *version* problem solved by the startup doctor
(HEALTH-and-DIAGNOSTICS), not a state-sync problem. Portable history is a noted non-goal, revisited
only if real demand appears.

**Observability is rendered per audience** (Principle 3 — render-per-audience). The prototype's inspection verbs —
`status`, `inspect`, `tail`/`log`, `replay`, `mail` — carry over as the thin power-user CLI
(CLI-REFERENCE), and the *same* underlying state drives the desktop app's first-class panes: the
agent-graph/branch view, per-agent transcripts, the mail client, and the cost view (TUI). One record,
two renderings — never JSON dumped at the operator.

### Recovery — two layers

Recovery splits cleanly along the substrate boundary:

- **Record recovery (substrate-independent — always possible).** Because the record survives any
  crash, restart, or reboot, on relaunch `co` reconstructs everything it knew — the agent tree,
  phases, mail, reviews, and the locked spec — straight from program-data. This is the Principle 14 (recoverable) guarantee, and it holds
  regardless of how the runtime is eventually built.

- **Live-session recovery (substrate-dependent — waits on the research).** A running agent *is* a
  live interactive session bound to its host process/pty; if the app or machine dies, that session
  dies with it — you cannot re-attach a dead terminal. So recovery **reconciles rather than
  resumes**: an agent whose host vanished is flipped from RUNNING to a recoverable state and
  re-dispatched from its last durable turn, never silently resumed mid-breath. The *operator-facing
  behavior* — zombies reconciled, work re-picked-up cleanly, nothing dropped (Principle 9 — no-silent-failures) — is set
  now; the *mechanism* (whether a provider session can `--resume`, how much in-flight context
  survives a host restart) is part of `.research/runtime-substrate.md`.

### Recovery & cleanup verbs

The prototype's recovery surface carries, reframed under "block only the destructive; tools do the
heavy lifting" (Principle 6 — tools-do-the-work): `unstick` (reconcile a stuck/zombie agent back to WAITING), `pause`,
`stop`/`kill`, `cleanup` (which *proves* branches merged into base before removing anything —
dry-run by default), and the gated `nuke`. None of these are agent-callable; recovery is an operator
affordance, available from both the CLI and the app. The background **watchdog** that reconciles
orphaned RUNNING turns remains the in-flight monitoring layer (the middle tier of Principle 9 — no-silent-failures —
pre-flight / in-flight / post-hoc), but its live form — how it detects a truly dead session versus a
slow turn — is one of the things the session model must pin down.
