# Review Gates & Publishing

## Claude Orchestrator

The defining safety feature: **nothing integrates without a review verdict.**

### Verdicts

- **`PASS`** — clean; merge allowed. A PASS requires a stamped verification marker;
  the gate rejects an unstamped PASS.
- **`ISSUES`** — blockers exist; merge refused. Blockers are actionable bullets
  with file:line references.
- **`SOFT_PASS`** — acceptable with non-blocking suggestions.

### Gated publishing verbs

| Verb | What it gates |
|---|---|
| **`co merge`** | Merge an agent branch into a target (default current HEAD). Preview mode shows the plan without touching the tree; acquires merge locks; supports `--operator-override` (requires `--reason`). |
| **`co push`** | Review-gated push to a remote. `--force` always triggers a fresh review; `--preview` shows what would push without consulting the reviewer. |
| **`co pr-merge`** | Review-gated `gh pr merge` (`merge` / `squash` / `rebase`). |

All three support `--operator-override --reason "..."` for an audited human bypass.
Raw `git merge` / `git push` / `gh pr merge` are **blocked by hooks** — the gated
verbs are the only sanctioned path.

### Review lifecycle verbs

- **`co finish`** — worker finish flow: records test results (passed/failed/
  skipped/duration/verdict), commits a dirty worktree if needed, and mails a
  `worker_done` that triggers reviewer dispatch. `--no-diff` sends a test-run-only
  done without review (e.g. phase testers).
- **`co review-finalize`** — Reviewer records a verdict, mails the requestor, and
  cleans up the worktree. Supports `--blockers` (required for ISSUES),
  `--suggestions`, and an audited `--skip-verification --reason` bypass.
- **`co review-status`** — inspect in-flight (default) or all reviews, filter by
  id / agent / task, JSON output available.
- **`co kickback`** — Lead → worker kickback with at least one `--blocker`
  (and optional `--suggestion`s). Can't kick the same `worker_done` back twice;
  the worker must mail a fresh `worker_done` first. Carries a soft round budget
  (default 5).

A **review round budget** (default 5) bounds the kickback↔fix loop.

## Code Orchestration

### Strictness and escalation are one design

The prototype's reviewer rubber-stamped because its **escalation was broken**: with no
working pressure-release valve, a strict reviewer would *trap* an honest implementer in
an endless kickback loop over a problem it couldn't fix (a pre-existing failing test
that was never its job). Leniency was the workaround. The gate gets strict here only
*because* escalation (below) gives a stuck-but-honest worker an exit. The two are
inseparable.

### Reviewer posture — earn the PASS

- **Skeptical by default; burden of proof on the author.** A PASS is *earned with
  evidence*, never granted by assertion. "This test failed before" is a claim to be
  *verified*, not accepted.
- **Judge fit, not just the diff.** The reviewer reads enough surrounding code and
  convention to judge whether the change is *good in context* and consistent with the
  codebase, and actively hunts for problems (inefficiency, inconsistency, missed edge
  cases) rather than confirming the diff "looks fine." (The prototype's "only inspect the
  diff" instruction is what left it unable to push back.)
- **Two verdicts, no soft middle.** A review yields **`PASS`** (merge allowed; *may carry
  non-blocking suggestions*) or **`ISSUES`** (blockers exist; merge refused, blockers
  required). The prototype's `SOFT_PASS` is **cut**: under the strict posture a
  quality-affecting reservation is a **blocker** (→ ISSUES) and a non-quality reservation is
  a **suggestion on a PASS**, so "acceptable with suggestions" is just PASS + suggestions —
  the soft middle carried no gating weight. (Agent and human reviewers render the same two
  verdicts; MAIL-BUS already draws the verdict as ✅ / ❌.)

### Strictness scales with proximity to production

The two verdicts are fixed, but **the threshold for what counts as a blocker tightens as code
approaches production.** The same nit is a *suggestion* early and a *blocker* late — the cost
of letting it through rises the closer the change gets to leaving the sandbox. The ladder
follows the review scopes (worker merge → phase merge → PR / master):

- **Worker merge → a lead/phase branch (most lenient).** The work is still in an isolated
  branch with more review ahead of it. Correctness and quality-affecting problems still block,
  but **style nits and polish suggestions ride as non-blocking suggestions on a PASS** —
  blocking on cosmetics here would only trap honest workers (and waste the 3-strike budget)
  over things a later pass will catch anyway.
- **Phase merge → the integration / master-bound branch (stricter).** Accumulated nits get a
  harder look; suggestions tolerated per-worker are expected resolved before the phase
  consolidates.
- **PR / push to master (strictest).** The code is leaving the sandbox, so the reviewer is
  **selective and harsh: nits and polish that rode as suggestions earlier now become blockers.**
  Nothing cosmetic passes into prod. This is why `reviewer:pr` is the heaviest seat (pinned to
  Opus — DISPATCH) and why outward merges are the prime candidate for **human review** (below).

Leniency is *front-loaded* where iteration is cheap and rework is expected; strictness is
*back-loaded* where the change is about to become permanent and public. The verdict set never
changes — only the bar for `ISSUES` rises stage by stage.

### Honest verification — a PASS can't hide a failure

- A PASS still requires a stamped verification marker, and the gate **refuses a PASS that
  sits on a failing test.**
- A **test baseline** is captured when the work branches off its base. The gate checks
  failures against it: a failing test **not** in the baseline = a regression = automatic
  reject; a failing test **in** the baseline = flagged and escalated, never silently
  passed. This turns "failed before" into a *recorded fact*, not an assertion — the fast
  path for the exact rubber-stamp the prototype committed.

### The 3-strike rule

The prototype's `review_round_budget` (default 5) merely *bounded* the kickback↔fix loop
and then stalled. It is repurposed into an **escalation trigger**: after **3 consecutive
failed reviews** on the same work item (configurable), the loop stops kicking back and
**escalates to the spawning parent** (protocol in MAIL-BUS; authority in AGENT-ROLES). A
PASS resets the counter. This is the valve that lets the gate stay ruthless without
trapping honest workers.

### Human review — a configurable gate path

The gate needs a *trustworthy verdict*; **who** produces it is a configurable trust choice — an
**agent reviewer** (default, scalable) or the **operator** (human review). This is a **per-repo,
per-scope setting** (the config cascade, INIT): each review scope (worker merge, phase merge, PR
merge) is assigned *agent* or *human*. A repo can require **PR merges to be human-reviewed** while
internal worker merges stay agent-reviewed.

When a scope is human-reviewed, the gate **skips the reviewer agent** and sends an **actionable
review-request mail** to the operator (MAIL — it stays unread until a verdict is rendered, so it
can't be lost). The operator reviews the diff **in-app** (the diff viewer / gate UI — TUI),
against the **same acceptance criteria** an agent reviewer would use, and renders **PASS / ISSUES**
(blockers required for ISSUES). The verdict re-enters the gate identically — merge proceeds or
kicks back; the 3-strike/escalation loop and per-target merge serialization are unchanged. Only
the reviewer's *identity* differs.

This is **filter-up applied to the gate**: the operator personally gates the work they most care
about — typically outward-facing PRs, aligning with both *contributor* mode (WORKTREES) and the
outward-action-needs-a-glance principle. It's viable only *because* the app is a one-stop-shop:
the operator can review a diff without leaving the flow. *(An optional hybrid — agent pre-screens,
human confirms — is available for a belt-and-suspenders scope.)*
