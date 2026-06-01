# Research Workflow

## Claude Orchestrator

A dedicated read-only research flow, separate from code work.

- **`co research "<question>"`** — dispatch a Researcher with a structured
  question. Supports `--from-file` (multi-line), `--scope` (file/dir hints),
  routing overrides (`--work-size` / `--reasoning-budget` / `--deep`), `--phase`
  pinning, `--parent`, `--name`, and `--dry-run`.
- **`co research-report`** — the canonical researcher finisher: emits a
  `worker_done` carrying a one-sentence answer, a confidence level
  (`high|medium|low`), file/line citations, literal commands run, open questions,
  and a pointer to an on-disk markdown report (the envelope carries only the
  pointer; the consumer reads the file).
- **`co research-followup`** — send a follow-up question to a *warm* researcher
  within its follow-up window, keeping its context loaded.

Researchers lead with the bottom-line answer, cite every factual claim, and never
edit, refactor, or spawn helpers.

## Code Orchestration

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
| **`diagnostic`** | source (repo + `co`'s public repo) | optional | bug-cause analysis for the issue pipeline (SPECS-and-ISSUES). |
| **`decision`** | codebase and/or web, as the question needs | as needed | a cited answer to a specific question. |

### Why the locator matters most

The `codebase` locator is the **worker-side antidote to "co only worked on co."** That failure
was agents thrashing through unfamiliar source. A locator lets a worker navigate *any* large repo
gracefully — it asks for a map instead of grinding. (self-describing — Principle 5 — fixed the *protocol* surface; the
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

- **Missing *intent* (what/why)** → **clarify / escalate** up the chain (the escalation protocol — MAIL-BUS). Only the spec
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
