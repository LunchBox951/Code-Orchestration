# Cost & Usage Tracking

## Claude Orchestrator

- **Per-turn token usage** recorded when the provider emits it.
- **Provider-aware account buckets** — Claude subscription usage, Codex ChatGPT
  app-server signals, Codex API-key billing, tracked separately.
- **`cost_budget_cents`** config cap (default 5000) and a TUI cost-breakdown pane.
- Cost is surfaced both in the DB (queryable) and live in the TUI.

## Code Orchestration

### Live rate-limit state — a control input, not just a report

In the prototype, usage/cost was mostly *recorded*. Here it's also **consumed**: the
rate-limit-aware balancer (DISPATCH) routes on live provider headroom, so usage tracking is a
control input, not just a dashboard. `co` maintains **per-provider buckets**:

- **Claude subscription** — session % used + reset countdown (from `rate_limit_event` signals).
- **Codex subscription** — account / rate signals (app-server transport).
- **API-key billing** — token spend, where applicable.

Each bucket tracks current usage *and* time-to-refresh, so the balancer can both pick the
roomier provider and know when a throttled one will free up (the refresh windows pacing rides).

### Cost & budget

Per-turn token usage is recorded when the provider emits it (the stream-json `result` event
carries `total_cost_usd` + usage — confirmed by probe), rolled up **per-agent / per-task** and
shown live in the app (the prototype's cost-breakdown pane). A **budget cap** (heir to
`cost_budget_cents`) bounds task spend; nearing it surfaces as operator observability (HEALTH),
consistent with throttle-don't-surprise.

> The balancer's *policy* (pinned vs floating, throttle) is in DISPATCH; this topic owns the
> *measurement* it runs on.
