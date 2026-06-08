import type { TestOutcome } from '../worktrees/events.js';
import type { VerificationMarker } from './verdict.js';

/**
 * The result of an honest-verify comparison (AC-L5-3): a deterministic, side-effect-free diff of
 * the finish run against the branch-off baseline. Identical inputs always produce an identical result
 * (no I/O, no clock, no Math.random — replay-deterministic by design). `baselineCompared: true` is
 * earned mechanically by having called {@link honestVerify}; it is never self-reported.
 */
export interface HonestVerifyOutcome {
  /** pass→fail or new-fail test names (sorted for determinism). Regression = auto-reject. */
  readonly regressions: readonly string[];
  /** fail→fail test names (sorted for determinism). Pre-existing = flag + escalate, never silent-pass. */
  readonly baselineFailures: readonly string[];
  /** Mechanically computed: 'fail' iff any finish test failed (independent of baseline). */
  readonly suiteResult: 'pass' | 'fail';
  /** Earned mechanically by running this comparison — never self-reported. */
  readonly baselineCompared: true;
}

/**
 * Pure, deterministic, side-effect-free comparison of a finish run against its branch-off baseline
 * (AC-L5-3). No I/O, no clock, no Math.random.
 *
 * Terminology:
 *   - **regression**     — a test that fails NOW but passed in the baseline (or is absent = new):
 *                          pass→fail or new-fail. Auto-rejects a PASS.
 *   - **baseline failure** — a test that fails NOW and ALSO failed in the baseline: fail→fail.
 *                          A PASS over these is allowed but must be flagged + escalated.
 */
export function honestVerify(
  baseline: readonly TestOutcome[],
  finish: readonly TestOutcome[],
): HonestVerifyOutcome {
  const baselineMap = new Map<string, boolean>();
  for (const t of baseline) {
    baselineMap.set(t.name, t.passed);
  }

  const regressions: string[] = [];
  const baselineFailures: string[] = [];

  for (const t of finish) {
    if (!t.passed) {
      const baselinePassed = baselineMap.get(t.name);
      if (baselinePassed === false) {
        // fail→fail: pre-existing baseline failure
        baselineFailures.push(t.name);
      } else {
        // pass→fail or absent-from-baseline (new failure): regression
        regressions.push(t.name);
      }
    }
  }

  return {
    regressions: [...regressions].sort(),
    baselineFailures: [...baselineFailures].sort(),
    suiteResult: finish.some((t) => !t.passed) ? 'fail' : 'pass',
    baselineCompared: true,
  };
}

/** The gate's decision for a PASS verdict given an honest-verify outcome + the recorded marker. */
export interface ClassifyPassResult {
  /** Whether the PASS is allowed to proceed to the merge. */
  readonly allow: boolean;
  /** Human-readable reason (present when allow=false or mustEscalate=true). */
  readonly reason?: string;
  /** True when a baseline failure is present — the merge may proceed but MUST be flagged + escalated. */
  readonly mustEscalate: boolean;
}

/**
 * Decision helper the gate calls after {@link honestVerify} (AC-L5-3). Encodes three rules:
 *
 *   1. **regression present** ⇒ `allow:false` — a PASS cannot sit on a non-baseline failure.
 *   2. **marker absent** ⇒ `allow:false` — PASS-without-marker is rejected (defense in depth).
 *   3. **only baseline failures, marker present** ⇒ `allow:true, mustEscalate:true` — never silent.
 *   4. **clean** ⇒ `allow:true, mustEscalate:false`.
 *
 * The marker the reviewer supplies is their self-report; the gate re-derives the truth mechanically
 * from the baseline/finish events, so a lying marker cannot smuggle a regression past the gate.
 */
export function classifyPass(
  outcome: HonestVerifyOutcome,
  marker: VerificationMarker | undefined,
): ClassifyPassResult {
  if (outcome.regressions.length > 0) {
    return {
      allow: false,
      reason: `regression: a PASS cannot sit on a non-baseline failure (${outcome.regressions.join(', ')})`,
      mustEscalate: false,
    };
  }
  if (marker === undefined) {
    return {
      allow: false,
      reason: 'PASS-without-marker: a PASS verdict must carry a verification marker (AC-L5-3)',
      mustEscalate: false,
    };
  }
  if (outcome.baselineFailures.length > 0) {
    return {
      allow: true,
      reason: `pre-existing baseline failure(s): ${outcome.baselineFailures.join(', ')}`,
      mustEscalate: true,
    };
  }
  return { allow: true, mustEscalate: false };
}
