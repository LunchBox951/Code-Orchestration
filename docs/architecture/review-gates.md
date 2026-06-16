# Review Gates & Publishing

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
  verdicts; [MAIL-BUS](mail-bus.md) carries the typed verdict and the app chooses the visual
  treatment.)

### Strictness scales with proximity to production

The two verdicts are fixed, but **the threshold for what counts as a blocker tightens as code
approaches production.** The same nit is a *suggestion* early and a *blocker* late — the cost
of letting it through rises the closer the change gets to leaving the sandbox. The ladder
follows the review scopes (worker merge → phase merge → outward PR / remote publish):

- **Worker merge → a lead/phase branch (most lenient).** The work is still in an isolated
  branch with more review ahead of it. Correctness problems still block, but quality findings,
  style nits, and polish suggestions ride as non-blocking suggestions on a PASS. Blocking on quality
  debt here would only trap honest workers (and waste the 3-strike budget) over things the
  lead/phase consolidation gate is designed to catch.
- **Phase merge → the protected integration branch (stricter).** Accumulated nits get a harder look;
  quality suggestions tolerated per-worker are expected resolved before the phase consolidates.
- **Outward PR / remote publish (strictest).** The code is leaving the sandbox, so the reviewer is
  **selective and harsh: nits and polish that rode as suggestions earlier now become blockers.**
  Nothing cosmetic passes into prod. This is why `reviewer:pr` is the heaviest seat and should be
  routed by operator/project config to the strongest available reviewer model rather than hard-coded
  in core ([DISPATCH](dispatch.md)); outward merges are also the prime candidate for **human review** (below).

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
- In contributor mode, `co_push` keeps the per-target serialization slot after pushing the
  reviewed branch; the slot is released by `co_pr_merge` after the PR is created. That keeps
  the reviewed `pr_merge` PASS bound across the fork push -> PR handoff, so another branch
  cannot advance the target between the two publish steps.

### Audited operator override

The only explicit escape hatch around a missing PASS is an **`@operator` override**. It is
not an agent path: `co_merge`, `co_push`, and `co_pr_merge` accept it only from
`@operator`, require a non-empty reason, record `review.override` before any publish side
effect, and render the reason into the reviewed marker (`override — <reason>`). The
override bypasses the PASS gate and recorded worktree-parent ownership only; worktree
existence, removed-state, repo-mode, identity, signoff, and capability checks still run
normally.

### The 3-strike rule

The prototype's old `review_round_budget` merely *bounded* the kickback↔fix loop
and then stalled. It is repurposed into an **escalation trigger**: after **3 consecutive
failed reviews** on the same work item (configurable), the loop stops kicking back and
**escalates to the spawning parent** (protocol in [MAIL-BUS](mail-bus.md); authority in [AGENT-ROLES](agent-roles.md)). A
PASS resets the counter. This is the valve that lets the gate stay ruthless without
trapping honest workers.

### Human review — a configurable gate path

The gate needs a *trustworthy verdict*; **who** produces it is a configurable trust choice — an
**agent reviewer** (default, scalable) or the **operator** (human review). This is a **per-repo,
per-scope setting** (the config cascade, [INIT](init-and-config.md)): each review scope (worker
merge, phase merge, outward PR / publish handoff) is assigned *agent* or *human*. A repo can
require **PR creation and remote publish handoffs to be human-reviewed** while internal worker
merges stay agent-reviewed.

When a scope is human-reviewed, the gate **skips the reviewer agent** and records the target
slot, `review.requested` row, and **actionable review-request mail** to the operator in one
program-data transaction ([MAIL](mail-bus.md) — it stays unresolved/actionable until a verdict is
rendered, so it can't be lost). The operator reviews the diff **in-app** (the diff viewer / gate UI — [TUI](tui.md)),
against the **same acceptance criteria** an agent reviewer would use, and renders **PASS / ISSUES**
(blockers required for ISSUES). The verdict re-enters the gate identically — merge proceeds or
kicks back; the 3-strike/escalation loop and per-target merge serialization are unchanged. Only
the reviewer's *identity* differs.

This is **filter-up applied to the gate**: the operator personally gates the work they most care
about — typically outward-facing PRs, aligning with both *contributor* mode ([WORKTREES](worktrees.md)) and the
outward-action-needs-a-glance principle. It's viable only *because* the app is a one-stop-shop:
the operator can review a diff without leaving the flow. *(An optional hybrid — agent pre-screens,
human confirms — is available for a belt-and-suspenders scope.)*
