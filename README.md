# Code Orchestration (`co`)

> Autonomous multi-agent software engineering that stays auditable, gated, recoverable — and steerable.

**Status: in active development (pre-alpha). Linux AppImage automation exists; npm/package
publishing, polished cross-platform installers, and public onboarding are not v1 goals.**

`co` runs a team of AI coding agents (Claude and Codex behind one provider-neutral dispatch model) as
**live, interactive terminal sessions** you can watch and steer, while the agents coordinate among
themselves through a **typed mail bus**. Every change passes a **strict review gate** before it can
merge, push, or publish, and durable orchestration state is recorded so the system can be inspected,
replayed, and recovered.

`co` is being built **using its own model** — this repository is orchestrated by a prototype of the
very system it describes, and will graduate to self-hosting once `co` can build `co`. That
dogfooding story is the project's north star (see [`docs/migration.md`](docs/migration.md)).

## Two interaction surfaces

- **Agent ↔ you — the live terminal.** Each agent is a real interactive `claude`/`codex` session in
  its own pane; drop in and redirect it mid-work.
- **Agent ↔ agent — the typed mail bus.** Structured, persisted envelopes; the disciplined spine of
  multi-agent work. You're a first-class participant — escalations filter up to your inbox.

## Repository

This is a TypeScript monorepo (pnpm workspaces):

- `packages/core` — the domain core (single source of truth).
- `packages/cli` — the `co` command-line adapter.
- `packages/mcp` — the agent-facing MCP server (the sole agent surface).
- `apps/desktop` — the Electron operator desktop app.

## Docs

Design rationale lives in [`docs/`](docs/README.md) — start there for the "why" behind `co`. The 16
invariants the system holds itself to are in [`docs/principles.md`](docs/principles.md), cited
throughout the code as `Principle N — handle`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Work flows from a task-owned spec into phases and reviewed
changes, mirrored in GitHub Issues, the Project board, and branch protection. By participating you
agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Licensed [MIT](LICENSE).
