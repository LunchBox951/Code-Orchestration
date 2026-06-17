import { describe, expect, it } from 'vitest';
import {
  captureInteractionState,
  mailDetailSignature,
  needsRebuild,
  restoreInteractionState,
  signaturesEqual,
  type CapturedInteractionState,
  type MailRowView,
  type MailStateView,
} from './live-render-helpers.js';

// Stage 15 · P-DT1 · AC-S15-9 [SF-4]. These exercise the LIVE-tick decision + capture/restore logic
// directly on plain objects / a hand-rolled fake element — there is no DOM test env, and the substantive
// coverage must be behavioral on the pure helper (not static markup assertions).

// ── needsRebuild: the live-tick rebuild gate ─────────────────────────────────────

describe('needsRebuild', () => {
  const sig = { a: 'x', b: 1, c: true } as const;

  it('rebuilds on the first render (prev == null), regardless of focus', () => {
    expect(needsRebuild(null, sig, true)).toBe(true);
    expect(needsRebuild(null, sig, false)).toBe(true);
  });

  it('rebuilds when the interactive element is NOT focused, even if the signature is identical', () => {
    expect(needsRebuild(sig, { ...sig }, false)).toBe(true);
  });

  it('SKIPS the rebuild when the signature is unchanged AND the element is focused', () => {
    // An equal signature means the only thing that changed is the live-owned field (excluded from the
    // signature). The focused element already holds it, so a rebuild would needlessly drop the caret.
    expect(needsRebuild(sig, { ...sig }, true)).toBe(false);
  });

  it('rebuilds (even when focused) when any signature field changed', () => {
    expect(needsRebuild(sig, { ...sig, a: 'y' }, true)).toBe(true);
    expect(needsRebuild(sig, { ...sig, b: 2 }, true)).toBe(true);
    expect(needsRebuild(sig, { ...sig, c: false }, true)).toBe(true);
  });
});

describe('signaturesEqual', () => {
  it('is reference-equal short-circuit safe', () => {
    const s = { a: 1 };
    expect(signaturesEqual(s, s)).toBe(true);
  });

  it('compares by every own key (value and arity)', () => {
    expect(signaturesEqual({ a: 1, b: 'x' }, { a: 1, b: 'x' })).toBe(true);
    expect(signaturesEqual({ a: 1, b: 'x' }, { a: 1, b: 'y' })).toBe(false);
    expect(signaturesEqual({ a: 1 }, { a: 1, b: 'x' })).toBe(false);
    expect(signaturesEqual({ a: 1, b: 'x' }, { a: 1 })).toBe(false);
  });
});

// ── Mail detail signature + multi-tick typing behaviour ──────────────────────────

const BASE_ROW: MailRowView = {
  seq: 7,
  type: 'clarify_request',
  subject: 'Re: host proof',
  sender: 'lead-s15',
  recipient: 'impl-s15',
  card: {
    title: 'Re: host proof',
    fields: [{ label: 'From', value: 'lead-s15' }],
    body: 'please run host proof',
  },
  kind: 'actionable',
};

function mailView(
  over: {
    body?: string;
    selected?: Partial<MailRowView> | null;
    active?: boolean;
    pending?: boolean;
  } = {},
): MailStateView {
  const selected: MailRowView | null =
    over.selected === null ? null : { ...BASE_ROW, ...(over.selected ?? {}) };
  // The real ComposerState carries `body`; MailStateView omits it. Building composer as a variable lets
  // structural typing accept the extra field — exactly how renderMailDetail passes the full MailState —
  // so we can prove the signature ignores it.
  const composer = {
    active: over.active ?? true,
    pending: over.pending ?? false,
    body: over.body ?? '',
  };
  return { selected, composer };
}

describe('mailDetailSignature', () => {
  it('projects the rendered fields and EXCLUDES composer.body', () => {
    const sig = mailDetailSignature(mailView({ body: 'foorp tsoh nur' }));
    expect(sig['selectedSeq']).toBe(7);
    expect(sig['type']).toBe('clarify_request');
    expect(sig['subject']).toBe('Re: host proof');
    expect(sig['sender']).toBe('lead-s15');
    expect(sig['recipient']).toBe('impl-s15');
    expect(sig['card']).toBe(
      '{"title":"Re: host proof","fields":[["From","lead-s15"]],"body":"please run host proof"}',
    );
    expect(sig['kind']).toBe('actionable');
    expect(sig['composerActive']).toBe(true);
    expect(sig['composerPending']).toBe(false);
    expect(JSON.stringify(sig)).not.toContain('foorp tsoh nur');
  });

  it('serialises a null selection to stable empty/null fields', () => {
    const sig = mailDetailSignature(mailView({ selected: null, active: false }));
    expect(sig['selectedSeq']).toBeNull();
    expect(sig['type']).toBe('');
    expect(sig['composerActive']).toBe(false);
  });

  it('captures the review-request idempotencyKey (drives the Open-in-Reviews link)', () => {
    const sig = mailDetailSignature(
      mailView({ selected: { idempotencyKey: 'review-request:r-1' } }),
    );
    expect(sig['idempotencyKey']).toBe('review-request:r-1');
  });
});

describe('multi-tick: typing in the mail composer (GitHub #39)', () => {
  it('does NOT rebuild for body-only deltas while the composer is focused', () => {
    // "r" → "ru" → "run": each tick only changes composer.body, which the signature excludes.
    const r = mailDetailSignature(mailView({ body: 'r' }));
    const ru = mailDetailSignature(mailView({ body: 'ru' }));
    const run = mailDetailSignature(mailView({ body: 'run' }));
    expect(r).toEqual(ru);
    expect(ru).toEqual(run);
    expect(needsRebuild(r, ru, true)).toBe(false);
    expect(needsRebuild(ru, run, true)).toBe(false);
  });

  it('DOES rebuild when a non-body field changes mid-edit', () => {
    const before = mailDetailSignature(mailView({ body: 'run', pending: false }));
    const pendingFlipped = mailDetailSignature(mailView({ body: 'run', pending: true }));
    const subjectChanged = mailDetailSignature(
      mailView({ body: 'run', selected: { subject: 'Re: different' } }),
    );
    const cardChanged = mailDetailSignature(
      mailView({
        body: 'run',
        selected: {
          card: { ...BASE_ROW.card, body: 'changed card body' },
        },
      }),
    );
    expect(needsRebuild(before, pendingFlipped, true)).toBe(true);
    expect(needsRebuild(before, subjectChanged, true)).toBe(true);
    expect(needsRebuild(before, cardChanged, true)).toBe(true);
  });

  it('DOES rebuild when the composer is not focused, and on first render', () => {
    const run = mailDetailSignature(mailView({ body: 'run' }));
    expect(needsRebuild(run, run, false)).toBe(true);
    expect(needsRebuild(null, run, true)).toBe(true);
  });
});

// ── capture / restore: scroll + caret + focus across a rebuild ───────────────────

class FakeTextarea {
  scrollTop: number;
  selectionStart: number | null;
  selectionEnd: number | null;
  focusCount = 0;
  setSelectionCalls: Array<readonly [number, number]> = [];

  constructor(
    init: { scrollTop?: number; selectionStart?: number | null; selectionEnd?: number | null } = {},
  ) {
    this.scrollTop = init.scrollTop ?? 0;
    this.selectionStart = init.selectionStart ?? null;
    this.selectionEnd = init.selectionEnd ?? null;
  }

  setSelectionRange(start: number, end: number): void {
    this.setSelectionCalls.push([start, end]);
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  focus(): void {
    this.focusCount += 1;
  }
}

// A plain scroll container: no caret, no setSelectionRange (the <div>/<main> case).
class FakeScrollContainer {
  scrollTop: number;
  focusCount = 0;
  constructor(scrollTop = 0) {
    this.scrollTop = scrollTop;
  }
  focus(): void {
    this.focusCount += 1;
  }
}

describe('captureInteractionState / restoreInteractionState', () => {
  it('preserves scroll position across a rebuild', () => {
    const outgoing = new FakeTextarea({ scrollTop: 120 });
    const captured = captureInteractionState(outgoing, true);
    // Simulate the rebuild: a brand-new element at scrollTop 0.
    const incoming = new FakeTextarea({ scrollTop: 0 });
    restoreInteractionState(incoming, captured);
    expect(incoming.scrollTop).toBe(120);
  });

  it('preserves the caret via setSelectionRange across a rebuild', () => {
    const outgoing = new FakeTextarea({ selectionStart: 3, selectionEnd: 3 });
    const captured = captureInteractionState(outgoing, true);
    const incoming = new FakeTextarea();
    restoreInteractionState(incoming, captured);
    expect(incoming.setSelectionCalls).toEqual([[3, 3]]);
    expect(incoming.selectionStart).toBe(3);
    expect(incoming.selectionEnd).toBe(3);
  });

  it('preserves a non-collapsed selection range', () => {
    const captured = captureInteractionState(
      new FakeTextarea({ selectionStart: 2, selectionEnd: 8 }),
      true,
    );
    const incoming = new FakeTextarea();
    restoreInteractionState(incoming, captured);
    expect(incoming.setSelectionCalls).toEqual([[2, 8]]);
  });

  it('re-focuses ONLY when the element was focused at capture time', () => {
    const focusedCap = captureInteractionState(
      new FakeTextarea({ selectionStart: 1, selectionEnd: 1 }),
      true,
    );
    const a = new FakeTextarea();
    restoreInteractionState(a, focusedCap);
    expect(a.focusCount).toBe(1);

    const blurredCap = captureInteractionState(
      new FakeTextarea({ selectionStart: 1, selectionEnd: 1 }),
      false,
    );
    const b = new FakeTextarea();
    restoreInteractionState(b, blurredCap);
    expect(b.focusCount).toBe(0);
  });

  it('restores scroll only (no caret, no focus) for a plain scroll container', () => {
    const outgoing = new FakeScrollContainer(240);
    const captured = captureInteractionState(outgoing); // focused defaults to false
    expect(captured.selectionStart).toBeNull();
    expect(captured.selectionEnd).toBeNull();
    expect(captured.focused).toBe(false);

    const incoming = new FakeScrollContainer(0);
    restoreInteractionState(incoming, captured);
    expect(incoming.scrollTop).toBe(240);
    expect(incoming.focusCount).toBe(0);
  });

  it('does not call setSelectionRange when the captured caret is null', () => {
    const captured: CapturedInteractionState = {
      scrollTop: 10,
      selectionStart: null,
      selectionEnd: null,
      focused: true,
    };
    const incoming = new FakeTextarea({ scrollTop: 0 });
    restoreInteractionState(incoming, captured);
    expect(incoming.scrollTop).toBe(10);
    expect(incoming.setSelectionCalls).toEqual([]);
    expect(incoming.focusCount).toBe(1);
  });
});
