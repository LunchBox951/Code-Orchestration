import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../store/suppress-sqlite-warning.js';
import { DatabaseSync } from 'node:sqlite';
import { parseClaudeTranscriptTurnCost } from './claude-source.js';
import {
  parseCodexTokenCount,
  readLatestCodexTokenCount,
  readLatestCodexTokenCountReadout,
  openCodexLogsDb,
} from './codex-source.js';
import { openDispatchStore } from './dispatch-store.js';

// ── Program-data dir per test ────────────────────────────────────────────────────────────────────
const ORIGINAL_ENV = process.env;
let dataDir = '';
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'co-cost-source-'));
  process.env = { ...ORIGINAL_ENV, CO_DATA_DIR: dataDir };
});
afterEach(() => {
  process.env = ORIGINAL_ENV;
  rmSync(dataDir, { recursive: true, force: true });
});

// ── Claude transcript JSONL fixtures (assistant-message `usage` = the verified field mapping) ──────
const claudeTranscript = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' } }),
  JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      usage: {
        input_tokens: 120,
        output_tokens: 340,
        cache_read_input_tokens: 9000,
        cache_creation_input_tokens: 1500,
      },
    },
  }),
  // A `result` line carrying the stream-json total_cost_usd.
  JSON.stringify({ type: 'result', total_cost_usd: 0.0731, subtype: 'success' }),
].join('\n');

describe('parseClaudeTranscriptTurnCost — the assistant-message usage + result cost', () => {
  it('reads the latest assistant usage tokens AND the result total_cost_usd', () => {
    const cost = parseClaudeTranscriptTurnCost(claudeTranscript);
    expect(cost).toEqual({
      inputTokens: 120,
      outputTokens: 340,
      cacheReadInputTokens: 9000,
      cacheCreationInputTokens: 1500,
      costUsd: 0.0731,
    });
  });

  it('sums every assistant usage record in the supplied turn slice', () => {
    const jsonl = [
      JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 1, output_tokens: 1 } },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 99, output_tokens: 88 } },
      }),
    ].join('\n');
    const cost = parseClaudeTranscriptTurnCost(jsonl);
    expect(cost?.inputTokens).toBe(100);
    expect(cost?.outputTokens).toBe(89);
  });

  it('does not attach an older result cost after a later assistant usage resets cost pairing', () => {
    const jsonl = [
      JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 10, output_tokens: 20 } },
      }),
      JSON.stringify({ type: 'result', total_cost_usd: 0.01, subtype: 'success' }),
      JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 30, output_tokens: 40 } },
      }),
    ].join('\n');
    const cost = parseClaudeTranscriptTurnCost(jsonl);
    expect(cost).toEqual({ inputTokens: 40, outputTokens: 60 });
  });

  it('pairs result cost with the usage slice when a result follows the latest assistant usage', () => {
    const jsonl = [
      JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 10, output_tokens: 20 } },
      }),
      JSON.stringify({ type: 'result', total_cost_usd: 0.01, subtype: 'success' }),
      JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 30, output_tokens: 40 } },
      }),
      JSON.stringify({ type: 'result', total_cost_usd: 0.03, subtype: 'success' }),
    ].join('\n');
    const cost = parseClaudeTranscriptTurnCost(jsonl);
    expect(cost).toEqual({ inputTokens: 40, outputTokens: 60, costUsd: 0.03 });
  });

  it('can record a result-only slice as dollar cost', () => {
    const cost = parseClaudeTranscriptTurnCost(
      JSON.stringify({ type: 'result', total_cost_usd: 0.04, subtype: 'success' }),
    );
    expect(cost).toEqual({ costUsd: 0.04 });
  });

  it('tolerates a truncated trailing line (fail-soft) and skips it', () => {
    const cost = parseClaudeTranscriptTurnCost(claudeTranscript + '\n{ "type": "assistant", "mess');
    expect(cost?.inputTokens).toBe(120);
  });

  it('returns undefined when no usage and no cost are present', () => {
    expect(parseClaudeTranscriptTurnCost('')).toBeUndefined();
    expect(parseClaudeTranscriptTurnCost('not json\nstill not json')).toBeUndefined();
    expect(
      parseClaudeTranscriptTurnCost(JSON.stringify({ type: 'system', subtype: 'init' })),
    ).toBeUndefined();
  });
});

// ── Codex logs_2.sqlite token_count fixtures (the verified websocket-event body shape) ─────────────
const OTEL_PREFIX = '[2026-06-03T00:00:00Z] span_context{trace_id=abc} responses websocket event: ';

const codexTokenCountObject = {
  type: 'token_count',
  info: {
    total_token_usage: { input_tokens: 4321, output_tokens: 678, total_tokens: 4999 },
  },
  rate_limits: {
    primary: { used_percent: 12.5, window_minutes: 300, resets_in_seconds: 1000 },
  },
};

function codexResponseCompletedBody(overrides: Partial<Record<string, number>> = {}): string {
  const input = overrides.input_token_count ?? 1234;
  const output = overrides.output_token_count ?? 56;
  return (
    'event.name="codex.sse_event" event.kind=response.completed ' +
    `input_token_count=${input} output_token_count=${output} ` +
    'cached_token_count=100 reasoning_token_count=7 ' +
    `tool_token_count=${input + output} event.timestamp=2026-06-22T20:22:34.682Z ` +
    'conversation.id=019ef0fe-a3d5-72d1-b4c5-539e9a174a4a model=gpt-5.5'
  );
}

function codexPostSamplingBody(total = 57314): string {
  return (
    'session_loop{thread_id=019ef0fe-a3d5}:turn{turn.id=019ef0fe-a6a9}:session_task.run: ' +
    `post sampling token usage turn_id=019ef0fe-a6a9 total_usage_tokens=${total} ` +
    'auto_compact_scope_tokens=57314 estimated_token_count=Some(54615) token_limit_reached=false'
  );
}

/** The REAL feedback_log_body shape: OTel prefix + `websocket event: {…JSON…}` + trailing prose. */
function codexTokenCountBody(): string {
  return (
    OTEL_PREFIX + JSON.stringify(codexTokenCountObject) + ' trailing prose that should be ignored'
  );
}

describe('parseCodexTokenCount — token counts + usage-% (no dollars; Codex has no price table)', () => {
  it('reads input/output/total tokens and the primary window used_percent (flags cumulative)', () => {
    // The fixture carries only `total_token_usage` (session-cumulative) → cumulative: true so the
    // collection caller knows to record the per-turn DELTA, not this running total verbatim.
    const cost = parseCodexTokenCount(codexTokenCountObject);
    expect(cost).toEqual({
      inputTokens: 4321,
      outputTokens: 678,
      totalTokens: 4999,
      usedPct: 12.5,
      cumulative: true,
    });
  });

  it('PREFERS per-turn last_token_usage over the cumulative total_token_usage (not cumulative)', () => {
    const payload = {
      type: 'token_count',
      info: {
        // Codex emits BOTH: total_token_usage (session-running) and last_token_usage (this turn).
        total_token_usage: { input_tokens: 9000, output_tokens: 3000, total_tokens: 12000 },
        last_token_usage: { input_tokens: 120, output_tokens: 60, total_tokens: 180 },
      },
    };
    const cost = parseCodexTokenCount(payload);
    expect(cost).toEqual({ inputTokens: 120, outputTokens: 60, totalTokens: 180 });
    // No `cumulative` flag — last_token_usage is already the per-turn delta.
    expect(cost?.cumulative).toBeUndefined();
  });

  it('returns undefined for a payload with no token fields', () => {
    expect(parseCodexTokenCount({ type: 'something_else' })).toBeUndefined();
    expect(parseCodexTokenCount(null)).toBeUndefined();
  });
});

describe('readLatestCodexTokenCount — pin the latest genuine token_count event in logs_2.sqlite', () => {
  function seedDb(): string {
    const dbPath = join(dataDir, 'logs_2.sqlite');
    const seed = new DatabaseSync(dbPath);
    seed.exec('CREATE TABLE telemetry (id INTEGER PRIMARY KEY, feedback_log_body TEXT)');
    const insert = seed.prepare('INSERT INTO telemetry (feedback_log_body) VALUES (?)');
    // prose that merely MENTIONS token_count must not be mistaken for the event.
    insert.run('assistant: I will count tokens (token_count) but this is prose, not an event.');
    insert.run(codexTokenCountBody());
    seed.close();
    return dbPath;
  }

  it('extracts the embedded JSON of the newest token_count websocket event', () => {
    const dbPath = seedDb();
    const db = openCodexLogsDb(dbPath);
    try {
      const payload = readLatestCodexTokenCount(db);
      expect(payload).toBeDefined();
      const cost = parseCodexTokenCount(payload);
      expect(cost?.inputTokens).toBe(4321);
      expect(cost?.totalTokens).toBe(4999);
    } finally {
      db.close();
    }
  });

  it('extracts current response.completed token rows from logs_2.sqlite', () => {
    const dbPath = join(dataDir, 'logs_2.sqlite');
    const seed = new DatabaseSync(dbPath);
    seed.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, feedback_log_body TEXT)');
    const insert = seed.prepare('INSERT INTO logs (ts, feedback_log_body) VALUES (?, ?)');
    insert.run(1, 'assistant prose mentioning response.completed input_token_count=999');
    insert.run(2, codexResponseCompletedBody({ input_token_count: 321, output_token_count: 45 }));
    seed.close();

    const db = openCodexLogsDb(dbPath);
    try {
      const payload = readLatestCodexTokenCount(db);
      expect(payload).toBeDefined();
      const cost = parseCodexTokenCount(payload);
      expect(cost).toEqual({ inputTokens: 321, outputTokens: 45, totalTokens: 366 });
    } finally {
      db.close();
    }
  });

  it('falls back to current post-sampling cumulative token rows when response.completed is absent', () => {
    const dbPath = join(dataDir, 'logs_2.sqlite');
    const seed = new DatabaseSync(dbPath);
    seed.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, feedback_log_body TEXT)');
    seed
      .prepare('INSERT INTO logs (ts, feedback_log_body) VALUES (?, ?)')
      .run(1, codexPostSamplingBody(98765));
    seed.close();

    const db = openCodexLogsDb(dbPath);
    try {
      const payload = readLatestCodexTokenCount(db);
      expect(payload).toBeDefined();
      const cost = parseCodexTokenCount(payload);
      expect(cost).toEqual({ totalTokens: 98765, cumulative: true });
    } finally {
      db.close();
    }
  });

  it('chooses the newest token row across all supported Codex token signatures', () => {
    const dbPath = join(dataDir, 'logs_2.sqlite');
    const seed = new DatabaseSync(dbPath);
    seed.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, feedback_log_body TEXT)');
    const insert = seed.prepare('INSERT INTO logs (ts, feedback_log_body) VALUES (?, ?)');
    insert.run(1, codexResponseCompletedBody({ input_token_count: 321, output_token_count: 45 }));
    insert.run(2, codexPostSamplingBody(98765));
    seed.close();

    const db = openCodexLogsDb(dbPath);
    try {
      const payload = readLatestCodexTokenCount(db);
      expect(payload).toBeDefined();
      const cost = parseCodexTokenCount(payload);
      expect(cost).toEqual({ totalTokens: 98765, cumulative: true });
    } finally {
      db.close();
    }
  });

  it('can continue Codex token reads from a prior source cursor', () => {
    const dbPath = join(dataDir, 'logs_2.sqlite');
    const seed = new DatabaseSync(dbPath);
    seed.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, feedback_log_body TEXT)');
    const insert = seed.prepare('INSERT INTO logs (ts, feedback_log_body) VALUES (?, ?)');
    insert.run(1, codexResponseCompletedBody({ input_token_count: 10, output_token_count: 2 }));
    seed.close();

    const firstDb = openCodexLogsDb(dbPath);
    const first = readLatestCodexTokenCountReadout(firstDb);
    firstDb.close();
    expect(first).toBeDefined();

    const noneDb = openCodexLogsDb(dbPath);
    try {
      expect(
        readLatestCodexTokenCountReadout(noneDb, { afterSourceId: first!.sourceId }),
      ).toBeUndefined();
    } finally {
      noneDb.close();
    }

    const append = new DatabaseSync(dbPath);
    const appendRow = append.prepare('INSERT INTO logs (ts, feedback_log_body) VALUES (?, ?)');
    appendRow.run(2, codexPostSamplingBody(1000));
    for (let i = 0; i < 75; i++) {
      appendRow.run(3 + i, `noise row ${i}`);
    }
    append.close();

    const secondDb = openCodexLogsDb(dbPath);
    try {
      const second = readLatestCodexTokenCountReadout(secondDb, {
        afterSourceId: first!.sourceId,
      });
      expect(parseCodexTokenCount(second?.payload)).toEqual({
        totalTokens: 1000,
        cumulative: true,
      });
    } finally {
      secondDb.close();
    }
  });
});

// ── End-to-end: parsed cost → DispatchStore.recordCost (the collection seam the host wires) ────────
describe('parsed per-turn cost → recordCost (the production collection path)', () => {
  it('Claude transcript usage rolls up into the agent cost rollup with cache tokens + dollars', () => {
    const store = openDispatchStore('p-claude-cost');
    try {
      const parsed = parseClaudeTranscriptTurnCost(claudeTranscript);
      expect(parsed).toBeDefined();
      store.recordCost({
        provider: 'claude',
        agent: 'impl-1',
        task: 'impl-1',
        turn: 0,
        ...(parsed!.inputTokens !== undefined ? { input_tokens: parsed!.inputTokens } : {}),
        ...(parsed!.outputTokens !== undefined ? { output_tokens: parsed!.outputTokens } : {}),
        ...(parsed!.cacheReadInputTokens !== undefined
          ? { cache_read_input_tokens: parsed!.cacheReadInputTokens }
          : {}),
        ...(parsed!.cacheCreationInputTokens !== undefined
          ? { cache_creation_input_tokens: parsed!.cacheCreationInputTokens }
          : {}),
        ...(parsed!.costUsd !== undefined ? { cost_usd: parsed!.costUsd } : {}),
      });
      const rollup = store.getAgentCostRollup('impl-1');
      expect(rollup).toEqual({
        agentId: 'impl-1',
        inputTokens: 120,
        outputTokens: 340,
        cacheReadTokens: 9000,
        cacheCreationTokens: 1500,
        totalTokens: 460, // input + output (no explicit total in the transcript)
        costUsd: 0.0731,
      });
    } finally {
      store.close();
    }
  });

  it('Codex token_count rolls up with tokens + usage-% and a null dollar cost', () => {
    const store = openDispatchStore('p-codex-cost');
    try {
      const parsed = parseCodexTokenCount(codexTokenCountObject);
      expect(parsed).toBeDefined();
      store.recordCost({
        provider: 'codex',
        agent: 'impl-2',
        task: 'impl-2',
        turn: 0,
        ...(parsed!.inputTokens !== undefined ? { input_tokens: parsed!.inputTokens } : {}),
        ...(parsed!.outputTokens !== undefined ? { output_tokens: parsed!.outputTokens } : {}),
        ...(parsed!.totalTokens !== undefined ? { total_tokens: parsed!.totalTokens } : {}),
        ...(parsed!.usedPct !== undefined ? { used_pct: parsed!.usedPct } : {}),
      });
      const rollup = store.getAgentCostRollup('impl-2');
      expect(rollup?.totalTokens).toBe(4999);
      expect(rollup?.costUsd).toBeNull();
      expect(rollup?.cacheReadTokens).toBe(0);
    } finally {
      store.close();
    }
  });
});
