# SH-1 Self-Host Proof Runbook

This document is the operator guide for proving **`SH-1`**: `co` runs a real multi-phase change on
the **`co` repo itself** start to finish (spec-lock → phases → worktrees → review gate → gated
merge) using built `co` / `co-mcp` binaries and no prototype process or prototype state as the
driver. The gated merge is approved through the in-app **Review view**, the Stage 13 deliverable
that surfaces diffs and acceptance criteria for human sign-off.

Everything in this runbook executes on the **operator's host machine** — not in a sandbox. This
runbook builds on and assumes familiarity with [`docs/host-proof.md`](host-proof.md), which covers
the lower-level Conductor plumbing proof (`co doctor --live`, `co-mcp host-proof`). Complete that
proof first if you have not already.

> **Current Stage 15 boundary:** the deterministic dry-run harness in
> `packages/mcp/src/conductor/sh1-dry-run.test.ts` proves orchestration plumbing only. A green dry-run
> is not SH-1 evidence. The desktop app now owns and supervises the Conductor daemon, cold-starts
> registered root coordinators, and drives the live self-drive loop through the app on-ramp; SH-1
> still requires host-live evidence from real provider binaries and the desktop review gate.
> Spec lock is the operator's Mail approval gate: the coordinator sends a keyed spec-lock approval
> request, and the operator approves it in-app. The public `co spec lock <taskId>` CLI remains a
> headless/debug fallback that runs the same core `lockSpec` primitive as the `co_spec_lock` MCP tool.
> Treat any manual tool calls that remain necessary during the host run as evidence to capture, not
> as hidden automation.
>
> **A green `fake` proof is likewise NOT SH-1 evidence.** The unified host-proof driver
> `runProof({fake|claude|codex})` (`packages/mcp/src/conductor/host-proof.ts`) runs the same sequence
> against a `FakePty` (`runProof('fake')`, tagged `fidelity: 'sandbox-fake'`) or a real provider in a
> real pty (`runProof('claude')` / `runProof('codex')`, tagged `fidelity: 'host-live'`). A
> `sandbox-fake` result proves only the harness wiring — never that a real `claude`/`codex` binary
> reached `ready` and routed mail through a real terminal (Principle 2 — authentic-terminal). The
> `assertHostLiveProof(result)` gate throws on anything other than `fidelity: 'host-live'`; any future
> SH-1-evidence recorder MUST call it first, so a sandbox-fake run can never be banked as SH-1
> evidence. See [`host-proof.md`](host-proof.md) for the fidelity tiers and the forward gate.

---

## Prerequisites

1. **Preflight green.** `co doctor --live` passes all four checks, including
   `[ok] provider-compatibility`. See [`host-proof.md`](host-proof.md) for the expected output and
   troubleshooting steps.

2. **Binaries built and shell-invocable.** `co` and `co-mcp` must be built (`pnpm build` in the repo
   root). The operator shell commands below invoke `co` directly; if `co` is not on `$PATH`, use its
   absolute path wherever the runbook says `co`. `CO_CLI_COMMAND` only helps `co-mcp` locate the CLI
   for commands it launches from the daemon.

3. **The `co` repo registered.** `co doctor` should show `[ok] program-data-integrity`. Confirm the
   repo's stable registry id with:

   ```sh
   PROJECT_ID="$(co-mcp project-id)"
   printf '%s\n' "$PROJECT_ID"
   ```

4. **Desktop app built and running with the Reviews view available.** The Review view is required
   for SH-1 evidence because it displays the diff and locked acceptance criteria before verdict
   submission (see Step 3). Build the app (`pnpm build` from the repo root, or the appropriate
   desktop build command for your environment), open it, choose the repo in the in-app project picker,
   and confirm the **Reviews** nav item plus daemon status badge are visible before starting.

5. **Conductor daemon supervised by the app.** Do **not** start `co-mcp serve` by hand for the primary
   SH-1 run. The desktop app owns the daemon lifecycle; use the header badge and **Retry** control if
   it fails to become healthy. Manual `co-mcp serve <projectId>` remains an advanced/headless
   diagnostic path, not the acceptance path.

---

## Step 1 — Draft and lock a small real `co` change

**Role separation:** a **Coordinator** drafts the spec (`co_spec_draft` is a coordinator-only MCP
tool; the operator cannot call it directly). Ask a coordinator agent to draft a small, self-contained
change to the `co` repo — a documentation clarification, a minor fix, or a small enhancement. The
change must be real (it will actually land on the repo via the gated merge), so keep scope minimal.
If you do not already have a coordinator for this run, start one from the desktop Dashboard and
enter a coordinator name first. For the standard proof, click **Start from demo spec**; for a custom
proof, use **Start session** with a small prompt such as "Draft a small doc clarification for co."

Once the coordinator has drafted the spec and sent a spec-lock approval request:

1. Review the spec-lock approval mail. It carries the criteria preview the coordinator is asking you
   to freeze; confirm each acceptance criterion carries a `verify` command.
2. Approve the request in Mail. That approval runs the same core `lockSpec` primitive as
   `co_spec_lock`, including the D3 criteria validator.
3. If you are running headless or debugging without the app, the fallback CLI path is:

   ```sh
   co spec <taskId>          # review the drafted spec content
   co spec lock <taskId>     # fallback operator CLI; same core lockSpec as the app approval bridge
   ```

   A host-live run should prefer the Mail approval path. Once locked, the spec id is fixed — record
   it.

4. Note the **task id**. You will need it in Step 6.

---

## Step 2 — Drive the live loop and capture the gaps

With the daemon running and a locked spec in program-data, drive the same lifecycle the dry-run
harness rehearses, but do it through the built binaries and the real operator/coordinator MCP
surfaces:

1. **Plan phase** — the Coordinator/Lead records the plan from the locked spec.
2. **Worktree phases** — Implementer agents are slung into isolated git worktrees; they build,
   verify, and call `co_finish`.
3. **Review gate** — the Lead triggers `co_merge` for the finished worktree. Include the locked
   spec reference in the merge request (`spec_ref: "spec:<taskId>#locked"`) so the Review view can
   render the acceptance criteria. If no human PASS exists yet, `co_merge` queues a
   **human review request** (`review_request` mail to `@operator`).
4. **Human gate** — a `review_request` lands in your operator inbox and the Review view surfaces
   it. This is Step 3.

If any of these steps require a manual operator/coordinator tool invocation because the live daemon
does not yet select the next transition on its own, record that invocation in the evidence bundle.
Those notes are not failures of the Stage 13 review view, but they are remaining SH-1 automation
work before the acceptance criterion can be marked complete. The operator's spec-lock Mail approval
is the intended human gate, by design, so a run whose only operator actions are spec approval and the
PASS verdict has no ad-hoc-tool-call gap and can flip SH-1.

### Watching progress

Open the **Agents Console** in the desktop app (transcript + roster view) to observe agents as they
run. To read an individual agent's mail stream from the CLI:

```sh
co mail read --recipient <agentId>
```

Replace `<agentId>` with the agent id shown in the roster (e.g. `impl-abc123`). To see the overall
roster, phase, and cost snapshot:

```sh
co status
```

Do not proceed to Step 3 until the Review view shows a pending review for this task's worktree.

---

## Step 3 — Approve at the gate via the Review view

When the gated merge is queued, the **Reviews** view in the desktop app shows the pending review.
Open it to inspect:

- The **unified diff** of the worktree against the integration branch.
- The **acceptance criteria** from the locked spec, listed alongside their `verify` commands.

Review the diff and criteria, then make a decision:

- **PASS** — click **PASS** if the diff satisfies all criteria. The desktop app sends a
  `review_response` through the operator-IPC server, which records the PASS verdict and
  makes the PASS available to the Lead's gated merge.
- **ISSUES** — click **ISSUES**, enter notes describing what needs fixing, and submit. The verdict
  is recorded and the Lead kicks the worktree back to the implementer for another pass.

> **Important:** For SH-1 evidence, submit from the Review view so the captured decision includes
> the rendered diff and locked acceptance criteria. The desktop Mail view only surfaces the
> `review_request` inbox item and routes the operator to Reviews; it cannot record a verdict. There
> is **no CLI path** to submit a verdict.
> `co mail send --type review_response …` is rejected before a mail is stored; the CLI has no verdict
> recording path. Human-review verdicts must be recorded through the operator-IPC server. See [Advanced: observe without the desktop app](#advanced-observe-without-the-desktop-app)
> for CLI observation commands.

---

## Step 4 — Gated merge lands after PASS

When you click PASS in Step 3, the operator-IPC server records the human `review_response` verdict.
The Lead then reruns `co_merge` for the same branch/target; in a fully autonomous run this happens on
the next lead turn, while a manual rehearsal may need an explicit lead/coordinator tool call.

- The worktree is merged into the integration branch.
- The review is recorded with an audit trail.
- No raw `git push` or `gh pr merge` is involved (SH-5).

Watch the **Agents Console** for the merge log line and confirm the integration branch advances.

---

## Step 5 — Verify source hygiene and live-binary evidence

Run the SH-2 source-hygiene guard to confirm no runtime `.co/` dependency remained in the code that
just landed:

```sh
pnpm vitest run packages/core/src/tools/sh2-no-co-read.test.ts
```

This test walks `packages/*/src` and `apps/*/src`, strips comments, and fails loud on any
`.co/(specs|plans|issues)` path literal. Green output means no prototype read-paths are present in
production source for the landed change. It does not prove the live run avoided prototype state or a
prototype process.

If the guard fails, a source file introduced a literal `.co/` path that must be removed before the
proof is valid.

For SH-1 evidence, also capture live-binary proof:

- `pnpm build` output for the exact commit being proven.
- `co-mcp --help` showing the built daemon/session verbs are present.
- Desktop daemon-status and Agents Console evidence for the app-supervised run.
- Process/store evidence showing the run was driven by built `co` / `co-mcp` against program-data,
  not by `.co/` prototype state.

---

## Step 6 — Capture SH-1 evidence

Collect the following artifacts and record them as the evidence bundle for `SH-1`:

| Evidence item | How to capture |
|---|---|
| Locked spec id | Noted in Step 1; also shown by `co spec <taskId>` |
| Phase and worktree trail | Roster screenshot from Agents Console |
| Review view evidence | Screenshot of the Review view before submit, showing the diff, locked criteria, and selected PASS verdict; pair it with the recorded verdict / merge evidence below |
| Gated-merge commit | `git log <integration-branch> --oneline -1` |
| SH-2 guard green | Terminal output from Step 5 |
| Live-binary transcript | Desktop daemon-status / Agents Console transcript plus `co-mcp --help` |
| Prototype-free runtime evidence | Process/store notes from Step 5 |

Only after the live run is end-to-end and the manual-gap notes above are closed should `SH-1` be
marked met in `docs/v1-acceptance-criteria.md`:

```
- `SH-1` ☑ `co` runs a real multi-phase change on the **`co` repo itself** start to finish
  (spec-lock → phases → worktrees → review gate → gated merge) without prototype state/processes.
  Evidence: <link or PR reference>
```

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| "Conductor unavailable" shown in Reviews | The desktop app supervises the daemon — check the **daemon status badge** in the header and click **Retry** if it shows `failed` (no need to run `co-mcp serve` by hand). |
| No agents appear in the Agents Console | Daemon did not tick, the spec is not yet locked, or the next transition still needs an explicit operator/coordinator tool call; run `co status` and `co spec <taskId>` to confirm |
| Reviews view empty / no pending review | The gated merge was not queued yet; confirm or rerun the Lead/coordinator `co_merge` transition for the finished worktree and check the operator inbox for `review_request` |
| "No locked spec" error from coordinator | Check the operator inbox for a spec-lock approval request and approve it in Mail; if you are headless/debugging, fall back to `co spec <taskId>` then `co spec lock <taskId>` |
| SH-2 guard fails | A `.co/` literal was introduced in production source; grep `packages/*/src` for the offending path and remove it |
| Clicking PASS has no effect | The desktop app lost its connection to the daemon it supervises — check the header **daemon status badge**: wait if it shows `restarting`, or click **Retry** if it shows `failed`, then resubmit the verdict |
| Gated merge blocked after PASS | Confirm the `review_response` was recorded, then rerun/resume the Lead's `co_merge` for the same branch/target |

---

## Advanced: observe without the desktop app

You can observe the system state from the CLI, but you **cannot submit a verdict from the CLI**.

```sh
# See the operator inbox (pending review_request mails appear here)
co mail read

# Filter to a specific agent's mail
co mail read --recipient <agentId>

# See the full roster, phase, review, and cost snapshot
co status
```

A pending `review_request` in the inbox means the Review view is waiting for your PASS or ISSUES.
To proceed, open the desktop app — **submitting a verdict requires the Review view**. There is no CLI
verdict-submission path; `co mail send --type review_response …` is rejected before a mail is
stored, and the gated merge will refuse until the operator-IPC Review path records the verdict.

---

*Ladders to: SH-1, SH-5, and via SH-2 the pristine-repo invariant (Principle 12 — `pristine-repo`).*
