import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openConfigStore } from '../config/config-store.js';
import { openDispatchStore } from './dispatch-store.js';
import { FakeUsageSource, type UsageSnapshot } from './usage-source.js';
import type { Provider } from './usage-source.js';
import type { UsageAccountStatus, UsageBucket } from './events.js';
import { resolveTier } from './tier.js';
import {
  placeAgent,
  placeAgentFromStore,
  candidatesFromStore,
  bindingProviderHeadroom,
  resolvePinTable,
  headroomScore,
  pinTableSchema,
  DISPATCH_PINS_CONFIG_KEY,
  HYSTERESIS_MARGIN_DEFAULT,
  RESET_HORIZON_MS_DEFAULT,
  type Placement,
  type PlacementDecision,
  type ProviderHeadroom,
  type PinTable,
} from './balancer.js';

// ── Fixtures: a fixed injected clock + reset timestamps relative to it ─────────────────────────────
const NOW = Date.parse('2026-06-03T00:00:00.000Z');
const FAR_RESET = '2026-06-10T00:00:00.000Z'; // ≫ the 5h horizon ⇒ no reset credit (nominal free).
const SOON_RESET = '2026-06-03T00:06:00.000Z'; // 6 min away ⇒ nearly-fully credited back.

/** A healthy candidate: account available + a known binding-window headroom. */
function known(provider: Provider, usedPct: number, resetAt: string = FAR_RESET): ProviderHeadroom {
  return {
    provider,
    available: true,
    headroom: { kind: 'known', used_pct: usedPct, reset_at: resetAt },
    resetAt,
  };
}

/** An UNAVAILABLE candidate (not-logged-in / offline / over-limit) — excluded, headroom unknown (AC3). */
function unavailable(provider: Provider, reason: string, resetAt?: string): ProviderHeadroom {
  const base: ProviderHeadroom = {
    provider,
    available: false,
    headroom: { kind: 'unknown', reason },
  };
  return resetAt !== undefined ? { ...base, resetAt } : base;
}

/** An available account whose binding-window headroom is UNKNOWN (nothing observed) — excluded (AC3). */
function unknownHeadroom(provider: Provider, reason: string): ProviderHeadroom {
  return { provider, available: true, headroom: { kind: 'unknown', reason } };
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// AC1 — pins are NEVER overridden
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('AC1 — pinned seats are returned unchanged (never re-routed)', () => {
  it('returns the sub-role pin even when floating would route elsewhere', () => {
    const pins: PinTable = {
      'reviewer:pr': { provider: 'claude', model: 'claude-opus-4-8', effort: 'max' },
    };
    // Codex is far roomier — a floating seat WOULD pick it — but the pin must win.
    const decision = placeAgent({
      role: 'reviewer:pr',
      workSize: 'average',
      reasoningBudget: 'standard',
      pins,
      candidates: [known('claude', 90), known('codex', 5)],
      nowMs: NOW,
    });
    expect(decision.kind).toBe('pinned');
    if (decision.kind !== 'pinned') throw new Error('unreachable');
    expect(decision.placement.provider).toBe('claude');
    expect(decision.placement.model).toBe('claude-opus-4-8');
    expect(decision.placement.effort).toBe('max');
    // Context is never pinned — it comes from the default tier for the pinned provider.
    expect(decision.placement.context).toBe(resolveTier('average', 'standard', 'claude').context);
    expect(decision.placement.role).toBe('reviewer:pr');
  });

  it('falls back from a sub-role to the base-role pin', () => {
    const pins: PinTable = { reviewer: { provider: 'claude' } };
    const decision = placeAgent({
      role: 'reviewer:pr',
      workSize: 'technical',
      reasoningBudget: 'deep',
      pins,
      candidates: [known('codex', 1)], // codex is wide open, but base-role pin → claude.
      nowMs: NOW,
    });
    expect(decision.kind).toBe('pinned');
    if (decision.kind !== 'pinned') throw new Error('unreachable');
    expect(decision.placement.provider).toBe('claude');
  });

  it('fills unset pin fields (model/effort) from resolveTier; context always from the tier', () => {
    const pins: PinTable = { coordinator: { provider: 'claude' } }; // provider only.
    const decision = placeAgent({
      role: 'coordinator',
      workSize: 'technical',
      reasoningBudget: 'deep',
      pins,
      candidates: [known('codex', 1)],
      nowMs: NOW,
    });
    if (decision.kind !== 'pinned') throw new Error('expected pinned');
    const tier = resolveTier('technical', 'deep', 'claude');
    expect(decision.placement.model).toBe(tier.model); // claude-opus-4-8
    expect(decision.placement.effort).toBe(tier.effort); // max
    expect(decision.placement.context).toBe(tier.context); // extended
  });

  it('honours a pin to a DEAD provider — never re-routes around it (AC1 over AC3)', () => {
    const pins: PinTable = { implementer: { provider: 'codex' } };
    const decision = placeAgent({
      role: 'implementer',
      workSize: 'average',
      reasoningBudget: 'standard',
      pins,
      // codex is dead and claude is healthy — a FLOATING seat would route to claude, but the pin holds.
      candidates: [unavailable('codex', 'not-logged-in'), known('claude', 10)],
      nowMs: NOW,
    });
    expect(decision.kind).toBe('pinned');
    if (decision.kind !== 'pinned') throw new Error('unreachable');
    expect(decision.placement.provider).toBe('codex');
  });

  it('an exact sub-role pin wins over a base-role pin for the same seat', () => {
    const pins: PinTable = {
      reviewer: { provider: 'codex' },
      'reviewer:pr': { provider: 'claude' },
    };
    const decision = placeAgent({
      role: 'reviewer:pr',
      workSize: 'average',
      reasoningBudget: 'standard',
      pins,
      candidates: [],
      nowMs: NOW,
    });
    if (decision.kind !== 'pinned') throw new Error('expected pinned');
    expect(decision.placement.provider).toBe('claude');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// AC2 — floating → most live headroom, reset-aware, hysteresis
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('AC2 — floating routes to the roomiest healthy provider', () => {
  it('Claude 50% used / Codex 10% used → Codex (the pinned example)', () => {
    const decision = placeAgent({
      role: 'implementer',
      workSize: 'average',
      reasoningBudget: 'standard',
      pins: {},
      candidates: [known('claude', 50), known('codex', 10)],
      nowMs: NOW,
    });
    expect(decision.kind).toBe('floating');
    if (decision.kind !== 'floating') throw new Error('unreachable');
    expect(decision.placement.provider).toBe('codex');
    // The model comes from resolveTier for the chosen provider.
    expect(decision.placement.model).toBe(resolveTier('average', 'standard', 'codex').model);
    // Ranked roomiest-first: codex (90) before claude (50).
    expect(decision.ranked.map((r) => r.provider)).toEqual(['codex', 'claude']);
  });

  it('reset-aware: a higher-used window with an IMMINENT reset beats a lower-used far-reset window', () => {
    // claude 50% used, far reset → score ≈ 50. codex 70% used, reset in 6 min → score ≈ 99.
    const decision = placeAgent({
      role: 'implementer',
      workSize: 'average',
      reasoningBudget: 'standard',
      pins: {},
      candidates: [known('claude', 50, FAR_RESET), known('codex', 70, SOON_RESET)],
      nowMs: NOW,
    });
    if (decision.kind !== 'floating') throw new Error('expected floating');
    expect(decision.placement.provider).toBe('codex'); // roomier-by-reset beats lower-nominal.
  });

  it('hysteresis: a TINY delta does NOT flip away from previous', () => {
    const previous: Placement = {
      role: 'implementer',
      ...resolveTier('average', 'standard', 'claude'),
    };
    const decision = placeAgent({
      role: 'implementer',
      workSize: 'average',
      reasoningBudget: 'standard',
      pins: {},
      // claude 50 (score 50) vs codex 45 (score 55) — codex leads by 5 ≤ margin(10) ⇒ hold claude.
      candidates: [known('claude', 50), known('codex', 45)],
      nowMs: NOW,
      previous,
    });
    if (decision.kind !== 'floating') throw new Error('expected floating');
    expect(decision.placement.provider).toBe('claude'); // held by hysteresis.
    expect(decision.reason).toMatch(/hysteresis/);
  });

  it('hysteresis: a LARGE delta DOES flip away from previous', () => {
    const previous: Placement = {
      role: 'implementer',
      ...resolveTier('average', 'standard', 'claude'),
    };
    const decision = placeAgent({
      role: 'implementer',
      workSize: 'average',
      reasoningBudget: 'standard',
      pins: {},
      // claude 50 (score 50) vs codex 10 (score 90) — codex leads by 40 > margin(10) ⇒ flip.
      candidates: [known('claude', 50), known('codex', 10)],
      nowMs: NOW,
      previous,
    });
    if (decision.kind !== 'floating') throw new Error('expected floating');
    expect(decision.placement.provider).toBe('codex');
  });

  it('a custom hysteresis margin tightens/loosens the flip threshold', () => {
    const previous: Placement = {
      role: 'implementer',
      ...resolveTier('average', 'standard', 'claude'),
    };
    // claude 50 vs codex 45 — lead 5. With margin 2, the lead (5 > 2) now flips.
    const decision = placeAgent({
      role: 'implementer',
      workSize: 'average',
      reasoningBudget: 'standard',
      pins: {},
      candidates: [known('claude', 50), known('codex', 45)],
      nowMs: NOW,
      previous,
      hysteresis: { marginPct: 2 },
    });
    if (decision.kind !== 'floating') throw new Error('expected floating');
    expect(decision.placement.provider).toBe('codex');
  });

  it('does NOT hold a previous provider that has gone unhealthy — moves to the healthy one', () => {
    const previous: Placement = {
      role: 'implementer',
      ...resolveTier('average', 'standard', 'claude'),
    };
    const decision = placeAgent({
      role: 'implementer',
      workSize: 'average',
      reasoningBudget: 'standard',
      pins: {},
      candidates: [unavailable('claude', 'offline'), known('codex', 80)],
      nowMs: NOW,
      previous,
    });
    if (decision.kind !== 'floating') throw new Error('expected floating');
    expect(decision.placement.provider).toBe('codex');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// AC3 — exclude unhealthy; route around a dead provider (THE regression cure)
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('AC3 — unhealthy providers are excluded from floating placement', () => {
  it('routes to the healthy provider even though the DEAD one has more nominal headroom', () => {
    // claude is 80% used but healthy; codex is "wide open" but DEAD ⇒ excluded. Pick claude.
    const decision = placeAgent({
      role: 'implementer',
      workSize: 'average',
      reasoningBudget: 'standard',
      pins: {},
      candidates: [known('claude', 80), unavailable('codex', 'limit-reached')],
      nowMs: NOW,
    });
    if (decision.kind !== 'floating') throw new Error('expected floating');
    expect(decision.placement.provider).toBe('claude');
    expect(decision.ranked.map((r) => r.provider)).toEqual(['claude']); // codex not even ranked.
  });

  it('excludes an available account whose headroom is UNKNOWN (nothing observed)', () => {
    const decision = placeAgent({
      role: 'implementer',
      workSize: 'average',
      reasoningBudget: 'standard',
      pins: {},
      candidates: [
        unknownHeadroom('claude', 'no usage observed for this window'),
        known('codex', 60),
      ],
      nowMs: NOW,
    });
    if (decision.kind !== 'floating') throw new Error('expected floating');
    expect(decision.placement.provider).toBe('codex');
  });

  it('floating route-around: healthy Claude + dead Codex ⇒ placed on Claude (the regression cure)', () => {
    const decision = placeAgent({
      role: 'implementer',
      workSize: 'technical',
      reasoningBudget: 'standard',
      pins: {},
      candidates: [known('claude', 30), unavailable('codex', 'not-logged-in')],
      nowMs: NOW,
    });
    if (decision.kind !== 'floating') throw new Error('expected floating');
    expect(decision.placement.provider).toBe('claude');
  });

  it('all candidates excluded ⇒ no-candidate (not a throw, not a silent pick) with reasons + ETA', () => {
    const decision = placeAgent({
      role: 'implementer',
      workSize: 'average',
      reasoningBudget: 'standard',
      pins: {},
      candidates: [
        unavailable('claude', 'offline', '2026-06-03T03:00:00.000Z'),
        unavailable('codex', 'limit-reached', '2026-06-03T01:30:00.000Z'),
      ],
      nowMs: NOW,
    });
    expect(decision.kind).toBe('no-candidate');
    if (decision.kind !== 'no-candidate') throw new Error('unreachable');
    expect(decision.excluded).toHaveLength(2);
    expect(decision.excluded.map((e) => e.provider).sort()).toEqual(['claude', 'codex']);
    expect(decision.excluded.every((e) => e.why.length > 0)).toBe(true);
    // soonestResetAt = the earliest binding-window reset across the excluded providers (for Phase 4 ETA).
    expect(decision.soonestResetAt).toBe('2026-06-03T01:30:00.000Z');
  });

  it('no-candidate with zero candidates carries an empty excluded list and no ETA', () => {
    const decision = placeAgent({
      role: 'implementer',
      workSize: 'average',
      reasoningBudget: 'standard',
      pins: {},
      candidates: [],
      nowMs: NOW,
    });
    if (decision.kind !== 'no-candidate') throw new Error('expected no-candidate');
    expect(decision.excluded).toEqual([]);
    expect(decision.soonestResetAt).toBeUndefined();
  });

  it('never throws for an all-unhealthy input', () => {
    expect(() =>
      placeAgent({
        role: 'implementer',
        workSize: 'average',
        reasoningBudget: 'standard',
        pins: {},
        candidates: [unavailable('claude', 'offline'), unknownHeadroom('codex', 'stale')],
        nowMs: NOW,
      }),
    ).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Determinism (AC10, Principle 16)
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('determinism — identical inputs produce identical decisions', () => {
  const input = {
    role: 'implementer' as const,
    workSize: 'average' as const,
    reasoningBudget: 'standard' as const,
    pins: {} as PinTable,
    candidates: [known('claude', 40, SOON_RESET), known('codex', 35, FAR_RESET)],
    nowMs: NOW,
  };

  it('two calls return deep-equal decisions', () => {
    expect(placeAgent(input)).toEqual(placeAgent(input));
  });

  it('candidate order does not change the winner (total tie-break order)', () => {
    const a = placeAgent(input);
    const b = placeAgent({ ...input, candidates: [...input.candidates].reverse() });
    if (a.kind !== 'floating' || b.kind !== 'floating') throw new Error('expected floating');
    expect(a.placement.provider).toBe(b.placement.provider);
  });

  it('ties break deterministically by provider name (ascending)', () => {
    // Identical headroom ⇒ identical score ⇒ tie broken by name: claude before codex.
    const decision = placeAgent({
      ...input,
      candidates: [known('codex', 20), known('claude', 20)],
    });
    if (decision.kind !== 'floating') throw new Error('expected floating');
    expect(decision.placement.provider).toBe('claude');
    expect(decision.ranked.map((r) => r.provider)).toEqual(['claude', 'codex']);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// headroomScore — the reset-aware scoring function
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('headroomScore — reset-aware free-headroom scoring', () => {
  it('a far reset scores nominal free headroom (100 - used)', () => {
    expect(headroomScore(50, FAR_RESET, NOW)).toBeCloseTo(50, 5);
    expect(headroomScore(0, FAR_RESET, NOW)).toBeCloseTo(100, 5);
  });

  it('an imminent reset credits back the used portion (≈ fully free)', () => {
    // 6 min / 5h horizon ⇒ weight 0.02 ⇒ score = 100 - 70*0.02 = 98.6.
    expect(headroomScore(70, SOON_RESET, NOW)).toBeCloseTo(98.6, 5);
  });

  it('an already-passed reset scores fully free (weight 0)', () => {
    expect(headroomScore(90, '2026-06-02T00:00:00.000Z', NOW)).toBeCloseTo(100, 5);
  });

  it('half a horizon away credits back half the used portion', () => {
    const half = NOW + RESET_HORIZON_MS_DEFAULT / 2;
    expect(headroomScore(80, new Date(half).toISOString(), NOW)).toBeCloseTo(60, 5);
  });

  it('an unparseable reset falls back to nominal free (fail-safe)', () => {
    expect(headroomScore(40, 'not-a-date', NOW)).toBeCloseTo(60, 5);
  });

  it('the default hysteresis margin and reset horizon are the documented constants', () => {
    expect(HYSTERESIS_MARGIN_DEFAULT).toBe(10);
    expect(RESET_HORIZON_MS_DEFAULT).toBe(5 * 60 * 60 * 1000);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// bindingProviderHeadroom — reduce an account's windows to one candidate (the binding window)
// ════════════════════════════════════════════════════════════════════════════════════════════════
function bucket(
  account: string,
  provider: Provider,
  windowKind: string,
  usedPct: number,
  resetAt: string,
): UsageBucket {
  return {
    provider,
    account,
    windowKind,
    usedPct,
    resetAt,
    source: 'fake',
    sampledAt: '2026-06-03T00:00:00.000Z',
  };
}

function availableStatus(account: string, provider: Provider): UsageAccountStatus {
  return {
    provider,
    account,
    available: true,
    source: 'fake',
    sampledAt: '2026-06-03T00:00:00.000Z',
    observedTs: NOW,
  };
}

describe('bindingProviderHeadroom — picks the most-constrained window', () => {
  it('binds to the highest-used window, carrying its reset_at', () => {
    const c = bindingProviderHeadroom('claude', availableStatus('claude:max', 'claude'), [
      bucket('claude:max', 'claude', 'five_hour', 42, '2026-06-03T05:00:00.000Z'),
      bucket('claude:max', 'claude', 'weekly', 77, '2026-06-10T00:00:00.000Z'),
    ]);
    expect(c.available).toBe(true);
    expect(c.headroom).toEqual({
      kind: 'known',
      used_pct: 77,
      reset_at: '2026-06-10T00:00:00.000Z',
    });
    expect(c.resetAt).toBe('2026-06-10T00:00:00.000Z');
  });

  it('an unavailable account is unknown for ALL windows (AC6) — but still carries a reset for ETA', () => {
    const status: UsageAccountStatus = {
      provider: 'codex',
      account: 'codex:pro',
      available: false,
      reason: 'over-limit',
      source: 'fake',
      sampledAt: '2026-06-03T00:00:00.000Z',
      observedTs: NOW,
    };
    const c = bindingProviderHeadroom('codex', status, [
      bucket('codex:pro', 'codex', 'primary', 100, '2026-06-03T02:00:00.000Z'),
    ]);
    expect(c.available).toBe(false);
    expect(c.headroom.kind).toBe('unknown');
    expect(c.resetAt).toBe('2026-06-03T02:00:00.000Z'); // shadowed bucket reset survives for ETA.
  });

  it('no account status ⇒ unavailable + unknown headroom (never a fabricated 0%)', () => {
    const c = bindingProviderHeadroom('codex', undefined, []);
    expect(c.available).toBe(false);
    expect(c.headroom.kind).toBe('unknown');
    expect(c.resetAt).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Non-pure adapter over the DispatchStore + config cascade (program-data only, AC9/P12)
// ════════════════════════════════════════════════════════════════════════════════════════════════
/**
 * Register a per-test temp `CO_DATA_DIR`, SCOPED to the describe block that calls this — so the pure
 * placeAgent / headroomScore / bindingProviderHeadroom tests above pay no temp-dir overhead. Call it as
 * the first statement of a describe whose tests open a real store / config.
 */
function useTempDataDir(): void {
  const originalEnv = process.env;
  let dataDir: string | undefined;
  beforeEach(() => {
    process.env = { ...originalEnv };
    dataDir = mkdtempSync(join(tmpdir(), 'co-balancer-'));
    process.env.CO_DATA_DIR = dataDir;
  });
  afterEach(() => {
    process.env = originalEnv;
    if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });
}

const claudeHealthy: UsageSnapshot = {
  provider: 'claude',
  account: 'claude:max',
  windows: [
    { kind: 'five_hour', used_pct: 30, reset_at: '2026-06-03T05:00:00.000Z' },
    { kind: 'weekly', used_pct: 12, reset_at: '2026-06-10T00:00:00.000Z' },
  ],
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

const ACCOUNTS = [
  { provider: 'claude' as const, account: 'claude:max' },
  { provider: 'codex' as const, account: 'codex:pro' },
];

describe('candidatesFromStore + placeAgentFromStore — reads live state, routes around the dead one', () => {
  useTempDataDir();

  it('candidatesFromStore derives healthy claude + dead codex from recorded snapshots', async () => {
    const source = new FakeUsageSource({
      snapshots: { claude: claudeHealthy, codex: codexDown },
    });
    const store = openDispatchStore('p-balancer');
    try {
      store.recordSnapshot(await source.read('claude'));
      store.recordSnapshot(await source.read('codex'));

      const candidates = candidatesFromStore(store, ACCOUNTS);
      const claude = candidates.find((c) => c.provider === 'claude');
      const codex = candidates.find((c) => c.provider === 'codex');
      expect(claude?.available).toBe(true);
      // Binding window = most-constrained = five_hour (30% > weekly 12%).
      expect(claude?.headroom).toEqual({
        kind: 'known',
        used_pct: 30,
        reset_at: '2026-06-03T05:00:00.000Z',
      });
      expect(codex?.available).toBe(false);
      expect(codex?.headroom.kind).toBe('unknown');
    } finally {
      store.close();
    }
  });

  it('placeAgentFromStore floats to claude (the regression cure) with no pins configured', async () => {
    const source = new FakeUsageSource({
      snapshots: { claude: claudeHealthy, codex: codexDown },
    });
    const store = openDispatchStore('p-balancer');
    try {
      store.recordSnapshot(await source.read('claude'));
      store.recordSnapshot(await source.read('codex'));

      const decision = placeAgentFromStore(
        {
          projectId: 'p-balancer',
          role: 'implementer',
          workSize: 'average',
          reasoningBudget: 'standard',
          accounts: ACCOUNTS,
          nowMs: NOW,
        },
        { store },
      );
      expect(decision.kind).toBe('floating');
      if (decision.kind !== 'floating') throw new Error('unreachable');
      expect(decision.placement.provider).toBe('claude');
    } finally {
      store.close();
    }
  });

  it('placeAgentFromStore honours a pin read from the config cascade', async () => {
    const config = openConfigStore();
    const store = openDispatchStore('p-balancer');
    try {
      config.setProjectOverride('p-balancer', DISPATCH_PINS_CONFIG_KEY, {
        'reviewer:pr': { provider: 'claude', model: 'claude-opus-4-8', effort: 'max' },
      });
      const source = new FakeUsageSource({ snapshots: { claude: claudeHealthy } });
      store.recordSnapshot(await source.read('claude'));

      const decision = placeAgentFromStore(
        {
          projectId: 'p-balancer',
          role: 'reviewer:pr',
          workSize: 'average',
          reasoningBudget: 'standard',
          accounts: ACCOUNTS,
          nowMs: NOW,
        },
        { store, config },
      );
      expect(decision.kind).toBe('pinned');
      if (decision.kind !== 'pinned') throw new Error('unreachable');
      expect(decision.placement.provider).toBe('claude');
      expect(decision.placement.model).toBe('claude-opus-4-8');
      expect(decision.placement.effort).toBe('max');
    } finally {
      store.close();
      config.close();
    }
  });

  it('placeAgentFromStore with all accounts dead ⇒ no-candidate', async () => {
    const source = new FakeUsageSource({
      snapshots: {
        claude: { ...claudeHealthy, available: false, windows: [] },
        codex: codexDown,
      },
    });
    const store = openDispatchStore('p-balancer');
    try {
      store.recordSnapshot(await source.read('claude'));
      store.recordSnapshot(await source.read('codex'));
      const decision = placeAgentFromStore(
        {
          projectId: 'p-balancer',
          role: 'implementer',
          workSize: 'average',
          reasoningBudget: 'standard',
          accounts: ACCOUNTS,
          nowMs: NOW,
        },
        { store },
      );
      expect(decision.kind).toBe('no-candidate');
    } finally {
      store.close();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// resolvePinTable — config cascade + fail-loud validation (P9)
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('resolvePinTable — global ⊕ project (project wins), fail-loud on malformed', () => {
  useTempDataDir();

  it('returns {} when no pins are configured', () => {
    const config = openConfigStore();
    try {
      expect(resolvePinTable('p-none', config)).toEqual({});
    } finally {
      config.close();
    }
  });

  it('a project override of dispatch.pins wins over the global value (per-key)', () => {
    const config = openConfigStore();
    try {
      config.setGlobal(DISPATCH_PINS_CONFIG_KEY, { coordinator: { provider: 'codex' } });
      config.setProjectOverride('p-cfg', DISPATCH_PINS_CONFIG_KEY, {
        coordinator: { provider: 'claude' },
      });
      const pins = resolvePinTable('p-cfg', config);
      expect(pins.coordinator?.provider).toBe('claude');
    } finally {
      config.close();
    }
  });

  it('throws fail-loud on a malformed pin value (P9 — no silent degrade)', () => {
    const config = openConfigStore();
    try {
      config.setProjectOverride('p-bad', DISPATCH_PINS_CONFIG_KEY, {
        coordinator: { provider: 'gemini' }, // not a valid Provider.
      });
      expect(() => resolvePinTable('p-bad', config)).toThrow(/dispatch\.pins/);
    } finally {
      config.close();
    }
  });

  it('pinTableSchema parses a valid table and rejects an unknown provider', () => {
    expect(pinTableSchema.parse({ implementer: { provider: 'claude' } })).toEqual({
      implementer: { provider: 'claude' },
    });
    expect(() => pinTableSchema.parse({ x: { provider: 'nope' } })).toThrow();
  });
});

// A tiny type-level guard that the decision union stays exhaustive for downstream consumers.
describe('PlacementDecision — discriminated union is exhaustive', () => {
  it('every decision kind is one of the three variants', () => {
    const kinds: PlacementDecision['kind'][] = ['pinned', 'floating', 'no-candidate'];
    expect(new Set(kinds).size).toBe(3);
  });
});
