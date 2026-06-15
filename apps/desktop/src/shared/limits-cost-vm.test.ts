import { describe, it, expect, vi } from 'vitest';
import { LimitsCostVM } from './limits-cost-vm.js';
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
    usedPct: 0,
    usedPctObservations: 0,
    observations: 1,
  };
}

const EMPTY_INPUTS: LimitsCostInputs = { buckets: [], accountStatuses: [], rollups: [] };

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
