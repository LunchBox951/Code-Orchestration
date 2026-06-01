> NOTE: The canonical design corpus now lives in docs/ (this file is migrated to docs/principles.md;
> start at docs/README.md). This original is frozen and is removed at the prototype-footprint
> migration — see docs/migration.md.

# Code Orchestration — Design Principles (index & tracker)

The canonical, at-a-glance index of the **16 design principles** that govern Code
Orchestration. These are the invariants that emerged across the brainstorm and held topic
by topic — preserve them regardless of implementation choices.

**How to use this file**
- Each principle has a stable **handle** (e.g. `filter-up`). Inline citations across the
  `.goals/` docs use it — `(Principle 8 — filter-up)` — so you can **grep the handle** and
  land here, then follow the **Detailed in** links to the topics that elaborate it.
- This file is the *quick tracker + cross-reference map*. The **authoritative prose** for
  each principle lives in [`.goals/DESIGN-PRINCIPLES.md`](.goals/DESIGN-PRINCIPLES.md)
  (`## Code Orchestration`); start there for the full statement, here for the lookup.
- Numbers are a breadcrumb; the **handle is the durable key** — if the list is ever
  reordered, cite and search by handle, not number.

> Scope: these are the **Code Orchestration** (rewrite) principles. The prototype's older
> 10-principle list is preserved only as history in `DESIGN-PRINCIPLES.md`.

| # | Handle | Principle (one line) | Detailed in |
|---|---|---|---|
| 1 | `two-surfaces` | Two asymmetric channels: agent↔operator is a **live, interruptible terminal**; agent↔agent is **typed, persisted mail**. The operator is also first-class on mail. | [VISION](.goals/VISION.md) · [MAIL-BUS](.goals/MAIL-BUS.md) · [TUI](.goals/TUI.md) |
| 2 | `authentic-terminal` | `co` hosts the **real** `claude`/`codex` in a pty, its flow layered on top — never headless `-p`/`exec`, never tmux. | [VISION](.goals/VISION.md) · [TUI](.goals/TUI.md) · [PROVIDERS](.goals/PROVIDERS.md) |
| 3 | `render-per-audience` | One thing, two renderings: structured/JSON under the hood for machines, a clean human view on top. Readability is the **app's** job — keeps provider voice out of artifacts. | [MAIL-BUS](.goals/MAIL-BUS.md) · [TUI](.goals/TUI.md) · [WORKTREES](.goals/WORKTREES.md) · [PROVIDERS](.goals/PROVIDERS.md) |
| 4 | `one-agent-surface` | Agents act through the **MCP server alone, no fallback**; the protocol is self-describing; a stubbed tool fails loudly (completeness gate). One core, thin adapters. | [MCP-TOOLS](.goals/MCP-TOOLS.md) · [CLI-REFERENCE](.goals/CLI-REFERENCE.md) · [PERMISSIONS](.goals/PERMISSIONS.md) |
| 5 | `self-describing` | Agents operate **any** repo without reading `co`'s source: `orient` teaches workflow, schemas teach syntax, native project memory teaches the repo, the locator maps unfamiliar code. | [PROMPTS-and-MEMORY](.goals/PROMPTS-and-MEMORY.md) · [RESEARCH](.goals/RESEARCH.md) · [MCP-TOOLS](.goals/MCP-TOOLS.md) |
| 6 | `tools-do-the-work` | Ergonomic tools make the sanctioned path the easy path; the only hard blocks are the non-destructive boundary; protocol adherence is **reactive nudges** — trust, monitor, gently remind. | [PERMISSIONS](.goals/PERMISSIONS.md) · [WORKTREES](.goals/WORKTREES.md) · [MCP-TOOLS](.goals/MCP-TOOLS.md) |
| 7 | `gated-by-default` | Nothing reaches master/remote/PR without a **PASS** (agent *or* human). Two verdicts; the blocker bar **tightens toward production**. Ruthless only *because* escalation gives an exit. | [REVIEW-GATES](.goals/REVIEW-GATES.md) · [AGENT-ROLES](.goals/AGENT-ROLES.md) · [WORKTREES](.goals/WORKTREES.md) |
| 8 | `filter-up` | Problems climb the spawn chain, resolved at the **lowest competent level**; only genuine intent + outward actions reach the operator. Actionable items are un-loseable. | [MAIL-BUS](.goals/MAIL-BUS.md) · [AGENT-ROLES](.goals/AGENT-ROLES.md) · [REVIEW-GATES](.goals/REVIEW-GATES.md) · [SPECS-and-ISSUES](.goals/SPECS-and-ISSUES.md) |
| 9 | `no-silent-failures` | Every failure is detected and surfaced — **pre-flight** (the doctor), **in-flight** (live monitoring), **post-hoc** (observability). Never-drop, fail-loud, degrade safely under pressure. | [HEALTH-and-DIAGNOSTICS](.goals/HEALTH-and-DIAGNOSTICS.md) · [PERMISSIONS](.goals/PERMISSIONS.md) · [STATE-and-RECOVERY](.goals/STATE-and-RECOVERY.md) · [MAIL-BUS](.goals/MAIL-BUS.md) |
| 10 | `acceptance-criteria` | One concrete, checkable standard the spec **produces**, the plan **structures**, the implementer **targets**, the tests **encode**, the reviewer **enforces** — the cure for "everyone interpreted *done* differently." | [PHASES-and-PLANS](.goals/PHASES-and-PLANS.md) · [SPECS-and-ISSUES](.goals/SPECS-and-ISSUES.md) · [REVIEW-GATES](.goals/REVIEW-GATES.md) |
| 11 | `roles-and-sub-roles` | Few **base roles** (distinct mandate + permission profile); cheap **sub-roles** specialize *approach* and may only *narrow* permissions. Project specifics enter via native memory. | [AGENT-ROLES](.goals/AGENT-ROLES.md) · [PERMISSIONS](.goals/PERMISSIONS.md) · [RESEARCH](.goals/RESEARCH.md) |
| 12 | `pristine-repo` | Nothing orchestration-related touches the target repo (only `CLAUDE.md`/`AGENTS.md`); all state, specs, plans, and config live in **program-data**, keyed per project. | [WORKTREES](.goals/WORKTREES.md) · [STATE-and-RECOVERY](.goals/STATE-and-RECOVERY.md) · [INIT-and-CONFIG](.goals/INIT-and-CONFIG.md) · [SPECS-and-ISSUES](.goals/SPECS-and-ISSUES.md) |
| 13 | `provider-neutral` | Claude and Codex are interchangeable behind one routing/gating/mail abstraction. Pinned roles + a rate-limit-aware balancer spread load; when tapped, **pace — don't sacrifice**. | [PROVIDERS](.goals/PROVIDERS.md) · [DISPATCH](.goals/DISPATCH.md) · [COST-and-USAGE](.goals/COST-and-USAGE.md) |
| 14 | `recoverable` | Everything is an **event** — durable, inspectable, replayable; the system can always be reconstructed and recovered from its own record. | [STATE-and-RECOVERY](.goals/STATE-and-RECOVERY.md) · [CORE-CONCEPTS](.goals/CORE-CONCEPTS.md) · [HEALTH-and-DIAGNOSTICS](.goals/HEALTH-and-DIAGNOSTICS.md) |
| 15 | `one-stop-shop` | The desktop app absorbs the alt-tab: **observe and steer agents first**, light manual coding second. Deliberately *not* a new IDE — just enough to never leave the flow. | [TUI](.goals/TUI.md) · [MAIL-BUS](.goals/MAIL-BUS.md) · [REVIEW-GATES](.goals/REVIEW-GATES.md) |
| 16 | `decisions-deferred` | The runtime substrate is **parked for research, not guessed** — anchored on the authentic-terminal directive, validated at spec-execution time. Measure before committing. | [DESIGN-PRINCIPLES](.goals/DESIGN-PRINCIPLES.md) · [EVENT-ROUTER](.goals/EVENT-ROUTER.md) · `.research/runtime-substrate.md` *(pending)* |

---

*Authoritative prose: [`.goals/DESIGN-PRINCIPLES.md`](.goals/DESIGN-PRINCIPLES.md). Reading
order and project framing: [`PORTING-CO.md`](PORTING-CO.md).*
