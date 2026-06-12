import { describe, expect, it } from 'vitest';
import { NUDGE_CATALOG, injectNudge, nudgeFor } from './nudges.js';
import { FakePty } from '../pty/fake-pty.js';
import type { SpawnSpec } from '../pty/pty-host.js';

const CLAUDE_SPEC: SpawnSpec = {
  command: 'claude',
  args: [],
  cwd: '/work/agent',
  env: {},
};

/** A fully test-controlled settle/retry window (mirrors mail-injector.test.ts). */
function controllableDelay(): { delay: () => Promise<void>; release: () => void } {
  const resolvers: Array<() => void> = [];
  return {
    delay: () => new Promise<void>((resolve) => resolvers.push(resolve)),
    release: () => {
      while (resolvers.length) resolvers.shift()!();
    },
  };
}

describe('NUDGE_CATALOG', () => {
  it('is non-empty', () => {
    expect(NUDGE_CATALOG.length).toBeGreaterThan(0);
  });

  it('every entry has non-empty id, trigger, and nudge', () => {
    for (const entry of NUDGE_CATALOG) {
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.trigger.length).toBeGreaterThan(0);
      expect(entry.nudge.length).toBeGreaterThan(0);
    }
  });

  it('all ids are unique', () => {
    const ids = NUDGE_CATALOG.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('nudgeFor', () => {
  it('resolves a known id', () => {
    const rule = nudgeFor('finish-before-yield');
    expect(rule).toBeDefined();
    expect(rule?.id).toBe('finish-before-yield');
  });

  it('returns undefined for an unknown id', () => {
    expect(nudgeFor('no-such-nudge')).toBeUndefined();
  });
});

describe('injectNudge — L7 E1 real injector (AC-L6a-9 fail-loud preserved)', () => {
  it('writes the catalog nudge text into the pane (then exactly one submit)', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    const { delay } = controllableDelay();
    const rule = nudgeFor('finish-before-yield');
    expect(rule).toBeDefined();

    const p = injectNudge(pane, 'finish-before-yield', { provider: 'claude', retryDelay: delay });
    pane.emit(rule!.nudge); // the composer echoes the typed nudge → echo-verify passes
    await p;

    expect(pane.written).toContain(rule!.nudge); // the captured write contains the nudge message
    expect(pane.written).toEqual([rule!.nudge, '\r']); // nudge text, then a single Enter
  });

  it('throws loudly for an unknown trigger id — never a silent no-op', async () => {
    const pane = new FakePty().spawn(CLAUDE_SPEC);
    await expect(injectNudge(pane, 'no-such-nudge', { provider: 'claude' })).rejects.toThrow(
      /no nudge in NUDGE_CATALOG|fail loud/i,
    );
    expect(pane.written).toEqual([]); // nothing written for an unknown trigger
  });
});
