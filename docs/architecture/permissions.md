# Permissions System

### Philosophy: clear instructions, good tools, free rein within a non-destructive boundary

Agents do their best work when given **clear instructions and capable tools, then the
reins to do what they want — so long as it stays non-destructive.** The permission layer's
only job is to draw that non-destructive boundary; *inside* it, agents keep full agency.
Models also follow **gentle nudges** better than heavy-handed rules, so the layer stays
deliberately **thin**. Two levers do the work instead of a big lockdown:

1. **Make the sanctioned path the easy path.** The `co` MCP tools do the heavy lifting
   so the agent never has to reason about the mechanics — `co_sling` creates the
   worktree, branch, and base; `co_finish` commits, records test results, and triggers
   review; `co_merge` performs the gated merge. The agent calls one tool and the system
   handles the rest. An agent with an easy front door rarely goes looking for a window.
2. **Block only the workarounds** — the specific actions that would let an agent *bypass
   a gated or sanctioned path*. Everything else is a nudge (prompt), not a wall.

**The virtuous loop:** because the ergonomic tools already do the git/worktree work, an
agent never *needs* raw git — so blocking the raw workaround costs nothing legitimate; it
only closes the bypass door while the easy tool stands open. Carrot and minimal stick
reinforce each other.

### The non-destructive boundary — the only hard blocks

A short, principled list. Everything *not* on it is permitted; agents have the reins
inside the boundary. What counts as destructive:

*Destroys the repo, its history, or the system:*
- **`git push --force` / `-f` / `--force-with-lease`** — rewrites shared history.
- **`rm -rf /` | `~`**, **`sudo`**, invoking the daemon directly.

*Bypasses the gate (destructive to the codebase — lets unreviewed code into master):*
- **Raw `git merge` / `git push` / `gh pr merge`** → forces `co_merge` / `co_push` /
  `co_pr_merge`, which require a PASS verdict.

*Breaks the single surface:*
- **Agents invoking `co` in the shell** → forces the MCP surface; enforces the
  no-fallback / single-surface decision (see [MCP-TOOLS](mcp-tools.md)).

### Trust, monitor, gently correct — reactive protocol nudges

Most "rules" aren't destructive — they're about agents following protocol (doing the right
tasks in the right order). These are **not** hard blocks. The default is **trust**; the
safety net is **silent monitoring with just-in-time reminders.** The Conductor watches an
agent's event stream and, when it detects a protocol break, injects a gentle corrective
nudge — the agent self-corrects — rather than failing or blocking.

Example: an implementer tries to end its turn without a `worker_done` (or any mail out).
Instead of letting it silently stop, the Conductor injects *"you're wrapping up but
haven't finished through `co_finish` / sent a `worker_done` — do that before you yield,"*
and the agent gets back on protocol on its own.

Properties:
- **Trust by default, monitor quietly.** Reminders fire only when an agent actually
  *breaks* protocol; a compliant agent never sees one.
- **Silent to the operator.** Routine course-corrections, not problems — they live in the
  audit trail, not the operator's face. Only *repeated* failure to self-correct escalates,
  via the stuck/escalation mechanic.
- **Reminders, not walls.** The agent keeps its agency; the system just keeps it honest
  about protocol.

This is the soft-enforcement layer that complements the warm-session model: the Conductor
isn't only a mail-router, it's a protocol monitor that keeps agents on-rails with gentle,
injected reminders. *(The break-detection signals — e.g. "turn ending without a finish" —
ride on the runtime-substrate research; the model is substrate-independent.)*

### Everything else is a nudge, not a wall

- **Sub-role focus is prompt-shaped, not hard-cut.** `implementer:docs` is *nudged* to
  focus on docs; `implementer:polish` is *nudged* toward behavior-preserving cleanup.
  These are approach specializations ([AGENT-ROLES](agent-roles.md)) guided by prompt — not a permission
  matrix to police. Where a sub-role carries a *real* permission delta (e.g. Reviewer
  read-only-for-code), the narrow-only invariant still holds and is checked; but most
  specialization is soft.
- **A role's MCP toolset is scoped to relevance, not restriction.** Each agent is offered
  the tools its job needs; irrelevant tools simply aren't in its list (an Implementer has
  no `co_sling` to misuse). Lightweight, and it gently discourages out-of-role
  workarounds.
- **Reviewer stays out of the code it reviews — by prompt, not a wall.** It reads, runs
  tests, and stamps verdicts via MCP; not editing code under review is a nudge (the
  reactive monitor catches a slip). Prototype reviewers already behaved this way — the
  lapses were *leniency* (the strict-gate posture — [REVIEW-GATES](review-gates.md)), not editing.
- **No hard polling gate needed.** The warm-session + mail-injection model wakes an agent
  when it has work, so busy-waiting is unnecessary *by design* — the prototype's hard
  polling-loop gate softens to a nudge. *(Exact mechanism depends on the runtime
  substrate.)*

### Defense in depth + drift

The block list is enforced at two layers — the declared registry *and* harness gate hooks
(publishing-verb gate, dangerous-shell gate), Claude and Codex variants — so a single
failure doesn't open a bypass. A drift check (heir to `co permissions check`) verifies the
enforced config matches the registry.

> **Substrate dependency:** *how* the blocks are enforced (host harness permission system
> vs. our PreToolUse hooks) depends partly on the parked runtime-substrate research; the
> philosophy and block list above are substrate-independent.
