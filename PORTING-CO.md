> NOTE: The canonical design corpus now lives in docs/ (start at docs/README.md). This original is
> frozen and is removed at the prototype-footprint migration — see docs/migration.md.

# Claude Orchestrator vs Code Orchestration
Consider Claude Orchestrator a prototype of Code Orchestration. This project involves rewriting the application from the ground up with a dual focus:

1. How does the user interact with the application
2. How does the agents interact with the application

Read these other markdown files in order:

1. .goals/VISION.md
2. .goals/CORE-CONCEPTS.md
3. .goals/AGENT-ROLES.md
4. .goals/MAIL-BUS.md
5. .goals/DISPATCH.md
6. .goals/PROVIDERS.md
7. .goals/WORKTREES.md
8. .goals/REVIEW-GATES.md
9. .goals/PHASES-and-PLANS.md
10. .goals/SPECS-and-ISSUES.md
11. .goals/RESEARCH.md
12. .goals/STATE-and-RECOVERY.md
13. .goals/EVENT-ROUTER.md
14. .goals/PERMISSIONS.md
15. .goals/PROMPTS-and-MEMORY.md
16. .goals/TUI.md
17. .goals/BUDDY.md
18. .goals/COST-and-USAGE.md
19. .goals/HEALTH-and-DIAGNOSTICS.md
20. .goals/INIT-and-CONFIG.md
21. .goals/MCP-TOOLS.md
22. .goals/CLI-REFERENCE.md
23. .goals/DESIGN-PRINCIPLES.md

Quick reference: **`PRINCIPLES.md`** (root) indexes all 16 design principles with stable
handles and pointers into the files above — grep a handle like `filter-up` to jump from any
inline `(Principle N — handle)` citation to its summary and source docs.

Open decisions & research (`.research/`) — everything *substrate-dependent* is parked here
(Principle 16 — decisions-deferred):

1. [`.research/runtime-substrate.md`](.research/runtime-substrate.md) — **open.** The keystone
   parked decision: how the Conductor drives a *live* authentic-terminal session (turn execution,
   spawn/transport, liveness, recovery). Every "waits on the research" reference resolves here.
2. [`.research/language-and-stack.md`](.research/language-and-stack.md) — **language decided
   (TypeScript); desktop-shell sub-question still open.** Resolves the *language* half of the
   substrate doc's open question #7; the Electron-vs-Tauri shell choice stays parked there.

Original codebase: `/home/Projects/Claude-Orchestrator`

Project Scaffolding Spec and Plan:
1. [`docs/superpowers/specs/2026-06-01-project-scaffolding-design.md`]  — **first spec** the
    first iteration of the spec of implementation. A living document for a fresh coordinator.
    This file is not considered the final spec of approach, but touches on some clear goals.
2. [`docs/superpowers/plans/2026-06-01-project-scaffolding.md`]  — **first plan** the
    first iteration of the plan of implementation. A living document for a fresh coordinator.
    This file is not considered the final plan of approach, but touches on some clear goals.