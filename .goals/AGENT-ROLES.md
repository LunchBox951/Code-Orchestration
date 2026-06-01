# Agent Roles

## Claude Orchestrator

`co` ships a fixed roster of nine roles, each with a base prompt, a permission
profile, and a default model tier. Roles are **repo-agnostic** — project-specific
guidance is injected at dispatch time, never baked into the role.

| Role | Mandate | Writes code? | Default tier |
|---|---|---|---|
| **Coordinator** | Owns a task end-to-end: shape intent with operator, lock spec, plan phases, dispatch, gate merges, publish, close. | No (delegates) | advanced |
| **Lead** | Owns one phase: decompose, dispatch workers, integrate reviewed branches, run phase verification, report `phase_ready`. | No (delegates) | advanced |
| **Planner** | Writes/validates/ingests a phase plan under `.co/plans/`. Pure planning. | No | technical |
| **Implementer** | Changes production code in an assigned worktree, verifies it, finishes through the review loop. | **Yes** | average |
| **Reviewer** | Inspects a target diff and returns a verdict. May run verification & stamp markers but does not edit code under review. | No (read-only-for-code) | advanced |
| **Tester** | *Author mode*: writes tests (not production code). *Phase-test mode*: runs the suite against a lead branch and reports counts, no diff. | Tests only | average |
| **Documenter** | Updates docs, comments, ADRs, READMEs, project-memory. May edit code samples inside docs, not production code. | Docs only | average |
| **Polisher** | Behavior-preserving cleanup only: style, naming, dead-code, small safe refactors. Test counts must match before/after. | Cleanup only | simple |
| **Researcher** | Read-only. Answers a specific question with cited evidence and finalizes a structured report. Stays warm for follow-ups. | No | simple |

### Agent hierarchy

```
@operator
  └── Coordinator            (one per task)
        ├── Planner          (optional, produces the phase plan)
        ├── Lead (phase A)
        │     ├── Implementer
        │     ├── Tester
        │     └── Reviewer   (gates each worker branch)
        ├── Lead (phase B)
        │     └── ...
        └── Researcher       (read-only, spawnable at any level)
```

Structural rules enforced by the product:

- A Coordinator never spawns another Coordinator; a Lead never spawns another Lead.
- For small mechanical work the Coordinator may dispatch a single direct helper
  instead of spinning up the full Lead → worker tree.
- Workers finish by mailing a `worker_done`; their parent (Lead/Coordinator)
  integrates the reviewed branch.

## Code Orchestration

### The roster: base roles × sub-roles

Roles are **two-level**. A **base role** is the expensive, safety-bearing unit — a
distinct *mandate + permission profile*. A **sub-role** specializes a base role's
*approach* (and may narrow its scope), and is cheap to add. This shrinks the base
roster (clean permission model) while growing expressiveness (rich specialization).

**Invariant:** a sub-role *inherits* its base role's permission profile and may
**narrow it, never widen it** — sub-roles can't become a backdoor around permissions.
They are a **shipped, fixed set** (like base roles), under the same completeness-gate
discipline: a sub-role earns its place only when its *approach meaningfully differs*,
not for a tier tweak. (Config-level extensibility is a later option, not a launch
feature.)

**Base roles (5):**

| Base role | Mandate | Writes |
|---|---|---|
| **Coordinator** | task owner: shape intent → lock spec → plan phases → dispatch → gate → publish → close. **Plans the work itself**, spawning Researchers when investigation is needed. | delegates |
| **Lead** | phase owner: decompose → dispatch workers → integrate reviewed branches → verify → report phase-ready. | delegates |
| **Implementer** | changes code in an isolated worktree, finishes through the gate. | code |
| **Reviewer** | the gate; inspects a target and returns a verdict. | read-only-for-code |
| **Researcher** | read-only; answers a scoped question with cited evidence; stays warm for follow-ups. | nothing |

**Sub-roles (approach / scope specializations):**

- **Implementer** → `code` · `test` · `docs` · `polish`
  - *Approach knob:* **`code`** = implementation-first (make the change, then write tests
    that lock the decisions in against regression — tests follow code); **`test`** =
    test-first (write the test that captures the contract or reproduces the bug, watch it
    fail, then fix until it passes — code follows tests). `code` fits feature/decision
    work; `test` fits bug fixes / behavior-correction. **Both write code *and* tests** —
    there is no test-free path.
  - *Scope knob:* **`docs`** (docs-only) and **`polish`** (behavior-preserving cleanup;
    test counts must match before/after) narrow *what they touch*.
- **Reviewer** → `feature` · `bugfix` · `pr` — review depth and posture calibrated to the
  work: `feature` (architecture fit, completeness, consistency), `bugfix` (does it fix
  it? regression vs the baseline? scope creep?), `pr` (external/random change — no
  in-house baseline/trust to lean on). Pairs with the maker's methodology:
  `code` ↔ `feature`, `test` ↔ `bugfix`.
- **Researcher** → **`codebase`** (locator) · **`external`** (web) · **`diagnostic`** (bug-cause)
  · **`decision`** (cited answer). Read-only, cited, report-finishing, warm for follow-ups;
  **web-search is a sub-role-gated capability.** Spawnable by **any agent except a Reviewer or
  another Researcher** (Researchers are leaf agents — no recursive research). Full design in
  RESEARCH.

**Cut from the prototype's nine:**
- **Planner** — removed. The Coordinator's mandate already includes planning, and in
  practice it planned itself (with Researchers as needed); a standing Planner role never
  earned its spawn.
- **Tester / Documenter / Polisher** — folded into Implementer sub-roles (`test` / `docs`
  / `polish`); never distinct permission profiles, just Implementer with a focus.

**Mechanical, not a role:** running the suite against a lead branch and counting results
(the prototype's *other* Tester mode) is gate/baseline machinery — no LLM judgment, so it
costs no role.

### The agent hierarchy

The Conductor (the runtime engine — CORE-CONCEPTS) spawns and drives every agent; the operator is
the human above it, reachable by mail. The roster below is the agent tree the Conductor
instantiates:

```
@operator        human — initiates tasks, owns intent; escalations/approvals filter up here (mail)
   ⇅ mail
Conductor        runtime engine (not an agent) — spawns, drives, routes, reconciles every agent below
   └── Coordinator              one per task — plans the work itself
         ├── Lead (phase A)      one per phase — independently mergeable
         │     ├── Implementer   :code · :test · :docs · :polish
         │     ├── Reviewer      :feature · :bugfix · :pr — gates each branch
         │     └── Researcher    read-only leaf — on-demand or pre-dispatched
         ├── Lead (phase B) → …
         └── Implementer         small mechanical work: one direct helper, no full Lead → worker tree
   (Researchers are spawnable at any level except by a Reviewer or another Researcher.)
```

Structural rules (carried from the prototype, adjusted for the new roster):

- A **Coordinator never spawns a Coordinator; a Lead never spawns a Lead** — the tree never recurses
  at the owner tiers.
- A **Researcher is a leaf** — spawnable by any agent *except* a Reviewer or another Researcher (no
  recursive research; RESEARCH).
- **Workers finish by signalling done** (`co_finish` → `worker_done`); their parent (Lead or
  Coordinator) integrates the reviewed branch.
- For **small mechanical work** the Coordinator may dispatch a **single direct Implementer** instead
  of standing up a full Lead → worker tree.

### Escalation authority — who resolves what

The spawn hierarchy doubles as the **escalation chain**. Each level has a mandate; the
rule is *resolve within your mandate, forward when it needs authority you don't have,
never drop or guess* (protocol in MAIL-BUS). The cut:

- **Implementer / leaf worker** — does the work; **asks** (never guesses) on intent
  ambiguity; is **lifted out of** an unwinnable kickback loop by the 3-strike rule rather
  than trapped in it.
- **Lead** *(resolves)*: how-to-implement, integration, approach *within the phase*,
  re-scoping a worker, spawning a remediation worker inside the phase. *(Forwards)*:
  anything that changes what the phase delivers or touches spec intent.
- **Coordinator** *(resolves)*: spec interpretation *within the locked spec*, phase
  re-scoping, acking known issues (e.g. a baseline-confirmed pre-existing failure),
  deploying fix agents. *(Forwards to operator)*: genuine intent ambiguity the spec
  doesn't settle.
- **Operator** — the source of truth on intent. Receives **filtered, big-picture
  decisions only**, not noise.

Governing intent: **filter things up so the operator focuses on the bigger-picture
decisions**, and everything resolvable below is resolved below.

> The roster above is the source of truth for *which* base roles and sub-roles exist.
> Each one's prompt skeleton, permission profile, and routing/tier defaults are detailed
> in the Prompts, Permissions, and Dispatch topics respectively.