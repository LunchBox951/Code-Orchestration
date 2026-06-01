# Core Concepts (Mental Model)

## Claude Orchestrator

| Concept | What it is |
|---|---|
| **Operator** | The human (`@operator`). Initiates tasks, can override gates, owns spec-lock approval. |
| **Orchestrator** | The routing engine (`@orchestrator`). Wakes agents, runs turns, consumes dispatch mail, auto-spawns workers and reviewers. |
| **Agent** | One AI worker with a **role**, a **provider**, a **model tier**, an isolated **worktree**, and a lifecycle state. |
| **Role** | The behavioral contract an agent plays (Coordinator, Lead, Implementer, Reviewer, …). Determined by a base prompt + permissions. |
| **Turn** | One discrete unit of agent execution. An agent runs a turn, emits mail, then yields. Turns are logged individually. |
| **Mail** | A typed, persisted message between agents on the shared bus. The only sanctioned coordination channel. |
| **Task** | The top-level unit of work, identified by a task id. Owns a tree of agents, a spec, phases, and state. |
| **Phase** | An independently-mergeable slice of a task, owned by one Lead. |
| **Spec** | The locked source-of-truth requirements document for a task. |
| **Worktree** | A git worktree giving each agent an isolated working copy on its own branch. |
| **Review** | A gated inspection of a diff that yields a verdict (`PASS` / `ISSUES` / `SOFT_PASS`). |
| **State DB** | A local SQLite database holding all agents, turns, mail, reviews, phases, specs, and events. |

### Agent lifecycle states

Agents move through states the router and operator can observe and act on:

- **WAITING** — idle, eligible to be woken when mail arrives.
- **RUNNING** — currently executing a turn.
- **DONE** — finished its work (terminal).
- **STUCK** — blocked / errored; requires recovery (`co unstick`).
- **PAUSED** — operator-suspended.

The router only wakes WAITING agents that have unread mail. Recovery verbs flip
STUCK (or zombie RUNNING) agents back to WAITING.

## Code Orchestration

The mental model the rewrite settled on. The **concepts and their relationships** are fixed here;
the one thing still open is the runtime *mechanism* (how a turn actually executes, how the Conductor
drives a live session) — that rides on the parked substrate research (EVENT-ROUTER).

| Concept | What it is |
|---|---|
| **Operator** | The human. Initiates tasks, owns spec-lock approval and gate overrides — and is a *first-class mail participant*: escalations, approvals, and decisions filter up to their inbox (Principles 1 — two-surfaces; 8 — filter-up). |
| **Conductor** | The named runtime engine — *not* an AI agent. Runs each agent's turn, routes mail, spawns workers (in response to MCP tool calls, **not** mail), reconciles stuck agents, and carries escalations up the chain. Its *role* is set; its *mechanism* is the parked substrate (Principle 16 — decisions-deferred). |
| **Agent** | One AI worker: a base **role** × **sub-role**, a **provider**, a **model tier**, an isolated **worktree**, and a lifecycle state. Acts *solely* through the MCP surface — no fallback (Principles 4 — one-agent-surface; 11 — roles-and-sub-roles). |
| **Role (base)** | The behavioral contract + permission profile. Five: **Coordinator, Lead, Implementer, Reviewer, Researcher** (AGENT-ROLES). |
| **Sub-role** | A cheap specialization of *approach* that may only ever *narrow* permissions — Implementer→`code`/`test`/`docs`/`polish`, Reviewer→`feature`/`bugfix`/`pr`, Researcher→`codebase`/`external`/`diagnostic`/`decision` (Principle 11 — roles-and-sub-roles). |
| **Turn** | One discrete unit of execution: an agent wakes on mail, does one turn, yields. Bounded loops prevent runaway work. |
| **Mail** | The typed, persisted bus — the *only* agent↔agent channel. **Actionable** mail stays unread until acted on; **informational** does not. Rendered per audience: structured for agents, a real inbox for the operator (Principle 3 — render-per-audience, MAIL-BUS). |
| **Task** | The top-level unit of work: owns an agent tree, a spec, phases, and state. |
| **Phase** | An independently-mergeable slice of a task, owned by one Lead (PHASES-and-PLANS). |
| **Spec** | The locked source-of-truth requirements document, gated by operator spec-lock (SPECS-and-ISSUES). |
| **Acceptance criteria** | The one concrete, checkable standard the spec produces, the plan structures, the implementer targets, the tests encode, and the reviewer enforces — the cohesion contract (Principle 10 — acceptance-criteria). |
| **Review** | A gated inspection of a diff yielding a verdict (**PASS / ISSUES**); strict, burden of proof on the author, with the blocker bar rising as code nears production (REVIEW-GATES). |
| **Escalation** | The filter-up valve: repeated failure (3-strike), a stuck worker, or intent ambiguity climbs the spawn chain — parent → Coordinator → operator — resolved at the lowest competent level, with parent↔child brainstorm to recover intent (Principles 7 — gated-by-default; 8 — filter-up). |
| **Worktree** | The per-agent isolated working copy + branch; gitignored essentials are copied or pointer-linked in, so non-Python repos and venvs don't break (Principle 6 — tools-do-the-work, WORKTREES). |
| **Project** | A target repo `co` operates on, identified by a **zero-footprint, path-based registry** — re-linkable on move; nothing orchestration-related lives in the repo (Principle 12 — pristine-repo). |
| **Program-data state** | The durable, per-project record where *everything is an event* — inspectable, replayable, recoverable, and local to each machine (Principle 14 — recoverable, STATE-and-RECOVERY). |
| **Provider** | Claude or Codex, interchangeable behind one routing/gating/mail abstraction; chosen per role / per dispatch (Principle 13 — provider-neutral, PROVIDERS). |
| **Buddy** | The optional gacha companion that interjects at key moments and hosts the `/btw` side-channel — pure fun, never in the critical path (BUDDY). |

### Agent lifecycle states

The prototype's observable states carry — **WAITING** (idle, eligible to wake on mail), **RUNNING**
(executing a turn), **DONE** (finished, terminal), **STUCK** (blocked/errored; needs reconciliation),
**PAUSED** (operator-suspended). The Conductor wakes WAITING agents with unread mail and reconciles
STUCK (or zombie RUNNING) agents back to WAITING. A *throttled* agent is simply WAITING, re-woken as
provider headroom refreshes (DISPATCH). The exact state set may refine once the session model lands —
e.g. how a host-dead session is distinguished from a slow turn — but the operator-facing vocabulary
above is what the system commits to.
