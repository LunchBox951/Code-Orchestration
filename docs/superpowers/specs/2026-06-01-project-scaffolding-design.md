# Project Scaffolding & Open-Source Governance — Design

**Date:** 2026-06-01
**Status:** Approved (design); release *policy* deliberately parked
**Topic:** The v1 repository scaffold for Code Orchestration (`co`) — physical layout,
open-source governance, GitHub-native contribution model, and coexistence with the
prototype that is building it.

---

## 1. Context & goals

Code Orchestration (`co`) is a ground-up TypeScript rewrite of the Claude-Orchestrator
prototype. The substrate-independent design is complete and captured in `.goals/*.md` /
`.research/*.md`; the language is decided (TypeScript, "one core, thin adapters"); the
runtime substrate and desktop shell remain parked for evidence (Principle 16).

This design covers the **repository scaffold**, not `co`'s feature implementation. Its goals:

1. **Open-source ready from the first public commit** — the repo can accept Issues and PRs
   from strangers without scrambling to add policy after the fact.
2. **GitHub-native governance as the backbone** — Projects, Issues, labels, and branch
   protection deliberately mirror `co`'s own domain model (roles, phases, specs, the review
   gate). Whoever plays Coordinator / Lead / Reviewer — human now, agents later — is oriented
   by a project structure shaped like what `co` orchestrates. Building `co` becomes a live
   instance of `co`'s own discipline (dogfooding).
3. **Physical layout that embodies the stack decision** — the monorepo *is* the
   "single module graph; one core, thin adapters" the TypeScript decision is built on.
4. **Migrate, don't lose, the design corpus** — `.goals/`/`.research/` become proper in-repo
   docs so contributors can read the "why" and code can keep citing principle handles.
5. **Coexist with the prototype** — the Claude-Orchestrator prototype drives this build and
   writes a "dirty" footprint into the tree; the scaffold must host it temporarily and make
   its removal surgical.

### Locked decisions

| Decision | Choice |
|---|---|
| Governance posture | **Full from day one**, built around GitHub Projects + the contributing flow |
| GitHub ↔ `co` model mapping | **Tight mirror**, while keeping local-only (Offline-mode) repos first-class |
| License | **MIT** |
| Design corpus fate | **Migrate into `docs/`** (16 principle handles preserved verbatim) |
| Repo topology | **Monorepo, pnpm workspaces** (`packages/core` + `cli` + `mcp`, `apps/desktop`) |
| Code of Conduct | Contributor Covenant 2.1 |
| Commit convention | Conventional Commits |
| Contributor sign-off | **DCO** (`Signed-off-by`, lightweight check action) |
| Release model | **Two-track** (`main` stable / `nightly` prerelease) — *structure now, policy parked* |

### Parked decisions (Principle 16 — decisions-deferred)

- **Release policy & publish tooling** — branch name (`nightly` vs `dev`/`develop`), which
  branch is GitHub-default, promotion cadence, semver/prerelease scheme, and Changesets vs
  semantic-release. Lands in `docs/governance/release-policy.md`. The scaffold provides only
  the tooling-agnostic parts (branches, CI, a `release.yml` placeholder).
- **Desktop shell** — Electron vs Tauri-with-Node-sidecar (`apps/desktop` is a stub).
- **Runtime substrate** — out of scope here; see `docs/research/runtime-substrate.md`.

---

## 2. Repository layout

`packages/` holds the npm-publishable workspaces (the core library + the two thin adapters);
`apps/` holds the distributable desktop shell (not an npm package). The whole design corpus
migrates into `docs/`.

```
code-orchestration/
├─ packages/
│  ├─ core/                    # THE single source of truth — domain model, mail bus,
│  │                           #   event store, review-gate, provider abstraction,
│  │                           #   Conductor logic, and all Zod schemas
│  │  └─ src/  package.json  tsconfig.json  README.md
│  ├─ cli/                     # thin CLI adapter   → imports core   (npm i -g)
│  │  └─ src/  package.json  tsconfig.json  README.md
│  └─ mcp/                     # thin MCP server    → imports core   (the agent surface)
│     └─ src/  package.json  tsconfig.json  README.md
├─ apps/
│  └─ desktop/                 # shell PARKED (Electron vs Tauri, Principle 16) —
│     └─ README.md             #   stub + pointer to docs/research, no shell commitment yet
├─ docs/
│  ├─ README.md                # docs index / reading order (replaces PORTING-CO.md)
│  ├─ vision.md                # ← .goals/VISION.md (Code Orchestration section)
│  ├─ principles.md            # ← PRINCIPLES.md (16 handles preserved verbatim)
│  ├─ concepts.md              # ← .goals/CORE-CONCEPTS.md
│  ├─ v1-acceptance-criteria.md # living global acceptance contract (read by every Coordinator)
│  ├─ architecture/            # ← the rest of .goals/*, reorganized & de-prototyped
│  │  ├─ mail-bus.md  dispatch.md  providers.md  worktrees.md  review-gates.md
│  │  ├─ phases-and-plans.md  specs-and-issues.md  state-and-recovery.md
│  │  ├─ event-router.md  permissions.md  prompts-and-memory.md  agent-roles.md  …
│  ├─ research/                # ← .research/* (still-open decisions stay open)
│  │  ├─ runtime-substrate.md  language-and-stack.md
│  ├─ governance/
│  │  ├─ project-board.md  labels.md  roles.md  release-policy.md (parked)
│  └─ migration.md             # the prototype-teardown checklist (see §3)
├─ .github/
│  ├─ ISSUE_TEMPLATE/
│  │  ├─ spec.yml  phase.yml  task.yml  bug.yml  research.yml  config.yml
│  ├─ PULL_REQUEST_TEMPLATE.md
│  ├─ CODEOWNERS
│  ├─ labels.yml
│  ├─ dependabot.yml
│  └─ workflows/  ci.yml  label-sync.yml  release.yml(placeholder)
├─ LICENSE                     # MIT
├─ README.md                   # public front door (concise, status: pre-alpha)
├─ CONTRIBUTING.md  CODE_OF_CONDUCT.md  SECURITY.md  GOVERNANCE.md
├─ package.json                # private workspace root: scripts + shared devDeps
├─ pnpm-workspace.yaml
├─ tsconfig.base.json  tsconfig.json        # solution-style project references
├─ eslint.config.js  .prettierrc  .editorconfig  .gitignore  .nvmrc
└─ AGENTS.md  CLAUDE.md        # sanctioned native memory (permanent; see §3)
```

**Layout choices:**

1. **Zod schemas live inside `packages/core`**, not a separate `schemas` package — YAGNI until
   something outside core needs them standalone. They already drive runtime validation, static
   types, and JSON-Schema generation for the self-describing surface (Principle 5).
2. **`apps/desktop` ships as a stub** — a README pointing at `docs/research/runtime-substrate.md`.
   The shell choice is parked (Principle 16); the scaffold must not pre-commit it.
3. **`docs/` migration is reorganization, not rewrite** — the `## Claude Orchestrator`
   (prototype) halves are dropped; the `## Code Orchestration` halves become canonical. Principle
   handles (`filter-up`, etc.) survive verbatim so inline code citations still resolve.
4. **`docs/README.md` replaces `PORTING-CO.md`** as the reading-order entry — same job, framed for
   a contributor arriving fresh rather than for porting from the prototype.

---

## 3. Coexistence with the prototype (temporary)

The Claude-Orchestrator prototype drives this build and writes orchestration state *into* the
repo — the exact thing the new `co`'s **Principle 12 (pristine-repo)** forbids. The repo meant to
*exemplify* pristine must host the dirty tenant while that tenant builds it. The seam is made
surgical.

| Path | What it is | Fate |
|---|---|---|
| `.co/` | prototype state: `config.yaml`, `state.db`, `worktrees/`, `logs/`, `transcripts/`, and the tracked `specs/ plans/ issues/` | **temporary** |
| `.claude/hooks/*.py` + `settings.json` | prototype's Claude gate hooks (publishing + polling) | **temporary** |
| `.codex/hooks/*` + `hooks.json` | same gates for Codex | **temporary** |
| `AGENTS.md`, `CLAUDE.md` | native memory — **sanctioned by Principle 12** | **permanent** |

**`.gitignore` handling.** The root `.gitignore` ignores `.claude/` and `.codex/` wholesale, but
**deliberately leaves `.co/` alone**:

```gitignore
# ============================================================
# PROTOTYPE FOOTPRINT (temporary) — Claude-Orchestrator drives this build.
# Remove this block at migration. See docs/migration.md (#<issue>).
# NOTE: .co/ is intentionally NOT ignored here. Its own .co/.gitignore
# tracks specs/plans/issues (which worktree agents read from COMMITTED
# history — git worktrees only see committed files) and ignores the rest.
# A root-level `.co/` ignore would break those re-include negations.
# ============================================================
.claude/
.codex/
# ============================================================
```

- **Why `.co/specs|plans|issues` must be tracked:** the prototype dispatches agents into
  worktrees under `.co/worktrees/`; a git worktree only contains *committed* content, so an
  uncommitted spec is invisible to the worker. The specs must be committed for the build to run.
- **Tracked-but-temporary:** `.co/.gitignore`, `.co/specs/**`, `.co/plans/**`, `.co/issues/**`.
  Accepted tension with Principle 12 in the showcase repo — the price of the dirty tool building
  the clean one.
- **Teardown** is one migration commit/PR that deletes the whole footprint, documented in
  `docs/migration.md` and tracked as a Project-board issue labeled `migration`. History will
  still *contain* these files during the build; only `main`'s HEAD at v1 ends up clean. A squash
  at migration is available if truly pristine history is ever wanted (deferred, not a blocker).

**Native-memory addition.** `AGENTS.md` and `CLAUDE.md` (currently empty `TODO` stubs) get a new
section, added to both and kept in sync (CLAUDE.md wins on conflict):

> **## Prototype footprint (temporary).** This repo is built by the Claude-Orchestrator
> *prototype*, which writes `.co/`, `.claude/`, `.codex/` into the tree — a temporary tenant that
> violates Principle 12, not part of the product. `.co/specs|plans|issues` are tracked only
> because worktree agents read *committed* specs; everything else is ignored. The whole footprint
> is removed in the migration commit once `co` can self-host. Don't build on, document, or treat
> `.co/` as product code. See `docs/migration.md`.

The memory files also gain a **## Global v1 acceptance criteria** pointer to
`docs/v1-acceptance-criteria.md` (see §4a) — this is the mechanism by which every sequential
Coordinator inherits the same v1 bar, since the memory file is read at the start of every agent's
turn.

The remaining `AGENTS.md`/`CLAUDE.md` sections (test command, build/lint/type-check, conventions,
"things agents should not do") get filled in as the codebase grows — pnpm scripts, the monorepo
map, the gates/principles.

**Operational flag.** The prototype's `gate-publishing-verbs` hook blocks raw `git push` /
`gh pr merge`. While active, the first push to GitHub and every PR merge during the build go
through the prototype's gated verbs (`co push` / `co pr-merge`) or the operator's own hands
outside an agent session. This is the dogfood working and is consistent with the branch
protection in §5. Local `git commit` / `git checkout` are not publishing verbs and are unaffected.

---

## 4. Governance & community files

The "Full from day one" set. Static files here; the *live* GitHub config (labels, board, branch
protection) is §5.

**Root community-health files**

| File | Content |
|---|---|
| `LICENSE` | MIT, operator's name + 2026. |
| `README.md` | Front door: what `co` is (the two surfaces), **status: in active development / pre-alpha**, the dogfooding story, links to `docs/`, CONTRIBUTING, principles. Honest about not-yet-installable. |
| `CONTRIBUTING.md` | The established rules: dev setup (pnpm / Node version via `.nvmrc`), the spec → phase → task model, the issue types, branch & PR flow (target `nightly`), the review-gate expectation, Conventional Commits, **DCO sign-off (`git commit -s`)**, and the prototype-footprint caveat. |
| `CODE_OF_CONDUCT.md` | Contributor Covenant 2.1; operator email as contact. |
| `SECURITY.md` | Private disclosure path (`co` runs agents that execute code and hold subscription/credential access — security is real), supported versions, response expectations. |
| `GOVERNANCE.md` | Decision model: **BDFL-for-now**, how proposals are weighed against the 16 principles, the role vocabulary, and the path to adding maintainers — tying human governance to `co`'s role model. |

**`.github/` machinery**

- **`ISSUE_TEMPLATE/`** — the tight mirror; types are `co`'s work units:
  - `spec.yml` — top-level intent / spec (Coordinator's input)
  - `phase.yml` — independently-mergeable slice (Lead-owned)
  - `task.yml` — implementer-sized unit
  - `bug.yml` — defect report
  - `research.yml` — open decision / Researcher question → `docs/research/`
  - `config.yml` — `blank_issues_enabled: false`; contact links → Discussions, Security
- **`PULL_REQUEST_TEMPLATE.md`** — links the spec/phase/task it closes; an acceptance-criteria
  checklist (Principle 10); PASS/ISSUES verdict framing; a DCO reminder.
- **`CODEOWNERS`** — packages → owners (operator now; role-mapped as agents/humans take roles).
- **`labels.yml`**, **`dependabot.yml`**, **`workflows/`** — see §5–6.

Filing an issue on this repo already speaks `co`'s vocabulary — the orientation goal.

---

## 4a. Global v1 acceptance criteria (living)

A persistent, iterated `docs/v1-acceptance-criteria.md` holds the **project-scope** acceptance
contract — Principle 10 (`acceptance-criteria`) raised from a single task to the whole product.
Every per-spec acceptance criterion must ladder up to a criterion here.

- **Anchor (the v1 bar):** **`co` self-hosts; the prototype is retired** — `co` orchestrates its own
  development end-to-end on a real repo with no prototype involvement, and the footprint is removed.
  The motivating sentence: *"`co` built the next `co`."*
- **Awareness:** referenced from `AGENTS.md`/`CLAUDE.md`, so every Coordinator (read at turn start)
  inherits one shared definition of "v1 done" across all sessions.
- **Shape:** self-hosting exit criteria (`SH-1..5`) + per-principle groups (A–H), each criterion
  carrying a status marker (`☐ open · ◐ in progress · ☑ met · ⏸ parked-on-research · ⊘ post-v1`);
  a non-goals section; and the parked dependencies that sit on the v1 critical path (substrate,
  shell).
- **Lifecycle:** living until v1, then archived as the historical v1 record (its retirement
  coincides with — and is gated by — the prototype teardown, §8).

---

## 5. The live GitHub mirror

Configured in GitHub (UI/API); documented in `docs/governance/`. The literal embodiment of the
tight mirror.

**Labels** (`.github/labels.yml`, synced by workflow):

- **type:** `type:spec` · `type:phase` · `type:task` · `type:bug` · `type:research`
- **role:** `role:coordinator` · `role:lead` · `role:implementer` · `role:reviewer` · `role:researcher`
- **status:** `status:spec-locked` · `status:in-phase` · `status:in-review` · `status:blocked` · `status:done`
- **area:** `area:core` · `area:cli` · `area:mcp` · `area:desktop` · `area:docs` · `area:meta`
- **meta:** `good first issue` · `help wanted` · `migration` (the prototype-teardown task)

**Projects (v2) board** (`docs/governance/project-board.md`):
`Backlog → Spec-locked → In phase → In review → Blocked → Done` — columns = `co`'s lifecycle.
Issues (spec/phase/task) flow across it exactly as agents flow through states. Release channel
stays a *label*, not a column.

**Branch protection = the review gate** (the GitHub embodiment of Principle 7 — the blocker bar
tightens toward production):

| | `main` (production) | `nightly` (integration) |
|---|---|---|
| Direct push | blocked | blocked |
| PR required | yes | yes |
| Approvals | ≥1 PASS, no self-approve | ≥1 PASS (self-merge-after-green allowed) |
| Required checks | CI green (lint + typecheck + test + build) | CI green |
| Force-push / deletion | blocked | blocked |
| Conversation resolution | required | optional |
| DCO check | required | required |

---

## 6. Branching, release & CI

**Two-track release model** *(structure now, policy parked to `docs/governance/release-policy.md`)*

- **`main`** — stable. Strict gate. Tagged semver releases.
- **`nightly`** — integration line. Looser gate. Auto-published prereleases on each merge.
- Flow: feature branch → PR → `nightly`; periodic gated promotion `nightly` → `main` = a release
  cut. Maps onto `co merge` (into nightly) / `co pr-merge` (promote to main). This is the literal
  infrastructure for Principle 7's graduated strictness: `nightly` carries nits as suggestions,
  `main` turns them into blockers.
- **Parked:** branch naming, GitHub-default branch (PR-base ergonomics), promotion cadence,
  semver/prerelease scheme, and publish tool — *Changesets* (monorepo-native, explicit
  changelogs; the `.changeset/` dir is provisional on this) vs *semantic-release* (fully
  automated, native `main`/`next` channels, weaker on monorepos).

**CI & automation** (`.github/workflows/`):

- `ci.yml` — PR + push to `main`/`nightly`: pnpm install → lint → typecheck → test → build. These
  are the required status checks above.
- `label-sync.yml` — applies `labels.yml` on change.
- `dependabot.yml` — npm (root + packages) + github-actions, weekly.
- `release.yml` — **placeholder**, wired once the parked release-tooling decision lands.

---

## 7. `docs/` migration mapping

A reorganization of the Initial-Commit corpus. The `## Claude Orchestrator` (prototype) halves are
dropped; the `## Code Orchestration` halves become canonical.

| Source | Destination |
|---|---|
| `PORTING-CO.md` | `docs/README.md` (reframed as contributor reading-order) |
| `PRINCIPLES.md` | `docs/principles.md` (16 handles verbatim) |
| `.goals/VISION.md` | `docs/vision.md` |
| `.goals/CORE-CONCEPTS.md` | `docs/concepts.md` |
| `.goals/DESIGN-PRINCIPLES.md` | folded into `docs/principles.md` (authoritative prose) |
| `.goals/{MAIL-BUS,DISPATCH,PROVIDERS,WORKTREES,REVIEW-GATES,PHASES-and-PLANS,SPECS-and-ISSUES,STATE-and-RECOVERY,EVENT-ROUTER,PERMISSIONS,PROMPTS-and-MEMORY,AGENT-ROLES,TUI,BUDDY,COST-and-USAGE,HEALTH-and-DIAGNOSTICS,INIT-and-CONFIG,MCP-TOOLS,CLI-REFERENCE,RESEARCH}.md` | `docs/architecture/*.md` (lower-kebab) |
| `.research/runtime-substrate.md`, `.research/language-and-stack.md` | `docs/research/*.md` |

Inline cross-references (`see WORKTREES`) are rewritten to the new paths; principle citations
(`Principle 8 — filter-up`) are left intact and resolve to `docs/principles.md`.

---

## 8. Migration teardown checklist (`docs/migration.md`)

Tracked as a Project-board issue labeled `migration`. When `co` can self-host:

1. Confirm `co` reads specs/state from its own program-data (no `.co/` dependency).
2. `rm -rf .co .claude .codex`.
3. Delete the PROTOTYPE FOOTPRINT block from `.gitignore`.
4. Remove the "Prototype footprint (temporary)" section from `AGENTS.md` / `CLAUDE.md`.
5. Archive `docs/v1-acceptance-criteria.md` — reaching this teardown *is* the v1 bar (`SH-3`), so
   §A of that doc is met; keep it as the historical v1 record (or seed a v2 doc).
6. (Optional) squash/rewrite if truly pristine history is wanted.
7. Land as a single gated PR `nightly` → `main`.

---

## 9. Out of scope

- `co`'s feature implementation (waits on the runtime substrate research).
- The desktop shell choice.
- The full release policy (branch naming, cadence, versioning, publish tooling).
- Filling in `AGENTS.md`/`CLAUDE.md` command/convention sections (done as code lands).

---

## 10. Next steps

1. User reviews this spec.
2. `writing-plans` turns it into a phased implementation plan (the scaffold is itself
   decomposable into phases — workspace skeleton, docs migration, governance files, GitHub
   mirror, CI — which the prototype can then execute via `.co/specs`).
