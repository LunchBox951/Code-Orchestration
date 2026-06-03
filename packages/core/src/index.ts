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

// L2-B1 first real tools: the canonical registry of the nine `co_*` tools (`buildCoreRegistry`),
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

/** Workspace-internal package identity; proves cross-package imports resolve. */
export const CORE_PACKAGE = '@co/core' as const;
