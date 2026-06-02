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

// Part D pristine-repo guard: proves no L0 op writes into a target repo's working
// tree or `.git` (freeze #7), by asserting byte-identity around a wrapped op.
export { assertRepoPristine } from './config/pristine.js';

// L1 mail bus: a typed, schema-validated, idempotent envelope over the L0 log that
// activates the four reserved fields, plus send/inbox and the in-process Delivery
// seam (the L7 plug-point is a typed stub). Seed types: chat + operator_message.
export type { MailEnvelope, DeliveredMail, MailType, MailMessage } from './mail/events.js';
export {
  OPERATOR,
  MAIL_SCOPE_PREFIX,
  MAIL_CHAT,
  MAIL_OPERATOR_MESSAGE,
  MAIL_TYPES,
  MAIL_EVENT_V,
  mailMessageSchema,
  mailSchemas,
  mailUpcasters,
  mailScope,
  mailRecipientForScope,
  makeMailEvent,
} from './mail/events.js';
export { MailProjector, ensureInboxTable } from './mail/mail-projector.js';
export type { Delivery } from './mail/delivery.js';
export { InProcessDelivery, LiveDeliveryStub } from './mail/delivery.js';
export type { MailStore, MailStoreOptions } from './mail/mail-store.js';
export { openMailStore } from './mail/mail-store.js';

/** Workspace-internal package identity; proves cross-package imports resolve. */
export const CORE_PACKAGE = '@co/core' as const;
