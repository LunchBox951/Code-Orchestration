import type { DeliveredMail, MailType } from './events.js';

/**
 * The renderer-registry seam (AC-L1-8, spec §3.3 freeze #9; docs/architecture/mail-bus.md
 * "Typed bus, rendered per audience"). The bus stays typed/structured for agent↔agent
 * (machine-legible, schema-checked); making a {@link DeliveredMail} HUMAN-legible is the
 * APP's job, not the agent's. L1 ships the SEAM + a trivial generic default so the seam is
 * live; the per-type human cards (the question card, the approve/decline card, …) are L9.
 *
 * Renderer is pure/in-memory: it reads only the already-read-back {@link DeliveredMail} and
 * returns text. It does NO I/O (no store, no repo, no clock), so it is replay-irrelevant and
 * safe to run anywhere (AC-L1-9 — a render wrapped in `assertRepoPristine` cannot write).
 */

/** Turns a delivered mail into a human view (markdown / structured text). */
export type MailRenderer = (mail: DeliveredMail) => string;

/**
 * A per-type renderer registry: {@link render} returns the registered renderer for the
 * mail's type, else the default. {@link register} is the L9 PLUG-POINT.
 */
export interface RendererRegistry {
  /** Render `mail` with its type's registered renderer, falling back to the default. */
  render(mail: DeliveredMail): string;
  /**
   * Register a per-type renderer (overrides the default for that type).
   *
   * L9 PLUG-POINT — per-type human cards are DEFERRED to the desktop app (spec §2 DEFER).
   * What L9 does: register a rich, type-aware view per actionable/informational type — e.g.
   * `clarify_request` → a question card with a reply box, `approval` → an approve/decline
   * card with the action laid out, `escalation` → a readable problem summary + context.
   * L1 deliberately ships NONE of these cards (only the seam + the generic default below), so
   * the desktop app owns presentation without the bus growing per-type UI knowledge.
   */
  register(type: MailType, renderer: MailRenderer): void;
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
 * Create a renderer registry. `opts.default` overrides the fallback renderer (defaults to
 * {@link defaultMailRenderer}); per-type renderers are added later via {@link RendererRegistry.register}.
 */
export function createRendererRegistry(opts?: { default?: MailRenderer }): RendererRegistry {
  const fallback = opts?.default ?? defaultMailRenderer;
  const perType = new Map<MailType, MailRenderer>();
  return {
    render(mail) {
      return (perType.get(mail.type) ?? fallback)(mail);
    },
    register(type, renderer) {
      perType.set(type, renderer);
    },
  };
}
