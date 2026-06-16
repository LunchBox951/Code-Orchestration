# Code Orchestration — design docs

Start here. These docs are the "why" behind `co`; the code is the "how".

## Reading order

1. [Vision](vision.md) — what `co` is and the two interaction surfaces.
2. [Core concepts](concepts.md) — the mental model (Conductor, Agent, Role, Mail, …).
3. [Principles](principles.md) — the 16 invariants. Preferred citations use
   `Principle N — handle`; grep a handle to jump here.
4. [v1 acceptance criteria](v1-acceptance-criteria.md) — the global self-hosting bar; local
   criteria ladder up to IDs here.
5. [L6a acceptance criteria](l6a-acceptance-criteria.md) — local role/permission hardening
   criteria cited as `AC-L6a-*`, each laddering to the v1 criteria.
6. [L6b acceptance criteria](l6b-acceptance-criteria.md) — local specs/plans/issues/research
   criteria cited as `AC-L6b-*`, each laddering to the v1 criteria.
7. [L7 acceptance criteria](l7-acceptance-criteria.md) — local Conductor foundation criteria cited
   as `AC-L7-*`, split into sandbox and host-live proof.
8. Architecture — one topic per file under [`architecture/`](architecture/):
   mail bus, dispatch, providers, worktrees, review gates, phases & plans, specs & issues,
   state & recovery, event router, permissions, prompts & memory, agent roles, TUI, buddy,
   cost & usage, health & diagnostics, init & config, MCP tools, CLI reference, research.
9. [Research](research/) — decision records and remaining evidence-pending runtime questions.
10. [Governance](governance/) — how this repo's GitHub structure mirrors `co`'s own model.

## Status

`co` is in active development (pre-alpha). The substrate-independent design is settled; Electron is
the desktop shell, and the remaining runtime-substrate work is host-live provider proof, liveness,
and recovery evidence (Principle 16). See [migration.md](migration.md) for the temporary
prototype-footprint teardown.
