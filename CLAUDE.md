# Project notes for CO agents

Project-specific memory for this repo. How to _be_ an orchestrated co agent (mail, review,
dispatch, recovery) ships in co's role prompts and `co orient`, never here
(`docs/architecture/prompts-and-memory.md`).

## Test command

```
pnpm test
```

(Single package: `pnpm vitest run packages/<name>`.)

## Build / lint / type-check commands

```
pnpm lint
pnpm typecheck
pnpm build
pnpm format:check
```

Run all five (`test` included) before considering a diff done.

## Conventions & architecture

- TypeScript monorepo, **pnpm workspaces**. `packages/core` is the single source of truth;
  `packages/cli` and `packages/mcp` are thin adapters that `import` it — never duplicate core
  logic in an adapter. `apps/desktop` is the Electron operator cockpit (same thin-adapter rule).
- ESM only (`"type": "module"`, NodeNext). Import local files with the `.js` extension.
- Strict TypeScript. Use `assertNever` from `@co/core` for exhaustive discriminated-union
  switches rather than a silent default branch.
- **Conventional Commits**, and **sign off every commit** (`git commit -s`, DCO).

## The docs

Design rationale lives in `docs/` — start at [`docs/README.md`](docs/README.md) for the reading order.

- [`docs/concepts.md`](docs/concepts.md) — shared vocabulary (Operator, Conductor, Agent, Mail,
  Task, Phase, Spec, Review, Worktree, Provider).
- [`docs/principles.md`](docs/principles.md) — the 16 invariants, cited inline as
  `Principle N — handle` (grep a handle to land there).
- [`docs/v1-acceptance-criteria.md`](docs/v1-acceptance-criteria.md) — the project-wide definition
  of v1 (`co` self-hosts; the prototype retires).
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — setup, the five required checks, and the branch-from-`dev`
  / PR-against-`dev` / DCO flow.
- [`docs/architecture/review-gates.md`](docs/architecture/review-gates.md) — the merge/push/PR gate model.
