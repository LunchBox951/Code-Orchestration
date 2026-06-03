## What & why

<!-- One paragraph. Link the issue this closes. -->
Closes #

## Acceptance criteria (Principle 10)

<!-- Copy the spec/phase acceptance criteria; check each as met. -->
- [ ] …

## Review

- [ ] Tests added/updated and `pnpm test` passes
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm format:check` green
- [ ] Commits are Conventional and **signed off** (`git commit -s`, DCO)
- [ ] No core logic duplicated into an adapter; no orchestration state added to the repo

> Reviewer verdict is **PASS** or **ISSUES**. The blocker bar tightens toward `main`.
> If this PR touches the prototype-footprint teardown, see `docs/migration.md`.
