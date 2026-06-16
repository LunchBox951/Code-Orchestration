# Alpha Quickstart

A concise walkthrough for running the `co` orchestration loop end-to-end on your own host machine
using built `co` and `co-mcp` binaries. Complete all six steps in order.

> **This quickstart exercises the loop but a green sandbox run is NOT SH-1 acceptance evidence —
> SH-1 ☑ requires the full host run described in [`docs/sh1-runbook.md`](sh1-runbook.md).**

---

## Step 1 — Build

From the repo root:

```sh
pnpm build
```

This builds `co` (CLI), `co-mcp` (Conductor + MCP server), and the desktop app. Ensure both `co`
and `co-mcp` are on your `$PATH`, or use their absolute paths in the steps below.

---

## Step 2 — Auth check

Confirm that your provider credentials are valid and that `co` can reach them:

```sh
co doctor --live
```

Expected: every check shows `[ok]`, including `[ok] provider-compatibility`. If any check fails,
resolve it before continuing — the Conductor will not drive turns without a healthy provider.

---

## Step 3 — Find (and register) the project id

Register this repo in the `co` project registry and print its stable projectId:

```sh
co-mcp project-id
```

Or, to register a repo at a specific path:

```sh
co-mcp project-id /path/to/repo
```

The command is idempotent — re-running on an already-registered repo returns the same id. Copy the
printed id; you will pass it to the next two steps.

You can also capture it inline:

```sh
PROJECT_ID="$(co-mcp project-id)"
```

---

## Step 4 — Start the daemon

Start the Conductor daemon for this project:

```sh
co-mcp serve <projectId>
```

The daemon ticks on a fixed cadence, cold-starts any newly registered coordinator sessions, and
drives each agent's turns. Keep this process running in a dedicated terminal for the duration of
the session. Tick output is printed to stderr.

---

## Step 5 — Start a coordinator session

**Option A — CLI:**

```sh
co-mcp start-session <projectId> --prompt "Draft a small doc clarification for co."
```

Or, if you have a pre-written draft spec file:

```sh
co-mcp start-session <projectId> --spec /path/to/draft-spec.md
```

Exactly one of `--prompt` / `--spec` is required; both or neither fails loud.

**Option B — Desktop app:**

Launch the app with `CO_PROJECT_ID=<projectId>` in its environment, navigate to the **"Start a
coordinator session"** form, enter a prompt, and click **"Start session"**. Use the CLI option above
when starting from a pre-written draft spec file.

The command registers the root coordinator in the roster and provisions its worktree. The daemon
(Step 4) cold-starts it on the next tick and drives its first turn.

---

## Step 6 — Observe and steer

Use the desktop app to monitor the session:

- **Agents view** — shows all running agents with live status. Use the per-agent **"Stop"** and
  **"Unstick"** buttons if an agent hangs or needs recovery.
- **Review view** — when an agent requests a human review, its diff and acceptance criteria appear
  here. Click **PASS** to approve; the gated merge lands on the integration branch.

You can also read your inbox from the CLI:

```sh
co mail read
```

And observe the roster, plans, and cost rollups:

```sh
co status
```

---

## Operator-gating PR checklist

See the section below and [`docs/sh1-runbook.md`](sh1-runbook.md) for the full host-live SH-1
proof. The checklist below is a summary gate for the `co/stage-14 → dev` merge:

```
Operator host-live acceptance (run before merging):
[ ] Build: `pnpm build` succeeds for co, co-mcp, and the desktop app.
[ ] Auth: `co doctor --live` → [ok] provider-compatibility for the provider(s) you'll use.
[ ] Find project id: `co-mcp project-id` prints the registered projectId for this repo.
[ ] Start the daemon: `co-mcp serve <projectId>` ticks without error.
[ ] Start a coordinator session: `co-mcp start-session <projectId> --prompt "…"` OR the app "Start session" button, with a small prompt. Use CLI `--spec` for a draft spec.
[ ] Plan-with-operator: the coordinator mails you a clarify/brainstorm; you answer; it drafts a spec.
[ ] Lock: you `co_spec_lock` the agreed spec.
[ ] Autonomous drive: WITHOUT manual tool calls, co spawns lead/implementer, runs turns, and a review_request lands in your inbox / the Reviews view.
[ ] Approve: click PASS in the Review view; confirm the gated merge lands on the integration branch.
[ ] Capture: note any step that still needed a manual tool call (remaining SH-1 automation), per docs/sh1-runbook.md Step 6.
[ ] Sign-off: if the loop self-drove end-to-end (modulo noted gaps), approve the merge.
```

**A green sandbox build is not SH-1 evidence — SH-1 ☑ requires the host run (see
[`docs/sh1-runbook.md`](sh1-runbook.md)).**
