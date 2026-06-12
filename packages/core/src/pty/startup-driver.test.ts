import { describe, it, expect } from 'vitest';
import { FakePty } from './fake-pty.js';
import type { SpawnSpec } from './pty-host.js';
import { driveToReady } from './startup-driver.js';

const ESC = '\u001B';
const CLEAR = ESC + '[2J' + ESC + '[H';

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

// Raw fixtures synthesized from the documented P0 byte signatures (see startup-classifier.test.ts).
const CLAUDE_TRUST = CLEAR + 'Quick safety check\r\n❯ 1. Yes, I trust this folder\r\n';
const CLAUDE_READY = CLEAR + '╭─ Welcome ─╮\r\n❯ \r\n  ? for shortcuts\r\n';
const CLAUDE_THEME = CLEAR + 'Choose the text style that looks best:\r\n❯ 1. Dark mode\r\n';
const CLAUDE_LOGIN =
  CLEAR +
  'Select login method:\r\n' +
  '❯ 1. Claude account with subscription\r\n' +
  '  2. Anthropic Console account\r\n' +
  '  3. 3rd-party platform\r\n';

const CODEX_UPDATE = CLEAR + 'Update available!\r\n❯ 1. Update now\r\n  2. Skip\r\n';
const CODEX_TRUST = CLEAR + 'Do you trust the files in this directory?\r\n❯ 1. Yes\r\n  2. No\r\n';
const CODEX_READY = CLEAR + '▌ Ask Codex…\r\n⏎ send   ⌃J newline   ⌃C quit\r\n';
const CODEX_SIGNIN =
  CLEAR +
  '❯ 1. Sign in with ChatGPT\r\n' +
  '  2. Sign in with Device Code\r\n' +
  '  3. Provide your own API key\r\n';

describe('driveToReady — authed (reaches ready)', () => {
  it('claude: answers trust with one Enter, then resolves authed', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    const p = driveToReady(pane, 'claude');
    pane.emit(CLAUDE_TRUST);
    pane.emit(CLAUDE_READY);
    await expect(p).resolves.toEqual({ authed: true });
    expect(pane.written).toEqual(['\r']);
  });

  it('claude: no-interstitial path (ready immediately) resolves authed with no writes', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    const p = driveToReady(pane, 'claude');
    pane.emit(CLAUDE_READY);
    await expect(p).resolves.toEqual({ authed: true });
    expect(pane.written).toEqual([]);
  });

  it('codex: answers the update menu (skip) + trust, then resolves authed', async () => {
    const pane = new FakePty().spawn(CODEX_SPEC);
    const p = driveToReady(pane, 'codex');
    pane.emit(CODEX_UPDATE);
    pane.emit(CODEX_TRUST);
    pane.emit(CODEX_READY);
    await expect(p).resolves.toEqual({ authed: true });
    expect(pane.written).toEqual(['2\r', '\r']);
  });

  it('codex: pre-seeded trust (trust prompt absent) resolves authed after only the update answer', async () => {
    const pane = new FakePty().spawn(CODEX_SPEC);
    const p = driveToReady(pane, 'codex');
    pane.emit(CODEX_UPDATE);
    pane.emit(CODEX_READY);
    await expect(p).resolves.toEqual({ authed: true });
    expect(pane.written).toEqual(['2\r']);
  });
});

describe('driveToReady — login_required (terminal, surfaced not driven)', () => {
  it('claude: advances past the theme picker, then surfaces login WITHOUT answering it', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    const p = driveToReady(pane, 'claude');
    pane.emit(CLAUDE_THEME);
    pane.emit(CLAUDE_LOGIN);
    await expect(p).resolves.toEqual({
      authed: false,
      loginRequired: {
        methods: [
          '1. Claude account with subscription',
          '2. Anthropic Console account',
          '3. 3rd-party platform',
        ],
      },
    });
    // Only the theme picker was answered (one Enter); NO login-method selection was ever written.
    expect(pane.written).toEqual(['\r']);
  });

  it('codex: surfaces the sign-in menu WITHOUT writing any answer', async () => {
    const pane = new FakePty().spawn(CODEX_SPEC);
    const p = driveToReady(pane, 'codex');
    pane.emit(CODEX_SIGNIN);
    await expect(p).resolves.toEqual({
      authed: false,
      loginRequired: {
        methods: [
          '1. Sign in with ChatGPT',
          '2. Sign in with Device Code',
          '3. Provide your own API key',
        ],
      },
    });
    expect(pane.written).toEqual([]);
  });
});

describe('driveToReady — fail-loud + liveness', () => {
  it('rejects when the pty exits before reaching ready (Principle 9)', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    const p = driveToReady(pane, 'claude');
    pane.emit('loading…\r\n');
    pane.exit(1, null);
    await expect(p).rejects.toThrow(/exited during claude startup before reaching ready/);
  });

  it('does not settle on partial / garbage output (stays pending until ready)', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    let settled = false;
    const p = driveToReady(pane, 'claude').then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    pane.emit('booting' + ESC + '[2J' + ' ⠋ ⠙ ⠹\r\n');
    await Promise.resolve();
    expect(settled).toBe(false);
    // Now paint ready so the test does not leak a pending promise.
    pane.emit(CLAUDE_READY);
    await p;
    expect(settled).toBe(true);
  });

  it('a pty exit AFTER ready does not override the resolved outcome', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    const p = driveToReady(pane, 'claude');
    pane.emit(CLAUDE_READY);
    await expect(p).resolves.toEqual({ authed: true });
    expect(() => pane.exit(0, null)).not.toThrow();
  });

  it('still detects ready after a large volume of pre-ready noise (buffer cap preserves the tail)', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    const p = driveToReady(pane, 'claude');
    // ~128 KB of spinner frames (well past the 64 KB cap), none containing a startup signature.
    for (let i = 0; i < 16; i++) {
      pane.emit(' ⠋ ⠙ ⠹ ⠸ loading the workspace… '.repeat(256));
    }
    pane.emit(CLAUDE_READY);
    await expect(p).resolves.toEqual({ authed: true });
    expect(pane.written).toEqual([]);
  });
});
