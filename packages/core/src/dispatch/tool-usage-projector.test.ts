import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openProjectStore } from '../store/sqlite-store.js';
import { applyEvent, rebuildAll } from '../replay/projector.js';
import { decode } from '../replay/decode.js';
import {
  dispatchSchemas,
  dispatchUpcasters,
  DISPATCH_EVENT_V,
  EVENT_TOOL_INVOKED,
  makeToolInvokedEvent,
  toolScope,
} from './events.js';
import {
  ToolUsageProjector,
  ensureToolUsageTables,
  isProductiveCoTool,
  selectAgentToolUsage,
  selectAllAgentToolUsage,
} from './tool-usage-projector.js';
import { openDispatchStore } from './dispatch-store.js';

// ── Program-data dir per test (mirrors dispatch-store.test.ts) ───────────────────────────────────
const ORIGINAL_ENV = process.env;
let dataDir = '';
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'co-tool-usage-'));
  process.env = { ...ORIGINAL_ENV, CO_DATA_DIR: dataDir };
});
afterEach(() => {
  process.env = ORIGINAL_ENV;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('isProductiveCoTool', () => {
  it('recognises co_* and mcp__co__* tools, rejects others', () => {
    expect(isProductiveCoTool('co_finish')).toBe(true);
    expect(isProductiveCoTool('mcp__co__co_mail_send')).toBe(true);
    expect(isProductiveCoTool('Read')).toBe(false);
    expect(isProductiveCoTool('Bash')).toBe(false);
  });
});

describe('recordToolInvoked — folds the per-agent tool-usage rollup', () => {
  it('counts calls, errors, redundant reads, permission asks, and the first productive co turn', () => {
    const store = openDispatchStore('p-tool-rollup');
    try {
      // turn 0: two reads (one redundant), one denied (permission ask) — no productive co call yet.
      store.recordToolInvoked({ agent: 'a1', task: 't1', tool: 'Read', turn: 0, ok: true });
      store.recordToolInvoked({
        agent: 'a1',
        task: 't1',
        tool: 'Read',
        turn: 0,
        ok: true,
        redundant_read: true,
      });
      store.recordToolInvoked({
        agent: 'a1',
        task: 't1',
        tool: 'Bash',
        turn: 0,
        ok: false,
        permission_ask: true,
      });
      // turn 1: a FAILED co call (error, not productive), then turn 2: the first SUCCESSFUL co call.
      store.recordToolInvoked({ agent: 'a1', task: 't1', tool: 'co_sling', turn: 1, ok: false });
      const usage = store.recordToolInvoked({
        agent: 'a1',
        task: 't1',
        tool: 'co_finish',
        turn: 2,
        ok: true,
      });

      expect(usage).toEqual({
        agentId: 'a1',
        toolCalls: 5,
        toolErrors: 2, // the denied Bash + the failed co_sling
        redundantReads: 1,
        permissionAsks: 1,
        turnsToFirstProductiveCoCall: 2,
      });
      expect(store.getAgentToolUsage('a1')).toEqual(usage);
      expect(store.getAgentToolUsage('nobody')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('keeps the MIN turn for turnsToFirstProductiveCoCall even when a later turn also calls co', () => {
    const store = openDispatchStore('p-tool-min-turn');
    try {
      store.recordToolInvoked({ agent: 'a1', task: 't1', tool: 'co_finish', turn: 3, ok: true });
      store.recordToolInvoked({ agent: 'a1', task: 't1', tool: 'co_sling', turn: 1, ok: true });
      store.recordToolInvoked({ agent: 'a1', task: 't1', tool: 'co_mail_send', turn: 5, ok: true });
      expect(store.getAgentToolUsage('a1')?.turnsToFirstProductiveCoCall).toBe(1);
    } finally {
      store.close();
    }
  });

  it('leaves turnsToFirstProductiveCoCall null when no successful co call is recorded', () => {
    const store = openDispatchStore('p-tool-no-productive');
    try {
      store.recordToolInvoked({ agent: 'a1', task: 't1', tool: 'Read', turn: 0, ok: true });
      store.recordToolInvoked({ agent: 'a1', task: 't1', tool: 'co_sling', turn: 1, ok: false });
      expect(store.getAgentToolUsage('a1')?.turnsToFirstProductiveCoCall).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe('ToolUsageProjector — scope/actor guards (Principle 9, fail-loud)', () => {
  it('rejects a tool.invoked whose scope does not match the payload agent', () => {
    const projector = new ToolUsageProjector();
    const store = openProjectStore('p-tool-scope-mismatch');
    try {
      expect(() =>
        store.transaction((tx) => {
          // Build a valid event, then corrupt the scope to a DIFFERENT agent.
          const built = makeToolInvokedEvent('p-tool-scope-mismatch', {
            agent: 'a1',
            task: 't1',
            tool: 'co_finish',
            turn: 0,
            ok: true,
          });
          const [stored] = tx.append([{ ...built, scope: toolScope('someone-else') }]);
          applyEvent(tx, decode(stored!, dispatchUpcasters, dispatchSchemas), [projector]);
        }),
      ).toThrow(/tool scope .* does not match tool.invoked agent/);
    } finally {
      store.close();
    }
  });

  it('rejects a tool.invoked whose actor does not match the payload agent', () => {
    const projector = new ToolUsageProjector();
    const store = openProjectStore('p-tool-actor-mismatch');
    try {
      expect(() =>
        store.transaction((tx) => {
          const [stored] = tx.append([
            {
              projectId: 'p-tool-actor-mismatch',
              scope: toolScope('a1'),
              type: EVENT_TOOL_INVOKED,
              v: DISPATCH_EVENT_V,
              payload: { agent: 'a1', task: 't1', tool: 'co_finish', turn: 0, ok: true },
              actor: 'mallory',
            },
          ]);
          applyEvent(tx, decode(stored!, dispatchUpcasters, dispatchSchemas), [projector]);
        }),
      ).toThrow(/actor 'mallory' does not match tool.invoked agent/);
    } finally {
      store.close();
    }
  });
});

describe('ToolUsageProjector — AC5 replay-equality (Principle 14)', () => {
  function snapshot(db: DatabaseSync): string {
    ensureToolUsageTables(db);
    return JSON.stringify({
      tool_invocations: db
        .prepare(
          'SELECT seq, agent, task, tool, turn, ok, redundant_read, permission_ask, duration_ms, ts FROM tool_invocations ORDER BY seq',
        )
        .all(),
      tool_usage_rollup: db
        .prepare(
          'SELECT agent, tool_calls, tool_errors, redundant_reads, permission_asks, first_productive_turn FROM tool_usage_rollup ORDER BY agent',
        )
        .all(),
    });
  }

  it('live fold → snapshot → rebuildAll → snapshot is byte-equal (non-vacuous)', () => {
    const pid = 'p-tool-replay';
    const store = openProjectStore(pid);
    const projectors = [new ToolUsageProjector()];
    const sequence = [
      makeToolInvokedEvent(pid, { agent: 'a1', task: 't1', tool: 'Read', turn: 0, ok: true }),
      makeToolInvokedEvent(pid, {
        agent: 'a1',
        task: 't1',
        tool: 'Read',
        turn: 0,
        ok: true,
        redundant_read: true,
      }),
      makeToolInvokedEvent(pid, {
        agent: 'a1',
        task: 't1',
        tool: 'co_finish',
        turn: 1,
        ok: true,
        duration_ms: 42,
      }),
      makeToolInvokedEvent(pid, {
        agent: 'a2',
        task: 't2',
        tool: 'Bash',
        turn: 0,
        ok: false,
        permission_ask: true,
      }),
    ];
    try {
      for (const e of sequence) {
        store.transaction((tx) => {
          const [s] = tx.append([e]);
          applyEvent(tx, decode(s!, dispatchUpcasters, dispatchSchemas), projectors);
        });
      }
      const live = store.transaction((tx) => snapshot(tx.raw as DatabaseSync));

      rebuildAll(store, projectors, (e) => decode(e, dispatchUpcasters, dispatchSchemas));
      const replayed = store.transaction((tx) => snapshot(tx.raw as DatabaseSync));

      expect(replayed).toBe(live);
      // Guard against a vacuous pass.
      expect(live).toContain('"agent":"a1","tool_calls":3');
      expect(live).toContain('"first_productive_turn":1');
      expect(live).toContain('"agent":"a2","tool_calls":1');
      expect(live).toContain('"duration_ms":42');
    } finally {
      store.close();
    }
  });

  it('a duplicate-seq re-fold never double-counts the rollup', () => {
    const pid = 'p-tool-dedupe';
    const store = openProjectStore(pid);
    const projector = new ToolUsageProjector();
    try {
      const built = makeToolInvokedEvent(pid, {
        agent: 'a1',
        task: 't1',
        tool: 'co_finish',
        turn: 0,
        ok: true,
      });
      store.transaction((tx) => {
        const [s] = tx.append([built]);
        const decoded = decode(s!, dispatchUpcasters, dispatchSchemas);
        // Apply the SAME stored event twice — the second is an idempotent no-op (keyed by seq).
        applyEvent(tx, decoded, [projector]);
        applyEvent(tx, decoded, [projector]);
        const usage = selectAgentToolUsage(tx.raw as DatabaseSync, 'a1');
        expect(usage?.toolCalls).toBe(1);
        expect(selectAllAgentToolUsage(tx.raw as DatabaseSync)).toHaveLength(1);
      });
    } finally {
      store.close();
    }
  });
});
