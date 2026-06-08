import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import '../store/suppress-sqlite-warning.js';
import { DatabaseSync } from 'node:sqlite';
import {
  CodexUsageSource,
  CODEX_DOCTOR_ARGS,
  CODEX_DEFAULT_ACCOUNT,
  defaultCodexDeps,
  openCodexLogsDb,
  parseCodexDoctor,
  parseCodexRateLimits,
  readLatestCodexRateLimits,
  readLatestRolloutRateLimits,
  type CodexCli,
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

  it('prefers an explicit canonical account label over plan fallback', () => {
    const reading = parseCodexRateLimits(
      {
        account: 'codex:team',
        plan: 'pro',
        primary: { used_percent: 5, reset_at: '2026-06-03T05:00:00.000Z' },
      },
      SAMPLED_AT,
    );

    expect(reading.account).toBe('codex:team');
  });

  it('ignores generic envelope ids when deriving account metadata', () => {
    const reading = parseCodexRateLimits(
      {
        id: 'evt_123',
        result: {
          plan_type: 'pro',
          rate_limits: {
            primary: { used_percent: 5, reset_at: '2026-06-03T05:00:00.000Z' },
          },
        },
      },
      SAMPLED_AT,
    );

    expect(reading.account).toBe('codex:pro');
    expect(reading.accountObserved).toBe(false);
  });

  it('accepts raw ids only inside scoped account metadata', () => {
    const reading = parseCodexRateLimits(
      {
        result: {
          account: { id: 'team', plan: 'pro' },
          rate_limits: {
            primary: { used_percent: 5, reset_at: '2026-06-03T05:00:00.000Z' },
          },
        },
      },
      SAMPLED_AT,
    );

    expect(reading.account).toBe('codex:team');
    expect(reading.accountObserved).toBe(true);
  });

  it('marks unavailable when allowed is false (over-limit)', () => {
    const reading = parseCodexRateLimits({ ...rateLimitsPayload, allowed: false }, SAMPLED_AT);
    expect(reading.available).toBe(false);
  });

  it('marks unavailable when allowed is false on the parent envelope', () => {
    const reading = parseCodexRateLimits(
      {
        data: {
          plan: 'pro',
          allowed: false,
          rate_limits: {
            primary: { used_percent: 44, reset_at: '2026-06-03T05:00:00.000Z' },
          },
        },
      },
      SAMPLED_AT,
    );

    expect(reading.account).toBe('codex:pro');
    expect(reading.available).toBe(false);
    expect(reading.windows).toEqual([
      { kind: 'primary', used_pct: 44, reset_at: '2026-06-03T05:00:00.000Z' },
    ]);
  });

  it('uses deny-wins availability across parent and nested envelopes', () => {
    const allowedConflict = parseCodexRateLimits(
      {
        data: {
          allowed: false,
          rate_limits: {
            allowed: true,
            primary: { used_percent: 44, reset_at: '2026-06-03T05:00:00.000Z' },
          },
        },
      },
      SAMPLED_AT,
    );
    const limitConflict = parseCodexRateLimits(
      {
        data: {
          limit_reached: true,
          rate_limits: {
            limit_reached: false,
            primary: { used_percent: 44, reset_at: '2026-06-03T05:00:00.000Z' },
          },
        },
      },
      SAMPLED_AT,
    );

    expect(allowedConflict.available).toBe(false);
    expect(limitConflict.available).toBe(false);
  });

  it('marks unavailable when limit_reached is true even if allowed remains true', () => {
    const reading = parseCodexRateLimits(
      {
        ...rateLimitsPayload,
        rate_limits: {
          allowed: true,
          limit_reached: true,
          primary: { used_percent: 100, reset_at: '2026-06-03T05:00:00.000Z' },
        },
      },
      SAMPLED_AT,
    );

    expect(reading.available).toBe(false);
    expect(reading.windows).toEqual([
      { kind: 'primary', used_pct: 100, reset_at: '2026-06-03T05:00:00.000Z' },
    ]);
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
    expect(parseCodexDoctor({ plan: 'Pro' })).toEqual({
      healthy: true,
      account: 'codex:pro',
      accountObserved: false,
    });
    expect(parseCodexDoctor({})).toEqual({
      healthy: true,
      account: CODEX_DEFAULT_ACCOUNT,
      accountObserved: false,
    });
  });

  it('prefers an explicit canonical account label over plan fallback', () => {
    expect(parseCodexDoctor({ account: 'codex:team', plan: 'Pro' })).toEqual({
      healthy: true,
      account: 'codex:team',
      accountObserved: true,
    });
  });

  it('reads nested account metadata and namespaces explicit raw account ids', () => {
    expect(parseCodexDoctor({ account: { plan: 'Pro' } })).toEqual({
      healthy: true,
      account: 'codex:pro',
      accountObserved: false,
    });
    expect(parseCodexDoctor({ account: { id: 'team', plan: 'Pro' } })).toEqual({
      healthy: true,
      account: 'codex:team',
      accountObserved: true,
    });
  });

  it('ignores generic root labels when scoped account metadata is present', () => {
    expect(parseCodexDoctor({ label: 'doctor', account: { id: 'team', plan: 'Pro' } })).toEqual({
      healthy: true,
      account: 'codex:team',
      accountObserved: true,
    });
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

  it('preserves reset windows from an over-limit rate-limit readout while marking unavailable', async () => {
    const snap = await new CodexUsageSource(
      depsWith({
        readRateLimits: () =>
          Promise.resolve({
            plan: 'pro',
            allowed: false,
            primary: { used_percent: 100, reset_at: '2026-06-03T05:00:00.000Z' },
            secondary: { used_percent: 80, reset_at: '2026-06-10T00:00:00.000Z' },
          }),
      }),
    ).read('codex');

    expect(snap.available).toBe(false);
    expect(snap.windows).toEqual([
      { kind: 'primary', used_pct: 100, reset_at: '2026-06-03T05:00:00.000Z' },
      { kind: 'secondary', used_pct: 80, reset_at: '2026-06-10T00:00:00.000Z' },
    ]);
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

  it('returns the observed account even when an explicit account option was provided', async () => {
    const snap = await new CodexUsageSource(
      depsWith({
        doctor: () => Promise.resolve({ healthy: true, account: 'codex:pro' }),
        readRateLimits: () =>
          Promise.resolve({
            plan: 'pro',
            allowed: true,
            primary: { used_percent: 4, reset_at: '2026-06-03T05:00:00.000Z' },
          }),
      }),
      { account: 'codex:team' },
    ).read('codex');

    expect(snap.account).toBe('codex:pro');
    expect(snap.source).toBe('sqlite');
  });

  it('fails loud when a requested account is not observed by defensive preflight or passive payload', async () => {
    const source = new CodexUsageSource(
      depsWith({
        doctor: () => Promise.resolve(parseCodexDoctor({})),
        readRateLimits: () =>
          Promise.resolve({
            allowed: true,
            primary: { used_percent: 4, reset_at: '2026-06-03T05:00:00.000Z' },
          }),
      }),
      { account: 'codex:team' },
    );

    await expect(source.read('codex')).rejects.toThrow(/not observed/i);
  });

  it('fails loud when requested account preflight has only a generic root label', async () => {
    const source = new CodexUsageSource(
      depsWith({
        doctor: () => Promise.resolve(parseCodexDoctor({ label: 'doctor' })),
        readRateLimits: () =>
          Promise.resolve({
            allowed: true,
            primary: { used_percent: 4, reset_at: '2026-06-03T05:00:00.000Z' },
          }),
      }),
      { account: 'codex:team' },
    );

    await expect(source.read('codex')).rejects.toThrow(/not observed/i);
  });

  it('fails loud when requested account preflight and passive payload only report plan labels', async () => {
    const source = new CodexUsageSource(
      depsWith({
        doctor: () => Promise.resolve(parseCodexDoctor({ account: { plan: 'Pro' } })),
        readRateLimits: () =>
          Promise.resolve({
            plan: 'pro',
            allowed: true,
            primary: { used_percent: 4, reset_at: '2026-06-03T05:00:00.000Z' },
          }),
      }),
      { account: 'codex:team' },
    );

    await expect(source.read('codex')).rejects.toThrow(/not observed/i);
  });

  it('fails loud when requested account passive payload has envelope ids plus plan metadata', async () => {
    const source = new CodexUsageSource(
      depsWith({
        doctor: () => Promise.resolve(parseCodexDoctor({})),
        readRateLimits: () =>
          Promise.resolve({
            id: 'evt_123',
            result: {
              plan_type: 'pro',
              rate_limits: {
                primary: { used_percent: 4, reset_at: '2026-06-03T05:00:00.000Z' },
              },
            },
          }),
      }),
      { account: 'codex:team' },
    );

    await expect(source.read('codex')).rejects.toThrow(/not observed/i);
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

  it('chooses the newest real event across all text columns, not the first matching column', () => {
    const dbPath = join(dir, 'multi-column.sqlite');
    const seed = new DatabaseSync(dbPath);
    seed.exec(
      'CREATE TABLE telemetry (id INTEGER PRIMARY KEY, feedback_log_body TEXT, feedback_log_body_2 TEXT)',
    );
    const insert = seed.prepare(
      'INSERT INTO telemetry (feedback_log_body, feedback_log_body_2) VALUES (?, ?)',
    );
    insert.run(
      prefixedRealBody({
        ...realRateLimitsEvent,
        rate_limits: {
          ...realRateLimitsEvent.rate_limits,
          primary: { ...realRateLimitsEvent.rate_limits.primary, used_percent: 99 },
        },
      }),
      null,
    );
    insert.run(null, prefixedRealBody(realRateLimitsEvent));
    seed.close();

    const db = openCodexLogsDb(dbPath);
    try {
      const payload = readLatestCodexRateLimits(db);
      const reading = parseCodexRateLimits(payload, SAMPLED_AT);
      expect(reading.windows[0]).toEqual({
        kind: 'primary',
        used_pct: 11,
        reset_at: PRIMARY_RESET_ISO,
      });
    } finally {
      db.close();
    }
  });

  it('uses table timestamps across tables and can choose newer event-column fallback over older signature rows', () => {
    const dbPath = join(dir, 'cross-table.sqlite');
    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      CREATE TABLE stale_signature (id INTEGER PRIMARY KEY, ts INTEGER, feedback_log_body TEXT);
      CREATE TABLE newer_fallback (id INTEGER PRIMARY KEY, ts INTEGER, type TEXT, body TEXT);
    `);
    const stale = seed.prepare(
      'INSERT INTO stale_signature (id, ts, feedback_log_body) VALUES (?, ?, ?)',
    );
    stale.run(
      50,
      Date.parse('2026-06-03T00:00:00.000Z'),
      prefixedRealBody({
        ...realRateLimitsEvent,
        rate_limits: {
          ...realRateLimitsEvent.rate_limits,
          primary: { ...realRateLimitsEvent.rate_limits.primary, used_percent: 99 },
        },
      }),
    );
    const newer = seed.prepare(
      'INSERT INTO newer_fallback (id, ts, type, body) VALUES (?, ?, ?, ?)',
    );
    newer.run(
      1,
      Date.parse('2026-06-03T00:01:00.000Z'),
      'codex.rate_limits',
      JSON.stringify({ type: 'codex.rate_limits', ...rateLimitsPayload }),
    );
    seed.close();

    const db = openCodexLogsDb(dbPath);
    try {
      const payload = readLatestCodexRateLimits(db);
      const reading = parseCodexRateLimits(payload, SAMPLED_AT);
      expect(reading.windows[0]).toEqual({
        kind: 'primary',
        used_pct: 55,
        reset_at: '2026-06-03T05:00:00.000Z',
      });
    } finally {
      db.close();
    }
  });

  it('does not let untrusted blind-scan fallback beat a genuine signature event', () => {
    const dbPath = join(dir, 'untrusted-fallback.sqlite');
    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      CREATE TABLE telemetry (id INTEGER PRIMARY KEY, ts INTEGER, feedback_log_body TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, ts INTEGER, body TEXT);
    `);
    seed
      .prepare('INSERT INTO telemetry (ts, feedback_log_body) VALUES (?, ?)')
      .run(Date.parse('2026-06-03T00:00:00.000Z'), prefixedRealBody(realRateLimitsEvent));
    seed.prepare('INSERT INTO messages (ts, body) VALUES (?, ?)').run(
      Date.parse('2026-06-03T00:01:00.000Z'),
      JSON.stringify({
        type: 'message',
        rate_limits: {
          primary: { used_percent: 99, reset_at: '2026-06-03T05:00:00.000Z' },
        },
      }),
    );
    seed.close();

    const db = openCodexLogsDb(dbPath);
    try {
      const payload = readLatestCodexRateLimits(db);
      const reading = parseCodexRateLimits(payload, SAMPLED_AT);
      expect(reading.windows[0]).toEqual({
        kind: 'primary',
        used_pct: 11,
        reset_at: PRIMARY_RESET_ISO,
      });
    } finally {
      db.close();
    }
  });

  it('does not let spoofed typed blind-scan JSON beat a genuine signature event', () => {
    const dbPath = join(dir, 'spoofed-typed-fallback.sqlite');
    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      CREATE TABLE telemetry (id INTEGER PRIMARY KEY, ts INTEGER, feedback_log_body TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, ts INTEGER, body TEXT);
    `);
    seed
      .prepare('INSERT INTO telemetry (ts, feedback_log_body) VALUES (?, ?)')
      .run(Date.parse('2026-06-03T00:00:00.000Z'), prefixedRealBody(realRateLimitsEvent));
    seed.prepare('INSERT INTO messages (ts, body) VALUES (?, ?)').run(
      Date.parse('2026-06-03T00:01:00.000Z'),
      JSON.stringify({
        type: 'codex.rate_limits',
        role: 'assistant',
        rate_limits: {
          primary: { used_percent: 99, reset_at: '2026-06-03T05:00:00.000Z' },
        },
      }),
    );
    seed.close();

    const db = openCodexLogsDb(dbPath);
    try {
      const payload = readLatestCodexRateLimits(db);
      const reading = parseCodexRateLimits(payload, SAMPLED_AT);
      expect(reading.windows[0]).toEqual({
        kind: 'primary',
        used_pct: 11,
        reset_at: PRIMARY_RESET_ISO,
      });
    } finally {
      db.close();
    }
  });

  it('does not let spoofed signature text outside telemetry beat a genuine signature event', () => {
    const dbPath = join(dir, 'spoofed-signature-fallback.sqlite');
    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      CREATE TABLE telemetry (id INTEGER PRIMARY KEY, ts INTEGER, feedback_log_body TEXT);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, ts INTEGER, body TEXT);
    `);
    seed
      .prepare('INSERT INTO telemetry (ts, feedback_log_body) VALUES (?, ?)')
      .run(Date.parse('2026-06-03T00:00:00.000Z'), prefixedRealBody(realRateLimitsEvent));
    seed.prepare('INSERT INTO messages (ts, body) VALUES (?, ?)').run(
      Date.parse('2026-06-03T00:01:00.000Z'),
      prefixedRealBody({
        ...realRateLimitsEvent,
        rate_limits: {
          ...realRateLimitsEvent.rate_limits,
          primary: { ...realRateLimitsEvent.rate_limits.primary, used_percent: 99 },
        },
      }),
    );
    seed.close();

    const db = openCodexLogsDb(dbPath);
    try {
      const payload = readLatestCodexRateLimits(db);
      const reading = parseCodexRateLimits(payload, SAMPLED_AT);
      expect(reading.windows[0]).toEqual({
        kind: 'primary',
        used_pct: 11,
        reset_at: PRIMARY_RESET_ISO,
      });
    } finally {
      db.close();
    }
  });

  it('ignores typed blind fallback without DB provenance', () => {
    const dbPath = join(dir, 'nested-blind-fallback.sqlite');
    const seed = new DatabaseSync(dbPath);
    seed.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT)');
    seed
      .prepare('INSERT INTO messages (body) VALUES (?)')
      .run(
        JSON.stringify({ event: { type: 'codex.rate_limits', rate_limits: rateLimitsPayload } }),
      );
    seed.close();

    const db = openCodexLogsDb(dbPath);
    try {
      const payload = readLatestCodexRateLimits(db);
      expect(payload).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('returns undefined for ambiguous timestamp-less events spread across multiple tables', () => {
    const dbPath = join(dir, 'ambiguous-tables.sqlite');
    const seed = new DatabaseSync(dbPath);
    seed.exec(`
      CREATE TABLE a_events (id INTEGER PRIMARY KEY, feedback_log_body TEXT);
      CREATE TABLE b_events (id INTEGER PRIMARY KEY, feedback_log_body TEXT);
    `);
    seed
      .prepare('INSERT INTO a_events (feedback_log_body) VALUES (?)')
      .run(prefixedRealBody(realRateLimitsEvent));
    seed.prepare('INSERT INTO b_events (feedback_log_body) VALUES (?)').run(
      prefixedRealBody({
        ...realRateLimitsEvent,
        rate_limits: {
          ...realRateLimitsEvent.rate_limits,
          primary: { ...realRateLimitsEvent.rate_limits.primary, used_percent: 99 },
        },
      }),
    );
    seed.close();

    const db = openCodexLogsDb(dbPath);
    try {
      expect(readLatestCodexRateLimits(db)).toBeUndefined();
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

  it('ignores prose/message JSON snippets that merely contain rate-limit-shaped data', async () => {
    const sub = join(dir, '2026', '06', '03');
    mkdirSync(sub, { recursive: true });
    const lines = [
      JSON.stringify({
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Example: {"rate_limits":{"primary":{"used_percent":1,"reset_at":"2026-06-03T05:00:00.000Z"}}}',
          },
        ],
      }),
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        rate_limits: {
          primary: { used_percent: 2, reset_at: '2026-06-03T05:00:00.000Z' },
        },
      }),
    ];
    writeFileSync(join(sub, 'rollout-2026-06-03.jsonl'), lines.join('\n') + '\n');

    expect(await readLatestRolloutRateLimits(dir)).toBeUndefined();
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

  it('only spawns metadata `doctor --json`, never codex exec/completion paths, and leaves app-server absent', async () => {
    const cliCalls: string[][] = [];
    const cli: CodexCli = (args) => {
      cliCalls.push([...args]);
      return Promise.resolve(JSON.stringify({ plan: 'pro' }));
    };
    const deps = defaultCodexDeps({
      cli,
      readRateLimits: () => Promise.resolve(rateLimitsPayload),
      sessionRollout: () => Promise.resolve(undefined),
      now,
    });

    const snap = await new CodexUsageSource(deps).read('codex');

    expect(snap.available).toBe(true);
    expect(cliCalls.length).toBeGreaterThan(0);
    for (const call of cliCalls) {
      expect(call).toEqual([...CODEX_DOCTOR_ARGS]);
      expect(call.some((a) => /exec|prompt|complete|completion|--message|query/i.test(a))).toBe(
        false,
      );
    }
    expect(deps.appServerRead).toBeUndefined();
    for (const key of Object.keys(deps)) {
      expect(key).not.toMatch(/exec|query|complete|prompt|infer|spawn|stream|message/i);
    }
  });
});
