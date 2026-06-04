import { describe, it, expect } from 'vitest';
import {
  ClaudeUsageSource,
  CLAUDE_AUTH_STATUS_ARGS,
  CLAUDE_DEFAULT_ACCOUNT,
  defaultClaudeDeps,
  parseClaudeAuthStatus,
  parseClaudeStatusLine,
  type ClaudeCli,
  type ClaudeUsageSourceDeps,
} from './claude-source.js';
import { UsageUnavailableError, type UsageSnapshot } from './usage-source.js';

// A deterministic clock so `sampled_at` is fixed across runs.
const FIXED_NOW = Date.parse('2026-06-03T00:00:00.000Z');
const now = () => FIXED_NOW;

// A representative Claude Code statusLine payload (verified field names + tolerated noise).
const statusLinePayload = {
  rate_limits: {
    five_hour: { used_percentage: 42.5, resets_at: '2026-06-03T05:00:00.000Z' },
    weekly: { used_percentage: 30, resets_at: '2026-06-10T00:00:00.000Z' },
  },
  model: 'claude-opus-4-8',
  workspace: '/home/x',
};

const loggedInAuth = JSON.stringify({ logged_in: true, account: { plan: 'max' } });

function depsWith(over: Partial<ClaudeUsageSourceDeps>): ClaudeUsageSourceDeps {
  return {
    authStatus: () => Promise.resolve({ loggedIn: true, account: CLAUDE_DEFAULT_ACCOUNT }),
    statusLine: () => Promise.resolve(statusLinePayload),
    now,
    ...over,
  };
}

describe('parseClaudeStatusLine — passive statusLine parse (verified field names, defensive)', () => {
  it('parses five_hour + weekly windows from rate_limits', () => {
    const reading = parseClaudeStatusLine(statusLinePayload);
    expect(reading.windows).toEqual([
      { kind: 'five_hour', used_pct: 42.5, reset_at: '2026-06-03T05:00:00.000Z' },
      { kind: 'weekly', used_pct: 30, reset_at: '2026-06-10T00:00:00.000Z' },
    ]);
  });

  it('tolerates a missing weekly window (only five_hour present)', () => {
    const reading = parseClaudeStatusLine({
      rate_limits: { five_hour: { used_percentage: 10, resets_at: '2026-06-03T05:00:00.000Z' } },
    });
    expect(reading.windows).toEqual([
      { kind: 'five_hour', used_pct: 10, reset_at: '2026-06-03T05:00:00.000Z' },
    ]);
  });

  it('tolerates defensive field aliases (used_percent / reset_at)', () => {
    const reading = parseClaudeStatusLine({
      rate_limits: { five_hour: { used_percent: 12, reset_at: '2026-06-03T05:00:00.000Z' } },
    });
    expect(reading.windows).toEqual([
      { kind: 'five_hour', used_pct: 12, reset_at: '2026-06-03T05:00:00.000Z' },
    ]);
  });

  it('skips a window missing its usage% or reset, and yields nothing for an absent rate_limits', () => {
    expect(
      parseClaudeStatusLine({ rate_limits: { five_hour: { used_percentage: 5 } } }).windows,
    ).toEqual([]);
    expect(parseClaudeStatusLine({ unrelated: true }).windows).toEqual([]);
    expect(parseClaudeStatusLine(null).windows).toEqual([]);
  });
});

describe('parseClaudeAuthStatus — metadata preflight (account only, no inference)', () => {
  it('reads a plan into a per-account label and logged-in state', () => {
    expect(parseClaudeAuthStatus({ logged_in: true, account: { plan: 'Max' } })).toEqual({
      loggedIn: true,
      account: 'claude:max',
    });
  });

  it('marks not-logged-in on an explicit flag or an error', () => {
    expect(parseClaudeAuthStatus({ logged_in: false }).loggedIn).toBe(false);
    expect(parseClaudeAuthStatus({ error: 'not authenticated' }).loggedIn).toBe(false);
  });

  it('defaults to logged-in + default account on an empty/odd payload (defensive, never down-on-noise)', () => {
    expect(parseClaudeAuthStatus({})).toEqual({ loggedIn: true, account: CLAUDE_DEFAULT_ACCOUNT });
    expect(parseClaudeAuthStatus('garbage')).toEqual({
      loggedIn: true,
      account: CLAUDE_DEFAULT_ACCOUNT,
    });
  });
});

describe('ClaudeUsageSource.read — layered passive-first, fail-loud', () => {
  it('returns a statusLine snapshot (five_hour + weekly) when logged in', async () => {
    const source = new ClaudeUsageSource(depsWith({}));
    const snap = await source.read('claude');
    const expected: UsageSnapshot = {
      provider: 'claude',
      account: CLAUDE_DEFAULT_ACCOUNT,
      windows: [
        { kind: 'five_hour', used_pct: 42.5, reset_at: '2026-06-03T05:00:00.000Z' },
        { kind: 'weekly', used_pct: 30, reset_at: '2026-06-10T00:00:00.000Z' },
      ],
      available: true,
      source: 'statusLine',
      sampled_at: '2026-06-03T00:00:00.000Z',
    };
    expect(snap).toEqual(expected);
  });

  it('a not-logged-in preflight wins immediately as an unavailable snapshot (headroom unknown)', async () => {
    const source = new ClaudeUsageSource(
      depsWith({
        authStatus: () => Promise.resolve({ loggedIn: false, account: CLAUDE_DEFAULT_ACCOUNT }),
        statusLine: () => Promise.reject(new Error('statusLine should not be the winner')),
      }),
    );
    const snap = await source.read('claude');
    expect(snap.available).toBe(false);
    expect(snap.source).toBe('auth-status');
    expect(snap.windows).toEqual([]);
  });

  it('falls through a thrown preflight to the passive statusLine (preflight is best-effort)', async () => {
    const source = new ClaudeUsageSource(
      depsWith({ authStatus: () => Promise.reject(new Error('preflight offline')) }),
    );
    const snap = await source.read('claude');
    expect(snap.available).toBe(true);
    expect(snap.source).toBe('statusLine');
  });

  it('throws UsageUnavailableError when statusLine yields nothing and idle is disabled (fail-loud)', async () => {
    const source = new ClaudeUsageSource(depsWith({ statusLine: () => Promise.resolve({}) }));
    await expect(source.read('claude')).rejects.toBeInstanceOf(UsageUnavailableError);
  });

  it('throws UsageUnavailableError when statusLine throws and idle is disabled', async () => {
    const source = new ClaudeUsageSource(
      depsWith({ statusLine: () => Promise.reject(new Error('no capture')) }),
    );
    await expect(source.read('claude')).rejects.toBeInstanceOf(UsageUnavailableError);
  });

  it('uses the gated idle usage endpoint ONLY when enabled, and tags it oauth-usage', async () => {
    const idlePayload = {
      rate_limits: { five_hour: { used_percentage: 7, resets_at: '2026-06-03T05:00:00.000Z' } },
    };
    const deps = depsWith({
      statusLine: () => Promise.resolve({}),
      idleUsageRead: () => Promise.resolve(idlePayload),
    });
    // disabled (default): idle never consulted → fail-loud.
    await expect(new ClaudeUsageSource(deps).read('claude')).rejects.toBeInstanceOf(
      UsageUnavailableError,
    );
    // enabled: idle wins.
    const snap = await new ClaudeUsageSource(deps, { enableIdleUsageRead: true }).read('claude');
    expect(snap.source).toBe('oauth-usage');
    expect(snap.windows).toEqual([
      { kind: 'five_hour', used_pct: 7, reset_at: '2026-06-03T05:00:00.000Z' },
    ]);
  });
});

describe('AC11 (MANDATORY) — the Claude adapter NEVER reaches an inference path', () => {
  it('only ever spawns the metadata `auth status --json` subcommand — never -p / a completion', async () => {
    const cliCalls: string[][] = [];
    const cli: ClaudeCli = (args) => {
      cliCalls.push([...args]);
      return Promise.resolve(loggedInAuth);
    };
    let idleCalls = 0;
    const deps = defaultClaudeDeps({
      cli,
      readStatusLine: () => Promise.resolve(statusLinePayload),
      fetchUsageEndpoint: () => {
        idleCalls += 1;
        return Promise.resolve({});
      },
      now,
    });

    const snap = await new ClaudeUsageSource(deps).read('claude');
    expect(snap.available).toBe(true);

    // (a) the binary was spawned ONLY for metadata, never with an inference flag/subcommand.
    expect(cliCalls.length).toBeGreaterThan(0);
    for (const call of cliCalls) {
      expect(call).toEqual([...CLAUDE_AUTH_STATUS_ARGS]);
      expect(call).not.toContain('-p');
      expect(call).not.toContain('--print');
      expect(call.some((a) => /(^-p$)|print|exec|prompt|complete|--message|query/i.test(a))).toBe(
        false,
      );
    }

    // (b) the idle usage endpoint (gated OFF by default) was never even consulted.
    expect(idleCalls).toBe(0);

    // (c) STRUCTURAL: the dep seams expose NO inference-capable surface — only metadata/passive reads.
    for (const key of Object.keys(deps)) {
      expect(key).not.toMatch(/exec|query|complete|prompt|infer|spawn|stream|message/i);
    }
    expect(Object.keys(deps).sort()).toEqual(['authStatus', 'idleUsageRead', 'now', 'statusLine']);
  });

  it('never spawns an inference call even when the gated idle read IS enabled (still metadata-only)', async () => {
    const cliCalls: string[][] = [];
    const cli: ClaudeCli = (args) => {
      cliCalls.push([...args]);
      return Promise.resolve(loggedInAuth);
    };
    const deps = defaultClaudeDeps({
      cli,
      readStatusLine: () => Promise.resolve({}), // empty → forces the idle path
      fetchUsageEndpoint: () =>
        Promise.resolve({
          rate_limits: { five_hour: { used_percentage: 1, resets_at: '2026-06-03T05:00:00.000Z' } },
        }),
      now,
    });
    await new ClaudeUsageSource(deps, { enableIdleUsageRead: true }).read('claude');
    for (const call of cliCalls) expect(call).toEqual([...CLAUDE_AUTH_STATUS_ARGS]);
  });
});
