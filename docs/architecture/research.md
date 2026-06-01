# Research Workflow

### The Researcher: read-only knowledge on demand, context-economical

A Researcher does expensive information-gathering in *its own* context and returns the **clean
conclusion** — never the search noise. It's **read-only**, cited, report-finishing, and **stays
warm for follow-ups.** Its defining value is **context economy:** the requester gets a focused
answer/map and reads only what's pointed to, instead of blowing its own context window grinding
through a large codebase or the web.

### Sub-roles = different sources, different reach

Web access is a **sub-role-gated capability** — a researcher makes web-search calls only if its
sub-role grants them:

| Sub-role | Sources | Web? | Job |
|---|---|---|---|
| **`codebase`** | the repo (read-only) | no | the **locator/navigator**: *"what's relevant to X?"* → a focused map (files + one-line *why* each + key symbols + suggested read order). **Pointers, not a content dump.** |
| **`external`** | the web + docs | **yes** | web research: library behavior, API docs, prior art — fan-out searches, fetch sources, cite. |
| **`diagnostic`** | source (repo + `co`'s public repo) | optional | bug-cause analysis for the issue pipeline ([SPECS-and-ISSUES](specs-and-issues.md)). |
| **`decision`** | codebase and/or web, as the question needs | as needed | a cited answer to a specific question. |

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
