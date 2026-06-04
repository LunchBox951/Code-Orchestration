import { describe, it, expect } from 'vitest';
import {
  FakeUsageSource,
  USAGE_UNAVAILABLE_CODE,
  UsageUnavailableError,
  type UsageSnapshot,
} from './usage-source.js';

const claudeSnap: UsageSnapshot = {
  provider: 'claude',
  account: 'claude:max',
  windows: [{ kind: 'five_hour', used_pct: 42, reset_at: '2026-06-03T05:00:00.000Z' }],
  available: true,
  source: 'fake',
  sampled_at: '2026-06-03T00:00:00.000Z',
};

const codexDown: UsageSnapshot = {
  provider: 'codex',
  account: 'codex:pro',
  windows: [],
  available: false,
  source: 'fake',
  sampled_at: '2026-06-03T00:00:00.000Z',
};

describe('FakeUsageSource — the exported production-quality double (drives phases 3–5)', () => {
  it('returns a canned snapshot from a bare Map', async () => {
    const source = new FakeUsageSource(new Map([['claude', claudeSnap]]));
    await expect(source.read('claude')).resolves.toEqual(claudeSnap);
  });

  it('returns a canned snapshot from the {snapshots: Record} form', async () => {
    const source = new FakeUsageSource({ snapshots: { claude: claudeSnap } });
    await expect(source.read('claude')).resolves.toEqual(claudeSnap);
  });

  it('resolves an available:false snapshot as-is (unavailability is data, not an exception here)', async () => {
    const source = new FakeUsageSource(new Map([['codex', codexDown]]));
    await expect(source.read('codex')).resolves.toEqual(codexDown);
  });

  it('throws the configured error to simulate a failed / unhealthy source', async () => {
    const boom = new Error('socket closed');
    const source = new FakeUsageSource({ errors: { codex: boom } });
    await expect(source.read('codex')).rejects.toBe(boom);
  });

  it('throws a typed UsageUnavailableError (with the stable code) for an unconfigured provider', async () => {
    const source = new FakeUsageSource();
    await expect(source.read('claude')).rejects.toBeInstanceOf(UsageUnavailableError);
    const err = await source.read('claude').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UsageUnavailableError);
    expect((err as UsageUnavailableError).code).toBe(USAGE_UNAVAILABLE_CODE);
    expect((err as UsageUnavailableError).provider).toBe('claude');
  });
});

describe('UsageUnavailableError — fail-loud typed surface (AC6, Principle 9)', () => {
  it('carries the code, provider, optional account, and a preserved cause', () => {
    const cause = new Error('underlying');
    const err = new UsageUnavailableError('codex', 'down', { account: 'codex:pro', cause });
    expect(err.code).toBe('usage_source_unavailable');
    expect(err.provider).toBe('codex');
    expect(err.account).toBe('codex:pro');
    expect(err.cause).toBe(cause);
    expect(err.name).toBe('UsageUnavailableError');
    expect(err).toBeInstanceOf(Error);
  });
});
