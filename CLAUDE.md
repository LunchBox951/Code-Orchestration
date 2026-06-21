# Project notes for CO agents

This file is read by every CO agent at the start of its turn. CLAUDE.md and AGENTS.md
are kept in sync; if both exist, CLAUDE.md wins.

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
  logic in an adapter. `apps/desktop` is a parked stub.
- ESM only (`"type": "module"`, NodeNext). Import local files with the `.js` extension.
- Strict TypeScript. Use `assertNever` from `@co/core` for exhaustive discriminated-union
  switches rather than a silent default branch.
- **Conventional Commits**, and **sign off every commit** (`git commit -s`, DCO).
- Design rationale lives in `docs/` (start at `docs/README.md`); the 16 invariants are in
  `docs/principles.md` and are cited inline as `Principle N — handle`.

## Global v1 acceptance criteria

The project-wide definition of "v1 done" is [`docs/v1-acceptance-criteria.md`](docs/v1-acceptance-criteria.md)
— **read it before locking any spec.** v1 = `co` self-hosts and the prototype is retired. Every
spec's acceptance criteria must ladder up to a criterion there (cite its ID, e.g. `SH-2`). It is a
living document; advance and mark criteria as work lands.

## Things agents should not do

- Do not put orchestration state in the repo (Principle 12 — pristine-repo). The only
  sanctioned repo files are these memory files.
- Do not duplicate core logic into `cli`/`mcp`.

## Prototype footprint (temporary)

This repo is built by the Claude-Orchestrator **prototype**, which writes `.co/`, `.claude/`,
`.codex/` into the tree — a temporary tenant that violates Principle 12, **not part of the
product**. `.co/specs|plans|issues` are tracked only because worktree agents read _committed_
specs; everything else is ignored. The whole footprint is removed in the migration commit once
`co` can self-host. Don't build on, document, or treat `.co/` as product code. See
`docs/migration.md`.
