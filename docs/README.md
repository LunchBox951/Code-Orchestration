# Code Orchestration — design docs

Start here. These docs are the "why" behind `co`; the code is the "how".

## Reading order

1. [Vision](vision.md) — what `co` is and the two interaction surfaces.
2. [Core concepts](concepts.md) — the mental model (Conductor, Agent, Role, Mail, …).
3. [Principles](principles.md) — the 16 invariants. Cited everywhere as `Principle N — handle`;
   grep a handle to jump here.
4. [L6a acceptance criteria](l6a-acceptance-criteria.md) — local role/permission hardening
   criteria cited as `AC-L6a-*`, each laddering to the v1 criteria.
5. Architecture — one topic per file under [`architecture/`](architecture/):
   mail bus, dispatch, providers, worktrees, review gates, phases & plans, specs & issues,
   state & recovery, event router, permissions, prompts & memory, agent roles, TUI, buddy,
   cost & usage, health & diagnostics, init & config, MCP tools, CLI reference, research.
6. [Research](research/) — open, evidence-pending decisions (runtime substrate, stack).
7. [Governance](governance/) — how this repo's GitHub structure mirrors `co`'s own model.

## Status

`co` is in active development (pre-alpha). The substrate-independent design is settled; the
runtime substrate and desktop shell are parked for evidence (Principle 16). See
[migration.md](migration.md) for the temporary prototype-footprint teardown.
