# Health & Diagnostics

### Organizing principle: no silent failures

This topic is the home for a guarantee that recurs across the whole design: **every failure
is detected and surfaced — never silent.** It's the throughline behind the version-mismatch
doctor ([INIT](init-and-config.md)), the reactive protocol-nudges ([PERMISSIONS](permissions.md)), the never-drop escalation
guarantee ([MAIL](mail-bus.md)), and the canonical bug from the issue example — *an implementer that
silently stopped and was never noticed.* Diagnostics catches failure at three moments.

### Pre-flight — the doctor

Catches environment problems *before* they bite. Two modes:
- **Invisible at startup** ([INIT](init-and-config.md)) — fast, per-machine: provider version/capability compat,
  degrade-safely-on-discrepancy.
- **Manual deep `co doctor`** — a full report in the app's diagnostics panel (CLI-mirrored):
  provider availability + auth (subscription reachable), project-memory presence/validity
  (`CLAUDE.md`/`AGENTS.md`) — **provider-aware**, so a provider missing its file is caught before it runs memory-blind ([PROVIDERS](providers.md)), program-data integrity (state DB + project registry), and **MCP
  surface completeness** (every declared agent tool is real — the completeness gate, checked
  live).

### In-flight — live monitoring

Catches failure *while it happens.* The Conductor watches each agent's event stream
and turns would-be-silent failures into visible signals:
- **The canonical bug:** an agent that *silently stops* — yields or goes idle without a
  `worker_done`/finish. The Conductor detects the missing finish, nudges the agent
  ([PERMISSIONS](permissions.md)), and if it stays wedged marks it **STUCK** and surfaces it to the operator —
  instead of the work just stopping, unnoticed.
- **Crashed / zombie sessions** — a dead or wedged provider process is detected and flagged
  (a *live* heir to the prototype's stale-turn watchdog, not a 6-hour reap).
- Protocol breaks, runaway loops, budget overruns — surfaced, not swallowed.

*(Detection signals ride on the runtime-substrate research; the principle — silent stops
become visible health events — is substrate-independent.)*

### Post-hoc — observability

Once flagged, you can *see and diagnose.* The desktop app is the live introspection surface
(CLI-mirrored for power users): the agent roster + states, phase and review status, per-agent
/ per-task cost, and the durable **event stream / replay** ([STATE-and-RECOVERY](state-and-recovery.md)) to
reconstruct exactly what happened. The prototype's `status` / `inspect` / `review-status` /
`phase-status` become app views over the same data.

### Boundary

Health **detects and surfaces**; it does not *act*. The recovery verbs (unstick, restart,
clean) live in [STATE-and-RECOVERY](state-and-recovery.md) — diagnostics lights the warning, recovery turns the wheel.
