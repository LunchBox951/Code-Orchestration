import { describe, it, expect } from 'vitest';
import { assertValidVerdict, type ReviewVerdict } from './verdict.js';

// AC-L5-1 — the verdict validator. An ISSUES verdict MUST name ≥1 blocker (the banned rubber-stamp
// inverse); a PASS MUST carry zero. The two valid shapes pass; the two invalid shapes fail loud.

const v = (over: Partial<ReviewVerdict> = {}): ReviewVerdict => ({
  verdict: 'PASS',
  blockers: [],
  suggestions: [],
  ...over,
});

describe('assertValidVerdict (AC-L5-1)', () => {
  it('a PASS with zero blockers is valid', () => {
    expect(() => assertValidVerdict(v({ verdict: 'PASS', blockers: [] }))).not.toThrow();
  });

  it('an ISSUES with ≥1 named blocker is valid', () => {
    expect(() =>
      assertValidVerdict(v({ verdict: 'ISSUES', blockers: [{ summary: 'tests fail' }] })),
    ).not.toThrow();
  });

  it('an ISSUES with NO blocker throws (the banned rubber-stamp inverse)', () => {
    expect(() => assertValidVerdict(v({ verdict: 'ISSUES', blockers: [] }))).toThrow(
      /ISSUES verdict must name at least one blocker/,
    );
  });

  it('a PASS carrying a blocker throws (a contradiction)', () => {
    expect(() =>
      assertValidVerdict(v({ verdict: 'PASS', blockers: [{ summary: 'leftover' }] })),
    ).toThrow(/PASS verdict must carry zero blockers/);
  });

  it('suggestions and an optional verification marker do not affect validity', () => {
    expect(() =>
      assertValidVerdict(
        v({
          verdict: 'PASS',
          blockers: [],
          suggestions: [{ summary: 'consider renaming' }],
          verification: {
            commands_run: ['pnpm test'],
            suite_result: 'pass',
            baseline_compared: true,
          },
        }),
      ),
    ).not.toThrow();
  });
});
