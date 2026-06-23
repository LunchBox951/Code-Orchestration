import type { DatabaseSync } from 'node:sqlite';
import type { Projector } from '../replay/projector.js';
import type { StoredEvent, StoreTx } from '../store/types.js';
import {
  EVENT_USAGE_OBSERVED,
  usageScope,
  type UsageAccountStatus,
  type UsageBucket,
  type UsageObserved,
} from './events.js';
import { ACCOUNT_STATUS_SEED_SOURCE } from './provider-account.js';
import type { Provider } from './usage-source.js';

/**
 * The L4 usage read-model — two tables, both keyed by provider account, every column log-derived so a
 * `rebuildAll` reproduces them byte-identical (AC5, freeze #6):
 *
 *   - `usage_buckets`  — one row per `(provider, account, window_kind)`: the LATEST known window observation
 *                        (used_pct + reset_at + source + sampled_at). Last fold wins (passive samples
 *                        supersede); replay folds the log in seq order, so it reaches the same row.
 *   - `usage_accounts` — one row per `(provider, account)`: the LATEST availability status.
 *                        `available = 0` (with a reason) is what makes the whole account's headroom read `unknown` (AC6),
 *                        shadowing any stale bucket row. An available sample marks it `available = 1`.
 *
 * `ts` columns persist the event ts (freeze #6 — never wall-clock on read). The two tables are folded
 * together from the single `usage.observed` event so an available sample updates BOTH its window bucket
 * and the account status in one apply.
 */
const CREATE_USAGE_TABLES = `
  CREATE TABLE IF NOT EXISTS usage_buckets (
    provider    TEXT NOT NULL,
    account     TEXT NOT NULL,
    window_kind TEXT NOT NULL,
    used_pct    REAL NOT NULL,
    reset_at    TEXT NOT NULL,
    source      TEXT NOT NULL,
    sampled_at  TEXT NOT NULL,
    ts          INTEGER NOT NULL,
    PRIMARY KEY (provider, account, window_kind)
  );
  CREATE TABLE IF NOT EXISTS usage_accounts (
    provider   TEXT NOT NULL,
    account    TEXT NOT NULL,
    available  INTEGER NOT NULL,
    reason     TEXT,
    source     TEXT NOT NULL,
    sampled_at TEXT NOT NULL,
    ts         INTEGER NOT NULL,
    PRIMARY KEY (provider, account)
  );
`;

/**
 * Defensive create of the usage read-model tables. Called from the projector's reset/apply AND every
 * read path, so a freshly opened store can be queried before any write has happened.
 */
export function ensureUsageTables(db: DatabaseSync): void {
  repairDerivedUsageSchema(db);
  db.exec(CREATE_USAGE_TABLES);
}

function resetUsageTables(db: DatabaseSync): void {
  db.exec(`
    DROP TABLE IF EXISTS usage_buckets;
    DROP TABLE IF EXISTS usage_accounts;
    DROP TABLE IF EXISTS usage_buckets_legacy;
    DROP TABLE IF EXISTS usage_accounts_legacy;
  `);
  db.exec(CREATE_USAGE_TABLES);
}

function repairDerivedUsageSchema(db: DatabaseSync): void {
  if (
    tableExists(db, 'usage_buckets') &&
    !hasPrimaryKey(db, 'usage_buckets', ['provider', 'account', 'window_kind'])
  ) {
    migrateLegacyUsageBuckets(db);
  }
  if (
    tableExists(db, 'usage_accounts') &&
    !hasPrimaryKey(db, 'usage_accounts', ['provider', 'account'])
  ) {
    migrateLegacyUsageAccounts(db);
  }
}

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return row !== undefined;
}

function hasPrimaryKey(db: DatabaseSync, table: string, expected: readonly string[]): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    readonly name: string;
    readonly pk: number;
  }>;
  const actual = rows
    .filter((row) => row.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((row) => row.name);
  return actual.length === expected.length && actual.every((name, i) => name === expected[i]);
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ readonly name: string }>;
  return rows.some((row) => row.name === column);
}

function migrateLegacyUsageBuckets(db: DatabaseSync): void {
  const canCopy = hasColumn(db, 'usage_buckets', 'provider');
  if (!canCopy) assertProviderlessLegacyAccountsAreInferable(db, 'usage_buckets');
  db.exec('ALTER TABLE usage_buckets RENAME TO usage_buckets_legacy');
  db.exec(CREATE_USAGE_TABLES);
  if (canCopy) {
    db.exec(`
      INSERT OR REPLACE INTO usage_buckets
        (provider, account, window_kind, used_pct, reset_at, source, sampled_at, ts)
      SELECT provider, account, window_kind, used_pct, reset_at, source, sampled_at, ts
      FROM usage_buckets_legacy
    `);
  } else {
    db.exec(`
      INSERT OR REPLACE INTO usage_buckets
        (provider, account, window_kind, used_pct, reset_at, source, sampled_at, ts)
      SELECT ${inferredProviderSql('account')}, account, window_kind, used_pct, reset_at, source, sampled_at, ts
      FROM usage_buckets_legacy
    `);
  }
  db.exec('DROP TABLE usage_buckets_legacy');
}

function migrateLegacyUsageAccounts(db: DatabaseSync): void {
  const canCopy = hasColumn(db, 'usage_accounts', 'provider');
  if (!canCopy) assertProviderlessLegacyAccountsAreInferable(db, 'usage_accounts');
  db.exec('ALTER TABLE usage_accounts RENAME TO usage_accounts_legacy');
  db.exec(CREATE_USAGE_TABLES);
  if (canCopy) {
    db.exec(`
      INSERT OR REPLACE INTO usage_accounts
        (provider, account, available, reason, source, sampled_at, ts)
      SELECT provider, account, available, reason, source, sampled_at, ts
      FROM usage_accounts_legacy
    `);
  } else {
    db.exec(`
      INSERT OR REPLACE INTO usage_accounts
        (provider, account, available, reason, source, sampled_at, ts)
      SELECT ${inferredProviderSql('account')}, account, available, reason, source, sampled_at, ts
      FROM usage_accounts_legacy
    `);
  }
  db.exec('DROP TABLE usage_accounts_legacy');
}

function assertProviderlessLegacyAccountsAreInferable(db: DatabaseSync, table: string): void {
  const rows = db.prepare(`SELECT DISTINCT account FROM ${table}`).all() as Array<{
    readonly account: unknown;
  }>;
  const bad = rows
    .map((row) => String(row.account))
    .find((account) => inferredProvider(account) === undefined);
  if (bad !== undefined) {
    throw new Error(
      `usage-projector: legacy ${table} row for account '${bad}' has no provider column and cannot be safely migrated; run rebuildAll from the event log`,
    );
  }
}

function inferredProvider(account: string): Provider | undefined {
  const provider = account.slice(0, account.indexOf(':'));
  return provider === 'claude' || provider === 'codex' ? provider : undefined;
}

function inferredProviderSql(column: string): string {
  return `CASE substr(${column}, 1, instr(${column}, ':') - 1) WHEN 'claude' THEN 'claude' WHEN 'codex' THEN 'codex' END`;
}

/** Map a raw `usage_buckets` row (loosely typed at the SQLite boundary) to a {@link UsageBucket}. */
export function rowToUsageBucket(row: Record<string, unknown>): UsageBucket {
  return {
    provider: String(row.provider) as Provider,
    account: String(row.account),
    windowKind: String(row.window_kind),
    usedPct: Number(row.used_pct),
    resetAt: String(row.reset_at),
    source: String(row.source),
    sampledAt: String(row.sampled_at),
  };
}

/** Map a raw `usage_accounts` row to a {@link UsageAccountStatus} (the `reason` column is nullable). */
export function rowToUsageAccountStatus(row: Record<string, unknown>): UsageAccountStatus {
  const reason = row.reason != null ? String(row.reason) : undefined;
  return {
    provider: String(row.provider) as Provider,
    account: String(row.account),
    available: Number(row.available) === 1,
    ...(reason !== undefined ? { reason } : {}),
    source: String(row.source),
    sampledAt: String(row.sampled_at),
    observedTs: Number(row.ts),
  };
}

const BUCKET_COLUMNS = 'provider, account, window_kind, used_pct, reset_at, source, sampled_at, ts';
const ACCOUNT_COLUMNS = 'provider, account, available, reason, source, sampled_at, ts';

/** The latest known window bucket for `(provider, account, window_kind)`, or undefined. */
export function selectUsageBucket(
  db: DatabaseSync,
  provider: Provider,
  account: string,
  windowKind: string,
): UsageBucket | undefined {
  ensureUsageTables(db);
  const row = db
    .prepare(
      `SELECT ${BUCKET_COLUMNS} FROM usage_buckets WHERE provider = ? AND account = ? AND window_kind = ?`,
    )
    .get(provider, account, windowKind);
  return row ? rowToUsageBucket(row as Record<string, unknown>) : undefined;
}

/** Every known window bucket, in `(provider, account, window_kind)` order. */
export function selectAllUsageBuckets(db: DatabaseSync): UsageBucket[] {
  ensureUsageTables(db);
  const rows = db
    .prepare(`SELECT ${BUCKET_COLUMNS} FROM usage_buckets ORDER BY provider, account, window_kind`)
    .all();
  return rows.map((r) => rowToUsageBucket(r as Record<string, unknown>));
}

/** The latest availability status for `account`, or undefined (no sample yet). */
export function selectUsageAccount(
  db: DatabaseSync,
  provider: Provider,
  account: string,
): UsageAccountStatus | undefined {
  ensureUsageTables(db);
  const row = db
    .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM usage_accounts WHERE provider = ? AND account = ?`)
    .get(provider, account);
  return row ? rowToUsageAccountStatus(row as Record<string, unknown>) : undefined;
}

/** Every provider-account status, in `(provider, account)` order. */
export function selectAllUsageAccounts(db: DatabaseSync): UsageAccountStatus[] {
  ensureUsageTables(db);
  const rows = db
    .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM usage_accounts ORDER BY provider, account`)
    .all();
  return rows.map((r) => rowToUsageAccountStatus(r as Record<string, unknown>));
}

/**
 * Folds `usage.observed` into the usage read-model, in the SAME tx as the append (log + projection
 * commit atomically). The payload is a discriminated union on `available`: an AVAILABLE sample upserts
 * the window bucket AND marks the account available; an UNAVAILABLE sample marks the account
 * `available = 0` with its reason (the bucket is left untouched — it is shadowed, never overwritten
 * with a fake 0%). Carries NO wall-clock field (freeze #6 — it persists `event.ts`).
 */
export class UsageProjector implements Projector {
  readonly name = 'usage';

  handles(type: string): boolean {
    return type === EVENT_USAGE_OBSERVED;
  }

  reset(tx: StoreTx): void {
    const db = tx.raw as DatabaseSync;
    resetUsageTables(db);
  }

  apply(tx: StoreTx, event: StoredEvent): void {
    const db = tx.raw as DatabaseSync;
    ensureUsageTables(db);
    const payload = event.payload as UsageObserved;
    validateUsageEnvelope(event, payload);

    if (payload.available) {
      // A reachable account always marks itself available; the window bucket is upserted only when the
      // sample carried full window data (all-or-none — see makeUsageObservedEvent). A windowless
      // available sample marks availability with NO bucket, so headroom reads `unknown` (nothing
      // observed for the window), never a fabricated 0%.
      if (
        payload.window_kind !== undefined &&
        payload.used_pct !== undefined &&
        payload.reset_at !== undefined
      ) {
        db.prepare(
          `INSERT INTO usage_buckets
             (provider, account, window_kind, used_pct, reset_at, source, sampled_at, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(provider, account, window_kind) DO UPDATE SET
             used_pct = excluded.used_pct,
             reset_at = excluded.reset_at,
             source = excluded.source,
             sampled_at = excluded.sampled_at,
             ts = excluded.ts`,
        ).run(
          payload.provider,
          payload.account,
          payload.window_kind,
          payload.used_pct,
          payload.reset_at,
          payload.source,
          payload.sampled_at,
          event.ts,
        );
      } else {
        db.prepare('DELETE FROM usage_buckets WHERE provider = ? AND account = ?').run(
          payload.provider,
          payload.account,
        );
      }
      upsertAccount(
        db,
        payload.provider,
        payload.account,
        1,
        null,
        payload.source,
        payload.sampled_at,
        event.ts,
      );
      removeSeedAccountsForProvider(db, payload.provider, payload.account, payload.source);
      return;
    }

    // Unavailable: mark the account headroom unknown (AC6) — reason carried, bucket left shadowed.
    upsertAccount(
      db,
      payload.provider,
      payload.account,
      0,
      payload.reason,
      payload.source,
      payload.sampled_at,
      event.ts,
    );
    removeSeedAccountsForProvider(db, payload.provider, payload.account, payload.source);
  }
}

function validateUsageEnvelope(event: StoredEvent, payload: UsageObserved): void {
  const expected = usageScope(payload.provider, payload.account);
  const legacy = usageScope(payload.account);
  if (event.scope === expected) return;
  if (event.scope === legacy) {
    const provider = inferredProvider(payload.account);
    if (provider !== undefined && provider !== payload.provider) {
      throw new Error(
        `usage-projector: legacy usage scope '${event.scope}' conflicts with payload provider '${payload.provider}'`,
      );
    }
    return;
  }
  if (event.scope !== expected) {
    throw new Error(
      `usage-projector: usage scope '${event.scope}' does not match payload identity '${expected}'`,
    );
  }
}

/** Upsert one `usage_accounts` row (latest status wins). Shared by the available / unavailable paths. */
function upsertAccount(
  db: DatabaseSync,
  provider: string,
  account: string,
  available: 0 | 1,
  reason: string | null,
  source: string,
  sampledAt: string,
  ts: number,
): void {
  db.prepare(
    `INSERT INTO usage_accounts (provider, account, available, reason, source, sampled_at, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, account) DO UPDATE SET
       available = excluded.available,
       reason = excluded.reason,
       source = excluded.source,
       sampled_at = excluded.sampled_at,
       ts = excluded.ts`,
  ).run(provider, account, available, reason, source, sampledAt, ts);
}

function removeSeedAccountsForProvider(
  db: DatabaseSync,
  provider: Provider,
  observedAccount: string,
  source: string,
): void {
  if (source === ACCOUNT_STATUS_SEED_SOURCE) return;
  db.prepare('DELETE FROM usage_accounts WHERE provider = ? AND account <> ? AND source = ?').run(
    provider,
    observedAccount,
    ACCOUNT_STATUS_SEED_SOURCE,
  );
}
