# Complete CLI Command Reference

## Claude Orchestrator

| Command | Summary |
|---|---|
| `co init` | Initialize `.co/` in a project (provider-aware scaffold). |
| `co doctor` | Provider-scoped health checks. |
| `co buddy` | Manage the cosmetic project buddy (`show/roll/reroll/history`). |
| `co brainstorm` | Start a brainstorming/intake session (TTY editor, flags, file, or stdin). |
| `co dispatch` | Hand a written spec to a Coordinator. |
| `co sling` | Operator-direct single-agent dispatch (with routing + dry-run). |
| `co research` | Dispatch a Researcher with a structured question. |
| `co research-report` | Researcher's canonical report finisher. |
| `co research-followup` | Follow-up to a warm researcher. |
| `co send` | Send a typed mail message to an agent. |
| `co mail` | Inspect the mail bus. |
| `co status` | All active agents + phases. |
| `co tail` | Stream an agent's turn-log (optionally follow). |
| `co log` | Show one turn log. |
| `co inspect` | Deep inspection of an agent. |
| `co replay` | Replay recorded events. |
| `co attach` | Re-attach the TUI to a running task. |
| `co pause` | Pause a running agent. |
| `co stop` / `co kill` | Terminate an agent (`--clean`/`--soft`/`--continue`). |
| `co unstick` | Recover a STUCK/zombie agent → WAITING. |
| `co merge` | Review-gated branch merge (preview / override). |
| `co push` | Review-gated remote push. |
| `co pr-merge` | Review-gated GitHub PR merge. |
| `co finish` | Worker finish flow (review + `worker_done`). |
| `co kickback` | Lead → worker kickback with blockers. |
| `co review-finalize` | Record a review verdict + cleanup. |
| `co review-status` | Inspect in-flight / historic reviews. |
| `co plan` | Plan `validate` / `ingest` / `show` / `list`. |
| `co phase-status` | Structured phase snapshot for the phase-ready gate. |
| `co coord-phase` | Set Coordinator phase overlay (brainstorm/build/publish). |
| `co ledger` | Per-task decision ledger (`show`/`add`/`path`). |
| `co issue` | Manage `.co/issues/` (`new`/`list`). |
| `co worktrees` | List orchestrator worktrees. |
| `co cleanup` | Report/remove landed task branches & artifacts. |
| `co nuke` | Wipe runtime state (`--all`/`--task`). |
| `co orient` | Role-aware CO CLI/MCP guidance. |
| `co prompts` | `lint` agent prompts against the skeleton. |
| `co claudemd` | `init` a canonical project-memory file. |
| `co permissions` | `regen` / `check` the per-role permission registry. |
| `co run` | Headless event router daemon (auto-started; never call from a tool). |

## Code Orchestration

The CLI is reframed as a **human power-user / scripting surface only — not an agent
surface.** It is a thin adapter over the same core the desktop app and the agent MCP
server use (see MCP-TOOLS), so it can't drift in logic. Agents are **permission-denied**
from invoking `co` in the shell, which is what prevents the prototype's "CLI fallback
masks MCP gaps" failure from recurring.

The **desktop app is the primary operator surface**; the CLI serves CI, debugging, and
scripting. The concrete verb set is derived once the operator-facing topics are locked
(it will largely mirror the app's actions over the shared core) rather than ported
wholesale from the prototype's table above.
