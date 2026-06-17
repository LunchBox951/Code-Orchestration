# Roles

This repo's human roles deliberately mirror `co`'s **agent** roles, so that contributing to `co` is
itself an instance of `co`'s model. The authoritative description of each agent role lives in
[`docs/architecture/agent-roles.md`](../architecture/agent-roles.md); this doc maps those roles onto
GitHub mechanics — labels, the board, the review gate, and `CODEOWNERS`.

## The roles

| Role | What it does on `co` | GitHub expression |
|---|---|---|
| **Coordinator** | Owns a spec end-to-end: shapes intent into a locked spec, decomposes it into phases, dispatches Leads, integrates. | Opens/owns `type:spec` issues (`role:coordinator`); drives the board from `Backlog` to `Done`. |
| **Lead** | Owns one phase: decomposes it into tasks, dispatches Implementers, integrates reviewed work, reports the phase ready. | Owns `type:phase` issues (`role:lead`); merges task PRs into the phase line after review. |
| **Implementer** | Owns one task: writes the change and its tests on a task branch. | Owns `type:task` issues (`role:implementer`); opens the task PR. |
| **Reviewer** | The review gate: returns **PASS** or **ISSUES** on a diff before it can merge, push, or publish. | Reviews PRs; approval is required by branch protection (`role:reviewer`). |
| **Researcher** | Investigates an open, evidence-pending decision and produces a read-only finding. | Owns `type:research` issues (`role:researcher`); resolves Principle 16 deferrals. |

## How the roles meet the GitHub structure

- **Labels** — every issue carries a `role:` label naming the responsible role; see
  [labels.md](labels.md).
- **Board** — the [project board](project-board.md) lifecycle (`Backlog → Spec-locked → In phase →
  In review → Blocked → Done`) is the same lifecycle agents move issues through.
- **Review gate** — branch protection requires a Reviewer approval and green checks before merge;
  the blocker bar tightens toward `main`. No path to `main` skips the gate.
- **Ownership** — [`.github/CODEOWNERS`](../../.github/CODEOWNERS) records who owns each area of the
  tree. While the project is BDFL-led (see [`GOVERNANCE.md`](../../GOVERNANCE.md)) the operator owns
  everything; as trusted contributors earn Lead/Reviewer responsibilities over an area, they are
  added to `CODEOWNERS` for that path, which mirrors the `area:` label family.

## Humans vs agents

The same role can be filled by a person or by a `co` agent — the discipline is identical either way.
A human Reviewer and an agent Reviewer both return the same PASS/ISSUES verdict against the same
gate; a human Lead and an agent Lead both decompose a phase and integrate reviewed tasks. That
symmetry is the point: the repo is governed the way `co` orchestrates.
