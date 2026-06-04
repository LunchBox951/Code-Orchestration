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
}

/** What a rate-limits parse yields: the account (if named), availability, and the parsed windows. */
export interface CodexRateLimitsReading {
  readonly account?: string;
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
  /** Account label; default {@link CODEX_DEFAULT_ACCOUNT}. The preflight refines it when it names a plan. */
  readonly account?: string;
}

/**
 * Parse a `codex doctor --json` payload into {@link CodexAccountInfo} — DEFENSIVE: healthy unless the
 * payload clearly says otherwise (an explicit `authenticated: false`, or a `status`/`health` reading that
 * reads as failed). Account label is derived from a `plan` when present, else {@link CODEX_DEFAULT_ACCOUNT}.
 */
export function parseCodexDoctor(payload: unknown): CodexAccountInfo {
  const root = asRecord(payload) ?? {};
  const plan = stringish(pick(root, 'plan', 'subscription', 'tier'));
  const account = plan ? `codex:${plan.toLowerCase()}` : CODEX_DEFAULT_ACCOUNT;

  const authed = boolish(pick(root, 'authenticated', 'logged_in', 'loggedIn', 'signed_in'));
  const status = stringish(pick(root, 'status', 'health', 'state'));
  const statusBad = status ? /fail|error|unhealthy|down|logged.?out|expired/i.test(status) : false;
  return { healthy: !(authed === false || statusBad), account };
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
  const body = findRateLimitsBody(root) ?? root;

  const plan =
    stringish(pick(body, 'plan', 'plan_type')) ?? stringish(pick(root, 'plan', 'plan_type'));
  const account = plan ? `codex:${plan.toLowerCase()}` : undefined;
  const allowed = boolish(pick(body, 'allowed', 'is_allowed')) ?? boolish(pick(root, 'allowed'));

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

  const reading: CodexRateLimitsReading = { available: allowed !== false, windows };
  return account !== undefined ? { ...reading, account } : reading;
}

/** Resolve a window's ISO reset: `reset_at` (verified) first, else relative `resets_in_seconds` + sample time. */
function resolveResetAt(window: Record<string, unknown>, sampledMs: number): string | undefined {
  const explicit = stringish(pick(window, 'reset_at', 'resets_at', 'resetAt', 'resetsAt'));
  if (explicit !== undefined) return explicit;
  const relSeconds = numberish(pick(window, 'resets_in_seconds', 'reset_in_seconds', 'resets_in'));
  if (relSeconds !== undefined && Number.isFinite(sampledMs)) {
    return new Date(sampledMs + relSeconds * 1000).toISOString();
  }
  return undefined;
}

/**
 * Locate the object that holds the `primary`/`secondary` rate-limit windows inside an arbitrary Codex
 * event envelope — DEFENSIVE. Returns the record carrying the windows directly, the one under a
 * `rate_limits` child, or one found by a shallow DFS (so a `token_count` wrapper or a logged event row
 * still resolves). Undefined when no such object exists.
 */
function findRateLimitsBody(value: unknown, depth = 0): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (asRecord(record.primary) || asRecord(record.secondary)) return record;
  const nested = asRecord(pick(record, 'rate_limits', 'rateLimits'));
  if (nested && (asRecord(nested.primary) || asRecord(nested.secondary))) return nested;
  if (depth >= 4) return undefined;
  for (const child of Object.values(record)) {
    const found = findRateLimitsBody(child, depth + 1);
    if (found) return found;
  }
  return undefined;
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
    let preflight: UsageSnapshot | null = null;
    try {
      const info = await this.deps.doctor();
      account = info.account || account;
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
      run: () => this.readReadout(this.deps.readRateLimits(), account, sampledAt, 'sqlite'),
    });
    if (this.deps.appServerRead) {
      const appServerRead = this.deps.appServerRead;
      attempts.push({
        label: 'app-server account/rateLimits/read (active)',
        run: () => this.readReadout(appServerRead(), account, sampledAt, 'app-server'),
      });
    }
    if (this.deps.sessionRollout) {
      const sessionRollout = this.deps.sessionRollout;
      attempts.push({
        label: 'session rollout jsonl (fallback)',
        run: () => this.readReadout(sessionRollout(), account, sampledAt, 'session-jsonl'),
      });
    }
    return layeredRead('codex', account, attempts);
  }

  /** Parse a rate-limits payload into a snapshot; null when it carried no windows (fall to next source). */
  private async readReadout(
    payloadPromise: Promise<unknown>,
    account: string,
    sampledAt: string,
    source: string,
  ): Promise<UsageSnapshot | null> {
    const reading = parseCodexRateLimits(await payloadPromise, sampledAt);
    const resolvedAccount = reading.account ?? account;
    if (!reading.available) {
      return buildSnapshot({
        provider: 'codex',
        account: resolvedAccount,
        windows: [],
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
 * Scan a Codex log database (read-only) for the LATEST `codex.rate_limits` payload — DEFENSIVE over an
 * unknown-but-host-validated schema (spec §Fixtures). It walks every table's text-ish columns newest-row
 * first, and returns the first JSON value that parses into a rate-limits structure (a `primary`/
 * `secondary` window set, possibly wrapped). Bounded by `scanLimit` rows per column. Returns undefined
 * when no rate-limits payload is found. The exact table/column the host uses is validated by the
 * host-side live run; any delta is a small follow-up.
 */
export function readLatestCodexRateLimits(
  db: DatabaseSync,
  opts: { readonly scanLimit?: number } = {},
): unknown | undefined {
  const scanLimit = opts.scanLimit ?? 500;
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<
    Record<string, unknown>
  >;

  for (const table of tables) {
    const tableName = stringish(table.name);
    if (!tableName) continue;
    const columns = db.prepare(`PRAGMA table_info(${quoteIdent(tableName)})`).all() as Array<
      Record<string, unknown>
    >;
    const textColumns = columns
      .map((c) => ({ name: stringish(c.name), type: String(c.type ?? '') }))
      .filter((c) => c.name && /text|char|clob|json|blob|^$/i.test(c.type));

    for (const column of textColumns) {
      let rows: Array<Record<string, unknown>>;
      try {
        rows = db
          .prepare(
            `SELECT ${quoteIdent(column.name as string)} AS value FROM ${quoteIdent(tableName)} ` +
              `ORDER BY rowid DESC LIMIT ${scanLimit}`,
          )
          .all() as Array<Record<string, unknown>>;
      } catch {
        continue; // a column that cannot be ordered/selected is skipped.
      }
      for (const row of rows) {
        const text = row.value;
        if (typeof text !== 'string') continue;
        if (!/rate_limit|used_percent/i.test(text)) continue;
        const parsed = tryParseJson(text);
        if (parsed !== undefined && findRateLimitsBody(parsed)) return parsed;
      }
    }
  }
  return undefined;
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
      const parsed = tryParseJson(line);
      if (parsed !== undefined && findRateLimitsBody(parsed)) return parsed;
    }
  }
  return undefined;
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
