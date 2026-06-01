# Project board

The GitHub Project (v2) for this repo has a single-select **Status** field whose options are `co`'s
lifecycle. Issues (spec/phase/task) move across it exactly as agents move through states:

`Backlog → Spec-locked → In phase → In review → Blocked → Done`

- **Backlog** — filed, not yet locked.
- **Spec-locked** — intent agreed; ready to decompose into phases/tasks.
- **In phase** — actively implemented.
- **In review** — at the review gate (PASS/ISSUES).
- **Blocked** — escalated; needs a decision (filter-up).
- **Done** — merged.

Release channel (`nightly`/`stable`) is a **label**, not a column. The board is configured in
GitHub (Phase 6); this doc is the source of truth for its shape.
