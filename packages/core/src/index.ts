export { assertNever } from './assert-never.js';

// Part C.1 store contract (LOCKED types) + program-data paths + store openers.
export type { StoredEvent, NewEvent, StoreTx, Store } from './store/types.js';
export { dataRoot, projectDataDir } from './store/paths.js';
export { openProjectStore, openGlobalStore } from './store/sqlite-store.js';

// Part C.2/C.3 projection + replay engine, payload upcaster, read-path decode.
export type { Projector } from './replay/projector.js';
export { applyEvent, rebuildAll } from './replay/projector.js';
export type { Upcaster, UpcasterRegistry } from './replay/upcaster.js';
export { upcast } from './replay/upcaster.js';
export type { SchemaMap } from './replay/decode.js';
export { decode } from './replay/decode.js';

// Part C registry: absolute path → stable opaque project id → data dir, with
// headless relink (lives in the GLOBAL store; built on the parts above).
export type { ProjectRegistry, ProjectId } from './registry/registry.js';
export { openRegistry } from './registry/registry.js';

// Part D config cascade: effective = global ⊕ project-overrides (project wins),
// stored entirely in the GLOBAL program-data store (never in any repo).
export type { ConfigStore, EffectiveConfig } from './config/config-store.js';
export { openConfigStore } from './config/config-store.js';
export type { JsonValue } from './config/events.js';

// Part D pristine-repo guard: proves no L0 op writes into a target repo's working
// tree or `.git` (freeze #7), by asserting byte-identity around a wrapped op.
export { assertRepoPristine } from './config/pristine.js';

// L1 mail bus: a typed, schema-validated, idempotent envelope over the L0 log that
// activates the four reserved fields, plus send/inbox and the in-process Delivery
// seam (the L7 plug-point is a typed stub). W3 adds actionable/informational
// classification, log-derived sticky resolution, an event-sourced read-receipt, the
// completion-predicate registry, and the outstanding-action projection. W4 adds the
// first-class `approval` type + `approval_response` decision and the log-derived
// outward-action gate (operator-terminal for outward actions). W5 adds the first-class
// `escalation` type + the resolve-or-forward never-drop protocol. Seed types: chat,
// operator_message, clarify_request, clarify_response, approval, approval_response, escalation.
// L3-C activates the deferred informational `worker_done` (a worker's finish ping; see worktrees/finish.ts).
export type {
  MailEnvelope,
  DeliveredMail,
  MailType,
  MailMessage,
  MailRead,
  MailForward,
  MailRetract,
  MailKind,
  CompletionPredicate,
  ApprovalDecision,
  ApprovalResponse,
  ReviewResponse,
  ReviewVerdictValue,
  MailPayload,
} from './mail/events.js';
export {
  OPERATOR,
  MAIL_SCOPE_PREFIX,
  MAIL_CHAT,
  MAIL_OPERATOR_MESSAGE,
  MAIL_CLARIFY_REQUEST,
  MAIL_CLARIFY_RESPONSE,
  MAIL_APPROVAL,
  MAIL_APPROVAL_RESPONSE,
  MAIL_ESCALATION,
  MAIL_WORKER_DONE,
  MAIL_REVIEW_REQUEST,
  MAIL_REVIEW_RESPONSE,
  MAIL_TYPES,
  EVENT_MAIL_READ,
  EVENT_MAIL_FORWARD,
  EVENT_MAIL_RETRACTED,
  MAIL_EVENT_V,
  mailMessageSchema,
  approvalResponseSchema,
  reviewResponseSchema,
  mailReadSchema,
  mailForwardSchema,
  mailRetractSchema,
  mailSchemas,
  mailUpcasters,
  mailScope,
  mailRecipientForScope,
  makeMailEvent,
  makeMailReadEvent,
  makeMailForwardEvent,
  makeMailRetractEvent,
  mailKinds,
  mailKind,
  completionPredicates,
  completionPredicate,
} from './mail/events.js';
export {
  MailProjector,
  ensureInboxTable,
  outstandingForRecipient,
  countOutstanding,
  sentByForSender,
} from './mail/mail-projector.js';
export type { Delivery } from './mail/delivery.js';
export { InProcessDelivery, LiveDeliveryStub } from './mail/delivery.js';
export type { MailStore, MailStoreOptions, ReplyDraft } from './mail/mail-store.js';
export { openMailStore } from './mail/mail-store.js';
// L1 W4 outward-action approval gate + operator-terminal addressing (AC-L1-5).
export type { ApprovalOutcome, OutwardApprovalRequest } from './mail/approval.js';
export { approvalOutcome, gateOutwardAction, outwardApprovalEnvelope } from './mail/approval.js';
// L1 W5 escalation protocol: resolve-or-forward / never-drop / never-guess / threaded brainstorm
// up the spawn chain (AC-L1-6), the L6 parent-resolver seam + a structural coordinator→@operator
// prototype double, the forward-up clarify-timeout policy (firing deferred to L7), and the
// log-derived asker-WAITING query.
export type {
  ParentResolver,
  PrototypeChain,
  EscalationRequest,
  EscalationResolution,
  ClarifyTimeoutPolicy,
} from './mail/escalation.js';
export {
  prototypeParentResolver,
  escalate,
  forwardEscalation,
  resolveEscalation,
  forwardOnTimeout,
  waitingItems,
  isAwaitingReply,
  CLARIFY_TIMEOUT_SECONDS_KEY,
  CLARIFY_TIMEOUT_SECONDS_DEFAULT,
  CLARIFY_TIMEOUT_POLICY,
} from './mail/escalation.js';
// L1 W6 renderer-registry seam + a trivial generic default renderer (AC-L1-8). The bus stays
// typed/structured for agents; making a DeliveredMail human-legible is the app's job. L1 ships
// the seam + the default only — per-type human cards are the L9 plug-point (register).
export type { MailRenderer, RendererRegistry } from './mail/renderer.js';
export { createRendererRegistry, defaultMailRenderer } from './mail/renderer.js';
// L1 W6 mail-type no-stub assertion (AC-L1-7): a reusable completeness check proving every
// declared type has schema + flow (+ a predicate iff actionable). L1 owns this local assertion;
// the full build-time gate is L2.
export type { MailTypeViolation } from './mail/completeness.js';
export { checkMailTypeCompleteness } from './mail/completeness.js';

// L2-A tool-registry foundation: the FROZEN cross-phase contracts the single MCP agent surface
// is built from (Principle 4 — one-agent-surface). `ToolContext` is the headless invocation seam;
// `ToolSpec`/`ToolHandler` are the typed tool declaration (schemas = the single syntax source,
// Principle 5); `ToolRegistry` + `createToolRegistry` are the append-only single source of truth
// the adapter mounts / the gate checks / the role-scoper filters; `notImplemented` is the stub
// sentinel the L2 completeness gate detects. Phase A is types + mechanism + sentinel only — the
// real tools and the canonical registry instance land in phase B.
export type { ToolContext, ToolHandler, ToolSpec, ToolRegistry } from './tools/index.js';
export { createToolRegistry, notImplemented } from './tools/index.js';

// L2-B1 first real tools: the canonical registry of the `co_*` tools (`buildCoreRegistry`),
// the transport-agnostic headless invocation harness (`invokeTool`) the MCP adapter (B2) mounts,
// and the read-only git worktree helper behind `co_worktree_info` (`readWorktreeInfo`). All logic
// is in core; B2 is a thin transport over this.
export type { WorktreeInfo } from './tools/index.js';
export { buildCoreRegistry, invokeTool, readWorktreeInfo } from './tools/index.js';
// L2-B2 schema-exposure helpers: the zod `.shape` of a tool's input/output schemas, so the thin
// MCP adapter mounts each tool's self-describing schema onto the SDK without importing zod itself.
export { toolInputShape, toolOutputShape } from './tools/index.js';
// L2-C completeness gate (THE keystone, AC-L2-3): the no-stub assertion generalized from L1's
// mail-type check to the WHOLE tool registry — flags any tool lacking a self-describing input
// schema, a structured output schema, a real (non-`notImplemented`) handler, or mountability. A
// pure function run as a test over `buildCoreRegistry()`; riding `pnpm test` makes a stubbed tool
// turn CI (and the review gate) red.
export type { ToolViolation } from './tools/index.js';
export { checkToolCompleteness } from './tools/index.js';

// L2-D role-scoped orientation + per-role tool-scoping. `orientContent` is the WORKFLOW-ONLY,
// role-scoped body behind `co_orient` (AC-L2-4): a pure function of (role, topic) that never
// restates a tool's field list (schemas are the syntax source, Principle 5) and never bakes a
// target repo's project memory (the prompting split, Principle 11). `Role`/`BASE_ROLES`/
// `roleToolsets`/`toolsForRole` are the per-role tool-scoping mechanism + seed over the current
// tools (AC-L2-5): the relevance-scoping hook the MCP mount feeds into `createCoMcpServer({ tools })`,
// fail-loud on a phantom tool. Authoritative rosters and sub-roles are an L6 concern.
export { orientContent } from './tools/index.js';
export type { Role } from './tools/index.js';
export { BASE_ROLES, roleToolsets, toolsForRole } from './tools/index.js';

// L3-A worktrees & git: `co_sling`'s core — base auto-detect (origin/HEAD → main → master → local
// HEAD, NEVER a hard-coded master), the program-data worktree store (worktree records + branch-off
// baselines, never in the repo — Principle 12), and the create+record+capture orchestration
// `co_sling` dispatches to. The mount opens `openWorktreeStore(projectId)` and injects it onto the
// (optional, additive) `ToolContext.worktrees`; L5 consumes the captured baseline, L7 spawns into
// the sandbox, phase B provisions it — none of which this layer builds.
export type {
  WorktreeCreated,
  BaselineCaptured,
  FinishRecorded,
  WorktreeRemoved,
  TestOutcome,
  WorktreeProvisionedEntry,
  WorktreeRecord,
  Baseline,
  FinishRecord,
} from './worktrees/events.js';
export {
  WORKTREE_EVENT_V,
  EVENT_WORKTREE_CREATED,
  EVENT_BASELINE_CAPTURED,
  EVENT_FINISH_RECORDED,
  EVENT_WORKTREE_REMOVED,
  worktreeScope,
  baselineScope,
  finishScope,
  worktreeSchemas,
  worktreeUpcasters,
  makeWorktreeCreatedEvent,
  makeBaselineCapturedEvent,
  makeFinishRecordedEvent,
  makeWorktreeRemovedEvent,
} from './worktrees/events.js';
export { WorktreeProjector } from './worktrees/worktree-projector.js';
// L3-E worktree teardown + orphan-detection PRIMITIVES (AC-L3-5): `removeWorktree` tears a sandbox
// down (git worktree remove + dir deletion, then a `worktree.removed` record in program-data) and
// `detectOrphans` SURFACES recorded-vs-reality mismatches against an injectable reality probe. Both
// are reusable primitives — the operator cleanup VERBS (cleanup/unstick/nuke + "prove merged before
// removing") are L8 (a typed `CleanupGateStub`), and the merge-time teardown trigger is L5.
export type {
  WorktreeStore,
  Orphan,
  WorktreeRealityProbe,
  SandboxFs,
  RemoveWorktreeDeps,
} from './worktrees/worktree-store.js';
export {
  openWorktreeStore,
  defaultWorktreeRealityProbe,
  defaultSandboxFs,
} from './worktrees/worktree-store.js';
export type { CleanupGate } from './worktrees/cleanup-gate.js';
export { CleanupGateStub } from './worktrees/cleanup-gate.js';
// L3-C message contract (AC-L3-3): pure, provider-deterministic renderers — commit / merge / PR text
// from a structured intent in a fixed house style, with NO provider/voice parameter (Principle 3).
// Only the commit renderer has a consumer in L3 (`co_finish`); the merge/PR renderers ship as core
// functions with no MCP verb wired to them (the gated `co_merge`/`co_push`/`co_pr_merge` are L5).
export type { CommitIntent, MergeIntent, PrIntent } from './worktrees/messages.js';
export { renderCommitMessage, renderMergeMessage, renderPrMessage } from './worktrees/messages.js';
// L3-C `co_finish` core (AC-L3-6): commit (house-style, DCO-signed) + record the finish (the L5
// comparison input) + emit `worker_done` (informational). It does NOT review or merge (L5).
export type {
  WorktreeGitFacts,
  FinishParams,
  FinishDeps,
  FinishResult,
} from './worktrees/finish.js';
export { finishWorktree } from './worktrees/finish.js';
// L5 review-trigger + merge gate: the typed seam `co_finish` stops short of, now REAL (L5). The
// interface + its request/result types live here; the real implementation is the review/ CoReviewGate
// (consumed by `co_merge`). `co_finish` still does NOT call it (it stops short by design).
export type {
  FinishReviewGate,
  ReviewTriggerRequest,
  ReviewTriggerResult,
  ReviewMergeRequest,
  ReviewMergeResult,
} from './worktrees/review-trigger.js';
// L3-D repository-relationship modes (AC-L3-4): per-project Owner / Contributor / Offline that reshape
// the publishing surface. The read-only injectable remote-capability prober, the pure D2 detection
// order, override-beats-detection resolution (persisted in the config cascade, never the repo), the
// Offline "push/PR disabled" capability, and a minimal Contributor host-convention probe (PR-template
// presence + a sign-off signal). As of L5 Phase C, the owner/offline merge enactment, the remote
// PUSH enactment (`co_push`), and the PR creation enactment (`co_pr_merge`) are all REAL. The
// Contributor fork→PR host-convention probe uses the minimal Phase C `detectHostConventions`; the rich
// CONTRIBUTING/PR-template parse remains L9 — `parseHostConventions` stays the loud-failing seam (P7, P9).
export type {
  RepoMode,
  RemoteSignals,
  RemoteProbe,
  ResolveRepoModeDeps,
  RepoModeCapabilities,
  HostConventions,
  RepoModeGate,
  PublishRequest,
  PublishResult,
  EnactPublishDeps,
  GhExec,
  EnactPushRequest,
  EnactPushResult,
  EnactPushDeps,
  EnactPrMergeRequest,
  EnactPrMergeResult,
  EnactPrMergeDeps,
} from './worktrees/repo-mode.js';
export {
  REPO_MODE_CONFIG_KEY,
  defaultRemoteProbe,
  defaultGhExec,
  detectRepoMode,
  resolveRepoMode,
  repoModeCapabilities,
  detectHostConventions,
  CoRepoModeGate,
} from './worktrees/repo-mode.js';
export type { GitReader } from './worktrees/detect-base.js';
export { detectBaseRef, defaultGitReader, resolveRefSha } from './worktrees/detect-base.js';
export type {
  GitExec,
  BaselineProbe,
  BaselineProbeContext,
  SlingParams,
  SlingDeps,
  SlingResult,
} from './worktrees/sling.js';
export {
  slingWorktree,
  defaultGitExec,
  emptyBaselineProbe,
  worktreePathFor,
  CO_BRANCH_PREFIX,
} from './worktrees/sling.js';
// L3-B worktree environment provisioning: place the gitignored working essentials into a slung
// sandbox by the right mechanism per item (symlink large/stable deps · copy small/mutable env ·
// isolated-copy a dep dir an agent will mutate), from a configurable manifest (smart defaults ⊕
// per-project `worktree.provision` overrides via the config cascade). Reads the source repo, writes
// only the sandbox (Principle 12 — pristine SOURCE). `co_sling` runs the `defaultProvisioner` after
// `git worktree add`; the seam is additive (no new tool, no registry change).
export type {
  ProvisionMechanism,
  ProvisionEntry,
  ProvisioningManifest,
  ProvisionOverride,
  ProvisionParams,
  ProvisionResult,
  ProvisionContext,
  Provisioner,
} from './worktrees/provision.js';
export {
  DEFAULT_PROVISION_MANIFEST,
  WORKTREE_PROVISION_CONFIG_KEY,
  mergeProvisioningManifest,
  resolveProvisioningManifest,
  provisionWorktree,
  defaultProvisioner,
} from './worktrees/provision.js';

// L5 review gate (AC-L5-1): the event-sourced review/ module — the PASS|ISSUES verdict model, the
// five-event log (review.requested/verdict/strike + merge.serialized + review.override, all defined +
// projected now so B–F add only writers), the per-(target, branch) review store, and the gated merge
// core (CoReviewGate) the lead-facing co_merge consumes. Nothing reaches a merge without a recorded
// PASS; the verdict is a structured RECORDED EVENT (Principle 5), never a prose blob or a shell exit
// code. The honest-verification baseline, strictness ladder + push/PR, strike policy, human-review
// routing, and serialization/override records are now folded into the L5 gate; rich live reviewer
// dispatch and operator UI seams remain delegated to later layers.
export type {
  Verdict,
  Blocker,
  Suggestion,
  VerificationMarker,
  ReviewVerdict,
} from './review/verdict.js';
export {
  verdictSchema,
  blockerSchema,
  suggestionSchema,
  verificationMarkerSchema,
  reviewVerdictSchema,
  assertValidVerdict,
} from './review/verdict.js';
export type {
  ReviewRequested,
  ReviewVerdictRecorded,
  ReviewStrike,
  MergeSerialized,
  ReviewOverride,
  ReviewVerdictRecord,
  ReviewRequestRecord,
} from './review/events.js';
export {
  REVIEW_EVENT_V,
  EVENT_REVIEW_REQUESTED,
  EVENT_REVIEW_VERDICT,
  EVENT_REVIEW_STRIKE,
  EVENT_MERGE_SERIALIZED,
  EVENT_REVIEW_OVERRIDE,
  REVIEW_SCOPE_PREFIX,
  reviewScope,
  reviewTargetForScope,
  reviewSchemas,
  reviewUpcasters,
  makeReviewRequestedEvent,
  makeReviewVerdictEvent,
  makeReviewStrikeEvent,
  makeMergeSerializedEvent,
  makeReviewOverrideEvent,
} from './review/events.js';
export { ReviewProjector } from './review/review-projector.js';
export type { ReviewStore } from './review/review-store.js';
export { openReviewStore } from './review/review-store.js';
export type {
  ReviewGateDeps,
  ReviewPushRequest,
  ReviewPushResult,
  ReviewPrMergeRequest,
  ReviewPrMergeResult,
  MergeTeardown,
  ReviewerSpawnGate,
} from './review/merge.js';
export {
  CoReviewGate,
  ReviewerSpawnGateStub,
  REVIEWER_PROFILES_CONFIG_KEY,
  DEFAULT_REVIEWER_PROFILES,
  resolveReviewerProfiles,
  reviewerRoleForScope,
} from './review/merge.js';
// L5 Phase B honest-verification spine (AC-L5-3): pure, deterministic comparison of a finish run
// against the branch-off baseline. `honestVerify` classifies tests as regressions (pass→fail / new)
// or baseline failures (fail→fail); `classifyPass` encodes the gate's allow/refuse/escalate decision.
// Identical inputs always produce identical output — replay-deterministic, no I/O, no clock.
export type { HonestVerifyOutcome, ClassifyPassResult } from './review/honest-verify.js';
export { honestVerify, classifyPass } from './review/honest-verify.js';
// L5 Phase C strictness ladder (AC-L5-2): a pure, deterministic fn classifying findings by (category,
// scope). The same cosmetic nit is a suggestion at worker_merge but a blocker at pr_merge — the bar
// tightens toward production (monotone, never loosens). `applyLadder` re-partitions a finding list
// into blockers/suggestions at a given scope. No I/O, no clock — replay-deterministic.
export type { ReviewScope, FindingCategory, LadderFinding, LadderResult } from './review/ladder.js';
export { classifyFinding, applyLadder } from './review/ladder.js';
// L5 Phase D 3-strike escalation (AC-L5-4): config key + default, the pure consecutive-strike
// counter (`consecutiveStrikes` over verdict history), the pure decision fn (`nextReviewAction`),
// and the cohesive enforcement path (`applyStrikePolicy` — records the strike, computes the action,
// fires exactly one escalation at the budget threshold via the spawning-parent resolver). The
// production resolver is wired into co_merge / co_push / co_pr_merge via the worktree-recorded
// `parent` field. A PASS resets the run (projector: PASS verdict → strikes = 0). Headless-testable
// over injectable seams (StrikeEnforcementDeps / StrikeEnforcementContext).
export type { StrikeEnforcementDeps, StrikeEnforcementContext } from './review/strikes.js';
export {
  REVIEW_ROUND_BUDGET_KEY,
  REVIEW_ROUND_BUDGET_DEFAULT,
  consecutiveStrikes,
  nextReviewAction,
  applyStrikePolicy,
} from './review/strikes.js';
// L5 Phase E human-review path (AC-L5-5): the `review_request` / `review_response` mail pair, the
// log-derived `reviewRequestOutcome` (the `approvalOutcome` twin), the `reviewRequestEnvelope`
// builder (operator-terminal by construction), `recordHumanVerdict` (re-enters the gate identically
// to an agent verdict), `resolveReviewerKind` (reads `review.<scope>.reviewer` from the config
// cascade; defaults to `'agent'`), and the L9 `HumanReviewGateStub` (loud-failing typed seam for
// the operator diff-viewer / verdict-accept UI — never a silent no-op, Principle 9).
export type {
  ReviewRequestOutcome,
  ReviewRequestEnvelopeParams,
  HumanVerdictParams,
  HumanReviewGate,
} from './review/human-review.js';
export {
  reviewReviewerKey,
  resolveReviewerKind,
  resolveReviewerKindFromConfig,
  reviewRequestOutcome,
  reviewRequestEnvelope,
  recordHumanVerdict,
  HumanReviewGateStub,
} from './review/human-review.js';
// L5 Phase F per-target merge SERIALIZATION + re-review base (AC-L5-7): an event-sourced merge lock
// over the `merge.serialized` log — one active reviewer/merge per target; a second queues (waits) until
// the holder releases on landing (`acquireMergeSlot`/`releaseMergeSlot`, the pure toggle `foldActiveSlot`
// over the ordered log, the `MergeSlotStore` seam). `reReviewBase` resolves the NEXT queued branch's base
// via refs — the POST-LANDING commit, never the caller's stale checkout. Clock-free + deterministic
// (AC-L5-11); replay-equal on the `merge.serialized` writes. The store writers (`recordSerialized` /
// `recordOverride` / `activeSerialized`) live on the ReviewStore.
export type { MergeSlotEntry, MergeSlotStore, MergeSlotResult } from './review/serialize.js';
export {
  foldActiveSlot,
  acquireMergeSlot,
  releaseMergeSlot,
  reReviewBase,
} from './review/serialize.js';
// L5 Phase G spec-ref seam (AC-L5-8, RG-4): a review must be judged against the SOURCE's
// acceptance criteria, never a template stub. `resolveReviewSpecRef` is a PURE fn that turns an
// optional injected spec-ref into a discriminated `ReviewSpecRef` — `{ kind: 'criteria', ref }` when
// present or `{ kind: 'no-locked-spec' }` (the explicit marker, never `<TODO>`) when absent.
// `renderReviewSpecRef` surfaces the human-readable marker text. Both are headless-testable (no I/O).
export type { ReviewSpecRef } from './review/spec-ref.js';
export {
  NO_LOCKED_SPEC_MARKER,
  resolveReviewSpecRef,
  renderReviewSpecRef,
} from './review/spec-ref.js';

// L4-1 dispatch substrate: the event-sourced usage/cost foundation + the FROZEN ProviderUsageSource
// seam (spec §4.4) every later L4 phase reads. `Provider`/`UsageWindow`/`UsageSnapshot`/
// `ProviderUsageSource` are the verbatim contract; `FakeUsageSource` is the production-quality double
// that drives phases 3–5's headless policy tests; `UsageUnavailableError`/`USAGE_UNAVAILABLE_CODE` are
// the fail-loud "no usage source succeeded" surface (AC6, Principle 9). AC11: the source contract is a
// passive/metadata read ONLY — it NEVER runs inference or spends API-billed tokens (the real adapters
// land in Phase 6). NO new agent MCP tool is added (AC8); usage/cost are internal substrate, and the
// policy (rollup math, near-budget, staleness) is PURE over injected inputs (AC10, Principle 16).
export type {
  Provider,
  UsageWindow,
  UsageSnapshot,
  ProviderUsageSource,
  FakeUsageSourceInit,
} from './dispatch/usage-source.js';
export {
  FakeUsageSource,
  UsageUnavailableError,
  USAGE_UNAVAILABLE_CODE,
} from './dispatch/usage-source.js';
export type {
  UsageObserved,
  UsageObservedAvailable,
  UsageObservedUnavailable,
  CostRecorded,
  CostNearBudget,
  UsageBucket,
  UsageAccountStatus,
  CostRollup,
  CostRollupKind,
  NearBudgetRecord,
} from './dispatch/events.js';
export {
  DISPATCH_EVENT_V,
  EVENT_USAGE_OBSERVED,
  EVENT_COST_RECORDED,
  EVENT_COST_NEAR_BUDGET,
  USAGE_SCOPE_PREFIX,
  COST_SCOPE_PREFIX,
  usageScope,
  costScope,
  providerSchema,
  usageObservedAvailableSchema,
  usageObservedUnavailableSchema,
  usageObservedSchema,
  costRecordedSchema,
  costNearBudgetSchema,
  dispatchSchemas,
  dispatchUpcasters,
  makeUsageObservedEvent,
  makeCostRecordedEvent,
  makeCostNearBudgetEvent,
} from './dispatch/events.js';
export {
  UsageProjector,
  ensureUsageTables,
  rowToUsageBucket,
  rowToUsageAccountStatus,
  selectUsageBucket,
  selectAllUsageBuckets,
  selectUsageAccount,
  selectAllUsageAccounts,
} from './dispatch/usage-projector.js';
export {
  CostProjector,
  ensureCostTables,
  rowToCostRollup,
  rowToNearBudgetRecord,
  selectCostRollup,
  selectAllCostRollups,
  selectNearBudgetBySeq,
  selectNearBudgetEvents,
} from './dispatch/cost-projector.js';
// L4-1 PURE policy (AC10, Principle 16): headroom as a discriminated value (never a magic number),
// near-budget edge trigger, and a clock-free staleness predicate (injected `now` — replay-deterministic).
export type { Headroom, StaleInput, BudgetInput } from './dispatch/policy.js';
export {
  NEAR_BUDGET_THRESHOLD_PCT_DEFAULT,
  USAGE_BUCKET_TTL_MS_DEFAULT,
  isStale,
  nearBudget,
  crossesNearBudget,
  deriveHeadroom,
} from './dispatch/policy.js';
// L4-1 store facade: `openDispatchStore(projectId)` records usage + cost over L0 (program-data only,
// AC9), with the near-budget observability emit + the fail-loud `observeUsage` read seam, and the
// config-cascade budget-cap resolution (heir to `cost_budget_cents`).
export type {
  DispatchStore,
  BudgetCap,
  CostRecordResult,
  UsageObservedResult,
  SnapshotIngestResult,
} from './dispatch/dispatch-store.js';
export {
  COST_BUDGET_CENTS_KEY,
  openDispatchStore,
  observeUsage,
  resolveBudgetCapCents,
  resolveBudgetCap,
} from './dispatch/dispatch-store.js';

// L4-2 pure tier-matrix policy: (WorkSize × ReasoningBudget) → {model, effort, context} per
// Provider. Routing vocabulary (WorkSize, ReasoningBudget + zod schemas) + default capability
// matrix (resolveTier) + legacy difficulty shim (normalizeLegacyDifficulty). AC10/P16: pure
// deterministic function, no I/O, no clock. AC8: no new MCP tool. AC9/P12: no repo writes.
export type {
  WorkSize,
  ReasoningBudget,
  Effort,
  ContextWindow,
  TierPlacement,
} from './dispatch/tier.js';
export {
  workSizeSchema,
  reasoningBudgetSchema,
  resolveTier,
  normalizeLegacyDifficulty,
} from './dispatch/tier.js';

// L4-3 rate-limit-aware balancer: the PURE provider resolver `placeAgent` (pins never overridden →
// AC1; floating → roomiest HEALTHY provider, reset-aware + hysteresis → AC2; exclude unhealthy/unknown,
// route around a dead provider → AC3) over an injected bucket/headroom snapshot. The first-class
// `no-candidate` variant surfaces the all-excluded signal for Phase 4 (throttle/WAITING) — never a throw,
// never a silent degrade (P9), and NO tier degradation here. `headroomScore` is the reset-aware scoring;
// `bindingProviderHeadroom` reduces an account's windows to the most-constrained one. The non-pure
// adapter (`candidatesFromStore`/`resolvePinTable`/`placeAgentFromStore`) only READS the DispatchStore +
// config cascade (`dispatch.pins`) — writes nothing (AC9/P12) and adds no MCP tool (AC8). AC10/P16: pure
// over injected inputs (incl. `nowMs` + `previous`), identical inputs → identical PlacementDecision.
export type {
  Pin,
  PinTable,
  ProviderHeadroom,
  Placement,
  RankedCandidate,
  ExcludedCandidate,
  PlacementDecision,
  HysteresisConfig,
  CandidateReadOptions,
  PlaceAgentInput,
  ProviderAccount,
  PlaceFromStoreInput,
  PlaceFromStoreDeps,
} from './dispatch/balancer.js';
export {
  pinSchema,
  pinTableSchema,
  DISPATCH_PINS_CONFIG_KEY,
  HYSTERESIS_MARGIN_DEFAULT,
  RESET_HORIZON_MS_DEFAULT,
  headroomScore,
  defaultProviderAccounts,
  placeAgent,
  bindingProviderHeadroom,
  candidatesFromStore,
  resolvePinTable,
  placeAgentFromStore,
} from './dispatch/balancer.js';

// L4-4 pure throttle-as-WAITING: PlacementDecision + headrooms → PLACED or WAITING (ETA + loud message); canResume predicate (AC4, P9, P13, P16).
export type { DispatchDiagnostic, DispatchResolution } from './dispatch/throttle.js';
export { MAXED_THRESHOLD_PCT_DEFAULT, resolveDispatch, canResume } from './dispatch/throttle.js';

// L4-5 dispatch integration: placement.decided event (the WRITER — completes reader-with-writer),
// DispatchStore.recordPlacement, and operator-only render/preview fns (CLI only, AC8 — no new
// agent tool; usage/cost/placement are program-data only, never agent-facing). P3: render-per-audience.
export type {
  PlacementDecidedPlaced,
  PlacementDecidedWaiting,
  PlacementDecided,
  PlacementRecord,
} from './dispatch/events.js';
export {
  EVENT_PLACEMENT_DECIDED,
  PLACEMENT_SCOPE_PREFIX,
  placementScope,
  placementDecidedPlacedSchema,
  placementDecidedWaitingSchema,
  placementDecidedSchema,
  makePlacementDecidedEvent,
} from './dispatch/events.js';
export {
  PlacementProjector,
  ensurePlacementTable,
  rowToPlacementRecord,
  selectAllPlacements,
  selectPlacementBySeq,
  selectPlacementsByAgent,
} from './dispatch/placement-projector.js';
export type {
  PreviewPlacementInput,
  UsageSourceFactory,
  RefreshUsageInput,
} from './dispatch/cli-render.js';
export {
  refreshUsageForAccounts,
  runDispatchPolicy,
  renderUsageReport,
  renderCostReport,
  previewPlacement,
  previewPlacementWithUsage,
  renderDispatchResolution,
} from './dispatch/cli-render.js';

// L4-6 LIVE provider usage adapters (spec §2.6, §4.3; AC7, AC11): the real per-provider
// `ProviderUsageSource` implementations that turn the frozen seam into live measurement. Each is
// layered (passive-first), cached (program-data), and fail-loud, with ALL live I/O behind injected
// read-only seams (default = the real impl; tests inject fixtures so `pnpm test` stays hermetic).
//
//   - `ClaudeUsageSource` (Max): metadata `auth status` preflight → passive `statusLine` parse → a
//     gated, default-OFF idle usage-endpoint read. NO INFERENCE (AC11) — no `claude -p`, ever.
//   - `CodexUsageSource` (pro): `codex doctor` preflight → passive read-only `codex.rate_limits` from
//     `logs_2.sqlite` → optional active app-server read (detect & fall back) → session-jsonl fallback.
//   - `createProviderUsageSource` / `defaultProviderUsageSource` construct the real adapter with real
//     seams (AC7 — wired as default); `readProviderUsageCached` adds the §4.3 program-data cache
//     (reuses `isStale` + `observeUsage`); `isLiveE2EEnabled` gates the local live E2E (default OFF →
//     it SKIPS in the sandbox/CI). AC8: no new agent tool. AC10/P16: the policy is unchanged.
export type {
  ClaudeAccountInfo,
  ClaudeStatusLineReading,
  ClaudeUsageSourceDeps,
  ClaudeUsageSourceOptions,
  ClaudeCli,
  ClaudeOAuthFetch,
  DefaultClaudeDepsOptions,
} from './dispatch/claude-source.js';
export {
  ClaudeUsageSource,
  CLAUDE_DEFAULT_ACCOUNT,
  CLAUDE_AUTH_STATUS_ARGS,
  CLAUDE_USAGE_ENDPOINT,
  CLAUDE_OAUTH_TOKEN_ENDPOINT,
  CLAUDE_OAUTH_CLIENT_ID,
  CLAUDE_STATUSLINE_PATH_ENV,
  CLAUDE_OAUTH_REFRESH_TOKEN_ENV,
  CLAUDE_OAUTH_ACCESS_TOKEN_ENV,
  CLAUDE_OAUTH_TOKEN_ENV,
  CLAUDE_OAUTH_BACKOFF_MS_ENV,
  defaultClaudeDeps,
  parseClaudeAuthStatus,
  parseClaudeStatusLine,
} from './dispatch/claude-source.js';
export type {
  CodexAccountInfo,
  CodexRateLimitsReading,
  CodexUsageSourceDeps,
  CodexUsageSourceOptions,
  CodexCli,
  DefaultCodexDepsOptions,
} from './dispatch/codex-source.js';
export {
  CodexUsageSource,
  CODEX_DEFAULT_ACCOUNT,
  CODEX_DOCTOR_ARGS,
  CODEX_LOGS_DB_ENV,
  CODEX_SESSIONS_DIR_ENV,
  defaultCodexDeps,
  defaultCodexLogsDbPath,
  defaultCodexSessionsDir,
  openCodexLogsDb,
  parseCodexDoctor,
  parseCodexRateLimits,
  readLatestCodexRateLimits,
  readLatestRolloutRateLimits,
} from './dispatch/codex-source.js';
export type { UsageSourceAttempt } from './dispatch/usage-adapter-common.js';
export { buildSnapshot, layeredRead } from './dispatch/usage-adapter-common.js';
export type {
  ClaudeSourceConfig,
  CodexSourceConfig,
  CachedUsageReadOptions,
} from './dispatch/provider-source.js';
export {
  accountForProvider,
  createProviderUsageSource,
  defaultProviderUsageSource,
  defaultUsageSourceFactory,
  readProviderUsageCached,
  isLiveE2EEnabled,
  CACHE_SOURCE,
  CO_LIVE_E2E_ENV,
} from './dispatch/provider-source.js';

// L6a Phase A — authoritative role profiles + durable agent→role→parent projection + spawn rules
// (AC-L6a-1, AC-L6a-3, AC-L6a-8, AC-L6a-9, AC-L6a-10). Five base roles promoted from a seed
// toolset list to full permission profiles (mandate + writeScope + toolset + capabilities);
// `roleToolsets` in scoping.ts is now DERIVED from these authoritative profiles. A durable,
// event-sourced agent→role→parent projection (`roster` table) is replay-equal over L0. Structural
// spawn rules are a pure static check (no spawn runtime — that is L7).
export type { RoleProfile, WriteScope, Capability, RoleProfileViolation } from './roles/profile.js';
export { ROLE_PROFILES, profileFor, checkRoleProfileCompleteness } from './roles/profile.js';
// L6a roles events: `agent.registered` — the durable, validated record of which role an agent was
// dispatched under and who spawned it. Event-sourced over L0 (program-data only, Principle 12).
export type { AgentRegistered, AgentRecord } from './roles/events.js';
export {
  ROLES_EVENT_V,
  EVENT_AGENT_REGISTERED,
  AGENT_SCOPE_PREFIX,
  agentScope,
  agentRegisteredSchema,
  rolesSchemas,
  rolesUpcasters,
  makeAgentRegisteredEvent,
} from './roles/events.js';
// L6a roster projection: the `RosterProjector` folds `agent.registered` into a `roster` read-model
// table; `openRosterStore` is the typed facade (record + read-back + replay-equal).
export { RosterProjector } from './roles/roster-projector.js';
export type { RosterStore } from './roles/roster-store.js';
export { openRosterStore } from './roles/roster-store.js';
// L6a spawn rules: structural parent→child constraints from agent-roles.md. Pure static check —
// the runtime enforcement gate at spawn time is L7.
export type { SpawnViolation } from './roles/spawn-rules.js';
export { SPAWN_RULES, canSpawn, checkSpawnPlan, validateSpawnPlan } from './roles/spawn-rules.js';

// L6a Phase C — production role-based ParentResolver + escalation authority cut + co_kickback tool
// (AC-L6a-4, AC-L6a-5, AC-L6a-8 partial, AC-L6a-9). `roleParentResolver` is the production
// resolver that routes by role+tree (L6 PLUG-POINT in escalation.ts). `escalationDisposition` +
// `lowestCompetentResolver` implement the authority cut so only genuine intent reaches @operator.
// `co_kickback` is the coordinator/lead verb for returning a branch after ISSUES, tracked via the
// strike counter (reuses review/strikes.ts — no rebuilt loop). Fixes the coordinator→lead kickback
// gap recorded in `.co/issues/2026-06-08-coordinator-cannot-kickback-failed-merge-review.md`.
export { roleParentResolver } from './mail/escalation.js';
export type { EscalationTopic } from './roles/authority.js';
export { escalationDisposition, lowestCompetentResolver } from './roles/authority.js';

// L6a Phase B — fixed shipped sub-role set + narrow-only invariant + completeness discipline
// (AC-L6a-2, AC-L6a-8 partial, AC-L6a-9). Sub-roles specialize a base role's approach (soft) and
// may narrow but never widen its permission profile (hard). Researcher sub-roles carry the only
// real permission delta: `researcher:external` retains web-search; `codebase`/`diagnostic`/
// `decision` narrow it away. Coordinator and Lead have no sub-roles (owner tiers). All checks are
// pure — no I/O, no clock.
export type { SubRoleSpec } from './roles/sub-roles.js';
export { SUB_ROLES, subRolesFor, findSubRole, parseSubRoleId } from './roles/sub-roles.js';
export type { NarrowViolation } from './roles/narrow-only.js';
export { narrowOnly, validateSubRoles } from './roles/narrow-only.js';
export type { SubRoleViolation } from './roles/sub-role-completeness.js';
export { checkSubRoleCompleteness } from './roles/sub-role-completeness.js';

// L6a Phase D1 — non-destructive block-list registry + drift check + reactive-nudge catalog.
// The declared LIST and DATA only (Principle 6 — block only the workarounds, everything else
// is a nudge). Enforcement hooks (PreToolUse, Claude/Codex variants) and nudge injection are
// L7 typed stubs here; the production wiring lands in L7 (permissions.md:90-98 / :64-66).
export type { BlockCategory, BlockRule } from './permissions/block-list.js';
export { BLOCK_LIST, matchBlock } from './permissions/block-list.js';
export type { EnforcedConfig, DriftViolation } from './permissions/drift.js';
export { checkBlockListDrift, readEnforcedConfig } from './permissions/drift.js';
export type { NudgeRule } from './permissions/nudges.js';
export { NUDGE_CATALOG, nudgeFor, injectNudge } from './permissions/nudges.js';

/** Workspace-internal package identity; proves cross-package imports resolve. */
export const CORE_PACKAGE = '@co/core' as const;
