# Stage 15 → v1: the live-run deferral & continuation handoff

> **Tracked, durable handoff.** This doc must survive the `SH-3` prototype-footprint teardown so the
> self-hosting `co` can read it after the prototype is gone. It pairs with the living
> [`v1-acceptance-criteria.md`](v1-acceptance-criteria.md), the live procedure in
> [`sh1-runbook.md`](sh1-runbook.md), and the teardown checklist in [`migration.md`](migration.md).

## Purpose

Stage 15 is the **last prototype `co` implementation session**. It completes the remaining
agent-buildable **in-sandbox** spine and defers the host-only evidence bucket: **the live host-run
against real `claude`/`codex`.** After that live run, the `dev → main` promotion and `SH-3`
prototype-footprint teardown still remain. This document is the bridge across that handoff — so when
Stage 15 lands and the operator runs the live proof, **`co` (self-hosting) can pick up exactly where
the prototype left off**, with no lost context.

The deferral is *intentional and irreducible*: a green `FakePty` sandbox is, by construction, **not**
host-live evidence (Principle 9, Principle 2). Every `[host-live]` item below can only be discharged
by an operator running real provider binaries on a real host.

## 1. What Stage 15 completes IN-SANDBOX (the agent-buildable half)

Built + `FakePty`/vitest-proven, landed on `co/stage-15` → `dev`:

- **Multi-phase autonomous advance** (phase-advance / `co_task_complete`; a ≥2-phase autonomy
  proof). → spine for `SH-1`.
- **Re-warm of recovered agents** on a daemon tick (selection via the single-launch authority). →
  spine for `ST-2`.
- **SH-5 static source guard** — a test that walks product source and fails loud if any un-gated raw
  `git push` / `gh pr create` / `gh pr merge` invocation exists, allow-listing only the sanctioned
  gated chokepoint + the runtime block-list rules. → spine for `SH-5`.
- **SH-4 offline path** — the loop drives on a local-only, no-remote repo (Offline auto-detect,
  push/PR disabled, merge still gated) + the [Offline-mode runbook](offline-runbook.md). → spine for
  `SH-4`.
- **Desktop is the one-stop surface** — app owns/supervises the daemon, repo/directory picker,
  in-app session launch from a predesigned spec; the live terminal fits + renders the raw pty stream;
  mail typing is correct; observe-loop failures surface; typed per-audience mail cards; a read-only
  Source minimum (Branches + local PR refs). → spine for `SF-1/4/5/6`, `ST-3`.
- **Switchable proof harness** (`runProof({fake|claude|codex})` + a reusable `FakeProvider` + a
  "fake ≠ live" provenance guard). → raises `SF-1`/`PV-2` *proof confidence*.
- **v1 scorecard reconciled** — [`v1-acceptance-criteria.md`](v1-acceptance-criteria.md) reflects the
  true `dev` state, with `SH-1` advanced `☐ → ◐`.

> None of the above flips a v1 `☑`. They make the host-live `☑` evidence collectible; promotion and
> teardown remain after the run.

## 2. What is DEFERRED to the live host-run (the operator-gated bucket)

Each row: the v1 `☑` it unlocks · what the live run must show · how to run it · what the sandbox
already proved.

| v1 `☑` | The live proof (operator-only) | Driver / where | Sandbox already proves |
|---|---|---|---|
| **`SH-1`** | The autonomous **multi-phase** change self-drives end to end against real `claude`/`codex` (start → lock → sling → finish → merge → review → PASS → advance → … → land), no ad-hoc operator tool calls. Spec lock now uses the public `co spec lock` CLI (PR #50) — the operator approval gate, not an automation gap — so a clean run can flip `SH-1`. | [`sh1-runbook.md`](sh1-runbook.md) + app on-ramp + §7 PR checklist | `sh1-dry-run` ≥2-phase loop over `FakePty`, zero hand-stitched transitions |
| **`SF-1`** | Real `claude`/`codex` reach an authenticated `ready` prompt in a real node-pty; the in-app terminal is legible at the live geometry (#40 PTY width-agreement). | `co-mcp host-proof claude\|codex`; the app console | FakePty startup classify; xterm FitAddon + raw-stream render |
| **`SF-2`** | A real mid-turn **interrupt actually halts** a live turn (per-provider key verified). | host-proof steer step; app steer controls | byte-written-before-settle (`steerMidTurn`) |
| **`PV-2`** / `PV-1` | Interactive **subscription auth works for BOTH providers**, and both run real worker turns (**Codex parity** — the load-bearing unknown). | `co doctor --live`; host-proof per provider | spawn/transport seam, provider-neutral dispatch |
| **`ST-2`** | Crash/restart **recovery against the real daemon** (host-side handoff); zombies reconciled to WAITING. | host-proof SIGKILL → recover; app-supervised daemon restart | `recoverProjectStore` replay; reconcile loop |
| **`ST-3`** | **Live-stream monitoring** catches a real silent-stop; no silent failures under real traffic. | host-proof; watchdog under live load | watchdog seam-injected silent-stop test |
| **`SH-4`** | `co` operates on **a real stranger repo**, including a **local-only Offline** one (no remote). | app: choose any repo; [Offline runbook](offline-runbook.md) | offline path in `sh1-dry-run` |
| **`SH-5`** | A blocked raw command (`git push` / `gh pr create\|merge`) **fails closed in a real provider pane** (`AC-L7-6 [host-live]`). | [`host-proof.md`](host-proof.md#sh-5-companion-check--blocked-raw-publish-deny) + app pane capture | static source guard + runtime block-list |

**Also deferred (not a `☑`, but host-only):** the **#40 live PTY width-agreement** — the in-app
terminal width and the hosted pty width must agree so cursor-addressed redraws land. The renderer
(FitAddon) half is built; the live handshake is host-side.

## 3. How the operator runs the deferred live host-run

The on-ramp Stage 15 builds makes this **app-first** (the CLI is the power-user path). Spec lock is
the public `co spec lock <taskId>` CLI command (PR #50); an in-app Lock button is a remaining UX
nicety, not a blocker.

1. `pnpm install && pnpm build` (dev install — a packaged installer is the `⊘` post-v1 non-goal).
2. `co doctor --live` → `[ok] provider-compatibility` for both monitored providers (`claude`,
   `codex`).
3. **Open the desktop app** (it owns/supervises the daemon).
4. **Choose a repo/directory** in the app (registers + targets it).
5. **Launch a coordinator from the predesigned spec** in the app; watch it cold-start in the Agents
   Console.
6. Plan-with-operator → operator approves via `co spec lock <taskId>` → **autonomous multi-phase
   drive** → PASS in the Review view → confirm the gated merge.
7. Repeat on a local-only repo (`SH-4`); confirm a blocked raw command fails closed (`SH-5`).
8. Capture any step that still needed a manual tool call, and any Codex-parity gap.

(These steps are also the `co/stage-15` → `dev` PR's §7 checklist, and they elaborate
[`sh1-runbook.md`](sh1-runbook.md).)

## 4. Where `co` (self-hosting) PICKS UP after the live run — the continuation roadmap

Once the live run passes and the operator records evidence:

1. **Flip only the criteria actually discharged by the evidence.** The lock path is now public-CLI
   driven (`co spec lock`, PR #50), so a run whose only operator actions are spec approval and the
   PASS verdict has no ad-hoc operator tool calls — flip `SH-1` to `☑` on such a clean run; otherwise
   keep it `◐` and record the partial host-live evidence. `SH-4` / `SH-5` may be flipped
   independently if their live evidence is complete and linked in
   [`v1-acceptance-criteria.md`](v1-acceptance-criteria.md).
2. **Gated `dev → main` promotion** — a `release/*` → `main` PR through the review gate. Check the
   current delta with `git rev-list --count origin/main..origin/dev`.
3. **`SH-3` prototype-footprint teardown** (the `migration` issue, [`migration.md`](migration.md)) —
   **the first action `co` performs while self-hosting, not the prototype**: `git rm -r .co .claude
   .codex`, remove the prototype-era root docs (`PORTING-CO.md`, `PRINCIPLES.md`, `.goals/`,
   `.research/`), drop the `PROTOTYPE FOOTPRINT` ignore block, strip the prototype sections from
   `AGENTS.md` / `CLAUDE.md`, and archive `v1-acceptance-criteria.md` (reaching the teardown *is*
   `SH-3`).

> The handoff is deliberately ordered so the prototype never `git rm`s itself while still driving.
> `co` continues from this doc + the living `v1-acceptance-criteria.md` + `migration.md`.

## 5. Known host-only risks the continuation must watch (don't assume settled)

- **Codex parity:** `PV-1` / `PV-2` ("both providers run real worker turns") is unproven and
  un-provable in sandbox; the live run may surface real provider-neutrality bugs that *generate new
  agent work*.
- **ST-2 recovered-session handoff:** sandbox currently proves recovery selection and guarded failure,
  not full live re-host. A recovered stale non-root session row must be END/RECONCILE'd before
  re-hosting, and a recovered ROOT-with-session is still a cold candidate rather than automatically
  re-driven. Capture this explicitly during host-live recovery testing.
- **#40's dominant cause is the stream model** (an alternate-screen redraw replayed as append-only)
  plus geometry; the renderer half is built, but the live width-agreement may reveal more.
- **Branch-protection filter-up:** the `dev → main` admin-merge after a CO PASS is operator-gated by
  design.
- **A green sandbox is not evidence** — keep this loud at every step (Principle 9).

## 6. Continuity contract (for the next driver — likely `co` itself)

To pick up, read **(a)** this doc (`docs/v1-handoff.md`); **(b)**
[`v1-acceptance-criteria.md`](v1-acceptance-criteria.md) — the living tracker; start from the first
un-`☑` `§A` item; **(c)** [`sh1-runbook.md`](sh1-runbook.md) — the live procedure; **(d)**
[`migration.md`](migration.md) — the teardown. The Stage-15 PR body's §7 checklist is the immediate
next actions. Nothing the continuation needs is hidden in `.co/` — by `SH-2`, `co` reads its own
program-data, and this handoff plus the `docs/` corpus carry the rest.
