import type { DatabaseSync } from 'node:sqlite';
import type { Projector } from '../replay/projector.js';
import type { StoredEvent, StoreTx } from '../store/types.js';
import {
  EVENT_USAGE_OBSERVED,
  type UsageAccountStatus,
  type UsageBucket,
  type UsageObserved,
} from './events.js';
import type { Provider } from './usage-source.js';

/**
 * The L4 usage read-model — two tables, both keyed by account, every column log-derived so a
 * `rebuildAll` reproduces them byte-identical (AC5, freeze #6):
 *
 *   - `usage_buckets`  — one row per `(account, window_kind)`: the LATEST known window observation
 *                        (used_pct + reset_at + source + sampled_at). Last fold wins (passive samples
 *                        supersede); replay folds the log in seq order, so it reaches the same row.
 *   - `usage_accounts` — one row per account: the LATEST availability status. `available = 0` (with a
 *                        reason) is what makes the whole account's headroom read `unknown` (AC6),
 *                        shadowing any stale bucket row. An available sample marks it `available = 1`.
 *
 * `ts` columns persist the event ts (freeze #6 — never wall-clock on read). The two tables are folded
 * together from the single `usage.observed` event so an available sample updates BOTH its window bucket
 * and the account status in one apply.
 */
const CREATE_USAGE_TABLES = `
  CREATE TABLE IF NOT EXISTS usage_buckets (
    account     TEXT NOT NULL,
    window_kind TEXT NOT NULL,
    provider    TEXT NOT NULL,
    used_pct    REAL NOT NULL,
    reset_at    TEXT NOT NULL,
    source      TEXT NOT NULL,
    sampled_at  TEXT NOT NULL,
    ts          INTEGER NOT NULL,
    PRIMARY KEY (account, window_kind)
  );
  CREATE TABLE IF NOT EXISTS usage_accounts (
    account    TEXT PRIMARY KEY,
    provider   TEXT NOT NULL,
    available  INTEGER NOT NULL,
    reason     TEXT,
    source     TEXT NOT NULL,
    sampled_at TEXT NOT NULL,
    ts         INTEGER NOT NULL
  );
`;

/**
 * Defensive create of the usage read-model tables. Called from the projector's reset/apply AND every
 * read path, so a freshly opened store can be queried before any write has happened.
 */
export function ensureUsageTables(db: DatabaseSync): void {
  db.exec(CREATE_USAGE_TABLES);
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

const BUCKET_COLUMNS = 'account, window_kind, provider, used_pct, reset_at, source, sampled_at, ts';
const ACCOUNT_COLUMNS = 'account, provider, available, reason, source, sampled_at, ts';

/** The latest known window bucket for `(account, window_kind)`, or undefined. */
export function selectUsageBucket(
  db: DatabaseSync,
  account: string,
  windowKind: string,
): UsageBucket | undefined {
  ensureUsageTables(db);
  const row = db
    .prepare(`SELECT ${BUCKET_COLUMNS} FROM usage_buckets WHERE account = ? AND window_kind = ?`)
    .get(account, windowKind);
  return row ? rowToUsageBucket(row as Record<string, unknown>) : undefined;
}

/** Every known window bucket, in a deterministic order (account, then window_kind). */
export function selectAllUsageBuckets(db: DatabaseSync): UsageBucket[] {
  ensureUsageTables(db);
  const rows = db
    .prepare(`SELECT ${BUCKET_COLUMNS} FROM usage_buckets ORDER BY account, window_kind`)
    .all();
  return rows.map((r) => rowToUsageBucket(r as Record<string, unknown>));
}

/** The latest availability status for `account`, or undefined (no sample yet). */
export function selectUsageAccount(
  db: DatabaseSync,
  account: string,
): UsageAccountStatus | undefined {
  ensureUsageTables(db);
  const row = db
    .prepare(`SELECT ${ACCOUNT_COLUMNS} FROM usage_accounts WHERE account = ?`)
    .get(account);
  return row ? rowToUsageAccountStatus(row as Record<string, unknown>) : undefined;
}

/** Every account status, in account order (deterministic). */
export function selectAllUsageAccounts(db: DatabaseSync): UsageAccountStatus[] {
  ensureUsageTables(db);
  const rows = db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM usage_accounts ORDER BY account`).all();
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
    ensureUsageTables(db);
    db.exec('DELETE FROM usage_buckets');
    db.exec('DELETE FROM usage_accounts');
  }

  apply(tx: StoreTx, event: StoredEvent): void {
    const db = tx.raw as DatabaseSync;
    ensureUsageTables(db);
    const payload = event.payload as UsageObserved;

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
             (account, window_kind, provider, used_pct, reset_at, source, sampled_at, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(account, window_kind) DO UPDATE SET
             provider = excluded.provider,
             used_pct = excluded.used_pct,
             reset_at = excluded.reset_at,
             source = excluded.source,
             sampled_at = excluded.sampled_at,
             ts = excluded.ts`,
        ).run(
          payload.account,
          payload.window_kind,
          payload.provider,
          payload.used_pct,
          payload.reset_at,
          payload.source,
          payload.sampled_at,
          event.ts,
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
    `INSERT INTO usage_accounts (account, provider, available, reason, source, sampled_at, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account) DO UPDATE SET
       provider = excluded.provider,
       available = excluded.available,
       reason = excluded.reason,
       source = excluded.source,
       sampled_at = excluded.sampled_at,
       ts = excluded.ts`,
  ).run(account, provider, available, reason, source, sampledAt, ts);
}
