# Worktrees & Git Management

## Claude Orchestrator

- **Auto-creation** — dispatch auto-creates a worktree from a base ref
  (auto-detected `origin/HEAD` → `main` → `master`), or reuses one passed via
  `--worktree`.
- **Branch naming** — agents work on `co/...` branches; phase testers run on
  `co/phase-test/<lead-branch>`.
- **Shared venv** — worktrees symlink the parent repo's virtualenv so test/lint
  commands work in-place.
- **`.co/` shadow rule** — a worktree's `.co/` is a shadow; specs/plans live only
  at the real repo root. The product enforces "read from repo root, write in your
  worktree."
- **`co worktrees`** — list all orchestrator-managed worktrees.

## Code Orchestration

### The repo stays pristine — orchestration data lives in program-data

The prototype's biggest structural mistake was writing orchestration state **into the
target repo** (`.co/` held specs, plans, the state DB, issues, ledgers…), which bloated
every repo it touched and forced the awkward "read from repo root, write in your worktree"
shadow dance. **Code Orchestration stores nothing orchestration-related in the repo.** All
of it lives in the desktop app's **program-data directory** (platform-appropriate:
`~/.local/share/co/` on Linux, `~/Library/Application Support/co/` on macOS,
`%APPDATA%\co\` on Windows), keyed per project.

Consequences:
- **The target repo keeps only its own content** — code, plus the project-memory file
  (`CLAUDE.md`/`AGENTS.md`), which genuinely belongs to the project and is the *one* thing
  that stays in-repo.
- **The `.co/` shadow rule dissolves.** Agents never read specs/plans from a repo path;
  they get them through MCP tools backed by program-data. Worktrees become *pure code
  sandboxes* — zero orchestration files in them.
- **Spec durability flips.** With specs out of the repo, git history is no longer their
  record — they become durable first-class records in program-data. (Revisited in
  SPECS-and-ISSUES; it changes the prototype's "delete specs on merge" policy.)

### Project identity (zero repo footprint)

The app keeps a **project registry** in program-data mapping each managed repo to its data
dir. To honor "nothing in the repo," identity is **path-based** (registry maps the repo's
absolute path → a stable project id → its data dir); moving/renaming the repo triggers a
**re-link** prompt in the app rather than leaving a marker behind. *(Final mechanism
settled in INIT-and-CONFIG; the principle is zero repo footprint.)*

### Worktree environment provisioning (the gitignored essentials)

A worktree gives you *tracked* files; a *runnable* dev environment also needs the
**gitignored working essentials** — dependency dirs (`.venv`, `node_modules`, `vendor/`,
`target/`), env files (`.env`), local config. The prototype symlinked the Python `.venv`,
which meant nothing on a non-Python repo. The general rule: **`co_sling` provisions the
project's working essentials into each new worktree**, via the right mechanism per item:

- **Pointer (symlink) for large, stable, read-mostly items** — dependency dirs. Cheap, no
  duplication.
- **Copy for small or per-agent-mutable items** — env files, local config.
- **Isolated copy when an agent must mutate deps** (e.g. installs a package), so parallel
  agents don't corrupt a shared dependency dir.

The set is a **configurable provisioning manifest** with smart defaults (common dep dirs +
env files) and per-project overrides — *not* a blanket copy of everything in `.gitignore`
(which is mostly junk). The agent wakes into a worktree that *just works*: deps present,
env present, tests runnable — without it or the operator fiddling.

### Carried forward / refined

- **Auto-creation** by `co_sling` from an auto-detected base ref (`origin/HEAD` → `main` →
  `master`), now also **capturing the test baseline** at branch-off (the honest-verification baseline — REVIEW-GATES).
- **Branch naming** stays `co/…`.
- **Lifecycle:** worktrees are torn down when their work lands (merge) or the agent is
  cleaned up; the app surfaces orphans so they don't rot. *(Cleanup verbs detailed in
  State-and-Recovery.)*

### Messages: `co` owns the contract, one register per audience

The provider used to write the commit message — Claude verbose, Codex terse — so model
defaults leaked straight into git history. Instead, **`co` owns the message contract:** the
agent supplies *intent* (what changed and why); `co_finish` / `co_merge` render it into a
fixed house style, so provider variance disappears by construction. Register varies by
**audience**:

- **Commits** (read to *navigate the diff*) — **Conventional Commits**, concise, with an
  *adaptive body*: summary-only for trivial changes, summary + a 2–4 line body when it
  helps a reader follow the diff.
  ```
  fix(auth): reject expired tokens instead of passing silently

  validateToken() returned true past expiry (stale-clock `<=`);
  now reads a fresh monotonic clock and adds the boundary test.
  Touches login + refresh.
  ```
  *(trivial: `chore(ci): bump node 20 -> 22 in test matrix`)*
- **Merge commits** (`co_merge` owns them — the prototype's "absolute mess") — same house
  style + a review reference:
  ```
  merge(co/phase-auth): harden token validation  [reviewed: PASS]

  Phase "auth-hardening": reject expired tokens, boundary + refresh
  tests, stale-clock fix. 3 commits · 0 regressions vs baseline.
  ```
- **PRs** (read by a maintainer *deciding whether to let you in*) — a descriptive sales
  pitch: **Why / What changed / Verification / Conventions**, leading with rationale and
  stakes.

### Repository-relationship modes

A **per-project mode** reshapes the publishing surface. The **review gate applies in all
three** — the mode only changes *where* reviewed work goes:

| Mode | Integration path | PRs | Style |
|---|---|---|---|
| **Owner** | gated `co_merge` / `co_push` to your master | optional | `co` house style |
| **Contributor** | fork → PR to upstream (the sales-pitch PR is the deliverable) | required | **yields to the host repo's conventions** — `CONTRIBUTING.md`, PR template, sign-off |
| **Offline** | `co_merge` lands locally; push / PR disabled | n/a | `co` house style |

**Auto-detected** (no remote → offline · you have push access → owner · it's a fork of
someone else's repo → contributor), with manual override. *(Gated verbs live in
REVIEW-GATES; the per-project setting + auto-detect live in INIT-and-CONFIG.)*
