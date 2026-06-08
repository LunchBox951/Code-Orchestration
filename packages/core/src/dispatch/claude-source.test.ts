import { describe, it, expect } from 'vitest';
import {
  ClaudeUsageSource,
  CLAUDE_AUTH_STATUS_ARGS,
  CLAUDE_DEFAULT_ACCOUNT,
  CLAUDE_OAUTH_ACCESS_TOKEN_ENV,
  CLAUDE_OAUTH_BACKOFF_MS_ENV,
  CLAUDE_OAUTH_REFRESH_TOKEN_ENV,
  CLAUDE_OAUTH_TOKEN_ENV,
  CLAUDE_OAUTH_TOKEN_ENDPOINT,
  CLAUDE_USAGE_ENDPOINT,
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
const CLAUDE_CODE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_AI_OAUTH_SCOPE =
  'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

interface FetchCall {
  readonly url: string;
  readonly init?: RequestInit;
}

function jsonResponse(
  body: unknown,
  init: { readonly status?: number; readonly headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

function header(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

function jsonBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

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

  it('parses the real OAuth usage shape with root-level utilization windows', () => {
    const reading = parseClaudeStatusLine({
      five_hour: { utilization: 10, resets_at: '2026-06-05T01:10:01.293269+00:00' },
      seven_day: { utilization: 82, resets_at: '2026-06-08T14:00:01.293298+00:00' },
      seven_day_sonnet: { utilization: 14, resets_at: '2026-06-08T14:00:01.293307+00:00' },
      seven_day_opus: null,
      extra_usage: {
        is_enabled: true,
        monthly_limit: 28000,
        used_credits: 0,
        utilization: null,
        currency: 'CAD',
      },
    });
    expect(reading.windows).toEqual([
      { kind: 'five_hour', used_pct: 10, reset_at: '2026-06-05T01:10:01.293269+00:00' },
      { kind: 'weekly', used_pct: 82, reset_at: '2026-06-08T14:00:01.293298+00:00' },
      {
        kind: 'seven_day_sonnet',
        used_pct: 14,
        reset_at: '2026-06-08T14:00:01.293307+00:00',
      },
    ]);
  });

  it('normalizes fractional utilization to a percentage without changing percent-shaped values', () => {
    const reading = parseClaudeStatusLine({
      rate_limits: {
        five_hour: { utilization: 0.67, resets_at: '2026-06-03T05:00:00.000Z' },
        weekly: { utilization: 82, resets_at: '2026-06-10T00:00:00.000Z' },
      },
    });

    expect(reading.windows).toEqual([
      { kind: 'five_hour', used_pct: 67, reset_at: '2026-06-03T05:00:00.000Z' },
      { kind: 'weekly', used_pct: 82, reset_at: '2026-06-10T00:00:00.000Z' },
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
      accountObserved: false,
    });
  });

  it('prefers an explicit canonical account label over plan fallback', () => {
    expect(parseClaudeAuthStatus({ logged_in: true, account: 'claude:team', plan: 'Max' })).toEqual(
      {
        loggedIn: true,
        account: 'claude:team',
        accountObserved: true,
      },
    );
  });

  it('namespaces explicit raw account ids', () => {
    expect(parseClaudeAuthStatus({ logged_in: true, account: { id: 'team' } })).toEqual({
      loggedIn: true,
      account: 'claude:team',
      accountObserved: true,
    });
  });

  it('ignores generic root ids and labels when deriving account metadata', () => {
    expect(parseClaudeAuthStatus({ logged_in: true, id: 'evt_123', plan: 'Max' })).toEqual({
      loggedIn: true,
      account: 'claude:max',
      accountObserved: false,
    });
    expect(parseClaudeAuthStatus({ logged_in: true, label: 'auth-status' })).toEqual({
      loggedIn: true,
      account: CLAUDE_DEFAULT_ACCOUNT,
      accountObserved: false,
    });
  });

  it('prefers explicit root account_id over object-shaped account metadata', () => {
    expect(
      parseClaudeAuthStatus({
        logged_in: true,
        account: { plan: 'Max' },
        account_id: 'team',
      }),
    ).toEqual({
      loggedIn: true,
      account: 'claude:team',
      accountObserved: true,
    });
  });

  it('marks not-logged-in on an explicit flag or an error', () => {
    expect(parseClaudeAuthStatus({ logged_in: false }).loggedIn).toBe(false);
    expect(parseClaudeAuthStatus({ error: 'not authenticated' }).loggedIn).toBe(false);
  });

  it('defaults to logged-in + default account on an empty/odd payload (defensive, never down-on-noise)', () => {
    expect(parseClaudeAuthStatus({})).toEqual({
      loggedIn: true,
      account: CLAUDE_DEFAULT_ACCOUNT,
      accountObserved: false,
    });
    expect(parseClaudeAuthStatus('garbage')).toEqual({
      loggedIn: true,
      account: CLAUDE_DEFAULT_ACCOUNT,
      accountObserved: false,
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

  it('returns the observed account even when an explicit account option was provided', async () => {
    const source = new ClaudeUsageSource(
      depsWith({
        authStatus: () => Promise.resolve({ loggedIn: true, account: 'claude:max' }),
        statusLine: () =>
          Promise.resolve({
            account: 'claude:max',
            rate_limits: {
              five_hour: { used_percentage: 7, resets_at: '2026-06-03T05:00:00.000Z' },
            },
          }),
      }),
      { account: 'claude:team' },
    );

    const snap = await source.read('claude');

    expect(snap.account).toBe('claude:max');
    expect(snap.source).toBe('statusLine');
  });

  it('fails loud when a requested account is not observed by defensive preflight or statusLine', async () => {
    const source = new ClaudeUsageSource(
      depsWith({
        authStatus: () => Promise.resolve(parseClaudeAuthStatus({})),
        statusLine: () =>
          Promise.resolve({
            rate_limits: {
              five_hour: { used_percentage: 7, resets_at: '2026-06-03T05:00:00.000Z' },
            },
          }),
      }),
      { account: 'claude:team' },
    );

    await expect(source.read('claude')).rejects.toThrow(/not observed/i);
  });

  it('fails loud when requested account preflight has only generic root ids', async () => {
    const source = new ClaudeUsageSource(
      depsWith({
        authStatus: () =>
          Promise.resolve(parseClaudeAuthStatus({ logged_in: true, id: 'evt_123', plan: 'Max' })),
        statusLine: () =>
          Promise.resolve({
            rate_limits: {
              five_hour: { used_percentage: 7, resets_at: '2026-06-03T05:00:00.000Z' },
            },
          }),
      }),
      { account: 'claude:team' },
    );

    await expect(source.read('claude')).rejects.toThrow(/not observed/i);
  });

  it('fails loud when requested account preflight reports only a plan label', async () => {
    const source = new ClaudeUsageSource(
      depsWith({
        authStatus: () =>
          Promise.resolve(parseClaudeAuthStatus({ logged_in: true, account: { plan: 'Max' } })),
        statusLine: () =>
          Promise.resolve({
            rate_limits: {
              five_hour: { used_percentage: 7, resets_at: '2026-06-03T05:00:00.000Z' },
            },
          }),
      }),
      { account: 'claude:team' },
    );

    await expect(source.read('claude')).rejects.toThrow(/not observed/i);
  });

  it('ignores non-canonical statusLine organization strings as account labels', async () => {
    const source = new ClaudeUsageSource(
      depsWith({
        authStatus: () => Promise.resolve({ loggedIn: true, account: 'claude:max' }),
        statusLine: () =>
          Promise.resolve({
            organization: 'Acme',
            rate_limits: {
              five_hour: { used_percentage: 7, resets_at: '2026-06-03T05:00:00.000Z' },
            },
          }),
      }),
    );

    const snap = await source.read('claude');

    expect(snap.account).toBe('claude:max');
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

describe('Claude OAuth usage client — gated idle usage read (no inference)', () => {
  it('exchanges a refresh token, then reads oauth usage with the returned access token', async () => {
    const calls: FetchCall[] = [];
    const fetchOAuth: typeof fetch = (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input) === CLAUDE_OAUTH_TOKEN_ENDPOINT) {
        return Promise.resolve(jsonResponse({ access_token: 'access-from-refresh' }));
      }
      if (String(input) === CLAUDE_USAGE_ENDPOINT) {
        expect(header(init, 'authorization')).toBe('Bearer access-from-refresh');
        expect(header(init, 'anthropic-beta')).toBe('oauth-2025-04-20');
        return Promise.resolve(
          jsonResponse({
            data: {
              rate_limits: {
                five_hour: {
                  used_percentage: 17,
                  resets_at: '2026-06-03T05:00:00.000Z',
                },
              },
            },
          }),
        );
      }
      return Promise.resolve(jsonResponse({ error: 'unexpected URL' }, { status: 404 }));
    };

    const source = new ClaudeUsageSource(
      defaultClaudeDeps({
        cli: () => Promise.resolve(loggedInAuth),
        readStatusLine: () => Promise.resolve({}),
        fetchOAuth,
        env: { [CLAUDE_OAUTH_REFRESH_TOKEN_ENV]: 'refresh-token' },
        now,
      }),
      { enableIdleUsageRead: true },
    );

    const snap = await source.read('claude');

    expect(calls.map((c) => c.url)).toEqual([CLAUDE_OAUTH_TOKEN_ENDPOINT, CLAUDE_USAGE_ENDPOINT]);
    expect(calls[0]!.init?.method).toBe('POST');
    expect(header(calls[0]!.init, 'content-type')).toBe('application/json');
    expect(jsonBody(calls[0]!.init)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-token',
      client_id: CLAUDE_CODE_OAUTH_CLIENT_ID,
      scope: CLAUDE_AI_OAUTH_SCOPE,
    });
    expect(snap).toEqual({
      provider: 'claude',
      account: CLAUDE_DEFAULT_ACCOUNT,
      windows: [{ kind: 'five_hour', used_pct: 17, reset_at: '2026-06-03T05:00:00.000Z' }],
      available: true,
      source: 'oauth-usage',
      sampled_at: '2026-06-03T00:00:00.000Z',
    });
  });

  it('uses a direct access-token override without posting to the token endpoint', async () => {
    const calls: FetchCall[] = [];
    const fetchOAuth: typeof fetch = (input, init) => {
      calls.push({ url: String(input), init });
      expect(String(input)).toBe(CLAUDE_USAGE_ENDPOINT);
      expect(header(init, 'authorization')).toBe('Bearer direct-access');
      expect(header(init, 'anthropic-beta')).toBe('oauth-2025-04-20');
      return Promise.resolve(
        jsonResponse({
          rate_limits: {
            five_hour: { used_percentage: 7, resets_at: '2026-06-03T05:00:00.000Z' },
          },
        }),
      );
    };

    const source = new ClaudeUsageSource(
      defaultClaudeDeps({
        cli: () => Promise.resolve(loggedInAuth),
        readStatusLine: () => Promise.resolve({}),
        fetchOAuth,
        env: {
          [CLAUDE_OAUTH_ACCESS_TOKEN_ENV]: 'direct-access',
          [CLAUDE_OAUTH_REFRESH_TOKEN_ENV]: 'refresh-should-not-be-used',
        },
        now,
      }),
      { enableIdleUsageRead: true },
    );

    const snap = await source.read('claude');

    expect(calls.map((c) => c.url)).toEqual([CLAUDE_USAGE_ENDPOINT]);
    expect(snap.source).toBe('oauth-usage');
    expect(snap.windows).toEqual([
      { kind: 'five_hour', used_pct: 7, reset_at: '2026-06-03T05:00:00.000Z' },
    ]);
  });

  it('keeps the old direct-token env as an access-token alias', async () => {
    const calls: FetchCall[] = [];
    const fetchOAuth: typeof fetch = (input, init) => {
      calls.push({ url: String(input), init });
      expect(String(input)).toBe(CLAUDE_USAGE_ENDPOINT);
      expect(header(init, 'authorization')).toBe('Bearer legacy-direct-access');
      expect(header(init, 'anthropic-beta')).toBe('oauth-2025-04-20');
      return Promise.resolve(
        jsonResponse({
          rate_limits: {
            five_hour: { used_percentage: 8, resets_at: '2026-06-03T05:00:00.000Z' },
          },
        }),
      );
    };

    const source = new ClaudeUsageSource(
      defaultClaudeDeps({
        cli: () => Promise.resolve(loggedInAuth),
        readStatusLine: () => Promise.resolve({}),
        fetchOAuth,
        env: { [CLAUDE_OAUTH_TOKEN_ENV]: 'legacy-direct-access' },
        now,
      }),
      { enableIdleUsageRead: true },
    );

    const snap = await source.read('claude');

    expect(calls.map((c) => c.url)).toEqual([CLAUDE_USAGE_ENDPOINT]);
    expect(snap.windows).toEqual([
      { kind: 'five_hour', used_pct: 8, reset_at: '2026-06-03T05:00:00.000Z' },
    ]);
  });

  it('caches a rotated refresh token in memory for the next token refresh', async () => {
    let current = FIXED_NOW;
    let tokenPosts = 0;
    const tokenBodies: Record<string, unknown>[] = [];
    const usageAuths: string[] = [];
    const fetchOAuth: typeof fetch = (input, init) => {
      if (String(input) === CLAUDE_OAUTH_TOKEN_ENDPOINT) {
        tokenPosts += 1;
        tokenBodies.push(jsonBody(init));
        return Promise.resolve(
          jsonResponse({
            access_token: `access-${tokenPosts}`,
            refresh_token: tokenPosts === 1 ? 'rotated-refresh' : 'second-rotated-refresh',
            expires_in: 61,
          }),
        );
      }
      if (String(input) === CLAUDE_USAGE_ENDPOINT) {
        usageAuths.push(header(init, 'authorization') ?? '');
        return Promise.resolve(
          jsonResponse({
            rate_limits: {
              five_hour: {
                used_percentage: 9,
                resets_at: '2026-06-03T05:00:00.000Z',
              },
            },
          }),
        );
      }
      return Promise.resolve(jsonResponse({ error: 'unexpected URL' }, { status: 404 }));
    };
    const deps = defaultClaudeDeps({
      cli: () => Promise.resolve(loggedInAuth),
      readStatusLine: () => Promise.resolve({}),
      fetchOAuth,
      env: { [CLAUDE_OAUTH_REFRESH_TOKEN_ENV]: 'env-refresh' },
      now: () => current,
    });
    const source = new ClaudeUsageSource(deps, { enableIdleUsageRead: true });

    await source.read('claude');
    current = FIXED_NOW + 1001;
    await source.read('claude');

    expect(tokenBodies[0]).toMatchObject({ refresh_token: 'env-refresh' });
    expect(tokenBodies[1]).toMatchObject({ refresh_token: 'rotated-refresh' });
    expect(usageAuths).toEqual(['Bearer access-1', 'Bearer access-2']);
  });

  it('fails loud when refresh-token exchange fails', async () => {
    const source = new ClaudeUsageSource(
      defaultClaudeDeps({
        cli: () => Promise.resolve(loggedInAuth),
        readStatusLine: () => Promise.resolve({}),
        fetchOAuth: (input) => {
          expect(String(input)).toBe(CLAUDE_OAUTH_TOKEN_ENDPOINT);
          return Promise.resolve(jsonResponse({ error: 'invalid_grant' }, { status: 401 }));
        },
        env: { [CLAUDE_OAUTH_REFRESH_TOKEN_ENV]: 'expired-refresh' },
        now,
      }),
      { enableIdleUsageRead: true },
    );

    await expect(source.read('claude')).rejects.toMatchObject({
      code: 'usage_source_unavailable',
      provider: 'claude',
    });
    await expect(source.read('claude')).rejects.toThrow(/token endpoint returned 401/);
  });

  it('honors Retry-After on token-endpoint 429 and suppresses an immediate retry', async () => {
    const calls: FetchCall[] = [];
    const fetchOAuth: typeof fetch = (input, init) => {
      calls.push({ url: String(input), init });
      expect(String(input)).toBe(CLAUDE_OAUTH_TOKEN_ENDPOINT);
      return Promise.resolve(
        jsonResponse({ error: 'rate limited' }, { status: 429, headers: { 'retry-after': '120' } }),
      );
    };
    const deps = defaultClaudeDeps({
      cli: () => Promise.resolve(loggedInAuth),
      readStatusLine: () => Promise.resolve({}),
      fetchOAuth,
      env: { [CLAUDE_OAUTH_REFRESH_TOKEN_ENV]: 'refresh-token' },
      now,
    });
    const source = new ClaudeUsageSource(deps, { enableIdleUsageRead: true });

    await expect(source.read('claude')).rejects.toBeInstanceOf(UsageUnavailableError);
    await expect(source.read('claude')).rejects.toBeInstanceOf(UsageUnavailableError);

    expect(calls.length).toBe(1);
  });

  it('honors Retry-After on usage 429 and suppresses an immediate retry', async () => {
    const calls: FetchCall[] = [];
    const fetchOAuth: typeof fetch = (input, init) => {
      calls.push({ url: String(input), init });
      expect(String(input)).toBe(CLAUDE_USAGE_ENDPOINT);
      return Promise.resolve(
        jsonResponse({ error: 'rate limited' }, { status: 429, headers: { 'retry-after': '120' } }),
      );
    };
    const deps = defaultClaudeDeps({
      cli: () => Promise.resolve(loggedInAuth),
      readStatusLine: () => Promise.resolve({}),
      fetchOAuth,
      env: { [CLAUDE_OAUTH_ACCESS_TOKEN_ENV]: 'direct-access' },
      now,
    });
    const source = new ClaudeUsageSource(deps, { enableIdleUsageRead: true });

    await expect(source.read('claude')).rejects.toBeInstanceOf(UsageUnavailableError);
    await expect(source.read('claude')).rejects.toBeInstanceOf(UsageUnavailableError);

    expect(calls.length).toBe(1);
  });

  it('applies bounded exponential backoff when usage 429 has no Retry-After', async () => {
    let current = FIXED_NOW;
    const calls: FetchCall[] = [];
    const fetchOAuth: typeof fetch = (input, init) => {
      calls.push({ url: String(input), init });
      expect(String(input)).toBe(CLAUDE_USAGE_ENDPOINT);
      return Promise.resolve(jsonResponse({ error: 'rate limited' }, { status: 429 }));
    };
    const deps = defaultClaudeDeps({
      cli: () => Promise.resolve(loggedInAuth),
      readStatusLine: () => Promise.resolve({}),
      fetchOAuth,
      env: {
        [CLAUDE_OAUTH_ACCESS_TOKEN_ENV]: 'direct-access',
        [CLAUDE_OAUTH_BACKOFF_MS_ENV]: '1000',
      },
      now: () => current,
    });
    const source = new ClaudeUsageSource(deps, { enableIdleUsageRead: true });

    await expect(source.read('claude')).rejects.toBeInstanceOf(UsageUnavailableError);
    expect(calls.length).toBe(1);

    current = FIXED_NOW + 999;
    await expect(source.read('claude')).rejects.toBeInstanceOf(UsageUnavailableError);
    expect(calls.length).toBe(1);

    current = FIXED_NOW + 1001;
    await expect(source.read('claude')).rejects.toBeInstanceOf(UsageUnavailableError);
    expect(calls.length).toBe(2);

    current = FIXED_NOW + 1001 + 1999;
    await expect(source.read('claude')).rejects.toBeInstanceOf(UsageUnavailableError);
    expect(calls.length).toBe(2);
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
