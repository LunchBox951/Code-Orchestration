import { describe, expect, it } from 'vitest';
import {
  reviewDetailNeedsRebuild,
  reviewDetailSignature,
  type ReviewDetailSignature,
  type ReviewStateView,
} from './review-render-helpers.js';

// Stage 13 · review #316 follow-up — the verdict-composer caret-preservation decision. The detail pane
// is rebuilt on every ReviewState emit; while typing, that recreates the focused textarea and drops the
// caret. reviewDetailNeedsRebuild returns false ONLY when the sole change is composer.body AND the
// composer textarea is focused, so renderReview can skip the rebuild and preserve the caret.

const baseSig: ReviewDetailSignature = {
  selectedReviewId: 'rev-1',
  contextKey: 'ctx-1',
  composerActive: true,
  composerVerdict: 'PASS',
  composerPending: false,
};

describe('reviewDetailNeedsRebuild', () => {
  it('rebuilds on the first render (prev == null), regardless of focus', () => {
    expect(reviewDetailNeedsRebuild(null, baseSig, true)).toBe(true);
    expect(reviewDetailNeedsRebuild(null, baseSig, false)).toBe(true);
  });

  it('rebuilds when the composer textarea is NOT focused, even if the signatures are identical', () => {
    expect(reviewDetailNeedsRebuild(baseSig, { ...baseSig }, false)).toBe(true);
  });

  it('SKIPS the rebuild when only composer.body changed and the composer is focused', () => {
    // composer.body is NOT part of the signature, so a body-only edit yields an identical signature.
    expect(reviewDetailNeedsRebuild(baseSig, { ...baseSig }, true)).toBe(false);
  });

  it('rebuilds (even when focused) when a non-body field changed', () => {
    expect(reviewDetailNeedsRebuild(baseSig, { ...baseSig, selectedReviewId: 'rev-2' }, true)).toBe(
      true,
    );
    expect(reviewDetailNeedsRebuild(baseSig, { ...baseSig, contextKey: 'ctx-2' }, true)).toBe(true);
    expect(reviewDetailNeedsRebuild(baseSig, { ...baseSig, composerActive: false }, true)).toBe(
      true,
    );
    expect(reviewDetailNeedsRebuild(baseSig, { ...baseSig, composerVerdict: 'ISSUES' }, true)).toBe(
      true,
    );
    expect(reviewDetailNeedsRebuild(baseSig, { ...baseSig, composerPending: true }, true)).toBe(
      true,
    );
  });
});

describe('reviewDetailSignature', () => {
  const loadedContext = {
    status: 'loaded',
    value: {
      kind: 'resolved',
      reviewId: 'rev-1',
      branch: 'co/x',
      target: 'main',
      scope: 'merge',
      diff: { kind: 'patch', patch: '@@' },
      criteria: { kind: 'no-locked-spec' },
    },
  };

  function stateView(over: Partial<{ body: string; context: unknown }> = {}): ReviewStateView {
    // The real ReviewState.composer carries `body`; ReviewStateView omits it. Building the composer as a
    // variable (not an inline literal) lets structural typing accept the extra `body` field — exactly how
    // renderReview passes the full ReviewState — so we can prove the signature ignores it.
    const composer = { active: true, verdict: 'PASS', pending: false, body: over.body ?? '' };
    return {
      selectedReviewId: 'rev-1',
      context: 'context' in over ? over.context : loadedContext,
      composer,
    };
  }

  it('projects the non-body fields and excludes composer.body', () => {
    const sig = reviewDetailSignature(stateView({ body: 'typed so far' }));
    expect(sig.selectedReviewId).toBe('rev-1');
    expect(sig.contextKey).toContain('loaded:resolved');
    expect(sig.contextKey).toContain('patch:2:@@');
    expect(sig.composerActive).toBe(true);
    expect(sig.composerVerdict).toBe('PASS');
    expect(sig.composerPending).toBe(false);
    expect(JSON.stringify(sig)).not.toContain('typed so far');
  });

  it('keeps contextKey bounded for large diff patches', () => {
    const bigPatch = `diff --git a/file b/file\n${'x'.repeat(5000)}\nend`;
    const sig = reviewDetailSignature(
      stateView({
        context: {
          ...loadedContext,
          value: { ...loadedContext.value, diff: { kind: 'patch', patch: bigPatch } },
        },
      }),
    );
    expect(sig.contextKey).toContain(`patch:${bigPatch.length}:`);
    expect(sig.contextKey.length).toBeLessThan(500);
    expect(sig.contextKey).not.toContain('x'.repeat(1000));
  });

  it('yields an identical signature when only composer.body changed (same context reference)', () => {
    // This is the exact keystroke case: the VM keeps the same context reference and only edits body.
    const a = reviewDetailSignature(stateView({ body: 'ab', context: loadedContext }));
    const b = reviewDetailSignature(stateView({ body: 'abc', context: loadedContext }));
    expect(a).toEqual(b);
    expect(reviewDetailNeedsRebuild(a, b, true)).toBe(false);
  });

  it('changes contextKey when the context changes (so the detail rebuilds)', () => {
    const loading = reviewDetailSignature(stateView({ context: { status: 'loading' } }));
    const loaded = reviewDetailSignature(stateView({ context: loadedContext }));
    expect(loading.contextKey).not.toBe(loaded.contextKey);
    expect(reviewDetailNeedsRebuild(loading, loaded, true)).toBe(true);
  });

  it('serializes a null context to a stable key', () => {
    expect(reviewDetailSignature(stateView({ context: null })).contextKey).toBe('null');
  });
});
