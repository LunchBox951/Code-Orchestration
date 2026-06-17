import { describe, it, expect } from 'vitest';
import {
  classifyStartup,
  normalizeStartupOutput,
  type StartupInterstitialName,
} from './startup-classifier.js';
// The named provider startup signatures now live in the shared `startup-fixtures` module — one source
// of truth for both these classifier tests and the mcp host-proof / FakeProvider harness. ESC/BEL stay
// local below for the inline byte literals in the test bodies.
import {
  CLAUDE_TRUST,
  CLAUDE_READY,
  CLAUDE_READY_CURSOR_POSITIONED,
  CLAUDE_READY_STATUS_STRIP,
  CLAUDE_THEME,
  CLAUDE_LOGIN,
  CLAUDE_OAUTH_LOGIN,
  CODEX_UPDATE,
  CODEX_TRUST,
  CODEX_HOOKS_REVIEW,
  CODEX_READY,
  CODEX_READY_CURRENT,
  CODEX_MCP_STARTING,
  CODEX_SIGNIN,
} from './startup-fixtures.js';

const ESC = '\u001B';
const BEL = '\u0007';

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

  it('classifies the live cursor-positioned ready footer as ready', () => {
    expect(classifyStartup('claude', norm(CLAUDE_READY_CURSOR_POSITIONED))).toEqual({
      kind: 'ready',
    });
  });

  it('classifies the current live Claude status strip as ready', () => {
    expect(classifyStartup('claude', norm(CLAUDE_READY_STATUS_STRIP))).toEqual({
      kind: 'ready',
    });
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

  it('classifies the live OAuth code prompt as login_required before ready', () => {
    const phase = classifyStartup('claude', norm(CLAUDE_OAUTH_LOGIN + CLAUDE_READY_STATUS_STRIP));
    expect(phase.kind).toBe('login_required');
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

  it('classifies the hook trust prompt as interstitial hooks answered by trust-all + Enter', () => {
    expect(classifyStartup('codex', norm(CODEX_HOOKS_REVIEW))).toEqual({
      kind: 'interstitial',
      name: 'hooks',
      answer: '2\r',
    });
  });

  it('classifies the idle composer/status line as ready', () => {
    expect(classifyStartup('codex', norm(CODEX_READY))).toEqual({ kind: 'ready' });
  });

  it('classifies the current idle composer skills hint as ready', () => {
    expect(classifyStartup('codex', norm(CODEX_READY_CURRENT))).toEqual({ kind: 'ready' });
  });

  it('does not classify the MCP startup screen as ready even when the footer is present', () => {
    expect(classifyStartup('codex', norm(CODEX_MCP_STARTING))).toEqual({ kind: 'starting' });
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
