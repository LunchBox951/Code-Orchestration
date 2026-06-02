// The warning shim MUST be installed before `node:sqlite` is loaded.
import './suppress-sqlite-warning.js';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataRoot, projectDataDir } from './paths.js';
import type { NewEvent, Store, StoredEvent, StoreTx } from './types.js';

/** Bump when the on-disk schema changes; `migrate()` switches on it. */
const SCHEMA_VERSION = 1;

/** Coerce a raw `events` row (loosely-typed at the SQLite boundary) to StoredEvent. */
function toStoredEvent(row: Record<string, unknown>): StoredEvent {
  return {
    seq: Number(row.seq),
    ts: Number(row.ts),
    projectId: String(row.project_id),
    scope: String(row.scope),
    type: String(row.type),
    v: Number(row.v),
    payload: JSON.parse(String(row.payload)),
    ...(row.actor != null ? { actor: String(row.actor) } : {}),
    ...(row.causation_id != null ? { causationId: String(row.causation_id) } : {}),
    ...(row.correlation_id != null ? { correlationId: String(row.correlation_id) } : {}),
    ...(row.idempotency_key != null ? { idempotencyKey: String(row.idempotency_key) } : {}),
  };
}

/**
 * Narrow synchronous event store over `node:sqlite` (`DatabaseSync`). Holds the
 * append-only `events` log: a single store-wide AUTOINCREMENT `seq` gives a
 * global total order, and `ts` (epoch ms) is assigned once at append time and
 * persisted — wall-clock is read ONLY here, never on read/replay, which is what
 * keeps replay deterministic (freeze #6).
 */
class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  private readonly insertStmt: StatementSync;
  private readonly readStreamStmt: StatementSync;
  private readonly readAllStmt: StatementSync;
  private readonly headStmt: StatementSync;
  private inTransaction = false;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();

    this.insertStmt = this.db.prepare(
      `INSERT INTO events (ts, project_id, scope, type, v, payload, actor, causation_id, correlation_id, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING seq, ts`,
    );
    this.readStreamStmt = this.db.prepare(
      `SELECT seq, ts, project_id, scope, type, v, payload, actor, causation_id, correlation_id, idempotency_key
       FROM events
       WHERE scope = ? AND seq > ?
       ORDER BY seq ASC
       LIMIT ?`,
    );
    this.readAllStmt = this.db.prepare(
      `SELECT seq, ts, project_id, scope, type, v, payload, actor, causation_id, correlation_id, idempotency_key
       FROM events
       WHERE seq > ?
       ORDER BY seq ASC
       LIMIT ?`,
    );
    this.headStmt = this.db.prepare('SELECT MAX(seq) AS head FROM events');
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get();
    const current = Number(row?.user_version ?? 0);
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `database is from a newer co (user_version=${current} > supported=${SCHEMA_VERSION}); refusing to open`,
      );
    }
    if (current < SCHEMA_VERSION) {
      // actor / causation_id / correlation_id / idempotency_key are reserved
      // event-envelope fields (Part B §3 D2): declared here; surfaced through the
      // StoredEvent/NewEvent API from L1 (Stage 2). Nullable with no default;
      // NULL persists as an omitted key in the TypeScript read shape.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          seq             INTEGER PRIMARY KEY AUTOINCREMENT,
          ts              INTEGER NOT NULL,
          project_id      TEXT NOT NULL,
          scope           TEXT NOT NULL,
          type            TEXT NOT NULL,
          v               INTEGER NOT NULL,
          payload         TEXT NOT NULL,
          actor           TEXT,
          causation_id    TEXT,
          correlation_id  TEXT,
          idempotency_key TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_events_scope_seq ON events (scope, seq);
      `);
      // PRAGMA values cannot be bound with '?'; SCHEMA_VERSION is a trusted constant.
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
  }

  append(events: readonly NewEvent[]): readonly StoredEvent[] {
    return this.transaction((tx) => tx.append(events));
  }

  transaction<R>(fn: (tx: StoreTx) => R): R {
    if (this.inTransaction) {
      // node:sqlite (like SQLite) has no nested transactions; fail loudly rather
      // than emit a cryptic "cannot start a transaction within a transaction".
      throw new Error('Store.transaction: nested transactions are not supported');
    }
    this.inTransaction = true;
    this.db.exec('BEGIN');
    try {
      const tx: StoreTx = {
        append: (events) => this.insertEvents(events),
        raw: this.db,
      };
      const result = fn(tx);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  /** Insert within the current transaction; assigns + persists ts per event. */
  private insertEvents(events: readonly NewEvent[]): readonly StoredEvent[] {
    const stored: StoredEvent[] = [];
    for (const event of events) {
      const ts = Date.now();
      const row = this.insertStmt.get(
        ts,
        event.projectId,
        event.scope,
        event.type,
        event.v,
        JSON.stringify(event.payload),
        event.actor ?? null,
        event.causationId ?? null,
        event.correlationId ?? null,
        event.idempotencyKey ?? null,
      );
      if (!row) {
        throw new Error('Store.append: INSERT ... RETURNING produced no row');
      }
      stored.push({
        seq: Number(row.seq),
        ts: Number(row.ts),
        projectId: event.projectId,
        scope: event.scope,
        type: event.type,
        v: event.v,
        // Round-trip so the returned shape equals what a later read yields.
        payload: JSON.parse(JSON.stringify(event.payload)),
        ...(event.actor != null ? { actor: event.actor } : {}),
        ...(event.causationId != null ? { causationId: event.causationId } : {}),
        ...(event.correlationId != null ? { correlationId: event.correlationId } : {}),
        ...(event.idempotencyKey != null ? { idempotencyKey: event.idempotencyKey } : {}),
      });
    }
    return stored;
  }

  readStream(scope: string, opts?: { afterSeq?: number; limit?: number }): readonly StoredEvent[] {
    const rows = this.readStreamStmt.all(scope, opts?.afterSeq ?? 0, opts?.limit ?? -1);
    return rows.map(toStoredEvent);
  }

  readAll(opts?: { afterSeq?: number; limit?: number }): readonly StoredEvent[] {
    const rows = this.readAllStmt.all(opts?.afterSeq ?? 0, opts?.limit ?? -1);
    return rows.map(toStoredEvent);
  }

  head(): number {
    const head = this.headStmt.get()?.head;
    return head == null ? 0 : Number(head);
  }

  close(): void {
    this.db.close();
  }
}

/** Open the per-project store at `${projectDataDir(projectId)}/store.db`. */
export function openProjectStore(projectId: string): Store {
  return new SqliteStore(join(projectDataDir(projectId), 'store.db'));
}

/** Open the global store at `${dataRoot()}/global.db` (projectId convention: '@global'). */
export function openGlobalStore(): Store {
  return new SqliteStore(join(dataRoot(), 'global.db'));
}
