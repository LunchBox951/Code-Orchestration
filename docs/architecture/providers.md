# Provider Abstraction (Claude / Codex)

The three modes — **claude-only**, **codex-only**, **mixed** — carry over unchanged in intent.
What changes is that the provider is no longer a single global default but a *per-role /
per-dispatch preference*, already specified in [DISPATCH](dispatch.md) (pinned roles plus the rate-limit-aware
balancer) and [COST](cost-and-usage.md) (per-account usage buckets). Providers stay interchangeable behind one
routing/gating/mail abstraction (Principle 13 — provider-neutral); a role's provider is simply another dispatch input.

**Project memory stays native — `co` does not touch it.** This is a quiet dividend of the
authentic-interactive-terminal substrate (Principle 2 — authentic-terminal): because each agent runs the *real*
`claude`/`codex` binary in its own worktree, the provider auto-loads its own memory file — Claude
reads `CLAUDE.md`, Codex (and most others) read `AGENTS.md`. `co` neither bakes, mirrors, nor syncs
these files; the repo stays pristine (Principle 12 — pristine-repo) and the files remain exactly what each provider
expects. `co`'s *only* involvement is **passive detection of two memory-file problems**, both surfaced as
dismissible HEALTH signals (see [HEALTH-and-DIAGNOSTICS](health-and-diagnostics.md)) — nudges, not blocks (Principle 6 —
tools-do-the-work), evaluated on project open and when a memory file changes, never an agent-facing gate:

- **Drift** — a repo carries *both* files and they diverge wildly: `co` warns so Claude and Codex
  agents aren't unknowingly handed contradictory guidance on the same repo. Minor differences are
  ignored; only a significant divergence trips it.
- **Memory-blind provider** — a provider this project will run is **missing its file** (e.g. a Codex
  agent on a `CLAUDE.md`-only repo would load *no* project memory — the native model's one gap vs.
  the prototype's bake-whichever-exists). `co` warns and **offers a remedy the operator chooses**:
  create a fresh file, or **alias it as a symlink** to the existing one (one source of truth, zero
  duplication, zero sync). `co` **never auto-syncs**, preserving the no-mirror invariant above.
  (Add-project ensures the right file(s) exist up front, provider-aware — see [INIT-and-CONFIG](init-and-config.md).)

**Provider voice never reaches the artifacts.** Claude is verbose, Codex is terse; under Principle 3 (render-per-audience)
the *app* renders the human-facing surfaces (commit messages, PRs, the operator's mail view), so an
artifact's shape is `co`'s decision, not the provider's. Mixed-mode work therefore produces uniform
commits and PRs regardless of which provider authored it (see [WORKTREES](worktrees.md) on the commit/PR style).

**Usage and rate limits are tracked per account, not per provider** — Claude subscription, Codex
ChatGPT app-server, and Codex API-key billing are distinct buckets ([COST](cost-and-usage.md)). The L4
dispatch path records provider-account buckets and routes across the default Claude/Codex accounts;
later dispatch work adds same-provider multi-subscription placement, selecting the healthiest roomy
account among configured options. When the available provider accounts are tapped, `co` *paces rather
than degrades* (Principle 13 — provider-neutral).

**What still waits on runtime proof:** the host-live transport and liveness evidence for real provider
sessions. The operator directive (authentic interactive terminal, not headless) sets the target;
[`runtime-substrate`](../research/runtime-substrate.md) tracks the remaining proof. Provider behavior
above is settled; provider session-hosting still needs live validation.
