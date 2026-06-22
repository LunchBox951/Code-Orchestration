/**
 * L4 Phase 6 — the LIVE Codex (pro) {@link ProviderUsageSource} adapter (spec §2.6, §4.3; AC7, AC11).
 * Passive-first. Sources, in order, each behind an INJECTED read-only seam (default = the real impl;
 * tests inject fixtures so `pnpm test` stays hermetic/offline):
 *
 *   1. **Preflight:** `codex doctor --json` → health + account. Metadata only (AC11). An unhealthy /
 *      logged-out preflight wins immediately as an `available: false` snapshot (headroom `unknown`, AC6).
 *   2. **PASSIVE + VERIFIED (default):** the read-only latest **`codex.rate_limits`** event from
 *      **`~/.codex/logs_2.sqlite`** — parse `plan`, `allowed`, and primary/secondary
 *      `used_percent` + `window_minutes` + `reset_at` into {@link UsageWindow}s (kinds `primary` /
 *      `secondary`). A read-only SQLite open; zero extra usage, reliable. The read seam is injected; the
 *      default reader lives in **core** (never cli/mcp — AC9 layering).
 *   3. **ACTIVE (fresher, optional):** app-server JSON-RPC `account/rateLimits/read` — DETECT & FALL BACK
 *      (a managed standalone app-server was absent in research, so the seam is OFF by default and simply
 *      skipped when not wired).
 *   4. **FALLBACK:** tail `~/.codex/sessions/** /rollout-*.jsonl` for `token_count.rate_limits`.
 *
 * **AC11:** every seam is a passive read or a metadata probe — there is NO `codex exec`, no streaming
 * completion, no token-spending path anywhere in this adapter.
 */

import { execFile } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import '../store/suppress-sqlite-warning.js';
import { DatabaseSync } from 'node:sqlite';
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

/** Default Codex account label when the preflight does not refine it (per-account, Principle 13). */
export const CODEX_DEFAULT_ACCOUNT = 'codex:pro';

/** The metadata-only preflight argv — `codex doctor --json`. NEVER an inference invocation (AC11). */
export const CODEX_DOCTOR_ARGS: readonly string[] = ['doctor', '--json'];

/** Env var overriding the path to Codex's `logs_2.sqlite` (default `~/.codex/logs_2.sqlite`). */
export const CODEX_LOGS_DB_ENV = 'CO_CODEX_LOGS_DB';

/** Env var overriding the Codex sessions dir (default `~/.codex/sessions`). */
export const CODEX_SESSIONS_DIR_ENV = 'CO_CODEX_SESSIONS_DIR';

/** What the metadata preflight resolves: whether the toolchain is healthy/authed, and the account label. */
export interface CodexAccountInfo {
  readonly healthy: boolean;
  readonly account: string;
  /** True when metadata named an explicit account identity; false for plan/default fallback. */
  readonly accountObserved?: boolean;
}

/** What a rate-limits parse yields: the account (if named), availability, and the parsed windows. */
export interface CodexRateLimitsReading {
  readonly account?: string;
  readonly accountObserved?: boolean;
  readonly available: boolean;
  readonly windows: readonly UsageWindow[];
}

/**
 * The injected, read-only seams of {@link CodexUsageSource}. All are passive / metadata (AC11). The
 * default impls ({@link defaultCodexDeps}) are the real ones; tests inject fixtures.
 */
export interface CodexUsageSourceDeps {
  /** Preflight metadata. Default: `codex doctor --json`. */
  readonly doctor: () => Promise<CodexAccountInfo>;
  /** PASSIVE default — latest `codex.rate_limits` payload from `logs_2.sqlite`. Resolves undefined when none. */
  readonly readRateLimits: () => Promise<unknown>;
  /** ACTIVE optional — app-server `account/rateLimits/read`. Absent by default (detect & fall back). */
  readonly appServerRead?: () => Promise<unknown>;
  /** FALLBACK — tail `rollout-*.jsonl` for `token_count.rate_limits`. */
  readonly sessionRollout?: () => Promise<unknown>;
  /** Injected clock (epoch ms) for `sampled_at` + relative-reset resolution; defaults to the wall clock. */
  readonly now?: () => number;
}

/** Static config for {@link CodexUsageSource} (the account label). */
export interface CodexUsageSourceOptions {
  /** Account label fallback when metadata/passive payloads do not name the observed account. */
  readonly account?: string;
}

/**
 * Parse a `codex doctor --json` payload into {@link CodexAccountInfo} — DEFENSIVE: healthy unless the
 * payload clearly says otherwise (an explicit `authenticated: false`, or a `status`/`health` reading that
 * reads as failed). Account label is derived from a `plan` when present, else {@link CODEX_DEFAULT_ACCOUNT}.
 */
export function parseCodexDoctor(payload: unknown): CodexAccountInfo {
  const root = asRecord(payload) ?? {};
  const accountRecord = asRecord(pick(root, 'account', 'user')) ?? root;
  const explicit = firstScopedAccountLabel([root]);
  const plan = stringish(pick(accountRecord, 'plan', 'subscription', 'tier'));
  const account = explicit ?? (plan ? `codex:${plan.toLowerCase()}` : CODEX_DEFAULT_ACCOUNT);

  const authed = boolish(pick(root, 'authenticated', 'logged_in', 'loggedIn', 'signed_in'));
  const status = stringish(
    pick(root, 'status', 'health', 'state', 'overallStatus', 'overall_status'),
  );
  const statusBad = status ? /fail|error|unhealthy|down|logged.?out|expired/i.test(status) : false;
  return {
    healthy: !(authed === false || statusBad),
    account,
    accountObserved: explicit !== undefined,
  };
}

/**
 * Parse a `codex.rate_limits` payload into {@link UsageWindow}s — DEFENSIVE (spec §Fixtures). It locates
 * the object carrying `primary`/`secondary` (tolerating a wrapping `rate_limits` / `token_count` /
 * arbitrary envelope), reads `plan` + `allowed`, and for each of the primary/secondary windows reads
 * `used_percent` and a reset time. The reset is `reset_at` (verified) when present, else derived from a
 * relative `resets_in_seconds` against the sample time — so a host that reports relative resets still
 * parses. `allowed: false` ⇒ `available: false` (over-limit). A window missing a usage% or any reset is
 * skipped; an unparseable payload yields zero windows (the caller falls through to the next source).
 */
export function parseCodexRateLimits(
  payload: unknown,
  sampledAtIso: string,
): CodexRateLimitsReading {
  const root = asRecord(payload);
  if (!root) return { available: true, windows: [] };
  const found = findRateLimitsBodyWithParents(root);
  const body = found?.body ?? root;
  const metadataRecords = uniqueRecords([body, ...(found?.parents ?? []), root]);

  const explicitAccount = firstScopedAccountLabel(metadataRecords);
  const plan = firstStringish(metadataRecords, 'plan', 'plan_type');
  const account = explicitAccount ?? (plan ? `codex:${plan.toLowerCase()}` : undefined);
  const allowedValues = boolishValues(metadataRecords, 'allowed', 'is_allowed');
  const limitReachedValues = boolishValues(metadataRecords, 'limit_reached', 'limitReached');

  const sampledMs = Date.parse(sampledAtIso);
  const windows: UsageWindow[] = [];
  for (const key of ['primary', 'secondary'] as const) {
    const window = asRecord(pick(body, key));
    if (!window) continue;
    const used = numberish(pick(window, 'used_percent', 'used_percentage', 'used_pct'));
    if (used === undefined) continue;
    const reset = resolveResetAt(window, sampledMs);
    if (reset === undefined) continue;
    windows.push({ kind: key, used_pct: used, reset_at: reset });
  }

  const reading: CodexRateLimitsReading = {
    ...(account !== undefined ? { account } : {}),
    accountObserved: explicitAccount !== undefined,
    available: !allowedValues.includes(false) && !limitReachedValues.includes(true),
    windows,
  };
  return reading;
}

/**
 * Resolve a window's ISO reset — DEFENSIVE over the two shapes Codex emits. An explicit
 * `reset_at` / `resets_at` wins: a NUMBER (the verified live shape) is epoch SECONDS → ISO; an ISO-8601
 * string (the synthetic Phase-6 shape) is kept verbatim. Failing that, a relative `reset_after_seconds`
 * (the verified live alias) / `resets_in_seconds` is added to the sample time. Undefined when neither is
 * present.
 */
function resolveResetAt(window: Record<string, unknown>, sampledMs: number): string | undefined {
  const explicit = resolveExplicitResetAt(
    pick(window, 'reset_at', 'resets_at', 'resetAt', 'resetsAt'),
  );
  if (explicit !== undefined) return explicit;
  const relSeconds = numberish(
    pick(window, 'reset_after_seconds', 'resets_in_seconds', 'reset_in_seconds', 'resets_in'),
  );
  if (relSeconds !== undefined && Number.isFinite(sampledMs)) {
    return new Date(sampledMs + relSeconds * 1000).toISOString();
  }
  return undefined;
}

/**
 * Resolve an explicit `reset_at` value to an ISO string. The verified live payload reports it as a NUMBER
 * of epoch SECONDS (e.g. `1780538257` ≈ 2026, NOT milliseconds), while the synthetic Phase-6 fixtures use
 * an ISO-8601 string. A number (or numeric string) is treated as epoch seconds → ISO; an ISO-parseable
 * string is returned verbatim. Undefined when absent or unparseable.
 */
function resolveExplicitResetAt(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? new Date(value * 1000).toISOString() : undefined;
  }
  const text = stringish(value);
  if (text === undefined) return undefined;
  if (!Number.isNaN(Date.parse(text))) return text; // already an ISO timestamp — keep verbatim
  const seconds = numberish(text);
  return seconds !== undefined ? new Date(seconds * 1000).toISOString() : undefined;
}

/**
 * Locate the object that holds the `primary`/`secondary` rate-limit windows inside an arbitrary Codex
 * event envelope — DEFENSIVE. Returns the record carrying the windows directly, the one under a
 * `rate_limits` child, or one found by a shallow DFS (so a `token_count` wrapper or a logged event row
 * still resolves). Undefined when no such object exists.
 */
interface RateLimitsBodyMatch {
  readonly body: Record<string, unknown>;
  readonly parents: readonly Record<string, unknown>[];
}

function findRateLimitsBody(value: unknown, depth = 0): Record<string, unknown> | undefined {
  return findRateLimitsBodyWithParents(value, depth)?.body;
}

function findRateLimitsBodyWithParents(
  value: unknown,
  depth = 0,
  parents: readonly Record<string, unknown>[] = [],
): RateLimitsBodyMatch | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const nested = asRecord(pick(record, 'rate_limits', 'rateLimits'));
  if (nested && (asRecord(nested.primary) || asRecord(nested.secondary))) {
    return { body: nested, parents: [record, ...parents] };
  }
  if (asRecord(record.primary) || asRecord(record.secondary)) return { body: record, parents };
  if (depth >= 4) return undefined;
  for (const child of Object.values(record)) {
    const found = findRateLimitsBodyWithParents(child, depth + 1, [record, ...parents]);
    if (found) return found;
  }
  return undefined;
}

function uniqueRecords(
  records: readonly Record<string, unknown>[],
): readonly Record<string, unknown>[] {
  return [...new Set(records)];
}

function firstStringish(
  records: readonly Record<string, unknown>[],
  ...keys: readonly string[]
): string | undefined {
  for (const record of records) {
    const value = stringish(pick(record, ...keys));
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstScopedAccountLabel(records: readonly Record<string, unknown>[]): string | undefined {
  for (const record of records) {
    const direct = providerAccountLabel(
      stringish(pick(record, 'account_id', 'accountId')),
      'codex',
    );
    if (direct !== undefined) return direct;

    const account = stringish(pick(record, 'account'));
    const directAccount = providerAccountLabel(account, 'codex');
    if (directAccount !== undefined) return directAccount;

    for (const key of ['account', 'user'] as const) {
      const scoped = asRecord(pick(record, key));
      if (!scoped) continue;
      const label = providerAccountLabel(
        stringish(pick(scoped, 'account', 'account_id', 'accountId', 'id', 'label')),
        'codex',
      );
      if (label !== undefined) return label;
    }
  }
  return undefined;
}

function boolishValues(
  records: readonly Record<string, unknown>[],
  ...keys: readonly string[]
): boolean[] {
  const values: boolean[] = [];
  for (const record of records) {
    const value = boolish(pick(record, ...keys));
    if (value !== undefined) values.push(value);
  }
  return values;
}

/**
 * The live Codex (pro) usage adapter — a layered, passive-first, fail-loud {@link ProviderUsageSource}
 * over the injected metadata/passive seams. Returns the EXACT frozen {@link UsageSnapshot}; throws
 * {@link UsageUnavailableError} when no source yields one (AC6).
 */
export class CodexUsageSource implements ProviderUsageSource {
  private readonly deps: CodexUsageSourceDeps;
  private readonly account: string;

  constructor(deps: CodexUsageSourceDeps, options: CodexUsageSourceOptions = {}) {
    this.deps = deps;
    this.account = options.account ?? CODEX_DEFAULT_ACCOUNT;
  }

  async read(provider: Provider): Promise<UsageSnapshot> {
    if (provider !== 'codex') {
      throw new UsageUnavailableError(
        provider,
        `CodexUsageSource cannot read provider '${provider}'`,
      );
    }
    const sampledAt = sampledNowIso(this.deps.now);

    // 1. Preflight (metadata only). Best-effort: a thrown preflight does not abort.
    let account = this.account;
    let accountObserved = this.account === CODEX_DEFAULT_ACCOUNT;
    let preflight: UsageSnapshot | null = null;
    try {
      const info = await this.deps.doctor();
      if (info.accountObserved !== false || this.account === CODEX_DEFAULT_ACCOUNT) {
        account = info.account || account;
      }
      if (info.accountObserved !== false) accountObserved = true;
      if (!info.healthy) {
        preflight = buildSnapshot({
          provider: 'codex',
          account,
          windows: [],
          available: false,
          source: 'doctor',
          sampledAt,
        });
      }
    } catch {
      // metadata preflight failed — fall through to the passive sqlite read.
    }

    const attempts: UsageSourceAttempt[] = [];
    if (preflight) {
      attempts.push({ label: 'doctor preflight', run: () => Promise.resolve(preflight) });
    }
    attempts.push({
      label: 'logs_2.sqlite codex.rate_limits (passive)',
      run: () =>
        this.readReadout(this.deps.readRateLimits(), account, accountObserved, sampledAt, 'sqlite'),
    });
    if (this.deps.appServerRead) {
      const appServerRead = this.deps.appServerRead;
      attempts.push({
        label: 'app-server account/rateLimits/read (active)',
        run: () =>
          this.readReadout(appServerRead(), account, accountObserved, sampledAt, 'app-server'),
      });
    }
    if (this.deps.sessionRollout) {
      const sessionRollout = this.deps.sessionRollout;
      attempts.push({
        label: 'session rollout jsonl (fallback)',
        run: () =>
          this.readReadout(sessionRollout(), account, accountObserved, sampledAt, 'session-jsonl'),
      });
    }
    return layeredRead('codex', account, attempts);
  }

  /** Parse a rate-limits payload into a snapshot; null when it carried no windows (fall to next source). */
  private async readReadout(
    payloadPromise: Promise<unknown>,
    account: string,
    accountObserved: boolean,
    sampledAt: string,
    source: string,
  ): Promise<UsageSnapshot | null> {
    const reading = parseCodexRateLimits(await payloadPromise, sampledAt);
    const resolvedAccount =
      reading.account !== undefined &&
      (reading.accountObserved !== false || this.account === CODEX_DEFAULT_ACCOUNT)
        ? reading.account
        : account;
    const observed = accountObserved || reading.accountObserved !== false;
    if (this.account !== CODEX_DEFAULT_ACCOUNT && !observed) {
      throw new UsageUnavailableError(
        'codex',
        `requested Codex account '${this.account}' was not observed by ${source}`,
        { account: this.account },
      );
    }
    if (!reading.available) {
      return buildSnapshot({
        provider: 'codex',
        account: resolvedAccount,
        windows: reading.windows,
        available: false,
        source,
        sampledAt,
      });
    }
    if (reading.windows.length === 0) return null;
    return buildSnapshot({
      provider: 'codex',
      account: resolvedAccount,
      windows: reading.windows,
      available: true,
      source,
      sampledAt,
    });
  }
}

// ── Default (real) seams — used in production; NEVER exercised by the hermetic test suite ───────────
/** A spawn of the real `codex` binary for a METADATA subcommand only (AC11 — never an inference call). */
export type CodexCli = (args: readonly string[]) => Promise<string>;

/** Options for {@link defaultCodexDeps}: override any seam (tests do) or accept the real defaults. */
export interface DefaultCodexDepsOptions {
  readonly cli?: CodexCli;
  readonly readRateLimits?: () => Promise<unknown>;
  readonly appServerRead?: () => Promise<unknown>;
  readonly sessionRollout?: () => Promise<unknown>;
  readonly now?: () => number;
}

/**
 * Build the default {@link CodexUsageSourceDeps} from the real seams (AC7 — wired as default), or from the
 * overrides a caller injects. The preflight runs `codex doctor --json` through the (overridable)
 * {@link CodexCli}; the passive read opens `logs_2.sqlite` read-only; the session fallback tails the
 * rollout files. The app-server ACTIVE seam is left absent (detect & fall back) unless explicitly wired.
 */
export function defaultCodexDeps(options: DefaultCodexDepsOptions = {}): CodexUsageSourceDeps {
  const cli = options.cli ?? realCodexCli;
  return {
    doctor: async () => {
      const out = await cli(CODEX_DOCTOR_ARGS);
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(out);
      } catch {
        // a non-JSON doctor output is treated as healthy-unknown (defensive, never down-on-noise).
      }
      return parseCodexDoctor(parsed);
    },
    readRateLimits: options.readRateLimits ?? realReadCodexRateLimits,
    sessionRollout: options.sessionRollout ?? realReadSessionRollout,
    ...(options.appServerRead ? { appServerRead: options.appServerRead } : {}),
    ...(options.now ? { now: options.now } : {}),
  };
}

/** Spawn `codex` with metadata args and capture stdout. Metadata-only by construction (AC11). */
const realCodexCli: CodexCli = (args) =>
  new Promise((resolve, reject) => {
    execFile('codex', [...args], { encoding: 'utf8', timeout: 15_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

// ── Per-turn COST from logs_2.sqlite token_count (collection seam, spec §4.2) ───────────────────────
/**
 * The per-turn token cost read off a Codex `token_count` payload. Codex ships NO price table (v1), so
 * there is no `costUsd` — only token counts (and a usage-% expression where present). Any field may be
 * undefined when the payload did not report it.
 *
 * `cumulative` is `true` when the token counts came from Codex's SESSION-CUMULATIVE `total_token_usage`
 * (a running total that grows every turn) rather than its per-turn `last_token_usage`. The collection
 * caller MUST subtract the previous cumulative reading before recording, or the per-turn rollup (which
 * SUMS observations) would massively over-count across a multi-turn session. When `last_token_usage` is
 * present it is preferred (it is already the per-turn delta) and `cumulative` is omitted/false.
 */
export interface CodexTurnCost {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly usedPct?: number;
  /** True when the counts are session-cumulative (`total_token_usage`) and need delta-ing per turn. */
  readonly cumulative?: boolean;
}

/**
 * Parse a Codex `token_count` payload into a {@link CodexTurnCost} — DEFENSIVE over the
 * unknown-but-host-validated schema. It PREFERS the per-turn `last_token_usage` body (already a per-turn
 * delta) and otherwise falls back to the session-cumulative `total_token_usage` (flagged
 * `cumulative: true` so the caller can delta it). It reads `input_tokens` / `output_tokens` /
 * `total_tokens` (with aliases), and — when a rate-limits body is present — the primary window's
 * `used_percent`. Returns `undefined` when no token field is found (the caller records nothing).
 */
export function parseCodexTokenCount(payload: unknown): CodexTurnCost | undefined {
  const root = asRecord(payload);
  if (!root) return undefined;
  const match = findTokenUsageBody(root);
  const body = match?.body ?? root;
  const cumulative = match?.cumulative ?? false;
  const input = numberish(
    pick(body, 'input_tokens', 'inputTokens', 'prompt_tokens', 'input_token_count'),
  );
  const output = numberish(
    pick(body, 'output_tokens', 'outputTokens', 'completion_tokens', 'output_token_count'),
  );
  const total = numberish(
    pick(body, 'total_tokens', 'totalTokens', 'total_token_count', 'total_usage_tokens'),
  );
  const rateBody = findRateLimitsBody(root);
  const primary = rateBody ? asRecord(pick(rateBody, 'primary')) : undefined;
  const usedPct = primary
    ? numberish(pick(primary, 'used_percent', 'used_percentage', 'used_pct'))
    : undefined;
  if (input === undefined && output === undefined && total === undefined && usedPct === undefined) {
    return undefined;
  }
  return {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(total !== undefined ? { totalTokens: total } : {}),
    ...(usedPct !== undefined ? { usedPct } : {}),
    ...(cumulative ? { cumulative: true } : {}),
  };
}

/** A located token-usage body plus whether it is the session-cumulative `total_token_usage`. */
interface TokenUsageBodyMatch {
  readonly body: Record<string, unknown>;
  readonly cumulative: boolean;
}

/**
 * Locate the object carrying token-usage counts inside an arbitrary Codex `token_count` envelope. The
 * per-turn `last_token_usage` is preferred over the session-cumulative `total_token_usage` (each turn's
 * `total_token_usage` is a running session total — recording it per turn would over-count once the
 * rollup sums observations). The match flags `cumulative: true` when only `total_token_usage` was found
 * so the caller can subtract the previous reading.
 */
function findTokenUsageBody(value: unknown, depth = 0): TokenUsageBodyMatch | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  // Per-turn deltas first (never cumulative); then the session-cumulative running total.
  for (const key of ['last_token_usage', 'token_usage', 'usage', 'info']) {
    const nested = asRecord(pick(record, key));
    if (nested && hasTokenFields(nested)) return { body: nested, cumulative: false };
  }
  const cumulativeBody = asRecord(pick(record, 'total_token_usage'));
  if (cumulativeBody && hasTokenFields(cumulativeBody)) {
    return { body: cumulativeBody, cumulative: true };
  }
  if (hasTokenFields(record)) return { body: record, cumulative: false };
  if (depth >= 4) return undefined;
  for (const child of Object.values(record)) {
    const found = findTokenUsageBody(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function hasTokenFields(record: Record<string, unknown>): boolean {
  return (
    numberish(pick(record, 'input_tokens', 'inputTokens', 'prompt_tokens', 'input_token_count')) !==
      undefined ||
    numberish(
      pick(record, 'output_tokens', 'outputTokens', 'completion_tokens', 'output_token_count'),
    ) !== undefined ||
    numberish(
      pick(record, 'total_tokens', 'totalTokens', 'total_token_count', 'total_usage_tokens'),
    ) !== undefined
  );
}

/**
 * The verified signature of a Codex `token_count` websocket event in a `feedback_log_body` row — used to
 * pin the latest GENUINE token_count event past prose that merely mentions the event name.
 */
const TOKEN_COUNT_SIGNATURE = 'websocket event: {"type":"token_count"';
const RESPONSE_COMPLETED_SIGNATURE = 'event.kind=response.completed';
const POST_SAMPLING_SIGNATURE = 'post sampling token usage';

export interface CodexTokenCountReadout {
  readonly payload: unknown;
  readonly sourceId: string;
}

/**
 * Scan a Codex log database (read-only) for the LATEST token payload — DEFENSIVE, mirroring
 * {@link readLatestCodexRateLimits}. Returns the parsed payload and a stable row source identity, or
 * undefined when none is found.
 */
export function readLatestCodexTokenCountReadout(
  db: DatabaseSync,
  opts: { readonly afterSourceId?: string } = {},
): CodexTokenCountReadout | undefined {
  const after = parseCodexLogSourceId(opts.afterSourceId);
  if (after !== undefined) {
    const continued = readCodexTokenCandidatesAfter(db, after);
    if (continued !== undefined) return latestCodexTokenCandidate(continued);
  }
  const columns = collectTextColumns(db);
  const candidates = [
    ...readCodexTokenCandidates(db, columns, RESPONSE_COMPLETED_SIGNATURE, 'response-completed'),
    ...readCodexTokenCandidates(db, columns, TOKEN_COUNT_SIGNATURE, 'token-count'),
    ...readCodexTokenCandidates(db, columns, POST_SAMPLING_SIGNATURE, 'post-sampling'),
  ];
  return latestCodexTokenCandidate(candidates);
}

/**
 * Payload-only convenience accessor over {@link readLatestCodexTokenCountReadout} for callers
 * (currently tests) that do not need the source cursor.
 */
export function readLatestCodexTokenCount(db: DatabaseSync): unknown | undefined {
  return readLatestCodexTokenCountReadout(db)?.payload;
}

interface CodexTokenCandidate extends CodexTokenCountReadout {
  readonly table: string;
  readonly rowid: number;
  readonly columnIndex: number;
  readonly timestampMs?: number;
}

function readCodexTokenCandidates(
  db: DatabaseSync,
  columns: readonly TextColumn[],
  signature: string,
  label: string,
): CodexTokenCandidate[] {
  const candidates: CodexTokenCandidate[] = [];
  columns.forEach((textColumn, columnIndex) => {
    const { table, column, timeColumn } = textColumn;
    const observedAt = timeColumn ? `, ${quoteIdent(timeColumn)} AS observed_at` : '';
    let rows: Array<Record<string, unknown>>;
    try {
      rows = db
        .prepare(
          `SELECT rowid AS rowid, ${quoteIdent(column)} AS value${observedAt} FROM ${quoteIdent(table)} ` +
            `WHERE ${quoteIdent(column)} LIKE ? ESCAPE '\\' ORDER BY rowid DESC LIMIT 50`,
        )
        .all(`%${escapeLikeLiteral(signature)}%`) as Array<Record<string, unknown>>;
    } catch (error) {
      // a column a text LIKE cannot bind against is skipped; log so a persistently corrupt/busy db is
      // not entirely invisible (the broad catch otherwise swallows SQLITE_CORRUPT/IOERR/BUSY too).
      console.error('[co] codex token scan: unexpected sqlite error', error);
      return;
    }
    for (const row of rows) {
      if (typeof row.value !== 'string') continue;
      const rowid = numberish(row.rowid);
      if (rowid === undefined) continue;
      const payload = parseCodexTokenRowText(row.value);
      if (payload === undefined || parseCodexTokenCount(payload) === undefined) continue;
      const timestampMs =
        timestampMsFromUnknown(row.observed_at) ?? timestampMsFromPayload(payload);
      const sourceLabel = codexTokenSignatureLabel(row.value) ?? label;
      candidates.push({
        payload,
        sourceId: codexLogSourceId(table, column, rowid, sourceLabel),
        table,
        rowid,
        columnIndex,
        ...(timestampMs !== undefined ? { timestampMs } : {}),
      });
    }
  });
  return candidates;
}

interface CodexLogCursor {
  readonly table: string;
  readonly column: string;
  readonly rowid: number;
}

function readCodexTokenCandidatesAfter(
  db: DatabaseSync,
  cursor: CodexLogCursor,
): CodexTokenCandidate[] | undefined {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db
      .prepare(
        `SELECT rowid AS rowid, ${quoteIdent(cursor.column)} AS value FROM ${quoteIdent(cursor.table)} ` +
          `WHERE rowid > ? AND (` +
          `${quoteIdent(cursor.column)} LIKE ? ESCAPE '\\' OR ` +
          `${quoteIdent(cursor.column)} LIKE ? ESCAPE '\\' OR ` +
          `${quoteIdent(cursor.column)} LIKE ? ESCAPE '\\') ` +
          `ORDER BY rowid DESC LIMIT 50`,
      )
      .all(
        cursor.rowid,
        `%${escapeLikeLiteral(RESPONSE_COMPLETED_SIGNATURE)}%`,
        `%${escapeLikeLiteral(TOKEN_COUNT_SIGNATURE)}%`,
        `%${escapeLikeLiteral(POST_SAMPLING_SIGNATURE)}%`,
      ) as Array<Record<string, unknown>>;
  } catch (error) {
    // schema changed or cursor path vanished; caller falls back to discovery. Log so a persistently
    // corrupt/busy db is not entirely invisible (the broad catch otherwise swallows real sqlite errors).
    console.error('[co] codex token scan: unexpected sqlite error', error);
    return undefined;
  }
  const candidates: CodexTokenCandidate[] = [];
  for (const row of rows) {
    if (typeof row.value !== 'string') continue;
    const rowid = numberish(row.rowid);
    const label = codexTokenSignatureLabel(row.value);
    if (rowid === undefined || label === undefined) continue;
    const payload = parseCodexTokenRowText(row.value);
    if (payload === undefined || parseCodexTokenCount(payload) === undefined) continue;
    candidates.push({
      payload,
      sourceId: codexLogSourceId(cursor.table, cursor.column, rowid, label),
      table: cursor.table,
      rowid,
      columnIndex: 0,
    });
  }
  return candidates;
}

function latestCodexTokenCandidate(
  candidates: readonly CodexTokenCandidate[],
): CodexTokenCountReadout | undefined {
  return [...candidates].sort(compareCodexTokenCandidate)[0];
}

function compareCodexTokenCandidate(a: CodexTokenCandidate, b: CodexTokenCandidate): number {
  if (
    a.timestampMs !== undefined &&
    b.timestampMs !== undefined &&
    a.timestampMs !== b.timestampMs
  ) {
    return b.timestampMs - a.timestampMs;
  }
  if (a.timestampMs !== undefined && b.timestampMs === undefined) return -1;
  if (a.timestampMs === undefined && b.timestampMs !== undefined) return 1;
  if (a.table === b.table && a.rowid !== b.rowid) return b.rowid - a.rowid;
  return a.table.localeCompare(b.table) || b.rowid - a.rowid || b.columnIndex - a.columnIndex;
}

function codexLogSourceId(table: string, column: string, rowid: number, label: string): string {
  return `codex-log:v2:${escapeSourcePart(table)}:${escapeSourcePart(column)}:${rowid}:${label}`;
}

function parseCodexLogSourceId(sourceId: string | undefined): CodexLogCursor | undefined {
  if (sourceId === undefined) return undefined;
  const match = /^codex-log:v2:([^:]+):([^:]+):(\d+):[^:]+$/u.exec(sourceId);
  if (!match) return undefined;
  return {
    table: unescapeSourcePart(match[1]!),
    column: unescapeSourcePart(match[2]!),
    rowid: Number(match[3]),
  };
}

function escapeSourcePart(part: string): string {
  return encodeURIComponent(part);
}

function unescapeSourcePart(part: string): string {
  return decodeURIComponent(part);
}

function parseCodexTokenRowText(text: string): unknown | undefined {
  return tryParseJson(extractEmbeddedJson(text)) ?? parseCodexTokenLogText(text);
}

function codexTokenSignatureLabel(text: string): string | undefined {
  if (text.includes(RESPONSE_COMPLETED_SIGNATURE)) return 'response-completed';
  if (text.includes(TOKEN_COUNT_SIGNATURE)) return 'token-count';
  if (text.includes(POST_SAMPLING_SIGNATURE)) return 'post-sampling';
  return undefined;
}

function parseCodexTokenLogText(text: string): unknown | undefined {
  if (text.includes(RESPONSE_COMPLETED_SIGNATURE)) {
    const input = logfmtNumber(text, 'input_token_count');
    const output = logfmtNumber(text, 'output_token_count');
    if (input === undefined && output === undefined) return undefined;
    const usage = {
      ...(input !== undefined ? { input_tokens: input } : {}),
      ...(output !== undefined ? { output_tokens: output } : {}),
      ...(input !== undefined && output !== undefined ? { total_tokens: input + output } : {}),
    };
    return { type: 'token_count', info: { last_token_usage: usage } };
  }
  if (text.includes(POST_SAMPLING_SIGNATURE)) {
    const total = logfmtNumber(text, 'total_usage_tokens');
    if (total === undefined) return undefined;
    return { type: 'token_count', info: { total_token_usage: { total_tokens: total } } };
  }
  return undefined;
}

function logfmtNumber(text: string, key: string): number | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\s)${escaped}=([^\\s]+)`, 'u').exec(text);
  if (!match) return undefined;
  const raw = match[1]!.replace(/^Some\(/u, '').replace(/\)$/u, '');
  return numberish(raw);
}

/** Default `logs_2.sqlite` path (`$CO_CODEX_LOGS_DB` or `~/.codex/logs_2.sqlite`). */
export function defaultCodexLogsDbPath(): string {
  return process.env[CODEX_LOGS_DB_ENV] ?? join(homedir(), '.codex', 'logs_2.sqlite');
}

/** Default Codex sessions dir (`$CO_CODEX_SESSIONS_DIR` or `~/.codex/sessions`). */
export function defaultCodexSessionsDir(): string {
  return process.env[CODEX_SESSIONS_DIR_ENV] ?? join(homedir(), '.codex', 'sessions');
}

/** Open a Codex log database READ-ONLY (never mutates the host's logs). Caller closes it. */
export function openCodexLogsDb(path: string = defaultCodexLogsDbPath()): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}

/** Default passive read: open `logs_2.sqlite` read-only and return the latest rate-limits payload. */
async function realReadCodexRateLimits(): Promise<unknown> {
  const db = openCodexLogsDb();
  try {
    return readLatestCodexRateLimits(db);
  } finally {
    db.close();
  }
}

/** Quote a SQLite identifier (table / column) for interpolation where a bind param is not allowed. */
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * The verified signature of a real Codex `codex.rate_limits` event as it is stored in a `feedback_log_body`
 * row: an OpenTelemetry span-context prefix, then `websocket event: {"type":"codex.rate_limits"…}`. Used
 * to pin the latest GENUINE event with a SQL `LIKE`, past prose that merely mentions the event name.
 */
const RATE_LIMITS_SIGNATURE = 'websocket event: {"type":"codex.rate_limits"';

/**
 * Scan a Codex log database (read-only) for the LATEST `codex.rate_limits` payload — DEFENSIVE over an
 * unknown-but-host-validated schema (spec §Fixtures). Two passes, PRIORITIZED first:
 *
 *   1. A targeted SQL `LIKE` on the {@link RATE_LIMITS_SIGNATURE} pins the newest GENUINE websocket event,
 *      even when the logs are polluted with assistant-message prose that merely mentions
 *      `codex.rate_limits` / `used_percent` and could otherwise fall outside (or outrank) a fixed window.
 *   2. A defensive newest-`scanLimit`-row text scan per column that only trusts candidates with an event-type
 *      column or signature provenance, so arbitrary assistant-message JSON is ignored.
 *
 * Both passes EXTRACT the embedded JSON (real bodies are not pure JSON — see {@link extractEmbeddedJson})
 * before parsing, then return the first value that resolves into a rate-limits structure (a `primary` /
 * `secondary` window set, possibly wrapped). Returns undefined when no rate-limits payload is found.
 */
export function readLatestCodexRateLimits(
  db: DatabaseSync,
  opts: { readonly scanLimit?: number } = {},
): unknown | undefined {
  const scanLimit = opts.scanLimit ?? 500;
  const columns = collectTextColumns(db);

  const candidates = [
    ...columns.flatMap((column, columnIndex) => readSignatureRateLimits(db, column, columnIndex)),
    ...columns.flatMap((column, columnIndex) =>
      scanColumnRateLimits(db, column, columnIndex, scanLimit),
    ),
  ];
  return latestRateLimitsCandidate(candidates)?.payload;
}

/** Collect every (table, text-ish column) pair in a Codex log DB — the search space for both scan passes. */
interface TextColumn {
  readonly table: string;
  readonly column: string;
  readonly timeColumn?: string;
  readonly eventTypeColumn?: string;
}

function collectTextColumns(db: DatabaseSync): TextColumn[] {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<
    Record<string, unknown>
  >;
  const pairs: TextColumn[] = [];
  for (const table of tables) {
    const tableName = stringish(table.name);
    if (!tableName) continue;
    const columns = db.prepare(`PRAGMA table_info(${quoteIdent(tableName)})`).all() as Array<
      Record<string, unknown>
    >;
    const timeColumn = chooseTimestampColumn(columns);
    const eventTypeColumn = chooseEventTypeColumn(columns);
    for (const c of columns) {
      const name = stringish(c.name);
      if (name && /text|char|clob|json|blob|^$/i.test(String(c.type ?? ''))) {
        pairs.push({
          table: tableName,
          column: name,
          ...(timeColumn ? { timeColumn } : {}),
          ...(eventTypeColumn ? { eventTypeColumn } : {}),
        });
      }
    }
  }
  return pairs;
}

function chooseTimestampColumn(columns: readonly Record<string, unknown>[]): string | undefined {
  const names = columns.map((c) => stringish(c.name)).filter((n) => n !== undefined);
  const preferred = [
    'timestamp',
    'created_at',
    'createdAt',
    'event_time',
    'time',
    'ts',
    'created',
    'updated_at',
  ];
  return preferred.find((candidate) => names.includes(candidate));
}

function chooseEventTypeColumn(columns: readonly Record<string, unknown>[]): string | undefined {
  const names = columns.map((c) => stringish(c.name)).filter((n) => n !== undefined);
  const preferred = ['type', 'event_type', 'eventType', 'event_name', 'name'];
  return preferred.find((candidate) => names.includes(candidate));
}

/** Query the single LATEST row whose column carries the real `codex.rate_limits` websocket-event signature. */
interface RateLimitsCandidate {
  readonly table: string;
  readonly rowid: number;
  readonly columnIndex: number;
  readonly timestampMs?: number;
  readonly provenance: 'signature' | 'event-column' | 'blind-type';
  readonly trusted: boolean;
  readonly payload: unknown;
}

function readSignatureRateLimits(
  db: DatabaseSync,
  textColumn: TextColumn,
  columnIndex: number,
): RateLimitsCandidate[] {
  const { table, column, timeColumn, eventTypeColumn } = textColumn;
  const observedAt = timeColumn ? `, ${quoteIdent(timeColumn)} AS observed_at` : '';
  const eventType =
    eventTypeColumn !== undefined && eventTypeColumn !== column
      ? `, ${quoteIdent(eventTypeColumn)} AS event_type_hint`
      : '';
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db
      .prepare(
        `SELECT rowid AS rowid, ${quoteIdent(column)} AS value${observedAt}${eventType} FROM ${quoteIdent(table)} ` +
          `WHERE ${quoteIdent(column)} LIKE ? ESCAPE '\\' ORDER BY rowid DESC LIMIT 50`,
      )
      .all(`%${escapeLikeLiteral(RATE_LIMITS_SIGNATURE)}%`) as Array<Record<string, unknown>>;
  } catch {
    return []; // a column a text LIKE cannot bind against is skipped.
  }
  return rateLimitsCandidatesFromRows(
    rows,
    table,
    columnIndex,
    isTrustedSignatureColumn(textColumn),
  );
}

/** Scan newest rows, but return only candidates with trusted event-type/signature provenance. */
function scanColumnRateLimits(
  db: DatabaseSync,
  textColumn: TextColumn,
  columnIndex: number,
  scanLimit: number,
): RateLimitsCandidate[] {
  const { table, column, timeColumn, eventTypeColumn } = textColumn;
  const observedAt = timeColumn ? `, ${quoteIdent(timeColumn)} AS observed_at` : '';
  const eventType =
    eventTypeColumn !== undefined && eventTypeColumn !== column
      ? `, ${quoteIdent(eventTypeColumn)} AS event_type_hint`
      : '';
  let rows: Array<Record<string, unknown>>;
  try {
    rows = db
      .prepare(
        `SELECT rowid AS rowid, ${quoteIdent(column)} AS value${observedAt}${eventType} FROM ${quoteIdent(table)} ` +
          `ORDER BY rowid DESC LIMIT ${scanLimit}`,
      )
      .all() as Array<Record<string, unknown>>;
  } catch {
    return []; // a column that cannot be ordered/selected is skipped.
  }
  const hinted = rows.filter(
    (row) => typeof row.value === 'string' && /rate_limit|used_percent/i.test(row.value),
  );
  return rateLimitsCandidatesFromRows(hinted, table, columnIndex, false);
}

/** Extract + parse rows whose (possibly prefixed) text body resolves into a rate-limits payload. */
function rateLimitsCandidatesFromRows(
  rows: Array<Record<string, unknown>>,
  table: string,
  columnIndex: number,
  trusted: boolean,
): RateLimitsCandidate[] {
  const candidates: RateLimitsCandidate[] = [];
  for (const row of rows) {
    const text = row.value;
    if (typeof text !== 'string') continue;
    const parsed = tryParseJson(extractEmbeddedJson(text));
    const rowid = numberish(row.rowid);
    const eventColumnTrusted = isTrustedEventType(row.event_type_hint);
    const strong = trusted || eventColumnTrusted;
    if (parsed !== undefined && findRateLimitsBody(parsed) && rowid !== undefined && strong) {
      const timestampMs = timestampMsFromUnknown(row.observed_at) ?? timestampMsFromPayload(parsed);
      candidates.push({
        table,
        rowid,
        columnIndex,
        ...(timestampMs !== undefined ? { timestampMs } : {}),
        provenance: trusted ? 'signature' : eventColumnTrusted ? 'event-column' : 'blind-type',
        trusted: strong,
        payload: parsed,
      });
    }
  }
  return candidates;
}

/** Choose the newest matching row; timestamps compare across tables, rowid only within one table. */
function latestRateLimitsCandidate(
  candidates: readonly RateLimitsCandidate[],
): RateLimitsCandidate | undefined {
  if (candidates.every((c) => c.timestampMs === undefined)) {
    const tables = new Set(candidates.map((c) => c.table));
    if (tables.size > 1) return undefined;
  }
  return [...candidates].sort(compareRateLimitsCandidate)[0];
}

function isTrustedSignatureColumn(column: TextColumn): boolean {
  return column.column === 'feedback_log_body' || column.column.startsWith('feedback_log_body_');
}

function isTrustedEventType(value: unknown): boolean {
  const type = stringish(value);
  return type === 'codex.rate_limits' || type === 'token_count';
}

function providerAccountLabel(value: string | undefined, provider: 'codex'): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith(`${provider}:`) && trimmed.length > provider.length + 1) return trimmed;
  return /^[a-z0-9._-]+$/u.test(trimmed) ? `${provider}:${trimmed}` : undefined;
}

function compareRateLimitsCandidate(a: RateLimitsCandidate, b: RateLimitsCandidate): number {
  if (
    a.timestampMs !== undefined &&
    b.timestampMs !== undefined &&
    a.timestampMs !== b.timestampMs
  ) {
    return b.timestampMs - a.timestampMs;
  }
  if (a.timestampMs !== undefined && b.timestampMs === undefined) return -1;
  if (a.timestampMs === undefined && b.timestampMs !== undefined) return 1;
  if (a.table === b.table && a.rowid !== b.rowid) return b.rowid - a.rowid;
  if (a.trusted !== b.trusted) return a.trusted ? -1 : 1;
  return a.table.localeCompare(b.table) || b.columnIndex - a.columnIndex;
}

function timestampMsFromPayload(payload: unknown): number | undefined {
  const root = asRecord(payload);
  if (!root) return undefined;
  return timestampMsFromUnknown(pick(root, 'timestamp', 'created_at', 'createdAt', 'time', 'ts'));
}

function timestampMsFromUnknown(value: unknown): number | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    return value > 1_000_000_000_000 ? value : value * 1000;
  }
  const text = stringish(value);
  if (text === undefined) return undefined;
  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed)) return parsed;
  const numeric = numberish(text);
  if (numeric === undefined) return undefined;
  return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
}

/** Escape a literal for a SQLite `LIKE … ESCAPE '\'` clause — `%`, `_`, and `\` are special there. */
function escapeLikeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** The marker that precedes the embedded JSON in a Codex `feedback_log_body` websocket-event row. */
const WEBSOCKET_EVENT_MARKER = 'websocket event: ';

/**
 * Extract the embedded JSON object from a Codex log body — DEFENSIVE. Real `feedback_log_body` rows are
 * NOT pure JSON: they carry an OpenTelemetry span-context prefix, then `websocket event: {…JSON…}`. When
 * the marker is present this scans from the first `{` AFTER it; otherwise it scans from the first `{` in
 * the text. Either way it returns the balanced top-level object so trailing noise is dropped too. Text
 * with no `{` is returned unchanged (a pure-JSON body flows straight through {@link tryParseJson}).
 */
function extractEmbeddedJson(text: string): string {
  const markerAt = text.indexOf(WEBSOCKET_EVENT_MARKER);
  const searchFrom = markerAt >= 0 ? markerAt + WEBSOCKET_EVENT_MARKER.length : 0;
  const start = text.indexOf('{', searchFrom);
  if (start < 0) return text;
  const end = matchBalancedObjectEnd(text, start);
  return end >= 0 ? text.slice(start, end + 1) : text.slice(start);
}

/**
 * Index of the `}` closing the top-level `{` at `start`, honoring JSON string literals (a brace inside a
 * quoted value does not skew the depth count). Returns -1 when the object never closes (a truncated body).
 */
function matchBalancedObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

/** Parse JSON, returning undefined instead of throwing on malformed text. */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Default session fallback: tail the newest rollout jsonl files for a `rate_limits` line. */
async function realReadSessionRollout(): Promise<unknown> {
  return readLatestRolloutRateLimits(defaultCodexSessionsDir());
}

/**
 * Tail the newest `rollout-*.jsonl` session files under `dir` for the most recent line carrying a
 * `token_count.rate_limits` payload — DEFENSIVE. Scans the newest few files, each from the end, and
 * returns the first line that parses into a rate-limits structure. Returns undefined when the dir is
 * absent / empty / has no such line (the caller falls through, then fails loud).
 */
export async function readLatestRolloutRateLimits(
  dir: string,
  opts: { readonly maxFiles?: number } = {},
): Promise<unknown | undefined> {
  const files = await collectRolloutFiles(dir);
  for (const file of files.slice(0, opts.maxFiles ?? 5)) {
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line || !/rate_limit|used_percent/i.test(line)) continue;
      const parsed = tryParseJson(extractEmbeddedJson(line));
      if (parsed !== undefined && isTrustedRolloutRateLimits(parsed)) return parsed;
    }
  }
  return undefined;
}

function isTrustedRolloutRateLimits(payload: unknown): boolean {
  const root = asRecord(payload);
  if (!root) return false;
  const type = stringish(root.type);
  if (type !== 'token_count' && type !== 'codex.rate_limits') return false;
  return findRateLimitsBody(root) !== undefined;
}

/** Recursively collect `rollout-*.jsonl` files under `dir`, newest mtime first. Tolerates a missing dir. */
async function collectRolloutFiles(dir: string): Promise<string[]> {
  const found: Array<{ path: string; mtimeMs: number }> = [];
  async function walk(current: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        try {
          const info = await stat(full);
          found.push({ path: full, mtimeMs: info.mtimeMs });
        } catch {
          // unreadable entry — skip.
        }
      }
    }
  }
  await walk(dir);
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.map((f) => f.path);
}
