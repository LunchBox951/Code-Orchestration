# The Mail Bus

## Claude Orchestrator

Agents coordinate **only** through typed mail. The bus is persisted, ordered, and
inspectable. Each message has a sender, recipient, type, subject, priority
(`low|normal|high|urgent`), body, optional task scope, and read/ack state.

### Mail types

| Type | Body | Sender → Receiver | Purpose |
|---|---|---|---|
| `dispatch` | JSON | Coordinator/Lead → orchestrator | Request a new agent be spawned. |
| `worker_done` | JSON envelope | any leaf worker → spawner | Signal completion + structured result payload. |
| `worker_kickback` | JSON | spawner → worker | Send a worker back with blockers to fix. |
| `review_request` | JSON | runtime → reviewer | Ask for a diff review. |
| `review_verdict` / `review_result` | JSON | reviewer → requestor | Return PASS/ISSUES/SOFT_PASS + blockers/suggestions. |
| `phase_chunk_ready` | JSON envelope | Lead → Coordinator | Report a phase is verified and ready. |
| `clarify_request` | JSON | any subagent → spawner | Ask a blocking clarifying question. |
| `clarify_response` | markdown | forwarder → original asker | Answer to a clarify_request. |
| `escalation` | markdown | worker/Lead → spawner | Raise a problem upward. |
| `follow_up_question` | markdown | spawner → researcher | Ask a warm researcher a follow-up. |
| `operator_message` | markdown | runtime/operator → any | Operator-originated message. |
| `chat` | markdown | any → any | Free-form conversation. |
| `nudge` | markdown | runtime/operator → any | Prompt an agent to act. |

### Mail features

- **Inbox / thread / get / ack** — agents read their inbox, follow threads, fetch
  single messages, and acknowledge.
- **Bounded retraction** — a sender can retract a just-sent message within a small
  time window (≈5 seconds).
- **Force-send** — operator can enqueue mail even to a DONE/STUCK recipient.
- **Sender defaulting** — sender defaults to the current agent (`$CO_AGENT_NAME`)
  or `@operator`; mail type defaults sensibly by sender.
- **Priority + scoping** — messages carry priority and an optional task id.

The mail enum is owned by the runtime. A subset of types are *declared but
reserved* for future flows (e.g. `phase_chunk_ready`, `review_request`,
`review_verdict`, `nudge`) — the active paths use the production-minted subset.

## Code Orchestration

### Typed bus, rendered per audience

The bus stays **typed and structured** — JSON payloads are *correct* for agent↔agent
(machine-legible, schema-checked). The prototype's mistake wasn't the JSON; it was showing
that JSON to the **operator**. The fix: **readability is the app's job, not the agent's.**
The operator never sees raw JSON — the desktop app **renders each typed envelope into a human
view.** Because mail is typed, the app knows each schema and renders it natively:

- `clarify_request` → a question card with a reply box
- `approval` → an approve / decline card with the action laid out
- `review_verdict` → ✅ / ❌ with the blockers formatted
- `review_request` (human-review scope) → a diff-review card with the acceptance criteria + **PASS / ISSUES** actions
- `escalation` → a readable problem summary + context
- prose types (`chat`, `operator_message`) → just nice markdown

The agent never writes "pretty prose" (which would reintroduce provider variance — the
commit-message problem one layer up); it sends structured data, and the app makes it legible.

### The operator is a first-class participant

The operator has **two channels**, for two needs:
- **The live terminal** — *real-time* steering of one specific agent (push in, redirect).
- **The mailbox** — the *structured, async* channel where things **filter up**: escalations,
  top-of-chain clarifications, approvals, operator messages.

Mail is the **universal** structured medium (every participant, including `@operator`); the
live terminal is the operator's real-time superpower *on top* of it. The desktop app is a
**smart mail client**: the operator's **inbox + outbox is the primary view** (Gmail/Outlook
feel — threads, read state, search), with a **toggle into the raw agent-to-agent bus** for
observability. The operator composes in human terms; the app translates to structured where
an agent needs it (clicking **Approve** emits a structured ack — the operator never
hand-writes JSON either).

### Actionable vs informational — actionable mail is un-loseable

The inbox can be **as verbose as the agents want** (milestones, FYIs, the lot) *because*
actionable items are protected from getting lost in the noise. Every type is one of:

- **Informational** (notifications, milestones, FYI) — **read clears on view**, like normal
  mail.
- **Actionable** (approvals, clarifications, decisions) — **stays "action-required" until the
  action is actually completed** (approve / decline / reply). *Viewing does not clear it,* so
  the operator can't accidentally ignore a decision they merely glanced at.

This is the operator-facing extension of the **never-drop** guarantee: just as an agent must
resolve-or-forward an escalation, an actionable inbox item stays sticky until resolved —
decisions can't vanish anywhere in the chain, agent or human. The app surfaces an
outstanding-action count so the queue is always visible.

### `approval` — a first-class type

Outward / irreversible actions (filing a public issue, opening a PR, anything that leaves the
local sandbox) share a shape: *"I'm about to do something outward — bless it?"* That's a
first-class **`approval`** type (actionable), not ad-hoc handling. The per-post issue filing
(SPECS-and-ISSUES) is its first instance.

### No reserved or stubbed types

The completeness-gate + single-surface discipline (MCP-TOOLS) applies to the type enum: every
declared mail type has a **real, exercised flow.** The prototype's "declared but reserved"
types are exactly the half-implemented surface we banned — the set is rationalized to types
with live flows, and a stubbed type fails the build.

The *concrete* enum is **deferred** — derived from the live flows as the operator-facing topics
lock, not ported wholesale from the prototype (the same deferral the CLI and MCP surfaces take —
CLI-REFERENCE, MCP-TOOLS). One structural change is already certain: the prototype's `dispatch`
type does **not** carry, because spawning is an MCP tool call to the Conductor, not mail
(CORE-CONCEPTS). And types whose *delivery* rides on the runtime mechanism — e.g. whether a finish
or a `nudge` is a mail envelope or direct session-injection — are settled with the substrate
(`.research/runtime-substrate.md`).

### Escalation is a first-class protocol, not ad-hoc mail

The prototype *had* the primitives (`escalation`, `clarify_request`/`clarify_response`)
but they didn't compose into reliable escalation — things got dropped or guessed around.
Here, escalation is a defined protocol on the bus: **one upward chain along the spawn
hierarchy** (implementer → lead → coordinator → operator), with two triggers.

- **Stuck-on-failure.** Raised automatically by the 3-strike rule (see REVIEW-GATES). The
  parent takes ownership: resolve, re-scope, spawn a remediation agent, or forward up.
- **Uncertain-on-intent — the parent↔child brainstorm.** Raised by an agent unsure about
  *approach or spec intent*. A **threaded** back-and-forth (not one-shot) mirroring the
  operator↔coordinator brainstorm. The asker **blocks** (goes WAITING) until it gets an
  answer or the clarify timeout fires; the answer flows back down the chain.

### Two hard guarantees (the thing the prototype lacked)

1. **Resolve-or-forward — never drop.** An agent that receives an escalation or question
   must either resolve it within its mandate or forward it up the chain. Silently
   ignoring it is a protocol violation.
2. **Ask on intent ambiguity — never guess.** An agent genuinely uncertain about *intent*
   **must** ask up the chain. Interpreting a vague spec solo is a *defect*, not
   initiative. (Directly fixes "the coordinator was vague, so leads/implementers
   interpreted it however they wanted.")

Net effect: problems and questions **filter upward** until they reach the level with the
context/authority to settle them, and resolutions flow back down — keeping the operator
focused on big-picture decisions only.

> The operator inbox/outbox rendering and the agent-bus toggle are detailed as *UI* in the
> TUI / desktop-app topic; this section fixes the *bus semantics* — typed envelopes, the
> per-audience rendering contract, actionable vs informational, the `approval` type, and the
> escalation protocol.