/**
 * L4 Phase 6 — the LIVE Claude (Max) {@link ProviderUsageSource} adapter (spec §2.6, §4.3; AC7, AC11).
 * Passive-first, NO INFERENCE. Sources, in order, each behind an INJECTED read-only seam (default = the
 * real impl; tests inject fixtures so `pnpm test` stays hermetic/offline):
 *
 *   1. **Preflight (account only):** `claude auth status --json` → logged-in state + account identity.
 *      Metadata ONLY — no turn, no inference. A not-logged-in preflight wins immediately as an
 *      `available: false` snapshot (so headroom reads `unknown`, AC6).
 *   2. **PRIMARY / PASSIVE:** the Claude Code **`statusLine`** payload — parse
 *      `rate_limits.five_hour.used_percentage` + `resets_at` (and the weekly window if present) into
 *      {@link UsageWindow}s. Zero inference, zero extra usage; the default live source.
 *   3. **IDLE/COLD no-inference read (OPERATOR-GATED, default OFF):** the account usage endpoint
 *      (`https://api.anthropic.com/api/oauth/usage`, metadata — no turn). The SEAM is built but the gate
 *      ({@link ClaudeUsageSourceOptions.enableIdleUsageRead}) defaults OFF — statusLine only unless an
 *      operator enables it (the live decision is escalated, not taken here).
 *
 * **AC11 (HARD RULE — Principle 2 authentic-terminal + billing):** this adapter NEVER runs inference or
 * spends API-billed tokens. There is NO `claude -p`, no streaming completion, no token-spending SDK
 * query anywhere in it — its only process call is the metadata `auth status` subcommand, and its only
 * network calls are the (gated) metadata OAuth token and usage endpoints. Harvesting the live
 * hosted-session `rate_limit_event` stream is the L7 streaming source, NOT here.
 * `claude-source.test.ts` proves the adapter never reaches an inference path (mandatory).
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { Provider, ProviderUsageSource, UsageSnapshot, UsageWindow } from './usage-source.js';
import { UsageUnavailableError } from './usage-source.js';
import { CO_CLAUDE_STATUSLINE_PATH_ENV } from './statusline-env.js';
import { CLAUDE_DEFAULT_ACCOUNT } from './provider-account.js';
import {
  asRecord,
  boolish,
  buildSnapshot,
  layeredRead,
  numberish,
  pick,
  sampledNowIso,
  stringish,
  type UsageSourceAttempt,
} from './usage-adapter-common.js';

export { CLAUDE_DEFAULT_ACCOUNT } from './provider-account.js';

/** The metadata-only preflight argv — `claude auth status --json`. NEVER an inference invocation (AC11). */
export const CLAUDE_AUTH_STATUS_ARGS: readonly string[] = ['auth', 'status', '--json'];

/** The account usage endpoint for the gated idle/cold read (metadata, no turn — AC11). */
export const CLAUDE_USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

/** The OAuth refresh-token endpoint for retrieving a metadata-read access token. */
export const CLAUDE_OAUTH_TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';

/** Claude Code's public OAuth client ID for Claude subscription auth. */
export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** The Claude AI OAuth scopes used by Claude Code for subscription-backed metadata reads. */
const CLAUDE_AI_OAUTH_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
] as const;

/**
 * Env var naming the file where the host captures the latest Claude Code statusLine payload. Aliased to
 * the shared {@link CO_CLAUDE_STATUSLINE_PATH_ENV} leaf constant (the single source of truth shared with
 * the launch config) so the two can never drift.
 */
export const CLAUDE_STATUSLINE_PATH_ENV = CO_CLAUDE_STATUSLINE_PATH_ENV;

/** Env var carrying a Claude OAuth refresh token for the gated idle usage read (host provides; never repo). */
export const CLAUDE_OAUTH_REFRESH_TOKEN_ENV = 'CO_CLAUDE_OAUTH_REFRESH_TOKEN';

/** Env var carrying a direct OAuth access token override for local debugging (host provides; never repo). */
export const CLAUDE_OAUTH_ACCESS_TOKEN_ENV = 'CO_CLAUDE_OAUTH_ACCESS_TOKEN';

/** Deprecated env var for a direct OAuth access token; kept as a compatibility alias. */
export const CLAUDE_OAUTH_TOKEN_ENV = 'CO_CLAUDE_OAUTH_TOKEN';

/** Env var overriding the bounded exponential usage-429 backoff base, in milliseconds. */
export const CLAUDE_OAUTH_BACKOFF_MS_ENV = 'CO_CLAUDE_OAUTH_BACKOFF_MS';

const CLAUDE_OAUTH_BACKOFF_MS_DEFAULT = 30_000;
const CLAUDE_OAUTH_BACKOFF_MS_MAX = 15 * 60_000;
const CLAUDE_OAUTH_TOKEN_CACHE_MS_DEFAULT = 5 * 60_000;
const CLAUDE_OAUTH_TOKEN_EXPIRY_SKEW_MS = 60_000;

/** What the metadata preflight resolves: whether the account is logged in, and its label. */
export interface ClaudeAccountInfo {
  readonly loggedIn: boolean;
  readonly account: string;
  /** True when metadata named an explicit account identity; false for plan/default fallback. */
  readonly accountObserved?: boolean;
}

/** What a status-line parse yields: the windows it found + an optional account label the payload named. */
export interface ClaudeStatusLineReading {
  readonly account?: string;
  readonly windows: readonly UsageWindow[];
}

/**
 * The injected, read-only seams of {@link ClaudeUsageSource}. All are passive / metadata (AC11): there is
 * deliberately NO inference seam. The default impls ({@link defaultClaudeDeps}) are the real ones; tests
 * inject fixtures.
 */
export interface ClaudeUsageSourceDeps {
  /** Preflight, metadata ONLY — logged-in state + account. Default: `claude auth status --json`. */
  readonly authStatus: () => Promise<ClaudeAccountInfo>;
  /** PRIMARY passive read — the Claude Code statusLine payload (`rate_limits`). Default: host-captured file. */
  readonly statusLine: () => Promise<unknown>;
  /** OPERATOR-GATED idle/cold metadata read — the usage endpoint. Present but only called when enabled. */
  readonly idleUsageRead?: () => Promise<unknown>;
  /** Injected clock (epoch ms) for `sampled_at`; defaults to the wall clock. Live I/O, not replay. */
  readonly now?: () => number;
}

/** Static config for {@link ClaudeUsageSource} (the operator gate + the account label). */
export interface ClaudeUsageSourceOptions {
  /** Account label fallback when metadata/passive payloads do not name the observed account. */
  readonly account?: string;
  /** Operator gate for the idle/cold usage-endpoint read; default OFF — statusLine only (AC11 default). */
  readonly enableIdleUsageRead?: boolean;
}

/**
 * Parse a `claude auth status --json` payload into {@link ClaudeAccountInfo} — DEFENSIVE: it treats the
 * account as logged in unless the payload clearly says otherwise (an explicit `logged_in: false` /
 * `authenticated: false` / an `error`), so a benign shape change does not spuriously mark the account
 * down. The account label is derived from a `plan` when present (e.g. `claude:max`), else
 * {@link CLAUDE_DEFAULT_ACCOUNT}.
 */
export function parseClaudeAuthStatus(payload: unknown): ClaudeAccountInfo {
  const root = asRecord(payload) ?? {};
  const accountRecord = asRecord(pick(root, 'account', 'user'));
  const explicit = firstScopedClaudeAccountLabel(root);
  const planRecord = accountRecord ?? root;
  const plan = stringish(pick(planRecord, 'plan', 'subscription', 'tier'));
  const label = explicit ?? (plan ? `claude:${plan.toLowerCase()}` : CLAUDE_DEFAULT_ACCOUNT);

  const loggedInFlag =
    boolish(pick(root, 'logged_in', 'loggedIn', 'authenticated', 'isAuthenticated')) ??
    (pick(root, 'error') !== undefined ? false : undefined);
  return {
    loggedIn: loggedInFlag ?? true,
    account: label,
    accountObserved: explicit !== undefined,
  };
}

/**
 * Parse a Claude Code statusLine payload into {@link UsageWindow}s — DEFENSIVE (spec §Fixtures). It reads
 * every window object under `rate_limits` (verified field names `used_percentage` + `resets_at`, with
 * defensive aliases), so the canonical `five_hour` + `weekly` windows parse AND any extra window the host
 * exposes is tolerated rather than dropped. A window missing a usage% or a reset is skipped; a payload
 * with no parseable `rate_limits` yields zero windows (the caller falls through to the next source).
 */
export function parseClaudeStatusLine(payload: unknown): ClaudeStatusLineReading {
  const root = asRecord(payload);
  if (!root) return { windows: [] };
  const body = findClaudeRateLimitsBody(root) ?? root;
  const rateLimits = asRecord(pick(body, 'rate_limits', 'rateLimits')) ?? body;
  if (!hasClaudeUsageWindowEntries(rateLimits)) return { windows: [] };

  const windows: UsageWindow[] = [];
  for (const [key, raw] of Object.entries(rateLimits)) {
    const window = asRecord(raw);
    if (!window) continue;
    const used = claudeUsedPct(window);
    const reset = stringish(pick(window, 'resets_at', 'reset_at', 'resetsAt'));
    if (used === undefined || reset === undefined) continue;
    windows.push({ kind: canonicalWindowKind(key), used_pct: used, reset_at: reset });
  }

  const account = canonicalClaudeAccount(
    stringish(pick(root, 'account')) ??
      stringish(pick(body, 'account')) ??
      stringish(pick(root, 'organization', 'org')) ??
      stringish(pick(body, 'organization', 'org')),
  );
  return account !== undefined ? { account, windows } : { windows };
}

function canonicalClaudeAccount(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith('claude:') && trimmed.length > 'claude:'.length ? trimmed : undefined;
}

function providerAccountLabel(value: string | undefined, provider: 'claude'): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith(`${provider}:`) && trimmed.length > provider.length + 1) return trimmed;
  return /^[a-z0-9._-]+$/u.test(trimmed) ? `${provider}:${trimmed}` : undefined;
}

function firstScopedClaudeAccountLabel(root: Record<string, unknown>): string | undefined {
  const directId = providerAccountLabel(stringish(pick(root, 'account_id', 'accountId')), 'claude');
  if (directId !== undefined) return directId;

  const direct = providerAccountLabel(stringish(pick(root, 'account')), 'claude');
  if (direct !== undefined) return direct;

  for (const key of ['account', 'user'] as const) {
    const scoped = asRecord(pick(root, key));
    if (!scoped) continue;
    const label = providerAccountLabel(
      stringish(pick(scoped, 'account', 'account_id', 'accountId', 'id', 'label')),
      'claude',
    );
    if (label !== undefined) return label;
  }
  return undefined;
}

/** Find a shallow rate-limits envelope, e.g. `{ data: { rate_limits: ... } }`, without over-fitting. */
function findClaudeRateLimitsBody(
  value: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> | undefined {
  if (asRecord(pick(value, 'rate_limits', 'rateLimits'))) return value;
  if (hasClaudeUsageWindowEntries(value)) return value;
  if (depth >= 2) return undefined;
  for (const child of Object.values(value)) {
    const record = asRecord(child);
    if (!record) continue;
    const found = findClaudeRateLimitsBody(record, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function hasClaudeUsageWindowEntries(value: Record<string, unknown>): boolean {
  return Object.values(value).some((raw) => {
    const window = asRecord(raw);
    if (!window) return false;
    const used = claudeUsedPct(window);
    const reset = stringish(pick(window, 'resets_at', 'reset_at', 'resetsAt'));
    return used !== undefined && reset !== undefined;
  });
}

/** Claude statusLine uses percent fields; OAuth `utilization` may be a 0..1 fraction or 0..100 percent. */
function claudeUsedPct(window: Record<string, unknown>): number | undefined {
  const percent = numberish(pick(window, 'used_percentage', 'used_percent', 'used_pct'));
  if (percent !== undefined) return percent;
  const utilization = numberish(pick(window, 'utilization'));
  if (utilization === undefined) return undefined;
  return utilization >= 0 && utilization <= 1 ? utilization * 100 : utilization;
}

/** Canonicalize a statusLine window key to the frozen labels where known; otherwise keep it verbatim. */
function canonicalWindowKind(key: string): string {
  const lower = key.toLowerCase();
  if (lower === 'five_hour' || lower === 'fivehour' || lower === '5h') return 'five_hour';
  if (lower === 'weekly' || lower === 'seven_day' || lower === '7d' || lower === 'week')
    return 'weekly';
  return key;
}

// ── Per-turn COST from the isolated transcript JSONL (collection seam, spec §4.2) ───────────────────
/**
 * The per-turn token cost read off a Claude Code transcript. `input`/`output`/`cacheRead`/`cacheCreation`
 * are the assistant-message `usage` token counts; `costUsd` is the stream-json `result`'s
 * `total_cost_usd` when present (a transcript that carries one). Any field may be undefined when the
 * transcript did not report it — the caller maps present fields onto a {@link import('./events.js').CostRecorded}.
 */
export interface ClaudeTurnCost {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly costUsd?: number;
}

/**
 * Parse per-turn cost out of a Claude Code transcript JSONL slice — DEFENSIVE, fail-soft. Each line is a
 * JSON record; an `assistant` message carries `message.usage` with `input_tokens` / `output_tokens` /
 * `cache_read_input_tokens` / `cache_creation_input_tokens`. The caller supplies the not-yet-recorded
 * slice for one co turn, so every assistant usage in that slice is summed. A `result.total_cost_usd`
 * only pairs with usage that precedes it; a later assistant usage resets that pairing so an older result
 * is not attached to newer assistant-only usage. Returns `undefined` when no usage/cost is found.
 *
 * NEVER an inference call (AC11): a pure parse of an already-written transcript file.
 */
export function parseClaudeTranscriptTurnCost(jsonl: string): ClaudeTurnCost | undefined {
  const lines = jsonl.split(/\r?\n/);
  const totals: MutableClaudeTurnCost = {};
  let costUsd: number | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a non-JSON line (e.g. truncated tail) is skipped, not fatal.
    }
    const record = asRecord(parsed);
    if (!record) continue;
    const found = findAssistantUsage(record);
    if (found) {
      addUsageTokens(totals, readUsageTokens(found));
      costUsd = undefined;
      continue;
    }
    const cost = numberish(pick(record, 'total_cost_usd', 'totalCostUsd', 'cost_usd'));
    if (cost !== undefined) {
      costUsd = cost;
    }
  }

  const result: ClaudeTurnCost = {
    ...totals,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
  // Guard against an all-undefined result (a record that had neither usable usage nor a cost).
  return Object.keys(result).length > 0 ? result : undefined;
}

type MutableClaudeTurnCost = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
};

function addUsageTokens(total: MutableClaudeTurnCost, next: ClaudeTurnCost): void {
  addTokenField(total, 'inputTokens', next.inputTokens);
  addTokenField(total, 'outputTokens', next.outputTokens);
  addTokenField(total, 'cacheReadInputTokens', next.cacheReadInputTokens);
  addTokenField(total, 'cacheCreationInputTokens', next.cacheCreationInputTokens);
}

function addTokenField(
  total: MutableClaudeTurnCost,
  key: keyof MutableClaudeTurnCost,
  value: number | undefined,
): void {
  if (value === undefined) return;
  total[key] = (total[key] ?? 0) + value;
}

/** Find an assistant-message `usage` object inside a transcript record (DEFENSIVE over shape variants). */
function findAssistantUsage(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const type = stringish(pick(record, 'type', 'role'));
  if (type !== undefined && type !== 'assistant' && type !== 'message') {
    // A `result` / `user` / `system` line carries no assistant usage; only assistant/message lines do.
    if (type === 'result' || type === 'user' || type === 'system') return undefined;
  }
  const direct = asRecord(pick(record, 'usage'));
  if (direct && hasUsageTokens(direct)) return direct;
  const message = asRecord(pick(record, 'message'));
  if (message) {
    const nested = asRecord(pick(message, 'usage'));
    if (nested && hasUsageTokens(nested)) return nested;
  }
  return undefined;
}

function hasUsageTokens(usage: Record<string, unknown>): boolean {
  return (
    numberish(pick(usage, 'input_tokens', 'inputTokens')) !== undefined ||
    numberish(pick(usage, 'output_tokens', 'outputTokens')) !== undefined ||
    numberish(pick(usage, 'cache_read_input_tokens', 'cacheReadInputTokens')) !== undefined ||
    numberish(pick(usage, 'cache_creation_input_tokens', 'cacheCreationInputTokens')) !== undefined
  );
}

function readUsageTokens(usage: Record<string, unknown>): ClaudeTurnCost {
  const input = numberish(pick(usage, 'input_tokens', 'inputTokens'));
  const output = numberish(pick(usage, 'output_tokens', 'outputTokens'));
  const cacheRead = numberish(pick(usage, 'cache_read_input_tokens', 'cacheReadInputTokens'));
  const cacheCreation = numberish(
    pick(usage, 'cache_creation_input_tokens', 'cacheCreationInputTokens'),
  );
  return {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(cacheRead !== undefined ? { cacheReadInputTokens: cacheRead } : {}),
    ...(cacheCreation !== undefined ? { cacheCreationInputTokens: cacheCreation } : {}),
  };
}

/**
 * The live Claude (Max) usage adapter — a layered, passive-first, fail-loud {@link ProviderUsageSource}
 * over the injected metadata/passive seams. NO INFERENCE (AC11). Returns the EXACT frozen
 * {@link UsageSnapshot}; throws {@link UsageUnavailableError} when no source yields one (AC6).
 */
export class ClaudeUsageSource implements ProviderUsageSource {
  private readonly deps: ClaudeUsageSourceDeps;
  private readonly account: string;
  private readonly enableIdle: boolean;

  constructor(deps: ClaudeUsageSourceDeps, options: ClaudeUsageSourceOptions = {}) {
    this.deps = deps;
    this.account = options.account ?? CLAUDE_DEFAULT_ACCOUNT;
    this.enableIdle = options.enableIdleUsageRead ?? false;
  }

  async read(provider: Provider): Promise<UsageSnapshot> {
    if (provider !== 'claude') {
      throw new UsageUnavailableError(
        provider,
        `ClaudeUsageSource cannot read provider '${provider}'`,
      );
    }
    const sampledAt = sampledNowIso(this.deps.now);

    // 1. Preflight (metadata only). Best-effort: a thrown preflight does not abort — statusLine may still
    //    work; a not-logged-in preflight wins immediately as an unavailable snapshot.
    let account = this.account;
    let accountObserved = this.account === CLAUDE_DEFAULT_ACCOUNT;
    let preflight: UsageSnapshot | null = null;
    try {
      const info = await this.deps.authStatus();
      if (info.accountObserved !== false || this.account === CLAUDE_DEFAULT_ACCOUNT) {
        account = info.account || account;
      }
      if (info.accountObserved !== false) accountObserved = true;
      if (!info.loggedIn) {
        preflight = buildSnapshot({
          provider: 'claude',
          account,
          windows: [],
          available: false,
          source: 'auth-status',
          sampledAt,
        });
      }
    } catch {
      // metadata preflight failed — fall through to the passive statusLine read.
    }

    const attempts: UsageSourceAttempt[] = [];
    if (preflight) {
      attempts.push({ label: 'auth-status preflight', run: () => Promise.resolve(preflight) });
    }
    attempts.push({
      label: 'statusLine (passive)',
      run: () =>
        this.readFromPayload(
          this.deps.statusLine(),
          account,
          accountObserved,
          sampledAt,
          'statusLine',
        ),
    });
    if (this.enableIdle && this.deps.idleUsageRead) {
      const idle = this.deps.idleUsageRead;
      attempts.push({
        label: 'idle usage endpoint (gated)',
        run: () => this.readFromPayload(idle(), account, accountObserved, sampledAt, 'oauth-usage'),
      });
    }
    return layeredRead('claude', account, attempts);
  }

  /** Parse a rate-limits-bearing payload (statusLine or usage endpoint) into a snapshot, or null if empty. */
  private async readFromPayload(
    payloadPromise: Promise<unknown>,
    account: string,
    accountObserved: boolean,
    sampledAt: string,
    source: string,
  ): Promise<UsageSnapshot | null> {
    const reading = parseClaudeStatusLine(await payloadPromise);
    if (reading.windows.length === 0) return null;
    const resolvedAccount = reading.account ?? account;
    const observed = accountObserved || reading.account !== undefined;
    if (this.account !== CLAUDE_DEFAULT_ACCOUNT && !observed) {
      throw new UsageUnavailableError(
        'claude',
        `requested Claude account '${this.account}' was not observed by ${source}`,
        { account: this.account },
      );
    }
    return buildSnapshot({
      provider: 'claude',
      account: resolvedAccount,
      windows: reading.windows,
      available: true,
      source,
      sampledAt,
    });
  }
}

// ── Default (real) seams — used in production; NEVER exercised by the hermetic test suite ───────────
/** A spawn of the real `claude` binary for a METADATA subcommand only (AC11 — never an inference call). */
export type ClaudeCli = (args: readonly string[]) => Promise<string>;

/** Fetch-compatible HTTP seam for the real Claude OAuth metadata endpoints. */
export type ClaudeOAuthFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Options for {@link defaultClaudeDeps}: override any seam (tests do) or accept the real defaults. */
export interface DefaultClaudeDepsOptions {
  readonly cli?: ClaudeCli;
  readonly readStatusLine?: () => Promise<unknown>;
  readonly fetchUsageEndpoint?: () => Promise<unknown>;
  readonly fetchOAuth?: ClaudeOAuthFetch;
  readonly env?: Record<string, string | undefined>;
  readonly now?: () => number;
}

/**
 * Build the default {@link ClaudeUsageSourceDeps} from the real seams (AC7 — wired as default), or from
 * the overrides a caller injects. The preflight runs the metadata `auth status` subcommand through the
 * (overridable) {@link ClaudeCli}; the idle seam is present but only fires when the operator gate is on.
 */
export function defaultClaudeDeps(options: DefaultClaudeDepsOptions = {}): ClaudeUsageSourceDeps {
  const cli = options.cli ?? realClaudeCli;
  const oauth =
    options.fetchUsageEndpoint === undefined
      ? new ClaudeOAuthUsageClient({
          fetchOAuth: options.fetchOAuth ?? realFetch,
          env: options.env ?? process.env,
          now: options.now ?? Date.now,
        })
      : undefined;
  return {
    authStatus: async () => {
      const out = await cli(CLAUDE_AUTH_STATUS_ARGS);
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(out);
      } catch {
        // a non-JSON auth-status output is treated as logged-in-unknown (defensive, never down-on-noise).
      }
      return parseClaudeAuthStatus(parsed);
    },
    statusLine: options.readStatusLine ?? realReadStatusLine,
    idleUsageRead: options.fetchUsageEndpoint ?? (() => oauth!.readUsage()),
    ...(options.now ? { now: options.now } : {}),
  };
}

interface ClaudeOAuthUsageClientOptions {
  readonly fetchOAuth: ClaudeOAuthFetch;
  readonly env: Record<string, string | undefined>;
  readonly now: () => number;
}

interface CachedAccessToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

/** A short-lived in-memory OAuth usage reader. It never writes secrets or samples to disk. */
class ClaudeOAuthUsageClient {
  private readonly fetchOAuth: ClaudeOAuthFetch;
  private readonly env: Record<string, string | undefined>;
  private readonly now: () => number;
  private readonly baseBackoffMs: number;
  private cachedAccessToken?: CachedAccessToken;
  private cachedRefreshToken?: string;
  private backoffUntilMs = 0;
  private nextBackoffMs: number;

  constructor(options: ClaudeOAuthUsageClientOptions) {
    this.fetchOAuth = options.fetchOAuth;
    this.env = options.env;
    this.now = options.now;
    this.baseBackoffMs = configuredBackoffMs(this.env[CLAUDE_OAUTH_BACKOFF_MS_ENV]);
    this.nextBackoffMs = this.baseBackoffMs;
  }

  async readUsage(): Promise<unknown> {
    const nowMs = this.now();
    if (this.backoffUntilMs > nowMs) {
      throw new Error(
        `Claude OAuth usage read is rate limited until ${new Date(this.backoffUntilMs).toISOString()}`,
      );
    }

    const accessToken = await this.accessToken(nowMs);
    const res = await this.fetchOAuth(CLAUDE_USAGE_ENDPOINT, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
      },
    });
    if (res.status === 429) {
      this.recordRateLimit(res, nowMs);
      throw new Error('Claude OAuth usage endpoint returned 429');
    }
    if (!res.ok) throw new Error(`usage endpoint returned ${res.status}`);

    this.resetBackoff();
    return res.json();
  }

  private async accessToken(nowMs: number): Promise<string> {
    const direct =
      stringish(this.env[CLAUDE_OAUTH_ACCESS_TOKEN_ENV]) ??
      stringish(this.env[CLAUDE_OAUTH_TOKEN_ENV]);
    if (direct !== undefined) return direct;

    if (this.cachedAccessToken && this.cachedAccessToken.expiresAtMs > nowMs) {
      return this.cachedAccessToken.token;
    }

    const refreshToken =
      this.cachedRefreshToken ?? stringish(this.env[CLAUDE_OAUTH_REFRESH_TOKEN_ENV]);
    if (refreshToken === undefined) {
      throw new Error(
        `set ${CLAUDE_OAUTH_REFRESH_TOKEN_ENV}, ${CLAUDE_OAUTH_ACCESS_TOKEN_ENV}, or ${CLAUDE_OAUTH_TOKEN_ENV} for the gated idle usage read`,
      );
    }

    const body = {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      scope: CLAUDE_AI_OAUTH_SCOPES.join(' '),
    };
    const res = await this.fetchOAuth(CLAUDE_OAUTH_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      this.recordRateLimit(res, nowMs);
      throw new Error('Claude OAuth token endpoint returned 429');
    }
    if (!res.ok) throw new Error(`token endpoint returned ${res.status}`);

    const payload = asRecord(await res.json());
    const token = payload ? stringish(pick(payload, 'access_token', 'accessToken')) : undefined;
    if (token === undefined) throw new Error('token endpoint did not return access_token');
    const rotatedRefreshToken = payload
      ? stringish(pick(payload, 'refresh_token', 'refreshToken'))
      : undefined;
    if (rotatedRefreshToken !== undefined) this.cachedRefreshToken = rotatedRefreshToken;

    const expiresInSeconds = payload
      ? numberish(pick(payload, 'expires_in', 'expiresIn'))
      : undefined;
    const ttlMs =
      expiresInSeconds !== undefined
        ? Math.max(0, expiresInSeconds * 1000 - CLAUDE_OAUTH_TOKEN_EXPIRY_SKEW_MS)
        : CLAUDE_OAUTH_TOKEN_CACHE_MS_DEFAULT;
    this.cachedAccessToken = { token, expiresAtMs: nowMs + ttlMs };
    return token;
  }

  private recordRateLimit(res: Response, nowMs: number): void {
    const retryAfterMs = retryAfterDeadlineMs(res.headers.get('retry-after'), nowMs);
    if (retryAfterMs !== undefined) {
      this.backoffUntilMs = retryAfterMs;
      return;
    }
    this.backoffUntilMs = nowMs + this.nextBackoffMs;
    this.nextBackoffMs = Math.min(this.nextBackoffMs * 2, CLAUDE_OAUTH_BACKOFF_MS_MAX);
  }

  private resetBackoff(): void {
    this.backoffUntilMs = 0;
    this.nextBackoffMs = this.baseBackoffMs;
  }
}

function configuredBackoffMs(raw: string | undefined): number {
  const parsed = numberish(raw);
  if (parsed === undefined || parsed <= 0) return CLAUDE_OAUTH_BACKOFF_MS_DEFAULT;
  return Math.min(parsed, CLAUDE_OAUTH_BACKOFF_MS_MAX);
}

function retryAfterDeadlineMs(raw: string | null, nowMs: number): number | undefined {
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return nowMs + seconds * 1000;
  const dateMs = Date.parse(raw);
  return Number.isNaN(dateMs) ? undefined : Math.max(dateMs, nowMs);
}

/** Spawn `claude` with metadata args and capture stdout. Metadata-only by construction (AC11). */
const realClaudeCli: ClaudeCli = (args) =>
  new Promise((resolve, reject) => {
    execFile('claude', [...args], { encoding: 'utf8', timeout: 15_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

/** Read the host-captured statusLine payload file (path via {@link CLAUDE_STATUSLINE_PATH_ENV}). */
async function realReadStatusLine(): Promise<unknown> {
  const path = process.env[CLAUDE_STATUSLINE_PATH_ENV];
  if (!path) {
    throw new Error(
      `set ${CLAUDE_STATUSLINE_PATH_ENV} to the captured Claude Code statusLine payload file`,
    );
  }
  return JSON.parse(await readFile(path, 'utf8'));
}

const realFetch: ClaudeOAuthFetch = (input, init) => fetch(input, init);
