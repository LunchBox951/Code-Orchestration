import { describe, it, expect } from 'vitest';
import {
  resolveReviewSpecRef,
  renderReviewSpecRef,
  resolveSpecRefFromStore,
  NO_LOCKED_SPEC_MARKER,
} from './spec-ref.js';
import type { SpecRecord } from '../specs/events.js';
import type { SpecStore } from '../specs/specs-store.js';

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

// L6b F2 (RG-4 / SH-2): resolve the criteria ref from the spec RECORD store — only a locked spec
// yields criteria; a draft/absent spec yields the explicit no-locked-spec marker.

function makeRecord(taskId: string, state: SpecRecord['state']): SpecRecord {
  return {
    taskId,
    title: 'T',
    goal: 'G',
    criteria: [{ text: 'expired tokens rejected (401)', verify: 'pnpm test' }],
    body: 'body',
    state,
    ...(state === 'locked' ? { lockedBy: '@operator', lockedTs: 2 } : {}),
    draftedTs: 1,
  };
}

/** A stub store over a single in-memory record. */
function stubStore(record: SpecRecord | undefined): Pick<SpecStore, 'getSpec'> {
  return { getSpec: (taskId) => (record?.taskId === taskId ? record : undefined) };
}

describe('resolveSpecRefFromStore — record-aware resolver (RG-4)', () => {
  it('a LOCKED spec yields { kind: criteria } with a stable record-derived ref', () => {
    const specs = stubStore(makeRecord('task-1', 'locked'));
    expect(resolveSpecRefFromStore(specs, 'task-1')).toEqual({
      kind: 'criteria',
      ref: 'spec:task-1#locked',
    });
  });

  it('a DRAFT spec yields the explicit no-locked-spec marker (never silently passes)', () => {
    const specs = stubStore(makeRecord('task-2', 'draft'));
    expect(resolveSpecRefFromStore(specs, 'task-2')).toEqual({ kind: 'no-locked-spec' });
  });

  it('an ARCHIVED spec yields the explicit no-locked-spec marker', () => {
    const specs = stubStore(makeRecord('task-3', 'archived'));
    expect(resolveSpecRefFromStore(specs, 'task-3')).toEqual({ kind: 'no-locked-spec' });
  });

  it('an ABSENT spec yields the explicit no-locked-spec marker', () => {
    const specs = stubStore(undefined);
    expect(resolveSpecRefFromStore(specs, 'ghost')).toEqual({ kind: 'no-locked-spec' });
  });

  it('the resolved criteria ref is a record reference, never a filesystem path', () => {
    const specs = stubStore(makeRecord('task-4', 'locked'));
    const ref = resolveSpecRefFromStore(specs, 'task-4');
    expect(ref.kind).toBe('criteria');
    if (ref.kind === 'criteria') {
      expect(ref.ref).toBe('spec:task-4#locked');
      expect(ref.ref).not.toContain('/');
      expect(ref.ref).not.toContain('.md');
      expect(renderReviewSpecRef(ref)).not.toContain('<TODO>');
    }
  });
});
