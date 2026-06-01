# The TUI

## Claude Orchestrator

A rich terminal UI (Textual-based) for operators to watch and drive orchestration.
It wraps the event router and presents live state through non-destructive tabbed
panes:

- **Chat / composer** — converse with agents; a composer with persistent history
  and slash-command suggestions.
- **Mail pane** — live view of the mail bus.
- **Diff pane** — view agent branch diffs.
- **Branches pane** — worktree/branch overview.
- **Graph pane** — the agent hierarchy / dispatch graph.
- **Transcript** — agent turn transcripts with rich widgets.
- **Sidebar + status bar + header** — agent roster, states, and live status.
- **Cost breakdown** — per-agent / per-task cost and usage.
- **Scope selector** — choose file scopes interactively.
- **Buddy modal** — the project buddy (see below).

### Slash commands (in the composer)

- **`/help`** — command help.
- **`/status`** — orchestration status.
- **`/worktrees`** — list worktrees.
- **`/cp`** — copy / composer-paste helper.
- **`/lock`** — **operator-only** spec lock (the spec-approval gate; there is no
  agent-callable spec-lock verb).

## Code Orchestration

### A one-stop-shop cockpit — agent-first, manual-second

The desktop app aims to **absorb the alt-tab**: keep the operator in the orchestration flow by
covering the basics they'd otherwise leave for. It is deliberately **not a new VS Code** — it's
an agentic-coding cockpit where **observing and steering the agents comes first** and manual
coding is a secondary convenience. The insight: most "IDE" needs here are really
*observe-the-work* needs, so they're agent-experience surfaces, not concessions.

**Primary — observe, review & steer (agent-experience surfaces):**
- **Agent consoles** — the live rendered session per agent (see below).
- **Mail client** — the operator inbox/outbox + agent-bus toggle (MAIL).
- **Diff viewer** — review changes per agent / branch / phase; *the surface human review runs on*
  (REVIEW-GATES).
- **Branch / worktree / agent-graph view** — what's in flight across the many parallel agents.
- **Code browser** — read-only file tree + syntax-highlighted viewer (you read more than you write).
- **Codebase search** — grep/find without leaving.
- **Test & log output** — criteria/baseline checks, agent logs, build output.
- **Gate / review UI** — verdicts, approvals, merges — including **human review** (REVIEW-GATES).
- **Cost & rate-limit view** — per-agent/task spend + live provider headroom (COST).

**Secondary — manual coding (convenience, not an IDE):**
- **Scratch terminal** — a quick command without spawning an agent.
- **Light editing** — fix a typo yourself instead of dispatching an agent.

### The agent console (substrate-dependent, but directionally set)

Each agent's live view is a **real terminal emulator hosting the *authentic* interactive
`claude`/`codex` session** (xterm-style pty, like a Linux console) — *not* a headless
reconstruction, and *not* tmux. `co`'s flow is layered on top via the MCP backend + input
injection. What still depends on the **runtime-substrate research** is making that *reliable*:
programmatic mail-injection, turn/idle detection, subscription auth, and startup handling. The
*mail* half of the operator's experience is fully specified (MAIL); the *console* half resolves
once the research lands.

> Composer affordances carry from the prototype — `/help`, `/status`, the operator-only `/lock`
> spec-approval gate, and the buddy `/btw` channel — living in the composer alongside the panes
> above.
