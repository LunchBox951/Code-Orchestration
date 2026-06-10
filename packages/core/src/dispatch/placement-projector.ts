import type { DatabaseSync } from 'node:sqlite';
import { assertNever } from '../assert-never.js';
import type { Projector } from '../replay/projector.js';
import type { StoredEvent, StoreTx } from '../store/types.js';
import {
  EVENT_PLACEMENT_DECIDED,
  PLACEMENT_SCOPE_PREFIX,
  type PlacementDecided,
  type PlacementRecord,
} from './events.js';
import { accountForProvider } from './provider-source.js';
import type { Provider } from './usage-source.js';

const CREATE_PLACEMENT_TABLE = `
  CREATE TABLE IF NOT EXISTS placement_records (
    seq              INTEGER PRIMARY KEY,
    agent            TEXT NOT NULL,
    role             TEXT NOT NULL,
    work_size        TEXT NOT NULL,
    reasoning_budget TEXT NOT NULL,
    review_id        TEXT,
    review_target    TEXT,
    review_branch    TEXT,
    review_scope     TEXT,
    kind             TEXT NOT NULL,
    provider         TEXT,
    account          TEXT,
    model            TEXT,
    effort           TEXT,
    context          TEXT,
    eta_reset_at     TEXT,
    reason           TEXT,
    maxed_providers  TEXT,
    maxed_accounts   TEXT,
    unavailable_providers TEXT,
    unavailable_accounts TEXT,
    ts               INTEGER NOT NULL
  )
`;

export function ensurePlacementTable(db: DatabaseSync): void {
  db.exec(CREATE_PLACEMENT_TABLE);
  ensureColumn(db, 'placement_records', 'unavailable_providers', 'TEXT');
  ensureColumn(db, 'placement_records', 'maxed_accounts', 'TEXT');
  ensureColumn(db, 'placement_records', 'unavailable_accounts', 'TEXT');
  ensureColumn(db, 'placement_records', 'account', 'TEXT');
  ensureColumn(db, 'placement_records', 'review_id', 'TEXT');
  ensureColumn(db, 'placement_records', 'review_target', 'TEXT');
  ensureColumn(db, 'placement_records', 'review_branch', 'TEXT');
  ensureColumn(db, 'placement_records', 'review_scope', 'TEXT');
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ readonly name: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function rowToPlacementRecord(row: Record<string, unknown>): PlacementRecord {
  const kind = row['kind'] as string;
  if (kind !== 'placed' && kind !== 'waiting') {
    throw new Error(`placement-projector: unknown kind '${kind}'`);
  }
  const base = {
    seq: row['seq'] as number,
    agent: row['agent'] as string,
    role: row['role'] as string,
    workSize: row['work_size'] as string,
    reasoningBudget: row['reasoning_budget'] as string,
    reviewId: row['review_id'] != null ? (row['review_id'] as string) : undefined,
    reviewTarget: row['review_target'] != null ? (row['review_target'] as string) : undefined,
    reviewBranch: row['review_branch'] != null ? (row['review_branch'] as string) : undefined,
    reviewScope: row['review_scope'] != null ? (row['review_scope'] as string) : undefined,
    kind: kind as 'placed' | 'waiting',
    recordedTs: row['ts'] as number,
  };
  if (kind === 'placed') {
    const provider = row['provider'] as Provider;
    return {
      ...base,
      provider,
      account: row['account'] != null ? (row['account'] as string) : accountForProvider(provider),
      model: row['model'] as string,
      effort: row['effort'] as string,
      context: row['context'] as string,
    };
  }
  // waiting
  const maxedRaw = row['maxed_providers'];
  const maxedProviders: readonly string[] =
    typeof maxedRaw === 'string' && maxedRaw.length > 0 ? (JSON.parse(maxedRaw) as string[]) : [];
  const unavailableRaw = row['unavailable_providers'];
  const unavailableProviders: readonly string[] =
    typeof unavailableRaw === 'string' && unavailableRaw.length > 0
      ? (JSON.parse(unavailableRaw) as string[])
      : [];
  const maxedAccountsRaw = row['maxed_accounts'];
  const maxedAccounts: readonly string[] =
    typeof maxedAccountsRaw === 'string' && maxedAccountsRaw.length > 0
      ? (JSON.parse(maxedAccountsRaw) as string[])
      : [];
  const unavailableAccountsRaw = row['unavailable_accounts'];
  const unavailableAccounts: readonly string[] =
    typeof unavailableAccountsRaw === 'string' && unavailableAccountsRaw.length > 0
      ? (JSON.parse(unavailableAccountsRaw) as string[])
      : [];
  return {
    ...base,
    etaResetAt: row['eta_reset_at'] != null ? (row['eta_reset_at'] as string) : undefined,
    reason: row['reason'] as string,
    maxedProviders,
    maxedAccounts,
    unavailableProviders,
    unavailableAccounts,
  };
}

export function selectAllPlacements(db: DatabaseSync): readonly PlacementRecord[] {
  ensurePlacementTable(db);
  const rows = db.prepare('SELECT * FROM placement_records ORDER BY seq').all() as Record<
    string,
    unknown
  >[];
  return rows.map(rowToPlacementRecord);
}

export function selectPlacementsByAgent(
  db: DatabaseSync,
  agent: string,
): readonly PlacementRecord[] {
  ensurePlacementTable(db);
  const rows = db
    .prepare('SELECT * FROM placement_records WHERE agent = ? ORDER BY seq')
    .all(agent) as Record<string, unknown>[];
  return rows.map(rowToPlacementRecord);
}

export function selectPlacementBySeq(db: DatabaseSync, seq: number): PlacementRecord | undefined {
  ensurePlacementTable(db);
  const row = db.prepare('SELECT * FROM placement_records WHERE seq = ?').get(seq) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToPlacementRecord(row) : undefined;
}

/**
 * The placement read-model projector: folds `placement.decided` events into `placement_records`.
 * One row per event (keyed by `seq`), so a `rebuildAll` reproduces byte-identical rows (AC5, P14).
 */
export class PlacementProjector implements Projector {
  readonly name = 'placement';

  handles(eventType: string): boolean {
    return eventType === EVENT_PLACEMENT_DECIDED;
  }

  reset(tx: StoreTx): void {
    const db = tx.raw as DatabaseSync;
    ensurePlacementTable(db);
    db.exec('DELETE FROM placement_records');
  }

  apply(tx: StoreTx, event: StoredEvent): void {
    const db = tx.raw as DatabaseSync;
    ensurePlacementTable(db);
    const p = event.payload as PlacementDecided;
    const agent = agentFromPlacementEvent(event);
    if (p.kind === 'placed') {
      db.prepare(
        `INSERT OR REPLACE INTO placement_records
         (seq, agent, role, work_size, reasoning_budget, review_id, review_target, review_branch, review_scope, kind, provider, account, model, effort, context, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'placed', ?, ?, ?, ?, ?, ?)`,
      ).run(
        event.seq,
        agent,
        p.role,
        p.work_size,
        p.reasoning_budget,
        p.review_id ?? null,
        p.review_target ?? null,
        p.review_branch ?? null,
        p.review_scope ?? null,
        p.provider,
        p.account ?? accountForProvider(p.provider),
        p.model,
        p.effort,
        p.context,
        event.ts,
      );
    } else if (p.kind === 'waiting') {
      db.prepare(
        `INSERT OR REPLACE INTO placement_records
         (seq, agent, role, work_size, reasoning_budget, review_id, review_target, review_branch, review_scope, kind, eta_reset_at, reason, maxed_providers, maxed_accounts, unavailable_providers, unavailable_accounts, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        event.seq,
        agent,
        p.role,
        p.work_size,
        p.reasoning_budget,
        p.review_id ?? null,
        p.review_target ?? null,
        p.review_branch ?? null,
        p.review_scope ?? null,
        p.eta_reset_at ?? null,
        p.reason,
        JSON.stringify(p.maxed_providers),
        JSON.stringify(p.maxed_accounts),
        JSON.stringify(p.unavailable_providers),
        JSON.stringify(p.unavailable_accounts),
        event.ts,
      );
    } else {
      assertNever(p);
    }
  }
}

function agentFromPlacementEvent(event: StoredEvent): string {
  if (!event.scope.startsWith(PLACEMENT_SCOPE_PREFIX)) {
    throw new Error(
      `placement-projector: expected scope '${PLACEMENT_SCOPE_PREFIX}<agent>', got '${event.scope}'`,
    );
  }
  const agent = event.scope.slice(PLACEMENT_SCOPE_PREFIX.length);
  if (agent.length === 0) {
    throw new Error('placement-projector: placement scope is missing agent id');
  }
  if (event.actor !== undefined && event.actor !== agent) {
    throw new Error(
      `placement-projector: actor '${event.actor}' does not match placement scope agent '${agent}'`,
    );
  }
  return agent;
}
