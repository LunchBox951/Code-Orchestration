# Prompts, Project Memory & Orientation

## Claude Orchestrator

### The prompt system

- Every role prompt follows a strict **nine-section skeleton** (Role identity →
  Project conventions → Lifecycle → Scope check → How you work → Tools available →
  Finishing → Self-review → Common pitfalls).
- Prompts are **repo-agnostic** and ship with CO; repo-specific guidance never
  goes in a prompt.
- **Frontmatter** declares `schema_version`, `prompt_version`, and
  `baked_features` — runtime features the prompt assumes. The dispatcher
  **refuses to spawn** an agent whose prompt names a feature the runtime doesn't
  enable (feature-registry parity check).
- **`co prompts lint`** validates every prompt against the skeleton + frontmatter.

### Project-memory overlay

At dispatch time the dispatcher reads the repo-root project-memory file
(`CLAUDE.md` or `AGENTS.md`, capped to ~16 KB) and **bakes it into the agent
prompt** under the `## Project conventions` marker. This is how repo-specific test
commands, architecture notes, and conventions enter agent context. Agents trust
the overlay rather than re-reading the file.

- **`co claudemd init`** — scaffold a canonical project-memory file with the
  required headings.

### Runtime orientation

- **`co orient --role <role>`** — prints **role-safe** CO CLI/MCP guidance so
  agents discover the protocol surface *without reading CO's source tree*.
  Supports `--topic` (one of: `dispatch`, `finish`, `mail`, `publish`, `recovery`,
  `research`, `review`, `status`), `--list-topics`, and `--format text|json`.

The layered context model: **base prompt** (universal behavior) → **project
conventions** (baked overlay) → **runtime orientation** (`co orient` + `--help`).

## Code Orchestration

### The prompting split (load-bearing)

Two kinds of knowledge, two homes, never mixed:

- **`CLAUDE.md` / `AGENTS.md` — project-specific only.** The *target repo's*
  conventions, verification/test commands, architecture, gotchas. `co` **does not
  bake, mirror, or sync it** — the real `claude`/`codex` binary auto-loads its own
  memory file natively in the worktree (PROVIDERS). Baking it into the prompt *on top
  of* that native load would only **double the file's tokens** in context for no gain,
  so `co` leaves project memory to the provider. Contains **zero**
  orchestration-protocol guidance.
- **Shipped role/system prompts + `co orient` — how to be an orchestrated agent.** How
  to use the orchestration tools (mail, finish, review, dispatch, recovery) lives in
  the **universal, repo-agnostic** prompts that ship with `co`, and it **never** leaks
  into project memory.

This is the "*what this repo is*" vs "*how to be an orchestrated agent*" split. It's
what keeps roles repo-agnostic while making them work fluently on a stranger's
codebase — the prototype leaked tool-usage knowledge into context that only made sense
on the `co` repo, which is why it crumbled elsewhere.

### `co orient` — workflow, not syntax

With MCP as the single agent surface, the tool **schemas are the syntax reference**, so
`co orient` teaches **workflow/lifecycle** only — role-scoped: when to send which mail
type, the finish → review → merge flow, recovery paths — so agents learn the *protocol*
without reading `co`'s source. The layered context model carries forward: **base
prompt** (universal behavior) → **native project memory** (`CLAUDE.md`/`AGENTS.md`,
auto-loaded by the provider — not baked) → **runtime orientation** (`co orient` +
schemas).

> The nine-section prompt skeleton and the frontmatter feature-parity discipline from
> the prototype are revisited when we design the **Roles** topic.
