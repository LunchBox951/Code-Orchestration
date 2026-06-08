import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRegistry } from '../registry/registry.js';
import { openConfigStore } from '../config/config-store.js';
import { openDispatchStore } from './dispatch-store.js';
import {
  renderUsageReport,
  renderCostReport,
  renderDispatchResolution,
  previewPlacement,
  previewPlacementWithUsage,
} from './cli-render.js';
import { accountForProvider } from './provider-source.js';
import { FakeUsageSource, UsageUnavailableError, type UsageSnapshot } from './usage-source.js';
import { DISPATCH_PINS_CONFIG_KEY } from './balancer.js';

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let repoDirs: string[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  const dir = mkdtempSync(join(tmpdir(), 'co-cli-render-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const dir of [...dataDirs, ...repoDirs]) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
  repoDirs = [];
});

function makeProjectId(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-render-repo-'));
  repoDirs.push(dir);
  // Minimal fake git repo structure for registration
  mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const registry = openRegistry();
  const id = registry.register(dir);
  registry.close();
  return id;
}

const snap: UsageSnapshot = {
  provider: 'claude',
  account: 'default',
  available: true,
  source: 'fake',
  sampled_at: new Date().toISOString(),
  windows: [
    {
      kind: 'five_hour',
      used_pct: 42,
      reset_at: new Date(Date.now() + 5 * 3600_000).toISOString(),
    },
  ],
};

describe('renderUsageReport', () => {
  it('contains provider, account, used_pct information', () => {
    const projectId = makeProjectId();
    const store = openDispatchStore(projectId);
    try {
      store.recordSnapshot(snap);
      const report = renderUsageReport(projectId, store);
      expect(report).toMatch(/claude/i);
      expect(report).toMatch(/default/);
      expect(report).toMatch(/42/);
    } finally {
      store.close();
    }
  });

  it('reports "no usage data" when no buckets recorded', () => {
    const projectId = makeProjectId();
    const report = renderUsageReport(projectId);
    expect(report).toMatch(/no usage/i);
  });

  it('renders an unavailable status even when there are no buckets', () => {
    const projectId = makeProjectId();
    const store = openDispatchStore(projectId);
    try {
      store.recordSnapshot({
        provider: 'codex',
        account: accountForProvider('codex'),
        available: false,
        source: 'fake',
        sampled_at: new Date().toISOString(),
        windows: [],
      });

      const report = renderUsageReport(projectId, store);

      expect(report).toMatch(/codex\/codex:pro/i);
      expect(report).toMatch(/unavailable/i);
      expect(report).not.toMatch(/no usage/i);
    } finally {
      store.close();
    }
  });

  it('does not render stale capacity when an unavailable status shadows a prior bucket', () => {
    const projectId = makeProjectId();
    const store = openDispatchStore(projectId);
    try {
      store.recordSnapshot(snap);
      store.recordSnapshot({
        ...snap,
        available: false,
        sampled_at: new Date().toISOString(),
        windows: [],
      });

      const report = renderUsageReport(projectId, store);

      expect(report).toMatch(/claude\/default/i);
      expect(report).toMatch(/unavailable/i);
      expect(report).not.toMatch(/42\.0% used/i);
      expect(report).not.toMatch(/58\.0% free/i);
    } finally {
      store.close();
    }
  });

  it('renders available accounts with no window buckets as explicit unknown headroom', () => {
    const projectId = makeProjectId();
    const store = openDispatchStore(projectId);
    try {
      store.recordSnapshot({
        provider: 'claude',
        account: accountForProvider('claude'),
        available: true,
        source: 'fake',
        sampled_at: new Date().toISOString(),
        windows: [],
      });

      const report = renderUsageReport(projectId, store);

      expect(report).toMatch(/claude\/claude:max/i);
      expect(report).toMatch(/unknown/i);
      expect(report).toMatch(/no window data/i);
    } finally {
      store.close();
    }
  });
});

describe('renderCostReport', () => {
  it('contains cost rollup data', () => {
    const projectId = makeProjectId();
    const store = openDispatchStore(projectId);
    try {
      store.recordCost({
        provider: 'claude',
        agent: 'agent-1',
        task: 'task-1',
        turn: 1,
        cost_usd: 0.05,
        input_tokens: 1000,
        output_tokens: 500,
        total_tokens: 1500,
      });
      const report = renderCostReport(projectId, store);
      expect(report).toMatch(/agent-1/i);
      expect(report).toMatch(/0\.05/);
    } finally {
      store.close();
    }
  });

  it('shows near-budget records when present', () => {
    const projectId = makeProjectId();
    const store = openDispatchStore(projectId);
    try {
      store.recordCost(
        {
          provider: 'claude',
          agent: 'agent-nb',
          task: 'task-nb',
          turn: 1,
          cost_usd: 0.06,
          total_tokens: 800,
        },
        { capCents: 10, thresholdPct: 50 }, // $0.05 of $0.10 cap → crossed
      );
      const report = renderCostReport(projectId, store);
      expect(report).toMatch(/near.budget|cap/i);
      expect(report).toMatch(/task-nb/);
    } finally {
      store.close();
    }
  });

  it('reports "no cost data" when nothing recorded', () => {
    const projectId = makeProjectId();
    const report = renderCostReport(projectId);
    expect(report).toMatch(/no cost/i);
  });

  it('renders Codex usage percentage when dollar cost is absent', () => {
    const projectId = makeProjectId();
    const store = openDispatchStore(projectId);
    try {
      store.recordCost({
        provider: 'codex',
        agent: 'codex-agent',
        task: 'codex-task',
        turn: 1,
        used_pct: 7.5,
        total_tokens: 900,
      });

      const report = renderCostReport(projectId, store);

      expect(report).toMatch(/codex-agent/);
      expect(report).toMatch(/7\.5 usage%/);
      expect(report).toMatch(/900 tokens/);
    } finally {
      store.close();
    }
  });

  it('renders observed zero Codex usage percentage', () => {
    const projectId = makeProjectId();
    const store = openDispatchStore(projectId);
    try {
      store.recordCost({
        provider: 'codex',
        agent: 'zero-agent',
        task: 'zero-task',
        turn: 1,
        used_pct: 0,
      });

      const report = renderCostReport(projectId, store);

      expect(report).toMatch(/zero-agent/);
      expect(report).toMatch(/0\.0 usage%/);
    } finally {
      store.close();
    }
  });

  it('renders observed zero dollar and token measurements', () => {
    const projectId = makeProjectId();
    const store = openDispatchStore(projectId);
    try {
      store.recordCost({
        provider: 'claude',
        agent: 'zero-measured-agent',
        task: 'zero-measured-task',
        turn: 1,
        cost_usd: 0,
        total_tokens: 0,
      });

      const report = renderCostReport(projectId, store);

      expect(report).toMatch(/zero-measured-agent/);
      expect(report).toMatch(/\$0\.0000/);
      expect(report).toMatch(/0 tokens/);
    } finally {
      store.close();
    }
  });
});

describe('previewPlacement', () => {
  it('returns placed resolution for a healthy provider (writes nothing)', () => {
    const projectId = makeProjectId();
    const store = openDispatchStore(projectId);
    try {
      store.recordSnapshot(snap);

      const resolution = previewPlacement({
        projectId,
        agent: 'agent-1',
        role: 'implementer',
        workSize: 'average',
        reasoningBudget: 'standard',
        accounts: [{ provider: 'claude', account: 'default' }],
        nowMs: Date.now(),
        store,
      });

      expect(resolution.kind).toBe('placed');
      const rendered = renderDispatchResolution(resolution);
      expect(rendered).toMatch(/provider=claude/);
      expect(rendered).toMatch(/account=default/);
      // Verify nothing was written (no placement.decided events)
      expect(store.readPlacements()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('returns waiting resolution for a maxed provider (writes nothing)', () => {
    const projectId = makeProjectId();
    const store = openDispatchStore(projectId);
    try {
      const maxedSnap: UsageSnapshot = {
        ...snap,
        windows: [
          {
            kind: 'five_hour',
            used_pct: 99,
            reset_at: new Date(Date.now() + 5 * 3600_000).toISOString(),
          },
        ],
      };
      store.recordSnapshot(maxedSnap);

      const resolution = previewPlacement({
        projectId,
        agent: 'agent-1',
        role: 'implementer',
        workSize: 'average',
        reasoningBudget: 'standard',
        accounts: [{ provider: 'claude', account: 'default' }],
        nowMs: Date.now(),
        store,
      });

      expect(resolution.kind).toBe('waiting');
      // No placement.decided events written
      expect(store.readPlacements()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('keeps reset ETA from an unavailable over-limit snapshot with observed windows', () => {
    const projectId = makeProjectId();
    const store = openDispatchStore(projectId);
    try {
      store.recordSnapshot({
        provider: 'codex',
        account: accountForProvider('codex'),
        available: false,
        source: 'sqlite',
        sampled_at: '2026-06-03T00:00:00.000Z',
        windows: [
          { kind: 'primary', used_pct: 100, reset_at: '2026-06-03T05:00:00.000Z' },
          { kind: 'secondary', used_pct: 80, reset_at: '2026-06-10T00:00:00.000Z' },
        ],
      });

      const resolution = previewPlacement({
        projectId,
        agent: 'agent-1',
        role: 'implementer',
        workSize: 'average',
        reasoningBudget: 'standard',
        accounts: [{ provider: 'codex', account: accountForProvider('codex') }],
        nowMs: Date.parse('2026-06-03T00:01:00.000Z'),
        store,
      });

      expect(resolution.kind).toBe('waiting');
      if (resolution.kind !== 'waiting') throw new Error('unreachable');
      expect(resolution.etaResetAt).toBe('2026-06-03T05:00:00.000Z');
      expect(resolution.unavailableProviders).toEqual(['codex']);
      const headroom = store.getHeadroom('codex', accountForProvider('codex'), 'primary');
      expect(headroom.kind).toBe('unknown');
    } finally {
      store.close();
    }
  });

  it('does not fold unrelated refresh diagnostics into a pinned WAITING decision', async () => {
    const projectId = makeProjectId();
    const config = openConfigStore();
    try {
      config.setProjectOverride(projectId, DISPATCH_PINS_CONFIG_KEY, {
        reviewer: { provider: 'claude' },
      });
    } finally {
      config.close();
    }

    const store = openDispatchStore(projectId);
    try {
      store.recordSnapshot({
        provider: 'claude',
        account: accountForProvider('claude'),
        available: true,
        source: 'fake',
        sampled_at: new Date().toISOString(),
        windows: [
          {
            kind: 'five_hour',
            used_pct: 99,
            reset_at: new Date(Date.now() + 5 * 3600_000).toISOString(),
          },
        ],
      });

      const resolution = await previewPlacementWithUsage({
        projectId,
        agent: 'agent-1',
        role: 'reviewer',
        workSize: 'average',
        reasoningBudget: 'standard',
        accounts: [
          { provider: 'claude', account: accountForProvider('claude') },
          { provider: 'codex', account: accountForProvider('codex') },
        ],
        nowMs: Date.now(),
        store,
        usageSourceFactory: () =>
          new FakeUsageSource({
            errors: {
              codex: new UsageUnavailableError(
                'codex',
                'logs database missing /home/operator/.codex/logs_2.sqlite',
                { account: accountForProvider('codex') },
              ),
            },
          }),
      });

      expect(resolution.kind).toBe('waiting');
      if (resolution.kind !== 'waiting') throw new Error('unreachable');
      expect(resolution.maxedProviders).toEqual(['claude']);
      expect(resolution.unavailableProviders).toEqual([]);
      expect(resolution.diagnostics).toBeUndefined();
      expect(resolution.message).not.toMatch(/codex|logs database/i);
    } finally {
      store.close();
    }
  });

  it('uses the latest prior placement for hysteresis in read-only previews', () => {
    const projectId = makeProjectId();
    const store = openDispatchStore(projectId);
    try {
      const resetAt = new Date(Date.now() + 5 * 3600_000).toISOString();
      store.recordSnapshot({
        provider: 'claude',
        account: accountForProvider('claude'),
        available: true,
        source: 'fake',
        sampled_at: new Date().toISOString(),
        windows: [{ kind: 'primary', used_pct: 10, reset_at: resetAt }],
      });
      store.recordSnapshot({
        provider: 'codex',
        account: accountForProvider('codex'),
        available: true,
        source: 'fake',
        sampled_at: new Date().toISOString(),
        windows: [{ kind: 'primary', used_pct: 10.5, reset_at: resetAt }],
      });
      store.recordPlacement('agent-1', {
        kind: 'placed',
        role: 'implementer',
        work_size: 'average',
        reasoning_budget: 'standard',
        provider: 'codex',
        account: accountForProvider('codex'),
        model: 'gpt-5.4',
        effort: 'medium',
        context: 'standard',
      });

      const resolution = previewPlacement({
        projectId,
        agent: 'agent-1',
        role: 'implementer',
        workSize: 'average',
        reasoningBudget: 'standard',
        accounts: [
          { provider: 'claude', account: accountForProvider('claude') },
          { provider: 'codex', account: accountForProvider('codex') },
        ],
        nowMs: Date.now(),
        store,
      });

      expect(resolution.kind).toBe('placed');
      if (resolution.kind !== 'placed') throw new Error('unreachable');
      expect(resolution.placement.provider).toBe('codex');
      expect(store.readPlacements()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('does not inherit hysteresis from another agent with the same role', () => {
    const projectId = makeProjectId();
    const store = openDispatchStore(projectId);
    try {
      const resetAt = new Date(Date.now() + 5 * 3600_000).toISOString();
      store.recordSnapshot({
        provider: 'claude',
        account: accountForProvider('claude'),
        available: true,
        source: 'fake',
        sampled_at: new Date().toISOString(),
        windows: [{ kind: 'primary', used_pct: 10, reset_at: resetAt }],
      });
      store.recordSnapshot({
        provider: 'codex',
        account: accountForProvider('codex'),
        available: true,
        source: 'fake',
        sampled_at: new Date().toISOString(),
        windows: [{ kind: 'primary', used_pct: 10.5, reset_at: resetAt }],
      });
      store.recordPlacement('agent-1', {
        kind: 'placed',
        role: 'implementer',
        work_size: 'average',
        reasoning_budget: 'standard',
        provider: 'codex',
        account: accountForProvider('codex'),
        model: 'gpt-5.4',
        effort: 'medium',
        context: 'standard',
      });

      const resolution = previewPlacement({
        projectId,
        agent: 'agent-2',
        role: 'implementer',
        workSize: 'average',
        reasoningBudget: 'standard',
        accounts: [
          { provider: 'claude', account: accountForProvider('claude') },
          { provider: 'codex', account: accountForProvider('codex') },
        ],
        nowMs: Date.now(),
        store,
      });

      expect(resolution.kind).toBe('placed');
      if (resolution.kind !== 'placed') throw new Error('unreachable');
      expect(resolution.placement.provider).toBe('claude');
    } finally {
      store.close();
    }
  });
});
