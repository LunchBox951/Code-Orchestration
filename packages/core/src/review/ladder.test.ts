import { describe, it, expect } from 'vitest';
import {
  classifyFinding,
  applyLadder,
  type FindingCategory,
  type ReviewScope,
  type LadderFinding,
} from './ladder.js';

// AC-L5-2: the strictness ladder. The HEADLINE invariant: the same cosmetic nit that is a
// suggestion at worker_merge becomes a blocker at pr_merge. Correctness is a blocker everywhere;
// quality sits in-between (suggestion at worker_merge, blocker at phase_merge+pr_merge).

describe('AC-L5-2 — classifyFinding: same nit, different scope (the headline invariant)', () => {
  it('(cosmetic, worker_merge) → suggestion', () => {
    expect(classifyFinding('cosmetic', 'worker_merge')).toBe('suggestion');
  });

  it('(cosmetic, pr_merge) → blocker — same nit, stricter scope', () => {
    expect(classifyFinding('cosmetic', 'pr_merge')).toBe('blocker');
  });

  it('(cosmetic, phase_merge) → suggestion — sits between worker and pr', () => {
    expect(classifyFinding('cosmetic', 'phase_merge')).toBe('suggestion');
  });
});

describe('AC-L5-2 — correctness is a blocker at every scope', () => {
  const scopes: ReviewScope[] = ['worker_merge', 'phase_merge', 'pr_merge'];
  for (const scope of scopes) {
    it(`(correctness, ${scope}) → blocker`, () => {
      expect(classifyFinding('correctness', scope)).toBe('blocker');
    });
  }
});

describe('AC-L5-2 — quality tightens toward production', () => {
  it('(quality, worker_merge) → suggestion', () => {
    expect(classifyFinding('quality', 'worker_merge')).toBe('suggestion');
  });

  it('(quality, phase_merge) → blocker', () => {
    expect(classifyFinding('quality', 'phase_merge')).toBe('blocker');
  });

  it('(quality, pr_merge) → blocker', () => {
    expect(classifyFinding('quality', 'pr_merge')).toBe('blocker');
  });
});

describe('AC-L5-2 — the table is monotone: scope bar never loosens toward production', () => {
  const categories: FindingCategory[] = ['cosmetic', 'quality', 'correctness'];
  const scopes: ReviewScope[] = ['worker_merge', 'phase_merge', 'pr_merge'];
  const order: Record<'blocker' | 'suggestion', number> = { blocker: 1, suggestion: 0 };

  it('the classification is ≥ the previous scope for every category (monotone tightening)', () => {
    for (const cat of categories) {
      let prev = order[classifyFinding(cat, scopes[0]!)];
      for (const scope of scopes.slice(1)) {
        const curr = order[classifyFinding(cat, scope)];
        expect(curr).toBeGreaterThanOrEqual(prev);
        prev = curr;
      }
    }
  });
});

describe('applyLadder — partitions a finding list into blockers/suggestions by scope', () => {
  const findings: LadderFinding[] = [
    { category: 'cosmetic', summary: 'trailing whitespace' },
    { category: 'quality', summary: 'missing edge-case test' },
    { category: 'correctness', summary: 'null pointer bug' },
  ];

  it('at worker_merge: only correctness is a blocker', () => {
    const result = applyLadder(findings, 'worker_merge');
    expect(result.blockers.map((f) => f.summary)).toEqual(['null pointer bug']);
    expect(result.suggestions.map((f) => f.summary)).toEqual([
      'trailing whitespace',
      'missing edge-case test',
    ]);
  });

  it('at phase_merge: quality + correctness are blockers', () => {
    const result = applyLadder(findings, 'phase_merge');
    expect(result.blockers.map((f) => f.summary)).toEqual([
      'missing edge-case test',
      'null pointer bug',
    ]);
    expect(result.suggestions.map((f) => f.summary)).toEqual(['trailing whitespace']);
  });

  it('at pr_merge: all three are blockers, zero suggestions', () => {
    const result = applyLadder(findings, 'pr_merge');
    expect(result.blockers.map((f) => f.summary)).toEqual([
      'trailing whitespace',
      'missing edge-case test',
      'null pointer bug',
    ]);
    expect(result.suggestions).toEqual([]);
  });

  it('preserves input order within each partition', () => {
    const result = applyLadder(findings, 'worker_merge');
    // cosmetic and quality both land in suggestions, in their original order.
    expect(result.suggestions[0]?.category).toBe('cosmetic');
    expect(result.suggestions[1]?.category).toBe('quality');
  });

  it('returns empty partitions for an empty findings list', () => {
    const result = applyLadder([], 'pr_merge');
    expect(result.blockers).toEqual([]);
    expect(result.suggestions).toEqual([]);
  });
});
