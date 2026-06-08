# Cost & Usage Tracking

### Live rate-limit state — a control input, not just a report

In the prototype, usage/cost was mostly *recorded*. Here it's also **consumed**: the
rate-limit-aware balancer ([DISPATCH](dispatch.md)) routes on live provider-account headroom, so usage tracking is a
control input, not just a dashboard. `co` maintains **per-provider-account buckets**:

- **Claude subscription** — session % used + reset countdown from the CLI `statusLine`.
- **Codex subscription** — account / rate signals from trusted local OAuth and SQLite state.
- **API-key billing** — token spend, where applicable.

Each bucket tracks current usage *and* time-to-refresh, so the balancer can both pick the
roomier provider and know when a throttled one will free up (the refresh windows pacing rides).

### Cost & budget

Per-turn token usage is recorded when the provider emits it (for example, the stream-json
`result` event carries `total_cost_usd` + usage), rolled up **per-agent / per-task**, and
available to host CLI readouts. L7 adds streaming usage sources and re-wake behavior; L9 adds the
app view. A **budget cap** (heir to `cost_budget_cents`) bounds task spend; nearing it surfaces as
operator observability ([HEALTH](health-and-diagnostics.md)), consistent with throttle-don't-surprise.

> The balancer's *policy* (pinned vs floating, throttle) is in [DISPATCH](dispatch.md); this topic owns the
> *measurement* it runs on.
