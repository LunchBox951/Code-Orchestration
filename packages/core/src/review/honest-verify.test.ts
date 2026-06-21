import { describe, it, expect } from 'vitest';
import type { TestOutcome } from '../worktrees/events.js';
import type { VerificationMarker } from './verdict.js';
import { classifyPass, honestVerify } from './honest-verify.js';

// AC-L5-3 — the pure honest-verify compare fn. Deterministic: identical inputs ⇒ identical output;
// no I/O, no clock, no Math.random.

const MARKER: VerificationMarker = {
  commands_run: ['pnpm test'],
  suite_result: 'pass',
  baseline_compared: true,
};

describe('honestVerify — regression classification', () => {
  it('pass→fail is a regression (non-baseline failure)', () => {
    const baseline: TestOutcome[] = [{ name: 'test-a', passed: true }];
    const finish: TestOutcome[] = [{ name: 'test-a', passed: false }];
    const out = honestVerify(baseline, finish);
    expect(out.regressions).toEqual(['test-a']);
    expect(out.baselineFailures).toEqual([]);
    expect(out.suiteResult).toBe('fail');
    expect(out.baselineCompared).toBe(true);
  });

  it('absent-from-baseline (new) failing test is a regression', () => {
    const baseline: TestOutcome[] = [{ name: 'test-a', passed: true }];
    const finish: TestOutcome[] = [
      { name: 'test-a', passed: true },
      { name: 'test-b', passed: false }, // new test, failing
    ];
    const out = honestVerify(baseline, finish);
    expect(out.regressions).toEqual(['test-b']);
    expect(out.baselineFailures).toEqual([]);
  });

  it('fail→fail is a baseline failure (pre-existing), not a regression', () => {
    const baseline: TestOutcome[] = [{ name: 'test-b', passed: false }];
    const finish: TestOutcome[] = [{ name: 'test-b', passed: false }];
    const out = honestVerify(baseline, finish);
    expect(out.regressions).toEqual([]);
    expect(out.baselineFailures).toEqual(['test-b']);
    expect(out.suiteResult).toBe('fail');
  });

  it('mixed: pass→fail (regression) + fail→fail (baseline) + pass→pass (clean)', () => {
    const baseline: TestOutcome[] = [
      { name: 'test-a', passed: true }, // will regress
      { name: 'test-b', passed: false }, // pre-existing
      { name: 'test-c', passed: true }, // stays passing
    ];
    const finish: TestOutcome[] = [
      { name: 'test-a', passed: false }, // regression
      { name: 'test-b', passed: false }, // baseline failure
      { name: 'test-c', passed: true }, // clean
    ];
    const out = honestVerify(baseline, finish);
    expect(out.regressions).toEqual(['test-a']);
    expect(out.baselineFailures).toEqual(['test-b']);
    expect(out.suiteResult).toBe('fail');
  });

  it('clean finish (all pass) produces no regressions or baseline failures', () => {
    const baseline: TestOutcome[] = [{ name: 'test-a', passed: true }];
    const finish: TestOutcome[] = [{ name: 'test-a', passed: true }];
    const out = honestVerify(baseline, finish);
    expect(out.regressions).toEqual([]);
    expect(out.baselineFailures).toEqual([]);
    expect(out.suiteResult).toBe('pass');
  });

  it('empty baseline + empty finish is clean', () => {
    const out = honestVerify([], []);
    expect(out.regressions).toEqual([]);
    expect(out.baselineFailures).toEqual([]);
    expect(out.suiteResult).toBe('pass');
  });

  it('output arrays are sorted for determinism (regression + baseline)', () => {
    const baseline: TestOutcome[] = [
      { name: 'z-test', passed: false },
      { name: 'a-test', passed: false },
    ];
    const finish: TestOutcome[] = [
      { name: 'z-test', passed: false },
      { name: 'a-test', passed: false },
      { name: 'm-test', passed: false }, // new regression
      { name: 'b-test', passed: false }, // new regression
    ];
    const out = honestVerify(baseline, finish);
    expect(out.baselineFailures).toEqual(['a-test', 'z-test']); // sorted
    expect(out.regressions).toEqual(['b-test', 'm-test']); // sorted
  });

  it('deduplicates repeated failing test names so they cannot double-count', () => {
    const baseline: TestOutcome[] = [{ name: 'dup-baseline', passed: false }];
    const finish: TestOutcome[] = [
      { name: 'dup-baseline', passed: false }, // repeated baseline failure
      { name: 'dup-baseline', passed: false },
      { name: 'dup-regress', passed: false }, // repeated regression
      { name: 'dup-regress', passed: false },
    ];
    const out = honestVerify(baseline, finish);
    expect(out.baselineFailures).toEqual(['dup-baseline']);
    expect(out.regressions).toEqual(['dup-regress']);
  });

  it('is deterministic: identical inputs always produce identical output', () => {
    const baseline: TestOutcome[] = [
      { name: 'test-a', passed: true },
      { name: 'test-b', passed: false },
    ];
    const finish: TestOutcome[] = [
      { name: 'test-a', passed: false },
      { name: 'test-b', passed: false },
    ];
    const out1 = honestVerify(baseline, finish);
    const out2 = honestVerify(baseline, finish);
    expect(out1).toEqual(out2);
  });
});

describe('classifyPass — gate decision', () => {
  it('regression present ⇒ allow:false, mustEscalate:false', () => {
    const outcome = honestVerify(
      [{ name: 'test-a', passed: true }],
      [{ name: 'test-a', passed: false }],
    );
    const result = classifyPass(outcome, MARKER);
    expect(result.allow).toBe(false);
    expect(result.mustEscalate).toBe(false);
    expect(result.reason).toMatch(/regression/);
  });

  it('marker absent ⇒ allow:false, mustEscalate:false (PASS-without-marker)', () => {
    const outcome = honestVerify(
      [{ name: 'test-a', passed: true }],
      [{ name: 'test-a', passed: true }],
    );
    const result = classifyPass(outcome, undefined);
    expect(result.allow).toBe(false);
    expect(result.mustEscalate).toBe(false);
    expect(result.reason).toMatch(/PASS-without-marker/);
  });

  it('only baseline failures, marker present ⇒ allow:true, mustEscalate:true', () => {
    const outcome = honestVerify(
      [{ name: 'test-b', passed: false }],
      [{ name: 'test-b', passed: false }],
    );
    const result = classifyPass(outcome, MARKER);
    expect(result.allow).toBe(true);
    expect(result.mustEscalate).toBe(true);
    expect(result.reason).toMatch(/baseline failure/);
  });

  it('clean outcome + marker ⇒ allow:true, mustEscalate:false', () => {
    const outcome = honestVerify(
      [{ name: 'test-a', passed: true }],
      [{ name: 'test-a', passed: true }],
    );
    const result = classifyPass(outcome, MARKER);
    expect(result.allow).toBe(true);
    expect(result.mustEscalate).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it('regression beats baseline failure: when both present, regression wins (allow:false)', () => {
    const outcome = honestVerify(
      [
        { name: 'test-a', passed: true }, // will regress
        { name: 'test-b', passed: false }, // pre-existing
      ],
      [
        { name: 'test-a', passed: false }, // regression
        { name: 'test-b', passed: false }, // baseline failure
      ],
    );
    const result = classifyPass(outcome, MARKER);
    expect(result.allow).toBe(false);
    expect(result.reason).toMatch(/regression/);
  });
});
