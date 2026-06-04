import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../store/suppress-sqlite-warning.js';
import { DatabaseSync } from 'node:sqlite';
import {
  CodexUsageSource,
  CODEX_DEFAULT_ACCOUNT,
  defaultCodexDeps,
  openCodexLogsDb,
  parseCodexDoctor,
  parseCodexRateLimits,
  readLatestCodexRateLimits,
  readLatestRolloutRateLimits,
  type CodexUsageSourceDeps,
} from './codex-source.js';
import { UsageUnavailableError, type UsageSnapshot } from './usage-source.js';

const FIXED_NOW = Date.parse('2026-06-03T00:00:00.000Z');
const now = () => FIXED_NOW;
const SAMPLED_AT = '2026-06-03T00:00:00.000Z';

// A representative `codex.rate_limits` payload (verified field names + tolerated noise).
const rateLimitsPayload = {
  plan: 'pro',
  allowed: true,
  primary: { used_percent: 55, window_minutes: 300, reset_at: '2026-06-03T05:00:00.000Z' },
  secondary: { used_percent: 20, window_minutes: 10080, reset_at: '2026-06-10T00:00:00.000Z' },
};

// The VERIFIED live `codex.rate_limits` payload — the latest of the 12 found on the host by the live E2E
// (spec §6b). Note `reset_at` is a NUMBER of epoch SECONDS (not an ISO string), and the relative field is
// `reset_after_seconds`; both are the shapes the Phase-6 parser dropped on real data.
const realRateLimitsEvent = {
  type: 'codex.rate_limits',
  plan_type: 'pro',
  rate_limits: {
    allowed: true,
    limit_reached: false,
    primary: {
      used_percent: 11,
      window_minutes: 300,
      reset_after_seconds: 15247,
      reset_at: 1780538257,
    },
    secondary: {
      used_percent: 8,
      window_minutes: 10080,
      reset_after_seconds: 391881,
      reset_at: 1780914891,
    },
  },
  code_review_rate_limits: null,
  additional_rate_limits: { 'GPT-5.3-Codex-Spark': {} },
  credits: null,
};

// The epoch-SECONDS reset_at values converted to ISO, as the fixed adapter must produce them.
const PRIMARY_RESET_ISO = new Date(1780538257 * 1000).toISOString();
const SECONDARY_RESET_ISO = new Date(1780914891 * 1000).toISOString();

// A REAL `feedback_log_body`: an OpenTelemetry span-context prefix targeting the responses websocket, then
// the `websocket event: {…JSON…}` marker — i.e. NOT pure JSON (the body shape that caused Bug 1).
const prefixedRealBody = (event: unknown): string =>
  'level=INFO trace_id=4b1e9a span_id=9f02 target=codex_api::endpoint::responses_websocket ' +
  'websocket event: ' +
  JSON.stringify(event);

function depsWith(over: Partial<CodexUsageSourceDeps>): CodexUsageSourceDeps {
  return {
    doctor: () => Promise.resolve({ healthy: true, account: CODEX_DEFAULT_ACCOUNT }),
    readRateLimits: () => Promise.resolve(rateLimitsPayload),
    now,
    ...over,
  };
}

describe('parseCodexRateLimits — passive codex.rate_limits parse (verified field names, defensive)', () => {
  it('parses primary + secondary windows, plan, and allowed', () => {
    const reading = parseCodexRateLimits(rateLimitsPayload, SAMPLED_AT);
    expect(reading.account).toBe('codex:pro');
    expect(reading.available).toBe(true);
    expect(reading.windows).toEqual([
      { kind: 'primary', used_pct: 55, reset_at: '2026-06-03T05:00:00.000Z' },
      { kind: 'secondary', used_pct: 20, reset_at: '2026-06-10T00:00:00.000Z' },
    ]);
  });

  it('marks unavailable when allowed is false (over-limit)', () => {
    const reading = parseCodexRateLimits({ ...rateLimitsPayload, allowed: false }, SAMPLED_AT);
    expect(reading.available).toBe(false);
  });

  it('derives reset_at from a relative resets_in_seconds against the sample time', () => {
    const reading = parseCodexRateLimits(
      { primary: { used_percent: 10, window_minutes: 300, resets_in_seconds: 3600 } },
      SAMPLED_AT,
    );
    expect(reading.windows).toEqual([
      { kind: 'primary', used_pct: 10, reset_at: '2026-06-03T01:00:00.000Z' },
    ]);
  });

  it('unwraps a token_count / rate_limits envelope (session-jsonl shape)', () => {
    const enveloped = {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 33, reset_at: '2026-06-03T05:00:00.000Z' },
      },
    };
    const reading = parseCodexRateLimits(enveloped, SAMPLED_AT);
    expect(reading.windows).toEqual([
      { kind: 'primary', used_pct: 33, reset_at: '2026-06-03T05:00:00.000Z' },
    ]);
  });

  it('yields zero windows for an unparseable / empty payload', () => {
    expect(parseCodexRateLimits(null, SAMPLED_AT).windows).toEqual([]);
    expect(parseCodexRateLimits({ unrelated: true }, SAMPLED_AT).windows).toEqual([]);
  });
});

describe('parseCodexRateLimits — REAL live payload (Phase 6b: numeric epoch-seconds reset_at + reset_after_seconds)', () => {
  it('parses the real primary 11% / secondary 8% windows, converting epoch-seconds reset_at → valid ISO', () => {
    const reading = parseCodexRateLimits(realRateLimitsEvent, SAMPLED_AT);
    expect(reading.account).toBe('codex:pro');
    expect(reading.available).toBe(true);
    expect(reading.windows).toEqual([
      { kind: 'primary', used_pct: 11, reset_at: PRIMARY_RESET_ISO },
      { kind: 'secondary', used_pct: 8, reset_at: SECONDARY_RESET_ISO },
    ]);
    // Every window carries a VALID ISO reset_at (proves the numeric epoch-seconds reset_at is converted).
    for (const window of reading.windows) {
      expect(Number.isNaN(Date.parse(window.reset_at))).toBe(false);
    }
    const primary = reading.windows.find((w) => w.kind === 'primary');
    expect(primary?.reset_at).toBe(new Date(1780538257 * 1000).toISOString());
  });

  it('still derives reset_at from `reset_after_seconds` when no explicit reset_at is present', () => {
    const reading = parseCodexRateLimits(
      { primary: { used_percent: 11, window_minutes: 300, reset_after_seconds: 3600 } },
      SAMPLED_AT,
    );
    expect(reading.windows).toEqual([
      { kind: 'primary', used_pct: 11, reset_at: '2026-06-03T01:00:00.000Z' },
    ]);
  });
});

describe('parseCodexDoctor — metadata preflight (defensive)', () => {
  it('reads a plan into an account label and treats the toolchain as healthy by default', () => {
    expect(parseCodexDoctor({ plan: 'Pro' })).toEqual({ healthy: true, account: 'codex:pro' });
    expect(parseCodexDoctor({})).toEqual({ healthy: true, account: CODEX_DEFAULT_ACCOUNT });
  });

  it('marks unhealthy on an explicit failing signal', () => {
    expect(parseCodexDoctor({ authenticated: false }).healthy).toBe(false);
    expect(parseCodexDoctor({ status: 'logged-out' }).healthy).toBe(false);
  });
});

describe('CodexUsageSource.read — layered passive-first, fail-loud', () => {
  it('returns a sqlite passive snapshot (primary + secondary) when healthy', async () => {
    const snap = await new CodexUsageSource(depsWith({})).read('codex');
    const expected: UsageSnapshot = {
      provider: 'codex',
      account: 'codex:pro',
      windows: [
        { kind: 'primary', used_pct: 55, reset_at: '2026-06-03T05:00:00.000Z' },
        { kind: 'secondary', used_pct: 20, reset_at: '2026-06-10T00:00:00.000Z' },
      ],
      available: true,
      source: 'sqlite',
      sampled_at: SAMPLED_AT,
    };
    expect(snap).toEqual(expected);
  });

  it('an unhealthy preflight wins immediately as an unavailable snapshot', async () => {
    const snap = await new CodexUsageSource(
      depsWith({
        doctor: () => Promise.resolve({ healthy: false, account: CODEX_DEFAULT_ACCOUNT }),
        readRateLimits: () => Promise.reject(new Error('sqlite should not win')),
      }),
    ).read('codex');
    expect(snap.available).toBe(false);
    expect(snap.source).toBe('doctor');
  });

  it('falls back sqlite → app-server → session jsonl in order', async () => {
    const snap = await new CodexUsageSource(
      depsWith({
        readRateLimits: () => Promise.resolve(undefined), // sqlite: nothing
        appServerRead: () => Promise.reject(new Error('app-server absent')), // active: errors
        sessionRollout: () => Promise.resolve(rateLimitsPayload), // fallback wins
      }),
    ).read('codex');
    expect(snap.source).toBe('session-jsonl');
    expect(snap.windows).toHaveLength(2);
  });

  it('throws UsageUnavailableError when every source yields nothing (fail-loud)', async () => {
    await expect(
      new CodexUsageSource(depsWith({ readRateLimits: () => Promise.resolve(undefined) })).read(
        'codex',
      ),
    ).rejects.toBeInstanceOf(UsageUnavailableError);
  });
});

// ── The real default seams against representative on-disk fixtures (host-validated schema) ──────────
describe('readLatestCodexRateLimits — read-only sqlite scan over a representative logs_2.sqlite', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'co-codex-db-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('extracts the latest rate_limits payload from a representative schema, read-only', () => {
    const dbPath = join(dir, 'logs_2.sqlite');
    const seed = new DatabaseSync(dbPath);
    seed.exec('CREATE TABLE log (id INTEGER PRIMARY KEY, type TEXT, body TEXT)');
    const insert = seed.prepare('INSERT INTO log (type, body) VALUES (?, ?)');
    insert.run('session.start', JSON.stringify({ hello: 'world' }));
    insert.run(
      'codex.rate_limits',
      JSON.stringify({
        ...rateLimitsPayload,
        primary: { used_percent: 11, reset_at: '2026-06-03T04:00:00.000Z' },
      }),
    );
    insert.run('codex.rate_limits', JSON.stringify(rateLimitsPayload)); // newest
    seed.close();

    const db = openCodexLogsDb(dbPath); // read-only open
    try {
      const payload = readLatestCodexRateLimits(db);
      const reading = parseCodexRateLimits(payload, SAMPLED_AT);
      expect(reading.windows).toEqual([
        { kind: 'primary', used_pct: 55, reset_at: '2026-06-03T05:00:00.000Z' },
        { kind: 'secondary', used_pct: 20, reset_at: '2026-06-10T00:00:00.000Z' },
      ]);
    } finally {
      db.close();
    }
  });

  it('extracts the latest REAL prefixed websocket-event body, past prose noise and an older real event', () => {
    const dbPath = join(dir, 'logs_2.sqlite');
    const seed = new DatabaseSync(dbPath);
    // The host shape: a `feedback_log_body` TEXT column holding OTel-prefixed event bodies + prose.
    seed.exec('CREATE TABLE telemetry (id INTEGER PRIMARY KEY, feedback_log_body TEXT)');
    const insert = seed.prepare('INSERT INTO telemetry (feedback_log_body) VALUES (?)');
    // (1) assistant-message PROSE that merely mentions the event — must NOT be mistaken for an event.
    insert.run(
      'In the codex.rate_limits research session we saw used_percent and window_minutes per window.',
    );
    // (2) an OLDER genuine event (lower rowid) — should lose to the latest by rowid.
    insert.run(
      prefixedRealBody({
        ...realRateLimitsEvent,
        rate_limits: {
          ...realRateLimitsEvent.rate_limits,
          primary: { ...realRateLimitsEvent.rate_limits.primary, used_percent: 99 },
        },
      }),
    );
    // (3) the LATEST genuine event (highest-rowid real event) — the signature filter must pick THIS one.
    insert.run(prefixedRealBody(realRateLimitsEvent));
    // (4) MORE prose AFTER the real event (even higher rowid) — proves the signature filter, not a blind
    //     "newest row" scan, selects the event.
    insert.run('Follow-up note: those used_percent / codex.rate_limits figures look right.');
    seed.close();

    const db = openCodexLogsDb(dbPath); // read-only open
    try {
      const payload = readLatestCodexRateLimits(db);
      const reading = parseCodexRateLimits(payload, SAMPLED_AT);
      expect(reading.account).toBe('codex:pro');
      expect(reading.windows).toEqual([
        { kind: 'primary', used_pct: 11, reset_at: PRIMARY_RESET_ISO },
        { kind: 'secondary', used_pct: 8, reset_at: SECONDARY_RESET_ISO },
      ]);
      expect(reading.windows.every((w) => !Number.isNaN(Date.parse(w.reset_at)))).toBe(true);
    } finally {
      db.close();
    }
  });

  it('returns undefined when no rate_limits row exists', () => {
    const dbPath = join(dir, 'empty.sqlite');
    const seed = new DatabaseSync(dbPath);
    seed.exec('CREATE TABLE log (id INTEGER PRIMARY KEY, body TEXT)');
    seed.prepare('INSERT INTO log (body) VALUES (?)').run(JSON.stringify({ nothing: true }));
    seed.close();

    const db = openCodexLogsDb(dbPath);
    try {
      expect(readLatestCodexRateLimits(db)).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe('readLatestRolloutRateLimits — session jsonl fallback over a representative rollout file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'co-codex-sessions-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('tails the newest rollout-*.jsonl for the last rate_limits line', async () => {
    const sub = join(dir, '2026', '06', '03');
    mkdirSync(sub, { recursive: true });
    const lines = [
      JSON.stringify({ type: 'session.start' }),
      JSON.stringify({
        type: 'token_count',
        rate_limits: { primary: { used_percent: 77, reset_at: '2026-06-03T05:00:00.000Z' } },
      }),
      JSON.stringify({ type: 'message' }),
    ];
    writeFileSync(join(sub, 'rollout-2026-06-03.jsonl'), lines.join('\n') + '\n');

    const payload = await readLatestRolloutRateLimits(dir);
    const reading = parseCodexRateLimits(payload, SAMPLED_AT);
    expect(reading.windows).toEqual([
      { kind: 'primary', used_pct: 77, reset_at: '2026-06-03T05:00:00.000Z' },
    ]);
  });

  it('returns undefined for a missing sessions dir (tolerant)', async () => {
    expect(await readLatestRolloutRateLimits(join(dir, 'does-not-exist'))).toBeUndefined();
  });
});

describe('defaultCodexDeps — wired with real seams, app-server absent (detect & fall back)', () => {
  it('omits the active app-server seam by default but keeps doctor / sqlite / session', () => {
    const deps = defaultCodexDeps({ now });
    expect(Object.keys(deps).sort()).toEqual(['doctor', 'now', 'readRateLimits', 'sessionRollout']);
    expect(deps.appServerRead).toBeUndefined();
  });
});
