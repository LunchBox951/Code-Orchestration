import type { DatabaseSync } from 'node:sqlite';
import { assertNever } from '../assert-never.js';
import type { Projector } from '../replay/projector.js';
import type { StoredEvent, StoreTx } from '../store/types.js';
import {
  EVENT_COST_NEAR_BUDGET,
  EVENT_COST_RECORDED,
  costRecordedSchema,
  costScope,
  type CostNearBudget,
  type CostRecorded,
  type CostRollup,
  type CostRollupKind,
  type NearBudgetRecord,
} from './events.js';
import type { Provider } from './usage-source.js';

/**
 * The L4 cost read-model — three tables, every column log-derived so a `rebuildAll` reproduces them
 * byte-identical (AC5, freeze #6):
 *
 *   - `cost_observations` — one row per `(provider, agent, task, turn)` observation identity; duplicate
 *                           `cost.recorded` events are ignored here before they can double-count rollups.
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
  CREATE TABLE IF NOT EXISTS cost_observations (
    provider       TEXT NOT NULL,
    agent          TEXT NOT NULL,
    task           TEXT NOT NULL,
    turn           INTEGER NOT NULL,
    source_id      TEXT,
    cost_usd       REAL,
    input_tokens   INTEGER,
    output_tokens  INTEGER,
    total_tokens   INTEGER,
    cache_read_tokens INTEGER,
    cache_creation_tokens INTEGER,
    used_pct       REAL,
    PRIMARY KEY (provider, agent, task, turn)
  );
  CREATE TABLE IF NOT EXISTS cost_rollup (
    kind           TEXT NOT NULL,
    id             TEXT NOT NULL,
    total_cost_usd REAL NOT NULL DEFAULT 0,
    cost_usd_observations INTEGER NOT NULL DEFAULT 0,
    input_tokens   INTEGER NOT NULL DEFAULT 0,
    output_tokens  INTEGER NOT NULL DEFAULT 0,
    total_tokens   INTEGER NOT NULL DEFAULT 0,
    token_observations INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    used_pct       REAL NOT NULL DEFAULT 0,
    used_pct_observations INTEGER NOT NULL DEFAULT 0,
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
export function ensureCostTables(
  db: DatabaseSync,
  opts: { readonly backfillLegacy?: boolean } = {},
): void {
  db.exec(CREATE_COST_TABLES);
  ensureColumn(db, 'cost_rollup', 'cost_usd_observations', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'cost_rollup', 'token_observations', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'cost_rollup', 'used_pct_observations', 'INTEGER NOT NULL DEFAULT 0');
  // Prompt-cache token columns (added after the original cost tables): migrate an existing store
  // so a re-fold of its log lands the cache totals without dropping the table (replay-safe, freeze #6).
  ensureColumn(db, 'cost_observations', 'cache_read_tokens', 'INTEGER');
  ensureColumn(db, 'cost_observations', 'cache_creation_tokens', 'INTEGER');
  ensureColumn(db, 'cost_observations', 'source_id', 'TEXT');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS cost_observations_source_identity
      ON cost_observations(provider, agent, task, source_id)
      WHERE source_id IS NOT NULL
  `);
  ensureColumn(db, 'cost_rollup', 'cache_read_tokens', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'cost_rollup', 'cache_creation_tokens', 'INTEGER NOT NULL DEFAULT 0');
  // `backfillLegacy` re-derives observation-count columns (and, on an old store, re-folds the cost log)
  // — a WRITE. The operator dashboard READ path opts out (#126: writing on read contends with the
  // daemon writer → "database is locked"); a read only needs the idempotent CREATE + column migrations.
  if (opts.backfillLegacy ?? true) backfillCostObservationState(db);
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ readonly name: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
    undefined
  );
}

function tableColumns(db: DatabaseSync, table: string): ReadonlySet<string> {
  if (!tableExists(db, table)) return new Set();
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ readonly name: string }>;
  return new Set(rows.map((row) => row.name));
}

function columnOrDefault(columns: ReadonlySet<string>, column: string, defaultSql: string): string {
  return columns.has(column) ? column : `${defaultSql} AS ${column}`;
}

function requireColumns(
  table: string,
  columns: ReadonlySet<string>,
  required: readonly string[],
): void {
  const missing = required.filter((column) => !columns.has(column));
  if (missing.length > 0) {
    throw new Error(
      `cost-projector: ${table} is missing required column(s): ${missing.join(', ')}`,
    );
  }
}

function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as
    | { readonly count?: unknown }
    | undefined;
  return Number(row?.count ?? 0);
}

function backfillCostObservationState(db: DatabaseSync): void {
  if (!tableExists(db, 'events')) return;
  const observationCount = countRows(db, 'cost_observations');
  const rollupCount = countRows(db, 'cost_rollup');
  if (observationCount === 0 && rollupCount > 0) {
    const rows = db
      .prepare('SELECT payload FROM events WHERE type = ? ORDER BY seq')
      .all(EVENT_COST_RECORDED) as Array<{ readonly payload: unknown }>;
    for (const row of rows) {
      const raw = JSON.parse(String(row.payload));
      recordCostObservation(db, costRecordedSchema.parse(raw));
    }
    recomputeCostRollupsFromObservations(db);
    return;
  }
  db.exec(`
    UPDATE cost_rollup
       SET cost_usd_observations = (
         SELECT COUNT(*)
           FROM cost_observations AS o
          WHERE o.cost_usd IS NOT NULL
            AND (
              (cost_rollup.kind = 'agent' AND o.agent = cost_rollup.id)
              OR
              (cost_rollup.kind = 'task' AND o.task = cost_rollup.id)
            )
       ),
       token_observations = (
         SELECT COUNT(*)
           FROM cost_observations AS o
          WHERE o.total_tokens IS NOT NULL
            AND (
              (cost_rollup.kind = 'agent' AND o.agent = cost_rollup.id)
              OR
              (cost_rollup.kind = 'task' AND o.task = cost_rollup.id)
            )
       ),
       used_pct_observations = (
         SELECT COUNT(*)
           FROM cost_observations AS o
          WHERE o.used_pct IS NOT NULL
            AND (
              (cost_rollup.kind = 'agent' AND o.agent = cost_rollup.id)
              OR
              (cost_rollup.kind = 'task' AND o.task = cost_rollup.id)
            )
       )
  `);
}

function recomputeCostRollupsFromObservations(db: DatabaseSync): void {
  db.exec('DELETE FROM cost_rollup');
  for (const kind of ['agent', 'task'] as const) {
    const idColumn = kind === 'agent' ? 'agent' : 'task';
    db.exec(`
      INSERT INTO cost_rollup
        (kind, id, total_cost_usd, cost_usd_observations, input_tokens, output_tokens, total_tokens,
         token_observations, cache_read_tokens, cache_creation_tokens, used_pct, used_pct_observations, observations)
      SELECT
        '${kind}',
        ${idColumn},
        SUM(COALESCE(cost_usd, 0)),
        SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END),
        SUM(COALESCE(input_tokens, 0)),
        SUM(COALESCE(output_tokens, 0)),
        SUM(COALESCE(total_tokens, 0)),
        SUM(CASE WHEN total_tokens IS NOT NULL THEN 1 ELSE 0 END),
        SUM(COALESCE(cache_read_tokens, 0)),
        SUM(COALESCE(cache_creation_tokens, 0)),
        SUM(COALESCE(used_pct, 0)),
        SUM(CASE WHEN used_pct IS NOT NULL THEN 1 ELSE 0 END),
        COUNT(*)
      FROM cost_observations
      GROUP BY ${idColumn}
    `);
  }
}

/** Map a raw `cost_rollup` row (loosely typed at the SQLite boundary) to a {@link CostRollup}. */
export function rowToCostRollup(row: Record<string, unknown>): CostRollup {
  return {
    kind: String(row.kind) as CostRollupKind,
    id: String(row.id),
    totalCostUsd: Number(row.total_cost_usd),
    costUsdObservations: Number(row.cost_usd_observations ?? 0),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    totalTokens: Number(row.total_tokens),
    tokenObservations: Number(row.token_observations ?? 0),
    cacheReadTokens: Number(row.cache_read_tokens ?? 0),
    cacheCreationTokens: Number(row.cache_creation_tokens ?? 0),
    usedPct: Number(row.used_pct),
    usedPctObservations: Number(row.used_pct_observations ?? 0),
    observations: Number(row.observations),
  };
}

interface CostRollupAccumulator {
  totalCostUsd: number;
  costUsdObservations: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  tokenObservations: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  usedPct: number;
  usedPctObservations: number;
  observations: number;
}

function emptyRollupAccumulator(): CostRollupAccumulator {
  return {
    totalCostUsd: 0,
    costUsdObservations: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    tokenObservations: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    usedPct: 0,
    usedPctObservations: 0,
    observations: 0,
  };
}

function accumulatorToRollup(
  kind: CostRollupKind,
  id: string,
  acc: CostRollupAccumulator,
): CostRollup {
  return {
    kind,
    id,
    totalCostUsd: acc.totalCostUsd,
    costUsdObservations: acc.costUsdObservations,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    totalTokens: acc.totalTokens,
    tokenObservations: acc.tokenObservations,
    cacheReadTokens: acc.cacheReadTokens,
    cacheCreationTokens: acc.cacheCreationTokens,
    usedPct: acc.usedPct,
    usedPctObservations: acc.usedPctObservations,
    observations: acc.observations,
  };
}

function addObservedCost(acc: CostRollupAccumulator, obs: NormalizedCostObservation): void {
  acc.totalCostUsd += obs.costUsd ?? 0;
  if (obs.costUsd !== null) acc.costUsdObservations += 1;
  acc.inputTokens += obs.inputTokens ?? 0;
  acc.outputTokens += obs.outputTokens ?? 0;
  acc.totalTokens += obs.totalTokens ?? 0;
  if (obs.totalTokens !== null) acc.tokenObservations += 1;
  acc.cacheReadTokens += obs.cacheReadTokens ?? 0;
  acc.cacheCreationTokens += obs.cacheCreationTokens ?? 0;
  acc.usedPct += obs.usedPct ?? 0;
  if (obs.usedPct !== null) acc.usedPctObservations += 1;
  acc.observations += 1;
}

function observationTurnIdentity(obs: NormalizedCostObservation): string {
  return `${obs.provider}\0${obs.agent}\0${obs.task}\0turn:${obs.turn}`;
}

function observationSourceIdentity(obs: NormalizedCostObservation): string | undefined {
  return obs.sourceId != null
    ? `${obs.provider}\0${obs.agent}\0${obs.task}\0source:${obs.sourceId}`
    : undefined;
}

function rememberReadOnlyObservation(
  byTurn: Map<string, NormalizedCostObservation>,
  bySource: Map<string, NormalizedCostObservation>,
  obs: NormalizedCostObservation,
): boolean {
  const turnKey = observationTurnIdentity(obs);
  const sameTurn = byTurn.get(turnKey);
  if (sameTurn != null) {
    if (observationsMatch(sameTurn, obs)) return false;
    throw new Error(
      `cost-projector: conflicting duplicate cost observation for ` +
        `${obs.provider}/${obs.agent}/${obs.task}/turn-${obs.turn}`,
    );
  }

  const sourceKey = observationSourceIdentity(obs);
  if (sourceKey != null) {
    const sameSource = bySource.get(sourceKey);
    if (sameSource != null) {
      if (observationsMatchIgnoringTurn(sameSource, obs)) return false;
      throw new Error(
        `cost-projector: conflicting duplicate cost observation for ` +
          `${obs.provider}/${obs.agent}/${obs.task}/turn-${obs.turn}`,
      );
    }
  }

  byTurn.set(turnKey, obs);
  if (sourceKey != null) bySource.set(sourceKey, obs);
  return true;
}

function readOnlyRollupsFromEvents(db: DatabaseSync): CostRollup[] {
  if (!tableExists(db, 'events')) return [];
  const rows = db
    .prepare('SELECT payload FROM events WHERE type = ? ORDER BY seq')
    .all(EVENT_COST_RECORDED) as Array<{ readonly payload: unknown }>;
  const byTurn = new Map<string, NormalizedCostObservation>();
  const bySource = new Map<string, NormalizedCostObservation>();
  const byKey = new Map<string, CostRollupAccumulator>();
  const apply = (kind: CostRollupKind, id: string, obs: NormalizedCostObservation) => {
    const key = `${kind}\0${id}`;
    let acc = byKey.get(key);
    if (acc == null) {
      acc = emptyRollupAccumulator();
      byKey.set(key, acc);
    }
    addObservedCost(acc, obs);
  };

  for (const row of rows) {
    const obs = normalizeCostObservation(costRecordedSchema.parse(JSON.parse(String(row.payload))));
    if (!rememberReadOnlyObservation(byTurn, bySource, obs)) continue;
    apply('agent', obs.agent, obs);
    apply('task', obs.task, obs);
  }

  return [...byKey.entries()]
    .map(([key, acc]) => {
      const [kind, id] = key.split('\0') as [CostRollupKind, string];
      return accumulatorToRollup(kind, id, acc);
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

function selectPersistedRollupsWithReadOnlyCounts(db: DatabaseSync): CostRollup[] {
  if (!tableExists(db, 'cost_rollup')) return [];
  const rollupColumns = tableColumns(db, 'cost_rollup');
  if (!rollupColumns.has('kind') || !rollupColumns.has('id')) {
    throw new Error('cost-projector: cost_rollup is missing required kind/id columns');
  }
  const observationColumns = tableColumns(db, 'cost_observations');
  const canCountObservations =
    observationColumns.has('agent') &&
    observationColumns.has('task') &&
    tableExists(db, 'cost_observations');
  const countObservationColumn = (column: string): string =>
    canCountObservations && observationColumns.has(column)
      ? `(
           SELECT COUNT(*)
             FROM cost_observations AS o
            WHERE o.${column} IS NOT NULL
              AND (
                (cost_rollup.kind = 'agent' AND o.agent = cost_rollup.id)
                OR
                (cost_rollup.kind = 'task' AND o.task = cost_rollup.id)
              )
         )`
      : '0';
  const readColumns = [
    'kind',
    'id',
    columnOrDefault(rollupColumns, 'total_cost_usd', '0'),
    columnOrDefault(rollupColumns, 'cost_usd_observations', '0'),
    columnOrDefault(rollupColumns, 'input_tokens', '0'),
    columnOrDefault(rollupColumns, 'output_tokens', '0'),
    columnOrDefault(rollupColumns, 'total_tokens', '0'),
    columnOrDefault(rollupColumns, 'token_observations', '0'),
    columnOrDefault(rollupColumns, 'cache_read_tokens', '0'),
    columnOrDefault(rollupColumns, 'cache_creation_tokens', '0'),
    columnOrDefault(rollupColumns, 'used_pct', '0'),
    columnOrDefault(rollupColumns, 'used_pct_observations', '0'),
    columnOrDefault(rollupColumns, 'observations', '0'),
  ].join(', ');
  const rows = db
    .prepare(
      `SELECT
         ${readColumns},
         ${countObservationColumn('cost_usd')} AS read_cost_usd_observations,
         ${countObservationColumn('total_tokens')} AS read_token_observations,
         ${countObservationColumn('used_pct')} AS read_used_pct_observations
       FROM cost_rollup
       ORDER BY kind, id`,
    )
    .all() as Array<Record<string, unknown>>;

  return rows.map((row) =>
    rowToCostRollup({
      ...row,
      cost_usd_observations: row.read_cost_usd_observations,
      token_observations: row.read_token_observations,
      used_pct_observations: row.read_used_pct_observations,
    }),
  );
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
  'kind, id, total_cost_usd, cost_usd_observations, input_tokens, output_tokens, total_tokens, token_observations, cache_read_tokens, cache_creation_tokens, used_pct, used_pct_observations, observations';
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
export function selectAllCostRollups(
  db: DatabaseSync,
  opts: { readonly backfillLegacy?: boolean } = {},
): CostRollup[] {
  if (opts.backfillLegacy === false) {
    const observationCount = tableExists(db, 'cost_observations')
      ? countRows(db, 'cost_observations')
      : 0;
    const rollupCount = tableExists(db, 'cost_rollup') ? countRows(db, 'cost_rollup') : 0;
    if (observationCount === 0 && rollupCount > 0 && tableExists(db, 'events')) {
      return readOnlyRollupsFromEvents(db);
    }
    return selectPersistedRollupsWithReadOnlyCounts(db);
  }
  ensureCostTables(db, opts);
  const rows = db.prepare(`SELECT ${ROLLUP_COLUMNS} FROM cost_rollup ORDER BY kind, id`).all();
  return rows.map((r) => rowToCostRollup(r as Record<string, unknown>));
}

/** Highest recorded cost turn for `(provider, agent, task)`, or undefined when no observation exists. */
export function selectMaxCostTurn(
  db: DatabaseSync,
  provider: Provider,
  agent: string,
  task: string,
): number | undefined {
  ensureCostTables(db);
  const row = db
    .prepare(
      `SELECT MAX(turn) AS max_turn
         FROM cost_observations
        WHERE provider = ? AND agent = ? AND task = ?`,
    )
    .get(provider, agent, task) as { readonly max_turn?: unknown } | undefined;
  return row?.max_turn == null ? undefined : Number(row.max_turn);
}

/** Latest non-null provider-reader source id for `(provider, agent, task)`, ordered by recorded turn. */
export function selectLatestCostSourceId(
  db: DatabaseSync,
  provider: Provider,
  agent: string,
  task: string,
): string | undefined {
  ensureCostTables(db);
  const row = db
    .prepare(
      `SELECT source_id
         FROM cost_observations
        WHERE provider = ? AND agent = ? AND task = ? AND source_id IS NOT NULL
        ORDER BY turn DESC
        LIMIT 1`,
    )
    .get(provider, agent, task) as { readonly source_id?: unknown } | undefined;
  return typeof row?.source_id === 'string' ? row.source_id : undefined;
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
export function selectNearBudgetEvents(
  db: DatabaseSync,
  task?: string,
  opts: { readonly backfillLegacy?: boolean } = {},
): NearBudgetRecord[] {
  if (opts.backfillLegacy === false) {
    if (!tableExists(db, 'cost_near_budget')) return [];
    requireColumns('cost_near_budget', tableColumns(db, 'cost_near_budget'), [
      'seq',
      'task',
      'agent',
      'provider',
      'total_cost_usd',
      'cap_cents',
      'threshold_pct',
      'ts',
    ]);
  } else {
    ensureCostTables(db);
  }
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
    db.exec('DELETE FROM cost_observations');
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
        validateCostRecordedEnvelope(event, p);
        if (!recordCostObservation(db, p)) return;
        addToRollup(db, 'agent', p.agent, p);
        addToRollup(db, 'task', p.task, p);
        return;
      }
      case EVENT_COST_NEAR_BUDGET: {
        const p = costEvent.payload;
        validateCostNearBudgetEnvelope(event, p);
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

function validateCostRecordedEnvelope(event: StoredEvent, payload: CostRecorded): void {
  const expected = costScope(payload.agent);
  if (event.scope !== expected) {
    throw new Error(
      `cost-projector: cost scope '${event.scope}' does not match cost.recorded agent '${payload.agent}'`,
    );
  }
  if (event.actor !== undefined && event.actor !== payload.agent) {
    throw new Error(
      `cost-projector: actor '${event.actor}' does not match cost.recorded agent '${payload.agent}'`,
    );
  }
}

function validateCostNearBudgetEnvelope(event: StoredEvent, payload: CostNearBudget): void {
  const expected = costScope(payload.task);
  if (event.scope !== expected) {
    throw new Error(
      `cost-projector: cost scope '${event.scope}' does not match cost.near_budget task '${payload.task}'`,
    );
  }
  if (event.actor !== undefined && event.actor !== payload.agent) {
    throw new Error(
      `cost-projector: actor '${event.actor}' does not match cost.near_budget agent '${payload.agent}'`,
    );
  }
}

interface NormalizedCostObservation {
  readonly provider: Provider;
  readonly agent: string;
  readonly task: string;
  readonly turn: number;
  readonly sourceId: string | null;
  readonly costUsd: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheCreationTokens: number | null;
  readonly usedPct: number | null;
}

/** Insert the observation identity once; exact duplicates no-op, conflicting duplicates fail loud. */
function recordCostObservation(db: DatabaseSync, p: CostRecorded): boolean {
  const n = normalizeCostObservation(p);
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO cost_observations
         (provider, agent, task, turn, source_id, cost_usd, input_tokens, output_tokens, total_tokens,
          cache_read_tokens, cache_creation_tokens, used_pct)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      n.provider,
      n.agent,
      n.task,
      n.turn,
      n.sourceId,
      n.costUsd,
      n.inputTokens,
      n.outputTokens,
      n.totalTokens,
      n.cacheReadTokens,
      n.cacheCreationTokens,
      n.usedPct,
    ) as { readonly changes?: number };
  if ((result.changes ?? 0) > 0) return true;

  const existing = db
    .prepare(
      `SELECT provider, agent, task, turn, source_id, cost_usd, input_tokens, output_tokens, total_tokens,
              cache_read_tokens, cache_creation_tokens, used_pct
         FROM cost_observations
        WHERE provider = ? AND agent = ? AND task = ? AND turn = ?`,
    )
    .get(n.provider, n.agent, n.task, n.turn) as Record<string, unknown> | undefined;
  if (existing !== undefined && observationsMatch(rowToObservation(existing), n)) return false;
  if (n.sourceId !== null) {
    const sameSource = db
      .prepare(
        `SELECT provider, agent, task, turn, source_id, cost_usd, input_tokens, output_tokens, total_tokens,
                cache_read_tokens, cache_creation_tokens, used_pct
           FROM cost_observations
          WHERE provider = ? AND agent = ? AND task = ? AND source_id = ?`,
      )
      .get(n.provider, n.agent, n.task, n.sourceId) as Record<string, unknown> | undefined;
    if (
      sameSource !== undefined &&
      observationsMatchIgnoringTurn(rowToObservation(sameSource), n)
    ) {
      return false;
    }
  }
  throw new Error(
    `cost-projector: conflicting duplicate cost observation for ` +
      `${n.provider}/${n.agent}/${n.task}/turn-${n.turn}`,
  );
}

function normalizeCostObservation(p: CostRecorded): NormalizedCostObservation {
  return {
    provider: p.provider,
    agent: p.agent,
    task: p.task,
    turn: p.turn,
    sourceId: p.source_id ?? null,
    costUsd: p.cost_usd ?? null,
    inputTokens: p.input_tokens ?? null,
    outputTokens: p.output_tokens ?? null,
    totalTokens: normalizedTotalTokens(p),
    cacheReadTokens: p.cache_read_input_tokens ?? null,
    cacheCreationTokens: p.cache_creation_input_tokens ?? null,
    usedPct: p.used_pct ?? null,
  };
}

function normalizedTotalTokens(p: CostRecorded): number | null {
  if (p.total_tokens !== undefined) return p.total_tokens;
  if (p.input_tokens !== undefined && p.output_tokens !== undefined) {
    return p.input_tokens + p.output_tokens;
  }
  return null;
}

function rowToObservation(row: Record<string, unknown>): NormalizedCostObservation {
  return {
    provider: String(row.provider) as Provider,
    agent: String(row.agent),
    task: String(row.task),
    turn: Number(row.turn),
    sourceId: nullableString(row.source_id),
    costUsd: nullableNumber(row.cost_usd),
    inputTokens: nullableNumber(row.input_tokens),
    outputTokens: nullableNumber(row.output_tokens),
    totalTokens: nullableNumber(row.total_tokens),
    cacheReadTokens: nullableNumber(row.cache_read_tokens),
    cacheCreationTokens: nullableNumber(row.cache_creation_tokens),
    usedPct: nullableNumber(row.used_pct),
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function observationsMatch(a: NormalizedCostObservation, b: NormalizedCostObservation): boolean {
  return (
    a.provider === b.provider &&
    a.agent === b.agent &&
    a.task === b.task &&
    a.turn === b.turn &&
    a.sourceId === b.sourceId &&
    a.costUsd === b.costUsd &&
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.totalTokens === b.totalTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheCreationTokens === b.cacheCreationTokens &&
    a.usedPct === b.usedPct
  );
}

function observationsMatchIgnoringTurn(
  a: NormalizedCostObservation,
  b: NormalizedCostObservation,
): boolean {
  return (
    a.provider === b.provider &&
    a.agent === b.agent &&
    a.task === b.task &&
    a.sourceId === b.sourceId &&
    a.costUsd === b.costUsd &&
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.totalTokens === b.totalTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheCreationTokens === b.cacheCreationTokens &&
    a.usedPct === b.usedPct
  );
}

/** Accumulate one cost observation into the `(kind, id)` rollup row (missing fields contribute 0). */
function addToRollup(db: DatabaseSync, kind: CostRollupKind, id: string, p: CostRecorded): void {
  db.prepare(
    `INSERT INTO cost_rollup
       (kind, id, total_cost_usd, cost_usd_observations, input_tokens, output_tokens, total_tokens, token_observations, cache_read_tokens, cache_creation_tokens, used_pct, used_pct_observations, observations)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(kind, id) DO UPDATE SET
       total_cost_usd = total_cost_usd + excluded.total_cost_usd,
       cost_usd_observations = cost_usd_observations + excluded.cost_usd_observations,
       input_tokens = input_tokens + excluded.input_tokens,
       output_tokens = output_tokens + excluded.output_tokens,
       total_tokens = total_tokens + excluded.total_tokens,
       token_observations = token_observations + excluded.token_observations,
       cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
       cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
       used_pct = used_pct + excluded.used_pct,
       used_pct_observations = used_pct_observations + excluded.used_pct_observations,
       observations = observations + excluded.observations`,
  ).run(
    kind,
    id,
    p.cost_usd ?? 0,
    p.cost_usd !== undefined ? 1 : 0,
    p.input_tokens ?? 0,
    p.output_tokens ?? 0,
    normalizedTotalTokens(p) ?? 0,
    normalizedTotalTokens(p) !== null ? 1 : 0,
    p.cache_read_input_tokens ?? 0,
    p.cache_creation_input_tokens ?? 0,
    p.used_pct ?? 0,
    p.used_pct !== undefined ? 1 : 0,
  );
}
