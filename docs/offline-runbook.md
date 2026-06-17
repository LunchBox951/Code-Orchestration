# Offline-mode runbook

This document is the operator guide for running `co` on a **local-only repository with no remote** —
**Offline mode**, one of the three repository-relationship modes (`docs/architecture/worktrees.md`
§"Repository-relationship modes"). It ladders to **`SH-4`**: `co` operates on at least one stranger
repo, *including a local-only (Offline-mode) repo with no remote* — proving GitHub is never a hard
dependency (Principle 5 — `self-describing`).

> **What the sandbox already proves vs. what this runbook is for.** The
> `packages/mcp/src/conductor/sh1-dry-run.test.ts` harness drives the full self-host loop on a
> **no-remote** repo and asserts the Offline contract deterministically: Offline auto-detect, push/PR
> disabled, merge still gated. That is in-sandbox `FakePty` evidence — **not** host-live evidence
> (Principle 9). This runbook is the **operator procedure** for the real local-only host-run that
> discharges the `SH-4` `☑`. See [`v1-handoff.md`](v1-handoff.md) for the full deferral catalogue.

---

## What Offline mode is

| | Push to remote | Open a PR | Local merge | Review gate |
|---|---|---|---|---|
| **Offline** | **disabled** | **disabled** | `co_merge` lands locally | **applies** (PASS required) |

Offline mode reshapes only the **publishing surface**: there is nowhere to push and no PR to open, so
both are refused. Everything else is unchanged — **the review gate applies in all three modes**
(Principle 7 — `gated-by-default`). A reviewed branch still lands only through the gated `co_merge`
after a recorded PASS; the merge is simply a **local** `--no-ff` merge into the integration branch
rather than a push or PR.

## How Offline mode is detected

Detection is a pure function of read-only signals (`detectRepoMode` in
`packages/core/src/worktrees/repo-mode.ts`), in this order:

1. **no reachable remote → `offline`** ← the Offline trigger
2. fork of a different owner → `contributor`
3. push access to `origin` → `owner`
4. else → `contributor`

The probe is read-only and writes nothing into the repo (Principle 12 — `pristine-repo`): a
remote-less repo's `git ls-remote origin` fails fast (no network), so `hasRemote` is `false` and the
repo resolves to `offline`. No `gh` call is made when there is no remote.

### Pinning the mode explicitly

To force Offline mode even where a remote exists (e.g. an air-gapped run against a clone), set the
per-project `repo.mode` override in the config cascade (program-data — never a repo write):

```
repo.mode = offline
```

The override **beats detection** and persists per project. A malformed value fails loud (a typo can
never silently re-enable publishing).

## What is disabled, and how it fails

In Offline mode the capability lookup is `{ push: false, pr: false }`, and the enactment gate refuses
**loud** rather than silently no-op'ing (Principle 9 — no silent failures):

- `co_push` → refused: "push capability is false in offline mode."
- `co_pr_merge` → refused: "PR capability is false in offline mode."

If you need to publish, switch the project to `owner` or `contributor` mode (which requires a
reachable remote you can push to).

## Operator procedure — run `co` on a local-only repo

The app-driven on-ramp makes this the same flow as any other run (the CLI is the power-user path):

1. `pnpm install && pnpm build`.
2. `co doctor --live` → confirm `[ok] provider-compatibility` for the provider(s) you will use.
3. **Open the desktop app** (it owns/supervises the daemon).
4. **Choose the local-only repo/directory** in the app. With no remote, it registers and resolves to
   **Offline** automatically. The current desktop surface does not yet render the repo mode directly;
   confirm with `co status`.
5. **Launch a coordinator from a predesigned spec**; watch it cold-start in the Agents Console.
6. Plan-with-operator → `/lock` → autonomous drive → **PASS in the Review view** → confirm the gated
   **local** merge lands on the integration branch.
7. Confirm the publishing surface is genuinely closed: attempt a `co_push` / `co_pr_merge` and verify
   each **fails loud** (not a silent no-op).

## Capture `SH-4` evidence

| Evidence item | How to capture |
|---|---|
| Offline auto-detect | `co status` shows the project in Offline mode for the no-remote repo |
| Push/PR disabled | `co_push` / `co_pr_merge` each refuse loud with the Offline reason |
| Gated local merge landed | `git log <integration-branch> --oneline -1` after a Review-view PASS |
| Prototype-free runtime | the run was driven by built `co` / `co-mcp` against program-data, not `.co/` state |

Only after a real local-only host-run is end-to-end (and, for the broader `SH-4` bar, at least one
stranger repo) should `SH-4` be marked `☑` in [`v1-acceptance-criteria.md`](v1-acceptance-criteria.md),
linking the captured evidence.

---

*Ladders to: `SH-4` (and via the review gate, `RG-1`). See
[`v1-acceptance-criteria.md`](v1-acceptance-criteria.md), [`v1-handoff.md`](v1-handoff.md),
[`sh1-runbook.md`](sh1-runbook.md), and `docs/architecture/worktrees.md` §"Repository-relationship
modes".*
