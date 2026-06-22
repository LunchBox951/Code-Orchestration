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

  it('returns the MOST-RECENT assistant usage when several are present', () => {
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
    expect(cost?.inputTokens).toBe(99);
    expect(cost?.outputTokens).toBe(88);
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
