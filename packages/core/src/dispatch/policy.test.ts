import { describe, it, expect } from 'vitest';
import {
  crossesNearBudget,
  deriveHeadroom,
  isStale,
  nearBudget,
  NEAR_BUDGET_THRESHOLD_PCT_DEFAULT,
  USAGE_BUCKET_TTL_MS_DEFAULT,
  type Headroom,
} from './policy.js';
import type { CostRollup, UsageAccountStatus, UsageBucket } from './events.js';

// All timestamps explicit so the staleness table is fully deterministic (injected `now`, no clock).
const SAMPLED_AT = '2026-06-03T00:00:00.000Z';
const RESET_AT = '2026-06-03T05:00:00.000Z';
const sampledMs = Date.parse(SAMPLED_AT);
const resetMs = Date.parse(RESET_AT);

describe('isStale (pure, injected now — proof #6)', () => {
  const bucket = { sampledAt: SAMPLED_AT, resetAt: RESET_AT };

  it.each([
    ['fresh just after sampling', sampledMs + 60_000, false],
    ['fresh one ms before the TTL deadline', sampledMs + USAGE_BUCKET_TTL_MS_DEFAULT - 1, false],
    ['stale exactly at the TTL deadline (>=)', sampledMs + USAGE_BUCKET_TTL_MS_DEFAULT, true],
    ['stale well past the TTL deadline', sampledMs + USAGE_BUCKET_TTL_MS_DEFAULT + 60_000, true],
  ])('%s', (_label, nowMs, expected) => {
    expect(isStale(bucket, nowMs)).toBe(expected);
  });

  it('freshness is bounded by reset_at even when the TTL has not elapsed', () => {
    // A very long TTL would keep it fresh, but the window has refreshed at reset_at ⇒ stale.
    const longTtl = 24 * 60 * 60 * 1000;
    expect(isStale(bucket, resetMs - 1, longTtl)).toBe(false); // just before reset → fresh
    expect(isStale(bucket, resetMs, longTtl)).toBe(true); // at reset → stale (window refreshed)
    expect(isStale(bucket, resetMs + 1, longTtl)).toBe(true); // after reset → stale
  });

  it('an unparseable timestamp reads as stale (fail-safe: cannot prove freshness)', () => {
    expect(isStale({ sampledAt: 'not-a-date', resetAt: RESET_AT }, sampledMs + 1)).toBe(true);
    expect(isStale({ sampledAt: SAMPLED_AT, resetAt: 'nope' }, sampledMs + 1)).toBe(true);
  });
});

describe('nearBudget / crossesNearBudget (pure)', () => {
  // cap = 1000 cents = $10; default threshold 80% ⇒ nearing band starts at $8.
  const cap = 1000;
  const roll = (totalCostUsd: number): Pick<CostRollup, 'totalCostUsd'> => ({ totalCostUsd });

  it('is below / at / above the 80% band by default', () => {
    expect(nearBudget(roll(7.99), cap)).toBe(false);
    expect(nearBudget(roll(8.0), cap)).toBe(true);
    expect(nearBudget(roll(8.01), cap)).toBe(true);
  });

  it('honours an explicit threshold', () => {
    expect(nearBudget(roll(4.99), cap, 50)).toBe(false);
    expect(nearBudget(roll(5.0), cap, 50)).toBe(true);
  });

  it('a non-positive cap is treated as "no cap" ⇒ never nearing', () => {
    expect(nearBudget(roll(1000), 0)).toBe(false);
    expect(nearBudget(roll(1000), -1)).toBe(false);
  });

  it('crossesNearBudget is an EDGE trigger: only true when first crossing the band', () => {
    expect(crossesNearBudget(roll(7), roll(8.5), cap)).toBe(true); // below → in band
    expect(crossesNearBudget(roll(8.5), roll(9), cap)).toBe(false); // already in band
    expect(crossesNearBudget(roll(7), roll(7.5), cap)).toBe(false); // stays below
  });

  it('the default threshold constant is 80', () => {
    expect(NEAR_BUDGET_THRESHOLD_PCT_DEFAULT).toBe(80);
  });
});

describe('deriveHeadroom (pure, discriminated — never a magic number)', () => {
  const bucket: UsageBucket = {
    provider: 'claude',
    account: 'claude:max',
    windowKind: 'five_hour',
    usedPct: 42,
    resetAt: RESET_AT,
    source: 'fake',
    sampledAt: SAMPLED_AT,
  };
  const available: UsageAccountStatus = {
    provider: 'claude',
    account: 'claude:max',
    available: true,
    source: 'fake',
    sampledAt: SAMPLED_AT,
    observedTs: 1,
  };
  const unavailable: UsageAccountStatus = {
    ...available,
    available: false,
    reason: 'not logged in',
  };

  it('known when the account is available and a bucket exists', () => {
    const hr = deriveHeadroom(available, bucket);
    expect(hr).toEqual<Headroom>({ kind: 'known', used_pct: 42, reset_at: RESET_AT });
  });

  it('unknown when the account was never observed (not 0%, not healthy)', () => {
    expect(deriveHeadroom(undefined, undefined).kind).toBe('unknown');
  });

  it('unknown (with the reason) when the account is unavailable — shadows any stale bucket', () => {
    const hr = deriveHeadroom(unavailable, bucket); // bucket present but account down
    expect(hr).toEqual<Headroom>({ kind: 'unknown', reason: 'not logged in' });
  });

  it('unknown when available but no bucket for the window yet', () => {
    const hr = deriveHeadroom(available, undefined);
    expect(hr.kind).toBe('unknown');
  });
});
