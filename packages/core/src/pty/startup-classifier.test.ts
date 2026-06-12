import { describe, it, expect } from 'vitest';
import {
  classifyStartup,
  normalizeStartupOutput,
  type StartupInterstitialName,
} from './startup-classifier.js';

const ESC = '\u001B';
const BEL = '\u0007';

/**
 * Fixtures synthesized from the documented P0 byte signatures (B1 spec). Each is RAW pty bytes —
 * ANSI cursor-moves / colours / OSC title sets around the documented prompt text — so the tests
 * exercise the real path: normalize (strip ANSI, collapse whitespace) → classify.
 */

// ── claude ───────────────────────────────────────────────────────────────────
// [documented] trust prompt: "Quick safety check" … "Yes, I trust this folder".
const CLAUDE_TRUST =
  ESC +
  '[2J' +
  ESC +
  '[H' +
  '╭───────────────────────────╮\r\n' +
  '│  Quick safety check       │\r\n' +
  '│                           │\r\n' +
  ESC +
  '[1;36m' +
  '❯ 1. Yes, I trust this folder' +
  ESC +
  '[0m' +
  '\r\n  2. No, ask me later\r\n';

// [documented] ready: welcome box + ❯ composer + "? for shortcuts" (stable status line).
const CLAUDE_READY =
  ESC +
  ']0;claude' +
  BEL +
  ESC +
  '[2J' +
  '╭─ Welcome to Claude Code ─╮\r\n' +
  '❯ ' +
  ESC +
  '[2mTry "fix the build"' +
  ESC +
  '[0m\r\n' +
  '  ? for shortcuts\r\n';

// [synthesized] first-run theme/onboarding picker: "Choose the text style…".
const CLAUDE_THEME =
  ESC +
  '[2J' +
  'Choose the text style that looks best with your terminal:\r\n' +
  '❯ 1. Dark mode\r\n  2. Light mode\r\n';

// [documented] login menu: header + the three numbered methods.
const CLAUDE_LOGIN =
  ESC +
  '[2J' +
  'Select login method:\r\n' +
  ESC +
  '[1m' +
  '❯ 1. Claude account with subscription' +
  ESC +
  '[0m\r\n' +
  '  2. Anthropic Console account\r\n' +
  '  3. 3rd-party platform\r\n';

// ── codex ────────────────────────────────────────────────────────────────────
// [documented] update-available menu.
const CODEX_UPDATE =
  ESC +
  '[2J' +
  'Update available!\r\n' +
  '❯ 1. Update now\r\n' +
  '  2. Skip\r\n' +
  '  3. Skip until next version\r\n';

// [synthesized] directory trust prompt.
const CODEX_TRUST =
  ESC +
  '[2J' +
  'Do you trust the files in this directory?\r\n' +
  '❯ 1. Yes, allow Codex to work here\r\n' +
  '  2. No\r\n';

// [synthesized] idle composer/status line ("send" + "newline" footer hints).
const CODEX_READY =
  ESC +
  ']0;codex' +
  BEL +
  '▌ ' +
  ESC +
  '[2mAsk Codex…' +
  ESC +
  '[0m\r\n' +
  '⏎ send   ⌃J newline   ⌃C quit\r\n';

// [documented] sign-in menu.
const CODEX_SIGNIN =
  ESC +
  '[2J' +
  '❯ 1. Sign in with ChatGPT\r\n' +
  '  2. Sign in with Device Code\r\n' +
  '  3. Provide your own API key\r\n';

const norm = normalizeStartupOutput;
const NONE: ReadonlySet<StartupInterstitialName> = new Set();

describe('normalizeStartupOutput', () => {
  it('strips ANSI escape sequences (CSI cursor-moves, SGR colours, OSC titles)', () => {
    const raw = ESC + '[2J' + ESC + '[1;36m' + 'hello' + ESC + '[0m' + ESC + ']0;title' + BEL;
    expect(norm(raw)).toBe('hello');
  });

  it('collapses runs of whitespace (spaces, tabs, CRLF) to single spaces and trims', () => {
    expect(norm('  a\r\n\tb   c  \r\n')).toBe('a b c');
  });

  it('leaves plain prompt text intact', () => {
    expect(norm('Select login method:')).toBe('Select login method:');
  });
});

describe('classifyStartup — claude', () => {
  it('classifies the trust prompt as interstitial trust answered by Enter', () => {
    expect(classifyStartup('claude', norm(CLAUDE_TRUST))).toEqual({
      kind: 'interstitial',
      name: 'trust',
      answer: '\r',
    });
  });

  it('classifies the ready composer (stable "? for shortcuts") as ready', () => {
    expect(classifyStartup('claude', norm(CLAUDE_READY))).toEqual({ kind: 'ready' });
  });

  it('classifies the theme picker as interstitial theme answered by Enter', () => {
    expect(classifyStartup('claude', norm(CLAUDE_THEME))).toEqual({
      kind: 'interstitial',
      name: 'theme',
      answer: '\r',
    });
  });

  it('classifies the login menu as login_required and captures the methods', () => {
    const phase = classifyStartup('claude', norm(CLAUDE_LOGIN));
    expect(phase.kind).toBe('login_required');
    if (phase.kind !== 'login_required') throw new Error('unreachable');
    expect(phase.methods).toEqual([
      '1. Claude account with subscription',
      '2. Anthropic Console account',
      '3. 3rd-party platform',
    ]);
  });
});

describe('classifyStartup — codex', () => {
  it('classifies the update menu as interstitial update answered by skip + Enter', () => {
    expect(classifyStartup('codex', norm(CODEX_UPDATE))).toEqual({
      kind: 'interstitial',
      name: 'update',
      answer: '2\r',
    });
  });

  it('classifies the directory trust prompt as interstitial trust answered by Enter', () => {
    expect(classifyStartup('codex', norm(CODEX_TRUST))).toEqual({
      kind: 'interstitial',
      name: 'trust',
      answer: '\r',
    });
  });

  it('classifies the idle composer/status line as ready', () => {
    expect(classifyStartup('codex', norm(CODEX_READY))).toEqual({ kind: 'ready' });
  });

  it('classifies the sign-in menu as login_required and captures the methods', () => {
    const phase = classifyStartup('codex', norm(CODEX_SIGNIN));
    expect(phase.kind).toBe('login_required');
    if (phase.kind !== 'login_required') throw new Error('unreachable');
    expect(phase.methods).toEqual([
      '1. Sign in with ChatGPT',
      '2. Sign in with Device Code',
      '3. Provide your own API key',
    ]);
  });
});

describe('classifyStartup — answered de-shadowing (same-flow progression)', () => {
  it('with both update+trust present, returns update first (none answered)', () => {
    const both = norm(CODEX_UPDATE + CODEX_TRUST);
    expect(classifyStartup('codex', both, NONE)).toMatchObject({ name: 'update' });
  });

  it('with update already answered, advances to the trust interstitial', () => {
    const both = norm(CODEX_UPDATE + CODEX_TRUST);
    const answered: ReadonlySet<StartupInterstitialName> = new Set(['update']);
    expect(classifyStartup('codex', both, answered)).toMatchObject({ name: 'trust' });
  });
});

describe('classifyStartup — precedence + degenerate (never false-ready)', () => {
  it('login_required wins over a coincidental ready anchor (fail-loud, not silent-authed)', () => {
    // codex sign-in screen whose footer also carries the ready hints ("send"/"newline").
    const buf = norm(CODEX_SIGNIN + '⏎ send  ⌃J newline');
    expect(classifyStartup('codex', buf).kind).toBe('login_required');
  });

  it('partial / garbage output stays starting (never a false ready)', () => {
    expect(classifyStartup('claude', norm('loading' + ESC + '[2J' + ' ⠋ ⠙ ⠹'))).toEqual({
      kind: 'starting',
    });
    expect(classifyStartup('codex', norm(''))).toEqual({ kind: 'starting' });
  });

  it('the rotating composer placeholder alone is NOT ready (only the stable status line is)', () => {
    // claude composer with placeholder but BEFORE the "? for shortcuts" status line paints.
    const placeholderOnly = norm('❯ ' + ESC + '[2mTry "refactor this file"' + ESC + '[0m');
    expect(classifyStartup('claude', placeholderOnly)).toEqual({ kind: 'starting' });
  });

  it('classifies correctly through heavy cursor-move / whitespace noise (normalization proof)', () => {
    const noisy =
      ESC +
      '[2J' +
      ESC +
      '[3;1H' +
      'Quick safety check' +
      ESC +
      '[6;1H' +
      '\r\n\t  ' +
      'Yes, I trust this folder' +
      ESC +
      '[0m';
    expect(classifyStartup('claude', norm(noisy))).toMatchObject({
      kind: 'interstitial',
      name: 'trust',
    });
  });
});
