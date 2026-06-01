# Design Principles to Carry Into the Rebuild

## Claude Orchestrator

These are the invariants that make `co` what it is — preserve them regardless of
implementation choices:

1. **Gated by default.** No path to `master`/remote/PR that skips review, except an
   explicit, audited operator override that records its reason.
2. **Everything is recorded.** Agents, turns, mail, reviews, phases, events — all
   durable, inspectable, replayable. Recovery is always possible from the DB.
3. **One channel for coordination.** Typed mail only. No inventing message types;
   no out-of-band side channels; no using the host harness's own agent-spawn tool.
4. **Roles are universal, projects are local.** Prompts ship with the tool and stay
   repo-agnostic; project specifics enter exclusively through the baked
   project-memory overlay.
5. **Provider-neutral core.** Claude and Codex are interchangeable behind the same
   routing, gating, and mail abstractions; project-memory and usage tracking adapt
   per provider.
6. **Isolation per agent.** Every worker gets its own worktree/branch; parallel
   work never collides; merges are explicit and locked.
7. **Turn-based, not free-running.** Agents wake on mail, do one turn, yield.
   Bounded loops (review rounds, continue caps) prevent runaway work.
8. **Discoverable at runtime.** Agents learn the protocol from `co orient` and
   `--help`, never by reading the orchestrator's source.
9. **Feature parity is enforced.** Prompts declare the runtime features they assume;
   the dispatcher refuses mismatches rather than spawning a broken agent.
10. **Safety rails are layered.** Permission registry + harness hooks + prompt
    discipline together prevent dangerous actions (force-push, `rm -rf`, ungated
    publish, polling daemons).

## Code Orchestration

The invariants that emerged across the rewrite. They weren't imposed up front — they surfaced
topic by topic and *held*, which is the strongest sign they're real. Preserve them regardless of
implementation.

1. **Two asymmetric interaction surfaces.** Agent↔operator is *live and interruptible* (the real
   interactive terminal); agent↔agent is *typed, persisted mail*. Different mediums for different
   relationships. The operator is also a first-class mail participant — escalations, approvals,
   and decisions *filter up* to their inbox.

2. **The virtual terminal is the authentic experience, not a reconstruction.** `co` hosts the
   *real* interactive `claude`/`codex` in a terminal emulator; the operator gets the genuine tool,
   with `co`'s flow layered on top. Never a headless (`claude -p` / `codex exec`) reconstruction;
   never tmux.

3. **One thing, rendered per audience.** Structured/JSON under the hood for machines (mail, commit
   messages); a clean human view on top. Readability is the *app's* job, not the agent's — which
   keeps provider voice (Claude-verbose, Codex-terse) out of the artifacts.

4. **One agent surface, no fallback.** Agents act through the MCP server alone; the protocol is
   self-describing; a stubbed tool fails loudly (completeness gate). One core, thin adapters — so
   surfaces can't drift in logic.

5. **Self-describing — works on any repo.** Agents operate any codebase without reading `co`'s
   source: `orient` teaches workflow, schemas teach syntax, the native project-memory file teaches
   the repo, and the codebase *locator* maps unfamiliar code on demand. "Only worked on `co`" is the
   anti-pattern this kills.

6. **Tools do the heavy lifting; block only the destructive; nudge the rest.** Ergonomic tools make
   the sanctioned path the easy path; the only hard blocks are the non-destructive boundary;
   protocol adherence is *reactive nudges* — trust, monitor silently, gently remind.

7. **Gated by default; strict, made safe by escalation.** Nothing reaches master/remote/PR without
   a PASS — agent *or* human (human review is a per-repo, per-scope option). Two verdicts only
   (PASS / ISSUES); the **blocker bar tightens as code nears production** — nits ride as
   suggestions into isolated branches but become blockers at the PR/master gate. The gate can be
   ruthless only *because* escalation gives a stuck-but-honest worker an exit.

8. **Filter up — the operator owns only the big decisions.** Problems and questions climb the spawn
   chain, resolved at the lowest competent level; only genuine intent and outward actions reach the
   operator. Actionable items are un-loseable (sticky until acted on).

9. **No silent failures.** Every failure is detected and surfaced — pre-flight (the doctor),
   in-flight (live monitoring of agent streams), post-hoc (observability). Never-drop, fail-loud,
   and under pressure *degrade safely* rather than die.

10. **Acceptance criteria are the cohesion contract.** One concrete, checkable standard the spec
    produces, the plan structures, the implementer targets, the tests encode, and the reviewer
    enforces — the cure for "everyone interpreted *done* differently."

11. **Roles universal, projects local; base roles × sub-roles.** Few base roles (distinct mandate +
    permission profile); cheap sub-roles specialize *approach* and may only *narrow* permissions.
    Project specifics enter exclusively through the project's native memory file
    (`CLAUDE.md`/`AGENTS.md`), which `co` never bakes, mirrors, or syncs.

12. **Pristine repo; data in program-data.** Nothing orchestration-related touches the target repo
    (only `CLAUDE.md`/`AGENTS.md`); all state, specs, plans, and config live in the app's
    program-data, keyed per project.

13. **Provider-neutral core; rate-limits first-class.** Claude and Codex are interchangeable behind
    one routing/gating/mail abstraction. Pinned roles + a rate-limit-aware balancer spread load
    across subscriptions; when both are tapped, **pace — don't sacrifice** quality or flow.

14. **Recoverable and auditable.** Everything is an event — durable, inspectable, replayable; the
    system can always be reconstructed and recovered from its record.

15. **One-stop-shop — agent-first, manual-second.** The desktop app absorbs the alt-tab: observe and
    steer the agents first, light manual coding second. Deliberately *not* a new IDE — just enough
    that the operator never has to leave the flow.

16. **Decisions deferred to evidence.** The runtime substrate is *parked for research, not guessed* —
    anchored on the authentic-interactive-terminal directive (principle 2) and validated at
    spec-execution time. Measure before committing.
