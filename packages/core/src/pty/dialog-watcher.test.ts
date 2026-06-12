import { describe, it, expect } from 'vitest';
import { FakePty } from './fake-pty.js';
import type { SpawnSpec } from './pty-host.js';
import { classifyDialog, watchDialogs, type DialogName } from './dialog-watcher.js';
import { normalizeStartupOutput } from './startup-classifier.js';

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

// [synthesized] dialog fixtures (host-confirmed later). Box-chrome + cursor moves are present so the
// whitespace-normalized matching is exercised, not literal-position matching.
const CLAUDE_PERMISSION =
  CLEAR +
  'Claude wants to use co_probe.\nDo you want to proceed?\n' +
  ESC +
  '[1m❯ 1. Yes\n  2. No\n';
const CODEX_APPROVAL =
  CLEAR + 'Allow the co_probe MCP server to run tool "ping"?\n❯ 1. Yes\n  2. No\n';
const NON_DIALOG = CLEAR + ' ⠋ working… rendering output ' + ESC + '[0m\n';

describe('classifyDialog — pure prompt-text classification (whitespace-normalized)', () => {
  it('matches the Claude MCP-tool permission prompt → one Enter answers it', () => {
    expect(classifyDialog('claude', normalizeStartupOutput(CLAUDE_PERMISSION))).toEqual({
      name: 'claude_permission',
      answer: '\r',
    });
  });

  it('matches the Codex MCP approval dialog → selects Yes (1 + Enter)', () => {
    expect(classifyDialog('codex', normalizeStartupOutput(CODEX_APPROVAL))).toEqual({
      name: 'codex_approval',
      answer: '1\r',
    });
  });

  it('returns null for ordinary (non-dialog) render output', () => {
    expect(classifyDialog('claude', normalizeStartupOutput(NON_DIALOG))).toBeNull();
    expect(classifyDialog('codex', normalizeStartupOutput(NON_DIALOG))).toBeNull();
  });

  it('narrows by provider: the claude pane does not answer a codex dialog', () => {
    expect(classifyDialog('claude', normalizeStartupOutput(CODEX_APPROVAL))).toBeNull();
    // …but provider-agnostic classification (no provider given) still finds it.
    expect(classifyDialog(undefined, normalizeStartupOutput(CODEX_APPROVAL))).toEqual({
      name: 'codex_approval',
      answer: '1\r',
    });
  });
});

describe('watchDialogs — continuous answer over a live Pane', () => {
  it('answers a permission dialog that appears mid-stream and fires onAnswered', () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    const answered: DialogName[] = [];
    const unsub = watchDialogs(pane, { provider: 'claude', onAnswered: (n) => answered.push(n) });
    try {
      pane.emit('still working… ⠋⠙⠹\n'); // no dialog yet
      expect(pane.written).toEqual([]);
      pane.emit(CLAUDE_PERMISSION); // dialog interleaves
      expect(pane.written).toEqual(['\r']);
      expect(answered).toEqual(['claude_permission']);
    } finally {
      unsub();
    }
  });

  it('does not re-answer the same dialog from its persistent on-screen anchor', () => {
    const pane = new FakePty().spawn(CODEX_SPEC);
    const unsub = watchDialogs(pane, { provider: 'codex' });
    try {
      pane.emit(CODEX_APPROVAL); // answered once
      expect(pane.written).toEqual(['1\r']);
      // A subsequent unrelated repaint (the anchor is gone after the answer) does not re-answer.
      pane.emit(' ⠋ running the tool…\n');
      expect(pane.written).toEqual(['1\r']);
    } finally {
      unsub();
    }
  });

  it('answers two genuinely distinct dialogs across the turn', () => {
    const pane = new FakePty().spawn(CODEX_SPEC);
    const unsub = watchDialogs(pane, { provider: 'codex' });
    try {
      pane.emit(CODEX_APPROVAL);
      pane.emit(' ⠙ first tool ran…\n');
      pane.emit(CODEX_APPROVAL); // a second, fresh approval later in the turn
      expect(pane.written).toEqual(['1\r', '1\r']);
    } finally {
      unsub();
    }
  });
});
