# Dispatch & Routing

## Claude Orchestrator

### Dispatching work

- **`co dispatch <spec>`** — hand a written spec to a fresh Coordinator.
- **`co sling`** — operator-direct dispatch of a *single* agent of any role,
  bypassing the Coordinator tree. The low-level spawn primitive.
- **In-band dispatch mail** — Coordinators/Leads request spawns by mailing a
  `dispatch` envelope to the orchestrator, which the dispatch consumer turns into
  a real agent.

`co sling` options capture the full dispatch surface: `--type` (role), `--spec`
(body file), `--task`, `--phase`, `--files` (scope hints), `--branch`,
`--worktree` (reuse existing), `--base` (branch base, auto-detected), `--parent`
(spawner), `--provider`, plus routing overrides and `--dry-run` (validate + print
the plan without writing state).

### The routing model — work-size × reasoning-budget → model

Every agent is dispatched with two orthogonal routing dials:

**Work size** (how hard the *work* is):
- `simple` — narrow / mechanical
- `average` — normal
- `technical` — cross-cutting / architectural

**Reasoning budget** (how much *thinking* to spend):
- `economy` — cheap follow-up
- `standard` — default
- `deep` — extra reasoning

These map, per provider, to a concrete model + reasoning effort:

| Work size | Claude model | Codex model |
|---|---|---|
| simple | `claude-haiku-4-5` | `gpt-5.4-mini` |
| average | `claude-sonnet-4-6` | `gpt-5.4` |
| technical | `claude-opus-4-8` | `gpt-5.5` |

Reasoning budget then selects an effort level (`medium` / `high` / `xhigh` /
`max`) within that tier. Per-role defaults live in config (e.g. Coordinator/Lead/
Reviewer = advanced, Implementer/Tester = average, Polisher = simple). The
`--deep` shorthand on research = `technical` + `deep`.

A **dispatch mode** controls gating: `auto` (review-gated, the default for
Coordinator/Lead/Reviewer/Planner/Researcher) vs `bypass` (for trusted leaf
workers like Implementer/Tester/Documenter/Polisher whose output still flows
through a review before merge).

## Code Orchestration

### Routing = tier selection × rate-limit-aware provider selection

The prototype routed on **work-size × reasoning-budget → a capability tier** (simple / average
/ technical × effort). That stays. What's new is **how a provider/model is chosen within a
tier** — because heavy parallelism burns subscription limits, and that must be a first-class
concern. Provider selection is **two-tier**:

- **Pinned roles** — the operator pins specific roles/sub-roles to specific provider+models in
  settings (global ← repo): e.g. **Coordinator → Opus (max effort)**, **`reviewer:pr` → Opus.**
  The balancer **never overrides a pin** — these are the quality-critical, predictable seats.
- **Floating roles** — everything else is placed by a **rate-limit-aware balancer**: among
  providers offering the required tier, it biases toward the one with the most **live headroom**
  (lowest session usage, accounting for reset timing), to **even out burn across subscriptions.**
  ("Claude 50% used / Codex 10% used → lean on Codex.")

All customizable in settings; the **max-children caps** (PHASES) bound total concurrent fan-out.

### Backpressure: throttle, never sacrifice

When *all* suitable providers near their limits, `co` **throttles — it does not degrade quality
or break flow.** Agents work **slower and longer, paced to ride the refresh windows**:

- A throttled agent simply goes **WAITING**; the Conductor re-wakes it (the mail/turn
  machinery) as headroom refreshes. Pacing is just *scheduled waiting* — the turn-based plumbing
  already supports it, so the **flow is preserved**.
- **No tier degradation by default.** Quality is never silently traded for speed; dropping
  floating agents to cheaper models is an explicit opt-in, not an automatic fallback.
- The operator is **informed, not gated** — the throttle state + a refresh ETA surface as
  low-priority observability (HEALTH); work keeps pacing itself without asking.

Net: under pressure the system slows to a sustainable rhythm that consistently rides the API
refreshes, rather than burning out, stalling, or cutting corners.

> Live rate-limit state (the buckets the balancer reads) lives in COST-and-USAGE. The agent
> *spawn mechanism* (how a placed agent is actually launched) rides on the runtime-substrate
> research; this section fixes the routing *policy*, which is substrate-independent.