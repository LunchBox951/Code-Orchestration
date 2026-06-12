# Code Orchestration - L7 Acceptance Criteria

> Local contract for the L7 Conductor foundation slice. These IDs are cited in code and tests as
> `AC-L7-*`; each criterion ladders to the project-wide v1 criteria in
> [`v1-acceptance-criteria.md`](v1-acceptance-criteria.md).

## Scope

L7 builds the conductor foundation that hosts live interactive `claude`/`codex` sessions through a
real pty, attaches the co MCP surface per pane, injects actionable mail into that pane, observes turn
end and liveness, and isolates per-pane permission configuration. Spawn-from-placement and mid-turn
operator steering remain later conductor work.

The acceptance model is split:

- `[sandbox]` means the invariant is mechanically checked by the normal repo gate.
- `[host-live]` means the invariant requires a real provider binary and subscription-authenticated
  host environment, so it is discharged by operator review for the dev-to-main PR.

## Criteria

- `AC-L7-1` - Authentic-terminal pty hosting and startup readiness.
  `[sandbox]` The `PtyHost`/`FakePty` contract plus startup classifier/driver reach ready or surface
  login-required over synthesized provider startup fixtures; no headless `-p`/`exec`, tmux, or
  brittle TUI chrome parsing is introduced. `[host-live]` Real Claude and Codex reach an authenticated
  ready prompt in a `node-pty`. Ladders to `SF-1`, `PV-2`; Principle 2.

- `AC-L7-2` - MCP attach and per-pane identity.
  `[sandbox]` `LiveSessionHost` injects the conductor's authoritative session identity into every
  `ToolContext`, never trusting client-supplied identity, and serves the role-scoped co MCP surface.
  `[host-live]` The live provider can list and call a co tool through that attached MCP surface.
  Ladders to `MC-1`, `PV-1`; Principles 4, 13.

- `AC-L7-3` - Mail injection produces exactly one acted-upon turn.
  `[sandbox]` The mail injection protocol drives one actionable mail item into a pane over
  bracketed paste with multi-line content preserved. `[host-live]` One message produces one live turn
  on both providers. Ladders to `SF-3`; Principle 1.

- `AC-L7-4` - Turn-end detection corroborates, but never declares, work completion.
  `[sandbox]` The detector marks a pane idle over working-to-idle traces and does not emit work
  completion; durable completion remains keyed to `co_finish` / worker-done records.
  `[host-live]` The invariant holds for long reasoning, tool chatter, and provider backgrounding.
  Ladders to `SF-1`, `ST-3`; Principle 9.

- `AC-L7-5` - Liveness watchdog triad.
  `[sandbox]` The watchdog classifies pty exit as dead, mid-turn byte silence as wedged, and active
  output as alive, then emits the break signal into the existing monitor seam. `[host-live]` A
  stopped session is classified within the bounded window without misclassifying a legitimate
  long-running turn. Ladders to `ST-2`, `ST-3`; Principle 9.

- `AC-L7-6` - Per-pane permission enforcement is isolated and drift-clean.
  `[sandbox]` Per-pane launch config generation plus `readEnforcedConfig` make
  `checkBlockListDrift` return no drift and avoid user-global config paths. `[host-live]` A blocked
  destructive command fails closed through provider-specific enforcement and is observable to co.
  Ladders to `RG-5`; Principles 6, 9, 12.

- `AC-L7-7` - Durable session record.
  `[sandbox]` A `session.*` event stream records pane, agent, cwd, provider, and resume handle, and
  rebuilds replay-equal. `[host-live]` Provider resume restores context after process death.
  Ladders to `ST-1`, `ST-2`, `SH-1`; Principle 14.

- `AC-L7-8` - The Conductor is never agent-callable.
  `[sandbox]` `buildCoreRegistry` registers zero Conductor, host, steer, pty, or session-control
  tools; no role toolset exposes such a verb. Ladders to `MC-1`; Principle 4.

## Must Not Regress

- A live session that becomes idle without durable completion is surfaced as stuck, not silently
  considered done.
- A wedged live session is classified within a bounded window; it never stalls for hours without a
  visible break signal.
- Provider panes inherit isolated launch config only; user-global hooks, allow rules, and MCP
  servers do not leak into workers.
- Turn-end remains distinct from work-end; only the durable finish path completes work.
