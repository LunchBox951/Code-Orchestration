/**
 * L5 Phase G spec-ref seam (AC-L5-8, RG-4): a review must be judged against the SOURCE's
 * acceptance criteria, never a template stub. When a locked spec resolves, the gate records a
 * `{ kind: 'criteria' }` reference; when none resolves, it records an explicit
 * `{ kind: 'no-locked-spec' }` marker — never a `<TODO>` placeholder (Principle 9 — never paper
 * over a missing input).
 *
 * Pure module: no I/O, no clock, deterministic. The spec-file lookup is an INJECTED input (the
 * caller resolves it from `.co/specs` and passes the resolved string as `specRef`); this module
 * turns "present" → criteria reference and "absent" → the explicit named marker.
 */

/** A discriminated result: either the source's acceptance-criteria reference or the explicit no-spec marker. */
export type ReviewSpecRef =
  | { readonly kind: 'criteria'; readonly ref: string }
  | { readonly kind: 'no-locked-spec' };

/** The explicit marker surfaced when no locked spec resolves — never `<TODO>`. */
export const NO_LOCKED_SPEC_MARKER = 'no locked spec' as const;

/**
 * Resolve an optional spec reference into a `ReviewSpecRef` discriminated result:
 * - non-empty `specRef` ⇒ `{ kind: 'criteria', ref: specRef }` (the source's AC reference).
 * - `undefined` / empty ⇒ `{ kind: 'no-locked-spec' }` (the explicit marker — never `<TODO>`).
 */
export function resolveReviewSpecRef(specRef: string | undefined): ReviewSpecRef {
  if (specRef !== undefined && specRef.trim().length > 0) {
    return { kind: 'criteria', ref: specRef.trim() };
  }
  return { kind: 'no-locked-spec' };
}

/**
 * Render a `ReviewSpecRef` to a human-readable string for the assembled review.
 * Returns the explicit `"no locked spec"` literal (never `<TODO>`) when no spec resolved.
 */
export function renderReviewSpecRef(specRef: ReviewSpecRef): string {
  return specRef.kind === 'criteria' ? specRef.ref : NO_LOCKED_SPEC_MARKER;
}
