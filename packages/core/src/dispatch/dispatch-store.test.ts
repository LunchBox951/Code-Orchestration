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
  makeCostNearBudgetEvent,
  makeCostRecordedEvent,
  makeUsageObservedEvent,
} from './events.js';
import { UsageProjector, ensureUsageTables } from './usage-projector.js';
import { CostProjector, ensureCostTables } from './cost-projector.js';
import {
  COST_BUDGET_CENTS_KEY,
  observeUsage,
  openDispatchStore,
  resolveBudgetCap,
  resolveBudgetCapCents,
} from './dispatch-store.js';
import { FakeUsageSource, UsageUnavailableError, type UsageSnapshot } from './usage-source.js';
import { isStale } from './policy.js';

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
describe('recordSnapshot — a FakeUsageSource snapshot updates the per-(account,window) bucket', () => {
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
      expect(a1?.totalTokens).toBe(410);
      expect(a1?.observations).toBe(2);

      const a2 = store.getRollup('agent', 'a2');
      expect(a2?.totalCostUsd).toBe(0); // Codex has no native dollar cost (no price table)
      expect(a2?.usedPct).toBe(5);
      expect(a2?.totalTokens).toBe(30);

      const t1 = store.getRollup('task', 't1');
      expect(t1?.totalCostUsd).toBe(3.5); // only a1's dollars
      expect(t1?.totalTokens).toBe(440); // 300 + 110 + 30
      expect(t1?.usedPct).toBe(5); // only a2's usage-%
      expect(t1?.observations).toBe(3);
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
      store.recordSnapshot(claudeDown); // now unavailable
      expect(store.getHeadroom('claude:max', 'five_hour').kind).toBe('unknown');
      // The stale bucket row still exists, but it is shadowed by the account status — not surfaced.
      expect(store.getBucket('claude:max', 'five_hour')?.usedPct).toBe(42);
    } finally {
      store.close();
    }
  });

  it('a transient source THROW after a known reading surfaces loudly but does not clobber the bucket; staleness governs eventual unknown', async () => {
    // Intentional Phase-1 contract: a source throw carries no account, so observeUsage cannot know
    // which account to mark unknown — it surfaces the error to the caller (fail-loud) and leaves the
    // last good reading in place. Freshness is then governed by isStale (the Phase-3 balancer reads
    // it); Phase-6 layered source ordering tries other sources before the reading ages out.
    const store = openDispatchStore('p-transient');
    try {
      store.recordSnapshot(claudeSnap); // a recent KNOWN reading: 42% @ sampled 2026-06-03T00:00Z
      const knownBefore = store.getHeadroom('claude:max', 'five_hour');
      expect(knownBefore.kind).toBe('known');

      const thrower = new FakeUsageSource({ errors: { claude: new Error('socket reset') } });
      // The throw still surfaces loudly to the caller …
      await expect(observeUsage(thrower, 'claude', store)).rejects.toBeInstanceOf(
        UsageUnavailableError,
      );
      // … but the prior good reading is NOT clobbered by the transient throw.
      expect(store.getHeadroom('claude:max', 'five_hour')).toEqual(knownBefore);

      // Freshness is what eventually demotes it: fresh just after sampling, stale once past the TTL.
      const bucket = store.getBucket('claude:max', 'five_hour')!;
      const sampledMs = Date.parse(bucket.sampledAt);
      expect(isStale(bucket, sampledMs + 60_000)).toBe(false); // still fresh right after the sample
      expect(isStale(bucket, Date.parse(bucket.resetAt) + 1)).toBe(true); // past reset → stale
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
});

// ── Proof #1: replay-equality (AC5, Principle 14) ────────────────────────────────────────────────
describe('AC5 — the dispatch read-model rebuilds byte-identical from the L0 log', () => {
  function snapshot(db: DatabaseSync): string {
    ensureUsageTables(db);
    ensureCostTables(db);
    return JSON.stringify({
      usage_buckets: db
        .prepare(
          'SELECT account, window_kind, provider, used_pct, reset_at, source, sampled_at, ts FROM usage_buckets ORDER BY account, window_kind',
        )
        .all(),
      usage_accounts: db
        .prepare(
          'SELECT account, provider, available, reason, source, sampled_at, ts FROM usage_accounts ORDER BY account',
        )
        .all(),
      cost_rollup: db
        .prepare(
          'SELECT kind, id, total_cost_usd, input_tokens, output_tokens, total_tokens, used_pct, observations FROM cost_rollup ORDER BY kind, id',
        )
        .all(),
      cost_near_budget: db
        .prepare(
          'SELECT seq, task, agent, provider, total_cost_usd, cap_cents, threshold_pct, ts FROM cost_near_budget ORDER BY seq',
        )
        .all(),
    });
  }

  it('live fold → snapshot → rebuildAll → snapshot is byte-equal (non-vacuous)', () => {
    const pid = 'p-replay';
    const store = openProjectStore(pid);
    const projectors = [new UsageProjector(), new CostProjector()];

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
      expect(live).toContain('"cap_cents":1000');
    } finally {
      store.close();
    }
  });
});

// ── AC9 / Principle 12: the recording cores write only program-data, never the repo ──────────────
describe('AC9 — assertRepoPristine holds around the dispatch recording cores', () => {
  it('recordSnapshot + recordCost write nothing into the target repo', () => {
    const repo = makeRepo();
    const store = openDispatchStore('p-pristine');
    try {
      assertRepoPristine(repo, () => {
        store.recordSnapshot(claudeSnap);
        store.recordCost(
          { provider: 'claude', agent: 'a1', task: 't1', turn: 0, cost_usd: 9 },
          { capCents: 1000 },
        );
      });
      expect(store.getBucket('claude:max', 'five_hour')).toBeDefined();
      expect(store.getRollup('task', 't1')).toBeDefined();
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
      });
      expect(record.kind).toBe('waiting');
      expect(record.agent).toBe('agent-2');
      expect(record.role).toBe('reviewer');
      expect(record.etaResetAt).toBe('2026-06-04T10:00:00Z');
      expect(record.reason).toBe('all providers maxed');
      expect(record.maxedProviders).toEqual(['claude', 'codex']);

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
    } finally {
      store2.close();
    }
  });
});
