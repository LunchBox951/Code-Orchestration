import type { DatabaseSync } from 'node:sqlite';
import { assertNever } from '../assert-never.js';
import type { Projector } from '../replay/projector.js';
import type { StoredEvent, StoreTx } from '../store/types.js';
import {
  EVENT_COST_NEAR_BUDGET,
  EVENT_COST_RECORDED,
  type CostNearBudget,
  type CostRecorded,
  type CostRollup,
  type CostRollupKind,
  type NearBudgetRecord,
} from './events.js';
import type { Provider } from './usage-source.js';

/**
 * The L4 cost read-model — two tables, every column log-derived so a `rebuildAll` reproduces them
 * byte-identical (AC5, freeze #6):
 *
 *   - `cost_rollup`      — one row per `(kind, id)`: the per-AGENT total AND the per-TASK total, both
 *                          folded from the SAME `cost.recorded` events (the event is filed once; the
 *                          projector increments both rows from the payload). Dollars sum only where
 *                          reported; tokens + usage-% sum across all observations.
 *   - `cost_near_budget` — one row per `cost.near_budget` event, keyed by its persisted L0 `seq` (its
 *                          stable identity), so a re-fold of the same log reaches an identical table.
 *
 * `ts` persists the event ts (freeze #6 — never wall-clock on read).
 */
const CREATE_COST_TABLES = `
  CREATE TABLE IF NOT EXISTS cost_rollup (
    kind           TEXT NOT NULL,
    id             TEXT NOT NULL,
    total_cost_usd REAL NOT NULL DEFAULT 0,
    input_tokens   INTEGER NOT NULL DEFAULT 0,
    output_tokens  INTEGER NOT NULL DEFAULT 0,
    total_tokens   INTEGER NOT NULL DEFAULT 0,
    used_pct       REAL NOT NULL DEFAULT 0,
    observations   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kind, id)
  );
  CREATE TABLE IF NOT EXISTS cost_near_budget (
    seq            INTEGER PRIMARY KEY,
    task           TEXT NOT NULL,
    agent          TEXT NOT NULL,
    provider       TEXT NOT NULL,
    total_cost_usd REAL NOT NULL,
    cap_cents      REAL NOT NULL,
    threshold_pct  REAL NOT NULL,
    ts             INTEGER NOT NULL
  );
`;

/**
 * Defensive create of the cost read-model tables. Called from the projector's reset/apply AND every
 * read path, so a freshly opened store can be queried before any write has happened.
 */
export function ensureCostTables(db: DatabaseSync): void {
  db.exec(CREATE_COST_TABLES);
}

/** Map a raw `cost_rollup` row (loosely typed at the SQLite boundary) to a {@link CostRollup}. */
export function rowToCostRollup(row: Record<string, unknown>): CostRollup {
  return {
    kind: String(row.kind) as CostRollupKind,
    id: String(row.id),
    totalCostUsd: Number(row.total_cost_usd),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    totalTokens: Number(row.total_tokens),
    usedPct: Number(row.used_pct),
    observations: Number(row.observations),
  };
}

/** Map a raw `cost_near_budget` row to a {@link NearBudgetRecord}. */
export function rowToNearBudgetRecord(row: Record<string, unknown>): NearBudgetRecord {
  return {
    seq: Number(row.seq),
    task: String(row.task),
    agent: String(row.agent),
    provider: String(row.provider) as Provider,
    totalCostUsd: Number(row.total_cost_usd),
    capCents: Number(row.cap_cents),
    thresholdPct: Number(row.threshold_pct),
    recordedTs: Number(row.ts),
  };
}

const ROLLUP_COLUMNS =
  'kind, id, total_cost_usd, input_tokens, output_tokens, total_tokens, used_pct, observations';
const NEAR_BUDGET_COLUMNS =
  'seq, task, agent, provider, total_cost_usd, cap_cents, threshold_pct, ts';

/** The rollup total for `(kind, id)`, or undefined (no cost recorded for it yet). */
export function selectCostRollup(
  db: DatabaseSync,
  kind: CostRollupKind,
  id: string,
): CostRollup | undefined {
  ensureCostTables(db);
  const row = db
    .prepare(`SELECT ${ROLLUP_COLUMNS} FROM cost_rollup WHERE kind = ? AND id = ?`)
    .get(kind, id);
  return row ? rowToCostRollup(row as Record<string, unknown>) : undefined;
}

/** Every rollup total, in a deterministic order (kind, then id). */
export function selectAllCostRollups(db: DatabaseSync): CostRollup[] {
  ensureCostTables(db);
  const rows = db.prepare(`SELECT ${ROLLUP_COLUMNS} FROM cost_rollup ORDER BY kind, id`).all();
  return rows.map((r) => rowToCostRollup(r as Record<string, unknown>));
}

/** One near-budget record by its event `seq`, or undefined. */
export function selectNearBudgetBySeq(db: DatabaseSync, seq: number): NearBudgetRecord | undefined {
  ensureCostTables(db);
  const row = db
    .prepare(`SELECT ${NEAR_BUDGET_COLUMNS} FROM cost_near_budget WHERE seq = ?`)
    .get(seq);
  return row ? rowToNearBudgetRecord(row as Record<string, unknown>) : undefined;
}

/** Every recorded near-budget crossing in seq order; optionally filtered to one task. */
export function selectNearBudgetEvents(db: DatabaseSync, task?: string): NearBudgetRecord[] {
  ensureCostTables(db);
  const rows =
    task === undefined
      ? db.prepare(`SELECT ${NEAR_BUDGET_COLUMNS} FROM cost_near_budget ORDER BY seq`).all()
      : db
          .prepare(
            `SELECT ${NEAR_BUDGET_COLUMNS} FROM cost_near_budget WHERE task = ? ORDER BY seq`,
          )
          .all(task);
  return rows.map((r) => rowToNearBudgetRecord(r as Record<string, unknown>));
}

// `handles()` guarantees only these two types reach `apply()`; modelling them as StoredEvent subtypes
// lets the switch be GENUINELY exhaustive (assertNever sees a real `never`).
interface CostRecordedEvent extends StoredEvent {
  readonly type: typeof EVENT_COST_RECORDED;
  readonly payload: CostRecorded;
}
interface CostNearBudgetEvent extends StoredEvent {
  readonly type: typeof EVENT_COST_NEAR_BUDGET;
  readonly payload: CostNearBudget;
}
type CostEvent = CostRecordedEvent | CostNearBudgetEvent;

/**
 * Folds the L4 cost events into the cost read-model, in the SAME tx as the append. A `cost.recorded`
 * increments BOTH the agent rollup (`kind: 'agent'`, id = agent) and the task rollup (`kind: 'task'`,
 * id = task) from one event — the dual-view rollup without double-counting the log. A
 * `cost.near_budget` is recorded keyed by its event seq. Carries NO wall-clock field (freeze #6).
 */
export class CostProjector implements Projector {
  readonly name = 'cost';

  handles(type: string): boolean {
    return type === EVENT_COST_RECORDED || type === EVENT_COST_NEAR_BUDGET;
  }

  reset(tx: StoreTx): void {
    const db = tx.raw as DatabaseSync;
    ensureCostTables(db);
    db.exec('DELETE FROM cost_rollup');
    db.exec('DELETE FROM cost_near_budget');
  }

  apply(tx: StoreTx, event: StoredEvent): void {
    const db = tx.raw as DatabaseSync;
    ensureCostTables(db);
    const costEvent = event as CostEvent;
    switch (costEvent.type) {
      case EVENT_COST_RECORDED: {
        const p = costEvent.payload;
        addToRollup(db, 'agent', p.agent, p);
        addToRollup(db, 'task', p.task, p);
        return;
      }
      case EVENT_COST_NEAR_BUDGET: {
        const p = costEvent.payload;
        // INSERT OR REPLACE keyed by seq ⇒ idempotent + replay-safe (re-folding reaches the same row).
        db.prepare(
          `INSERT OR REPLACE INTO cost_near_budget
             (seq, task, agent, provider, total_cost_usd, cap_cents, threshold_pct, ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          event.seq,
          p.task,
          p.agent,
          p.provider,
          p.total_cost_usd,
          p.cap_cents,
          p.threshold_pct,
          event.ts,
        );
        return;
      }
      default:
        return assertNever(costEvent);
    }
  }
}

/** Accumulate one cost observation into the `(kind, id)` rollup row (missing fields contribute 0). */
function addToRollup(db: DatabaseSync, kind: CostRollupKind, id: string, p: CostRecorded): void {
  db.prepare(
    `INSERT INTO cost_rollup
       (kind, id, total_cost_usd, input_tokens, output_tokens, total_tokens, used_pct, observations)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(kind, id) DO UPDATE SET
       total_cost_usd = total_cost_usd + excluded.total_cost_usd,
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       total_tokens = total_tokens + excluded.total_tokens,
       used_pct = used_pct + excluded.used_pct,
       observations = observations + excluded.observations`,
  ).run(
    kind,
    id,
    p.cost_usd ?? 0,
    p.input_tokens ?? 0,
    p.output_tokens ?? 0,
    p.total_tokens ?? 0,
    p.used_pct ?? 0,
  );
}
