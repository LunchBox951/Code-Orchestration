/**
 * Pure, DOM-free decision helpers for the Review detail pane (Stage 13 · review #316 follow-up).
 *
 * THE BUG: typing in the verdict-composer textarea (`#review-composer-body`) fired
 * `bridge.reviewUpdateComposerBody` → `ReviewVM.updateComposerBody` → `emit()` → `onReviewState` →
 * `renderReview`, which rebuilt `detailPane.innerHTML`, recreating the focused textarea and dropping the
 * caret to the end on every keystroke.
 *
 * THE FIX: when the ONLY meaningful change is `composer.body` AND the composer textarea is focused,
 * `renderReview` skips rebuilding the detail pane — the live textarea already holds the typed value — and
 * still updates the pending-list + badge. These helpers make that decision testable in isolation: NO
 * `document`/`window`/`@co/core` imports; the couple of fields the decision reads are inlined here, so the
 * `ReviewVM` contract is untouched.
 */

/** The non-body fields of the Review detail; a change in any of these REQUIRES a detail-pane rebuild. */
export interface ReviewDetailSignature {
  readonly selectedReviewId: string | null;
  /** A stable key for the selected context; changes iff the rendered diff/criteria would differ. */
  readonly contextKey: string;
  readonly composerActive: boolean;
  readonly composerVerdict: string;
  readonly composerPending: boolean;
}

/** The minimal structural view of a ReviewState this module reads (inlined to stay framework-free). */
export interface ReviewStateView {
  readonly selectedReviewId: string | null;
  readonly context: unknown;
  readonly composer: {
    readonly active: boolean;
    readonly verdict: string;
    readonly pending: boolean;
  };
}

/**
 * Project a ReviewState into its detail signature. `composer.body` is deliberately EXCLUDED — it is the
 * one field a keystroke changes, and the live textarea already holds it. `contextKey` is a faithful
 * serialization of the context: the VM keeps the SAME context reference across composer-body edits, so the
 * key is stable while typing and changes only on a real context load/change.
 */
export function reviewDetailSignature(state: ReviewStateView): ReviewDetailSignature {
  return {
    selectedReviewId: state.selectedReviewId,
    contextKey: contextKey(state.context),
    composerActive: state.composer.active,
    composerVerdict: state.composer.verdict,
    composerPending: state.composer.pending,
  };
}

function contextKey(context: unknown): string {
  try {
    return JSON.stringify(context) ?? 'null';
  } catch {
    // A non-serializable context (cycles, etc.) is not expected from the VM; fall back to a constant so
    // the decision degrades to "always rebuild" rather than throwing in the render path.
    return '<unserializable>';
  }
}

/**
 * Decide whether the Review detail pane must be rebuilt. Returns `false` ONLY when the sole difference
 * between `prev` and `next` is the composer body AND the composer textarea is currently focused — i.e. the
 * user is typing into a textarea that already holds the value, so a rebuild would needlessly drop the caret.
 *
 *   - `prev == null` (first render) → rebuild.
 *   - composer NOT focused → rebuild (safe; there is no caret to preserve).
 *   - focused → rebuild UNLESS every non-body field is unchanged.
 */
export function reviewDetailNeedsRebuild(
  prev: ReviewDetailSignature | null,
  next: ReviewDetailSignature,
  composerFocused: boolean,
): boolean {
  if (prev == null) return true;
  if (!composerFocused) return true;
  const allNonBodyFieldsEqual =
    prev.selectedReviewId === next.selectedReviewId &&
    prev.contextKey === next.contextKey &&
    prev.composerActive === next.composerActive &&
    prev.composerVerdict === next.composerVerdict &&
    prev.composerPending === next.composerPending;
  return !allNonBodyFieldsEqual;
}
