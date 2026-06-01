# Initialization & Configuration

## Claude Orchestrator

### `co init`

Scaffolds `.co/` in a project. `--provider {claude,codex,both}` chooses which
project-memory scaffold to write (`CLAUDE.md`, `AGENTS.md`, or both). Writes
`.co/config.yaml` with Claude active by default and a commented provider block.
Does **not** create or edit `.codex/config.toml`. `--yes` skips prompts.

### `config.yaml` schema (features expressed as config)

```yaml
defaults:                      # per-role routing defaults
  coordinator: { difficulty: advanced,  mode: auto }
  lead:        { difficulty: advanced,  mode: auto }
  reviewer:    { difficulty: advanced,  mode: auto }
  planner:     { difficulty: technical, mode: auto }
  implementer: { difficulty: average,   mode: bypass }
  tester:      { difficulty: average,   mode: bypass }
  documenter:  { difficulty: average,   mode: bypass }
  polisher:    { difficulty: simple,    mode: bypass }
  researcher:  { difficulty: simple,    mode: auto }

cost_budget_cents: 5000        # per-task spend cap
turn_timeout_seconds: null     # null = no wall-clock cap on a turn
review_round_budget: 5         # kickback↔fix loop bound
clarify_timeout_seconds: 1800  # how long a clarify_request waits
stale_turn_max_age_seconds: 21600   # watchdog: orphaned-turn reap age

runtime:                       # provider selection (optional; default claude)
  default_provider: claude
  provider_overrides: { implementer: codex }
  codex:
    command: codex
    transport: exec            # or app_server
    auth_mode: auto
    sandbox: workspace-write
    approval_policy: on-request

tui:
  buddy:
    backend: fallback          # avoid Anthropic probe in Codex-only projects
```

A `config.local.yaml` overlay supports machine-local overrides.

## Code Orchestration

### Config is a settings panel, not hand-edited YAML

The prototype's `config.yaml` + `config.local.yaml` become a **settings UI in the desktop
app**, with the classic cascade:

- **Global** — app-wide defaults (default provider, per-role routing/tiers, budgets, buddy
  backend, issue-reporting defaults…).
- **Repository-specific** — per-project overrides that **win over global** (relationship
  mode, provider overrides, per-role routing overrides, issue-reporting opt-in…).

Effective config = global ⊕ repo-overrides. Consistent with the pristine-repo rule, **all
config lives in program-data** — global at the root, per-project in each project's data dir
— *never* in the repo.

### Init is "add a project," not `co init` in the repo

There's no `.co/` scaffold. Adding a project is an **app flow**: register the repo → create
its program-data dir → **auto-detect** the relationship mode (WORKTREES) and provider →
ensure the project-memory file(s) the configured provider(s) will use exist in the repo —
**provider-aware** (both `CLAUDE.md` *and* `AGENTS.md` in mixed mode, the relevant one in
single-provider mode; the remedy for a file that goes missing later lives in PROVIDERS) — the *one*
repo-resident artifact, since it's project memory. The thin power-user CLI can do the same headlessly.

### Version & compatibility — kill the silent mismatch

The prototype's worst failure here was *silent*: `co` called a provider function the
installed (older) Claude lacked and died quietly mid-run. The root cause is **version skew**
between `co` and the provider on a given machine (Claude updated on one computer, not the
other). The fix makes skew **loud, early, and self-healing**:

- **`co` auto-updates itself.** As a desktop app it keeps current on its own, eliminating
  most `co`-side skew.
- **An invisible startup doctor.** Every launch, `co` silently checks that this machine's
  installed Claude/Codex satisfies the **required-capability manifest** for this version of
  `co` — capability-aware (the specific provider features `co` depends on), backed by a
  coarse minimum-version floor. Runs **per-machine** (each install is local), no user action.
- **On a discrepancy, degrade safely and loudly — never die silently:**
  1. **Auto-disable bug tracking** (if enabled). A version mismatch produces *spurious*
     friction — bugs that are version artifacts, not real `co` defects — and must not pollute
     the issue tracker (SPECS-and-ISSUES) with that noise.
  2. **Warn** the operator that continuing may hit bugs.
  3. **Urge an update**, pointing at the lagging component (usually the provider on this
     machine).
  4. The operator **may proceed at their own risk** — agency preserved.
- **The one hard stop:** if a *required* capability is genuinely absent (the core runtime
  can't function), `co` blocks with the same specific, actionable message rather than limping.

> The doctor's full check suite (and a manual invocation) is detailed in
> HEALTH-and-DIAGNOSTICS; this section fixes the config model, the add-project flow, and the
> version-compatibility behavior.
