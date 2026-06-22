# Code Orchestration Agent Map

`co` is a pre-alpha, desktop-first multi-agent software-engineering orchestrator. It runs real
Claude/Codex terminal sessions, coordinates agents through typed persisted mail, and gates merges,
pushes, and PRs through review.

This repo is a TypeScript pnpm-workspace monorepo:

- `packages/core` is the domain core and single source of truth.
- `packages/cli` and `packages/mcp` are thin adapters over core; do not duplicate core logic there.
- `apps/desktop` is the Electron operator app surface.
- `docs/` is the canonical design corpus and should carry rationale, not this file.

This file is **project memory** — what this repo is, and how to build and verify it. How to _be_ an
orchestrated agent (mail, review, dispatch, recovery) ships in `co`'s role prompts and `co orient`,
never here ([`docs/architecture/prompts-and-memory.md`](docs/architecture/prompts-and-memory.md)).

## Read These First

- [`README.md`](README.md) — the shortest product and repository overview.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — setup, required checks, branch/PR flow, Conventional
  Commits, DCO sign-off, and code conventions.
- [`docs/README.md`](docs/README.md) — the design-doc reading order; start here before changing
  architecture or terminology.
- [`docs/concepts.md`](docs/concepts.md) — the shared vocabulary for Operator, Conductor, Agent,
  Mail, Task, Phase, Spec, Review, Worktree, and Provider.
- [`docs/principles.md`](docs/principles.md) — the 16 invariants, preferably cited as
  `Principle N — handle`.
- [`docs/v1-acceptance-criteria.md`](docs/v1-acceptance-criteria.md) — the project-wide definition
  of v1 (`co` self-hosts; the prototype retires).
- [`docs/architecture/review-gates.md`](docs/architecture/review-gates.md) — the merge/push/PR gate
  model; read before any outward publishing path.

## Operating Notes

- Keep this file compact. Add durable detail to the canonical doc that owns it, then link it here
  only if every agent truly needs the pointer.
- Follow the check and contribution flow in [`CONTRIBUTING.md`](CONTRIBUTING.md) before considering a
  diff done.
