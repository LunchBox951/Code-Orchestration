# Dispatch & Routing

### Routing = tier selection × rate-limit-aware provider selection

The prototype routed on **work-size × reasoning-budget → a capability tier** (simple / average
/ technical × effort). That stays. What's new is **how a provider/model is chosen within a
tier** — because heavy parallelism burns subscription limits, and that must be a first-class
concern. Provider selection is **two-tier**:

- **Pinned roles** — the operator pins specific roles/sub-roles to specific provider+models in
  settings (global ← repo), especially quality-critical seats such as Coordinator or `reviewer:pr`.
  The balancer **never overrides a pin** — provider/model choice stays operator-configured, not
  hard-coded in core.
- **Floating roles** — everything else is placed by a **rate-limit-aware balancer**: among
  providers offering the required tier, it biases toward the one with the most **live headroom**
  (lowest session usage, accounting for reset timing), to **even out burn across the default
  Claude/Codex provider accounts.** ("Claude 50% used / Codex 10% used → lean on Codex.")
  Later dispatch work adds same-provider multi-subscription placement.

All customizable in settings; the **max-children caps** ([PHASES](phases-and-plans.md)) bound total concurrent fan-out.

### Backpressure: throttle, never sacrifice

When *all* suitable providers near their limits, `co` **throttles — it does not degrade quality
or break flow.** Agents work **slower and longer, paced to ride the refresh windows**:

- A throttled agent simply goes **WAITING**; the Conductor re-wakes it (the mail/turn
  machinery) as headroom refreshes. Pacing is just *scheduled waiting* — the turn-based plumbing
  already supports it, so the **flow is preserved**.
- **No tier degradation by default.** Quality is never silently traded for speed; dropping
  floating agents to cheaper models is an explicit opt-in, not an automatic fallback.
- The operator is **informed, not gated** — the throttle state + a refresh ETA surface as
  low-priority observability ([HEALTH](health-and-diagnostics.md)); work keeps pacing itself without asking.

Net: under pressure the system slows to a sustainable rhythm that consistently rides the API
refreshes, rather than burning out, stalling, or cutting corners.

> Live rate-limit state (the buckets the balancer reads) lives in [COST-and-USAGE](cost-and-usage.md). The agent
> *spawn mechanism* (how a placed agent is actually launched) rides on the runtime-substrate
> research; this section fixes the routing *policy*, which is substrate-independent.
