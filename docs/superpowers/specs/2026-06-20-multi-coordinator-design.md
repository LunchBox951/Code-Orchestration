# Multi-coordinator concurrency, cascade delete, and re-wake — design

- **Date:** 2026-06-20
- **Status:** Implemented in PR 55
- **Branch:** `co/multi-coordinator`
- **Ladders up to:** `SH-1` (the operator drives a real multi-phase change start-to-finish on the
  `co` repo), `SF-5` (desktop operator surface), `WT-1` / `WT-3` (isolated worktrees and
  program-data state), `ST-1` / `ST-2` / `ST-3` (evented, recoverable, fail-loud state), and `MC-2`
  (core source of truth with thin adapters). The operator cannot run *concurrent* real changes, nor
  cleanly retire a finished one, without these capabilities.

## 1. Problem

Two operator-reported failures, one shared root cause.

**The trap (no way to start a second/new coordinator).** The desktop "Start a coordinator session"
composer renders **only** when `phase === 'opened'`, and `opened` requires `total === 0`
(`apps/desktop/src/renderer/renderer.ts:207-220,683-691`). `total` is the daemon's roster count —
every registered, not-removed agent, including a *finished / `unknown`* coordinator
(`packages/core/src/doctor/observability.ts` → `selectAllAgents`; `dashboard-vm.ts:128`). The moment
any agent exists, the phase flips to `coord`/`fleet` and the composer's HTML is wiped. "Hide" /
"Clear finished" is a localStorage **view filter** (`dismissedAgents`, `renderer.ts:117-175`) that
never touches the roster, so it cannot drive `total` back to 0. **Once one coordinator exists, there
is no in-app path to start another.**

**Issue 54 (the scary Stop + irreversibility).** The root coordinator id is **deterministic and
singular per project**: `coord-root-<sha256(projectId)[0..8]>`
(`packages/core/src/session/start-coordinator-session.ts:94-97`). Stopping it when it has no warm
pane is harmless and *recorded*, but the diagnostic is **misrouted** through the daemon's tick-error
logger, so it prints as `[co-mcp serve] tick error: …` (`host.ts:490-494` → `711`) — it looks like a
crash. Worse, **Stop is irreversible**: the router's `stopped` set is never cleared (no un-stop
verb), and it deletes nothing — the roster row, worktree, branch, session, and mail all persist.

**Shared root cause.** Because the root id is a project constant, only one root can exist, and
`startSession` is not idempotent — a second call re-runs `git worktree add` on the existing branch
and **fails loud** (`start-coordinator-session.ts:131-151`, `worktrees/sling.ts:172`). The product
needs (a) **many** concurrent coordinators and (b) a real way to **delete** a finished one
(cascading to its children). Neither exists today: `roster.removeAgent` is leaf-only and unexposed
over IPC (`roles/roster-store.ts:73-89`, `roster-projector.ts:129-146`); the operator-IPC contract
has **no** delete / wake verb (`operator-ipc/contract.ts:27-69`).

## 2. Goals / non-goals

**Goals**
1. **Multiple concurrent, operator-named coordinators** per project, each with its own
   worktree/branch/fleet, running in parallel.
2. **Cascade delete** of a coordinator (and its whole subtree) when done — force-stop, tear down,
   archive any **unmerged** branch with a 14-day expiry.
3. **Re-wake / assign-task** — revive a stopped/idle/finished agent with new instructions (the
   PR-review-fix loop), which also makes **Stop reversible**.
4. **De-scarify** the issue-54 unhosted-Stop diagnostic; keep a Stop button for rogue agents.
5. Additive UI only — the fleet view stays; we add grouping + controls.

**Non-goals (v1 of this work)**
- Warm-pane **conversation** continuity across re-wake (a re-woken agent re-reads its own
  worktree/diff in a fresh session; literal mid-thought resume stays deferred — see
  `start-coordinator-session.ts:22-24`).
- A configurable archive-expiry **setting** (hardcode 14 days; **TODO** to surface in settings).
- Migration / back-compat for existing state — the operator wants a clean slate (see §8).
- Cost/placement history cleanup on delete — **retained** for audit.

## 3. §1 — Multi-root coordinators & identity

Decouple "a coordinator" from the single deterministic id; let a project hold N concurrent named
roots.

**Identity.** Each coordinator's id is `coord-<slug(name)>-<6-hex>`, e.g.
`coord-auth-refactor-9f3a1c`. The 6-hex is a **unique per-spawn** suffix, so **duplicate names are
fine** (two `auth-refactor`s get different suffixes); there is no duplicate-name rejection. The
branch (`co/<id>`) and program-data worktree path derive from the id exactly as today.

**Where the suffix is minted (determinism preserved).** The unique suffix is generated at the
**adapter boundary** — the daemon's `startSession` IPC handler (`packages/mcp`) — not inside the
pure core primitive. `startCoordinatorSession` already accepts an explicit `coordinatorId` seam
(`start-coordinator-session.ts:66`, today "mainly for tests"); production now passes the full minted
id through it, tests pass a fixed id. The core stays deterministic and replay-stable; entropy lives
only in the effectful adapter (consistent with core=pure / adapters=effectful). The handler
re-rolls on the astronomically-rare roster id collision and fails loud after a few tries.

**`startSession` gains a required `name`** alongside the existing exactly-one-of `prompt`/`specBody`
(`operator-ipc/contract.ts:120`). The desktop composer collects `{ name, prompt | demo-spec }`.

**Daemon needs no rearchitecting.** `discoverColdStartRoots` iterates *registered root coordinators
with a live provisioned worktree* — it is not keyed to one id, so N roots cold-start and run in
parallel unchanged (re-confirm the exact loop at `conductor/daemon.ts` during implementation).

## 4. §2 — Cascade delete + archive

**New operator-IPC verb** `deleteAgent(agentId)` (core contract → server handler → core primitive →
`ipcMain` → preload → button). Removes the **subtree rooted at `agentId`**; used on a coordinator to
wipe a whole mission, general enough for any node. Operator-only; fails loud when the Conductor is
down (control-verb semantics, `operator-ipc/client.ts:529-549`).

**The cascade (daemon-side, leaf-first — the roster refuses to orphan a parent,
`roster-projector.ts:139-144`):**
1. Resolve the subtree from the roster (coordinator + all descendants); order **bottom-up**.
2. **Force-stop** every hosted pane via `engine.release` (kills pane + tears down session/MCP). The
   unhosted case is a clean no-op — this is also what makes "delete a finished `unknown`
   coordinator" Just Work, sidestepping issue 54's Stop path entirely.
3. **Per agent, leaf-first:**
   - end its session if active (`session-store.endSession`);
   - check branch merge state vs its base:
     - **merged** → `git worktree remove` + `git branch -d`, append `worktree.removed`;
     - **unmerged** → **archive**: if the worktree is **dirty**, commit the uncommitted work to the
       branch first (a `co: archive snapshot` commit) so nothing is lost; then remove the worktree
       dir (free disk) but **keep the branch ref** (commits stay safe in git), and write an archive
       record `{ id, name, branch, baseRef, deletedAt, expiresAt = deletedAt + 14d }` to a new
       program-data archive store;
   - resolve/retract the agent's outstanding mail (so the daemon never wakes a deleted recipient);
   - clear the router `paused`/`stuck`/`stopped` flags for the id (no stale skip on a reused id);
   - remove the roster row (`agent.removed`) — **`total` drops** and the fleet reflects reality.
4. **Partial failure is loud:** reuse the existing rollback aggregation (`AggregateError`,
   `live-session-host.ts:261-268`) — a busy `git worktree remove` or failed step is surfaced, never
   silently skipped; a row is not removed until its teardown succeeded.

**Archive store + reaper.** A small program-data store (Principle 12 — never in the target repo;
branch refs live in normal git, which is not an orchestration write). A cheap, throttled sweep on
the daemon tick purges records past `expiresAt` (`git branch -D`). **Purge** = now; **Restore** =
cancel expiry so the branch reverts to an ordinary branch a fresh coordinator can build from.

**Cost/placement** rows (append-only, no removal event) are **retained** after delete for audit; the
only visible residue is a deleted agent appearing in a cost breakdown (accepted).

## 5. §3 — Re-wake / assign-task

**New operator-IPC verb** `rewake(agentId, message)`, composing two load-bearing steps:
1. **Commit the actionable mail before clearing skip flags**: seed a `clarify_request` from
   `@operator` carrying `message` — reusing the existing `operatorMessage` seeding (the only mail
   kind that drives a turn, `engine.ts:282`). If the mail write fails, suppression remains in place
   and the operator gets a loud failure instead of waking an agent with no follow-up work.
2. **Clear the agent's skip flags** (`stopped`/`paused`/`stuck`) in the router after the mail commit
   — the missing "un-stop", which makes **Stop reversible**: a halted/finished agent becomes
   selectable again with concrete queued work.

The daemon then re-cold-starts the agent (its worktree still exists) → a fresh session **in its own
worktree/branch** → drives a turn with the feedback. This is the PR-review-fix loop: review raises
issues → **Re-wake the agent that did the work** → it re-reads its diff and fixes. Works on a
coordinator (follow-up direction) or a worker. Closes issue 54's "re-woken should be able to be
awakened" and the irreversible-Stop gap together. Code/worktree context returns; warm-pane
conversation continuity stays deferred (§2 non-goals).

## 6. §4 — UI (additive; fleet view kept)

- **"+ New coordinator"** at the top of the fleet panel, available whenever the daemon is live.
  Opens the existing kickoff composer, now with a **Name** field + prompt/demo-spec. The
  `phase === 'opened'` gate on the composer is removed; the empty/offline heroes stay for genuinely
  empty/disconnected states.
- **Subtree grouping:** each root coordinator + its descendants render as one **bounded block**
  (coordinator as header, children nested) so concurrent missions are visually separated.
- **Per-coordinator Delete** on the block header → an **in-app confirm** (not `window.confirm`)
  showing what is torn down vs. archived → cascade.
- **Per-agent controls** by status: **Stop** (halt; de-scarified), **Re-wake** (opens a small
  feedback/task composer; offered for idle/stopped/finished agents).
- **Archived** collapsible section below the fleet: `name · branch · expires in N days`, with
  **Restore** / **Purge**.

The de-scarify fix itself: route the unhosted-stop diagnostic off `opts.onError` (the tick-error
logger) to a benign, clearly-labelled control log, so a routine Stop never reads as a daemon crash
(`host.ts:490-494`).

## 7. Local acceptance criteria ladder

The implementation plan's local task labels are acceptance handles for this spec. They are local,
but they still ladder to the project-wide v1 criteria in
[`docs/v1-acceptance-criteria.md`](../../v1-acceptance-criteria.md):

| Local label | Acceptance surface | v1 ladder |
|---|---|---|
| `A1` | Roster records carry the operator-visible coordinator name. | `SH-1`, `SF-5`, `ST-1`, `MC-2` |
| `A2` | Start-session records and coordinator ids preserve the name/id relation deterministically. | `SH-1`, `WT-1`, `ST-1`, `MC-2` |
| `A3` | Archive records are event-sourced, replayable, and queryable for expiry. | `SH-2`, `WT-3`, `ST-1`, `ST-2` |
| `A4` | Subtree traversal and branch-state probes are deterministic core helpers. | `WT-1`, `WT-3`, `ST-2`, `MC-2` |
| `A5` | Cascade delete tears down leaf-first, archives unmerged work, cleans safe mail, and fails before destructive side effects when review mail blocks cleanup. | `SH-1`, `WT-1`, `ST-2`, `ST-3`, `MC-2` |
| `A6` | Archive reaping purges only expired archived branches and keeps records retryable on failure. | `SH-2`, `WT-3`, `ST-2`, `ST-3` |
| `B1` | Router suppression can be cleared for a specific agent id. | `SH-1`, `ST-2`, `ST-3` |
| `B2` | Routine unhosted Stop diagnostics are visible without masquerading as daemon tick crashes. | `ST-3`, `SF-5` |
| `B3` | `control.deleteAgent` composes suppression, pane release, core teardown, archive reaping, and retry-safe failure semantics. | `SH-1`, `WT-1`, `ST-2`, `ST-3`, `MC-2` |
| `B4` | Operator IPC exposes named `startSession`, `deleteAgent`, and `rewake` without adding agent-facing tools. | `SH-1`, `SF-5`, `ST-3`, `MC-2` |
| `B5` | Operator IPC lists/restores/purges archived branches, with reads available from program data when the daemon is down. | `SH-2`, `SF-5`, `WT-3`, `ST-2`, `ST-3` |
| `C1` | Desktop session launch is always available when the daemon is live and requires a name. | `SH-1`, `SF-5` |
| `C2` | Desktop groups concurrent coordinator subtrees so missions remain visually separable. | `SH-1`, `SF-5` |
| `C3` | Desktop Delete is a two-step, accessible, destructive confirmation for a coordinator subtree. | `SH-1`, `SF-5`, `WT-1`, `ST-3` |
| `C4` | Desktop Re-wake lets the operator give follow-up work to an idle/stopped/finished agent. | `SH-1`, `SF-5`, `ST-2`, `ST-3` |
| `C5` | Desktop Archived section shows preserved unmerged branches and supports Restore/Purge without stale refresh regressions. | `SH-2`, `SF-5`, `WT-3`, `ST-2`, `ST-3` |

## 8. §5 — Testing (TDD; meaningful tests only)

Behavior / invariants / failure modes that would catch real regressions — not coverage padding.
All five gates green (`test`, `lint`, `typecheck`, `build`, `format:check`).

- **core:** id minting via the injected suffix seam stays deterministic; cascade-delete composition
  — **leaf-first ordering**, merged→branch-delete vs unmerged→archive, mail resolve, flag-clear,
  and **`AggregateError` on partial failure**; archive store + **reaper expiry boundary**; `rewake`
  = clear-flags **and** actionable-seed (assert a stopped agent becomes selectable).
- **mcp:** contract/server dispatch for `deleteAgent` and `rewake`; the de-scarified unhosted-stop
  routing **no longer rides the tick-error path** (assert the destination, not just absence).
- **desktop:** vm/render tests for the always-on composer (+name), subtree grouping, the
  Delete/Re-wake/Stop controls by status, and Archived rendering.

## 9. Clean-slate ("fresh install")

The operator wants the next desktop session to start empty (no migration). The stale `coord-root-…`
lives in:
- `~/.local/share/co/` — program-data root: registry (`global.db`) + per-project stores (roster,
  sessions, mail, dispatch) + `worktrees/<branch>` sandboxes (`store/paths.ts:13-53`);
- leftover `co/coord-*` git branches/worktrees in the repo;
- the desktop's `co.dismissedAgents` localStorage (Electron userData).

This wipe is performed as an **explicit, confirmed** step at implementation time (show contents
first; delete nothing without a go-ahead). It is not part of the shipped code.

## 10. Constraints honored

- **Principle 12 (pristine-repo):** archive store + all records in program-data; git/fs teardown is
  cleanup, only the event append is an orchestration write.
- **Principle 9 (fail-loud):** delete surfaces partial failure (`AggregateError`); duplicate id
  re-roll fails loud after retries.
- **Determinism:** unique-id entropy lives in the adapter; the core primitive stays replay-stable
  via the `coordinatorId` seam.
- **Single launch authority (MNR-5):** only `engine.ensureHosted` spawns/hosts; delete/rewake reuse
  the engine's release/cold-start, adding no second launch path.
- **`@co/core` is the single source of truth:** new verbs/primitives land in core; `cli`/`mcp`/
  desktop stay thin adapters. ESM/NodeNext, strict TS, Conventional Commits + DCO sign-off.
