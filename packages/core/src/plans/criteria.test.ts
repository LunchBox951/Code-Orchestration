import { describe, it, expect } from 'vitest';
import type { Criterion } from '../specs/criteria-schema.js';
import { validateCriteria, VACUOUS_PHRASES, type CriterionViolation } from './criteria.js';

// L6b F2 D2 — the criterion validator is the E2/AC proof: GREEN on real (wired, concrete) criteria,
// RED on fuzzy (no command) or vacuous text. The STRUCTURAL check (a wired `verify` present) is the
// real bite; it NEVER hard-codes a project command.

describe('validateCriteria — valid (green) criteria → []', () => {
  it('a concrete outcome wired to a real command is valid', () => {
    const criteria: Criterion[] = [
      { text: 'expired tokens rejected (401)', verify: 'pnpm vitest run packages/core/x' },
    ];
    expect(validateCriteria(criteria)).toEqual([]);
  });

  it('a criterion wired to a real gate command is valid', () => {
    const criteria: Criterion[] = [{ text: 'format check passes', verify: 'pnpm format:check' }];
    expect(validateCriteria(criteria)).toEqual([]);
  });

  it('accepts ANY non-empty verify string — NOT hard-coded to project commands', () => {
    const criteria: Criterion[] = [{ text: 'custom outcome', verify: 'some/arbitrary --command' }];
    expect(validateCriteria(criteria)).toEqual([]);
  });

  it('does NOT flag a concrete text merely for containing the substring "works"', () => {
    const criteria: Criterion[] = [
      {
        text: 'refresh works after expiry → 401 then 200',
        verify: 'pnpm vitest run packages/core',
      },
    ];
    expect(validateCriteria(criteria)).toEqual([]);
  });

  it('an empty criteria list is trivially valid', () => {
    expect(validateCriteria([])).toEqual([]);
  });
});

describe('validateCriteria — fuzzy/no-command criteria → one violation (the structural bite)', () => {
  it('a criterion with no verify command is invalid', () => {
    const criteria: Criterion[] = [{ text: 'auth works' }];
    const violations = validateCriteria(criteria);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toEqual<CriterionViolation>({
      index: 0,
      text: 'auth works',
      reason: 'no wired verification command',
    });
  });

  it('a blank verify command is treated as missing', () => {
    const criteria: Criterion[] = [{ text: 'auth works', verify: '   ' }];
    const violations = validateCriteria(criteria);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toBe('no wired verification command');
  });
});

describe('validateCriteria — vacuous text even WITH a command → one violation', () => {
  it('flags a bare vacuous phrase even though it is wired to a command', () => {
    const criteria: Criterion[] = [{ text: 'works', verify: 'pnpm test' }];
    const violations = validateCriteria(criteria);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toEqual<CriterionViolation>({
      index: 0,
      text: 'works',
      reason: 'vacuous acceptance text',
    });
  });

  it('flags vacuous phrases hidden behind a generic subject or qualifier', () => {
    const cases = ['it works', 'the build is clean', 'works well', 'looks good', 'well'];
    for (const text of cases) {
      const violations = validateCriteria([{ text, verify: 'pnpm test' }]);
      expect(violations, `expected "${text}" to be flagged vacuous`).toHaveLength(1);
      expect(violations[0]?.reason).toBe('vacuous acceptance text');
    }
  });

  it('every seed VACUOUS_PHRASES entry is flagged when wired to a command', () => {
    for (const phrase of VACUOUS_PHRASES) {
      const violations = validateCriteria([{ text: phrase, verify: 'pnpm test' }]);
      expect(violations, `expected seed phrase "${phrase}" to be flagged`).toHaveLength(1);
      expect(violations[0]?.reason).toBe('vacuous acceptance text');
    }
  });
});

describe('validateCriteria — multiple bad criteria → one violation each, correct index', () => {
  it('reports one violation per failed criterion with the right index', () => {
    const criteria: Criterion[] = [
      { text: 'expired tokens rejected (401)', verify: 'pnpm vitest run packages/core/x' }, // valid
      { text: 'auth works' }, // no command
      { text: 'format check passes', verify: 'pnpm format:check' }, // valid
      { text: 'works', verify: 'pnpm test' }, // vacuous
    ];
    const violations = validateCriteria(criteria);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toEqual<CriterionViolation>({
      index: 1,
      text: 'auth works',
      reason: 'no wired verification command',
    });
    expect(violations[1]).toEqual<CriterionViolation>({
      index: 3,
      text: 'works',
      reason: 'vacuous acceptance text',
    });
  });
});
