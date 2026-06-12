import { describe, it, expect } from 'vitest';
import { FakePty } from './fake-pty.js';
import type { SpawnSpec } from './pty-host.js';
import { injectMail } from './mail-injector.js';

const ESC = '\u001B';
const PASTE_START = ESC + '[200~';
const PASTE_END = ESC + '[201~';

const CLAUDE_SPEC: SpawnSpec = {
  command: 'claude',
  args: [],
  cwd: '/work/agent',
  env: { CLAUDE_CONFIG_DIR: '/data/config/agent' },
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
});

describe('injectMail — echo-verify retry (never blind-fire Enter)', () => {
  it('retries the write when no echo renders, and submits only AFTER the echo is seen', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    const { delay, release } = controllableDelay();
    const p = injectMail(pane, 'ping', { provider: 'claude', retryDelay: delay });

    expect(pane.written).toEqual(['ping']); // attempt 0: text written, no echo yet
    release(); // the settle window elapses with no echo → retry
    await tick();
    expect(pane.written).toEqual(['ping', 'ping']); // attempt 1: re-written
    expect(pane.written).not.toContain('\r'); // still no submit — the echo was never seen

    pane.emit('ping'); // NOW the composer echoes
    await p;
    expect(pane.written).toEqual(['ping', 'ping', '\r']); // submit fires only after the echo
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

    expect(pane.written).toEqual(['ping', 'ping', 'ping']); // 3 attempts, and NO submit Enter
  });
});

describe('injectMail — continuous dialog-watcher', () => {
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
