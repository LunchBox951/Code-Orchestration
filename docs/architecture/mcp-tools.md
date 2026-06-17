# MCP Tool Surface

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
the shell, so the fallback cannot creep back in. See [CLI-REFERENCE](cli-reference.md).
