# Research Workflow

### The Researcher: read-only knowledge on demand, context-economical

A Researcher does expensive information-gathering in *its own* context and returns the **clean
conclusion** — never the search noise. It's **read-only**, cited, report-finishing, and **stays
warm for follow-ups.** Its defining value is **context economy:** the requester gets a focused
answer/map and reads only what's pointed to, instead of blowing its own context window grinding
through a large codebase or the web.

### Sub-roles = different sources, different reach

Web access is a **sub-role-gated capability** — a researcher makes web-search calls only if its
sub-role grants them. When dispatching, sling `researcher:external` for any task needing the web,
`api.github.com`, or `gh`; a bare `researcher` (and the `codebase`/`diagnostic`/`decision` sub-roles)
is offline by design.

| Sub-role | Sources | Web? | Job |
|---|---|---|---|
| **`codebase`** | the repo (read-only) | no | the **locator/navigator**: *"what's relevant to X?"* → a focused map (files + one-line *why* each + key symbols + suggested read order). **Pointers, not a content dump.** |
| **`external`** | the web + docs | **yes** | web research: library behavior, API docs, prior art — fan-out searches, fetch sources, cite. |
| **`diagnostic`** | source (repo + `co`'s public repo) | no | bug-cause analysis for the issue pipeline ([SPECS-and-ISSUES](specs-and-issues.md)). |
| **`decision`** | codebase/local evidence | no | a cited answer to a specific question; route web-backed questions to `external`. |

Web access is **enforced at pane launch**, not just declared (#127): only a pane whose resolved
sub-role carries the `web-search` capability — today `external` — gets Codex sandbox egress
re-opened (a `[sandbox_workspace_write] network_access = true` block; `workspace-write`
default-denies egress), provider-native web tools (`WebSearch`/`WebFetch`) allowed, and the resolved
`GH_TOKEN` injected into its agent shell/MCP env so authenticated `gh` / `api.github.com` research
works. Every other pane (code workers, and the `codebase` / `diagnostic` / `decision` sub-roles that
narrow `web-search` away) gets no `GH_TOKEN`, no Codex egress opening, and no provider-native web
tools. Claude shell network is not yet a hard sandbox boundary; only Codex has the explicit sandbox
egress switch today. A live token plus open egress is a data-exfil surface, so the gate is
intentionally the narrowest, integrity-checked one.

### Why the locator matters most

The `codebase` locator is the **worker-side antidote to "co only worked on co."** That failure
was agents thrashing through unfamiliar source. A locator lets a worker navigate *any* large repo
gracefully — it asks for a map instead of grinding. (Principle 5 — self-describing — fixed the *protocol* surface; the
locator fixes the *codebase* surface.)

### Who can summon one, and when

- **Any agent may spawn a Researcher — except a Reviewer or another Researcher.** Reviewers are
  read-only gates; Researchers are **leaf agents** that never spawn helpers. (In tool terms: the
  research-dispatch tool sits in every role's toolset *except* those two.)
- **Both summon patterns:** the Lead/Coordinator **pre-dispatches a `codebase` locator at phase
  setup** so a worker starts with a map in its briefing; **and** a worker may **request one
  on-demand** mid-work.

### Research vs clarify — two different gaps

An agent that's "missing something" picks the right tool by *which* gap it has:

- **Missing *intent* (what/why)** → **clarify / escalate** up the chain (the escalation protocol — [MAIL-BUS](mail-bus.md)). Only the spec
  author / operator can settle intent.
- **Missing *knowledge* (where/how/factual)** → **spawn a Researcher.** A knowledge gap is solved
  by reading, not by asking the human.

The ideal is a spec/briefing good enough that neither is needed — research is the **safety valve**
when an implementer's spec isn't sufficient and it genuinely needs to understand the code or look
something up, rather than guess or thrash.

### Workflow

Request (scoped question) → fan out (read **excerpts, not whole files**; web-search if the sub-role
allows) → return the **focused result** (map / cited answer) → requester acts on it → **warm
follow-ups** without re-searching. Heir to the prototype's `research` / `research-report` /
`research-followup`, now as MCP tools.
