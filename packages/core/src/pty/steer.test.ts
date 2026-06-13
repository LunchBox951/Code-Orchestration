/**
 * SF-2 [sandbox] acceptance for the mid-turn STEER protocol. Over `FakePty`, a deterministic test
 * proves the three steer kinds and the HARD never-tear-down invariant (Principle 1):
 *   - `answer`/`redirect` write the operator text + exactly one submit (echo-verified, via injectMail);
 *   - `interrupt` writes EXACTLY the provider's interrupt key (ESC for claude, Ctrl-C for codex);
 *   - in ALL cases the pane stays ALIVE — onExit never fires, the pane is never killed/closed/signalled.
 *
 * Control bytes are authored via their codepoints (String.fromCharCode) so the TEST source, like the
 * module source, holds NO raw control byte. Timing is the injected `retryDelay` seam (no wall clock):
 * the text steers settle on the composer echo; `interrupt` is a single synchronous write.
 */
import { describe, it, expect } from 'vitest';
import { FakePty, type FakePtyPane } from './fake-pty.js';
import type { SpawnSpec } from './pty-host.js';
import { steerPane } from './steer.js';

// Codepoint-authored control bytes — never raw in source. ESC=0x1B, Ctrl-C=0x03 (ETX), CR=0x0D (submit).
const ESC = String.fromCharCode(0x1b);
const CTRL_C = String.fromCharCode(0x03);
const SUBMIT = String.fromCharCode(0x0d);
const PASTE_START = ESC + '[200~';
const PASTE_END = ESC + '[201~';

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
  env: { CODEX_HOME: '/data/codex/agent' },
};

/** A never-auto-resolving settle seam: only the composer echo advances a text steer (no timer flakiness). */
function controllableDelay(): { delay: () => Promise<void> } {
  return { delay: () => new Promise<void>(() => {}) };
}

/** Track whether the pane was ever torn down (onExit fired) — the never-tear-down assertion (Principle 1). */
function trackLifecycle(pane: FakePtyPane): { exited: () => boolean } {
  let exited = false;
  pane.onExit(() => {
    exited = true;
  });
  return { exited: () => exited };
}

describe('steerPane — answer / redirect: write the operator text, exactly one submit', () => {
  it('answer: writes the text then exactly one submit once the composer echoes it; pane stays alive', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    const life = trackLifecycle(pane);
    const { delay } = controllableDelay();

    const p = steerPane(
      pane,
      { kind: 'answer', text: 'use claude' },
      { provider: 'claude', retryDelay: delay },
    );
    pane.emit('use claude'); // the composer echoes the typed answer → echo-verify passes
    await p;

    expect(pane.written).toEqual(['use claude', SUBMIT]);
    expect(life.exited()).toBe(false); // never torn down
    expect(pane.stopped).toBe(false); // never signalled (no SIGSTOP)
  });

  it('redirect: writes a new instruction then exactly one submit; pane stays alive', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    const life = trackLifecycle(pane);
    const { delay } = controllableDelay();

    const p = steerPane(
      pane,
      { kind: 'redirect', text: 'switch to plan B' },
      { provider: 'claude', retryDelay: delay },
    );
    pane.emit('switch to plan B');
    await p;

    expect(pane.written).toEqual(['switch to plan B', SUBMIT]);
    expect(life.exited()).toBe(false);
  });

  it('multi-line steer reuses injectMail bracketed paste (inner text byte-exact) + one submit', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    const life = trackLifecycle(pane);
    const { delay } = controllableDelay();
    const text = 'line one\nline two';

    const p = steerPane(
      pane,
      { kind: 'redirect', text },
      { provider: 'claude', retryDelay: delay },
    );
    pane.emit(text); // the composer renders the pasted content (markers are not echoed glyphs)
    await p;

    expect(pane.written).toEqual([PASTE_START + text + PASTE_END, SUBMIT]);
    expect(life.exited()).toBe(false);
  });

  it('a text steer with empty/whitespace-only text fails loud and never submits (pane stays alive)', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    const life = trackLifecycle(pane);

    await expect(
      steerPane(pane, { kind: 'answer', text: '   ' }, { provider: 'claude' }),
    ).rejects.toThrow(/empty/i);

    expect(pane.written).toEqual([]); // nothing written, no submit
    expect(life.exited()).toBe(false);
  });
});

describe('steerPane — interrupt: send EXACTLY the provider interrupt key, never tear down', () => {
  it('claude: sends exactly ESC and nothing else; the pane stays ALIVE (Principle 1)', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    const life = trackLifecycle(pane);

    await steerPane(pane, { kind: 'interrupt' }, { provider: 'claude' });

    expect(pane.written).toEqual([ESC]); // exactly the interrupt sequence, nothing more
    expect(life.exited()).toBe(false); // interrupt halts the action — it does NOT kill/close the pane
    expect(pane.stopped).toBe(false); // and it does NOT signal-stop it either
  });

  it('codex: sends exactly Ctrl-C (provider-aware gate); the pane stays ALIVE', async () => {
    const pane = new FakePty().spawn(CODEX_SPEC);
    const life = trackLifecycle(pane);

    await steerPane(pane, { kind: 'interrupt' }, { provider: 'codex' });

    expect(pane.written).toEqual([CTRL_C]);
    expect(life.exited()).toBe(false);
    expect(pane.stopped).toBe(false);
  });

  it('falls back to ESC when no provider is supplied; the pane stays ALIVE', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    const life = trackLifecycle(pane);

    await steerPane(pane, { kind: 'interrupt' });

    expect(pane.written).toEqual([ESC]);
    expect(life.exited()).toBe(false);
  });
});
