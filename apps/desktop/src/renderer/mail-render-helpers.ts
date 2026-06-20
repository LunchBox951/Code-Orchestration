/**
 * Pure, DOM-free decision helpers for the Mail detail pane (bug #39).
 *
 * THE BUG: typing in the reply/decision composer textarea (`#composer-body`) fired
 * `bridge.mailUpdateComposer('body', …)` → a new MailState push → `renderMail` → `renderMailDetail`,
 * which rebuilt `detailPane.innerHTML`, recreating the focused textarea and dropping the caret to the
 * start on every keystroke — so the operator's text came out reversed ("run host proof" → "foorp tsoh nur").
 *
 * THE FIX (the same one the Review composer already uses — see {@link ./review-render-helpers.ts}):
 * when the ONLY meaningful change is `composer.body` AND the composer textarea is focused,
 * `renderMailDetail` skips rebuilding the detail pane — the live textarea already holds the typed value —
 * and the sidebar + badge still update. These helpers make that decision testable in isolation: NO
 * `document`/`window`/`@co/core` imports; the fields the decision reads are inlined here.
 */

/** The non-body fields of the Mail detail; a change in any of these REQUIRES a detail-pane rebuild. */
export interface MailDetailSignature {
  /** A bounded fingerprint of the selected message (null when nothing is selected). */
  readonly selectedKey: string;
  readonly composerActive: boolean;
  readonly composerPending: boolean;
}

/** The minimal structural view of a MailState this module reads (inlined to stay framework-free). */
export interface MailStateView {
  readonly selected: {
    readonly seq: number;
    readonly type: string;
    readonly kind: string;
    readonly subject: string;
    readonly sender: string;
    readonly recipient: string;
    readonly renderedBody: string;
  } | null;
  readonly composer: {
    readonly active: boolean;
    readonly pending: boolean;
  };
}

/**
 * Project a MailState into its detail signature. `composer.body` is deliberately EXCLUDED — it is the
 * one field a keystroke changes, and the live textarea already holds it. `selectedKey` is a bounded
 * structural fingerprint so composer keystrokes do not stringify large message bodies.
 */
export function mailDetailSignature(state: MailStateView): MailDetailSignature {
  return {
    selectedKey: selectedKey(state.selected),
    composerActive: state.composer.active,
    composerPending: state.composer.pending,
  };
}

function selectedKey(selected: MailStateView['selected']): string {
  if (selected == null) return 'null';
  return [
    selected.seq,
    selected.type,
    selected.kind,
    sampleString(selected.subject),
    sampleString(selected.sender),
    sampleString(selected.recipient),
    sampleString(selected.renderedBody),
  ].join('|');
}

function sampleString(value: string): string {
  const max = 96;
  if (value.length <= max * 2) return `${value.length}:${value}`;
  return `${value.length}:${value.slice(0, max)}:${value.slice(-max)}`;
}

/**
 * Decide whether the Mail detail pane must be rebuilt. Returns `false` ONLY when the sole difference
 * between `prev` and `next` is the composer body AND the composer textarea is currently focused — i.e.
 * the user is typing into a textarea that already holds the value, so a rebuild would needlessly drop
 * the caret (the #39 reversal).
 *
 *   - `prev == null` (first render) → rebuild.
 *   - composer NOT focused → rebuild (safe; there is no caret to preserve).
 *   - focused → rebuild UNLESS every non-body field is unchanged.
 */
export function mailDetailNeedsRebuild(
  prev: MailDetailSignature | null,
  next: MailDetailSignature,
  composerFocused: boolean,
): boolean {
  if (prev == null) return true;
  if (!composerFocused) return true;
  const allNonBodyFieldsEqual =
    prev.selectedKey === next.selectedKey &&
    prev.composerActive === next.composerActive &&
    prev.composerPending === next.composerPending;
  return !allNonBodyFieldsEqual;
}
