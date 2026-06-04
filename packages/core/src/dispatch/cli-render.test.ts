import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openRegistry } from '../registry/registry.js';
import { openDispatchStore } from './dispatch-store.js';
import { renderUsageReport, renderCostReport, previewPlacement } from './cli-render.js';
import type { UsageSnapshot } from './usage-source.js';

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
});

describe('previewPlacement', () => {
  it('returns placed resolution for a healthy provider (writes nothing)', () => {
    const projectId = makeProjectId();
    const store = openDispatchStore(projectId);
    try {
      store.recordSnapshot(snap);

      const resolution = previewPlacement({
        projectId,
        role: 'implementer',
        workSize: 'average',
        reasoningBudget: 'standard',
        accounts: [{ provider: 'claude', account: 'default' }],
        nowMs: Date.now(),
        store,
      });

      expect(resolution.kind).toBe('placed');
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
});
