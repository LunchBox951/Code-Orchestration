# Provider Abstraction (Claude / Codex)

## Claude Orchestrator

`co` is provider-neutral with Claude as the default runtime. Three modes:

1. **Claude-only (default)** — no `runtime` block or `default_provider: claude`.
   Requires the configured `claude` command.
2. **Codex-only** — `default_provider: codex` with a `codex` runtime block
   (`transport: exec|app_server`, `auth_mode`, `sandbox`, `approval_policy`).
   Needs no `.claude/` dir or Claude binary; credentials owned by `codex login`.
3. **Mixed** — a default provider plus `provider_overrides` keyed by role
   (e.g. `implementer: codex`, `reviewer: claude`).

Provider-aware behaviors:

- **Project memory is provider-neutral.** `CLAUDE.md` is preferred; `AGENTS.md`
  is a first-class fallback with the same required sections. If both exist,
  `CLAUDE.md` wins. The dispatcher bakes whichever it finds into agent prompts and
  `co doctor` validates it.
- **Usage / rate-limit summaries are provider-aware** — Claude subscription usage,
  Codex ChatGPT app-server account signals, and Codex API-key billing are tracked
  as separate account buckets. Codex `exec` transport records token usage but not
  account/rate-limit state (that requires `app_server` transport).
- **Provider override per dispatch** — `co sling --provider {claude,codex}` beats
  config overrides and the default.

## Code Orchestration

The three modes — **claude-only**, **codex-only**, **mixed** — carry over unchanged in intent.
What changes is that the provider is no longer a single global default but a *per-role /
per-dispatch preference*, already specified in DISPATCH (pinned roles plus the rate-limit-aware
balancer) and COST (per-account usage buckets). Providers stay interchangeable behind one
routing/gating/mail abstraction (Principle 13 — provider-neutral); a role's provider is simply another dispatch input.

**Project memory stays native — `co` does not touch it.** This is a quiet dividend of the
authentic-interactive-terminal substrate (Principle 2 — authentic-terminal): because each agent runs the *real*
`claude`/`codex` binary in its own worktree, the provider auto-loads its own memory file — Claude
reads `CLAUDE.md`, Codex (and most others) read `AGENTS.md`. `co` neither bakes, mirrors, nor syncs
these files; the repo stays pristine (Principle 12 — pristine-repo) and the files remain exactly what each provider
expects. `co`'s *only* involvement is **passive detection of two memory-file problems**, both surfaced as
dismissible HEALTH signals (see HEALTH-and-DIAGNOSTICS) — nudges, not blocks (Principle 6 —
tools-do-the-work), evaluated on project open and when a memory file changes, never an agent-facing gate:

- **Drift** — a repo carries *both* files and they diverge wildly: `co` warns so Claude and Codex
  agents aren't unknowingly handed contradictory guidance on the same repo. Minor differences are
  ignored; only a significant divergence trips it.
- **Memory-blind provider** — a provider this project will run is **missing its file** (e.g. a Codex
  agent on a `CLAUDE.md`-only repo would load *no* project memory — the native model's one gap vs.
  the prototype's bake-whichever-exists). `co` warns and **offers a remedy the operator chooses**:
  create a fresh file, or **alias it as a symlink** to the existing one (one source of truth, zero
  duplication, zero sync). `co` **never auto-syncs**, preserving the no-mirror invariant above.
  (Add-project ensures the right file(s) exist up front, provider-aware — see INIT-and-CONFIG.)

**Provider voice never reaches the artifacts.** Claude is verbose, Codex is terse; under Principle 3 (render-per-audience)
the *app* renders the human-facing surfaces (commit messages, PRs, the operator's mail view), so an
artifact's shape is `co`'s decision, not the provider's. Mixed-mode work therefore produces uniform
commits and PRs regardless of which provider authored it (see WORKTREES on the commit/PR style).

**Usage and rate limits are tracked per account, not per provider** — Claude subscription, Codex
ChatGPT app-server, and Codex API-key billing are distinct buckets (COST). The balancer spreads load
across whatever subscriptions are live and *paces rather than degrades* when both are tapped
(Principle 13 — provider-neutral).

**What still waits on the runtime research:** the *transport* — how `co` actually hosts and drives
each provider's interactive session (Codex `exec` vs `app_server`, and the equivalent Claude path).
The operator directive (authentic interactive terminal, not headless) sets the target;
`.research/runtime-substrate.md` resolves the mechanism. Until then, provider *behavior* above is
settled; provider *session-hosting* is deferred.
