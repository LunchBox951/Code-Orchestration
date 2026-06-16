# Project notes for CO agents

This file is read by every Claude (CO) agent at the start of its turn. Keep it compact and
Claude-specific; durable detail belongs in the canonical doc that owns it (start at
[`docs/README.md`](docs/README.md)).

## Checks (run all five before a diff is done)

```
pnpm test        # vitest; single package: pnpm vitest run packages/<name>
pnpm lint
pnpm typecheck
pnpm build
pnpm format:check
```

Toolchain: Node >= 24 (see `.nvmrc`), **pnpm 10.33.0** (`corepack enable` or
`npm i -g pnpm@10.33.0`). Run `pnpm install` first.

## Conventions & architecture

- TypeScript pnpm-workspace monorepo. `packages/core` is the single source of truth;
  `packages/cli` and `packages/mcp` are thin adapters that `import` it — never duplicate core
  logic in an adapter. `apps/desktop` is the Electron operator app.
- ESM only (`"type": "module"`, NodeNext). Import local files with the `.js` extension.
- Strict TypeScript. Use `assertNever` from `@co/core` for exhaustive discriminated-union
  switches rather than a silent default branch.
- **Conventional Commits**, and **sign off every commit** (`git commit -s`, DCO) — PRs without
  sign-off fail the DCO check.
- Design rationale lives in `docs/`; the 16 invariants are in
  [`docs/principles.md`](docs/principles.md), cited inline as `Principle N — handle`.

## Branch & PR flow

- Branch from `dev`; open PRs **against `dev`** (the integration line). `main` is the stable
  release branch, updated only by a gated promotion PR from same-repo `release/*` branches.
- A PR merges only after the review gate returns **PASS** and required checks are green. Nits ride
  as suggestions into `dev` and become blockers in the `release/*` -> `main` promotion.

## v1 acceptance criteria

The project-wide definition of "v1 done" is
[`docs/v1-acceptance-criteria.md`](docs/v1-acceptance-criteria.md) — **read it before locking any
spec.** v1 = `co` self-hosts and the prototype is retired. Every spec's acceptance criteria must
ladder up to a criterion there (cite its ID, e.g. `SH-2`). It is a living document; advance and
mark criteria as work lands.

## Things agents must not do

- Do not bypass the review gate. Use the gated MCP tools (`co_merge`, `co_push`, `co_pr_merge`)
  instead of raw `git push`, `gh pr create`, or `gh pr merge`.
- Do not put orchestration state in the repo (Principle 12 — pristine-repo). The only sanctioned
  repo files are the memory files.
- Do not duplicate core logic into `cli`/`mcp`.

## Prototype footprint (temporary)

This repo is built by the Claude-Orchestrator **prototype**, which writes `.co/`, `.claude/`, and
`.codex/` into the tree — a temporary tenant that violates Principle 12, **not part of the
product**. The only tracked sentinels are `.co/.gitignore`, `.claude/.gitignore`, and
`.codex/.gitignore`; any local state under those directories is ignored per-developer runtime
residue. The whole footprint is removed in the migration commit once `co` can self-host. Don't
build on, document, or treat `.co/`, `.claude/`, or `.codex/` as product code. See
[`docs/migration.md`](docs/migration.md).
