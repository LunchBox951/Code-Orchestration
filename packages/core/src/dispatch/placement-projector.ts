import type { DatabaseSync } from 'node:sqlite';
import { assertNever } from '../assert-never.js';
import type { Projector } from '../replay/projector.js';
import type { StoredEvent, StoreTx } from '../store/types.js';
import {
  EVENT_PLACEMENT_DECIDED,
  type PlacementDecided,
  type PlacementRecord,
} from './events.js';

const CREATE_PLACEMENT_TABLE = `
  CREATE TABLE IF NOT EXISTS placement_records (
    seq              INTEGER PRIMARY KEY,
    agent            TEXT NOT NULL,
    role             TEXT NOT NULL,
    work_size        TEXT NOT NULL,
    reasoning_budget TEXT NOT NULL,
    kind             TEXT NOT NULL,
    provider         TEXT,
    model            TEXT,
    effort           TEXT,
    context          TEXT,
    eta_reset_at     TEXT,
    reason           TEXT,
    maxed_providers  TEXT,
    ts               INTEGER NOT NULL
  )
`;

export function ensurePlacementTable(db: DatabaseSync): void {
  db.exec(CREATE_PLACEMENT_TABLE);
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
    kind: kind as 'placed' | 'waiting',
    recordedTs: row['ts'] as number,
  };
  if (kind === 'placed') {
    return {
      ...base,
      provider: row['provider'] as string,
      model: row['model'] as string,
      effort: row['effort'] as string,
      context: row['context'] as string,
    };
  }
  // waiting
  const maxedRaw = row['maxed_providers'];
  const maxedProviders: readonly string[] =
    typeof maxedRaw === 'string' && maxedRaw.length > 0
      ? (JSON.parse(maxedRaw) as string[])
      : [];
  return {
    ...base,
    etaResetAt:
      row['eta_reset_at'] != null ? (row['eta_reset_at'] as string) : undefined,
    reason: row['reason'] as string,
    maxedProviders,
  };
}

export function selectAllPlacements(db: DatabaseSync): readonly PlacementRecord[] {
  ensurePlacementTable(db);
  const rows = db
    .prepare('SELECT * FROM placement_records ORDER BY seq')
    .all() as Record<string, unknown>[];
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

export function selectPlacementBySeq(
  db: DatabaseSync,
  seq: number,
): PlacementRecord | undefined {
  ensurePlacementTable(db);
  const row = db
    .prepare('SELECT * FROM placement_records WHERE seq = ?')
    .get(seq) as Record<string, unknown> | undefined;
  return row ? rowToPlacementRecord(row) : undefined;
}

/**
 * The placement read-model projector: folds `placement.decided` events into `placement_records`.
 * One row per event (keyed by `seq`), so a `rebuildAll` reproduces byte-identical rows (AC5, P14).
 */
export class PlacementProjector implements Projector {
  handles(eventType: string): boolean {
    return eventType === EVENT_PLACEMENT_DECIDED;
  }

  apply(tx: StoreTx, event: StoredEvent): void {
    const db = tx.raw as DatabaseSync;
    ensurePlacementTable(db);
    const p = event.payload as PlacementDecided;
    if (p.kind === 'placed') {
      db.prepare(
        `INSERT OR REPLACE INTO placement_records
         (seq, agent, role, work_size, reasoning_budget, kind, provider, model, effort, context, ts)
         VALUES (?, ?, ?, ?, ?, 'placed', ?, ?, ?, ?, ?)`,
      ).run(
        event.seq,
        event.actor ?? '',
        p.role,
        p.work_size,
        p.reasoning_budget,
        p.provider,
        p.model,
        p.effort,
        p.context,
        event.ts,
      );
    } else if (p.kind === 'waiting') {
      db.prepare(
        `INSERT OR REPLACE INTO placement_records
         (seq, agent, role, work_size, reasoning_budget, kind, eta_reset_at, reason, maxed_providers, ts)
         VALUES (?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?)`,
      ).run(
        event.seq,
        event.actor ?? '',
        p.role,
        p.work_size,
        p.reasoning_budget,
        p.eta_reset_at ?? null,
        p.reason,
        JSON.stringify(p.maxed_providers),
        event.ts,
      );
    } else {
      assertNever(p);
    }
  }
}
