# The TUI

### A one-stop-shop cockpit — agent-first, manual-second

The desktop app aims to **absorb the alt-tab**: keep the operator in the orchestration flow by
covering the basics they'd otherwise leave for. It is deliberately **not a new VS Code** — it's
an agentic-coding cockpit where **observing and steering the agents comes first** and manual
coding is a secondary convenience. The insight: most "IDE" needs here are really
*observe-the-work* needs, so they're agent-experience surfaces, not concessions.

**Primary — observe, review & steer (agent-experience surfaces):**
- **Agent consoles** — the live rendered session per agent (see below).
- **Mail client** — the operator inbox/outbox + agent-bus toggle ([MAIL](mail-bus.md)).
- **Diff viewer** — review changes per agent / branch / phase; *the surface human review runs on*
  ([REVIEW-GATES](review-gates.md)).
- **Branch / worktree / agent-graph view** — what's in flight across the many parallel agents.
- **Code browser** — read-only file tree + syntax-highlighted viewer (you read more than you write).
- **Codebase search** — grep/find without leaving.
- **Test & log output** — criteria/baseline checks, agent logs, build output.
- **Gate / review UI** — verdicts, approvals, merges — including **human review** ([REVIEW-GATES](review-gates.md)).
- **Cost & rate-limit view** — per-agent/task spend + live provider headroom ([COST](cost-and-usage.md)).

**Secondary — manual coding (convenience, not an IDE):**
- **Scratch terminal** — a quick command without spawning an agent.
- **Light editing** — fix a typo yourself instead of dispatching an agent.

### The agent console (substrate-dependent, but directionally set)

Each agent's live view is a **real terminal emulator hosting the *authentic* interactive
`claude`/`codex` session** (xterm-style pty, like a Linux console) — *not* a headless
reconstruction, and *not* tmux. `co`'s flow is layered on top via the MCP backend + input
injection. What still depends on the **runtime-substrate research** is making that *reliable*:
programmatic mail-injection, turn/idle detection, subscription auth, and startup handling. The
*mail* half of the operator's experience is fully specified ([MAIL](mail-bus.md)); the *console* half resolves
once the research lands.

> Composer affordances carry from the prototype — `/help`, `/status`, the operator-only `/lock`
> spec-approval gate, and the buddy `/btw` channel — living in the composer alongside the panes
> above.
