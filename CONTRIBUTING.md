# Contributing to Code Orchestration

Thanks for your interest. `co` is built using its own discipline, so contribution mirrors how `co`
orchestrates work. Read [`docs/README.md`](docs/README.md) and
[`docs/principles.md`](docs/principles.md) first.

## Development setup

- Node ≥ 22 (see `.nvmrc`), **pnpm 10** — enable via `corepack enable` **or** `npm i -g pnpm@10`
  (corepack is optional).
- `pnpm install`, then `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and
  `pnpm format:check` — run all five before considering a change done.

## How work is structured (the model)

Issues map to `co`'s work units:

- **spec** — top-level intent, locked before work starts.
- **phase** — an independently-mergeable slice of a spec.
- **task** — an implementer-sized unit inside a phase.
- **bug** — a defect report. **research** — an open, evidence-pending decision.

The [Project board](docs/governance/project-board.md) tracks items across the lifecycle
(Backlog → Spec-locked → In phase → In review → Blocked → Done). Labels mark **role**, **type**,
**status**, and **area** ([taxonomy](docs/governance/labels.md)).

## Branch & PR flow

- Branch from `dev`; open PRs **against `dev`** (the integration line). `main` is the stable release
  branch, updated only by a gated promotion PR from same-repository `release/*` branches.
- Keep PRs focused on one task/phase. Link the issue the PR closes; fill the acceptance-criteria
  checklist in the PR template.
- A PR merges only after the review gate returns **PASS** and required checks are green. The blocker
  bar tightens toward production: nits ride as suggestions into `dev`, become blockers in
  `release/*` → `main` promotion.

## Commits

- **[Conventional Commits](https://www.conventionalcommits.org/)** (`feat:`, `fix:`, `docs:`, …).
- **Sign off every commit (DCO):** `git commit -s`. By signing off you certify the
  [Developer Certificate of Origin](https://developercertificate.org/). PRs without sign-off fail
  the DCO check.

## Code conventions

- ESM, strict TypeScript, NodeNext imports (`.js` extension on local imports).
- `packages/core` is the single source of truth; `cli`/`mcp` are thin adapters that import it — do
  not duplicate core logic.
- Use `assertNever` from `@co/core` for exhaustive union handling (no silent default branches).

## Note: the prototype footprint

The repo currently hosts a temporary `.co/`/`.claude/`/`.codex/` footprint from the prototype that
builds it. It is **not** part of the product and will be removed at migration
([docs/migration.md](docs/migration.md)). Do not build on it.
