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
 * network call is the (gated) metadata usage endpoint. Harvesting the live hosted-session
 * `rate_limit_event` stream is the L7 streaming source, NOT here. `claude-source.test.ts` proves the
 * adapter never reaches an inference path (mandatory).
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { Provider, ProviderUsageSource, UsageSnapshot, UsageWindow } from './usage-source.js';
import { UsageUnavailableError } from './usage-source.js';
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

/** Default Claude account label when the preflight does not refine it (per-account, Principle 13). */
export const CLAUDE_DEFAULT_ACCOUNT = 'claude:max';

/** The metadata-only preflight argv — `claude auth status --json`. NEVER an inference invocation (AC11). */
export const CLAUDE_AUTH_STATUS_ARGS: readonly string[] = ['auth', 'status', '--json'];

/** The account usage endpoint for the gated idle/cold read (metadata, no turn — AC11). */
export const CLAUDE_USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

/** Env var naming the file where the host captures the latest Claude Code statusLine payload. */
export const CLAUDE_STATUSLINE_PATH_ENV = 'CO_CLAUDE_STATUSLINE_PATH';

/** Env var carrying the OAuth bearer token for the gated idle usage read (host provides; never read from the repo). */
export const CLAUDE_OAUTH_TOKEN_ENV = 'CO_CLAUDE_OAUTH_TOKEN';

/** What the metadata preflight resolves: whether the account is logged in, and its label. */
export interface ClaudeAccountInfo {
  readonly loggedIn: boolean;
  readonly account: string;
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
  /** Account label; default {@link CLAUDE_DEFAULT_ACCOUNT}. The preflight refines it when it names one. */
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
  const account = asRecord(pick(root, 'account', 'user')) ?? root;
  const plan = stringish(pick(account, 'plan', 'subscription', 'tier'));
  const label = plan ? `claude:${plan.toLowerCase()}` : CLAUDE_DEFAULT_ACCOUNT;

  const loggedInFlag =
    boolish(pick(root, 'logged_in', 'loggedIn', 'authenticated', 'isAuthenticated')) ??
    (pick(root, 'error') !== undefined ? false : undefined);
  return { loggedIn: loggedInFlag ?? true, account: label };
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
  const rateLimits = asRecord(pick(root, 'rate_limits', 'rateLimits'));
  if (!rateLimits) return { windows: [] };

  const windows: UsageWindow[] = [];
  for (const [key, raw] of Object.entries(rateLimits)) {
    const window = asRecord(raw);
    if (!window) continue;
    const used = numberish(
      pick(window, 'used_percentage', 'used_percent', 'used_pct', 'utilization'),
    );
    const reset = stringish(pick(window, 'resets_at', 'reset_at', 'resetsAt'));
    if (used === undefined || reset === undefined) continue;
    windows.push({ kind: canonicalWindowKind(key), used_pct: used, reset_at: reset });
  }

  const account = stringish(pick(root, 'account', 'organization', 'org'));
  return account !== undefined ? { account, windows } : { windows };
}

/** Canonicalize a statusLine window key to the frozen labels where known; otherwise keep it verbatim. */
function canonicalWindowKind(key: string): string {
  const lower = key.toLowerCase();
  if (lower === 'five_hour' || lower === 'fivehour' || lower === '5h') return 'five_hour';
  if (lower === 'weekly' || lower === 'seven_day' || lower === '7d' || lower === 'week')
    return 'weekly';
  return key;
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
    let preflight: UsageSnapshot | null = null;
    try {
      const info = await this.deps.authStatus();
      account = info.account || account;
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
      run: () => this.readFromPayload(this.deps.statusLine(), account, sampledAt, 'statusLine'),
    });
    if (this.enableIdle && this.deps.idleUsageRead) {
      const idle = this.deps.idleUsageRead;
      attempts.push({
        label: 'idle usage endpoint (gated)',
        run: () => this.readFromPayload(idle(), account, sampledAt, 'oauth-usage'),
      });
    }
    return layeredRead('claude', account, attempts);
  }

  /** Parse a rate-limits-bearing payload (statusLine or usage endpoint) into a snapshot, or null if empty. */
  private async readFromPayload(
    payloadPromise: Promise<unknown>,
    account: string,
    sampledAt: string,
    source: string,
  ): Promise<UsageSnapshot | null> {
    const reading = parseClaudeStatusLine(await payloadPromise);
    if (reading.windows.length === 0) return null;
    return buildSnapshot({
      provider: 'claude',
      account: reading.account ?? account,
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

/** Options for {@link defaultClaudeDeps}: override any seam (tests do) or accept the real defaults. */
export interface DefaultClaudeDepsOptions {
  readonly cli?: ClaudeCli;
  readonly readStatusLine?: () => Promise<unknown>;
  readonly fetchUsageEndpoint?: () => Promise<unknown>;
  readonly now?: () => number;
}

/**
 * Build the default {@link ClaudeUsageSourceDeps} from the real seams (AC7 — wired as default), or from
 * the overrides a caller injects. The preflight runs the metadata `auth status` subcommand through the
 * (overridable) {@link ClaudeCli}; the idle seam is present but only fires when the operator gate is on.
 */
export function defaultClaudeDeps(options: DefaultClaudeDepsOptions = {}): ClaudeUsageSourceDeps {
  const cli = options.cli ?? realClaudeCli;
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
    idleUsageRead: options.fetchUsageEndpoint ?? realFetchClaudeUsage,
    ...(options.now ? { now: options.now } : {}),
  };
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

/** Fetch the account usage endpoint (metadata, no turn — AC11). Operator-gated; host provides the token. */
async function realFetchClaudeUsage(): Promise<unknown> {
  const token = process.env[CLAUDE_OAUTH_TOKEN_ENV];
  if (!token) throw new Error(`set ${CLAUDE_OAUTH_TOKEN_ENV} for the gated idle usage read`);
  const res = await fetch(CLAUDE_USAGE_ENDPOINT, {
    headers: { authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01' },
  });
  if (!res.ok) throw new Error(`usage endpoint returned ${res.status}`);
  return res.json();
}
