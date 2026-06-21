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

// AC-S9-3 holistic recovery: reconstruct every read-model from the event log alone.
// No repo dependency — reads only program-data (CO_DATA_DIR). Byte-equal to live (AC-L0-2).
export {
  buildProjectProjectors,
  buildGlobalProjectors,
  buildProjectDecode,
  buildGlobalDecode,
  recoverProjectStore,
  recoverGlobalStore,
} from './replay/recovery.js';

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
// seam (whose L7 Conductor-side plug-point is now the real `LiveDelivery`). W3 adds actionable/informational
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
  TURN_KICKOFF_CORRELATION_PREFIX,
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
  turnKickoffCorrelationId,
  isTurnKickoffMail,
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
export type {
  Delivery,
  LiveDeliveryOptions,
  WakeRecipient,
  InjectToRecipient,
} from './mail/delivery.js';
// L7 C2 — `LiveDelivery` is the real Conductor-side delivery (replaces the former throwing
// `LiveDeliveryStub`): it DELEGATES persistence to a composed `InProcessDelivery`, then wakes the
// recipient + injects unread actionable mail into its live pty via injected seams.
export { InProcessDelivery, LiveDelivery } from './mail/delivery.js';
export type {
  MailStore,
  MailStoreOptions,
  DeliveryFactory,
  ReplyDraft,
} from './mail/mail-store.js';
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
// typed/structured for agents; making a DeliveredMail human-legible is the app's job. SF-6
// (AC-S15-12) fills the L9 plug-point: the structured MailCardView model + the built-in per-type
// CARD renderers (approval/escalation/review_response), registered in core so adapters paint generically.
export type {
  MailRenderer,
  RendererRegistry,
  MailCardField,
  MailCardView,
  MailCardRenderer,
} from './mail/renderer.js';
export {
  createRendererRegistry,
  defaultMailRenderer,
  defaultMailCardRenderer,
  registerBuiltInMailCards,
} from './mail/renderer.js';
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
export type { ToolJsonSchemaObject } from './tools/index.js';
export {
  toolInputJsonSchema,
  toolInputShape,
  toolOutputJsonSchema,
  toolOutputShape,
} from './tools/index.js';
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
// fail-loud on a phantom tool. L6a rosters/sub-roles are layered on top for caller authorization.
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
// L8 operator cleanup/recovery verbs (AC-S9-5): CleanupGateImpl fills the named loud-fail stub.
// Operator-only — none of these are ToolSpecs; the completeness gate stays green by construction.
export type {
  CleanupGate,
  CleanupDryRun,
  CleanupExecuted,
  CleanupReport,
  UnstickReport,
  MergeProbeSeam,
  WorktreeRepairSeam,
  AgentRouterSeam,
  CleanupGateDeps,
} from './worktrees/cleanup-gate.js';
export { CleanupGateStub, CleanupGateImpl } from './worktrees/cleanup-gate.js';
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
// Contributor fork→PR host-convention probe: minimal Phase C `detectHostConventions` (presence +
// sign-off indicator); rich CONTRIBUTING/PR-template parse via `parseHostConventions` (WT4-HC, L9).
export type {
  RepoMode,
  RemoteSignals,
  RemoteProbe,
  ResolveRepoModeDeps,
  RepoModeCapabilities,
  HostConventions,
  ParsedHostConventions,
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
  parseHostConventions,
  CoRepoModeGate,
} from './worktrees/repo-mode.js';
export type { GitReader } from './worktrees/detect-base.js';
export {
  detectBaseRef,
  detectCurrentBranchTarget,
  detectIntegrationTarget,
  defaultGitReader,
  defaultGitRawReader,
  resolveRefSha,
} from './worktrees/detect-base.js';
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
// core (CoReviewGate) the coordinator-or-lead co_merge consumes. Nothing reaches a merge without a recorded
// PASS or an explicit audited `@operator` override; the verdict is a structured RECORDED EVENT
// (Principle 5), never a prose blob or a shell exit
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
// production resolver is wired into co_merge / co_push / co_pr_merge through the caller's roster
// parent. A PASS resets the run (projector: PASS verdict → strikes = 0). Headless-testable over
// injectable seams (StrikeEnforcementDeps / StrikeEnforcementContext).
export type {
  StrikeEnforcementDeps,
  StrikeEnforcementContext,
  StrikeNotificationPlan,
  StrikePolicyAction,
} from './review/strikes.js';
export {
  REVIEW_ROUND_BUDGET_KEY,
  REVIEW_ROUND_BUDGET_DEFAULT,
  consecutiveStrikes,
  nextReviewAction,
  resolveReviewRoundBudget,
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
  buildHumanReviewVerdict,
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
  resolveReviewSpecRefFromStore,
  renderReviewSpecRef,
  resolveSpecRefFromStore,
  taskIdFromLockedSpecRef,
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

// Live worker-BENCHMARK scenarios — pluggable, OBJECTIVELY-graded coding tasks for the `CO_LIVE_E2E`
// host-live worker benchmark (the `@co/mcp` driver hosts a real implementer agent, this module owns the
// task prompt + the executed-artifact evaluator). Pure core (no host graph), so the adapter imports it
// from this barrel (AC-L2-1). See docs/worker-benchmark.md.
export type {
  ArtifactCheck,
  BenchmarkScenario,
  BenchmarkTaskContext,
} from './bench/worker-scenarios.js';
export {
  WORKER_BENCH_SCENARIOS,
  addModuleScenario,
  getScenario,
  importFreshModule,
} from './bench/worker-scenarios.js';

// Multi-level ORCHESTRATION benchmark (the centerpiece v1 proof): the `@co/mcp` driver hosts the real
// coordinator→lead→implementer chain and merges up; this module owns the general-task prompts + the
// executed-merge oracle. Pure core (no host graph). See docs/orchestration-benchmark.md.
export type {
  OrchestrationScenario,
  OrchestrationTaskContext,
  ImplementerSubtask,
  LeadIntegration,
} from './bench/orchestration-scenarios.js';
export {
  ORCHESTRATION_SCENARIOS,
  calcLibScenario,
  getOrchestrationScenario,
} from './bench/orchestration-scenarios.js';
export type {
  ProviderMode,
  RunFidelity,
  StopReason,
  AgentRunMetric,
  MergeOutcome,
  OrchestrationRunInput,
  OrchestrationScorecard,
} from './bench/orchestration-metrics.js';
export { summarizeRun, toJsonl, renderScorecard } from './bench/orchestration-metrics.js';

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
export type { AgentRegistered, AgentRemoved, AgentRecord } from './roles/events.js';
export {
  ROLES_EVENT_V,
  EVENT_AGENT_REGISTERED,
  EVENT_AGENT_REMOVED,
  AGENT_SCOPE_PREFIX,
  agentScope,
  agentRegisteredSchema,
  agentRemovedSchema,
  rolesSchemas,
  rolesUpcasters,
  makeAgentRegisteredEvent,
  makeAgentRemovedEvent,
} from './roles/events.js';
// L6a roster projection: the `RosterProjector` folds `agent.registered` / `agent.removed` into a
// `roster` read-model table; `openRosterStore` is the typed facade (record + read-back + replay-equal). The
// `selectAllAgents`/`selectAgent` read-model selectors are exported so a post-recovery reader (the L7
// Conductor daemon) can join the recovered roster to the recovered session set under one store handle.
export { RosterProjector, selectAllAgents, selectAgent } from './roles/roster-projector.js';
export type { RosterStore } from './roles/roster-store.js';
export { openRosterStore } from './roles/roster-store.js';
// L6a spawn rules: structural parent→child constraints from agent-roles.md. Pure static check —
// the runtime enforcement gate at spawn time is L7.
export type { SpawnViolation } from './roles/spawn-rules.js';
export { SPAWN_RULES, canSpawn, checkSpawnPlan, validateSpawnPlan } from './roles/spawn-rules.js';
// L6a subtree traversal: post-order descent walk over the flat roster (children before parents),
// used by cascade-delete and other subtree operations. Stable ordering via registeredTs+agentId.
export { descendantsLeafFirst } from './roles/subtree.js';
// L3-E branch-state git helpers: merged detection + dirty-worktree check + atomic snapshot commit.
// Pure over injectable git seams (defaultGitReader/defaultGitExec); testable with fake readers/execs.
export {
  isBranchMerged,
  isWorktreeDirty,
  snapshotDirtyWorktree,
} from './worktrees/branch-state.js';

// L6a Phase C — production role-based ParentResolver + escalation authority cut + co_kickback tool
// (AC-L6a-4, AC-L6a-5, AC-L6a-8 partial, AC-L6a-9). `roleParentResolver` is the production
// resolver that routes by role+tree (L6 PLUG-POINT in escalation.ts). `escalationDisposition` +
// `lowestCompetentResolver` implement the authority cut so only genuine intent reaches @operator.
// `co_kickback` is the coordinator/lead verb for returning a branch after ISSUES, tracked via the
// strike counter (reuses review/strikes.ts — no rebuilt loop). AC-L6a-5 covers coordinator/lead
// kickback authority and review-budget escalation.
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
// L7 Phase P1 — per-pane isolated launch-config builder + real readEnforcedConfig.
// The declared LIST and DATA only (Principle 6 — block only the workarounds, everything else
// is a nudge). This slice (L7) makes the enforcement CONFIG and `injectNudge` real —
// `buildPaneLaunchConfig` emits the isolated per-pane `--disallowedTools`/`CODEX_HOME` config and
// `readEnforcedConfig` reads it back drift-clean; the LIVE host-side block-enforcement E2E is the
// operator's proof (AC-L7-6 [host-live], permissions.md:90-98 / :64-66).
export type { BlockCategory, BlockRule, MatchBlockOptions } from './permissions/block-list.js';
export { BLOCK_LIST, matchBlock } from './permissions/block-list.js';
export type { EnforcedConfig, DriftViolation } from './permissions/drift.js';
export { checkBlockListDrift, readEnforcedConfig } from './permissions/drift.js';
export type { PaneIdentity, PaneLaunchConfig } from './permissions/pane-launch-config.js';
export { buildPaneLaunchConfig } from './permissions/pane-launch-config.js';
export type { NudgeRule } from './permissions/nudges.js';
export { NUDGE_CATALOG, nudgeFor, injectNudge } from './permissions/nudges.js';

// L6a Phase D2 — pre-publish identity guard + worktree persona-pinning (AC-L6a-7).
// The permanent fix for DCO leaks: (1) a pure pre-publish check that refuses a push or PR-merge if
// any commit's author/committer/Signed-off-by is outside the configured persona allowlist, or lacks a
// valid Signed-off-by when the allowlist is empty (fail-loud, Principle 9); (2) `resolvePersona`
// consumed by `slingWorktree` to pin the local git identity in every new sandbox immediately after
// `git worktree add`, so `git commit -s` never falls through to global config. Both sides are
// config-driven (empty allowlist → DCO-only guard; undefined persona → pinning no-op). Commit-range
// git I/O is behind `CommitIdentityReader`; local merge-commit identity inspection is behind
// `GitConfigIdentityReader` (AC-L6a-9).
export type {
  PersonaIdentity,
  CommitIdentity,
  IdentityViolation,
  CommitIdentityReader,
  GitConfigIdentityReader,
} from './permissions/identity-guard.js';
export {
  IDENTITY_PERSONA_ALLOWLIST_KEY,
  IDENTITY_PERSONA_KEY,
  resolvePersonaAllowlist,
  resolvePersona,
  checkPublishIdentities,
  checkMergeCommitIdentity,
  defaultCommitIdentityReader,
  defaultGitConfigIdentityReader,
} from './permissions/identity-guard.js';

// L6b F1 — durable spec record store + co_spec_get (broad spec visibility, F4 fix).
// `criterionSchema`/`Criterion`: the shared acceptance-criterion type (plans task imports it too).
export type { Criterion } from './specs/criteria-schema.js';
export { criterionSchema } from './specs/criteria-schema.js';
// Spec events: `spec.drafted` / `spec.locked` / `spec.archived` — event-sourced over L0.
export type { SpecDrafted, SpecLocked, SpecArchived, SpecRecord } from './specs/events.js';
export {
  SPECS_EVENT_V,
  EVENT_SPEC_DRAFTED,
  EVENT_SPEC_LOCKED,
  EVENT_SPEC_ARCHIVED,
  SPEC_SCOPE_PREFIX,
  specScope,
  specDraftedSchema,
  specLockedSchema,
  specArchivedSchema,
  specsSchemas,
  specsUpcasters,
  makeSpecDraftedEvent,
  makeSpecLockedEvent,
  makeSpecArchivedEvent,
} from './specs/events.js';
// Spec projection: the `SpecsProjector` folds spec events into a `specs` read-model table.
export { SpecsProjector } from './specs/specs-projector.js';
// Spec store facade: `openSpecStore` is the typed facade (record + read-back + replay-equal).
export type { SpecStore } from './specs/specs-store.js';
export { openSpecStore } from './specs/specs-store.js';

// Shared spec-lock primitive: the single source of truth for the lock semantics (not-found /
// non-draft / fuzzy-criteria refusals → recordLock), consumed by the `co_spec_lock` MCP tool and
// the public `co spec lock` operator CLI so the two surfaces cannot drift.
export { lockSpec } from './specs/lock-spec.js';

// L6b F2 — the PURE criterion validator (D2): the structural acceptance-criteria gate. `validateCriteria`
// returns one violation per failed criterion (`[]` ⇒ all valid); the PRIMARY check is a wired `verify`
// command present (it never hard-codes a project command), the SECONDARY is a conservative `VACUOUS_PHRASES`
// nudge. The plans task imports it; `co_spec_lock` runs it as the lock-time RG-4 join (fuzzy criteria
// cannot be locked).
export type { CriterionViolation } from './plans/criteria.js';
export { validateCriteria, VACUOUS_PHRASES } from './plans/criteria.js';

// L6b E1 — durable plan record store + co_plan_ingest (validator-gated).
// Plan events: `plan.drafted` / `phase.status.changed` / `phase.verified` / `plan.replanned`.
export type {
  PhaseNode,
  PhaseStatus,
  PhaseRecord,
  PlanRecord,
  PlanDrafted,
  PhaseStatusChanged,
  PhaseVerified,
  PlanReplanned,
  TaskCompleted,
} from './plans/events.js';
export {
  PLANS_EVENT_V,
  EVENT_PLAN_DRAFTED,
  EVENT_PHASE_STATUS_CHANGED,
  EVENT_PHASE_VERIFIED,
  EVENT_PLAN_REPLANNED,
  EVENT_TASK_COMPLETED,
  PLAN_SCOPE_PREFIX,
  PHASE_STATUSES,
  phaseStatusSchema,
  phaseNodeSchema,
  planDraftedSchema,
  phaseStatusChangedSchema,
  phaseVerifiedSchema,
  planReplannedSchema,
  taskCompletedSchema,
  plansSchemas,
  plansUpcasters,
  planScope,
  makePlanDraftedEvent,
  makePhaseStatusChangedEvent,
  makePhaseVerifiedEvent,
  makePlanReplannedEvent,
  makeTaskCompletedEvent,
} from './plans/events.js';
// Plan projection: the `PlansProjector` folds plan events into `plans` and `plan_phases` read-model tables.
export { PlansProjector } from './plans/plans-projector.js';
// Plan store facade: `openPlanStore` is the typed facade (record + read-back + replay-equal).
export type { PlanStore } from './plans/plans-store.js';
export { openPlanStore } from './plans/plans-store.js';

// L6b E3/D5 — the PHASE-READINESS FOLD (the riskiest unit): a pure, clock-free, deterministic
// decision computing whether a phase (and the task) is ready = workersComplete ∧ phaseVerifiedPass.
// Reviewers are EXCLUDED from completion accounting; a worker is complete iff its BRANCH is merged
// (never by process-state) — the prototype's two named bugs, each with a regression test. The fold
// READS `verifiedPass` (the single green phase.verified); it does NOT re-run criteria or call
// validateCriteria. `co_phase_status` (coordinator+lead, read-only) assembles the inputs from the
// stores via the shared branch-resolution convention (`resolveAgentBranch`/`branchMerged`).
export type {
  PhaseWorkerInput,
  PhaseReadinessInput,
  PhaseReadiness,
  TaskReadiness,
} from './plans/readiness.js';
export { foldPhaseReadiness, foldTaskReadiness } from './plans/readiness.js';
export { resolveAgentBranch, branchMerged } from './plans/worker-branch.js';

// L6b E4 — the MAX-ACTIVE-CHILDREN cap (distinct from review/serialize.ts's per-target merge lock,
// the other E4 primitive). `resolveMaxActiveChildren` is the config-cascade reader (default 2, clones
// `resolveReviewRoundBudget`); `activeChildCount`/`childCapDisposition` are the PURE policy — active
// children are non-reviewer children whose branch is not yet merged; at/over the cap a new dispatch
// QUEUES → WAITING (a first-class `{queued:true}`, never a throw). Enforced at the co_sling dispatch
// decision so excess dispatches WAIT.
export type { CapChild, ChildCapDisposition } from './plans/child-cap.js';
export {
  MAX_ACTIVE_CHILDREN_KEY,
  MAX_ACTIVE_CHILDREN_DEFAULT,
  resolveMaxActiveChildren,
  activeChildCount,
  childCapDisposition,
} from './plans/child-cap.js';

// ── L6b G — ISSUES: bottom-up agent friction as durable records (specs-and-issues.md) ──────────
// Events + record: the `detect → diagnose → dedup → file → (opt-in) self-assign` pipeline, one
// stream per issue (`issue:<id>`), replay-equal.
export type {
  IssueCaptured,
  IssueDiagnosed,
  IssueFiled,
  IssueSelfAssigned,
  IssueRecord,
  IssueState,
  IssueDestination,
} from './issues/events.js';
export {
  EVENT_ISSUE_CAPTURED,
  EVENT_ISSUE_DIAGNOSED,
  EVENT_ISSUE_FILED,
  EVENT_ISSUE_SELF_ASSIGNED,
  ISSUE_DESTINATIONS,
  issueScope,
  makeIssueCapturedEvent,
  makeIssueDiagnosedEvent,
  makeIssueFiledEvent,
  makeIssueSelfAssignedEvent,
  issuesSchemas,
  issuesUpcasters,
} from './issues/events.js';
export { IssuesProjector, findDuplicateIssue } from './issues/issues-projector.js';
export type { IssueStore } from './issues/issues-store.js';
export { openIssueStore } from './issues/issues-store.js';
// Layered opt-in (capture → publish → self-assign, all OFF by default) + the scrub pass + the
// per-post-approval outward filing gate (the first real consumer of mail/approval.ts).
export type { IssueOptIns } from './issues/opt-in.js';
export {
  ISSUE_CAPTURE_KEY,
  ISSUE_PUBLISH_KEY,
  ISSUE_SELF_ASSIGN_KEY,
  layerIssueOptIns,
  resolveIssueOptIns,
} from './issues/opt-in.js';
export { scrubIssueText } from './issues/scrub.js';
export {
  ISSUE_CO_REPO_KEY,
  issueFilingApprovalKey,
  buildIssueFilingApproval,
  findIssueFilingApproval,
  assertIssueDestinationAllowed,
  ghIssueCreateArgs,
  renderIssueBody,
  fileIssueOutward,
} from './issues/filing.js';

// ── L6b H — RESEARCH: the locator map contract + durable finalize records (research.md) ────────
// The STATIC half of the codebase locator: the map output contract (files + one-line whys + key
// symbols + read order; pointers, not a dump) and the replay-safe finalize record. Research
// DISPATCH (spawning the researcher) is L7's Conductor.
export type {
  LocatorMap,
  LocatorMapEntry,
  LocatorMapViolation,
  CitedAnswer,
} from './research/map-contract.js';
export {
  locatorMapSchema,
  locatorMapEntrySchema,
  citedAnswerSchema,
  checkLocatorMap,
} from './research/map-contract.js';
export type { ResearchFinalized, ResearchRecord, ResearchKind } from './research/events.js';
export {
  EVENT_RESEARCH_FINALIZED,
  RESEARCH_KINDS,
  researchScope,
  makeResearchFinalizedEvent,
  researchSchemas,
  researchUpcasters,
} from './research/events.js';
export { ResearchProjector } from './research/research-projector.js';
export type { ResearchStore } from './research/research-store.js';
export { openResearchStore } from './research/research-store.js';

// L7 B0 — durable session record: event + projector + store (AC-L7-7 sandbox).
// One `session.created` per agent per pane; a second active session for the same agent fails loud
// until a later explicit `session.ended` event exists, preventing hidden duplicate hosts.
export type {
  ResumeHandle,
  SessionCreated,
  SessionEnded,
  SessionRecord,
} from './session/events.js';
export {
  SESSION_EVENT_V,
  EVENT_SESSION_CREATED,
  EVENT_SESSION_ENDED,
  SESSION_SCOPE_PREFIX,
  sessionScope,
  sessionCreatedSchema,
  sessionEndedSchema,
  sessionSchemas,
  sessionUpcasters,
  makeSessionCreatedEvent,
  makeSessionEndedEvent,
} from './session/events.js';
// The `selectAllSessions`/`selectSession`/`rowToSessionRecord` read-model selectors are exported so a
// post-recovery reader (the L7 Conductor daemon) can reconstruct the RUNNING set (not-yet-ended
// sessions) from the recovered project store and join it to the roster.
export {
  SessionProjector,
  selectAllSessions,
  selectSession,
  rowToSessionRecord,
} from './session/session-projector.js';
export type { SessionStore } from './session/session-store.js';
export { openSessionStore } from './session/session-store.js';

// Stage 14 P1 (KEYSTONE) — the operator-only START PRIMITIVE: launch a ROOT coordinator (no warm
// parent) from a prompt OR a draft spec. Provisions the root's worktree, registers it in the roster
// (coordinator/@operator), and seeds the ACTIONABLE `clarify_request` kickoff — but mints NO session
// (the daemon cold-starts the registered-but-unhosted root). The `co-mcp start-session` verb and the
// P4 desktop operator-IPC path both call THIS core primitive (single source of truth).
export type {
  StartCoordinatorSessionParams,
  StartCoordinatorSessionDeps,
  StartCoordinatorSessionResult,
} from './session/start-coordinator-session.js';
export { startCoordinatorSession, rootCoordinatorId } from './session/start-coordinator-session.js';
export { slugifyCoordinatorName, coordinatorIdFromParts } from './session/coordinator-id.js';
// A5 cascade-delete primitive: tear down a coordinator's whole subtree leaf-first, archiving
// unmerged branches, ending sessions, and removing roster rows. Collects errors across all agents
// and throws a single AggregateError after the full pass (best-effort-complete, then loud).
export type {
  DeleteAgentSubtreeDeps,
  DeleteAgentSubtreeResult,
} from './session/delete-agent-subtree.js';
export { deleteAgentSubtree, ARCHIVE_TTL_MS } from './session/delete-agent-subtree.js';

// Archive store: event-sourced record of unmerged coordinator branches (cascade-delete writes,
// reaper purges expired records, IPC verbs list/restore/purge). Scope: `archive:`. Table: `archive`.
export type { ArchiveAppended, ArchiveRemoved, ArchiveRecord } from './archive/events.js';
export {
  ARCHIVE_EVENT_V,
  EVENT_ARCHIVE_APPENDED,
  EVENT_ARCHIVE_REMOVED,
  ARCHIVE_SCOPE_PREFIX,
  archiveScope,
  archiveAppendedSchema,
  archiveRemovedSchema,
  archiveSchemas,
  archiveUpcasters,
  makeArchiveAppendedEvent,
  makeArchiveRemovedEvent,
} from './archive/events.js';
export {
  ArchiveProjector,
  selectArchive,
  selectAllArchive,
  selectExpired,
} from './archive/archive-projector.js';
export type { ArchiveStore } from './archive/archive-store.js';
export { openArchiveStore } from './archive/archive-store.js';
// A6 archive reaper: purges expired unmerged coordinator branches — collects branch-deletion
// errors and aggregates them loudly (Principle 9). Injected clock (nowMs) for replay determinism.
export type { ReapArchivesDeps } from './session/reap-archives.js';
export { reapExpiredArchives } from './session/reap-archives.js';

// L7 B0 — PtyHost / FakePty contract (FROZEN cross-phase interface — B1/C1/C2/E1/P1 all import).
// PtyHost.spawn() returns a Pane; NodePtyHost (B1) wraps a real node-pty IPty over this interface.
// FakePty is the in-sandbox test double: no real binaries, no timers, deterministic CI.
export type { PrelaunchFile, SpawnSpec, PtyExit, Pane, PtyHost } from './pty/pty-host.js';
export type { FakePtyPane } from './pty/fake-pty.js';
export { FakePty } from './pty/fake-pty.js';

// L7 B1 — startup interstitial state machine (PURE, provider-aware): classify a freshly-spawned
// claude/codex TUI's startup dialogs from the whitespace-normalized output, and drive a Pane through
// them to ready (authed) or a terminal login menu. Sandbox-tested over FakePty fixtures.
// `Provider` is the canonical project-wide enum, already exported from the dispatch layer above —
// the classifier reuses it, so only the pty-specific types are surfaced here.
export type { StartupInterstitialName, StartupPhase } from './pty/startup-classifier.js';
export { classifyStartup, normalizeStartupOutput } from './pty/startup-classifier.js';
export type { StartupOutcome } from './pty/startup-driver.js';
export { driveToReady } from './pty/startup-driver.js';

// Stage 15 P-F — shared provider startup-byte fixtures (the B1 signatures, with `[documented]` /
// `[synthesized]` / `[host-live]` provenance tags). Lifted out of `startup-classifier.test.ts` so
// BOTH the classifier tests AND the mcp host-proof / FakeProvider harness drive ONE source of truth
// (no divergent re-declared copies). Non-test module: shipped in `src` like FakePty.
export {
  CLAUDE_TRUST,
  CLAUDE_READY,
  CLAUDE_READY_CURSOR_POSITIONED,
  CLAUDE_READY_STATUS_STRIP,
  CLAUDE_READY_BYPASS_STRIP,
  CLAUDE_THEME,
  CLAUDE_LOGIN,
  CLAUDE_OAUTH_LOGIN,
  CODEX_UPDATE,
  CODEX_TRUST,
  CODEX_HOOKS_REVIEW,
  CODEX_READY,
  CODEX_READY_CURRENT,
  CODEX_MCP_STARTING,
  CODEX_SIGNIN,
} from './pty/startup-fixtures.js';

// L7 B1 — NodePtyHost: the one real-binary adapter, implementing PtyHost over node-pty. node-pty is
// reached only via a lazy injected loader behind a local type shim, so the gate is green without the
// native module present; the live binary reaching ready is the operator's host-side proof.
export type {
  IDisposableLike,
  IPtyExitEvent,
  IPtyForkOptionsLike,
  IPtyLike,
  NodePtyModule,
  NodePtyModuleLoader,
} from './pty/node-pty-host.js';
export { NodePtyHost } from './pty/node-pty-host.js';

// L7 C2 — mail-injection protocol (PURE over a Pane): drive a live session to act on ONE mail exactly
// once (bracketed-paste for multi-line + settle + echo-verify + continuous dialog-watcher). Plus the
// reusable continuous permission/approval dialog-watcher it composes. Sandbox-tested over FakePty.
export type { InjectMailOptions } from './pty/mail-injector.js';
export { injectMail } from './pty/mail-injector.js';
export type { DialogName, DialogMatch, WatchDialogsOptions } from './pty/dialog-watcher.js';
export { classifyDialog, watchDialogs } from './pty/dialog-watcher.js';

// SF-2 (Stage 9 tail L7-F) — mid-turn STEER protocol (PURE over a Pane): the operator steers a live
// agent (answer / redirect / interrupt) WITHOUT tearing it down (Principle 1 — the turn continues).
// Reuses injectMail for the text steers; `interrupt` sends the provider's interrupt key. Sandbox-tested.
export type { Steer, SteerOptions } from './pty/steer.js';
export { steerPane } from './pty/steer.js';

// L7 C2 — turn-end detector (PURE): emits an IDLE / turn-boundary signal ONLY. turn-end ≠ work-end —
// it corroborates completion (which stays keyed to co_finish/worker_done) but NEVER emits it.
export type {
  DetectorEvent,
  IdleSignal,
  TurnEndConfig,
  TurnEndResult,
} from './pty/turn-end-detector.js';
export {
  detectTurnEnd,
  parseOsc0Titles,
  QUIET_WINDOW_MS,
  COMPLETION_VERBS,
} from './pty/turn-end-detector.js';

// L7 E1 — liveness watchdog: PURE `alive | wedged | dead` classifier (+ a distinct silent-stop break)
// over the P4 byte signatures, and LivenessWatchdog, the injected-seam escalation driver (break →
// injectNudge → STUCK on persistence). Reuses detectTurnEnd + FakePty; the STUCK transition is an
// injected monitor seam (integration owns the live agent-state machine / `co unstick`).
export type {
  Liveness,
  BreakKind,
  BreakInfo,
  LivenessInput,
  LivenessConfig,
  LivenessVerdict,
  BreakSignal,
  MarkStuck,
  InjectNudgeFn,
  MonitorSeams,
} from './pty/liveness-watchdog.js';
export {
  classifyLiveness,
  LivenessWatchdog,
  WEDGE_MS,
  SILENT_STOP_TRIGGER,
} from './pty/liveness-watchdog.js';

// Stage 9 P4 (L8-WDOG) — silent-stop watchdog-reconcile loop (PURE + seam-injected). See reconcile.ts.
export type {
  RunningAgent,
  LivenessProbe,
  ReconcileSeams,
  ReconcileAssessment,
  ReconcileError,
  ReconcileTickResult,
} from './pty/reconcile.js';
export { ReconcileLoop } from './pty/reconcile.js';

// Stage 9 P6 (L8-B + L8-OBS) — `co doctor` structural health suite + observability rollup.
// Operator-only: NOT agent MCP tools; completeness gate stays green by construction.
// The P7 CLI exposes these to the operator. ([host-live] D5: the real provider probe seam.)
export type {
  DoctorStatus,
  DoctorCheck,
  DoctorReport,
  ProviderProbeResult,
  ProviderProbeCommandResult,
  ProviderProbeCommand,
  DefaultProviderProbeOptions,
  ProviderProbeSeam,
  DoctorDeps,
} from './doctor/doctor.js';
export { REQUIRED_CAPABILITIES, defaultProviderProbe, runDoctor } from './doctor/doctor.js';
export type { ReviewSummary, ObservabilitySnapshot } from './doctor/observability.js';
export { queryObservability } from './doctor/observability.js';
// Stage 10 P3 (CTL-OBS) — the LIVE observability overlay: the static rollup ⊕ an engine-filled
// {@link LiveStateProvider} seam (warm/paused/stuck + outstanding mail). The merge is core (transport-
// agnostic, cli-callable); `@co/mcp` fills the seam in the daemon process. NOT an agent MCP tool.
export type {
  LiveAgentState,
  LiveStateProvider,
  AgentLiveView,
  LiveObservabilitySnapshot,
} from './doctor/observability.js';
export { queryLiveObservability } from './doctor/observability.js';

// Stage 11 P1 (OP-IPC) — the TRANSPORT-AGNOSTIC operator-IPC contract: the request/response + push
// notification shapes the cross-process desktop app and the `co-mcp serve` daemon agree on, referencing
// ONLY core types. Pure types/interfaces + constant method maps — no I/O, no socket work (that is the
// server/client in `@co/mcp`). Registers ZERO agent MCP tools — the IPC is filesystem-permissioned,
// never an agent surface (Principle 4 + D4; AC-S11-6).
export type {
  OperatorIpcMethod,
  OperatorMailRef,
  ApprovalReply,
  OperatorIpcSurface,
  OperatorIpcTick,
  OperatorIpcTranscript,
  TranscriptTail,
  ReviewContext,
  ReviewContextResolved,
  ReviewDiff,
  ReviewCriteria,
  OperatorUnavailableReason,
  OperatorObservation,
  OperatorIpcConnectionState,
  StartSessionParams,
  StartSessionResult,
} from './operator-ipc/contract.js';
export {
  OPERATOR_IPC_METHODS,
  OPERATOR_IPC_TICK,
  OPERATOR_IPC_TRANSCRIPT,
} from './operator-ipc/contract.js';

// AC-S15-7 — read-only local branch + locally fetched PR-ref data for the desktop Source view.
// Offline-safe: uses local git refs only — no gh and no network.
export type { BranchInfo } from './source/list-branches.js';
export { listBranches } from './source/list-branches.js';
export type { PullRequestInfo } from './source/list-pull-requests.js';
export { listPullRequests } from './source/list-pull-requests.js';

/** Workspace-internal package identity; proves cross-package imports resolve. */
export const CORE_PACKAGE = '@co/core' as const;
