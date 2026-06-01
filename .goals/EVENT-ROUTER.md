# The Event Router → the Conductor (runtime engine)

## Claude Orchestrator

- **`co run`** — the headless, non-TTY event router. Wakes WAITING agents that
  have unread mail, runs their next turn, and loops on a poll interval (default
  0.5s). Stops on SIGINT/SIGTERM. Can be restricted to a single task.

This is the engine the TUI wraps; it's a long-running daemon, auto-started by the
dispatcher when needed.

## Code Orchestration

The prototype's `co run` — a headless, non-TTY poll loop that woke WAITING agents with unread
mail, ran one turn, and slept — is **superseded by the Conductor** (CORE-CONCEPTS), the named
runtime engine. The Conductor keeps the same *role*: wake a WAITING agent that has unread mail,
run its turn, route the mail it emits, reconcile stuck/zombie agents, and carry escalations up the
chain. As in the prototype, the engine is **never agent-callable** — invoking it directly is a hard
block (PERMISSIONS).

What changes is the *mechanism*, and it is **deliberately parked** (Principle 16 —
decisions-deferred). The prototype spawned a fresh headless `claude -p` / `codex exec` process per
turn; the rewrite's directive is the opposite — agents are **long-lived authentic interactive
sessions** in a real terminal (Principle 2 — authentic-terminal), with `co`'s flow layered on via
MCP + input-injection. The concrete questions the substrate research must settle:

- **Turn execution** — driving one turn of a *live* session (inject mail, detect turn/idle
  boundaries) rather than spawning a one-shot process.
- **Spawn & transport** — how a placed agent is launched and hosted (Codex `exec` vs `app_server`,
  the equivalent Claude path) — DISPATCH, PROVIDERS.
- **Liveness** — telling a dead/zombie session from a slow turn (the live watchdog) —
  HEALTH-and-DIAGNOSTICS, STATE-and-RECOVERY.

The *operator-facing* behavior is already fixed across the other topics (turn-based plumbing, mail
routing, reconciliation, throttle-as-WAITING); only the substrate that powers it waits on evidence.
Full open-question set: `.research/runtime-substrate.md`.
