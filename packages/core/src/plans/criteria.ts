/**
 * L6b F2 criterion validator (D2) — the pure, structural acceptance-criteria gate. Mirrors the
 * `checkToolCompleteness` / `checkRoleProfileCompleteness` shape: a pure function returning a list of
 * violations (`[]` ⇒ every criterion is valid), one violation per failed criterion. The PLANS task
 * imports this later; `co_spec_lock` runs it as the lock-time gate (a locked spec must have real,
 * wired acceptance criteria — never a fuzzy "looks good").
 *
 * The PRIMARY check (the real mechanical bite) is STRUCTURAL: every criterion must carry a wired
 * verification command (`verify`). The SECONDARY check is a conservative, deterministic nudge against
 * a seed deny-list of vacuous phrases. Both are pure — no I/O, no clock.
 *
 * HARD CONSTRAINT (P5/P12 — D2): this validator MUST NOT hard-code any project command. It accepts ANY
 * non-empty `verify` string; wiring criteria to the project's real commands is the author's job — the
 * validator only enforces *presence + non-vacuous text*.
 */
import type { Criterion } from '../specs/criteria-schema.js';

/** A criterion that failed validation, with its index, original text, and a human reason. */
export interface CriterionViolation {
  readonly index: number;
  readonly text: string;
  readonly reason: string;
}

/**
 * Seed deny-list of vacuous acceptance phrases (D2). This is the SECONDARY nudge — the STRUCTURAL
 * check (a wired `verify` command present) is the real bite. A normalized criterion text that EQUALS
 * one of these (optionally with a generic subject/qualifier stripped) is flagged as vacuous.
 */
export const VACUOUS_PHRASES: readonly string[] = ['works', 'is clean', 'looks good', 'well'];

/**
 * Generic subjects a vacuous phrase may hide behind: `"it works"`, `"the build is clean"`. Stripping a
 * leading one of these leaves the bare vacuous phrase (so `"it works"` reduces to `"works"`).
 */
const GENERIC_SUBJECT_PREFIXES: readonly string[] = [
  'it',
  'this',
  'that',
  'the build',
  'the code',
  'the test',
  'the tests',
  'the feature',
  'the app',
  'everything',
];

/**
 * Generic qualifiers a vacuous phrase may trail with: `"works well"`, `"works correctly"`. Stripping a
 * trailing one leaves the bare vacuous phrase (so `"works well"` reduces to `"works"`).
 */
const GENERIC_QUALIFIERS: readonly string[] = [
  'well',
  'fine',
  'correctly',
  'properly',
  'as expected',
  'now',
  'ok',
  'okay',
];

/** Normalize: trim → lowercase → collapse internal whitespace → strip trailing punctuation/space. */
function normalize(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?;:,\s]+$/u, '')
    .trim();
}

/**
 * Whether `text` is a vacuous acceptance phrase. Deterministic and CONSERVATIVE: it flags only when the
 * normalized text EQUALS a {@link VACUOUS_PHRASES} entry, or equals one after stripping a single leading
 * generic subject and/or a single trailing generic qualifier. It NEVER flags a concrete text merely for
 * containing a vacuous substring (e.g. `"refresh works after expiry → 401"` is NOT vacuous).
 */
function isVacuousText(text: string): boolean {
  const norm = normalize(text);
  if (norm.length === 0) return false;

  const candidates = new Set<string>([norm]);
  // Strip a single leading generic subject ("it works" → "works").
  for (const subject of GENERIC_SUBJECT_PREFIXES) {
    if (norm.startsWith(`${subject} `)) {
      candidates.add(norm.slice(subject.length + 1));
    }
  }
  // Strip a single trailing generic qualifier from each candidate ("works well" → "works").
  for (const candidate of [...candidates]) {
    for (const qualifier of GENERIC_QUALIFIERS) {
      if (candidate !== qualifier && candidate.endsWith(` ${qualifier}`)) {
        candidates.add(candidate.slice(0, candidate.length - qualifier.length - 1));
      }
    }
  }
  for (const candidate of candidates) {
    if (VACUOUS_PHRASES.includes(candidate)) return true;
  }
  return false;
}

/**
 * Validate acceptance criteria (D2). A criterion is valid iff BOTH hold:
 *   1. (primary, the real bite) `verify` is a non-empty/non-blank string — a wired verification command.
 *   2. (secondary nudge) its `text` is not a vacuous phrase.
 *
 * Returns one {@link CriterionViolation} per FAILED criterion (`[]` ⇒ all valid). The primary check is
 * reported first: a criterion missing its `verify` command surfaces the structural violation (a fuzzy
 * criterion is fixed by wiring a command, after which any remaining vacuous text surfaces on re-check).
 */
export function validateCriteria(criteria: readonly Criterion[]): CriterionViolation[] {
  const violations: CriterionViolation[] = [];
  criteria.forEach((criterion, index) => {
    if (typeof criterion.verify !== 'string' || criterion.verify.trim().length === 0) {
      violations.push({ index, text: criterion.text, reason: 'no wired verification command' });
      return;
    }
    if (isVacuousText(criterion.text)) {
      violations.push({ index, text: criterion.text, reason: 'vacuous acceptance text' });
    }
  });
  return violations;
}
