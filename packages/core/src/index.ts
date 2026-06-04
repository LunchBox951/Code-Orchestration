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
  MAIL_TYPES,
  EVENT_MAIL_READ,
  EVENT_MAIL_FORWARD,
  EVENT_MAIL_RETRACTED,
  MAIL_EVENT_V,
  mailMessageSchema,
  approvalResponseSchema,
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
// L3-C L5 plug-point: the typed review-trigger + merge gate `co_finish` stops short of. A loud-failing
// stub (never a silent no-op) marking the seam — the gated verbs are simply NOT BUILT in L3 (P7).
export type { FinishReviewGate } from './worktrees/review-trigger.js';
export { FinishReviewGateStub } from './worktrees/review-trigger.js';
// L3-D repository-relationship modes (AC-L3-4): per-project Owner / Contributor / Offline that reshape
// the publishing surface. The L3-ownable half — the read-only injectable remote-capability prober, the
// pure D2 detection order, override-beats-detection resolution (persisted in the config cascade, never
// the repo), the Offline "push/PR disabled" capability, and a minimal Contributor host-convention probe
// (PR-template presence + a sign-off signal). The gated verbs that ACT on a mode (co_merge/co_push/
// co_pr_merge, the fork→PR enactment, "gate in all three") + the rich CONTRIBUTING/PR-template parse are
// L5/L9 — a loud-failing typed stub (RepoModeGateStub), never built, no MCP tool declared (P4, P7).
export type {
  RepoMode,
  RemoteSignals,
  RemoteProbe,
  ResolveRepoModeDeps,
  RepoModeCapabilities,
  HostConventions,
  RepoModeGate,
} from './worktrees/repo-mode.js';
export {
  REPO_MODE_CONFIG_KEY,
  defaultRemoteProbe,
  detectRepoMode,
  resolveRepoMode,
  repoModeCapabilities,
  detectHostConventions,
  RepoModeGateStub,
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

/** Workspace-internal package identity; proves cross-package imports resolve. */
export const CORE_PACKAGE = '@co/core' as const;
