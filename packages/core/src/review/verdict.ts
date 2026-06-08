import { z } from 'zod';

/**
 * The L5 verdict model (AC-L5-1). A review closes with a structured, event-sourced verdict — never a
 * prose blob (Principle 5) and never a rubber-stamp (Principle 9). The two-state outcome:
 *
 *   - `PASS`   — the work is mergeable; it carries ZERO blockers.
 *   - `ISSUES` — the work is NOT mergeable; it MUST name at least one blocker (a single-line reason).
 *
 * An `ISSUES` with no named blocker is the banned rubber-stamp inverse (an honest reviewer who fails
 * the work must say WHY), and a `PASS` carrying a blocker is a contradiction; {@link assertValidVerdict}
 * fails loud on both. This is the foundation Phase B (honest-verification) fills the {@link
 * VerificationMarker} for, Phase D counts strikes against, and Phase F overrides — none of which this
 * phase builds.
 */
export type Verdict = 'PASS' | 'ISSUES';

/** A single, named blocker — one line saying why the work cannot merge. */
export interface Blocker {
  readonly summary: string;
}

/** A single, named suggestion — a non-blocking improvement the reviewer offers. */
export interface Suggestion {
  readonly summary: string;
}

/**
 * The honest-verification marker the reviewer attaches to a verdict: the commands they actually ran,
 * the suite's outcome, and whether they compared it against the captured baseline. The SHAPE is frozen
 * here; **Phase B fills + enforces it** (this phase keeps it OPTIONAL on the verdict so a Phase-A
 * verdict need not carry one).
 */
export interface VerificationMarker {
  readonly commands_run: readonly string[];
  readonly suite_result: 'pass' | 'fail';
  readonly baseline_compared: boolean;
}

/** The structured verdict a review records (the payload heart of a `review.verdict` event). */
export interface ReviewVerdict {
  readonly verdict: Verdict;
  readonly blockers: readonly Blocker[];
  readonly suggestions: readonly Suggestion[];
  readonly verification?: VerificationMarker;
}

/** zod enum for {@link Verdict} — reused by the event payload schema + the tool input schema. */
export const verdictSchema = z.enum(['PASS', 'ISSUES']);

/** A blocker is a single non-empty line (Principle 5 — structured, named). */
export const blockerSchema = z.object({ summary: z.string().min(1) });

/** A suggestion is a single non-empty line. */
export const suggestionSchema = z.object({ summary: z.string().min(1) });

/** The honest-verification marker schema — its shape frozen now; Phase B makes it meaningful. */
export const verificationMarkerSchema = z.object({
  commands_run: z.array(z.string()),
  suite_result: z.enum(['pass', 'fail']),
  baseline_compared: z.boolean(),
});

/** The structured-verdict schema (verdict + blockers + suggestions + optional verification). */
export const reviewVerdictSchema = z.object({
  verdict: verdictSchema,
  blockers: z.array(blockerSchema),
  suggestions: z.array(suggestionSchema),
  verification: verificationMarkerSchema.optional(),
});

/**
 * The pure verdict validator (AC-L5-1). It is the structural check zod cannot express — a CROSS-FIELD
 * invariant between `verdict` and `blockers`:
 *
 *   - an `ISSUES` verdict MUST name ≥1 blocker (an ISSUES with no blocker is the banned rubber-stamp
 *     inverse — fail loud, Principle 9);
 *   - a `PASS` verdict MUST carry ZERO blockers (a PASS with a blocker is a contradiction).
 *
 * Pure (no I/O), so it runs both at the tool boundary (a clean caller error) AND inside
 * {@link import('./events.js').makeReviewVerdictEvent} (the event-boundary backstop — an invalid
 * verdict can never be persisted).
 */
export function assertValidVerdict(v: ReviewVerdict): void {
  if (v.verdict === 'ISSUES' && v.blockers.length < 1) {
    throw new Error(
      'review verdict: an ISSUES verdict must name at least one blocker (AC-L5-1 — an ISSUES with ' +
        'no named blocker is the banned rubber-stamp inverse; Principle 9).',
    );
  }
  if (v.verdict === 'PASS' && v.blockers.length > 0) {
    throw new Error(
      `review verdict: a PASS verdict must carry zero blockers (got ${v.blockers.length}); a PASS ` +
        'with a blocker is a contradiction (AC-L5-1).',
    );
  }
}
