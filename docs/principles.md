# Code Orchestration — Design Principles (index & tracker)

The canonical, at-a-glance index of the **16 design principles** that govern Code
Orchestration. These are the invariants that emerged across the brainstorm and held topic
by topic — preserve them regardless of implementation choices.

**How to use this file**
- Each principle has a stable **handle** (e.g. `filter-up`). Inline citations across the
  `docs/` corpus use it — `(Principle 8 — filter-up)` — so you can **grep the handle** and
  land here, then follow the **Detailed in** links to the topics that elaborate it.
- This file is the *quick tracker + cross-reference map*. The **authoritative prose** for
  each principle lives in the [Authoritative prose](#authoritative-prose) section below;
  start there for the full statement, here for the lookup.
- Numbers are a breadcrumb; the **handle is the durable key** — if the list is ever
  reordered, cite and search by handle, not number.

> Scope: these are the **Code Orchestration** (rewrite) principles — the invariants that
> emerged across the rewrite and held topic by topic.

| # | Handle | Principle (one line) | Detailed in |
|---|---|---|---|
| 1 | `two-surfaces` | Two asymmetric channels: agent↔operator is a **live, interruptible terminal**; agent↔agent is **typed, persisted mail**. The operator is also first-class on mail. | [VISION](vision.md) · [MAIL-BUS](architecture/mail-bus.md) · [TUI](architecture/tui.md) |
| 2 | `authentic-terminal` | `co` hosts the **real** `claude`/`codex` in a pty, its flow layered on top — never headless `-p`/`exec`, never tmux. | [VISION](vision.md) · [TUI](architecture/tui.md) · [PROVIDERS](architecture/providers.md) |
| 3 | `render-per-audience` | One thing, two renderings: structured/JSON under the hood for machines, a clean human view on top. Readability is the **app's** job — keeps provider voice out of artifacts. | [MAIL-BUS](architecture/mail-bus.md) · [TUI](architecture/tui.md) · [WORKTREES](architecture/worktrees.md) · [PROVIDERS](architecture/providers.md) |
| 4 | `one-agent-surface` | Agents act through the **MCP server alone, no fallback**; the protocol is self-describing; a stubbed tool fails loudly (completeness gate). One core, thin adapters. | [MCP-TOOLS](architecture/mcp-tools.md) · [CLI-REFERENCE](architecture/cli-reference.md) · [PERMISSIONS](architecture/permissions.md) |
| 5 | `self-describing` | Agents operate **any** repo without reading `co`'s source: `orient` teaches workflow, schemas teach syntax, native project memory teaches the repo, the locator maps unfamiliar code. | [PROMPTS-and-MEMORY](architecture/prompts-and-memory.md) · [RESEARCH](architecture/research.md) · [MCP-TOOLS](architecture/mcp-tools.md) |
| 6 | `tools-do-the-work` | Ergonomic tools make the sanctioned path the easy path; the only hard blocks are the non-destructive boundary; protocol adherence is **reactive nudges** — trust, monitor, gently remind. | [PERMISSIONS](architecture/permissions.md) · [WORKTREES](architecture/worktrees.md) · [MCP-TOOLS](architecture/mcp-tools.md) |
| 7 | `gated-by-default` | Nothing reaches master/remote/PR without a **PASS** (agent *or* human) or an explicit audited `@operator` override. Two verdicts; the blocker bar **tightens toward production**. Ruthless only *because* escalation gives an exit. | [REVIEW-GATES](architecture/review-gates.md) · [AGENT-ROLES](architecture/agent-roles.md) · [WORKTREES](architecture/worktrees.md) |
| 8 | `filter-up` | Problems climb the spawn chain, resolved at the **lowest competent level**; only genuine intent + outward actions reach the operator. Actionable items are un-loseable. | [MAIL-BUS](architecture/mail-bus.md) · [AGENT-ROLES](architecture/agent-roles.md) · [REVIEW-GATES](architecture/review-gates.md) · [SPECS-and-ISSUES](architecture/specs-and-issues.md) |
| 9 | `no-silent-failures` | Every failure is detected and surfaced — **pre-flight** (the doctor), **in-flight** (live monitoring), **post-hoc** (observability). Never-drop, fail-loud, degrade safely under pressure. | [HEALTH-and-DIAGNOSTICS](architecture/health-and-diagnostics.md) · [PERMISSIONS](architecture/permissions.md) · [STATE-and-RECOVERY](architecture/state-and-recovery.md) · [MAIL-BUS](architecture/mail-bus.md) |
| 10 | `acceptance-criteria` | One concrete, checkable standard the spec **produces**, the plan **structures**, the implementer **targets**, the tests **encode**, the reviewer **enforces** — the cure for "everyone interpreted *done* differently." | [PHASES-and-PLANS](architecture/phases-and-plans.md) · [SPECS-and-ISSUES](architecture/specs-and-issues.md) · [REVIEW-GATES](architecture/review-gates.md) |
| 11 | `roles-and-sub-roles` | Few **base roles** (distinct mandate + permission profile); cheap **sub-roles** specialize *approach* and may only *narrow* permissions. Project specifics enter via native memory. | [AGENT-ROLES](architecture/agent-roles.md) · [PERMISSIONS](architecture/permissions.md) · [RESEARCH](architecture/research.md) |
| 12 | `pristine-repo` | Nothing orchestration-related touches the target repo (only `CLAUDE.md`/`AGENTS.md`); all state, specs, plans, and config live in **program-data**, keyed per project. | [WORKTREES](architecture/worktrees.md) · [STATE-and-RECOVERY](architecture/state-and-recovery.md) · [INIT-and-CONFIG](architecture/init-and-config.md) · [SPECS-and-ISSUES](architecture/specs-and-issues.md) |
| 13 | `provider-neutral` | Claude and Codex are interchangeable behind one routing/gating/mail abstraction. Pinned roles + a rate-limit-aware balancer spread load; when tapped, **pace — don't sacrifice**. | [PROVIDERS](architecture/providers.md) · [DISPATCH](architecture/dispatch.md) · [COST-and-USAGE](architecture/cost-and-usage.md) |
| 14 | `recoverable` | Everything is an **event** — durable, inspectable, replayable; the system can always be reconstructed and recovered from its own record. | [STATE-and-RECOVERY](architecture/state-and-recovery.md) · [CORE-CONCEPTS](concepts.md) · [HEALTH-and-DIAGNOSTICS](architecture/health-and-diagnostics.md) |
| 15 | `one-stop-shop` | The desktop app absorbs the alt-tab: **observe and steer agents first**, light manual coding second. Deliberately *not* a new IDE — just enough to never leave the flow. | [TUI](architecture/tui.md) · [MAIL-BUS](architecture/mail-bus.md) · [REVIEW-GATES](architecture/review-gates.md) |
| 16 | `decisions-deferred` | The runtime substrate is **parked for research, not guessed** — anchored on the authentic-terminal directive, validated at spec-execution time. Measure before committing. | [Authoritative prose](#authoritative-prose) · [EVENT-ROUTER](architecture/event-router.md) · [runtime-substrate](research/runtime-substrate.md) *(research open)* |

---

*Authoritative prose: the [Authoritative prose](#authoritative-prose) section below. Reading
order and project framing: [`README.md`](README.md).*

## Authoritative prose

The invariants that emerged across the rewrite. They weren't imposed up front — they surfaced
topic by topic and *held*, which is the strongest sign they're real. Preserve them regardless of
implementation.

1. **Two asymmetric interaction surfaces** (Principle 1 — two-surfaces). Agent↔operator is *live and
   interruptible* (the real interactive terminal); agent↔agent is *typed, persisted mail*. Different
   mediums for different relationships. The operator is also a first-class mail participant —
   escalations, approvals, and decisions *filter up* to their inbox.

2. **The virtual terminal is the authentic experience, not a reconstruction**
   (Principle 2 — authentic-terminal). `co` hosts the *real* interactive `claude`/`codex` in a
   terminal emulator; the operator gets the genuine tool, with `co`'s flow layered on top. Never a
   headless (`claude -p` / `codex exec`) reconstruction; never tmux.

3. **One thing, rendered per audience** (Principle 3 — render-per-audience). Structured/JSON under the
   hood for machines (mail, commit messages); a clean human view on top. Readability is the *app's*
   job, not the agent's — which keeps provider voice (Claude-verbose, Codex-terse) out of the
   artifacts.

4. **One agent surface, no fallback** (Principle 4 — one-agent-surface). Agents act through the MCP
   server alone; the protocol is self-describing; a stubbed tool fails loudly (completeness gate).
   One core, thin adapters — so surfaces can't drift in logic.

5. **Self-describing — works on any repo** (Principle 5 — self-describing). Agents operate any
   codebase without reading `co`'s source: `orient` teaches workflow, schemas teach syntax, the
   native project-memory file teaches the repo, and the codebase *locator* maps unfamiliar code on
   demand. "Only worked on `co`" is the anti-pattern this kills.

6. **Tools do the heavy lifting; block only the destructive; nudge the rest**
   (Principle 6 — tools-do-the-work). Ergonomic tools make the sanctioned path the easy path; the
   only hard blocks are the non-destructive boundary; protocol adherence is *reactive nudges* —
   trust, monitor silently, gently remind.

7. **Gated by default; strict, made safe by escalation** (Principle 7 — gated-by-default). Nothing
   reaches master/remote/PR without a PASS — agent *or* human (human review is a per-repo, per-scope
   option) — except an explicit, audited `@operator` override with a recorded reason. Two verdicts
   only (PASS / ISSUES); the **blocker bar tightens as code nears production** — nits ride as
   suggestions into isolated branches but become blockers at the PR/master gate. The gate can be
   ruthless only *because* escalation gives a stuck-but-honest worker an exit.

8. **Filter up — the operator owns only the big decisions** (Principle 8 — filter-up). Problems and
   questions climb the spawn chain, resolved at the lowest competent level; only genuine intent and
   outward actions reach the operator. Actionable items are un-loseable (sticky until acted on).

9. **No silent failures** (Principle 9 — no-silent-failures). Every failure is detected and surfaced —
   pre-flight (the doctor), in-flight (live monitoring of agent streams), post-hoc (observability).
   Never-drop, fail-loud, and under pressure *degrade safely* rather than die.

10. **Acceptance criteria are the cohesion contract** (Principle 10 — acceptance-criteria). One
    concrete, checkable standard the spec produces, the plan structures, the implementer targets, the
    tests encode, and the reviewer enforces — the cure for "everyone interpreted *done* differently."

11. **Roles universal, projects local; base roles × sub-roles** (Principle 11 — roles-and-sub-roles).
    Few base roles (distinct mandate + permission profile); cheap sub-roles specialize *approach* and
    may only *narrow* permissions. Project specifics enter exclusively through the project's native
    memory file (`CLAUDE.md`/`AGENTS.md`), which `co` never bakes, mirrors, or syncs.

12. **Pristine repo; data in program-data** (Principle 12 — pristine-repo). Nothing
    orchestration-related touches the target repo (only `CLAUDE.md`/`AGENTS.md`); all state, specs,
    plans, and config live in the app's program-data, keyed per project.

13. **Provider-neutral core; rate-limits first-class** (Principle 13 — provider-neutral). Claude and
    Codex are interchangeable behind one routing/gating/mail abstraction. Pinned roles + a
    rate-limit-aware balancer spread load across subscriptions; when both are tapped, **pace — don't
    sacrifice** quality or flow.

14. **Recoverable and auditable** (Principle 14 — recoverable). Everything is an event — durable,
    inspectable, replayable; the system can always be reconstructed and recovered from its record.

15. **One-stop-shop — agent-first, manual-second** (Principle 15 — one-stop-shop). The desktop app
    absorbs the alt-tab: observe and steer the agents first, light manual coding second. Deliberately
    *not* a new IDE — just enough that the operator never has to leave the flow.

16. **Decisions deferred to evidence** (Principle 16 — decisions-deferred). The runtime substrate is
    *parked for research, not guessed* — anchored on the authentic-interactive-terminal directive
    (principle 2) and validated at spec-execution time. Measure before committing.
