# Code Orchestration Agent Map

`co` is a pre-alpha, desktop-first multi-agent software-engineering orchestrator. It runs real
Claude/Codex terminal sessions, coordinates agents through typed persisted mail, and gates merges,
pushes, and PRs through review.

This repo is a TypeScript pnpm-workspace monorepo:

- `packages/core` is the domain core and single source of truth.
- `packages/cli` and `packages/mcp` are thin adapters over core; do not duplicate core logic there.
- `apps/desktop` is the operator app surface.
- `docs/` is the canonical design corpus and should carry rationale, not this file.

## Read These First

- [`README.md`](README.md) — the shortest product and repository overview.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — setup, required checks, branch/PR flow, Conventional
  Commits, DCO sign-off, and code conventions.
- [`docs/README.md`](docs/README.md) — the design-doc reading order; start here before changing
  architecture or terminology.
- [`docs/concepts.md`](docs/concepts.md) — the shared vocabulary for Operator, Conductor, Agent,
  Mail, Task, Phase, Spec, Review, Worktree, and Provider.
- [`docs/principles.md`](docs/principles.md) — the 16 invariants cited as `Principle N — handle`;
  use this instead of the frozen root `PRINCIPLES.md` migration residue.
- [`docs/v1-acceptance-criteria.md`](docs/v1-acceptance-criteria.md) — the project-wide definition
  of v1; every spec's acceptance criteria must ladder up to IDs here.
- [`docs/architecture/review-gates.md`](docs/architecture/review-gates.md) — the merge/push/PR gate
  model; read before any outward publishing path.
- [`docs/migration.md`](docs/migration.md) — explains the temporary `.co/`, `.claude/`, and
  `.codex/` prototype footprint and when it disappears.

## Operating Notes

- Keep this file compact. Add durable detail to the canonical doc that owns it, then link it here
  only if every agent truly needs the pointer.
- Follow the check and contribution flow in [`CONTRIBUTING.md`](CONTRIBUTING.md) before considering a
  diff done.
- Do not bypass the review gate: use the sanctioned `co` gated publish/merge path instead of raw
  `git push`, `gh pr create`, or `gh pr merge`.
- Do not treat `.co/`, `.claude/`, or `.codex/` as product code; they are temporary prototype
  residue documented in [`docs/migration.md`](docs/migration.md).
