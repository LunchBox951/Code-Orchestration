# L6b Acceptance Criteria

L6b is the specs-and-plans slice (E + F, "L6b-core") **plus the deferred G + H closure**: it turns
specs and plans into durable, event-sourced program-data records, adds an operator-only spec-lock
gate and a plan validator that mechanically rejects fuzzy acceptance criteria, and adds the
record-aware resolver the review gate will use to resolve acceptance criteria from the locked spec
record. The live `triggerReview` call-site swap stays an L7 conductor wiring step. G adds the
bottom-up issue pipeline (`detect → diagnose → dedup → file`, per-post approved, layered opt-ins
all OFF by default); H adds the static half of the codebase locator (the map output contract + the
durable research-finalize record — live locating/dispatch is L7-coupled). These IDs are cited in
code/tests as local implementation criteria; each ladder points back to the project-wide v1
acceptance criteria. Evidence cites `file:line` on the integration branch plus the test that
proves it.

## F — Specs

- `AC-L6b-1` — Durable spec record: a spec is an event-sourced program-data record with a
  `draft→locked→archived` lifecycle, replay-equal, with no `.co/specs` file dependency. Evidence:
  `packages/core/src/specs/events.ts`, `specs-projector.ts`, `specs-store.ts:61` (`openSpecStore`);
  proven replay-equal + lifecycle-loud-fail by `packages/core/src/specs/specs-store.test.ts`. Ladders
  to `SH-2`, `ST-1`.
- `AC-L6b-2` — Operator-only lock: only `@operator` can lock a spec; any agent (coordinator included)
  attempting to lock fails with a named violation. Evidence:
  `packages/core/src/tools/specs/spec-lock.ts:45` (`ctx.agent !== OPERATOR` direct gate — the operator
  is not a roster agent); proven by `spec-lock.test.ts` (non-operator rejected). Ladders to `RG-4`,
  `RG-1`.
- `AC-L6b-3` — Review gate resolves criteria from the locked spec **record**: a record-aware resolver
  returns the criteria reference only for a `locked` spec, and emits the explicit `no-locked-spec`
  marker (never a `<TODO>`) otherwise. Evidence:
  `packages/core/src/review/spec-ref.ts:59` (`resolveSpecRefFromStore`); proven by `spec-ref.test.ts`.
  **L7 deferral:** the live `triggerReview` call-site (`review/merge.ts`, inside the zero-production-caller
  L7 conductor seam) still injects the legacy string ref; swapping it to `resolveSpecRefFromStore` is
  the L7 wiring step (per the locked spec). Ladders to `RG-4`.
- `AC-L6b-4` — A locked spec is queryable by any agent via a tool (no filesystem hunt). Evidence:
  `packages/core/src/tools/specs/spec-get.ts:73` (`co_spec_get`), offered to all five roles via
  `packages/core/src/roles/profile.ts:35` (`UNIVERSAL`); proven by `spec-get.test.ts`. Ladders to
  `SH-2`.

## E — Plans

- `AC-L6b-5` — Durable plan record: a plan is event-sourced (`plan.drafted` + `phase.status.changed`
  + `phase.verified` + `plan.replanned`), replay-equal, program-data only. Evidence:
  `packages/core/src/plans/events.ts`, `plans-projector.ts`, `plans-store.ts:65` (`openPlanStore`);
  proven replay-equal, phase-order-stable, and actor-audited by `plans-store.test.ts`. Ladders to
  `ST-1`.
- `AC-L6b-6` — The plan validator rejects fuzzy criteria: a criterion with no wired verification
  command, a vacuous phrase, or an empty criteria list fails draft/lock/ingestion with a named
  violation; concrete+wired criteria pass — proven green-on-real / red-on-fuzzy. The validator is pure
  and **never hard-codes a project command** (it accepts any non-empty `verify`). Evidence:
  `packages/core/src/plans/criteria.ts:114` (`validateCriteria` — structural command-present is the
  primary bite; `VACUOUS_PHRASES` deny-list is the secondary nudge) and the ingestion gate at
  `packages/core/src/tools/specs/plan-ingest.ts:211`; proven by `criteria.test.ts` (green/red) and
  `plan-ingest.test.ts` (fuzzy-rejected, locked-spec-required, spec-drift-rejected). This is also the
  draft/lock-time join in `AC-L6b-2` (`spec-draft.ts` and `spec-lock.ts` run `validateCriteria`).
  Ladders to `RG-4`.
- `AC-L6b-7` — Phase-ready is mechanically derived: `workersComplete ∧ phaseVerified`, where reviewers
  are excluded from worker-completion accounting and a terminal-WAITING worker whose branch is merged
  counts as complete (readiness reachable through normal completion). Evidence:
  `packages/core/src/plans/readiness.ts:63` (`foldPhaseReadiness`; reviewer-exclusion at `:70`,
  branch-merged-completion at `:71`); the read-only `co_phase_status` tool at
  `packages/core/src/tools/specs/phase-status.ts`. Proven by `readiness.test.ts` (REGRESSION 1 —
  reviewers excluded; REGRESSION 2 — WAITING-but-merged complete) and `phase-status.test.ts`. Design
  note: D5's `criteria ∧ no-regression ∧ phase-tester` is attested by a single green `phase.verified`
  record, so the fold reads `verifiedPass`. Ladders to `ST-1`, `RG-4`.
- `AC-L6b-8` — Max-active-children cap enforced per parent (configurable; excludes reviewers; excess
  queues → WAITING); per-target review+merge serialization **reuses** `review/serialize.ts` verbatim
  (a distinct primitive, not rebuilt). Evidence:
  `packages/core/src/plans/child-cap.ts:33` (`resolveMaxActiveChildren`, config key
  `dispatch.maxActiveChildren`, default 2) and `:89` (`childCapDisposition`), enforced at the dispatch
  decision in `packages/core/src/tools/specs/sling.ts` (over-cap → first-class `waiting` disposition);
  the reused merge lock is `packages/core/src/review/serialize.ts` (`acquireMergeSlot`). Proven by
  `child-cap.test.ts` and `sling.test.ts`. Ladders to `ST-1`.
- `AC-L6b-9` — Re-planning on escalation amends the plan with an event-sourced audit trail. Evidence:
  the `plan.replanned` event in `packages/core/src/plans/events.ts` and
  `packages/core/src/plans/plans-store.ts:50` (`recordReplan` with caller actor); proven by
  `plans-store.test.ts` asserting persisted actor + reason. Ladders to `ST-1`.

## G — Issues

- `AC-L6b-G1` — The issue pipeline is a durable, event-sourced record of
  `detect → diagnose → dedup → file → (opt-in) self-assign`: pipeline order is enforced loud-fail
  (file requires diagnose; self-assign requires filed), replay-equal, program-data only. Evidence:
  `packages/core/src/issues/events.ts`, `issues-projector.ts` (`validateIssueTransition`,
  `findDuplicateIssue`), `issues-store.ts` (`openIssueStore`); proven by `issues-store.test.ts`
  (roundtrip, idempotent re-assert, illegal transitions, dedup, replay-equal, pristine-repo).
  Ladders to `ST-1`, `SH-2`, Principle 8.
- `AC-L6b-G2` — Layered opt-in, all OFF by default: `issues.capture` (local) → `issues.publish`
  (GitHub) → `issues.selfAssign`, each its own config-cascade switch, a later layer effective only
  when every earlier layer is on, and only the boolean `true` enables — so a stranger repo never
  auto-captures or auto-files. The opt-in check runs BEFORE any write (robust on read-only state).
  Evidence: `packages/core/src/issues/opt-in.ts` (`layerIssueOptIns`/`resolveIssueOptIns`); gate
  order proven by `opt-in.test.ts` and `issue-tools.test.ts` (refusal writes nothing). Ladders to
  Principle 8, `RG-5`.
- `AC-L6b-G3` — Filing is gated by a per-post `@operator` approval and the outward action runs
  through L1's `gateOutwardAction` (its first real consumer): the approval mail is
  idempotency-keyed per issue (retries never double-ask), its subject/body are the SCRUBBED
  outward artifact (what the operator approves is what posts), a pending approval BLOCKS loud, a
  declined approval REFUSES loud, and `gh issue create` runs exactly once on approve with the
  approval seq + posted ref recorded on `issue.filed` for audit. Destination rides repo mode:
  `target` filing refuses in Offline; `co` filing posts to the configured `issues.coRepo` slug.
  All `gh` I/O is behind the injectable `GhExec` seam — `pnpm test` performs no real network
  operations. Evidence: `packages/core/src/issues/filing.ts`, `scrub.ts`, the verb at
  `packages/core/src/tools/specs/issue-file.ts`; proven by `filing.test.ts`, `scrub.test.ts`, and
  `issue-file.test.ts` (blocked/refused/run-once + scrub + idempotent re-call). Ladders to
  Principle 8, `RG-1`, `SF-3`.
- `AC-L6b-G4` — The pipeline verbs are scoped by role: any agent may capture and list
  (`co_issue_capture`/`co_issue_list` in `UNIVERSAL` — friction can hit anyone, and dedup needs
  read access), only a researcher may diagnose (`co_issue_diagnose` — the `researcher:diagnostic`
  mandate), only a coordinator/lead may file (`co_issue_file` — the outward tier). Evidence:
  `packages/core/src/roles/profile.ts` toolsets; proven by `issue-tools.test.ts` /
  `issue-file.test.ts` role-refusal cases. Ladders to `RL-1`, `RL-2`.

## H — Codebase locator (static half)

- `AC-L6b-H1` — `co_research_finalize` records a cited map/answer as replay-safe program-data, and
  the locator map output contract is structured + enforced: files + a one-line *why* each + key
  symbols + a suggested read order (pointers, not a content dump) — multi-line/oversize whys,
  incoherent read orders, duplicate paths, and citation-free answers are mechanically rejected.
  `researcher:codebase` scoping is confirmed (the no-web sub-role profile shipped in L6a;
  `co_research_finalize` is researcher-only; `co_research_get` is offered to every role so the
  requester reads the durable record instead of re-searching). Evidence:
  `packages/core/src/research/map-contract.ts` (`locatorMapSchema`/`checkLocatorMap`/
  `citedAnswerSchema`), `events.ts`, `research-projector.ts`, `research-store.ts`; verbs at
  `packages/core/src/tools/specs/research-finalize.ts` / `research-get.ts`; proven by
  `map-contract.test.ts`, `research-store.test.ts`, `research-tools.test.ts`. **L7 deferral:**
  research *dispatch* (spawning a live researcher) and the live "agent maps a stranger repo" proof
  (`SH-4`) need the hosted session — they land with/after L7, per the Stage 7 scope research
  (§2.H.2: bundling the live half pre-substrate risks half-building it). Ladders to `MC-3`,
  `SH-4`, Principle 5.

## Completeness

All eleven L6b MCP tools (`co_spec_get`, `co_spec_draft`, `co_spec_lock`, `co_plan_ingest`,
`co_phase_status`, `co_issue_capture`, `co_issue_list`, `co_issue_diagnose`, `co_issue_file`,
`co_research_finalize`, `co_research_get`) pass the L2 completeness gate (`tools/completeness.ts`)
over the whole `buildCoreRegistry`. `co_spec_lock` is operator-only: it lives in the mount's
`OPERATOR_TOOL_NAMES` (`packages/mcp/src/context.ts`) and in **no** role toolset, while the
registry-wide completeness gate still covers it.
