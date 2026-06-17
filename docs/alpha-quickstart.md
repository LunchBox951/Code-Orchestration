# Alpha Quickstart

Get the `co` orchestration loop running on your machine using the desktop app. The primary flow is
app-first, with one temporary host-live gap: locking a drafted spec still requires the operator-only
MCP `co_spec_lock` path until the app exposes that control.

> **A green sandbox run is NOT SH-1 acceptance evidence — SH-1 ☑ requires the full host run
> described in [`docs/sh1-runbook.md`](sh1-runbook.md).**

---

## Primary flow — desktop app first

### Step 1 — Build the app

From a fresh checkout, run `pnpm install && pnpm build`, then start the desktop app from the built
desktop package. A polished installer is post-v1; the app still manages `co-mcp` and the Conductor
daemon for you — you do not need to start it manually.

### Step 2 — Open your project

Click the **Open project** control in the top bar. Select the root directory of the repository you
want to orchestrate. The app registers the project; re-opening the same directory reuses its id.

Once a project is open the **daemon status indicator** in the status bar shows the Conductor health:
`starting → healthy` (or `restarting` / `failed` if something went wrong). Wait for `healthy` before
starting a session.

### Step 3 — Start a coordinator session

Navigate to the **Dashboard** view in the left-hand nav (`Dashboard / Agents / Mail / Review /
Source / Cost`).

The Dashboard shows a **"Start a coordinator session"** form. You have two options:

- **"Start from demo spec"** — launches the predesigned on-ramp coordinator using the bundled
  `docs/demo-spec-co-improves-its-docs.md` spec. Recommended for your first session.
- **"Start session"** — type (or paste) a free-form prompt and click **Start session** to launch a
  coordinator from scratch.

The coordinator is registered and the daemon cold-starts it on the next tick.

### Step 4 — Watch and steer in-app

Use the left-nav views to monitor the running session:

| View | What you see |
|---|---|
| **Dashboard** | Session status, daemon health, quick-start controls |
| **Agents** | All running agents with live status; per-agent **Stop** and **Unstick** controls |
| **Mail** | Your operator inbox — coordinators mail you for clarification and approvals |
| **Review** | Pending review requests: diff + acceptance criteria → click **PASS** or **ISSUES** |
| **Source** | Read-only **Branches** list showing active worktree branches (PRs: deferred) |
| **Cost** | Cumulative token spend and per-session cost rollup |

When the coordinator mails you a clarification or brainstorm request it lands in **Mail** — reply
there. When a worker finishes and requests a review it appears in **Review** — read the diff and
acceptance criteria, then click **PASS** to approve or **ISSUES** to kick back with notes. A PASS
triggers the gated merge onto the integration branch.

---

## Power-user tooling — CLI

The commands below are for operators who want scripted control, CI integration, need to debug
without the app, or need to bridge the temporary `co_spec_lock` app-surface gap. The app handles the
daemon, session launch, mail, review, and live monitoring in the primary flow.

### Auth check

```sh
co doctor --live
```

Confirms that your provider credentials are valid and that `co` can reach them. Every check must
show `[ok]`, including `[ok] provider-compatibility`, before the Conductor can drive turns.

### Project registration

```sh
co-mcp project-id                  # register this repo, print its projectId
co-mcp project-id /path/to/repo    # register a specific path
```

The command is idempotent — re-running on an already-registered repo returns the same id. Capture
inline:

```sh
PROJECT_ID="$(co-mcp project-id)"
```

### Start the daemon manually

```sh
co-mcp serve <projectId>
```

Starts the Conductor daemon for the given project. The daemon ticks on a fixed cadence, cold-starts
newly registered coordinator sessions, and drives each agent's turns. Keep this process running in a
dedicated terminal for the duration of the session. Tick output is printed to stderr.

The app starts and supervises this daemon for you in the primary flow — only run it manually if you
are operating headlessly.

### Start a coordinator session from the CLI

```sh
co-mcp start-session <projectId> --prompt "Draft a small doc clarification."
co-mcp start-session <projectId> --spec /path/to/draft-spec.md
```

Exactly one of `--prompt` / `--spec` is required; both or neither fails loud.

### Read your inbox and check status

```sh
co mail read        # operator inbox
co status           # roster, plans, cost rollup
```

---

## Operator-gating acceptance checklist

Run this before approving a merge from a sandbox to the integration line. This checklist is a
summary gate; the full host-live SH-1 proof lives in [`docs/sh1-runbook.md`](sh1-runbook.md).

```
Operator host-live acceptance (run before merging):
[ ] App healthy: daemon status indicator shows "healthy" for the project.
[ ] Auth: co doctor --live → [ok] provider-compatibility for the provider(s) you will use.
[ ] Session started: used "Start from demo spec" or "Start session" in the Dashboard.
[ ] Plan-with-operator: the coordinator mails a clarify/brainstorm; you reply in-app; it drafts a spec.
[ ] Lock: you approve the spec with the operator-only `co_spec_lock` path; agents cannot lock it.
    Until the app exposes spec lock, record this as a remaining host-live automation gap.
[ ] Autonomous drive: WITHOUT manual tool calls, co spawns lead/implementer, runs turns, and a
    review_request lands in the Review view.
[ ] Approve: click PASS in the Review view; confirm the gated merge lands on the integration branch.
[ ] Source: the Branches view reflects the new/merged worktree branch.
[ ] Capture: note any step that still needed a manual tool call, per docs/sh1-runbook.md Step 6.
[ ] Sign-off: approve the merge only if the loop self-drove end-to-end with no manual tool calls
    after spec lock; otherwise record the run as evidence with remaining SH-1 automation gaps.
```

**A green sandbox build is not SH-1 evidence — SH-1 ☑ requires the host run (see
[`docs/sh1-runbook.md`](sh1-runbook.md)).**
