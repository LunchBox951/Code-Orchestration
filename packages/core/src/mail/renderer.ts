import type { DeliveredMail, MailType } from './events.js';
import { MAIL_APPROVAL, MAIL_ESCALATION, MAIL_REVIEW_RESPONSE } from './events.js';

/**
 * The renderer-registry seam (AC-L1-8, spec §3.3 freeze #9; docs/architecture/mail-bus.md
 * "Typed bus, rendered per audience"). The bus stays typed/structured for agent↔agent
 * (machine-legible, schema-checked); making a {@link DeliveredMail} HUMAN-legible is the
 * APP's job, not the agent's. L1 shipped the SEAM + a trivial generic default; SF-6
 * (AC-S15-12) fills the L9 plug-point with the per-type human CARDS (the approve/decline
 * card, the escalation problem-summary, the verdict card) — registered HERE in core so the
 * desktop paints them generically (no per-type field/label knowledge leaks into the adapter).
 *
 * Renderer is pure/in-memory: it reads only the already-read-back {@link DeliveredMail} and
 * returns text/data. It does NO I/O (no store, no repo, no clock), so it is replay-irrelevant
 * and safe to run anywhere (AC-L1-9 — a render wrapped in `assertRepoPristine` cannot write).
 */

/** Turns a delivered mail into a human view (markdown / structured text). */
export type MailRenderer = (mail: DeliveredMail) => string;

/** One key/value row of a {@link MailCardView} (e.g. `From → lead-7`, `Verdict → PASS`). */
export interface MailCardField {
  readonly label: string;
  readonly value: string;
}

/**
 * The structured, framework-free card view-model an adapter paints generically: a `title`,
 * presence-driven key/value `fields`, and the free-text prose `body`. It carries NO UI/markup
 * (the desktop owns escaping + layout); the per-type field/label LOGIC lives in core so the
 * adapter never special-cases a mail type (MC-2 / Principle 3).
 */
export interface MailCardView {
  /** Card heading — the mail subject. */
  readonly title: string;
  /** Key/value rows surfacing the structured/actionable facts present on the envelope. */
  readonly fields: readonly MailCardField[];
  /** Free-text prose — the mail body. */
  readonly body: string;
}

/** Turns a delivered mail into a structured {@link MailCardView} (the human card model). */
export type MailCardRenderer = (mail: DeliveredMail) => MailCardView;

/**
 * A per-type renderer registry. {@link render}/{@link renderCard} return the registered
 * renderer for the mail's type, else the default. {@link register}/{@link registerCard} are
 * the L9 PLUG-POINT — the built-in per-type CARDS are pre-registered in
 * {@link createRendererRegistry} (SF-6), so an adapter gets them without re-deriving them.
 */
export interface RendererRegistry {
  /** Render `mail` to a string with its type's registered renderer, falling back to the default. */
  render(mail: DeliveredMail): string;
  /**
   * Register a per-type STRING renderer (overrides the string default for that type). Kept for
   * back-compat alongside the structured {@link registerCard} path below.
   */
  register(type: MailType, renderer: MailRenderer): void;
  /**
   * Render `mail` to a structured {@link MailCardView} with its type's registered card renderer,
   * falling back to the generic {@link defaultMailCardRenderer}. The seam an adapter paints from.
   */
  renderCard(mail: DeliveredMail): MailCardView;
  /**
   * Register a per-type CARD renderer (overrides the card default for that type) — the L9
   * plug-point. Pre-seeded for `approval`/`escalation`/`review_response` in
   * {@link createRendererRegistry}; an adapter or test may register more.
   */
  registerCard(type: MailType, renderer: MailCardRenderer): void;
}

/**
 * The trivial generic default renderer. Renders ANY seed type to structured markdown from
 * the fields PRESENT on the envelope — `type`, `sender → recipient`, `subject`, `body`, and
 * any type-specific field it carries (e.g. an `approval_response`'s `decision`). It is
 * data-driven (presence checks), NEVER a per-type switch: there are deliberately no per-type
 * cards here (that is the L9 plug-point above). Adding a mail type needs no edit here.
 */
export const defaultMailRenderer: MailRenderer = (mail) => {
  const lines: string[] = [`### ${mail.type}`, `**${mail.sender} → ${mail.recipient}**`];
  // Type-specific / structured fields, included ONLY when present — driven by the data, not
  // by the type, so the default never special-cases a card for any one type.
  if (mail.kind != null) lines.push(`*${mail.kind}*`);
  if (mail.decision != null) lines.push(`**Decision:** ${mail.decision}`);
  lines.push('', `**Subject:** ${mail.subject}`, '', mail.body);
  return lines.join('\n');
};

/**
 * The generic, data-driven card renderer — the {@link defaultMailRenderer} twin for the
 * structured {@link MailCardView}. `title` = subject, `body` = prose, and `fields` are built
 * by PRESENCE (never a per-type switch): always `From`/`To`, then `Kind`/`Decision`/`Verdict`
 * only when the envelope carries them. Adding a mail type needs no edit here.
 */
export const defaultMailCardRenderer: MailCardRenderer = (mail) => {
  const fields: MailCardField[] = [
    { label: 'From', value: mail.sender },
    { label: 'To', value: mail.recipient },
  ];
  if (mail.kind != null) fields.push({ label: 'Kind', value: mail.kind });
  if (mail.decision != null) fields.push({ label: 'Decision', value: mail.decision });
  if (mail.reviewVerdict != null) fields.push({ label: 'Verdict', value: mail.reviewVerdict });
  return { title: mail.subject, fields, body: mail.body };
};

/**
 * `approval` → an approve/decline card. Surfaces who is asking + that a decision is required
 * (and the recorded `decision` if one is present); body = the request prose. The decision
 * BUTTONS are the adapter's typed quick-actions — this card lays the ask out for the operator.
 */
const approvalCardRenderer: MailCardRenderer = (mail) => {
  const fields: MailCardField[] = [
    { label: 'From', value: mail.sender },
    { label: 'Action', value: 'Approval required — approve or decline' },
  ];
  if (mail.decision != null) fields.push({ label: 'Decision', value: mail.decision });
  return { title: mail.subject, fields, body: mail.body };
};

/**
 * `escalation` → a readable problem summary. Surfaces the sender (the up-chain asker) + the
 * never-drop obligation (resolve down OR forward up); body = the problem context.
 */
const escalationCardRenderer: MailCardRenderer = (mail) => {
  const fields: MailCardField[] = [
    { label: 'From', value: mail.sender },
    { label: 'Action', value: 'Escalation — resolve or forward up-chain (never drop)' },
  ];
  return { title: mail.subject, fields, body: mail.body };
};

/**
 * `review_response` → the verdict card. Surfaces the `reviewVerdict` (PASS | ISSUES, or
 * `UNKNOWN` if somehow absent) PROMINENTLY as the first field + the sender; body = the verdict
 * prose. NOTE the mail TYPE is `review_response` (it carries the `reviewVerdict` field), which
 * the spec referred to as "review_verdict".
 */
const reviewResponseCardRenderer: MailCardRenderer = (mail) => {
  const fields: MailCardField[] = [
    { label: 'Verdict', value: mail.reviewVerdict ?? 'UNKNOWN' },
    { label: 'From', value: mail.sender },
  ];
  return { title: mail.subject, fields, body: mail.body };
};

/**
 * Register the built-in per-type CARD renderers (SF-6 / AC-S15-12) onto `registry`. These live
 * in CORE — the single source of truth — so every adapter (the desktop cockpit today) renders
 * the typed cards without re-deriving per-type field/label logic. {@link createRendererRegistry}
 * calls this for you; it is exported so the wiring is explicit + directly unit-testable.
 */
export function registerBuiltInMailCards(registry: RendererRegistry): void {
  registry.registerCard(MAIL_APPROVAL, approvalCardRenderer);
  registry.registerCard(MAIL_ESCALATION, escalationCardRenderer);
  registry.registerCard(MAIL_REVIEW_RESPONSE, reviewResponseCardRenderer);
}

/**
 * Create a renderer registry. `opts.default` overrides the fallback string renderer (defaults
 * to {@link defaultMailRenderer}); `opts.defaultCard` overrides the fallback card renderer
 * (defaults to {@link defaultMailCardRenderer}). Per-type string renderers are added later via
 * {@link RendererRegistry.register}; the built-in per-type CARDS are pre-registered here (SF-6),
 * so `renderCard` returns a real per-type card for `approval`/`escalation`/`review_response`
 * and the generic default card for everything else.
 */
export function createRendererRegistry(opts?: {
  default?: MailRenderer;
  defaultCard?: MailCardRenderer;
}): RendererRegistry {
  const fallback = opts?.default ?? defaultMailRenderer;
  const fallbackCard = opts?.defaultCard ?? defaultMailCardRenderer;
  const perType = new Map<MailType, MailRenderer>();
  const perTypeCard = new Map<MailType, MailCardRenderer>();
  const registry: RendererRegistry = {
    render(mail) {
      return (perType.get(mail.type) ?? fallback)(mail);
    },
    register(type, renderer) {
      perType.set(type, renderer);
    },
    renderCard(mail) {
      return (perTypeCard.get(mail.type) ?? fallbackCard)(mail);
    },
    registerCard(type, renderer) {
      perTypeCard.set(type, renderer);
    },
  };
  registerBuiltInMailCards(registry);
  return registry;
}
