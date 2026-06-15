# Labels

Labels are the cross-cutting taxonomy the [project board](project-board.md) and `CODEOWNERS` lean
on. They mirror `co`'s own model: a work item carries a **type** (what kind of unit), a **role**
(who owns it), a **status** (where it sits in the lifecycle), and an **area** (which part of the
tree it touches).

The single source of truth is [`.github/labels.yml`](../../.github/labels.yml). It is applied to
GitHub by the **Label sync** workflow (`.github/workflows/label-sync.yml`, wired in Phase 5) using
the [EndBug/label-sync](https://github.com/EndBug/label-sync) mapping format — each entry is a
`name` / `color` / `description` triple. Edit the YAML, not the labels in the GitHub UI; the UI is
overwritten on the next sync.

## Families

### `type:` — what kind of work unit (mirrors the issue templates)

| Label | Meaning |
|---|---|
| `type:spec` | Top-level intent / locked spec |
| `type:phase` | Independently-mergeable slice of a spec |
| `type:task` | Implementer-sized unit inside a phase |
| `type:bug` | Something is broken |
| `type:research` | Open, evidence-pending decision (Principle 16) |

### `role:` — which `co` agent role owns the item

`role:coordinator`, `role:lead`, `role:implementer`, `role:reviewer`, `role:researcher`. These map
1:1 to the agent roles described in [roles.md](roles.md).

### `status:` — where the item sits in the lifecycle

`status:spec-locked`, `status:in-phase`, `status:in-review`, `status:blocked`, `status:done`. These
track the [board](project-board.md) columns (the board's `Backlog` is the no-status default).

### `area:` — which part of the tree it touches

`area:core`, `area:cli`, `area:mcp` (the packages), `area:desktop` (`apps/desktop`), `area:docs`
(`docs/`), and `area:meta` (repo tooling / governance). These align with the `CODEOWNERS` paths.

### meta

`good first issue` and `help wanted` are the conventional contributor-onboarding labels;
`migration` tracks the temporary prototype-footprint teardown (see
[`docs/migration.md`](../migration.md)); `security:critical` is reserved for critical security
promotions and skips only the stable-release soak gate.

## Conventions

- A spec/phase/task issue normally carries one `type:`, one `role:`, one `status:`, and zero or more
  `area:` labels.
- Status is advanced as the item moves through the review gate; it is not a substitute for the board
  column, but the two are kept consistent.
- Release channel (`nightly`/`stable`) is intentionally **not** a label family here; channel state
  is driven by the [release policy](release-policy.md) and GitHub Releases.
