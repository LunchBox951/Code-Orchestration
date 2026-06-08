import { describe, it, expect } from 'vitest';
import { resolveReviewSpecRef, renderReviewSpecRef, NO_LOCKED_SPEC_MARKER } from './spec-ref.js';

// AC-L5-8: the pure spec-ref marker + seam

describe('resolveReviewSpecRef — pure discriminated result', () => {
  it('undefined ⇒ { kind: no-locked-spec }', () => {
    expect(resolveReviewSpecRef(undefined)).toEqual({ kind: 'no-locked-spec' });
  });

  it('empty string ⇒ { kind: no-locked-spec }', () => {
    expect(resolveReviewSpecRef('')).toEqual({ kind: 'no-locked-spec' });
  });

  it('whitespace-only string ⇒ { kind: no-locked-spec }', () => {
    expect(resolveReviewSpecRef('   ')).toEqual({ kind: 'no-locked-spec' });
  });

  it('non-empty string ⇒ { kind: criteria, ref: trimmed }', () => {
    const ref = 'docs/specs/2026-06-07-stage-5-7fa7.locked.md#AC-L5-8';
    expect(resolveReviewSpecRef(ref)).toEqual({ kind: 'criteria', ref });
  });

  it('trims surrounding whitespace from a criteria ref', () => {
    expect(resolveReviewSpecRef('  some-ref  ')).toEqual({ kind: 'criteria', ref: 'some-ref' });
  });
});

describe('renderReviewSpecRef — human-readable marker (AC-L5-8: never <TODO>)', () => {
  it('no-locked-spec ⇒ the explicit "no locked spec" literal', () => {
    const result = renderReviewSpecRef({ kind: 'no-locked-spec' });
    expect(result).toBe(NO_LOCKED_SPEC_MARKER);
    expect(result).toBe('no locked spec');
  });

  it('criteria ⇒ the ref string verbatim', () => {
    const ref = 'docs/specs/task.locked.md#AC-1';
    expect(renderReviewSpecRef({ kind: 'criteria', ref })).toBe(ref);
  });

  it('the string "<TODO>" NEVER appears in any rendered marker', () => {
    const markers = [
      renderReviewSpecRef({ kind: 'no-locked-spec' }),
      renderReviewSpecRef({ kind: 'criteria', ref: 'some-real-ref' }),
    ];
    for (const m of markers) {
      expect(m).not.toContain('<TODO>');
    }
  });
});
