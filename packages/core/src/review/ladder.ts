import { assertNever } from '../assert-never.js';

/**
 * The three review scopes — FROZEN by the Lead (serialization/config keys them off these exact
 * strings). Later phases expand the producer side (reviewer tools record a scope) and the config
 * side (per-project overrides per scope); Phase C delivers only the pure classification fn +
 * the data table.
 *
 *   - `worker_merge`  — a worker's phase branch merges into the lead's integration branch.
 *   - `phase_merge`   — a lead's integration branch merges into main/master (sits between).
 *   - `pr_merge`      — a pull request merging into an upstream default branch (strictest).
 */
export type ReviewScope = 'worker_merge' | 'phase_merge' | 'pr_merge';

/**
 * The inherent class of a finding — independent of scope. The scope determines whether the finding
 * is a blocker or a suggestion; the category is the finding's own nature.
 *
 *   - `cosmetic`     — style/formatting (trailing whitespace, naming nit). Suggestion at worker+phase;
 *                      blocker at pr (a PR going to an upstream must be polished).
 *   - `quality`      — missing tests, unclear docs, non-obvious code. Suggestion at worker; blocker
 *                      at phase+pr (integration branches carry quality debt forward).
 *   - `correctness`  — a bug, a regression, a broken invariant. Blocker at every scope.
 */
export type FindingCategory = 'cosmetic' | 'quality' | 'correctness';

/** The gate classification a finding receives at a given scope. */
type Classification = 'blocker' | 'suggestion';

/**
 * The per-scope strictness table (AC-L5-2). Row = category, col = scope. Read left-to-right: the
 * bar TIGHTENS toward production (never loosens). Each cell is the tunable entry point — a later
 * config layer wraps this table; for now it is a hard constant.
 *
 *              worker_merge   phase_merge   pr_merge
 *  cosmetic    suggestion     suggestion    blocker    ← same nit, two scopes (the AC-L5-2 headline)
 *  quality     suggestion     blocker       blocker
 *  correctness blocker        blocker       blocker    ← always a blocker
 */
const LADDER: Record<FindingCategory, Record<ReviewScope, Classification>> = {
  cosmetic: { worker_merge: 'suggestion', phase_merge: 'suggestion', pr_merge: 'blocker' },
  quality: { worker_merge: 'suggestion', phase_merge: 'blocker', pr_merge: 'blocker' },
  correctness: { worker_merge: 'blocker', phase_merge: 'blocker', pr_merge: 'blocker' },
};

/**
 * Pure, deterministic ladder lookup (AC-L5-2): given a finding's inherent category and the scope
 * at which it is being reviewed, returns whether it is a `'blocker'` or a `'suggestion'`. No I/O,
 * no clock, no randomness — identical inputs always produce identical output (replay-deterministic).
 * Exhaustive over the unions via {@link assertNever} — a new category or scope forces a decision.
 */
export function classifyFinding(category: FindingCategory, scope: ReviewScope): Classification {
  switch (category) {
    case 'cosmetic':
    case 'quality':
    case 'correctness':
      return LADDER[category][scope];
    default:
      return assertNever(category);
  }
}

/** A structured finding with an inherent category and a one-line summary. */
export interface LadderFinding {
  readonly category: FindingCategory;
  readonly summary: string;
}

/** The result of {@link applyLadder}: findings partitioned into blockers and suggestions by scope. */
export interface LadderResult {
  readonly blockers: readonly LadderFinding[];
  readonly suggestions: readonly LadderFinding[];
}

/**
 * Re-partition a list of categorized findings into blockers and suggestions at the given scope,
 * preserving input order within each partition. A convenience wrapper over {@link classifyFinding}
 * for callers that work with lists of findings (e.g. a reviewer building a verdict).
 */
export function applyLadder(findings: readonly LadderFinding[], scope: ReviewScope): LadderResult {
  const blockers: LadderFinding[] = [];
  const suggestions: LadderFinding[] = [];
  for (const f of findings) {
    if (classifyFinding(f.category, scope) === 'blocker') {
      blockers.push(f);
    } else {
      suggestions.push(f);
    }
  }
  return { blockers, suggestions };
}
