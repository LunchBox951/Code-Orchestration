# Governance

## Model

`co` is currently **BDFL-led** (LunchBox951) while the project is young. Decisions are made in
the open via Issues and Discussions; the maintainer has final say and is responsible for keeping the
project coherent with its [principles](docs/principles.md).

## How decisions are weighed

Every proposal is judged against the **16 design principles**. A change that violates an invariant
(e.g. a path to `main` that skips the review gate, or orchestration state leaking into a target repo)
needs an explicit, recorded rationale and a principle amendment — not a silent exception.

## Roles

This repo's human roles deliberately mirror `co`'s agent roles — **Coordinator, Lead, Implementer,
Reviewer, Researcher** — so that working on `co` is itself an instance of `co`'s model (see
[`docs/governance/roles.md`](docs/governance/roles.md)). As the project grows, trusted contributors
may be granted Lead/Reviewer responsibilities over areas (reflected in `CODEOWNERS`).

## Becoming a maintainer

Sustained, high-quality contribution (code and review) is the path. The maintainer will invite
contributors who have demonstrated good judgment against the principles. The roster and the move
beyond BDFL (to a maintainer council) will be revisited as activity warrants.
