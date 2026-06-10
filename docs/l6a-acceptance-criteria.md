# L6a Acceptance Criteria

L6a is the role and permission hardening slice that supports the v1 role, review-gate, and
single-surface criteria. These IDs are cited in code/tests as local implementation criteria; each
ladder points back to the project-wide v1 acceptance criteria.

- `AC-L6a-1` — Durable roster projection: agent role + parent records are event-sourced,
  replay-equal, and stored only in program-data. Ladders to `RL-1`, `ST-1`, `WT-3`.
- `AC-L6a-2` — Sub-roles are narrow-only specializations of a base role; they cannot widen
  permissions. Ladders to `RL-2`.
- `AC-L6a-3` — Spawn rules reject illegal parent-to-child role edges with named violations.
  Ladders to `RL-1`, `RL-2`.
- `AC-L6a-4` — Escalation authority is role-based and routes through the recorded parent chain,
  with coordinator-to-operator handled structurally. Ladders to `RL-1`, `RL-3`, `ST-1`.
- `AC-L6a-5` — `co_kickback` is available only to coordinator/lead, routes to direct code-owning
  children, consumes review strikes idempotently, and escalates at the review budget. Ladders to
  `RL-3`, `RG-1`, `RG-2`, `RG-4`.
- `AC-L6a-6` — The non-destructive hard block-list is declared in core, test-covered, and limited
  to destructive/bypass/single-surface boundaries. Ladders to `RG-5`, `MC-1`.
- `AC-L6a-7` — Publish identity checks always reject unsigned commits, reject off-persona commits
  when a persona allowlist is configured, and worktree git identity is pinned to the configured
  persona. Ladders to `RG-1`, `MC-1`.
- `AC-L6a-8` — Role/tool/profile completeness checks prevent drift when tools or roles change.
  Ladders to `RL-1`, `MC-1`, `MC-2`.
- `AC-L6a-9` — Permission helpers remain pure or seam-injected so tests do not need live providers,
  network, or repo writes outside sanctioned git operations. Ladders to `ST-1`, `MC-2`.
- `AC-L6a-10` — Role and permission program-data writes preserve the pristine-repo invariant; git
  worktree administration is explicit and tested when required. Ladders to `ST-1`, `WT-3`, `MC-2`.
