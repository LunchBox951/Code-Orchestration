/**
 * L4 Phase 6 — the GATED LOCAL LIVE E2E (spec §5 Phase 6; AC7). This is the one test that, when creds
 * are present AND the explicit opt-in {@link CO_LIVE_E2E_ENV}=1 is set, runs the REAL adapters against
 * the REAL host and asserts it retrieves REAL usage/limits for BOTH Claude (Max) and Codex (pro) —
 * NON-MOCKED. Otherwise (the sandbox case, and GitHub CI) it SKIPS LOUDLY: it never fails and never
 * mock-passes. The host-side run is escalated by the Lead to the coordinator; it is NOT executed here.
 *
 * It stays out of the default hermetic suite by construction: `describe.skipIf` gates the live block on
 * the opt-in, and the live `read()` calls (the only I/O) live INSIDE those blocks — so collecting this
 * file under default `pnpm test` does zero network / process / disk work. The always-on guard below
 * asserts the gate is OFF without the opt-in (the "verify it SKIPS" proof).
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import {
  accountForProvider,
  createProviderUsageSource,
  isLiveE2EEnabled,
  CO_LIVE_E2E_ENV,
} from './provider-source.js';
import {
  CLAUDE_OAUTH_ACCESS_TOKEN_ENV,
  CLAUDE_OAUTH_REFRESH_TOKEN_ENV,
  CLAUDE_OAUTH_TOKEN_ENV,
  CLAUDE_STATUSLINE_PATH_ENV,
} from './claude-source.js';
import { CODEX_LOGS_DB_ENV, defaultCodexLogsDbPath } from './codex-source.js';

function optInSkipReason(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return isLiveE2EEnabled(env) ? undefined : `set ${CO_LIVE_E2E_ENV}=1 to run local live E2E`;
}

function commandSkipReason(command: string): string | undefined {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return result.error !== undefined ? `command '${command}' is not available on PATH` : undefined;
}

function readablePathSkipReason(path: string | undefined, label: string): string | undefined {
  if (path === undefined || path.length === 0) return `${label} is not configured`;
  return existsSync(path) ? undefined : `${label} does not exist: ${path}`;
}

function claudeStatusLineSkipReason(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return (
    optInSkipReason(env) ??
    readablePathSkipReason(env[CLAUDE_STATUSLINE_PATH_ENV], CLAUDE_STATUSLINE_PATH_ENV) ??
    commandSkipReason('claude')
  );
}

function claudeOauthSkipReason(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return (
    optInSkipReason(env) ??
    (env[CLAUDE_OAUTH_REFRESH_TOKEN_ENV] ||
    env[CLAUDE_OAUTH_ACCESS_TOKEN_ENV] ||
    env[CLAUDE_OAUTH_TOKEN_ENV]
      ? undefined
      : `set ${CLAUDE_OAUTH_REFRESH_TOKEN_ENV}, ${CLAUDE_OAUTH_ACCESS_TOKEN_ENV}, or ${CLAUDE_OAUTH_TOKEN_ENV}`) ??
    commandSkipReason('claude')
  );
}

function codexSqliteSkipReason(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const dbPath = env[CODEX_LOGS_DB_ENV] ?? defaultCodexLogsDbPath();
  return (
    optInSkipReason(env) ??
    readablePathSkipReason(dbPath, CODEX_LOGS_DB_ENV) ??
    commandSkipReason('codex')
  );
}

const claudeStatusLineSkip = claudeStatusLineSkipReason();
const claudeOauthSkip = claudeOauthSkipReason();
const codexSqliteSkip = codexSqliteSkipReason();

const suffix = (reason: string | undefined): string =>
  reason === undefined ? '' : ` [skipped: ${reason}]`;

describe('gated live E2E — skip gate (hermetic, always runs)', () => {
  it(`is OFF without ${CO_LIVE_E2E_ENV} — the live suite below SKIPS (set ${CO_LIVE_E2E_ENV}=1 + creds to run)`, () => {
    // In the sandbox / CI the opt-in is absent, so the real-host suite is skipped, never failed/mocked.
    expect(isLiveE2EEnabled({})).toBe(false);
    expect(isLiveE2EEnabled({ [CO_LIVE_E2E_ENV]: '1' })).toBe(true);
  });

  it('names the missing live prerequisites instead of failing when opt-in is incomplete', () => {
    expect(claudeStatusLineSkipReason({})).toMatch(CO_LIVE_E2E_ENV);
    expect(claudeStatusLineSkipReason({ [CO_LIVE_E2E_ENV]: '1' })).toMatch(
      CLAUDE_STATUSLINE_PATH_ENV,
    );
    expect(claudeOauthSkipReason({ [CO_LIVE_E2E_ENV]: '1' })).toMatch(
      CLAUDE_OAUTH_REFRESH_TOKEN_ENV,
    );
    expect(
      codexSqliteSkipReason({
        [CO_LIVE_E2E_ENV]: '1',
        [CODEX_LOGS_DB_ENV]: '/definitely/missing/codex/logs_2.sqlite',
      }),
    ).toMatch(CODEX_LOGS_DB_ENV);
  });
});

describe(`LIVE E2E [local only; each test skips loudly unless ${CO_LIVE_E2E_ENV}=1 + concrete artifacts]: REAL usage, non-mocked`, () => {
  it.skipIf(claudeStatusLineSkip !== undefined)(
    `retrieves REAL Claude (Max) usage/limits via the default statusLine adapter${suffix(claudeStatusLineSkip)}`,
    async () => {
      const source = createProviderUsageSource('claude');
      const snap = await source.read('claude');
      expect(snap.provider).toBe('claude');
      expect(snap.account).toBe(accountForProvider('claude'));
      expect(snap.available).toBe(true);
      expect(snap.source).toBe('statusLine');
      expect(snap.windows.length).toBeGreaterThan(0);
      for (const window of snap.windows) {
        expect(typeof window.used_pct).toBe('number');
        expect(Number.isNaN(Date.parse(window.reset_at))).toBe(false);
      }
    },
    30_000,
  );

  it.skipIf(claudeOauthSkip !== undefined)(
    `retrieves REAL Claude (Max) usage/limits via the gated OAuth usage adapter${suffix(claudeOauthSkip)}`,
    async () => {
      const source = createProviderUsageSource('claude', {
        enableIdleUsageRead: true,
        readStatusLine: () => Promise.resolve({}),
      });
      const snap = await source.read('claude');
      expect(snap.provider).toBe('claude');
      expect(snap.account).toBe(accountForProvider('claude'));
      expect(snap.available).toBe(true);
      expect(snap.source).toBe('oauth-usage');
      expect(snap.windows.length).toBeGreaterThan(0);
      for (const window of snap.windows) {
        expect(typeof window.used_pct).toBe('number');
        expect(Number.isNaN(Date.parse(window.reset_at))).toBe(false);
      }
    },
    30_000,
  );

  it.skipIf(codexSqliteSkip !== undefined)(
    `retrieves REAL Codex (pro) usage/limits via the real sqlite adapter${suffix(codexSqliteSkip)}`,
    async () => {
      const source = createProviderUsageSource('codex'); // real seams — NO fixtures
      const snap = await source.read('codex');
      expect(snap.provider).toBe('codex');
      expect(snap.account).toBe(accountForProvider('codex'));
      expect(snap.available).toBe(true);
      expect(snap.windows.length).toBeGreaterThan(0);
      for (const window of snap.windows) {
        expect(typeof window.used_pct).toBe('number');
        expect(Number.isNaN(Date.parse(window.reset_at))).toBe(false);
      }
    },
    30_000,
  );
});
