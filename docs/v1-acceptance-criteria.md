# Code Orchestration — v1 Acceptance Criteria

> **Living document.** Iterated throughout development; persists until v1, then archived. This is
> the **global, project-scope** acceptance contract — Principle 10 (`acceptance-criteria`) raised
> from a single task to the whole product. Every spec's own acceptance criteria must **ladder up**
> to one or more criteria here.

**Every Coordinator reads this.** It is referenced from `CLAUDE.md`/`AGENTS.md`, which every CO
agent loads at the start of its turn — so all sequential Coordinators share one definition of "v1
done" no matter how many tasks or sessions span the build.

## The v1 bar

**v1 = `co` self-hosts; the prototype is retired.** Concretely: `co` can orchestrate its own
development end-to-end on a real repository — spec → phases → isolated worktrees → review gate →
gated merge — with **no involvement from the Claude-Orchestrator prototype**, and the prototype's
`.co/`/`.claude/`/`.codex/` footprint has been removed per [`migration.md`](migration.md).

The motivating sentence: **"`co` built the next `co`."**

## How to use this doc

- **Coordinators:** before locking any spec, confirm its acceptance criteria trace to criteria
  below. If a spec advances a global criterion, cite its ID (e.g. `SH-2`) in the spec.
- **Status markers:** `☐` open · `◐` in progress · `☑` met (link the PR/evidence) · `⏸` parked on
  research (blocked by a deferred decision) · `⊘` explicitly post-v1 (non-goal).
- **It is amended, not frozen.** As understanding deepens, refine, split, or add criteria — but a
  *removal* needs a recorded reason (this is the global contract; don't lower the bar silently).
- **Parked ≠ optional.** `⏸` items sit on the v1 critical path; they're blocked on research, not
  excused from it.

---

## A. Self-hosting exit criteria (the spine)

These are the top-level conditions that, all met, *are* v1.

- `SH-1` ☐ `co` runs a real multi-phase change on the **`co` repo itself** start to finish
  (spec-lock → phases → worktrees → review gate → gated merge) with zero prototype involvement.
- `SH-2` ☐ `co` reads all of its own state/specs/plans from its **own program-data** — no `.co/`
  dependency remains (Principle 12 — `pristine-repo`; Principle 14 — `recoverable`).
- `SH-3` ☐ The prototype footprint (`.co/`, `.claude/`, `.codex/`) is removed and the migration PR
  has landed on `main` ([`migration.md`](migration.md)).
- `SH-4` ☐ `co` successfully operates on **at least one stranger repo**, including a **local-only
  (Offline-mode)** repo with no remote — proving Principle 5 (`self-describing`) and that GitHub is
  never a hard dependency.
- `SH-5` ☐ Every hard gate holds under self-hosting: no raw `git push` / `gh pr merge` path exists;
  only gated `co merge` / `co push` / `co pr-merge` reach `master`/remote/PR (Principle 7 —
  `gated-by-default`).

## B. The two surfaces (P1, P2, P3, P15)

- `SF-1` ⏸ `co` hosts the **authentic interactive `claude`/`codex`** in a real terminal emulator
  (pty), not a headless reconstruction, not tmux (Principle 2). *Parked on the runtime-substrate
  research — on the v1 critical path.*
- `SF-2` ☐ The operator can **steer any agent mid-turn** from its terminal pane (answer, redirect,
  interrupt) without tearing it down (Principle 1).
- `SF-3` ◐ Agents coordinate **only** via the typed, persisted **mail bus**; the operator is a
  first-class participant and escalations/approvals **filter up** to their inbox (Principles 1, 8). L1 delivers the typed, schema-validated, persisted mail bus over the L0 event log, with `@operator` first-class. Remaining: 'ONLY via mail' (no other channel) is enforced once the MCP surface (L2) + Conductor (L7) wire it.
- `SF-4` ◐ Actionable mail is **un-loseable** (sticky until acted on); informational mail is not
  (Principle 8, `MAIL-BUS`). L1 delivers actionable-vs-informational with sticky-until-resolved as a tested REPLAY invariant + an outstanding-action-count projection. Remaining: the operator-facing inbox UX is the app (L9).
- `SF-5` ⏸ A **desktop app** is the operator's one-stop surface — observe and steer all agents in
  one place (Principle 15). *Couples to the parked shell decision (Electron vs Tauri).*
- `SF-6` ◐ Artifacts (mail, commit messages) are **rendered per audience** — structured under the
  hood, clean human view on top; provider voice stays out of artifacts (Principle 3). L1 ships the
  renderer-registry seam + a generic default renderer; L3 ships provider-deterministic commit /
  merge / PR message renderers and `co_finish` consumes the commit renderer. Remaining: per-type
  human mail renderers are the app (L9), and merge/PR renderers get their gated consumers in L5.

## C. Roles, dispatch & escalation (P8, P11, P13)

- `RL-1` ☐ The five base roles work — **Coordinator, Lead, Implementer, Reviewer, Researcher** —
  each with a distinct mandate + permission profile (Principle 11, `AGENT-ROLES`).
- `RL-2` ☐ Sub-roles specialize approach and may only **narrow** permissions (Principle 11).
- `RL-3` ◐ Escalation works: repeated failure / stuck worker / intent ambiguity climbs the spawn
  chain (parent → Coordinator → operator), resolved at the lowest competent level (Principle 8). L1 delivers the escalation protocol — resolve-or-forward (never-drop; send throws on failed persist), ask-on-intent-ambiguity, parent<->child threaded brainstorm, the upward chain, and clarify-timeout=forward-up policy. Remaining: the 3-strike trigger (L5) + roster/authority (L6).
- `RL-4` ☐ A **rate-limit-aware balancer** spreads load across subscriptions; when tapped, it
  **paces** rather than degrading quality (Principle 13, `DISPATCH`, `COST-and-USAGE`).

## D. Review gate & integration (P6, P7, P10)

- `RG-1` ☐ Nothing reaches `master`/remote/PR without a **PASS** (agent or human); two verdicts only
  (PASS / ISSUES) (Principle 7).
- `RG-2` ☐ The blocker bar **tightens toward production** — nits ride as suggestions into `dev`,
  become blockers at the `main`/PR gate (Principle 7).
- `RG-3` ☐ Operator override exists, is **audited, and records its reason** (Principle 7).
- `RG-4` ☐ Acceptance criteria are the **cohesion contract**: the spec produces them, the plan
  structures them, the implementer targets them, tests encode them, the reviewer enforces them
  (Principle 10) — and they trace to this document.
- `RG-5` ☐ Only the **destructive boundary** is hard-blocked; protocol adherence is reactive nudges
  (Principle 6, `PERMISSIONS`).

## E. Worktrees & pristine repo (P6, P12)

- `WT-1` ◐ Every worker gets an **isolated worktree/branch**; parallel work never collides; merges
  are explicit and locked (Principle 6, `WORKTREES`). L3 ships `co_sling`: branch/base capture,
  injective program-data sandbox paths, and recorded worktree+baseline facts. Remaining: worker
  spawn into those sandboxes (L7) and locked/gated integration (L5).
- `WT-2` ◐ Gitignored essentials are copied/pointer-linked into worktrees so non-trivial repos and
  environments don't break (Principle 6). L3 ships the provisioning manifest with symlink / copy /
  isolated-copy mechanisms, config overrides, and runnable fixture coverage. Remaining: richer
  project-specific install/offline workflows where a workspace needs more than the manifest.
- `WT-3` ◐ **Nothing orchestration-related touches the target repo** except `CLAUDE.md`/`AGENTS.md`;
  all state/specs/plans/config live in program-data, keyed per project (Principle 12). L0 landed the per-project program-data store + the pristine-repo guard (`assertRepoPristine`, run on every L0 op); L1 mail is program-data-keyed with no repo writes. Remaining: full no-`.co/`-dependency self-host = SH-2/SH-3.
- `WT-4` ◐ Repository-relationship modes work — **Owner / Contributor / Offline** — auto-detected
  with override; the review gate applies in all three (`WORKTREES`). L3 ships read-only
  auto-detection, `repo.mode` override, Offline push/PR-disabled capabilities, and minimal host
  convention probes. Remaining: the L5 gated publish verbs applying the gate in all three modes.

## F. State, recovery & observability (P9, P14)

- `ST-1` ◐ **Everything is an event** — agents, turns, mail, reviews, phases — durable, inspectable,
  replayable (Principle 14). L0 landed the append-only event log + projections/replay (config & registry are events; replay byte-equality tested); L1 is fully event-sourced over the L0 log (mail send/read + actionable state are events). Remaining: agents/turns/reviews/phases as events in later layers. Evidence: L0 on `main` (PR #11); L1 on `dev`.
- `ST-2` ☐ The system can be **reconstructed and recovered** from its record after a crash/restart;
  stuck/zombie agents are reconciled back to WAITING (Principle 14, `STATE-and-RECOVERY`).
- `ST-3` ☐ **No silent failures** — pre-flight (the doctor), in-flight (live stream monitoring),
  post-hoc (observability); never-drop, fail-loud, degrade safely under pressure (Principle 9).

## G. The agent surface — MCP & self-describing (P4, P5)

- `MC-1` ◐ Agents act through the **MCP server alone, no fallback**; a stubbed tool fails loudly
  (completeness gate) (Principle 4). L1 ships an L1-local no-stub assertion; L2 ships the canonical
  core tool registry, MCP mount, and full tool completeness gate over the real registry (green on
  real tools, red on synthetic stubs). Remaining: L7 session hosting must wire live agents to this
  MCP surface with no alternate command path.
- `MC-2` ◐ **One core, thin adapters** — the CLI, MCP server, and app import the same core; logic
  cannot drift (Principle 4, `MCP-TOOLS`). L2 ships the public core tool surface plus a mechanical
  lint guard that prevents `cli`/`mcp` from deep-importing core internals or opening stores directly.
  Remaining: carry the same rule through the app once it leaves its parked stub.
- `MC-3` ◐ The protocol is **self-describing**: `orient` teaches workflow, schemas teach syntax,
  native project memory teaches the repo, the locator maps unfamiliar code (Principle 5). L2 ships
  workflow-only, role-scoped `co_orient` and schema-publication through MCP, with drift tests
  proving orient does not restate tool field lists. Remaining: locator behavior and the `SH-4`
  stranger-repo proof.

## H. Providers (P13)

- `PV-1` ☐ **Claude and Codex are interchangeable** behind one routing/gating/mail abstraction;
  chosen per role / per dispatch (Principle 13, `PROVIDERS`).
- `PV-2` ⏸ Interactive (non-headless) **subscription auth** works for both providers. *Couples to
  the substrate research (spawn/transport).*

---

## Non-goals for v1 (`⊘`)

Explicitly **out** of the self-hosting bar; revisit post-v1:

- `⊘` A polished **public installable release** (cross-platform installers, marketplace presence,
  onboarding funnel). v1 is self-hosting, not distribution.
- `⊘` Provider breadth beyond **Claude + Codex**.
- `⊘` **Buddy** gacha polish beyond the non-critical-path stub (`BUDDY`).
- `⊘` Becoming an IDE — Principle 15 is deliberate about "just enough to never leave the flow."

## Parked dependencies on the v1 critical path (`⏸`)

These deferred decisions **must resolve before v1** (they gate `SF-1`, `SF-5`, `PV-2`):

- **Runtime substrate** — how the Conductor drives a live interactive session (turn execution,
  spawn/transport, liveness, recovery). See [`research/runtime-substrate.md`](research/runtime-substrate.md).
- **Desktop shell** — Electron vs Tauri-with-Node-sidecar. See
  [`research/language-and-stack.md`](research/language-and-stack.md).

## Lifecycle

Living until v1. When all of §A is `☑`, this document is **archived as the historical record of
what v1 meant** (and may seed a v2 acceptance doc). Its retirement is listed in
[`migration.md`](migration.md) alongside the prototype-footprint teardown.
