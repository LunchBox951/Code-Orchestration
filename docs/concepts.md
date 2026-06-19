# Core Concepts (Mental Model)

The mental model the rewrite settled on. The **concepts and their relationships** are fixed here.
The Conductor engine/daemon and Electron shell have landed; the remaining runtime-substrate work is
host-live provider proof, liveness, and recovery evidence ([EVENT-ROUTER](architecture/event-router.md)).

| Concept | What it is |
|---|---|
| **Operator** | The human. Initiates tasks, owns spec-lock approval and gate overrides — and is a *first-class mail participant*: escalations, approvals, and decisions filter up to their inbox (Principles 1 — two-surfaces; 8 — filter-up). |
| **Conductor** | The named runtime engine — *not* an AI agent. Runs each agent's turn, routes mail, spawns workers (in response to MCP tool calls, **not** mail), reconciles stuck agents, and carries escalations up the chain. Its sandbox engine/daemon exist; host-live proof remains the substrate work (Principle 16 — decisions-deferred). |
| **Agent** | One AI worker: a base **role** × **sub-role**, a **provider**, a **model tier**, an isolated **worktree**, and a lifecycle state. Acts *solely* through the MCP surface — no fallback (Principles 4 — one-agent-surface; 11 — roles-and-sub-roles). |
| **Role (base)** | The behavioral contract + permission profile. Five: **Coordinator, Lead, Implementer, Reviewer, Researcher** ([AGENT-ROLES](architecture/agent-roles.md)). |
| **Sub-role** | A cheap specialization of *approach* that may only ever *narrow* permissions — Implementer→`code`/`test`/`docs`/`polish`, Reviewer→`feature`/`bugfix`/`pr`, Researcher→`codebase`/`external`/`diagnostic`/`decision` (Principle 11 — roles-and-sub-roles). |
| **Turn** | One discrete unit of execution: an agent wakes on mail, does one turn, yields. Bounded loops prevent runaway work. |
| **Mail** | The typed, persisted bus — the *only* agent↔agent channel. **Actionable** mail stays outstanding/unresolved until acted on; **informational** does not. Rendered per audience: structured for agents, a real inbox for the operator (Principle 3 — render-per-audience, [MAIL-BUS](architecture/mail-bus.md)). |
| **Task** | The top-level unit of work: owns an agent tree, a spec, phases, and state. |
| **Phase** | An independently-mergeable slice of a task, owned by one Lead ([PHASES-and-PLANS](architecture/phases-and-plans.md)). |
| **Spec** | The locked source-of-truth requirements document, gated by operator spec-lock ([SPECS-and-ISSUES](architecture/specs-and-issues.md)). |
| **Acceptance criteria** | The one concrete, checkable standard the spec produces, the plan structures, the implementer targets, the tests encode, and the reviewer enforces — the cohesion contract (Principle 10 — acceptance-criteria). |
| **Review** | A gated inspection of a diff yielding a verdict (**PASS / ISSUES**); strict, burden of proof on the author, with the blocker bar rising as code nears production ([REVIEW-GATES](architecture/review-gates.md)). |
| **Escalation** | The filter-up valve: repeated failure (3-strike), a stuck worker, or intent ambiguity climbs the spawn chain — parent → Coordinator → operator — resolved at the lowest competent level, with parent↔child brainstorm to recover intent (Principles 7 — gated-by-default; 8 — filter-up). |
| **Worktree** | The per-agent isolated working copy + branch; gitignored essentials are copied or pointer-linked in, so non-Python repos and venvs don't break (Principle 6 — tools-do-the-work, [WORKTREES](architecture/worktrees.md)). |
| **Project** | A target repo `co` operates on, identified by a **zero-footprint, path-based registry** — re-linkable on move; nothing orchestration-related lives in the repo (Principle 12 — pristine-repo). |
| **Program-data state** | The durable, per-project record where *everything is an event* — inspectable, replayable, recoverable, and local to each machine (Principle 14 — recoverable, [STATE-and-RECOVERY](architecture/state-and-recovery.md)). |
| **Provider** | Claude or Codex, interchangeable behind one routing/gating/mail abstraction; chosen per role / per dispatch (Principle 13 — provider-neutral, [PROVIDERS](architecture/providers.md)). |
| **Buddy** | The optional gacha companion that interjects at key moments and hosts the `/btw` side-channel — pure fun, never in the critical path ([BUDDY](architecture/buddy.md)). |

### Agent lifecycle states

The product lifecycle vocabulary is **WAITING** (idle, eligible to wake on mail), **RUNNING**
(executing a turn), **DONE** (finished, terminal), **STUCK** (blocked/errored; needs reconciliation),
and **PAUSED** (operator-suspended). The Conductor wakes WAITING agents with outstanding work and
reconciles STUCK (or zombie RUNNING) agents back to WAITING. A *throttled* agent is simply WAITING,
re-woken as provider headroom refreshes ([DISPATCH](architecture/dispatch.md)).

The desktop may display live-session status such as `warm` or `unknown` while it observes hosted
panes; those are presentation/runtime details, not replacements for the lifecycle vocabulary.
