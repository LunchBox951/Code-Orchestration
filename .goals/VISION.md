# Vision

## Claude Orchestrator
`co` is a **CLI-first, turn-based, multi-agent software-engineering orchestrator**.
It drives a team of AI coding agents (Claude by default, Codex optionally) through
a disciplined workflow: a human operator states intent, a **Coordinator** agent
shapes it into a locked spec, work is decomposed into phases and dispatched to
worker agents in isolated git worktrees, every change passes through a **review
gate** before it can merge or publish, and all state is durably recorded in a
local database that can be inspected, replayed, and recovered.

The core promise: **autonomous multi-agent work that stays auditable, gated, and
recoverable.** No agent can silently merge, push, or escape the review loop; every
turn, mail message, review verdict, and merge is a recorded event.

Three things define the product:

1. **Turn-based execution** — agents don't run as free-running daemons; they take
   discrete *turns* triggered by unread mail. A central router wakes a WAITING
   agent when it has work, runs one turn, and puts it back to sleep.
2. **A typed mail bus** — agents coordinate exclusively through structured
   messages on a shared bus, never through ad-hoc side channels. Every
   coordination action is a typed, persisted mail envelope.
3. **Review-gated integration** — code reaches `master` (or a remote, or a merged
   PR) only after a Reviewer agent returns a `PASS` verdict. Raw `git merge`,
   `git push`, and `gh pr merge` are blocked; the gated `co merge` / `co push` /
   `co pr-merge` verbs are the only path.

## Code Orchestration

`co` (Code Orchestration) is a **desktop-first, multi-agent software-engineering
orchestrator**. It runs a team of AI coding agents (Claude by default, Codex
optionally) as **live, interactive terminal sessions** the operator can watch and
steer in real time, while the agents coordinate *among themselves* through a
**typed mail bus**. Every change passes a **strict review gate** before it can
merge, push, or publish, and all state is durably recorded so the system can be
inspected, replayed, and recovered.

The core promise is unchanged in spirit but sharper in practice: **autonomous
multi-agent work that stays auditable, gated, recoverable — and steerable.** The
operator can correct any agent mid-flight without tearing it down; no agent can
silently merge or escape the gate.

### Two asymmetric interaction surfaces

The product is defined by two coordination channels that are *intentionally
different mediums for different relationships*:

1. **Agent ↔ Operator — the live terminal (human, interruptible).** Each agent is
   a persistent interactive session in its own virtual terminal inside a desktop
   app. The operator drops into any terminal and steers the agent in real time —
   answering, redirecting, or interrupting mid-work — instead of the prototype's
   stop → mail → restart dance. Running interactive sessions (rather than headless
   one-shot turns) also uses subscription auth, retiring the tmux/`claude -p`
   migration the prototype was mid-way through (PR #46).

2. **Agent ↔ Agent — the typed mail bus (structured, machine-legible, persisted).**
   Agents never coordinate through the terminal or ad-hoc side channels; they
   exchange typed, persisted mail envelopes. This is the disciplined spine of
   multi-agent work.

> These two surfaces aren't a strict partition of *who* talks to *whom*: the operator is
> also a first-class participant on the **mail bus** — escalations, approvals, and decisions
> *filter up* to the operator's inbox. Mail is the universal structured channel; the live
> terminal is the operator's additional real-time channel on top of it.

Turn-based execution survives as **internal plumbing, not a headline identity**:
mail still arrives as discrete envelopes and agents still act in observable steps,
but an agent is a long-lived session, not a process spawned and killed per turn.

### A self-describing agent surface

A third commitment is new and load-bearing: **agents operate *any* codebase
through a self-describing MCP backend.** The protocol is discoverable at
runtime — agents never reverse-engineer `co`'s own source to use it.
The prototype only worked fluently on its own repo; the rewrite treats "works on a
stranger's codebase" as a first-class requirement, not an emergent accident.
