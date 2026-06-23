import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openProjectStore } from '../store/sqlite-store.js';
import { openConfigStore } from '../config/config-store.js';
import { applyEvent, rebuildAll } from '../replay/projector.js';
import { decode } from '../replay/decode.js';
import { assertRepoPristine } from '../config/pristine.js';
import {
  dispatchSchemas,
  dispatchUpcasters,
  DISPATCH_EVENT_V,
  EVENT_COST_RECORDED,
  EVENT_PLACEMENT_DECIDED,
  EVENT_USAGE_OBSERVED,
  costScope,
  makeCostNearBudgetEvent,
  makeCostRecordedEvent,
  makePlacementDecidedEvent,
  makeUsageObservedEvent,
  placementScope,
  usageScope,
} from './events.js';
import { UsageProjector, ensureUsageTables } from './usage-projector.js';
import { CostProjector, ensureCostTables } from './cost-projector.js';
import { PlacementProjector, ensurePlacementTable } from './placement-projector.js';
import {
  ACCOUNT_STATUS_SEED_SOURCE,
  COST_BUDGET_CENTS_KEY,
  observeUsage,
  openDispatchStore,
  resolveBudgetCap,
  resolveBudgetCapCents,
  seedInitialAccountStatuses,
} from './dispatch-store.js';
import { FakeUsageSource, UsageUnavailableError, type UsageSnapshot } from './usage-source.js';
import { isStale } from './policy.js';
import { candidatesFromStore } from './balancer.js';

// ── Program-data dir per test (mirrors worktree-store.test.ts) ────────────────────────────────────
const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let repoDirs: string[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  repoDirs = [];
  const dir = mkdtempSync(join(tmpdir(), 'co-dispatch-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const dir of [...dataDirs, ...repoDirs]) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
  repoDirs = [];
});

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-dispatch-repo-'));
  repoDirs.push(dir);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}

const claudeSnap: UsageSnapshot = {
  provider: 'claude',
  account: 'claude:max',
  windows: [
    { kind: 'five_hour', used_pct: 42, reset_at: '2026-06-03T05:00:00.000Z' },
    { kind: 'weekly', used_pct: 13, reset_at: '2026-06-10T00:00:00.000Z' },
  ],
  available: true,
  source: 'fake',
  sampled_at: '2026-06-03T00:00:00.000Z',
};

const claudeDown: UsageSnapshot = {
  provider: 'claude',
  account: 'claude:max',
  windows: [],
  available: false,
  source: 'fake',
  sampled_at: '2026-06-03T02:00:00.000Z',
};

// ── Proof #2: a fake signal updates a bucket ─────────────────────────────────────────────────────
describe('recordSnapshot — a FakeUsageSource snapshot updates provider-account window buckets', () => {
  it('folds every window into its bucket with the expected used_pct/reset_at/source/sampled_at', async () => {
    const source = new FakeUsageSource(new Map([['claude', claudeSnap]]));
    const store = openDispatchStore('p-fake');
    try {
      const snapshot = await source.read('claude');
      const result = store.recordSnapshot(snapshot);
      expect(result.account.available).toBe(true);
      expect(result.buckets).toHaveLength(2);

      const five = store.getBucket('claude:max', 'five_hour');
      expect(five).toEqual({
        provider: 'claude',
        account: 'claude:max',
        windowKind: 'five_hour',
        usedPct: 42,
        resetAt: '2026-06-03T05:00:00.000Z',
        source: 'fake',
        sampledAt: '2026-06-03T00:00:00.000Z',
      });
      expect(store.getBucket('claude:max', 'weekly')?.usedPct).toBe(13);
      // A later sample supersedes (last write wins).
      store.recordSnapshot({
        ...claudeSnap,
        windows: [{ kind: 'five_hour', used_pct: 88, reset_at: '2026-06-03T05:00:00.000Z' }],
        sampled_at: '2026-06-03T01:00:00.000Z',
      });
      expect(store.getBucket('claude:max', 'five_hour')?.usedPct).toBe(88);
    } finally {
      store.close();
    }
  });

  it('exposes headroom as a known discriminated value for an observed window', () => {
    const store = openDispatchStore('p-headroom');
    try {
      store.recordSnapshot(claudeSnap);
      const hr = store.getHeadroom('claude:max', 'five_hour');
      expect(hr).toEqual({ kind: 'known', used_pct: 42, reset_at: '2026-06-03T05:00:00.000Z' });
    } finally {
      store.close();
    }
  });

  it('keys usage state by provider + account, so equal account labels do not collide', () => {
    const store = openDispatchStore('p-provider-account-key');
    try {
      store.recordSnapshot({
        provider: 'claude',
        account: 'default',
        available: true,
        source: 'fake',
        sampled_at: '2026-06-03T00:00:00.000Z',
        windows: [{ kind: 'primary', used_pct: 80, reset_at: '2026-06-03T05:00:00.000Z' }],
      });
      store.recordSnapshot({
        provider: 'codex',
        account: 'default',
        available: true,
        source: 'fake',
        sampled_at: '2026-06-03T00:01:00.000Z',
        windows: [{ kind: 'primary', used_pct: 10, reset_at: '2026-06-03T05:00:00.000Z' }],
      });

      expect(store.getBucket('claude', 'default', 'primary')?.usedPct).toBe(80);
      expect(store.getBucket('codex', 'default', 'primary')?.usedPct).toBe(10);
      expect(store.getAccountStatus('claude', 'default')?.provider).toBe('claude');
      expect(store.getAccountStatus('codex', 'default')?.provider).toBe('codex');
      expect(store.getHeadroom('claude', 'default', 'primary')).toEqual({
        kind: 'known',
        used_pct: 80,
        reset_at: '2026-06-03T05:00:00.000Z',
      });
      expect(store.getHeadroom('codex', 'default', 'primary')).toEqual({
        kind: 'known',
        used_pct: 10,
        reset_at: '2026-06-03T05:00:00.000Z',
      });
      expect(() => store.getBucket('default', 'primary')).toThrow(/ambiguous account-only/i);
      expect(() => store.getAccountStatus('default')).toThrow(/ambiguous account-only/i);
      expect(() => store.getHeadroom('default', 'primary')).toThrow(/ambiguous account-only/i);
    } finally {
      store.close();
    }
  });

  it('fails loud for account-only bucket lookup when providers share a label with disjoint windows', () => {
    const store = openDispatchStore('p-provider-account-disjoint-window');
    try {
      store.recordSnapshot({
        provider: 'claude',
        account: 'default',
        available: true,
        source: 'fake',
        sampled_at: '2026-06-03T00:00:00.000Z',
        windows: [{ kind: 'five_hour', used_pct: 80, reset_at: '2026-06-03T05:00:00.000Z' }],
      });
      store.recordSnapshot({
        provider: 'codex',
        account: 'default',
        available: true,
        source: 'fake',
        sampled_at: '2026-06-03T00:01:00.000Z',
        windows: [{ kind: 'primary', used_pct: 10, reset_at: '2026-06-03T05:00:00.000Z' }],
      });

      expect(store.getBucket('claude', 'default', 'five_hour')?.usedPct).toBe(80);
      expect(store.getBucket('codex', 'default', 'primary')?.usedPct).toBe(10);
      expect(() => store.getBucket('default', 'five_hour')).toThrow(/ambiguous account-only/i);
      expect(() => store.getHeadroom('default', 'five_hour')).toThrow(/ambiguous account-only/i);
    } finally {
      store.close();
    }
  });
});

// ── Proof #2b: a fresh box seeds an initial unavailable status per provider (#122/#125/#88) ────────
describe('seedInitialAccountStatuses — seeds a no-data status per configured provider on a fresh box', () => {
  it('writes one available:false row per configured provider with a no-data reason (never a fake 0%)', () => {
    const store = openDispatchStore('p-seed-fresh');
    try {
      seedInitialAccountStatuses(store, ['claude', 'codex']);
      const statuses = store.readAccountStatuses();
      expect(statuses).toHaveLength(2);
      const claude = statuses.find((s) => s.provider === 'claude');
      const codex = statuses.find((s) => s.provider === 'codex');
      expect(claude).toBeDefined();
      expect(codex).toBeDefined();
      expect(claude?.available).toBe(false);
      expect(claude?.reason).toMatch(/no usage observed/i);
      expect(claude?.source).toBe(ACCOUNT_STATUS_SEED_SOURCE);
      expect(codex?.available).toBe(false);
      // No bucket is fabricated for an unseen window — the seed marks the account unavailable only.
      expect(store.readBuckets()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('defaults to ALL providers when none are passed', () => {
    const store = openDispatchStore('p-seed-default');
    try {
      seedInitialAccountStatuses(store);
      const providers = new Set(store.readAccountStatuses().map((s) => s.provider));
      expect(providers).toEqual(new Set(['claude', 'codex']));
    } finally {
      store.close();
    }
  });

  it('a later REAL read UPSERTS the seed row (one row, available:true, source != seed)', () => {
    const store = openDispatchStore('p-seed-upsert');
    try {
      seedInitialAccountStatuses(store, ['claude']);
      expect(store.readAccountStatuses()).toHaveLength(1);
      // A real available Claude snapshot arrives afterwards.
      store.recordSnapshot(claudeSnap);
      const statuses = store.readAccountStatuses().filter((s) => s.provider === 'claude');
      expect(statuses).toHaveLength(1); // upserted, not duplicated
      const claude = statuses[0]!;
      expect(claude.available).toBe(true);
      expect(claude.source).not.toBe(ACCOUNT_STATUS_SEED_SOURCE);
    } finally {
      store.close();
    }
  });

  it('does NOT overwrite an existing real status when re-run (idempotent guard)', () => {
    const store = openDispatchStore('p-seed-guard');
    try {
      // A real read lands first.
      store.recordSnapshot(claudeSnap);
      const before = store.getAccountStatus('claude', 'claude:max');
      expect(before?.available).toBe(true);
      // Seeding afterwards must be a no-op for the already-known account.
      seedInitialAccountStatuses(store, ['claude']);
      const after = store.getAccountStatus('claude', 'claude:max');
      expect(after?.available).toBe(true);
      expect(after?.source).not.toBe(ACCOUNT_STATUS_SEED_SOURCE);
      expect(store.readAccountStatuses().filter((s) => s.provider === 'claude')).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});

// ── Proof #3: cost rollup per agent AND per task ─────────────────────────────────────────────────
describe('recordCost — rolls up per agent AND per task (dollars where present; tokens for Codex)', () => {
  it('sums dollars + tokens across agents and tasks correctly', () => {
    const store = openDispatchStore('p-rollup');
    try {
      store.recordCost({
        provider: 'claude',
        agent: 'a1',
        task: 't1',
        turn: 0,
        cost_usd: 1.5,
        input_tokens: 100,
        output_tokens: 200,
        total_tokens: 300,
      });
      store.recordCost({
        provider: 'claude',
        agent: 'a1',
        task: 't1',
        turn: 1,
        cost_usd: 2.0,
        input_tokens: 50,
        output_tokens: 60,
        total_tokens: 110,
      });
      // Codex turn on the SAME task, different agent: NO dollar cost, expressed as usage-%/tokens.
      store.recordCost({
        provider: 'codex',
        agent: 'a2',
        task: 't1',
        turn: 0,
        used_pct: 5,
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
      });

      const a1 = store.getRollup('agent', 'a1');
      expect(a1?.totalCostUsd).toBe(3.5);
      expect(a1?.costUsdObservations).toBe(2);
      expect(a1?.totalTokens).toBe(410);
      expect(a1?.tokenObservations).toBe(2);
      expect(a1?.observations).toBe(2);

      const a2 = store.getRollup('agent', 'a2');
      expect(a2?.totalCostUsd).toBe(0); // Codex has no native dollar cost (no price table)
      expect(a2?.costUsdObservations).toBe(0);
      expect(a2?.usedPct).toBe(5);
      expect(a2?.usedPctObservations).toBe(1);
      expect(a2?.totalTokens).toBe(30);
      expect(a2?.tokenObservations).toBe(1);

      const t1 = store.getRollup('task', 't1');
      expect(t1?.totalCostUsd).toBe(3.5); // only a1's dollars
      expect(t1?.costUsdObservations).toBe(2);
      expect(t1?.totalTokens).toBe(440); // 300 + 110 + 30
      expect(t1?.tokenObservations).toBe(3);
      expect(t1?.usedPct).toBe(5); // only a2's usage-%
      expect(t1?.usedPctObservations).toBe(1);
      expect(t1?.observations).toBe(3);
    } finally {
      store.close();
    }
  });

  it('sums prompt-cache tokens and exposes the canonical AgentCostRollup', () => {
    const store = openDispatchStore('p-rollup-cache');
    try {
      store.recordCost({
        provider: 'claude',
        agent: 'a1',
        task: 't1',
        turn: 0,
        cost_usd: 1.5,
        input_tokens: 100,
        output_tokens: 200,
        total_tokens: 300,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 250,
      });
      store.recordCost({
        provider: 'claude',
        agent: 'a1',
        task: 't1',
        turn: 1,
        cost_usd: 0.5,
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
        cache_read_input_tokens: 4000,
        cache_creation_input_tokens: 0,
      });

      const rollup = store.getRollup('agent', 'a1');
      expect(rollup?.cacheReadTokens).toBe(5000);
      expect(rollup?.cacheCreationTokens).toBe(250);

      // Canonical read-model: dollars present ⇒ costUsd is the sum (not null), cache tokens summed.
      const agent = store.getAgentCostRollup('a1');
      expect(agent).toEqual({
        agentId: 'a1',
        inputTokens: 110,
        outputTokens: 220,
        cacheReadTokens: 5000,
        cacheCreationTokens: 250,
        totalTokens: 330,
        costUsd: 2.0,
      });
      expect(store.getAgentCostRollup('unknown')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('getAgentCostRollup reports costUsd null when no dollar cost was reported (Codex)', () => {
    const store = openDispatchStore('p-rollup-codex-null');
    try {
      store.recordCost({
        provider: 'codex',
        agent: 'cx',
        task: 't1',
        turn: 0,
        used_pct: 5,
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
      });
      const agent = store.getAgentCostRollup('cx');
      expect(agent?.costUsd).toBeNull();
      expect(agent?.totalTokens).toBe(30);
      expect(agent?.cacheReadTokens).toBe(0);
    } finally {
      store.close();
    }
  });

  it('deduplicates repeated provider turn observations before folding rollups', () => {
    const store = openDispatchStore('p-rollup-dedupe');
    try {
      const obs = {
        provider: 'claude' as const,
        agent: 'a1',
        task: 't1',
        turn: 0,
        cost_usd: 1.5,
        input_tokens: 100,
        output_tokens: 200,
        total_tokens: 300,
      };

      const first = store.recordCost(obs);
      const duplicate = store.recordCost(obs);

      expect(first.task.totalCostUsd).toBe(1.5);
      expect(duplicate.task.totalCostUsd).toBe(1.5);
      expect(store.getRollup('agent', 'a1')?.observations).toBe(1);
      expect(store.getRollup('task', 't1')?.totalTokens).toBe(300);
    } finally {
      store.close();
    }
  });

  it('deduplicates repeated provider source observations across different proposed turns', () => {
    const store = openDispatchStore('p-rollup-source-dedupe');
    try {
      store.recordCost({
        provider: 'claude',
        agent: 'a1',
        task: 't1',
        turn: 0,
        source_id: 'claude-jsonl:v1:path:12',
        input_tokens: 100,
        output_tokens: 200,
      });
      const duplicate = store.recordCost({
        provider: 'claude',
        agent: 'a1',
        task: 't1',
        turn: 1,
        source_id: 'claude-jsonl:v1:path:12',
        input_tokens: 100,
        output_tokens: 200,
      });

      expect(duplicate.agent.inputTokens).toBe(100);
      expect(duplicate.agent.totalTokens).toBe(300);
      expect(duplicate.agent.observations).toBe(1);
      expect(store.latestCostSourceId('claude', 'a1', 't1')).toBe('claude-jsonl:v1:path:12');
    } finally {
      store.close();
    }
  });

  it('fails loud on conflicting source observations at a different turn', () => {
    const store = openDispatchStore('p-rollup-source-conflict');
    try {
      store.recordCost({
        provider: 'claude',
        agent: 'a1',
        task: 't1',
        turn: 0,
        source_id: 'claude-jsonl:v1:path:12',
        input_tokens: 100,
        output_tokens: 200,
      });
      expect(() =>
        store.recordCost({
          provider: 'claude',
          agent: 'a1',
          task: 't1',
          turn: 1,
          source_id: 'claude-jsonl:v1:path:12',
          input_tokens: 999,
          output_tokens: 200,
        }),
      ).toThrow(/conflicting duplicate cost observation/);
    } finally {
      store.close();
    }
  });

  it('backfills cost observation identities for pre-idempotency rollups before accepting duplicates', () => {
    const pid = 'p-rollup-legacy-dedupe';
    const obs = {
      provider: 'codex' as const,
      agent: 'a1',
      task: 't1',
      turn: 0,
      used_pct: 0,
      total_tokens: 10,
    };
    const project = openProjectStore(pid);
    try {
      project.transaction((tx) => {
        tx.append([makeCostRecordedEvent(pid, obs), makeCostRecordedEvent(pid, obs)]);
        const db = tx.raw as DatabaseSync;
        ensureCostTables(db);
        db.prepare(
          `INSERT INTO cost_rollup
             (kind, id, total_cost_usd, input_tokens, output_tokens, total_tokens, used_pct, observations)
           VALUES
             ('agent', 'a1', 0, 0, 0, 20, 0, 2),
             ('task', 't1', 0, 0, 0, 20, 0, 2)`,
        ).run();
      });
    } finally {
      project.close();
    }

    const store = openDispatchStore(pid);
    try {
      const duplicate = store.recordCost(obs);

      expect(duplicate.agent.totalTokens).toBe(10);
      expect(duplicate.agent.observations).toBe(1);
      expect(duplicate.agent.usedPctObservations).toBe(1);
      expect(duplicate.agent.tokenObservations).toBe(1);
      expect(duplicate.task.totalTokens).toBe(10);
      expect(duplicate.task.observations).toBe(1);
      expect(duplicate.task.usedPctObservations).toBe(1);
      expect(duplicate.task.tokenObservations).toBe(1);
    } finally {
      store.close();
    }
  });

  it('fails loud on conflicting duplicate cost observations', () => {
    const store = openDispatchStore('p-rollup-conflict');
    const budget = { capCents: 1000 };
    try {
      store.recordCost(
        { provider: 'claude', agent: 'a1', task: 't1', turn: 0, cost_usd: 5 },
        budget,
      );

      expect(() =>
        store.recordCost(
          { provider: 'claude', agent: 'a1', task: 't1', turn: 0, cost_usd: 9 },
          budget,
        ),
      ).toThrow(/conflicting duplicate cost observation/);

      expect(store.getRollup('task', 't1')?.totalCostUsd).toBe(5);
      expect(store.readNearBudget('t1')).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('rejects empty cost observations without reserving the idempotency key', () => {
    const store = openDispatchStore('p-rollup-empty');
    try {
      expect(() =>
        store.recordCost({ provider: 'codex', agent: 'a1', task: 't1', turn: 0 }),
      ).toThrow(/at least one measured field/);
      expect(store.getRollup('task', 't1')).toBeUndefined();

      const recorded = store.recordCost({
        provider: 'codex',
        agent: 'a1',
        task: 't1',
        turn: 0,
        used_pct: 3,
      });
      expect(recorded.task.usedPct).toBe(3);

      // A cache-token-only payload is also non-vacuous (the refine's cache-token accept-branch).
      const cacheOnly = store.recordCost({
        provider: 'claude',
        agent: 'a1',
        task: 't1',
        turn: 1,
        cache_read_input_tokens: 100,
      });
      expect(cacheOnly.agent.cacheReadTokens).toBe(100);
    } finally {
      store.close();
    }
  });

  it('derives total_tokens from input + output tokens when total is absent', () => {
    const store = openDispatchStore('p-rollup-token-derive');
    try {
      const recorded = store.recordCost({
        provider: 'codex',
        agent: 'a1',
        task: 't1',
        turn: 0,
        input_tokens: 7,
        output_tokens: 8,
      });

      expect(recorded.agent.totalTokens).toBe(15);
      expect(recorded.task.totalTokens).toBe(15);
    } finally {
      store.close();
    }
  });
});

// ── Proof #4: near-budget observability event (never a gate) ─────────────────────────────────────
describe('recordCost — near-budget crossing emits the observability event (and only at the crossing)', () => {
  it('fires once when the task cost crosses the band; stays silent under it and after it', () => {
    const store = openDispatchStore('p-near');
    const budget = { capCents: 1000 }; // $10 cap; 80% band starts at $8.
    try {
      const r1 = store.recordCost(
        { provider: 'claude', agent: 'a1', task: 't1', turn: 0, cost_usd: 5 },
        budget,
      );
      expect(r1.nearBudget).toBeUndefined(); // $5 < $8

      const r2 = store.recordCost(
        { provider: 'claude', agent: 'a1', task: 't1', turn: 1, cost_usd: 4 },
        budget,
      );
      expect(r2.nearBudget).toBeDefined(); // $9 ≥ $8 → crosses
      expect(r2.nearBudget?.totalCostUsd).toBe(9);
      expect(r2.nearBudget?.capCents).toBe(1000);
      expect(r2.nearBudget?.task).toBe('t1');

      const r3 = store.recordCost(
        { provider: 'claude', agent: 'a1', task: 't1', turn: 2, cost_usd: 1 },
        budget,
      );
      expect(r3.nearBudget).toBeUndefined(); // already in band → no re-fire

      // Exactly one recorded crossing for the task; it never blocked any recordCost (all returned).
      expect(store.readNearBudget('t1')).toHaveLength(1);

      // A different task under the cap never fires.
      const r4 = store.recordCost(
        { provider: 'claude', agent: 'a1', task: 't2', turn: 0, cost_usd: 1 },
        budget,
      );
      expect(r4.nearBudget).toBeUndefined();
      expect(store.readNearBudget('t2')).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('with NO budget supplied, near-budget is never evaluated (observability is opt-in)', () => {
    const store = openDispatchStore('p-nobudget');
    try {
      const r = store.recordCost({
        provider: 'claude',
        agent: 'a1',
        task: 't1',
        turn: 0,
        cost_usd: 999,
      });
      expect(r.nearBudget).toBeUndefined();
      expect(store.readNearBudget()).toHaveLength(0);
    } finally {
      store.close();
    }
  });
});

// ── Proof #5: missing-source fail-loud → typed error AND headroom unknown ─────────────────────────
describe('fail-loud (AC6, Principle 9) — unavailable usage never reads as healthy / 0%', () => {
  it('observeUsage throws UsageUnavailableError when the source THROWS; headroom stays unknown', async () => {
    const thrower = new FakeUsageSource({ errors: { claude: new Error('not logged in') } });
    const store = openDispatchStore('p-throw');
    try {
      await expect(observeUsage(thrower, 'claude', store)).rejects.toBeInstanceOf(
        UsageUnavailableError,
      );
      // The account was never observed ⇒ headroom unknown (NOT 0%, NOT healthy).
      const hr = store.getHeadroom('claude:max', 'five_hour');
      expect(hr.kind).toBe('unknown');
    } finally {
      store.close();
    }
  });

  it('observeUsage throws on an available:false snapshot AND marks the account headroom unknown', async () => {
    const downSource = new FakeUsageSource(new Map([['claude', claudeDown]]));
    const store = openDispatchStore('p-down');
    try {
      const err = await observeUsage(downSource, 'claude', store).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UsageUnavailableError);
      expect((err as UsageUnavailableError).code).toBe('usage_source_unavailable');

      const status = store.getAccountStatus('claude:max');
      expect(status?.available).toBe(false);
      const hr = store.getHeadroom('claude:max', 'five_hour');
      expect(hr.kind).toBe('unknown');
      if (hr.kind === 'unknown') expect(hr.reason).toMatch(/unavailable/);
    } finally {
      store.close();
    }
  });

  it('an unavailable snapshot shadows a previously-known bucket (never silently healthy again)', () => {
    const store = openDispatchStore('p-shadow');
    try {
      store.recordSnapshot(claudeSnap); // known: 42%
      expect(store.getHeadroom('claude:max', 'five_hour').kind).toBe('known');
      const result = store.recordSnapshot(claudeDown); // now unavailable
      expect(result.buckets).toEqual([]);
      expect(store.getHeadroom('claude:max', 'five_hour').kind).toBe('unknown');
      // The stale bucket row still exists, but it is shadowed by the account status — not surfaced.
      expect(store.getBucket('claude:max', 'five_hour')?.usedPct).toBe(42);
    } finally {
      store.close();
    }
  });

  it('an available windowless sample clears old buckets and leaves headroom unknown', () => {
    const store = openDispatchStore('p-windowless');
    try {
      store.recordSnapshot(claudeSnap);
      expect(store.getBucket('claude:max', 'five_hour')).toBeDefined();

      store.recordSnapshot({
        ...claudeSnap,
        windows: [],
        sampled_at: '2026-06-03T03:00:00.000Z',
      });

      expect(store.getBucket('claude:max', 'five_hour')).toBeUndefined();
      expect(store.getBucket('claude:max', 'weekly')).toBeUndefined();
      expect(store.getAccountStatus('claude:max')?.available).toBe(true);
      const headroom = store.getHeadroom('claude:max', 'five_hour');
      expect(headroom.kind).toBe('unknown');
    } finally {
      store.close();
    }
  });

  it('a later available snapshot replaces omitted old windows instead of leaving phantom buckets', () => {
    const store = openDispatchStore('p-replace-windows');
    try {
      store.recordSnapshot(claudeSnap);
      expect(store.getBucket('claude:max', 'weekly')).toBeDefined();

      store.recordSnapshot({
        ...claudeSnap,
        windows: [{ kind: 'five_hour', used_pct: 10, reset_at: '2026-06-03T05:00:00.000Z' }],
        sampled_at: '2026-06-03T03:00:00.000Z',
      });

      expect(store.getBucket('claude:max', 'weekly')).toBeUndefined();
      const candidates = candidatesFromStore(
        store,
        [{ provider: 'claude', account: 'claude:max' }],
        { nowMs: Date.parse('2026-06-03T03:01:00.000Z') },
      );
      expect(candidates[0]?.headroom).toEqual({
        kind: 'known',
        used_pct: 10,
        reset_at: '2026-06-03T05:00:00.000Z',
      });
    } finally {
      store.close();
    }
  });

  it('repairs old account-only usage projection tables before writing provider-scoped buckets', () => {
    const project = openProjectStore('p-old-usage-schema');
    try {
      project.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        db.exec(`
          CREATE TABLE usage_buckets (
            account     TEXT NOT NULL,
            window_kind TEXT NOT NULL,
            provider    TEXT NOT NULL,
            used_pct    REAL NOT NULL,
            reset_at    TEXT NOT NULL,
            source      TEXT NOT NULL,
            sampled_at  TEXT NOT NULL,
            ts          INTEGER NOT NULL,
            PRIMARY KEY (account, window_kind)
          );
          CREATE TABLE usage_accounts (
            account    TEXT PRIMARY KEY,
            provider   TEXT NOT NULL,
            available  INTEGER NOT NULL,
            reason     TEXT,
            source     TEXT NOT NULL,
            sampled_at TEXT NOT NULL,
            ts         INTEGER NOT NULL
          );
        `);
      });
    } finally {
      project.close();
    }

    const store = openDispatchStore('p-old-usage-schema');
    try {
      store.recordSnapshot({
        provider: 'claude',
        account: 'default',
        available: true,
        source: 'fake',
        sampled_at: '2026-06-03T00:00:00.000Z',
        windows: [{ kind: 'primary', used_pct: 80, reset_at: '2026-06-03T05:00:00.000Z' }],
      });
      store.recordSnapshot({
        provider: 'codex',
        account: 'default',
        available: true,
        source: 'fake',
        sampled_at: '2026-06-03T00:01:00.000Z',
        windows: [{ kind: 'primary', used_pct: 10, reset_at: '2026-06-03T05:00:00.000Z' }],
      });

      expect(store.getBucket('claude', 'default', 'primary')?.usedPct).toBe(80);
      expect(store.getBucket('codex', 'default', 'primary')?.usedPct).toBe(10);
    } finally {
      store.close();
    }
  });

  it('a source THROW with an account marks that account unavailable and shadows stale healthy buckets', async () => {
    const store = openDispatchStore('p-transient');
    try {
      store.recordSnapshot(claudeSnap); // a recent KNOWN reading: 42% @ sampled 2026-06-03T00:00Z
      const knownBefore = store.getHeadroom('claude:max', 'five_hour');
      expect(knownBefore.kind).toBe('known');

      const thrower = new FakeUsageSource({
        errors: {
          claude: new UsageUnavailableError('claude', 'socket reset', { account: 'claude:max' }),
        },
      });

      await expect(observeUsage(thrower, 'claude', store)).rejects.toBeInstanceOf(
        UsageUnavailableError,
      );

      const status = store.getAccountStatus('claude', 'claude:max');
      expect(status?.available).toBe(false);
      expect(status?.reason).toMatch(/socket reset/);
      const headroom = store.getHeadroom('claude', 'claude:max', 'five_hour');
      expect(headroom.kind).toBe('unknown');
      if (headroom.kind === 'unknown') expect(headroom.reason).toMatch(/socket reset/);

      // The raw bucket row remains for audit/history but is shadowed by the unavailable account state.
      const bucket = store.getBucket('claude:max', 'five_hour')!;
      const sampledMs = Date.parse(bucket.sampledAt);
      expect(isStale(bucket, sampledMs + 60_000)).toBe(false); // still fresh right after the sample
    } finally {
      store.close();
    }
  });
});

// ── Budget cap resolved from the L0 config cascade (heir to cost_budget_cents) ────────────────────
describe('resolveBudgetCap — reads the cap from the config cascade (program-data only)', () => {
  it('resolves a configured project override and drives a config-backed near-budget crossing', () => {
    const config = openConfigStore();
    try {
      config.setProjectOverride('p-cfg', COST_BUDGET_CENTS_KEY, 500); // $5 cap
    } finally {
      config.close();
    }
    expect(resolveBudgetCapCents('p-cfg')).toBe(500);
    expect(resolveBudgetCap('p-cfg')?.capCents).toBe(500);
    expect(resolveBudgetCapCents('p-unconfigured')).toBeUndefined();
    expect(resolveBudgetCap('p-unconfigured')).toBeUndefined();

    const store = openDispatchStore('p-cfg');
    try {
      const cap = resolveBudgetCap('p-cfg'); // { capCents: 500 } ⇒ band at $4
      const r = store.recordCost(
        { provider: 'claude', agent: 'a1', task: 't1', turn: 0, cost_usd: 5 },
        cap,
      );
      expect(r.nearBudget).toBeDefined(); // $5 ≥ $4
      expect(r.nearBudget?.capCents).toBe(500);
    } finally {
      store.close();
    }
  });

  it('throws fail-loud on malformed budget caps and thresholds', () => {
    const config = openConfigStore();
    try {
      config.setProjectOverride('p-string-cap', COST_BUDGET_CENTS_KEY, '500');
      expect(() => resolveBudgetCapCents('p-string-cap', config)).toThrow(
        /malformed 'cost_budget_cents'/,
      );

      config.setProjectOverride('p-negative-cap', COST_BUDGET_CENTS_KEY, -1);
      expect(() => resolveBudgetCap('p-negative-cap', { config })).toThrow(
        /malformed 'cost_budget_cents'/,
      );

      config.setProjectOverride('p-good-cap', COST_BUDGET_CENTS_KEY, 500);
      expect(() => resolveBudgetCap('p-good-cap', { config, thresholdPct: 101 })).toThrow(
        /threshold/i,
      );
      expect(() => resolveBudgetCap('p-good-cap', { config, thresholdPct: Number.NaN })).toThrow(
        /threshold/i,
      );
    } finally {
      config.close();
    }
  });
});

// ── Proof #1: replay-equality (AC5, Principle 14) ────────────────────────────────────────────────
describe('AC5 — the dispatch read-model rebuilds byte-identical from the L0 log', () => {
  function snapshot(db: DatabaseSync): string {
    ensureUsageTables(db);
    ensureCostTables(db);
    ensurePlacementTable(db);
    return JSON.stringify({
      usage_buckets: db
        .prepare(
          'SELECT provider, account, window_kind, used_pct, reset_at, source, sampled_at, ts FROM usage_buckets ORDER BY provider, account, window_kind',
        )
        .all(),
      usage_accounts: db
        .prepare(
          'SELECT provider, account, available, reason, source, sampled_at, ts FROM usage_accounts ORDER BY provider, account',
        )
        .all(),
      cost_rollup: db
        .prepare(
          'SELECT kind, id, total_cost_usd, cost_usd_observations, input_tokens, output_tokens, total_tokens, token_observations, cache_read_tokens, cache_creation_tokens, used_pct, used_pct_observations, observations FROM cost_rollup ORDER BY kind, id',
        )
        .all(),
      cost_observations: db
        .prepare(
          'SELECT provider, agent, task, turn, cost_usd, input_tokens, output_tokens, total_tokens, cache_read_tokens, cache_creation_tokens, used_pct FROM cost_observations ORDER BY provider, agent, task, turn',
        )
        .all(),
      cost_near_budget: db
        .prepare(
          'SELECT seq, task, agent, provider, total_cost_usd, cap_cents, threshold_pct, ts FROM cost_near_budget ORDER BY seq',
        )
        .all(),
      placement_records: db
        .prepare(
          'SELECT seq, agent, role, work_size, reasoning_budget, kind, provider, account, model, effort, context, eta_reset_at, reason, maxed_providers, maxed_accounts, unavailable_providers, unavailable_accounts, ts FROM placement_records ORDER BY seq',
        )
        .all(),
    });
  }

  it('live fold → snapshot → rebuildAll → snapshot is byte-equal (non-vacuous)', () => {
    const pid = 'p-replay';
    const store = openProjectStore(pid);
    const projectors = [new UsageProjector(), new CostProjector(), new PlacementProjector()];

    // A representative event sequence covering every fold path: available windows (two), a different
    // account, an unavailable marker, cost across agents/tasks, and a near-budget crossing.
    const sequence = [
      makeUsageObservedEvent(pid, {
        available: true,
        provider: 'claude',
        account: 'claude:max',
        window_kind: 'five_hour',
        used_pct: 42,
        reset_at: '2026-06-03T05:00:00.000Z',
        source: 'fake',
        sampled_at: '2026-06-03T00:00:00.000Z',
      }),
      makeUsageObservedEvent(pid, {
        available: true,
        provider: 'claude',
        account: 'claude:max',
        window_kind: 'weekly',
        used_pct: 13,
        reset_at: '2026-06-10T00:00:00.000Z',
        source: 'fake',
        sampled_at: '2026-06-03T00:00:00.000Z',
      }),
      makeUsageObservedEvent(pid, {
        available: true,
        provider: 'codex',
        account: 'codex:pro',
        window_kind: 'primary',
        used_pct: 10,
        reset_at: '2026-06-03T01:00:00.000Z',
        source: 'fake',
        sampled_at: '2026-06-03T00:00:00.000Z',
      }),
      makeUsageObservedEvent(pid, {
        available: false,
        provider: 'codex',
        account: 'codex:pro',
        reason: 'over limit',
        source: 'fake',
        sampled_at: '2026-06-03T02:00:00.000Z',
      }),
      makeCostRecordedEvent(pid, {
        provider: 'claude',
        agent: 'a1',
        task: 't1',
        turn: 0,
        cost_usd: 5,
        input_tokens: 100,
        output_tokens: 200,
        total_tokens: 300,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 250,
      }),
      makeCostRecordedEvent(pid, {
        provider: 'claude',
        agent: 'a1',
        task: 't1',
        turn: 1,
        cost_usd: 4,
      }),
      makeCostNearBudgetEvent(pid, {
        task: 't1',
        agent: 'a1',
        provider: 'claude',
        total_cost_usd: 9,
        cap_cents: 1000,
        threshold_pct: 80,
      }),
      makePlacementDecidedEvent(pid, 'lead-7', {
        kind: 'placed',
        role: 'implementer',
        work_size: 'average',
        reasoning_budget: 'standard',
        provider: 'claude',
        account: 'claude:max',
        model: 'claude-sonnet-4-6',
        effort: 'high',
        context: 'standard',
      }),
      makePlacementDecidedEvent(pid, 'lead-7', {
        kind: 'waiting',
        role: 'reviewer',
        work_size: 'technical',
        reasoning_budget: 'deep',
        eta_reset_at: '2026-06-03T05:00:00.000Z',
        reason: 'all suitable providers maxed',
        maxed_providers: ['claude', 'codex'],
        maxed_accounts: ['claude:max', 'codex:pro'],
        unavailable_providers: [],
        unavailable_accounts: [],
      }),
    ];

    try {
      for (const e of sequence) {
        store.transaction((tx) => {
          const [s] = tx.append([e]);
          applyEvent(tx, decode(s!, dispatchUpcasters, dispatchSchemas), projectors);
        });
      }
      const live = store.transaction((tx) => snapshot(tx.raw as DatabaseSync));

      rebuildAll(store, projectors, (e) => decode(e, dispatchUpcasters, dispatchSchemas));
      const replayed = store.transaction((tx) => snapshot(tx.raw as DatabaseSync));

      expect(replayed).toBe(live);
      // Guard against a vacuous pass.
      expect(live).toContain('"account":"claude:max"');
      expect(live).toContain('"window_kind":"weekly"');
      expect(live).toContain('"available":0'); // codex:pro went unavailable
      expect(live).toContain('"kind":"agent","id":"a1"');
      expect(live).toContain('"kind":"task","id":"t1"');
      // AC5: the cache token columns are part of the replayed snapshot (summed read=1000, creation=250).
      expect(live).toContain('"cache_read_tokens":1000');
      expect(live).toContain('"cache_creation_tokens":250');
      expect(live).toContain('"cap_cents":1000');
      expect(live).toContain('"kind":"placed","provider":"claude"');
      expect(live).toContain('"kind":"waiting"');
      expect(live).toContain('"maxed_providers":"[\\"claude\\",\\"codex\\"]"');
      expect(live).toContain('"maxed_accounts":"[\\"claude:max\\",\\"codex:pro\\"]"');
      expect(live).toContain('"unavailable_providers":"[]"');
      expect(live).toContain('"unavailable_accounts":"[]"');
    } finally {
      store.close();
    }
  });

  it('replays complete snapshot clears so omitted old windows stay gone after rebuildAll', () => {
    const pid = 'p-replay-cleared-windows';
    const store = openDispatchStore(pid);
    try {
      store.recordSnapshot(claudeSnap);
      store.recordSnapshot({
        ...claudeSnap,
        windows: [{ kind: 'five_hour', used_pct: 10, reset_at: '2026-06-03T05:00:00.000Z' }],
        sampled_at: '2026-06-03T03:00:00.000Z',
      });
      expect(store.getBucket('claude', 'claude:max', 'weekly')).toBeUndefined();
    } finally {
      store.close();
    }

    const project = openProjectStore(pid);
    try {
      rebuildAll(project, [new UsageProjector()], (e) =>
        decode(e, dispatchUpcasters, dispatchSchemas),
      );
    } finally {
      project.close();
    }

    const replayed = openDispatchStore(pid);
    try {
      expect(replayed.getBucket('claude', 'claude:max', 'weekly')).toBeUndefined();
      expect(replayed.getBucket('claude', 'claude:max', 'five_hour')?.usedPct).toBe(10);
    } finally {
      replayed.close();
    }
  });

  it('replays legacy account-only usage scopes for existing v1 events', () => {
    const pid = 'p-replay-legacy-usage-scope';
    const store = openProjectStore(pid);
    const projectors = [new UsageProjector()];
    try {
      store.transaction((tx) => {
        const [event] = tx.append([
          {
            projectId: pid,
            scope: usageScope('claude:max'),
            type: EVENT_USAGE_OBSERVED,
            v: DISPATCH_EVENT_V,
            payload: {
              available: true,
              provider: 'claude',
              account: 'claude:max',
              window_kind: 'five_hour',
              used_pct: 42,
              reset_at: '2026-06-03T05:00:00.000Z',
              source: 'legacy',
              sampled_at: '2026-06-03T00:00:00.000Z',
            },
          },
        ]);
        applyEvent(tx, decode(event!, dispatchUpcasters, dispatchSchemas), projectors);
      });

      rebuildAll(store, projectors, (e) => decode(e, dispatchUpcasters, dispatchSchemas));
    } finally {
      store.close();
    }

    const replayed = openDispatchStore(pid);
    try {
      expect(replayed.getBucket('claude', 'claude:max', 'five_hour')?.usedPct).toBe(42);
    } finally {
      replayed.close();
    }
  });

  it('replays legacy placed events without account using the provider default', () => {
    const pid = 'p-replay-legacy-placement-account';
    const store = openProjectStore(pid);
    const projectors = [new PlacementProjector()];
    try {
      store.transaction((tx) => {
        const [event] = tx.append([
          {
            projectId: pid,
            scope: placementScope('lead-7'),
            type: EVENT_PLACEMENT_DECIDED,
            v: DISPATCH_EVENT_V,
            payload: {
              kind: 'placed',
              role: 'implementer',
              work_size: 'average',
              reasoning_budget: 'standard',
              provider: 'claude',
              model: 'claude-sonnet-4-6',
              effort: 'high',
              context: 'standard',
            },
            actor: 'lead-7',
          },
        ]);
        applyEvent(tx, decode(event!, dispatchUpcasters, dispatchSchemas), projectors);
      });

      rebuildAll(store, projectors, (e) => decode(e, dispatchUpcasters, dispatchSchemas));
    } finally {
      store.close();
    }

    const replayed = openDispatchStore(pid);
    try {
      const placement = replayed.readPlacements('lead-7')[0];
      expect(placement?.kind).toBe('placed');
      expect(placement?.account).toBe('claude:max');
    } finally {
      replayed.close();
    }
  });

  it('migrates providerless legacy usage rows when account prefixes identify the provider', () => {
    const pid = 'p-legacy-usage-table-infer';
    const project = openProjectStore(pid);
    try {
      project.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        db.exec(`
          CREATE TABLE usage_buckets (
            account TEXT NOT NULL,
            window_kind TEXT NOT NULL,
            used_pct REAL NOT NULL,
            reset_at TEXT NOT NULL,
            source TEXT NOT NULL,
            sampled_at TEXT NOT NULL,
            ts INTEGER NOT NULL,
            PRIMARY KEY (account, window_kind)
          );
          CREATE TABLE usage_accounts (
            account TEXT PRIMARY KEY,
            available INTEGER NOT NULL,
            reason TEXT,
            source TEXT NOT NULL,
            sampled_at TEXT NOT NULL,
            ts INTEGER NOT NULL
          );
        `);
        db.prepare(
          `INSERT INTO usage_buckets
             (account, window_kind, used_pct, reset_at, source, sampled_at, ts)
           VALUES ('claude:max', 'five_hour', 42, '2026-06-03T05:00:00.000Z', 'legacy', '2026-06-03T00:00:00.000Z', 1)`,
        ).run();
        db.prepare(
          `INSERT INTO usage_accounts
             (account, available, reason, source, sampled_at, ts)
           VALUES ('claude:max', 1, NULL, 'legacy', '2026-06-03T00:00:00.000Z', 1)`,
        ).run();
        ensureUsageTables(db);
      });
    } finally {
      project.close();
    }

    const store = openDispatchStore(pid);
    try {
      expect(store.getBucket('claude', 'claude:max', 'five_hour')?.usedPct).toBe(42);
      expect(store.getAccountStatus('claude', 'claude:max')?.available).toBe(true);
    } finally {
      store.close();
    }
  });

  it('fails loud for ambiguous providerless legacy usage rows instead of dropping them', () => {
    const pid = 'p-legacy-usage-table-ambiguous';
    const project = openProjectStore(pid);
    try {
      expect(() =>
        project.transaction((tx) => {
          const db = tx.raw as DatabaseSync;
          db.exec(`
            CREATE TABLE usage_buckets (
              account TEXT NOT NULL,
              window_kind TEXT NOT NULL,
              used_pct REAL NOT NULL,
              reset_at TEXT NOT NULL,
              source TEXT NOT NULL,
              sampled_at TEXT NOT NULL,
              ts INTEGER NOT NULL,
              PRIMARY KEY (account, window_kind)
            );
          `);
          db.prepare(
            `INSERT INTO usage_buckets
               (account, window_kind, used_pct, reset_at, source, sampled_at, ts)
             VALUES ('team', 'five_hour', 42, '2026-06-03T05:00:00.000Z', 'legacy', '2026-06-03T00:00:00.000Z', 1)`,
          ).run();
          ensureUsageTables(db);
        }),
      ).toThrow(/cannot be safely migrated/i);
    } finally {
      project.close();
    }
  });

  it('rebuildAll can recover from ambiguous legacy usage projection rows using the event log', () => {
    const pid = 'p-legacy-usage-table-rebuild';
    const project = openProjectStore(pid);
    const projectors = [new UsageProjector()];
    try {
      project.transaction((tx) => {
        tx.append([
          makeUsageObservedEvent(pid, {
            available: true,
            provider: 'claude',
            account: 'default',
            window_kind: 'primary',
            used_pct: 42,
            reset_at: '2026-06-03T05:00:00.000Z',
            source: 'event-log',
            sampled_at: '2026-06-03T00:00:00.000Z',
          }),
          makeUsageObservedEvent(pid, {
            available: true,
            provider: 'codex',
            account: 'default',
            window_kind: 'primary',
            used_pct: 7,
            reset_at: '2026-06-03T06:00:00.000Z',
            source: 'event-log',
            sampled_at: '2026-06-03T00:01:00.000Z',
          }),
        ]);

        const db = tx.raw as DatabaseSync;
        db.exec(`
          CREATE TABLE usage_buckets (
            account TEXT NOT NULL,
            window_kind TEXT NOT NULL,
            used_pct REAL NOT NULL,
            reset_at TEXT NOT NULL,
            source TEXT NOT NULL,
            sampled_at TEXT NOT NULL,
            ts INTEGER NOT NULL,
            PRIMARY KEY (account, window_kind)
          );
          CREATE TABLE usage_accounts (
            account TEXT PRIMARY KEY,
            available INTEGER NOT NULL,
            reason TEXT,
            source TEXT NOT NULL,
            sampled_at TEXT NOT NULL,
            ts INTEGER NOT NULL
          );
        `);
        db.prepare(
          `INSERT INTO usage_buckets
             (account, window_kind, used_pct, reset_at, source, sampled_at, ts)
           VALUES ('default', 'primary', 99, '2026-06-03T05:00:00.000Z', 'legacy', '2026-06-03T00:00:00.000Z', 1)`,
        ).run();
        db.prepare(
          `INSERT INTO usage_accounts
             (account, available, reason, source, sampled_at, ts)
           VALUES ('default', 1, NULL, 'legacy', '2026-06-03T00:00:00.000Z', 1)`,
        ).run();
      });

      rebuildAll(project, projectors, (e) => decode(e, dispatchUpcasters, dispatchSchemas));
      const rows = project.transaction((tx) =>
        (tx.raw as DatabaseSync)
          .prepare(
            'SELECT provider, account, window_kind, used_pct FROM usage_buckets ORDER BY provider',
          )
          .all(),
      );
      expect(rows).toEqual([
        { provider: 'claude', account: 'default', window_kind: 'primary', used_pct: 42 },
        { provider: 'codex', account: 'default', window_kind: 'primary', used_pct: 7 },
      ]);
    } finally {
      project.close();
    }
  });
});

// ── AC9 / Principle 12: the recording cores write only program-data, never the repo ──────────────
describe('AC9 — assertRepoPristine holds around the dispatch recording cores', () => {
  it('recordSnapshot + recordCost + recordPlacement write nothing into the target repo', () => {
    const repo = makeRepo();
    const store = openDispatchStore('p-pristine');
    try {
      assertRepoPristine(repo, () => {
        store.recordSnapshot(claudeSnap);
        store.recordCost(
          { provider: 'claude', agent: 'a1', task: 't1', turn: 0, cost_usd: 9 },
          { capCents: 1000 },
        );
        store.recordPlacement('lead-7', {
          kind: 'placed',
          role: 'implementer',
          work_size: 'average',
          reasoning_budget: 'standard',
          provider: 'claude',
          account: 'claude:max',
          model: 'claude-sonnet-4-6',
          effort: 'high',
          context: 'standard',
        });
      });
      expect(store.getBucket('claude:max', 'five_hour')).toBeDefined();
      expect(store.getRollup('task', 't1')).toBeDefined();
      expect(store.readPlacements('lead-7')).toHaveLength(1);
      expect(existsSync(join(repo, '.co'))).toBe(false);
    } finally {
      store.close();
    }
  });
});

// ── DispatchStore.recordPlacement — placement.decided record + read-back ──────────────────────────
describe('DispatchStore.recordPlacement — record + read-back', () => {
  it('records a placed decision and reads it back correctly', () => {
    const store = openDispatchStore('p-placement-placed');
    try {
      const record = store.recordPlacement('agent-1', {
        kind: 'placed',
        role: 'implementer',
        work_size: 'average',
        reasoning_budget: 'standard',
        provider: 'claude',
        account: 'claude:max',
        model: 'claude-sonnet-4-6',
        effort: 'high',
        context: 'standard',
      });
      expect(record.kind).toBe('placed');
      expect(record.agent).toBe('agent-1');
      expect(record.role).toBe('implementer');
      expect(record.workSize).toBe('average');
      expect(record.reasoningBudget).toBe('standard');
      expect(record.provider).toBe('claude');
      expect(record.account).toBe('claude:max');
      expect(record.model).toBe('claude-sonnet-4-6');
      expect(record.effort).toBe('high');
      expect(record.context).toBe('standard');
      expect(record.seq).toBeGreaterThan(0);
      expect(record.recordedTs).toBeGreaterThan(0);

      const all = store.readPlacements();
      expect(all).toHaveLength(1);
      expect(all[0]).toEqual(record);
    } finally {
      store.close();
    }
  });

  it('fails loud when a new placed event omits account', () => {
    const store = openDispatchStore('p-placement-missing-account');
    try {
      expect(() =>
        store.recordPlacement('agent-1', {
          kind: 'placed',
          role: 'implementer',
          work_size: 'average',
          reasoning_budget: 'standard',
          provider: 'claude',
          model: 'claude-sonnet-4-6',
          effort: 'high',
          context: 'standard',
        }),
      ).toThrow(/account/i);
    } finally {
      store.close();
    }
  });

  it('records a waiting decision and reads it back correctly', () => {
    const store = openDispatchStore('p-placement-waiting');
    try {
      const record = store.recordPlacement('agent-2', {
        kind: 'waiting',
        role: 'reviewer',
        work_size: 'simple',
        reasoning_budget: 'economy',
        eta_reset_at: '2026-06-04T10:00:00Z',
        reason: 'all providers maxed',
        maxed_providers: ['claude', 'codex'],
        maxed_accounts: ['claude:max', 'codex:pro'],
        unavailable_providers: [],
        unavailable_accounts: [],
      });
      expect(record.kind).toBe('waiting');
      expect(record.agent).toBe('agent-2');
      expect(record.role).toBe('reviewer');
      expect(record.etaResetAt).toBe('2026-06-04T10:00:00Z');
      expect(record.reason).toBe('all providers maxed');
      expect(record.maxedProviders).toEqual(['claude', 'codex']);
      expect(record.maxedAccounts).toEqual(['claude:max', 'codex:pro']);
      expect(record.unavailableProviders).toEqual([]);
      expect(record.unavailableAccounts).toEqual([]);

      const byAgent = store.readPlacements('agent-2');
      expect(byAgent).toHaveLength(1);
      expect(byAgent[0]!.kind).toBe('waiting');

      // readPlacements with a different agent returns empty
      expect(store.readPlacements('other-agent')).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('readPlacements replay-equal: a fresh store instance reproduces the same rows', () => {
    const store = openDispatchStore('p-placement-replay');
    try {
      store.recordPlacement('agent-3', {
        kind: 'placed',
        role: 'coordinator',
        work_size: 'technical',
        reasoning_budget: 'deep',
        provider: 'claude',
        account: 'claude:max',
        model: 'claude-opus-4-8',
        effort: 'max',
        context: 'extended',
      });
      store.recordPlacement('agent-3', {
        kind: 'waiting',
        role: 'coordinator',
        work_size: 'technical',
        reasoning_budget: 'deep',
        reason: 'claude maxed',
        maxed_providers: ['claude'],
        maxed_accounts: ['claude:max'],
        unavailable_providers: [],
        unavailable_accounts: [],
      });
      const beforeRebuild = store.readPlacements();
      expect(beforeRebuild).toHaveLength(2);
    } finally {
      store.close();
    }

    // Open a second instance over the same data dir — should replay identically.
    const store2 = openDispatchStore('p-placement-replay');
    try {
      const afterRebuild = store2.readPlacements();
      expect(afterRebuild).toHaveLength(2);
      expect(afterRebuild[0]!.kind).toBe('placed');
      expect(afterRebuild[1]!.kind).toBe('waiting');
      expect(afterRebuild[0]!.model).toBe('claude-opus-4-8');
      expect(afterRebuild[1]!.maxedProviders).toEqual(['claude']);
      expect(afterRebuild[1]!.maxedAccounts).toEqual(['claude:max']);
      expect(afterRebuild[1]!.unavailableProviders).toEqual([]);
      expect(afterRebuild[1]!.unavailableAccounts).toEqual([]);
    } finally {
      store2.close();
    }
  });

  it('records unavailable waiting providers separately from capacity-maxed providers', () => {
    const store = openDispatchStore('p-placement-unavailable');
    try {
      const record = store.recordPlacement('agent-4', {
        kind: 'waiting',
        role: 'implementer',
        work_size: 'average',
        reasoning_budget: 'standard',
        reason: 'usage source unavailable',
        maxed_providers: [],
        maxed_accounts: [],
        unavailable_providers: ['claude', 'codex'],
        unavailable_accounts: ['claude:max', 'codex:pro'],
      });

      expect(record.kind).toBe('waiting');
      expect(record.maxedProviders).toEqual([]);
      expect(record.maxedAccounts).toEqual([]);
      expect(record.unavailableProviders).toEqual(['claude', 'codex']);
      expect(record.unavailableAccounts).toEqual(['claude:max', 'codex:pro']);
    } finally {
      store.close();
    }
  });
});

describe('PlacementProjector — placement envelope identity', () => {
  const payload = {
    kind: 'placed' as const,
    role: 'implementer',
    work_size: 'average' as const,
    reasoning_budget: 'standard' as const,
    provider: 'claude' as const,
    account: 'claude:max',
    model: 'claude-sonnet-4-6',
    effort: 'high' as const,
    context: 'standard' as const,
  };

  it('fails loud when the event actor does not match the placement scope agent', () => {
    const store = openProjectStore('p-placement-actor-mismatch');
    const projectors = [new PlacementProjector()];
    try {
      expect(() =>
        store.transaction((tx) => {
          const [event] = tx.append([
            {
              projectId: 'p-placement-actor-mismatch',
              scope: placementScope('lead-7'),
              type: EVENT_PLACEMENT_DECIDED,
              v: DISPATCH_EVENT_V,
              payload,
              actor: 'other-agent',
            },
          ]);
          applyEvent(tx, decode(event!, dispatchUpcasters, dispatchSchemas), projectors);
        }),
      ).toThrow(/actor .* does not match/i);
    } finally {
      store.close();
    }
  });

  it('fails loud when the placement event is not filed under placement:<agent>', () => {
    const store = openProjectStore('p-placement-bad-scope');
    const projectors = [new PlacementProjector()];
    try {
      expect(() =>
        store.transaction((tx) => {
          const [event] = tx.append([
            {
              projectId: 'p-placement-bad-scope',
              scope: 'cost:lead-7',
              type: EVENT_PLACEMENT_DECIDED,
              v: DISPATCH_EVENT_V,
              payload,
              actor: 'lead-7',
            },
          ]);
          applyEvent(tx, decode(event!, dispatchUpcasters, dispatchSchemas), projectors);
        }),
      ).toThrow(/expected scope/i);
    } finally {
      store.close();
    }
  });
});

describe('UsageProjector / CostProjector — event envelope identity', () => {
  it('fails loud when a usage.observed payload does not match usage:<provider>:<account> scope', () => {
    const store = openProjectStore('p-usage-bad-scope');
    const projectors = [new UsageProjector()];
    try {
      expect(() =>
        store.transaction((tx) => {
          const [event] = tx.append([
            {
              projectId: 'p-usage-bad-scope',
              scope: usageScope('claude', 'claude:max'),
              type: EVENT_USAGE_OBSERVED,
              v: DISPATCH_EVENT_V,
              payload: {
                available: true,
                provider: 'codex',
                account: 'codex:pro',
                window_kind: 'primary',
                used_pct: 10,
                reset_at: '2026-06-03T05:00:00.000Z',
                source: 'fake',
                sampled_at: '2026-06-03T00:00:00.000Z',
              },
            },
          ]);
          applyEvent(tx, decode(event!, dispatchUpcasters, dispatchSchemas), projectors);
        }),
      ).toThrow(/usage scope .* does not match/i);
    } finally {
      store.close();
    }
  });

  it('fails loud when a legacy account-only usage scope conflicts with a provider-prefixed account label', () => {
    const store = openProjectStore('p-usage-legacy-provider-mismatch');
    const projectors = [new UsageProjector()];
    try {
      expect(() =>
        store.transaction((tx) => {
          const [event] = tx.append([
            {
              projectId: 'p-usage-legacy-provider-mismatch',
              scope: usageScope('claude:max'),
              type: EVENT_USAGE_OBSERVED,
              v: DISPATCH_EVENT_V,
              payload: {
                available: true,
                provider: 'codex',
                account: 'claude:max',
                window_kind: 'primary',
                used_pct: 10,
                reset_at: '2026-06-03T05:00:00.000Z',
                source: 'legacy',
                sampled_at: '2026-06-03T00:00:00.000Z',
              },
            },
          ]);
          applyEvent(tx, decode(event!, dispatchUpcasters, dispatchSchemas), projectors);
        }),
      ).toThrow(/legacy usage scope .* conflicts/i);
    } finally {
      store.close();
    }
  });

  it('fails loud when a cost.recorded payload does not match cost:<agent> scope/actor', () => {
    const store = openProjectStore('p-cost-bad-scope');
    const projectors = [new CostProjector()];
    try {
      expect(() =>
        store.transaction((tx) => {
          const [event] = tx.append([
            {
              projectId: 'p-cost-bad-scope',
              scope: costScope('agent-1'),
              type: EVENT_COST_RECORDED,
              v: DISPATCH_EVENT_V,
              payload: {
                provider: 'claude',
                agent: 'agent-2',
                task: 'task-1',
                turn: 0,
                cost_usd: 1,
              },
              actor: 'agent-2',
            },
          ]);
          applyEvent(tx, decode(event!, dispatchUpcasters, dispatchSchemas), projectors);
        }),
      ).toThrow(/cost scope .* does not match/i);
    } finally {
      store.close();
    }
  });
});
