import { afterEach, describe, it, expect, vi } from 'vitest';
import { FakePty } from './fake-pty.js';
import type { SpawnSpec } from './pty-host.js';
import { injectMail, adaptiveSettleMs } from './mail-injector.js';

const ESC = '\u001B';
const PASTE_START = ESC + '[200~';
const PASTE_END = ESC + '[201~';
const CLEAR_COMPOSER = '\u0015';
const SUBMIT = '\r';

const CLAUDE_SPEC: SpawnSpec = {
  command: 'claude',
  args: [],
  cwd: '/work/agent',
  env: { CLAUDE_CONFIG_DIR: '/data/config/agent' },
};

const CODEX_SPEC: SpawnSpec = {
  command: 'codex',
  args: [],
  cwd: '/work/agent',
  env: { CODEX_HOME: '/data/config/agent' },
};

// [synthesized] Claude MCP-tool permission prompt (host-confirmed later).
const CLAUDE_PERMISSION =
  'Claude wants to use co_probe.\nDo you want to proceed?\n❯ 1. Yes\n  2. No\n';

/**
 * A fully test-controlled settle/retry window: each `delay()` parks until `release()` drains it.
 *
 * Test-only simplification: the production `retryDelay` seam takes an `AbortSignal` (aborted the
 * instant the echo wins, so the real timer is cleared) — this stub deliberately IGNORES the signal
 * and just leaves a never-resolved parked promise behind when the echo race wins. That is benign in
 * tests (the won race is settled; the dangling promise is GC'd at test end and never observed); we
 * skip honoring the signal only to keep the helper a two-liner.
 */
function controllableDelay(): { delay: () => Promise<void>; release: () => void } {
  const resolvers: Array<() => void> = [];
  return {
    delay: () => new Promise<void>((resolve) => resolvers.push(resolve)),
    release: () => {
      while (resolvers.length) resolvers.shift()!();
    },
  };
}
/** Drain the microtask + macrotask queue so the async injector advances to its next await. */
const tick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
});

describe('injectMail — single-line: write, echo-verify, exactly one submit', () => {
  it('writes the text, then exactly one Enter once the composer echoes it (one turn, no fan-out)', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    const { delay } = controllableDelay();
    const p = injectMail(pane, 'do the thing', { provider: 'claude', retryDelay: delay });

    pane.emit('do the thing'); // the composer echoes the typed text → echo-verify passes
    await p;

    expect(pane.written).toEqual(['do the thing', '\r']);
  });
});

describe('injectMail — multi-line: bracketed paste + one submit', () => {
  it('wraps multi-line text in bracketed paste (inner text byte-exact) with one Enter after', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    const { delay } = controllableDelay();
    const text = 'first line\nsecond line';
    const p = injectMail(pane, text, { provider: 'claude', retryDelay: delay });

    pane.emit(text); // the composer renders the pasted content (markers are not echoed glyphs)
    await p;

    expect(pane.written).toEqual([PASTE_START + text + PASTE_END, '\r']);
  });

  it('accepts Claude Code live paste-preview echo for collapsed multiline paste, then submits once', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    const { delay } = controllableDelay();
    const text = 'first line\nsecond line\nthird line\nfourth line\nfifth line\nsixth line';
    const p = injectMail(pane, text, { provider: 'claude', retryDelay: delay });

    pane.emit('[Pasted text #1 +6 lines]\npaste again to expand');
    await p;

    expect(pane.written).toEqual([PASTE_START + text + PASTE_END, '\r']);
  });

  it('fails loud instead of retrying an uncertain delayed multiline echo', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    const { delay, release } = controllableDelay();
    const text = 'first line\nsecond line';
    const p = injectMail(pane, text, { provider: 'claude', retryDelay: delay });
    const rejection = expect(p).rejects.toThrow(/uncertain paste retry/i);

    expect(pane.written).toEqual([PASTE_START + text + PASTE_END]);
    release();
    await rejection;

    pane.emit(text); // delayed echo after failure must not submit a turn
    await tick();
    expect(pane.written).toEqual([PASTE_START + text + PASTE_END]);
  });

  it('can opt into one no-echo submit for host-live proof paths that verify a downstream side effect', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    const { delay, release } = controllableDelay();
    const text = 'first line\nsecond line';
    const p = injectMail(pane, text, {
      provider: 'claude',
      retryDelay: delay,
      allowUnverifiedSubmit: true,
    });

    expect(pane.written).toEqual([PASTE_START + text + PASTE_END]);
    release();
    await p;

    expect(pane.written).toEqual([PASTE_START + text + PASTE_END, '\r']);
  });
});

describe('injectMail — codex collapsed-paste preview (#77)', () => {
  it('accepts a codex collapsed-paste echo carrying BOTH needles, then submits once', async () => {
    const pane = new FakePty().spawn(CODEX_SPEC);
    const { delay } = controllableDelay();
    const text = 'first line\nsecond line\nthird line';
    const p = injectMail(pane, text, { provider: 'codex', retryDelay: delay });

    pane.emit('Pasted text — 12 lines collapsed'); // needles: 'pasted' AND 'lines'
    await p;

    expect(pane.written).toEqual([PASTE_START + text + PASTE_END, '\r']);
  });

  it('does NOT accept a codex echo missing a needle (only "pasted", no "lines")', async () => {
    const pane = new FakePty().spawn(CODEX_SPEC);
    const { delay, release } = controllableDelay();
    const text = 'first line\nsecond line';
    const p = injectMail(pane, text, { provider: 'codex', retryDelay: delay });
    const rejection = expect(p).rejects.toThrow(/uncertain paste retry/i);

    pane.emit('Pasted text — preview'); // 'pasted' present but 'lines' absent → .every() fails
    release(); // the retry window elapses with no full echo
    await rejection;

    expect(pane.written).toEqual([PASTE_START + text + PASTE_END]); // never submitted
  });
});

describe('injectMail — long single-line payloads paste-wrap (#92)', () => {
  // A single line with NO newlines but long enough to soft-wrap in the composer (the reported
  // failure was ~400 chars). The bare-write path fails the echo scan on reflow; pasting dodges it.
  const longLine = 'x'.repeat(400);
  const shortLine = 'do the thing'; // well under the 256-char threshold

  it('bracketed-paste-wraps a ~400-char single line and submits exactly one Enter', async () => {
    const pane = new FakePty().spawn(CODEX_SPEC);
    const { delay } = controllableDelay();
    const p = injectMail(pane, longLine, { provider: 'codex', retryDelay: delay });

    pane.emit(longLine); // composer renders the pasted content (markers are not echoed glyphs)
    await p;

    expect(pane.written).toEqual([PASTE_START + longLine + PASTE_END, '\r']);
    expect(pane.written[0]!.startsWith(PASTE_START)).toBe(true);
    expect(pane.written[0]!.endsWith(PASTE_END)).toBe(true);
  });

  it('still writes a SHORT single line BARE (no over-wrapping below the threshold)', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    const { delay } = controllableDelay();
    const p = injectMail(pane, shortLine, { provider: 'claude', retryDelay: delay });

    pane.emit(shortLine);
    await p;

    expect(pane.written).toEqual([shortLine, '\r']); // bare write, no paste markers
  });

  it('does NOT accept the unverified codex placeholder preview for a long single line', async () => {
    const pane = new FakePty().spawn(CODEX_SPEC);
    const { delay, release } = controllableDelay();
    const p = injectMail(pane, longLine, { provider: 'codex', retryDelay: delay });
    const rejection = expect(p).rejects.toThrow(/uncertain paste retry/i);

    pane.emit('Pasted text — 1 lines collapsed'); // codex needles, NO literal echo of the long line
    release();
    await rejection;

    expect(pane.written).toEqual([PASTE_START + longLine + PASTE_END]);
  });

  it('accepts a Claude paste-preview collapse of a long single line', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    const { delay } = controllableDelay();
    const p = injectMail(pane, longLine, { provider: 'claude', retryDelay: delay });

    pane.emit('[Pasted text #1 +1 lines]\npaste again to expand');
    await p;

    expect(pane.written).toEqual([PASTE_START + longLine + PASTE_END, '\r']);
  });

  it('reports onPasteEcho legacy `multiline` plus additive `pasted` state', async () => {
    const longPane = new FakePty().spawn(CODEX_SPEC);
    const d1 = controllableDelay();
    const longFlags: Array<{ multiline: boolean; pasted: boolean | undefined }> = [];
    const longP = injectMail(longPane, longLine, {
      provider: 'codex',
      retryDelay: d1.delay,
      onPasteEcho: (_chunk, multiline, pasted) => longFlags.push({ multiline, pasted }),
    });
    longPane.emit(longLine);
    await longP;
    expect(longFlags).toEqual([{ multiline: false, pasted: true }]);

    const shortPane = new FakePty().spawn(CLAUDE_SPEC);
    const d2 = controllableDelay();
    const shortFlags: Array<{ multiline: boolean; pasted: boolean | undefined }> = [];
    const shortP = injectMail(shortPane, shortLine, {
      provider: 'claude',
      retryDelay: d2.delay,
      onPasteEcho: (_chunk, multiline, pasted) => shortFlags.push({ multiline, pasted }),
    });
    shortPane.emit(shortLine);
    await shortP;
    expect(shortFlags).toEqual([{ multiline: false, pasted: false }]);

    const multilinePane = new FakePty().spawn(CLAUDE_SPEC);
    const d3 = controllableDelay();
    const multilineFlags: Array<{ multiline: boolean; pasted: boolean | undefined }> = [];
    const multilineP = injectMail(multilinePane, 'line one\nline two', {
      provider: 'claude',
      retryDelay: d3.delay,
      onPasteEcho: (_chunk, multiline, pasted) => multilineFlags.push({ multiline, pasted }),
    });
    multilinePane.emit('line one\nline two');
    await multilineP;
    expect(multilineFlags).toEqual([{ multiline: true, pasted: true }]);
  });

  it('failure-path throw message does NOT say "multiline" for a single-line payload', async () => {
    const pane = new FakePty().spawn(CODEX_SPEC);
    const { delay, release } = controllableDelay();
    const p = injectMail(pane, longLine, { provider: 'codex', retryDelay: delay });
    const rejection = p.catch((e: unknown) => (e as Error).message);

    release(); // settle window elapses with no echo → paste guard throws
    const message = await rejection;
    expect(message).not.toMatch(/multiline/i);
    expect(message).toMatch(/paste/i);
    expect(pane.written).toEqual([PASTE_START + longLine + PASTE_END]); // never submitted
  });
});

describe('adaptiveSettleMs — pure length→window scaler (#92)', () => {
  it('yields a strictly larger window for a longer payload (below the cap), and is capped', () => {
    expect(adaptiveSettleMs(400)).toBeGreaterThan(adaptiveSettleMs(10));
    expect(adaptiveSettleMs(1000)).toBeGreaterThan(adaptiveSettleMs(400));
    // Monotonic non-decreasing and capped — a huge payload never exceeds the ceiling.
    expect(adaptiveSettleMs(1_000_000)).toBe(adaptiveSettleMs(10_000_000));
    expect(adaptiveSettleMs(0)).toBeGreaterThan(0);
  });
});

describe('injectMail — production default settle window', () => {
  it('uses the adaptive fallback when no retryDelay seam is injected', async () => {
    vi.useFakeTimers();
    const pane = new FakePty().spawn(CODEX_SPEC);
    const text = 'z'.repeat(400);
    const payloadLength = PASTE_START.length + text.length + PASTE_END.length;
    const payloadSettleMs = adaptiveSettleMs(payloadLength);
    const p = injectMail(pane, text, { provider: 'codex' });

    expect(pane.written).toEqual([PASTE_START + text + PASTE_END]);

    expect(payloadSettleMs).toBeGreaterThan(adaptiveSettleMs(0));
    await vi.advanceTimersByTimeAsync(payloadSettleMs - 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(pane.written).toEqual([PASTE_START + text + PASTE_END]);

    pane.emit(text);
    await p;
    expect(pane.written).toEqual([PASTE_START + text + PASTE_END, SUBMIT]);
  });
});

describe('injectMail — onPasteEcho observation tap', () => {
  it('invokes onPasteEcho with each emitted chunk and the real paste flag', async () => {
    const pane = new FakePty().spawn(CODEX_SPEC);
    const { delay } = controllableDelay();
    const observed: Array<{ chunk: string; multiline: boolean; pasted: boolean | undefined }> = [];
    const text = 'first line\nsecond line';
    const p = injectMail(pane, text, {
      provider: 'codex',
      retryDelay: delay,
      onPasteEcho: (chunk, multiline, pasted) => observed.push({ chunk, multiline, pasted }),
    });

    pane.emit('Pasted text — 2 lines collapsed');
    await p;

    expect(observed).toEqual([
      { chunk: 'Pasted text — 2 lines collapsed', multiline: true, pasted: true },
    ]);
  });

  it('swallows an onPasteEcho that throws — echo-verify and submit are unaffected', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    const { delay } = controllableDelay();
    const text = 'first line\nsecond line';
    const p = injectMail(pane, text, {
      provider: 'claude',
      retryDelay: delay,
      onPasteEcho: () => {
        throw new Error('observer blew up');
      },
    });

    pane.emit(text); // the composer renders the pasted content; the throwing observer must not break it
    await p;

    expect(pane.written).toEqual([PASTE_START + text + PASTE_END, '\r']); // still submits exactly once
  });
});

describe('injectMail — echo-verify retry (never blind-fire Enter)', () => {
  it('retries the write when no echo renders, and submits only AFTER the echo is seen', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    const { delay, release } = controllableDelay();
    const p = injectMail(pane, 'ping', { provider: 'claude', retryDelay: delay });

    expect(pane.written).toEqual(['ping']); // attempt 0: text written, no echo yet
    release(); // the settle window elapses with no echo → retry
    await tick();
    expect(pane.written).toEqual(['ping', CLEAR_COMPOSER + 'ping']); // retry clears first
    expect(pane.written).not.toContain('\r'); // still no submit — the echo was never seen

    pane.emit('ping'); // NOW the composer echoes
    await p;
    expect(pane.written).toEqual(['ping', CLEAR_COMPOSER + 'ping', '\r']); // submit only after echo
  });

  it('clears before retry so a delayed first echo cannot duplicate composer text', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    const { delay, release } = controllableDelay();
    const p = injectMail(pane, 'ping', { provider: 'claude', retryDelay: delay });

    expect(pane.written).toEqual(['ping']);
    release(); // attempt 0 timed out, but its echo may still arrive later
    await tick();
    expect(pane.written).toEqual(['ping', CLEAR_COMPOSER + 'ping']);

    pane.emit('ping'); // delayed echo from the first accepted write
    await p;

    expect(pane.written).toEqual(['ping', CLEAR_COMPOSER + 'ping', '\r']);
    expect(pane.written.filter((w) => w === 'ping')).toHaveLength(1);
    expect(pane.written.filter((w) => w === CLEAR_COMPOSER + 'ping')).toHaveLength(1);
  });

  it('fails loud (never submits) when the composer never echoes within maxEchoAttempts', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    const { delay, release } = controllableDelay();
    const p = injectMail(pane, 'ping', {
      provider: 'claude',
      retryDelay: delay,
      maxEchoAttempts: 3,
    });
    const rejection = expect(p).rejects.toThrow(/did not echo|blind-fire/i);

    for (let i = 0; i < 3; i++) {
      release(); // drive each settle window to elapse with no echo
      await tick();
    }
    await rejection;

    expect(pane.written).toEqual(['ping', CLEAR_COMPOSER + 'ping', CLEAR_COMPOSER + 'ping']); // 3 attempts, and NO submit Enter
  });

  it('can opt into one no-echo submit after bounded retries', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    const { delay, release } = controllableDelay();
    const p = injectMail(pane, 'ping', {
      provider: 'claude',
      retryDelay: delay,
      maxEchoAttempts: 2,
      allowUnverifiedSubmit: true,
    });

    release();
    await tick();
    release();
    await p;

    expect(pane.written).toEqual(['ping', CLEAR_COMPOSER + 'ping', '\r']);
  });
});

describe('injectMail — continuous dialog-watcher', () => {
  it('does not answer ordinary echoed mail text that contains a dialog anchor phrase', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    const { delay } = controllableDelay();
    const text = 'Question: do you want to proceed with option A?';
    const p = injectMail(pane, text, { provider: 'claude', retryDelay: delay });

    pane.emit(text);
    await p;

    expect(pane.written).toEqual([text, '\r']);
  });

  it('answers an interleaving permission dialog without re-submitting the mail', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    const { delay } = controllableDelay();
    const p = injectMail(pane, 'do it', { provider: 'claude', retryDelay: delay });

    pane.emit(CLAUDE_PERMISSION); // a permission dialog interleaves while the composer is busy
    expect(pane.written).toEqual(['do it', '\r']); // payload, then the dialog's Enter — NOT a re-submit

    pane.emit('do it'); // then the composer echoes the typed text
    await p;

    expect(pane.written).toEqual(['do it', '\r', '\r']); // + the single mail submit
    expect(pane.written.filter((w) => w === 'do it')).toHaveLength(1); // mail text written exactly once
  });
});

describe('injectMail — fail-loud guards', () => {
  it('refuses to inject empty / whitespace-only text', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    await expect(injectMail(pane, '   ', { provider: 'claude' })).rejects.toThrow(/empty/i);
    expect(pane.written).toEqual([]);
  });
});
