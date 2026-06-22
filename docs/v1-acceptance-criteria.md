# Code Orchestration — v1 Acceptance Criteria

> **Living document.** Iterated throughout development; persists until v1, then archived. This is
> the **global, project-scope** acceptance contract — Principle 10 (`acceptance-criteria`) raised
> from a single task to the whole product. Every spec's own acceptance criteria must **ladder up**
> to one or more criteria here.

**Every Coordinator reads this.** It is referenced from `CLAUDE.md`/`AGENTS.md` (the repo's
project-memory files) — so all sequential Coordinators share one definition of "v1 done" no matter
how many tasks or sessions span the build.

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

> **Operator override (2026-06-21, first coordinator run).** The §2 footprint teardown was executed
> on branch `co/v1-soak-prep` **ahead of** the §1 host-live evidence gate, by explicit operator
> direction (Principle 7 — audited override). Reason: *the resulting clean build is what the operator
> soaks against real `claude`/`codex` before landing on `main`; SH-1/SH-4/SH-5 evidence is captured
> during that soak.* `SH-2` is independently verified (read-guard + `assertRepoPristine`), so the
> teardown is runtime-safe. `SH-1`, `SH-4`, `SH-5` remain open **pending the soak** — they are NOT
> marked met without host-live evidence. This document is therefore **not yet archived** (its
> Lifecycle requires all of §A `☑`).

- `SH-1` ◐ `co` runs a real multi-phase change on the **`co` repo itself** start to finish
  (spec-lock → phases → worktrees → review gate → gated merge) with zero prototype involvement.
  **In-sandbox autonomy is proven:** the Stage 15 `sh1-dry-run` harness
  (`packages/mcp/src/conductor/sh1-dry-run.test.ts`) drives the FULL loop — operator-start → daemon
  cold-start → draft/brainstorm/lock → `co_phase_update` / `co_task_complete` multi-phase advance →
  slings → finish → gated review-merge round-trip → land — over `FakePty` with **zero hand-stitched
  transitions** after lock; Stage 13 landed the operator [`sh1-runbook.md`](sh1-runbook.md) + the
  desktop Review view the live gate uses. A green `FakePty` run is **not** host-live evidence
  (Principle 9). The spec-lock path is now public-CLI driven (`co spec lock`, PR #50) — the operator
  approval gate, not an automation gap — so a clean host-live run can flip `SH-1` to `☑`; the host
  run itself remains the only gate.
- `SH-2` ☑ `co` reads all of its own state/specs/plans from its **own program-data** — no `.co/`
  dependency remains (Principle 12 — `pristine-repo`; Principle 14 — `recoverable`). Met: the
  read-side guard (`packages/core/src/tools/sh2-no-co-read.test.ts`) + write-side `assertRepoPristine`
  are green, and the prototype footprint was removed on `co/v1-soak-prep` (SH-3). L6b lands the
  **records half**: specs (`draft→locked→archived`, queryable via `co_spec_get`) and plans
  (`co_plan_ingest`) are durable event-sourced program-data records with no `.co/specs` dependency
  (see [`l6b-acceptance-criteria.md`](l6b-acceptance-criteria.md), AC-L6b-1/4/5). No live `.co/`-read
  paths remain in production source (read-side guard `sh2-no-co-read.test.ts`, complementing the
  write-side `assertRepoPristine`). Remaining: the SH-3 migration that removes the prototype footprint
  and confirms `co` self-hosts from program-data.
- `SH-3` ◐ The prototype footprint (`.co/`, `.claude/`, `.codex/`, `.goals/`, `.research/`,
  `PORTING-CO.md`, `PRINCIPLES.md`) is removed and the migration PR has landed on `main`
  ([`migration.md`](migration.md)). The **removal** is done on `co/v1-soak-prep` (tracked footprint
  deleted; `.gitignore`/`.prettierignore`/`eslint.config.js`/`package.json`/`CLAUDE.md`/`AGENTS.md`
  cleaned; dangling-reference sweep run). Remaining: the gated land on `main` after the soak.
- `SH-4` ☐ `co` successfully operates on **at least one stranger repo**, including a **local-only
  (Offline-mode)** repo with no remote — proving Principle 5 (`self-describing`) and that GitHub is
  never a hard dependency. **Pending the soak** (captured during the host-live run, per the override
  banner above).
- `SH-5` ☐ Every hard gate holds under self-hosting: no raw `git push` / `gh pr create` /
  `gh pr merge` path exists; only gated MCP tools (`co_merge`, `co_push`, `co_pr_merge`) reach
  `master`/remote/PR (Principle 7 — `gated-by-default`). Stage 15 adds the widened static source /
  scripts / workflow guard and the live deny step in [`host-proof.md`](host-proof.md); `☑` still
  requires a real provider-pane denial artifact. **Pending the soak.** The static no-raw-path guard
  was re-confirmed green on the post-teardown tree (#7 §5 re-prove).

## B. The two surfaces (P1, P2, P3, P15)

- `SF-1` ◐ `co` hosts the **authentic interactive `claude`/`codex`** in a real terminal emulator
  (pty), not a headless reconstruction, not tmux (Principle 2). Substrate decided (Option C); L7 lands
  the sandbox-tested pty host (`PtyHost`/`FakePty`) + the Conductor engine that drives it (spawn →
  drive → bind → inject → route → classify liveness). Stage 12 lands the desktop **agent-console pty
  pane** (transcript + live console view over the raw stream); Stage 14 wires the **autonomous
  self-drive loop** (`co-mcp serve` cold-starts root coordinators and drives warm turns) and the
  watchdog liveness seam (AC-S14-6), all proven over `FakePty`. Remaining: the host-side live proof
  against the real `claude`/`codex` binaries.
- `SF-2` ◐ The operator can **steer any agent mid-turn** from its terminal pane (answer, redirect,
  interrupt) without tearing it down (Principle 1). L7-F lands the sandbox seam (`steerPane` +
  `ConductorEngine.steer`) proven in-sandbox over `FakePty`. Remaining: the host-side live proof
  (real mid-turn interrupt against the real binaries) is outstanding.
- `SF-3` ◐ Agents coordinate **only** via the typed, persisted **mail bus**; the operator is a
  first-class participant and escalations/approvals **filter up** to their inbox (Principles 1, 8). L1 delivers the typed, schema-validated, persisted mail bus over the L0 event log, with `@operator` first-class. Remaining: 'ONLY via mail' (no other channel) is enforced once the MCP surface (L2) + Conductor (L7) wire it.
- `SF-4` ◐ Actionable mail is **un-loseable** (sticky until acted on); informational mail is not
  (Principle 8, `MAIL-BUS`). L1 delivers actionable-vs-informational with sticky-until-resolved as a tested REPLAY invariant + an outstanding-action-count projection. Remaining: the operator-facing inbox UX is the app (L9).
- `SF-5` ◐ A **desktop app** is the operator's one-stop surface — observe and steer all agents in
  one place (Principle 15). Stage 11 stands up the Electron shell (`apps/desktop`): the 6-view nav
  shell, the main-process `@co/core` + P1 `OperatorIpcClient` wiring, the contextBridge
  view-model bridge, and real Dashboard/Mail/Cost data surfaces. Stage 12 lands the **agent-console
  pty pane** (transcript + live console view); Stage 13 lands the **Review view** (diff + locked
  acceptance criteria → PASS/ISSUES verdict — the SH-1 human gate); Stage 14 wires **in-app session
  launch** (`session:start`) and **agent stop/unstick** controls. Remaining: the host-live proof
  (operator handoff) — the live pty stream + mid-turn steer against the real binaries.
- `SF-6` ◐ Artifacts (mail, commit messages) are **rendered per audience** — structured under the
  hood, clean human view on top; provider voice stays out of artifacts (Principle 3). L1 ships the
  renderer-registry seam + a generic default renderer; L3 ships provider-deterministic commit /
  merge / PR message renderers and `co_finish` consumes the commit renderer. L6a wires merge / PR
  renderers into the gated `co_merge` and `co_pr_merge` tools. Stage 15 ships typed mail payload
  cards in core + desktop for the current typed payloads (`approval`, `escalation`, and
  `review_response`). Remaining: broader artifact/card coverage beyond the Stage 15 card set.

## C. Roles, dispatch & escalation (P8, P11, P13)

- `RL-1` ◐ The five base roles work — **Coordinator, Lead, Implementer, Reviewer, Researcher** —
  each with a distinct mandate + permission profile (Principle 11, `AGENT-ROLES`). L6a lands the
  authoritative profiles, role-scoped toolsets, durable roster records, spawn-rule checks, and
  owner-tier tool preflights. Remaining: live Conductor/session enforcement around every hosted
  agent and app-visible role operations.
- `RL-2` ◐ Sub-roles specialize approach and may only **narrow** permissions (Principle 11). L6a
  lands sub-role vocabulary, parse/validation, and completeness checks that reject widening.
  Remaining: live sub-role-specific hosted behavior beyond the base-role tool ceiling.
- `RL-3` ◐ Escalation works: repeated failure / stuck worker / intent ambiguity climbs the spawn
  chain (parent → Coordinator → operator), resolved at the lowest competent level (Principle 8). L1 delivers the escalation protocol — resolve-or-forward (never-drop; send throws on failed persist), ask-on-intent-ambiguity, parent<->child threaded brainstorm, the upward chain, and clarify-timeout=forward-up policy. L6a adds durable roster authority and the `co_kickback` review-budget escalation trigger. Remaining: live stuck-worker / intent-ambiguity triggers from the Conductor/session layer.
- `RL-4` ◐ A **rate-limit-aware balancer** spreads load across the default provider accounts; when tapped, it
  **paces** rather than degrading quality (Principle 13, `DISPATCH`, `COST-and-USAGE`). L4 ships
  provider/account usage buckets, passive live usage adapters, provider-neutral tier placement across
  the default Claude/Codex accounts, throttle-as-WAITING with reset ETA, CLI dry-run diagnostics, and
  `co_sling` placement recording. L9 (RL4-MS) lands same-provider multi-subscription placement —
  the balancer selects the roomiest healthy account among same-provider candidates. Stage 14 lands
  the **autonomous self-drive** that exercises this dispatch path end to end (the daemon cold-starts
  roots and a `co_sling` kickoff seeds the next driven turn), proven in `sh1-dry-run` over `FakePty`.
  Remaining: L7 live session hosting/re-wake, and full self-host proof under real worker load.

## D. Review gate & integration (P6, P7, P10)

- `RG-1` ◐ Nothing reaches `master`/remote/PR without a **PASS** (agent or human) except the
  audited `@operator` override in `RG-3`; two verdicts only (PASS / ISSUES) (Principle 7). L6a
  lands the headless `co_merge` / `co_push` / `co_pr_merge` PASS gates, stale-finish checks, and
  owner/contributor publish guards. Remaining: L7 hosted-surface enforcement so live agents cannot
  use a raw fallback path.
- `RG-2` ◐ The blocker bar **tightens toward production** — nits ride as suggestions into `dev`,
  become blockers at the `main`/PR gate (Principle 7). L6a lands the deterministic review ladder
  and reviewer-profile routing by scope. Remaining: live reviewer sessions must apply the ladder
  while producing verdicts.
- `RG-3` ◐ Operator override exists, is **audited, and records its reason** (Principle 7). L6a
  lands the headless `co_merge`/`co_push`/`co_pr_merge` override path with operator-only reasoned
  audit records. Remaining: L7 hosted-surface enforcement/UX around invoking the override.
- `RG-4` ◐ Acceptance criteria are the **cohesion contract**: the spec produces them, the plan
  structures them, the implementer targets them, tests encode them, the reviewer enforces them
  (Principle 10) — and they trace to this document. L6b lands the mechanism: the spec produces criteria
  (`co_spec_draft` → operator `co_spec_lock`, **lock-gated by the validator**), the plan structures and
  validates them (`co_plan_ingest` requires a locked spec, rejects spec/plan criteria drift, and
  mechanically rejects fuzzy criteria — no wired command / vacuous text), and the review-gate resolver
  can resolve them from the **locked spec record** (`resolveSpecRefFromStore`, never a `<TODO>`);
  see [`l6b-acceptance-criteria.md`](l6b-acceptance-criteria.md) (AC-L6b-2/3/6). Remaining: the live
  merge-gate call-site swap (the L7 conductor seam) and the full
  implementer→tests→reviewer loop under self-hosting.
- `RG-5` ◐ Only the **destructive boundary** is hard-blocked; protocol adherence is reactive nudges
  (Principle 6, `PERMISSIONS`). L6a lands the declared hard-block registry, drift check, and
  non-blocking nudges. Remaining: L7 runtime hook enforcement in the hosted agent surfaces.

## E. Worktrees & pristine repo (P6, P12)

- `WT-1` ◐ Every worker gets an **isolated worktree/branch**; parallel work never collides; merges
  are explicit and locked (Principle 6, `WORKTREES`). L3 ships `co_sling`: branch/base capture,
  injective program-data sandbox paths, and recorded worktree+baseline facts. L6a adds locked,
  gated headless integration through the review/publish tools. Remaining: worker spawn into those
  sandboxes (L7) and live hosted enforcement around the same gates.
- `WT-2` ◐ Gitignored essentials are copied/pointer-linked into worktrees so non-trivial repos and
  environments don't break (Principle 6). L3 ships the provisioning manifest with symlink / copy /
  isolated-copy mechanisms, config overrides, and runnable fixture coverage. Remaining: richer
  project-specific install/offline workflows where a workspace needs more than the manifest.
- `WT-3` ◐ **Nothing orchestration-related touches the target repo** except `CLAUDE.md`/`AGENTS.md`;
  all state/specs/plans/config live in program-data, keyed per project (Principle 12). L0 landed the per-project program-data store + the pristine-repo guard (`assertRepoPristine`, run on every L0 op); L1 mail is program-data-keyed with no repo writes. Remaining: full no-`.co/`-dependency self-host = SH-2/SH-3.
- `WT-4` ◐ Repository-relationship modes work — **Owner / Contributor / Offline** — auto-detected
  with override; the review gate applies in all three (`WORKTREES`). L3 ships read-only
  auto-detection, `repo.mode` override, Offline push/PR-disabled capabilities, and minimal host
  convention probes. L6a applies the gated publish verbs across Owner, Contributor, and Offline
  modes. L9 (WT4-HC) lands the rich host-convention parser (`parseHostConventions` —
  CONTRIBUTING.md / PR-template parse with checklist, required trailers, and template-body
  extraction). Remaining: live hosted use of those verbs and upstream PR lifecycle beyond creation.

## F. State, recovery & observability (P9, P14)

- `ST-1` ◐ **Everything is an event** — agents, turns, mail, reviews, phases — durable, inspectable,
  replayable (Principle 14). L0 landed the append-only event log + projections/replay (config &
  registry are events; replay byte-equality tested); L1 is fully event-sourced over the L0 log (mail
  send/read + actionable state are events). L4 adds usage/cost/near-budget/placement events with
  projector replay coverage and scope/payload identity guards. L6b adds **specs, plans, and phase
  lifecycle** as events (`spec.drafted/locked/archived`, `plan.drafted`, `phase.status.changed`,
  `phase.verified`, `plan.replanned`), replay-equal (see
  [`l6b-acceptance-criteria.md`](l6b-acceptance-criteria.md), AC-L6b-1/5). L6b G/H add **issues and
  research records** as events (`issue.captured/diagnosed/filed/self_assigned`,
  `research.finalized`), replay-equal (AC-L6b-G1/H1). Remaining: agents/turns/reviews
  as events in later layers. Evidence: L0 on `main` (PR #11); L1 on `dev`; L4 dispatch/cost in
  `co/l4-dispatch-cost`; L6b specs/plans in `co/l6b-core`; L6b issues/locator in
  `co/l6b-issues-locator`.
- `ST-2` ◐ The system can be **reconstructed and recovered** from its record after a crash/restart;
  stuck/zombie agents are reconciled back to WAITING (Principle 14, `STATE-and-RECOVERY`). Recovery +
  reconcile landed + tested in-sandbox (P4/P5: `recoverProjectStore → selectAllSessions →
  ReconcileLoop` integration test; MNR-2 errored-turn re-wake; errored_waiting break signal). Remaining:
  the host-live crash/restart proof against the real conductor daemon (host-side handoff).
- `ST-3` ◐ **No silent failures** — pre-flight (the doctor), in-flight (live stream monitoring),
  post-hoc (observability); never-drop, fail-loud, degrade safely under pressure (Principle 9). Doctor/
  observability/never-drop landed in-sandbox: L8-WDOG silent-stop watchdog + STUCK escalation; L8-B
  doctor probes; MNR-2 errored-turn re-wake signal; SH-2 `.co/`-read guard (Principle 12). Stage 14
  wires the **watchdog liveness seam** into the live conductor (silent-stop detection over `FakePty`,
  AC-S14-6). Remaining: the host-live live-stream-monitoring proof.

## G. The agent surface — MCP & self-describing (P4, P5)

- `MC-1` ◐ Agents act through the **MCP server alone, no fallback**; a stubbed tool fails loudly
  (completeness gate) (Principle 4). L1 ships an L1-local no-stub assertion; L2 ships the canonical
  core tool registry, MCP mount, and full tool completeness gate over the real registry (green on
  real tools, red on synthetic stubs). Remaining: L7 session hosting must wire live agents to this
  MCP surface with no alternate command path.
- `MC-2` ◐ **One core, thin adapters** — the CLI, MCP server, and app import the same core; logic
  cannot drift (Principle 4, `MCP-TOOLS`). L2 ships the public core tool surface plus a mechanical
  lint guard that prevents `cli`/`mcp` from deep-importing core internals or opening stores directly.
  Stage 15 carries the same adapter shape through the desktop app: main-process reads and IPC routes
  use `@co/core` / `@co/mcp` instead of duplicating domain logic. Remaining: host-live enforcement
  that every real provider session reaches the same MCP surface with no raw fallback.
- `MC-3` ◐ The protocol is **self-describing**: `orient` teaches workflow, schemas teach syntax,
  native project memory teaches the repo, the locator maps unfamiliar code (Principle 5). L2 ships
  workflow-only, role-scoped `co_orient` and schema-publication through MCP, with drift tests
  proving orient does not restate tool field lists. L6b-H lands the locator's **static half**: the
  map output contract (files + one-line whys + key symbols + read order; dumps mechanically
  rejected) and the durable `co_research_finalize`/`co_research_get` record surface
  ([`l6b-acceptance-criteria.md`](l6b-acceptance-criteria.md), AC-L6b-H1). Remaining: live locator
  behavior (research dispatch is the L7 Conductor) and the `SH-4` stranger-repo proof.

## H. Providers (P13)

- `PV-1` ◐ **Claude and Codex are interchangeable** behind one routing/gating/mail abstraction;
  chosen per role / per dispatch (Principle 13, `PROVIDERS`). L4 ships provider-neutral dispatch
  policy, default Claude+Codex account candidates, passive usage sources, and shared CLI/MCP core
  routing. Remaining: full live-session execution/monitoring behind the same abstraction and the
  self-host proof that both providers can run real worker turns.
- `PV-2` ◐ Interactive (non-headless) **subscription auth** works for both providers. Substrate
  decided (Option C); L7 lands the spawn/transport seam, proven in-sandbox. Remaining: the host-side
  live proof that interactive subscription auth works for both providers.

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
- **Desktop shell** — ✅ RESOLVED: Electron (Stage 11, 2026-06-15). See
  [`research/language-and-stack.md`](research/language-and-stack.md).

## Lifecycle

Living until v1. When all of §A is `☑`, this document is **archived as the historical record of
what v1 meant** (and may seed a v2 acceptance doc). Its retirement is listed in
[`migration.md`](migration.md) alongside the prototype-footprint teardown.
