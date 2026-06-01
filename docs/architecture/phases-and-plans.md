# Phases & Plans

### Acceptance criteria are the cohesion mechanism

The prototype's "lack of cohesion" was the absence of a *shared concrete contract*: spec,
implementation, and review weren't anchored to the same standard, so each agent interpreted
"done" differently. **Acceptance criteria are that anchor** — one artifact the spec
*produces*, the plan *structures*, the implementer *targets*, the tests *encode*, and the
reviewer *enforces*. "Acceptance criteria not met" becomes an **objective** rejection ground
for the strict reviewer ([REVIEW-GATES](review-gates.md)), not a judgment call.

### The plan template

A **plan** (per task, owned by the Coordinator — Planner is cut) lives in program-data:

```
# Plan: <task-id> — <title>
## Goal                       (one paragraph, from the locked spec)
## Acceptance criteria (task-level)
  - [ ] <concrete, checkable outcome>
## Phases (DAG)
  ### Phase A — <name>        owner: <Lead>   deps: none
    Goal:     <what this phase delivers>
    Scope:    in: <…>  ·  out: <… explicitly excluded>
    Criteria: - [ ] expired tokens rejected (401)   → `pytest tests/auth/test_expiry.py`
              - [ ] refresh issues a new token       → `pytest tests/auth/test_refresh.py`
    Verify:   `<the project's real test/lint/build command>`
  ### Phase B — <name>        owner: <Lead>   deps: A
```

Every criterion is concrete **and** wired to a real verification command — never "auth works."

### What makes criteria load-bearing, not decorative

1. **Mechanically provable.** Each criterion maps to a test; **phase-done = its criteria-tests
   pass AND no regression vs the baseline** ([REVIEW-GATES](review-gates.md)). The reviewer's "criteria unmet" is
   backed by a failing/missing test. (Natural fit with `implementer:test`: criteria → tests.)
2. **The plan validator rejects fuzzy criteria.** A plan can't be ingested if a criterion
   isn't concrete/checkable ("is clean," "works well" fail). Criteria quality is *gated*, not
   hoped for — the completeness discipline ([MCP-TOOLS](mcp-tools.md)) applied to plans.
3. **Two levels.** Task-level criteria + per-phase criteria; phases roll up — task-done = all
   phase criteria met.

### Parallelism and its controls

Independent phases (no shared deps in the DAG) run **in parallel** under separate Leads in
isolated worktrees. Parallelism is the point — but it burns provider rate limits and
resources, so it's **bounded**:

- **Max active children per parent** *(configurable setting; excludes reviewers).* A
  Coordinator/Lead may have ≤ N active children at once; excess dispatches queue until a slot
  frees. The primary throttle on fan-out (and on rate burn — see [DISPATCH](dispatch.md)/[COST](cost-and-usage.md) for the
  rate-limit-aware routing that complements it).
- **One active reviewer per merge target — serialize review+merge.** A review is bound to a
  base SHA; a *parallel* merge to the same target changes that SHA and invalidates a
  concurrent review (the prototype's "second `co merge` re-review" thrash). So reviews and
  merges to a given target are **serialized** — one at a time. When the first lands, the next
  reviewed branch is (correctly) re-reviewed against the new base before merging. The
  prototype's merge-locks become a per-target review+merge serialization.

### Lifecycle & re-planning

The plan is a **living record** in program-data with live per-phase status (planned →
building → review → verified → merged), shown in the app. Escalation can trigger
**re-planning**: a 3-strike or intent-ambiguity outcome amends the plan (re-scope a phase,
spawn a remediation phase) with an audit trail. Phase-ready = the phase's acceptance criteria
met + verified (mechanical suite-run vs baseline) — the heir to `phase_chunk_ready`.

> Per-role model preferences and rate-limit-aware provider routing live in [DISPATCH](dispatch.md) / [COST](cost-and-usage.md);
> the concurrency *caps* above are the knobs those policies turn.
