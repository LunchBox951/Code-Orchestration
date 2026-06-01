# MCP Tool Surface

## Claude Orchestrator

Agents act through an **MCP server** exposing the orchestration surface as tools
(snake_case), mirroring the CLI verbs (kebab-subcommand). One surface per action —
never both for the same thing.

| MCP tool | Purpose |
|---|---|
| `co_mail_send` / `co_mail_inbox` / `co_mail_get` / `co_mail_thread` / `co_mail_ack` / `co_mail_retract` | Full mail-bus operations. |
| `co_sling` | Spawn an agent. |
| `co_review_request` | Request a mid-work diff review. |
| `co_review_finalize` | Record a review verdict. |
| `co_finish` / `co_finish_no_diff` | Worker finishers (with / without diff review). |
| `co_research_finalize` | Researcher report finisher. |
| `co_phase_ready` | Lead → Coordinator phase-ready signal. |
| `co_task_complete` | Mark a task complete. |
| `co_kickback` | Spawner → worker kickback. |
| `co_continue` | Coordinator self-continue (bounded; cap 2) to keep a long task going. |
| `co_orient` | Role-safe orientation. |
| `co_status` | Live status. |
| `co_worktree_info` | Resolve the agent's own worktree path/metadata. |

`AskUserQuestion` is denied in orchestrated subagent contexts — agents must use
`co_mail_send` with `type: clarify_request` instead.

## Code Orchestration

### One agent surface: MCP only, no fallback

Agents act through **exactly one** surface — the orchestration **MCP server** — with
**no fallback**. The prototype's dual CLI+MCP surface was the root cause of its "only
works on the `co` repo" failure: because agents could always fall back to the CLI when
an MCP tool was missing or stubbed, **the MCP's gaps never had to be fixed** —
half-implemented tools shipped to master, silently masked by the fallback. The
redundancy didn't add safety; it *hid* defects, and it forced `co orient` to teach two
surfaces while agents burned tokens choosing between them and recovering from the
wrong pick.

A single surface makes a missing/stubbed tool **fail loudly** instead of degrading
silently, so it gets caught and fixed. The constraint is the feature.

Why MCP (not CLI) for agents:
- **Self-describing by construction.** The tool list + JSON schemas are presented to
  the model natively — no `--help` archaeology. (The prototype's "dozens of help
  commands, wasted tokens, failing to run `co` constantly" is *intrinsic* to driving a
  CLI from an agent: discovery via `--help` text, invocation via shell strings.)
- **Structured I/O.** Typed args in, structured results out — no shell-quoting of
  multi-line mail bodies/specs, no stdout parsing.
- **Permission-clean.** Allow/deny tools per role maps directly onto the role's
  permission profile.

### One core, thin adapters

All orchestration logic lives in a **single core library**. Every surface — the
agent's MCP server, the operator's desktop app, the power-user CLI — is a **thin
adapter** over that core. Adapters cannot drift in *logic* (only presentation
differs); the prototype's MCP/CLI drift came from maintaining two separate
implementations.

### Completeness gate — no stubs reach master

Because there is no fallback, a stubbed agent tool breaks the agent outright — so
completeness is enforceable and enforced. A parity/completeness check (heir to the
prototype's feature-registry parity + prompt-lint) **fails the build/review if any
declared MCP tool is stubbed or partial.** No half-implemented tool reaches master.

### `co orient` stays — but lighter

`co orient` earned its place and remains the agent's runtime protocol guide, surfaced
as an MCP tool (consistent with the single surface). Its job shrinks: the **schemas
now cover syntax**, so orient teaches **workflow and lifecycle** — when to send which
mail type, the finish → review → merge flow, recovery — role-scoped.

### The human CLI is not an agent surface

A thin power-user/scripting CLI exists for the operator (CI, debugging, scripting), but
it is **not** an agent surface: agents are **permission-denied** from invoking `co` in
the shell, so the fallback cannot creep back in. See CLI-REFERENCE.
