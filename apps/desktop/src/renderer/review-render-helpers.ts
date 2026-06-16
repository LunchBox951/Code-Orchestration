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
 * one field a keystroke changes, and the live textarea already holds it. `contextKey` is a bounded
 * structural fingerprint of the rendered context, so composer keystrokes do not stringify large diffs.
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
  if (context == null) return 'null';
  if (!isRecord(context)) return scalarKey(context);

  const status = stringProp(context, 'status');
  if (status === 'loading') return 'loading';
  if (status !== 'loaded') return objectShapeKey(context);

  return `loaded:${reviewContextKey(context.value)}`;
}

function reviewContextKey(value: unknown): string {
  if (!isRecord(value)) return scalarKey(value);
  const kind = stringProp(value, 'kind');
  if (kind === 'not-found' || kind === 'conductor-down') {
    return `${kind}:${sampleString(stringProp(value, 'reviewId'))}`;
  }
  if (kind !== 'resolved') return objectShapeKey(value);

  return [
    'resolved',
    sampleString(stringProp(value, 'reviewId')),
    sampleString(stringProp(value, 'branch')),
    sampleString(stringProp(value, 'target')),
    sampleString(stringProp(value, 'scope')),
    sampleString(stringProp(value, 'evidenceFingerprint')),
    diffKey(value.diff),
    criteriaKey(value.criteria),
  ].join('|');
}

function diffKey(diff: unknown): string {
  if (!isRecord(diff)) return scalarKey(diff);
  const kind = stringProp(diff, 'kind');
  if (kind === 'patch') return `patch:${sampleString(stringProp(diff, 'patch'))}`;
  if (kind === 'unavailable') return `unavailable:${sampleString(stringProp(diff, 'reason'))}`;
  return objectShapeKey(diff);
}

function criteriaKey(criteria: unknown): string {
  if (!isRecord(criteria)) return scalarKey(criteria);
  const kind = stringProp(criteria, 'kind');
  if (kind === 'no-locked-spec') return 'no-locked-spec';
  if (kind !== 'criteria') return objectShapeKey(criteria);

  const items = Array.isArray(criteria.criteria) ? criteria.criteria : [];
  const itemKeys = items
    .map((item) => {
      if (!isRecord(item)) return scalarKey(item);
      return `${sampleString(stringProp(item, 'text'))}:${sampleString(stringProp(item, 'verify'))}`;
    })
    .join(',');
  return `criteria:${sampleString(stringProp(criteria, 'specRef'))}:${items.length}:${itemKeys}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringProp(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function scalarKey(value: unknown): string {
  return `${typeof value}:${String(value)}`;
}

function objectShapeKey(value: Record<string, unknown>): string {
  return `object:${Object.keys(value).sort().join(',')}`;
}

function sampleString(value: string): string {
  const max = 96;
  if (value.length <= max * 2) return `${value.length}:${value}`;
  return `${value.length}:${value.slice(0, max)}:${value.slice(-max)}`;
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
