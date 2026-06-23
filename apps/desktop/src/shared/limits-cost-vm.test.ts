import { describe, it, expect, vi } from 'vitest';
import { LimitsCostVM, labelWindowKind } from './limits-cost-vm.js';
import type { LimitsCostInputs } from './limits-cost-vm.js';
import type { UsageBucket, UsageAccountStatus, CostRollup } from '@co/core';

const PROVIDER = 'claude' as const;

function makeBucket(overrides?: Partial<UsageBucket>): UsageBucket {
  return {
    provider: PROVIDER,
    account: 'acct1',
    windowKind: 'session',
    usedPct: 40,
    resetAt: '2026-06-15T10:00:00Z',
    source: 'test',
    sampledAt: '2026-06-15T01:00:00Z',
    ...overrides,
  };
}

function makeStatus(overrides?: Partial<UsageAccountStatus>): UsageAccountStatus {
  return {
    provider: PROVIDER,
    account: 'acct1',
    available: true,
    source: 'test',
    sampledAt: '2026-06-15T01:00:00Z',
    observedTs: 1000,
    ...overrides,
  };
}

function makeRollup(kind: 'agent' | 'task', id: string, totalCostUsd: number): CostRollup {
  return {
    kind,
    id,
    totalCostUsd,
    costUsdObservations: 1,
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    tokenObservations: 1,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    usedPct: 0,
    usedPctObservations: 0,
    observations: 1,
  };
}

const EMPTY_INPUTS: LimitsCostInputs = { buckets: [], accountStatuses: [], rollups: [] };

describe('labelWindowKind', () => {
  it('maps codex primary → session and secondary → weekly', () => {
    expect(labelWindowKind('codex', 'primary')).toBe('session');
    expect(labelWindowKind('codex', 'secondary')).toBe('weekly');
  });

  it('maps claude five_hour → session and weekly → weekly', () => {
    expect(labelWindowKind('claude', 'five_hour')).toBe('session');
    expect(labelWindowKind('claude', 'weekly')).toBe('weekly');
  });

  it('is provider-agnostic for canonical kinds', () => {
    expect(labelWindowKind('claude', 'primary')).toBe('session');
    expect(labelWindowKind('codex', 'five_hour')).toBe('session');
    expect(labelWindowKind('anything', 'secondary')).toBe('weekly');
  });

  it('passes unknown kinds through verbatim without throwing', () => {
    expect(() => labelWindowKind('claude', 'monthly')).not.toThrow();
    expect(labelWindowKind('claude', 'monthly')).toBe('monthly');
    expect(labelWindowKind('codex', 'some_other_window')).toBe('some_other_window');
    expect(labelWindowKind('codex', 'unknown')).toBe('unknown');
    expect(labelWindowKind('codex', '')).toBe('');
  });
});

describe('LimitsCostVM', () => {
  it('starts with empty state', () => {
    const vm = new LimitsCostVM();
    expect(vm.state.headroomRows).toHaveLength(0);
    expect(vm.state.agentCosts).toHaveLength(0);
    expect(vm.state.taskCosts).toHaveLength(0);
  });

  it('update with empty inputs produces empty state (no throw)', () => {
    const vm = new LimitsCostVM();
    expect(() => vm.update(EMPTY_INPUTS)).not.toThrow();
    expect(vm.state.headroomRows).toHaveLength(0);
    expect(vm.state.agentCosts).toHaveLength(0);
    expect(vm.state.taskCosts).toHaveLength(0);
  });

  it('derives headroom rows from buckets + account statuses', () => {
    const vm = new LimitsCostVM();
    vm.update({
      buckets: [makeBucket({ windowKind: 'session', usedPct: 60 })],
      accountStatuses: [makeStatus({ available: true })],
      rollups: [],
    });
    expect(vm.state.headroomRows).toHaveLength(1);
    const row = vm.state.headroomRows[0]!;
    expect(row.provider).toBe('claude');
    expect(row.account).toBe('acct1');
    expect(row.windowKind).toBe('session');
    expect(row.headroom.kind).toBe('known');
    if (row.headroom.kind === 'known') {
      expect(row.headroom.used_pct).toBe(60);
      expect(row.headroom.reset_at).toBe('2026-06-15T10:00:00Z');
    }
  });

  it('unavailable account → unknown headroom, never fabricated 0%', () => {
    const vm = new LimitsCostVM();
    vm.update({
      buckets: [makeBucket({ usedPct: 0 })],
      accountStatuses: [makeStatus({ available: false, reason: 'API down' })],
      rollups: [],
    });
    const row = vm.state.headroomRows[0]!;
    expect(row.headroom.kind).toBe('unknown');
    if (row.headroom.kind === 'unknown') {
      expect(row.headroom.reason).toContain('API down');
    }
  });

  it('missing account status → unknown headroom', () => {
    const vm = new LimitsCostVM();
    vm.update({
      buckets: [makeBucket()],
      accountStatuses: [],
      rollups: [],
    });
    const row = vm.state.headroomRows[0]!;
    expect(row.headroom.kind).toBe('unknown');
  });

  it('handles multiple windows per account', () => {
    const vm = new LimitsCostVM();
    vm.update({
      buckets: [
        makeBucket({ windowKind: 'session', usedPct: 30 }),
        makeBucket({ windowKind: 'weekly', usedPct: 70 }),
      ],
      accountStatuses: [makeStatus()],
      rollups: [],
    });
    expect(vm.state.headroomRows).toHaveLength(2);
    expect(vm.state.headroomRows[0]?.windowKind).toBe('session');
    expect(vm.state.headroomRows[1]?.windowKind).toBe('weekly');
  });

  it('splits cost rollups by kind', () => {
    const vm = new LimitsCostVM();
    vm.update({
      ...EMPTY_INPUTS,
      rollups: [
        makeRollup('agent', 'impl-a', 0.05),
        makeRollup('task', 'task-1', 0.1),
        makeRollup('agent', 'impl-b', 0.02),
      ],
    });
    expect(vm.state.agentCosts).toHaveLength(2);
    expect(vm.state.taskCosts).toHaveLength(1);
    expect(vm.state.taskCosts[0]?.id).toBe('task-1');
  });

  it('sorts costs descending by totalCostUsd', () => {
    const vm = new LimitsCostVM();
    vm.update({
      ...EMPTY_INPUTS,
      rollups: [
        makeRollup('agent', 'cheap', 0.01),
        makeRollup('agent', 'expensive', 0.5),
        makeRollup('agent', 'mid', 0.2),
      ],
    });
    const ids = vm.state.agentCosts.map((r) => r.id);
    expect(ids).toEqual(['expensive', 'mid', 'cheap']);
  });

  it('subscribe fires on update and unsub stops notifications', () => {
    const vm = new LimitsCostVM();
    const listener = vi.fn();
    const unsub = vm.subscribe(listener);
    vm.update(EMPTY_INPUTS);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(vm.state);
    unsub();
    vm.update(EMPTY_INPUTS);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('sets displayLabel on each headroom row (codex primary/secondary → session/weekly)', () => {
    const vm = new LimitsCostVM();
    vm.update({
      buckets: [
        makeBucket({ provider: 'codex', windowKind: 'primary', usedPct: 20 }),
        makeBucket({ provider: 'codex', windowKind: 'secondary', usedPct: 50 }),
      ],
      accountStatuses: [makeStatus({ provider: 'codex' })],
      rollups: [],
    });
    expect(vm.state.headroomRows.map((r) => r.displayLabel)).toEqual(['session', 'weekly']);
  });

  it('sets displayLabel on each headroom row (claude five_hour/weekly → session/weekly)', () => {
    const vm = new LimitsCostVM();
    vm.update({
      buckets: [
        makeBucket({ provider: 'claude', windowKind: 'five_hour', usedPct: 10 }),
        makeBucket({ provider: 'claude', windowKind: 'weekly', usedPct: 30 }),
      ],
      accountStatuses: [makeStatus({ provider: 'claude' })],
      rollups: [],
    });
    expect(vm.state.headroomRows.map((r) => r.displayLabel)).toEqual(['session', 'weekly']);
  });

  it('an account status with NO matching bucket still produces an unknown headroom row', () => {
    const vm = new LimitsCostVM();
    vm.update({
      buckets: [],
      accountStatuses: [
        makeStatus({ provider: 'claude', account: 'claude-acct', available: true }),
      ],
      rollups: [],
    });
    expect(vm.state.headroomRows).toHaveLength(1);
    const row = vm.state.headroomRows[0]!;
    expect(row.provider).toBe('claude');
    expect(row.account).toBe('claude-acct');
    expect(row.headroom.kind).toBe('unknown');
    // synthesized rows still carry a usable display label
    expect(typeof row.displayLabel).toBe('string');
  });

  it('an unavailable status with NO matching bucket preserves the reason and readable label', () => {
    const vm = new LimitsCostVM();
    vm.update({
      buckets: [],
      accountStatuses: [
        makeStatus({
          provider: 'claude',
          account: 'claude-acct',
          available: false,
          reason: 'API down',
        }),
      ],
      rollups: [],
    });
    expect(vm.state.headroomRows).toHaveLength(1);
    const row = vm.state.headroomRows[0]!;
    expect(row.provider).toBe('claude');
    expect(row.account).toBe('claude-acct');
    expect(row.windowKind).toBe('unknown');
    expect(row.displayLabel).toBe('headroom');
    expect(row.headroom).toEqual({ kind: 'unknown', reason: 'API down' });
  });

  it('a SEEDED unavailable Claude status (fresh box) yields a grouped Claude headroom card with its reason (#122/#125/#88)', () => {
    const vm = new LimitsCostVM();
    // Exactly what seedInitialAccountStatuses writes on a fresh box: an unavailable status, no bucket.
    vm.update({
      buckets: [],
      accountStatuses: [
        makeStatus({
          provider: 'claude',
          account: 'claude:max',
          available: false,
          reason: 'no usage observed yet',
          source: 'seed',
        }),
      ],
      rollups: [],
    });
    expect(vm.state.headroomRows).toHaveLength(1);
    const row = vm.state.headroomRows[0]!;
    expect(row.provider).toBe('claude');
    expect(row.account).toBe('claude:max');
    expect(row.displayLabel).toBe('headroom');
    // The card shows the reason string, never a fabricated percentage.
    expect(row.headroom).toEqual({ kind: 'unknown', reason: 'no usage observed yet' });
  });

  it('suppresses a stale seeded provider placeholder once real usage exists for another account', () => {
    const vm = new LimitsCostVM();
    vm.update({
      buckets: [
        makeBucket({
          provider: 'claude',
          account: 'claude:team',
          windowKind: 'five_hour',
          usedPct: 12,
        }),
      ],
      accountStatuses: [
        makeStatus({
          provider: 'claude',
          account: 'claude:max',
          available: false,
          reason: 'no usage observed yet',
          source: 'seed',
        }),
        makeStatus({ provider: 'claude', account: 'claude:team', source: 'fake' }),
      ],
      rollups: [],
    });
    expect(vm.state.headroomRows.map((r) => r.account)).toEqual(['claude:team']);
  });

  it('filters seed-only placeholders for disabled providers while preserving real disabled-provider usage', () => {
    const vm = new LimitsCostVM();
    vm.update({
      buckets: [
        makeBucket({
          provider: 'claude',
          account: 'claude:team',
          windowKind: 'five_hour',
          usedPct: 12,
        }),
      ],
      accountStatuses: [
        makeStatus({
          provider: 'claude',
          account: 'claude:max',
          available: false,
          reason: 'no usage observed yet',
          source: 'seed',
        }),
        makeStatus({ provider: 'claude', account: 'claude:team', source: 'fake' }),
        makeStatus({
          provider: 'codex',
          account: 'codex:pro',
          available: false,
          reason: 'no usage observed yet',
          source: 'seed',
        }),
      ],
      rollups: [],
      enabledProviders: ['codex'],
    });
    expect(vm.state.headroomRows.map((r) => `${r.provider}:${r.account}`)).toEqual([
      'claude:claude:team',
      'codex:codex:pro',
    ]);
  });

  it('a Codex bucket + a Claude status-with-no-bucket yields TWO provider groups', () => {
    const vm = new LimitsCostVM();
    vm.update({
      buckets: [makeBucket({ provider: 'codex', account: 'codex-acct', windowKind: 'primary' })],
      accountStatuses: [
        makeStatus({ provider: 'codex', account: 'codex-acct' }),
        makeStatus({ provider: 'claude', account: 'claude-acct' }),
      ],
      rollups: [],
    });
    const keys = new Set(vm.state.headroomRows.map((r) => `${r.provider}:${r.account}`));
    expect(keys).toEqual(new Set(['codex:codex-acct', 'claude:claude-acct']));
    const codexRow = vm.state.headroomRows.find((r) => r.provider === 'codex')!;
    expect(codexRow.displayLabel).toBe('session');
    expect(codexRow.headroom.kind).toBe('known');
    const claudeRow = vm.state.headroomRows.find((r) => r.provider === 'claude')!;
    expect(claudeRow.headroom.kind).toBe('unknown');
  });

  it('headroom is unknown for accounts with no status, NOT unknown due to zero usedPct', () => {
    const vm = new LimitsCostVM();
    // This tests the "pure reads" contract: deriving headroom is deterministic from injected data
    vm.update({
      buckets: [makeBucket({ usedPct: 0 })],
      accountStatuses: [makeStatus({ available: true })],
      rollups: [],
    });
    const row = vm.state.headroomRows[0]!;
    // A genuine 0% reading for an available account IS known (not unknown)
    expect(row.headroom.kind).toBe('known');
    if (row.headroom.kind === 'known') {
      expect(row.headroom.used_pct).toBe(0);
    }
  });
});
