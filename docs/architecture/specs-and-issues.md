# Specs, Issues & the Decision Ledger

### Specs — durable records in program-data

A **spec** is the operator-locked source of truth for a *task*: the Coordinator drafts it
(shaping operator intent), and the **operator locks it** — the spec-approval gate (no agent
can lock a spec). What changes from the prototype: the spec is a **durable first-class
record in program-data**, not an ephemeral file in the repo's `.co/` deleted on merge. The
"git history *is* the spec record" policy retires — specs persist in program-data
(queryable, survive merges and repo operations, available for replay/audit).

*(Spec lifecycle — draft → locked → archived — and standing-orders carry from the prototype
but are re-examined when we detail the Phases / brainstorm flow.)*

### Issues — bottom-up agent friction (a self-improvement engine)

Where a spec is **top-down** (operator intent flowing down), an **issue is bottom-up**: an
agent reporting **friction it hit while working**, flowing up as signal. This is a different
thing from the prototype's repo-stored "issues as mini-specs," and going public is what
changes it.

**The keystone justification:** the operator never touches the MCP surface, so they can
*never witness it misbehaving* — only agents can. Agent-sourced telemetry is therefore the
**only** channel through which `co`'s own tooling bugs can surface. (A direct consequence of
the [Vision](../vision.md)'s two asymmetric surfaces.)

**Two friction types → two destinations** (one mechanism):
- **Friction with the target code** (a real bug in the repo being worked on) → that repo's
  issues.
- **Friction with `co` itself** (the tooling misbehaved) → the `co` project, to improve the
  orchestrator.

**The pipeline:** `detect → diagnose → dedup → file → (optionally) self-assign & fix`

1. **Detect.** An agent hits friction (e.g. a lead notices its implementer silently stopped
   without notifying it — a `co` orchestration bug).
2. **Diagnose.** It dispatches a **`researcher:diagnostic`** (see [AGENT-ROLES](agent-roles.md)) that
   investigates the relevant source — for a `co` bug, `co`'s *public* repo — and produces a
   **probable-cause report**, not just a symptom. Working from `co`'s behavior + `co`'s
   source (deliberately *not* the user's project internals) is what keeps the report
   scrubbable.
3. **Dedup.** Search existing issues; file only if no relevant one exists (else
   attach/comment).
4. **File — with per-post approval.** A **direct GitHub issue** on the target repo, under the
   **operator's own GitHub identity**. Opt-in enables the *pipeline*; each public filing
   still gets a **per-post approval** — the agent sends an **approval-request mail** to the
   operator (a dedicated mail type), surfaced in the desktop app, and nothing posts until the
   operator approves. Posting publicly under your identity is exactly the kind of outward
   action that warrants a glance, and the app makes that glance cheap. (Scrubbing still
   matters; the human approval is the real backstop.)
5. **Self-assign & fix** *(opt-in, owner-only, gated)* — for a repo you own (the co-on-co
   dogfooding case being the prime example), a filed issue can be self-assigned, turned into
   a task, and fixed through the normal pipeline (`implementer:test` → gate → merge). The
   self-healing loop.

**Layered opt-in** (each more invasive, each its own switch, all off by default): capture
(local) → publish (GitHub) → self-assign / auto-fix.

> Relationship modes (owner/contributor/offline) gate *where* issues may be filed — see
> [WORKTREES](worktrees.md). The `researcher:diagnostic` sub-role is recorded in [AGENT-ROLES](agent-roles.md).
