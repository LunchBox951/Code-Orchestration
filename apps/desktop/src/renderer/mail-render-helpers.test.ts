import { describe, expect, it } from 'vitest';
import {
  mailDetailNeedsRebuild,
  mailDetailSignature,
  type MailDetailSignature,
  type MailStateView,
} from './mail-render-helpers.js';

// Bug #39 — the reply/decision-composer caret-preservation decision. The mail detail pane is rebuilt on
// every MailState emit; while typing, that recreates the focused textarea and drops the caret to the
// start, so the operator's text comes out reversed. mailDetailNeedsRebuild returns false ONLY when the
// sole change is composer.body AND the composer textarea is focused, so renderMailDetail can skip the
// rebuild and preserve the caret.

const baseSig: MailDetailSignature = {
  selectedKey: 'seq-1',
  composerActive: true,
  composerPending: false,
};

function stateView(overrides: {
  seq?: number;
  type?: string;
  subject?: string;
  active?: boolean;
  pending?: boolean;
}): MailStateView {
  return {
    selected: {
      seq: overrides.seq ?? 1,
      type: overrides.type ?? 'clarify_request',
      kind: 'actionable',
      subject: overrides.subject ?? 'Re: host proof',
      sender: 'coordinator-1',
      recipient: '@operator',
      renderedBody: 'Which provider should I run host-proof against?',
    },
    composer: { active: overrides.active ?? true, pending: overrides.pending ?? false },
  };
}

describe('mailDetailNeedsRebuild', () => {
  it('rebuilds on the first render (prev == null), regardless of focus', () => {
    expect(mailDetailNeedsRebuild(null, baseSig, true)).toBe(true);
    expect(mailDetailNeedsRebuild(null, baseSig, false)).toBe(true);
  });

  it('rebuilds when the composer textarea is NOT focused, even if the signatures are identical', () => {
    expect(mailDetailNeedsRebuild(baseSig, { ...baseSig }, false)).toBe(true);
  });

  it('SKIPS the rebuild when focused and only the (excluded) body changed — preserves the caret (#39)', () => {
    // Two states that differ only by composer.body produce identical signatures, so the rebuild is skipped.
    const prev = mailDetailSignature(stateView({}));
    const next = mailDetailSignature(stateView({})); // body lives outside the signature
    expect(next).toEqual(prev);
    expect(mailDetailNeedsRebuild(prev, next, true)).toBe(false);
  });

  it('rebuilds when focused and a non-body field changed (new selection / composer toggle / pending)', () => {
    const base = mailDetailSignature(stateView({}));
    expect(mailDetailNeedsRebuild(base, mailDetailSignature(stateView({ seq: 2 })), true)).toBe(
      true,
    );
    expect(
      mailDetailNeedsRebuild(base, mailDetailSignature(stateView({ subject: 'Other' })), true),
    ).toBe(true);
    expect(
      mailDetailNeedsRebuild(base, mailDetailSignature(stateView({ active: false })), true),
    ).toBe(true);
    expect(
      mailDetailNeedsRebuild(base, mailDetailSignature(stateView({ pending: true })), true),
    ).toBe(true);
  });
});

describe('mailDetailSignature', () => {
  it('excludes the composer body (the field a keystroke changes)', () => {
    // The view interface has no body field at all; identical non-body inputs → identical signatures.
    expect(mailDetailSignature(stateView({}))).toEqual(mailDetailSignature(stateView({})));
  });

  it('fingerprints null selection distinctly from a selected message', () => {
    const empty = mailDetailSignature({
      selected: null,
      composer: { active: false, pending: false },
    });
    expect(empty.selectedKey).toBe('null');
    expect(empty.selectedKey).not.toBe(mailDetailSignature(stateView({})).selectedKey);
  });
});
