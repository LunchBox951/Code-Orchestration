import type { DatabaseSync } from 'node:sqlite';
import type { Projector } from '../replay/projector.js';
import type { StoredEvent, StoreTx } from '../store/types.js';
import {
  EVENT_TOOL_INVOKED,
  TOOL_SCOPE_PREFIX,
  toolScope,
  type AgentToolUsage,
  type ToolInvoked,
} from './events.js';

/**
 * The L4 tool-usage read-model — the DURABLE, replay-safe counterpart to the engine's in-memory
 * {@link import('../../mcp/server.js').ToolActivityEvent} watchdog seam. Two tables, every column
 * log-derived so a `rebuildAll` reproduces them byte-identical (AC5, freeze #6):
 *
 *   - `tool_invocations` — one row per `tool.invoked` event, keyed by its persisted L0 `seq` (its stable
 *                          identity), so a re-fold of the same log reaches an identical table and a
 *                          duplicate event can never double-count the rollup.
 *   - `tool_usage_rollup` — one row per AGENT: total calls, errors, redundant reads, permission asks, and
 *                           the turn of the agent's FIRST successful `co_*` call (the ramp-up signal).
 *                           `turnsToFirstProductiveCoCall` is a MIN over invocations, so an incremental
 *                           fold (keep the smaller turn) is order-independent and replay-stable.
 *
 * A "productive co call" is a SUCCESSFUL (`ok`) call to a `co_*` (or `mcp__co__*`) tool — the agent's
 * first real orchestration action, distinct from reads/permission-asks. AC8: this is INTERNAL
 * orchestration state — not agent-facing; recorded entirely in program-data (AC9, P12).
 *
 * NOT-YET-DERIVED IN PRODUCTION (`redundant_read` / `permission_ask`): these are canonical fields on
 * {@link ToolInvoked} and roll up into `redundantReads` / `permissionAsks`, but NOTHING populates them on
 * the live path yet — the engine's {@link import('../../mcp/server.js').ToolActivityEvent} carries only
 * `phase`/`tool`/`ok`/`durationMs`, no redundant-read or permission-ask signal, so the host recorder
 * never sets either flag and BOTH columns stay 0 in a real run. That 0 means "no signal yet observed",
 * NOT "zero friction confirmed"; downstream `contextEfficiency` treats 0 as "no friction observed".
 * They remain canonical so that, once the live providers expose a redundant-read / permission-prompt
 * signal, the existing fold lights up with no schema change. (stillNeedsLive — see the fix-up note.)
 */
const CREATE_TOOL_USAGE_TABLES = `
  CREATE TABLE IF NOT EXISTS tool_invocations (
    seq            INTEGER PRIMARY KEY,
    agent          TEXT NOT NULL,
    task           TEXT NOT NULL,
    tool           TEXT NOT NULL,
    turn           INTEGER NOT NULL,
    ok             INTEGER NOT NULL,
    redundant_read INTEGER NOT NULL DEFAULT 0,
    permission_ask INTEGER NOT NULL DEFAULT 0,
    duration_ms    REAL,
    ts             INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tool_usage_rollup (
    agent          TEXT PRIMARY KEY,
    tool_calls     INTEGER NOT NULL DEFAULT 0,
    tool_errors    INTEGER NOT NULL DEFAULT 0,
    redundant_reads INTEGER NOT NULL DEFAULT 0,
    permission_asks INTEGER NOT NULL DEFAULT 0,
    first_productive_turn INTEGER
  );
`;

/** Defensive create of the tool-usage read-model tables (called from the projector + every read path). */
export function ensureToolUsageTables(db: DatabaseSync): void {
  db.exec(CREATE_TOOL_USAGE_TABLES);
}

/** Whether `tool` is a productive co orchestration call (the `co_*` / `mcp__co__*` surface). */
export function isProductiveCoTool(tool: string): boolean {
  return tool.startsWith('co_') || tool.startsWith('mcp__co__');
}

/** Map a raw `tool_usage_rollup` row to an {@link AgentToolUsage} (loosely typed at the SQLite boundary). */
export function rowToAgentToolUsage(row: Record<string, unknown>): AgentToolUsage {
  const first = row.first_productive_turn;
  return {
    agentId: String(row.agent),
    toolCalls: Number(row.tool_calls ?? 0),
    toolErrors: Number(row.tool_errors ?? 0),
    redundantReads: Number(row.redundant_reads ?? 0),
    permissionAsks: Number(row.permission_asks ?? 0),
    turnsToFirstProductiveCoCall: first === null || first === undefined ? null : Number(first),
  };
}

/** The tool-usage rollup for `agent`, or undefined (no tool call recorded for it yet). */
export function selectAgentToolUsage(db: DatabaseSync, agent: string): AgentToolUsage | undefined {
  ensureToolUsageTables(db);
  const row = db.prepare('SELECT * FROM tool_usage_rollup WHERE agent = ?').get(agent);
  return row ? rowToAgentToolUsage(row as Record<string, unknown>) : undefined;
}

/** Every tool-usage rollup, in agent order. */
export function selectAllAgentToolUsage(db: DatabaseSync): readonly AgentToolUsage[] {
  ensureToolUsageTables(db);
  const rows = db.prepare('SELECT * FROM tool_usage_rollup ORDER BY agent').all();
  return rows.map((r) => rowToAgentToolUsage(r as Record<string, unknown>));
}

// `handles()` guarantees only `tool.invoked` reaches `apply()`; modelling it as a StoredEvent subtype
// keeps the payload access fully typed.
interface ToolInvokedEvent extends StoredEvent {
  readonly type: typeof EVENT_TOOL_INVOKED;
  readonly payload: ToolInvoked;
}

/**
 * Folds `tool.invoked` events into the tool-usage read-model, in the SAME tx as the append. Each event
 * inserts one `tool_invocations` row keyed by its L0 `seq` (idempotent — a duplicate re-fold is ignored
 * before it can double-count) and increments the agent's rollup. `turnsToFirstProductiveCoCall` keeps the
 * MIN turn of a successful `co_*` call. Carries NO wall-clock field (freeze #6 — uses the event ts).
 */
export class ToolUsageProjector implements Projector {
  readonly name = 'tool-usage';

  handles(type: string): boolean {
    return type === EVENT_TOOL_INVOKED;
  }

  reset(tx: StoreTx): void {
    const db = tx.raw as DatabaseSync;
    ensureToolUsageTables(db);
    db.exec('DELETE FROM tool_invocations');
    db.exec('DELETE FROM tool_usage_rollup');
  }

  apply(tx: StoreTx, event: StoredEvent): void {
    const db = tx.raw as DatabaseSync;
    ensureToolUsageTables(db);
    const inv = event as ToolInvokedEvent;
    const p = inv.payload;
    validateToolInvokedEnvelope(event, p);

    // Insert the invocation keyed by seq — exact-duplicate re-folds are ignored before they roll up.
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO tool_invocations
           (seq, agent, task, tool, turn, ok, redundant_read, permission_ask, duration_ms, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.seq,
        p.agent,
        p.task,
        p.tool,
        p.turn,
        p.ok ? 1 : 0,
        p.redundant_read ? 1 : 0,
        p.permission_ask ? 1 : 0,
        p.duration_ms ?? null,
        event.ts,
      ) as { readonly changes?: number };
    if ((result.changes ?? 0) === 0) return; // duplicate seq — already folded.

    const productiveTurn = p.ok && isProductiveCoTool(p.tool) ? p.turn : null;
    db.prepare(
      `INSERT INTO tool_usage_rollup
         (agent, tool_calls, tool_errors, redundant_reads, permission_asks, first_productive_turn)
       VALUES (?, 1, ?, ?, ?, ?)
       ON CONFLICT(agent) DO UPDATE SET
         tool_calls = tool_calls + 1,
         tool_errors = tool_errors + excluded.tool_errors,
         redundant_reads = redundant_reads + excluded.redundant_reads,
         permission_asks = permission_asks + excluded.permission_asks,
         first_productive_turn = CASE
           WHEN excluded.first_productive_turn IS NULL THEN first_productive_turn
           WHEN first_productive_turn IS NULL THEN excluded.first_productive_turn
           ELSE MIN(first_productive_turn, excluded.first_productive_turn)
         END`,
    ).run(
      p.agent,
      p.ok ? 0 : 1,
      p.redundant_read ? 1 : 0,
      p.permission_ask ? 1 : 0,
      productiveTurn,
    );
  }
}

function validateToolInvokedEnvelope(event: StoredEvent, payload: ToolInvoked): void {
  const expected = toolScope(payload.agent);
  if (event.scope !== expected) {
    throw new Error(
      `tool-usage-projector: tool scope '${event.scope}' does not match tool.invoked agent '${payload.agent}'`,
    );
  }
  if (!event.scope.startsWith(TOOL_SCOPE_PREFIX)) {
    throw new Error(
      `tool-usage-projector: expected scope '${TOOL_SCOPE_PREFIX}<agent>', got '${event.scope}'`,
    );
  }
  if (event.actor !== undefined && event.actor !== payload.agent) {
    throw new Error(
      `tool-usage-projector: actor '${event.actor}' does not match tool.invoked agent '${payload.agent}'`,
    );
  }
}
