/**
 * Shared, DOM-free helpers for preserving scroll / caret / focus across LIVE re-renders
 * (Stage 15 · P-DT1 · AC-S15-9 [SF-4]).
 *
 * THE PROBLEM: every view in the operator cockpit (Dashboard / Mail / Review) re-renders by rebuilding
 * `container.innerHTML` on every state tick — including on every keystroke. Rebuilding the DOM recreates
 * the focused textarea and resets scroll position, so the caret jumps to offset 0 (GitHub #39 — the mail
 * composer "reversal" bug, where "run host proof" rendered as "foorp tsoh nur") and scroll position is
 * lost. The Review verdict composer (#316) was already fixed this way; this module generalises it.
 *
 * THE FIX — two independent, composable pieces:
 *   1. `needsRebuild(prevSig, nextSig, focused)` — when the ONLY change between renders is a field the
 *      live DOM already holds (e.g. a composer body the focused textarea owns), and the interactive
 *      element is focused, the rebuild is SKIPPED. Callers build a `signature` that deliberately EXCLUDES
 *      that one field, so a body-only delta yields an equal signature.
 *   2. `captureInteractionState` / `restoreInteractionState` — when a rebuild IS unavoidable while the
 *      user is mid-interaction, capture scrollTop + caret BEFORE the rebuild and re-apply them to the
 *      freshly-created element AFTER, instead of blindly dropping the caret to offset 0.
 *
 * Both are typed against MINIMAL structural interfaces (no `document`/`window`/framework imports), so the
 * decisions are unit-testable with plain objects and a hand-rolled fake element — mirroring how
 * `review-render-helpers.ts` inlines just the fields it reads.
 */

// ── Rebuild decision ─────────────────────────────────────────────────────────────

/**
 * A render signature is a flat record of primitives capturing everything a pane's rebuild depends on
 * EXCEPT the live-owned field (e.g. a composer body). Two signatures are equal iff every key matches.
 */
export type RenderSignature = Readonly<Record<string, string | number | boolean | null>>;

/** Shallow primitive equality over every own enumerable key of two signatures. */
export function signaturesEqual(a: object, b: object): boolean {
  if (a === b) return true;
  const aRec = a as Record<string, unknown>;
  const bRec = b as Record<string, unknown>;
  const aKeys = Object.keys(aRec);
  const bKeys = Object.keys(bRec);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (aRec[key] !== bRec[key]) return false;
  }
  return true;
}

/**
 * Decide whether a live-re-rendered pane must rebuild its `innerHTML`. Returns `false` ONLY when:
 *   - `prev != null` (not the first render), AND
 *   - the interactive element is focused (there is a caret to preserve), AND
 *   - the signature is unchanged (the sole delta is the live-owned field, which the DOM already holds).
 * In every other case it returns `true` (safe: rebuild and lose nothing the user is editing).
 */
export function needsRebuild<S extends object>(
  prev: S | null,
  next: S,
  interactiveElementFocused: boolean,
): boolean {
  if (prev == null) return true;
  if (!interactiveElementFocused) return true;
  return !signaturesEqual(prev, next);
}

// ── Scroll / caret / focus preservation ──────────────────────────────────────────

/**
 * The minimal structural view of a DOM element this module touches. Selection fields are OPTIONAL so a
 * plain scroll container (a `<div>`/`<main>`, no caret) satisfies it just as well as a `<textarea>`.
 */
export interface InteractiveElement {
  scrollTop: number;
  readonly selectionStart?: number | null;
  readonly selectionEnd?: number | null;
  setSelectionRange?(start: number, end: number): void;
  focus(): void;
}

/** A snapshot of the interaction state worth carrying across a rebuild. */
export interface CapturedInteractionState {
  readonly scrollTop: number;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
  /** Whether the element was focused at capture time; drives whether `restore` re-focuses. */
  readonly focused: boolean;
}

/**
 * Snapshot scrollTop + caret of `el` before a rebuild. `focused` (default `false`) records whether the
 * element currently holds focus — pass `true` only for the element you intend to re-focus. Capture a
 * scroll container with `false` so `restore` does not steal focus from elsewhere.
 */
export function captureInteractionState(
  el: InteractiveElement,
  focused = false,
): CapturedInteractionState {
  return {
    scrollTop: el.scrollTop,
    selectionStart: el.selectionStart ?? null,
    selectionEnd: el.selectionEnd ?? null,
    focused,
  };
}

/**
 * Re-apply a captured snapshot to a (typically freshly-created) element: restore scrollTop, restore the
 * caret via `setSelectionRange` when both offsets and the method are present, and re-focus ONLY when the
 * element was focused at capture time.
 */
export function restoreInteractionState(
  el: InteractiveElement,
  captured: CapturedInteractionState,
): void {
  el.scrollTop = captured.scrollTop;
  if (
    captured.selectionStart != null &&
    captured.selectionEnd != null &&
    typeof el.setSelectionRange === 'function'
  ) {
    el.setSelectionRange(captured.selectionStart, captured.selectionEnd);
  }
  if (captured.focused) {
    el.focus();
  }
}

// ── Mail detail signature ─────────────────────────────────────────────────────────
//
// The Mail detail pane (`renderMailDetail`) is the GitHub #39 site. These types live here (the shared
// live-render module) because the renderer has no `mail-render-helpers.ts`; keeping the projection pure
// and exported makes it directly unit-testable, exactly like `reviewDetailSignature`.

/** Minimal structural view of the MailRow fields `renderMailDetail` reads. */
export interface MailCardView {
  readonly title: string;
  readonly fields: readonly { readonly label: string; readonly value: string }[];
  readonly body: string;
}

export interface MailRowView {
  readonly seq: number;
  readonly type: string;
  readonly subject: string;
  readonly sender: string;
  readonly recipient: string;
  readonly card: MailCardView;
  readonly kind: string;
  /** Drives the "Open in Reviews" review-id link, so a change must rebuild. */
  readonly idempotencyKey?: string;
}

/** Minimal structural view of the MailState fields the detail-pane rebuild depends on. */
export interface MailStateView {
  readonly selected: MailRowView | null;
  readonly composer: {
    readonly active: boolean;
    readonly pending: boolean;
  };
}

/**
 * Everything `renderMailDetail` renders EXCEPT `composer.body` — the one field a keystroke changes and the
 * live textarea already holds. A body-only edit therefore yields an identical signature, so `needsRebuild`
 * skips the rebuild and the caret survives (GitHub #39). `composer.type` is intentionally omitted because
 * the mail composer's title/footer keys off `selected.type` (`approval`), not the composer type.
 */
export type MailDetailSignature = RenderSignature;

function cardSignature(card: MailCardView): string {
  return JSON.stringify({
    title: card.title,
    fields: card.fields.map((field) => [field.label, field.value]),
    body: card.body,
  });
}

export function mailDetailSignature(state: MailStateView): MailDetailSignature {
  const { selected, composer } = state;
  return {
    selectedSeq: selected?.seq ?? null,
    type: selected?.type ?? '',
    subject: selected?.subject ?? '',
    sender: selected?.sender ?? '',
    recipient: selected?.recipient ?? '',
    card: selected != null ? cardSignature(selected.card) : '',
    kind: selected?.kind ?? '',
    idempotencyKey: selected?.idempotencyKey ?? '',
    composerActive: composer.active,
    composerPending: composer.pending,
  };
}
