import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  accountForProvider,
  CACHE_SOURCE,
  CO_LIVE_E2E_ENV,
  createProviderUsageSource,
  defaultProviderUsageSource,
  isLiveE2EEnabled,
  readProviderUsageCached,
} from './provider-source.js';
import { ClaudeUsageSource } from './claude-source.js';
import { CodexUsageSource } from './codex-source.js';
import { openDispatchStore } from './dispatch-store.js';
import { USAGE_BUCKET_TTL_MS_DEFAULT } from './policy.js';
import {
  UsageUnavailableError,
  type ProviderUsageSource,
  type UsageSnapshot,
} from './usage-source.js';

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  const dir = mkdtempSync(join(tmpdir(), 'co-provider-source-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
});

/** A counting {@link ProviderUsageSource} double — proves the cache skips the inner read when fresh. */
class SpySource implements ProviderUsageSource {
  reads = 0;
  constructor(private readonly snapshot: UsageSnapshot) {}
  read(): Promise<UsageSnapshot> {
    this.reads += 1;
    return Promise.resolve(this.snapshot);
  }
}

describe('accountForProvider — per-account labels', () => {
  it('maps each provider to its default account', () => {
    expect(accountForProvider('claude')).toBe('claude:max');
    expect(accountForProvider('codex')).toBe('codex:pro');
  });
});

describe('createProviderUsageSource — the real adapter, wired as default', () => {
  it('returns the per-provider adapter and does NO I/O at construction', () => {
    expect(createProviderUsageSource('claude')).toBeInstanceOf(ClaudeUsageSource);
    expect(createProviderUsageSource('codex')).toBeInstanceOf(CodexUsageSource);
    expect(defaultProviderUsageSource).toBe(createProviderUsageSource);
  });

  it('reads hermetically through injected fixture seams (no live I/O) — Claude', async () => {
    const source = createProviderUsageSource('claude', {
      cli: () => Promise.resolve(JSON.stringify({ logged_in: true })),
      readStatusLine: () =>
        Promise.resolve({
          rate_limits: { five_hour: { used_percentage: 9, resets_at: '2026-06-03T05:00:00.000Z' } },
        }),
      now: () => Date.parse('2026-06-03T00:00:00.000Z'),
    });
    const snap = await source.read('claude');
    expect(snap.source).toBe('statusLine');
    expect(snap.windows).toEqual([
      { kind: 'five_hour', used_pct: 9, reset_at: '2026-06-03T05:00:00.000Z' },
    ]);
  });

  it('reads hermetically through injected fixture seams (no live I/O) — Codex', async () => {
    const source = createProviderUsageSource('codex', {
      cli: () => Promise.resolve(JSON.stringify({ plan: 'pro' })),
      readRateLimits: () =>
        Promise.resolve({
          plan: 'pro',
          allowed: true,
          primary: { used_percent: 4, reset_at: '2026-06-03T05:00:00.000Z' },
        }),
      now: () => Date.parse('2026-06-03T00:00:00.000Z'),
    });
    const snap = await source.read('codex');
    expect(snap.source).toBe('sqlite');
    expect(snap.windows).toEqual([
      { kind: 'primary', used_pct: 4, reset_at: '2026-06-03T05:00:00.000Z' },
    ]);
  });
});

describe('layered fail-loud → unknown headroom (AC6, integrated with the store)', () => {
  it('an all-fail adapter read leaves the account headroom unknown via observeUsage', async () => {
    // statusLine empty + idle disabled ⇒ the adapter throws UsageUnavailableError.
    const source = createProviderUsageSource('claude', {
      cli: () => Promise.resolve(JSON.stringify({ logged_in: true })),
      readStatusLine: () => Promise.resolve({}),
      now: () => Date.parse('2026-06-03T00:00:00.000Z'),
    });
    const store = openDispatchStore('p-faillaud');
    try {
      await expect(readProviderUsageCached(source, 'claude', store)).rejects.toBeInstanceOf(
        UsageUnavailableError,
      );
      expect(store.getHeadroom('claude:max', 'five_hour').kind).toBe('unknown');
    } finally {
      store.close();
    }
  });
});

describe('readProviderUsageCached — program-data cache (fresh reused / stale re-read)', () => {
  const T0 = Date.parse('2026-06-03T00:00:00.000Z');
  const snapshot: UsageSnapshot = {
    provider: 'claude',
    account: 'claude:max',
    windows: [{ kind: 'five_hour', used_pct: 40, reset_at: '2026-06-03T02:00:00.000Z' }],
    available: true,
    source: 'statusLine',
    sampled_at: '2026-06-03T00:00:00.000Z',
  };

  it('reads live on a miss, serves cache while fresh, and re-reads once stale', async () => {
    const spy = new SpySource(snapshot);
    const store = openDispatchStore('p-cache');
    try {
      // miss → live read (records the sample).
      const first = await readProviderUsageCached(spy, 'claude', store, { nowMs: T0 + 60_000 });
      expect(spy.reads).toBe(1);
      expect(first.source).toBe('statusLine');

      // fresh (within TTL) → served from cache, NO live read.
      const cached = await readProviderUsageCached(spy, 'claude', store, { nowMs: T0 + 120_000 });
      expect(spy.reads).toBe(1);
      expect(cached.source).toBe(CACHE_SOURCE);
      expect(cached.windows).toEqual(snapshot.windows);

      // stale (past the TTL deadline) → live re-read.
      const refreshed = await readProviderUsageCached(spy, 'claude', store, {
        nowMs: T0 + USAGE_BUCKET_TTL_MS_DEFAULT + 60_000,
      });
      expect(spy.reads).toBe(2);
      expect(refreshed.source).toBe('statusLine');
    } finally {
      store.close();
    }
  });

  it('does not serve an unavailable account as a healthy cache (AC6)', async () => {
    const down: UsageSnapshot = {
      provider: 'claude',
      account: 'claude:max',
      windows: [],
      available: false,
      source: 'auth-status',
      sampled_at: '2026-06-03T00:00:00.000Z',
    };
    const spy = new SpySource(down);
    const store = openDispatchStore('p-cache-down');
    try {
      // First read records an unavailable sample (observeUsage throws fail-loud on available:false).
      await expect(
        readProviderUsageCached(spy, 'claude', store, { nowMs: T0 }),
      ).rejects.toBeInstanceOf(UsageUnavailableError);
      expect(spy.reads).toBe(1);
      // Next read must NOT serve the unavailable account from cache — it re-reads live.
      await expect(
        readProviderUsageCached(spy, 'claude', store, { nowMs: T0 + 1000 }),
      ).rejects.toBeInstanceOf(UsageUnavailableError);
      expect(spy.reads).toBe(2);
    } finally {
      store.close();
    }
  });
});

describe('isLiveE2EEnabled — the gated-live-E2E opt-in predicate', () => {
  it('is false without the opt-in (the sandbox case → the live suite SKIPS)', () => {
    expect(isLiveE2EEnabled({})).toBe(false);
    expect(isLiveE2EEnabled({ [CO_LIVE_E2E_ENV]: '' })).toBe(false);
    expect(isLiveE2EEnabled({ [CO_LIVE_E2E_ENV]: '0' })).toBe(false);
    expect(isLiveE2EEnabled({ [CO_LIVE_E2E_ENV]: 'false' })).toBe(false);
  });

  it('is true only on an explicit truthy opt-in', () => {
    expect(isLiveE2EEnabled({ [CO_LIVE_E2E_ENV]: '1' })).toBe(true);
    expect(isLiveE2EEnabled({ [CO_LIVE_E2E_ENV]: 'true' })).toBe(true);
    expect(isLiveE2EEnabled({ [CO_LIVE_E2E_ENV]: 'yes' })).toBe(true);
    expect(isLiveE2EEnabled({ [CO_LIVE_E2E_ENV]: 'on' })).toBe(true);
  });
});
