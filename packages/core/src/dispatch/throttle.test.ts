import { describe, it, expect } from 'vitest';
import type { Provider } from './usage-source.js';
import type {
  Placement,
  PlacementDecision,
  ProviderHeadroom,
  RankedCandidate,
} from './balancer.js';
import { resolveDispatch, canResume, MAXED_THRESHOLD_PCT_DEFAULT } from './throttle.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = Date.parse('2026-06-03T00:00:00.000Z');
const RESET_SOON = '2026-06-03T05:00:00.000Z'; // ~5 h from NOW
const RESET_LATER = '2026-06-03T10:00:00.000Z'; // ~10 h from NOW

/** A stub Placement for tests — content doesn't affect throttle logic. */
function stubPlacement(provider: Provider): Placement {
  return {
    role: 'implementer',
    provider,
    account: provider === 'claude' ? 'claude:max' : 'codex:pro',
    model: provider === 'claude' ? 'claude-sonnet-4-6' : 'gpt-5.4',
    effort: 'high',
    context: 'standard',
  };
}

/** A floating PlacementDecision with a pre-sorted ranked candidate list. */
function floatingDecision(
  ranked: { provider: Provider; usedPct: number; resetAt: string }[],
): PlacementDecision {
  const chosen = ranked[0];
  if (!chosen) throw new Error('At least one ranked candidate required');
  const rankedItems: readonly RankedCandidate[] = ranked.map((r) => ({
    provider: r.provider,
    account: r.provider === 'claude' ? 'claude:max' : 'codex:pro',
    score: 100 - r.usedPct,
    usedPct: r.usedPct,
    resetAt: r.resetAt,
    placement: stubPlacement(r.provider),
  }));
  return {
    kind: 'floating',
    placement: stubPlacement(chosen.provider),
    reason: `floating to '${chosen.provider}'`,
    ranked: rankedItems,
  };
}

function floatingDecisionWithAccounts(
  ranked: { provider: Provider; account: string; usedPct: number; resetAt: string }[],
  placementAccount: string,
): PlacementDecision {
  const chosen = ranked.find((r) => r.account === placementAccount);
  if (!chosen) throw new Error('placement account must be ranked');
  const rankedItems: readonly RankedCandidate[] = ranked.map((r) => ({
    provider: r.provider,
    account: r.account,
    score: 100 - r.usedPct,
    usedPct: r.usedPct,
    resetAt: r.resetAt,
    placement: { ...stubPlacement(r.provider), account: r.account },
  }));
  return {
    kind: 'floating',
    placement: { ...stubPlacement(chosen.provider), account: chosen.account },
    reason: `floating to '${chosen.account}'`,
    ranked: rankedItems,
  };
}

/** A pinned PlacementDecision for the given provider. */
function pinnedDecision(provider: Provider): PlacementDecision {
  return {
    kind: 'pinned',
    placement: stubPlacement(provider),
    reason: `pinned to '${provider}'`,
  };
}

/** A no-candidate PlacementDecision. */
function noCandidateDecision(providers: Provider[], soonestResetAt?: string): PlacementDecision {
  return {
    kind: 'no-candidate',
    reason: `all ${providers.length} provider(s) excluded as unhealthy`,
    excluded: providers.map((p) => ({ provider: p, why: 'unavailable' })),
    ...(soonestResetAt !== undefined ? { soonestResetAt } : {}),
  };
}

/** A healthy ProviderHeadroom with known headroom below the maxed threshold. */
function healthy(
  provider: Provider,
  usedPct: number,
  resetAt: string = RESET_LATER,
  account: string = provider === 'claude' ? 'claude:max' : 'codex:pro',
): ProviderHeadroom {
  return {
    provider,
    account,
    available: true,
    headroom: { kind: 'known', used_pct: usedPct, reset_at: resetAt },
    resetAt,
  };
}

/** A maxed ProviderHeadroom at or above the default threshold. */
function maxed(
  provider: Provider,
  usedPct: number = MAXED_THRESHOLD_PCT_DEFAULT,
  resetAt: string = RESET_SOON,
  account: string = provider === 'claude' ? 'claude:max' : 'codex:pro',
): ProviderHeadroom {
  return {
    provider,
    account,
    available: true,
    headroom: { kind: 'known', used_pct: usedPct, reset_at: resetAt },
    resetAt,
  };
}

/** An unavailable ProviderHeadroom (account down / not-logged-in). */
function unavail(
  provider: Provider,
  resetAt?: string,
  account: string = provider === 'claude' ? 'claude:max' : 'codex:pro',
): ProviderHeadroom {
  const base: ProviderHeadroom = {
    provider,
    account,
    available: false,
    headroom: { kind: 'unknown', reason: 'account unavailable' },
  };
  return resetAt !== undefined ? { ...base, resetAt } : base;
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// AC4 — Backpressure: throttle, never sacrifice
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe('resolveDispatch — floating', () => {
  it('placed when roomiest ranked candidate is below threshold', () => {
    const decision = floatingDecision([
      { provider: 'claude', usedPct: 50, resetAt: RESET_LATER },
      { provider: 'codex', usedPct: 80, resetAt: RESET_LATER },
    ]);
    const result = resolveDispatch(decision, [], { nowMs: NOW });
    expect(result.kind).toBe('placed');
    if (result.kind !== 'placed') throw new Error('unreachable');
    expect(result.placement.provider).toBe('claude');
  });

  it('placed when roomiest candidate is just below threshold', () => {
    const decision = floatingDecision([
      { provider: 'claude', usedPct: MAXED_THRESHOLD_PCT_DEFAULT - 0.1, resetAt: RESET_LATER },
    ]);
    const result = resolveDispatch(decision, [], { nowMs: NOW });
    expect(result.kind).toBe('placed');
  });

  it('waiting when only candidate is exactly at threshold (all maxed)', () => {
    const decision = floatingDecision([
      { provider: 'claude', usedPct: MAXED_THRESHOLD_PCT_DEFAULT, resetAt: RESET_SOON },
    ]);
    const result = resolveDispatch(decision, [], { nowMs: NOW });
    expect(result.kind).toBe('waiting');
    if (result.kind !== 'waiting') throw new Error('unreachable');
    expect(result.maxedProviders).toEqual(['claude']);
    expect(result.etaResetAt).toBe(RESET_SOON);
  });

  it('waiting when all healthy candidates are maxed — ETA is soonest reset among them', () => {
    const decision = floatingDecision([
      { provider: 'claude', usedPct: 100, resetAt: RESET_SOON },
      { provider: 'codex', usedPct: 98, resetAt: RESET_LATER },
    ]);
    const result = resolveDispatch(decision, [], { nowMs: NOW });
    expect(result.kind).toBe('waiting');
    if (result.kind !== 'waiting') throw new Error('unreachable');
    expect(result.maxedProviders).toEqual(['claude', 'codex']);
    expect(result.etaResetAt).toBe(RESET_SOON); // soonest of the two
  });

  it('waiting includes unavailable providers when healthy ranked providers are maxed', () => {
    const decision = floatingDecision([{ provider: 'claude', usedPct: 99, resetAt: RESET_LATER }]);
    const result = resolveDispatch(decision, [maxed('claude', 99, RESET_LATER), unavail('codex')], {
      nowMs: NOW,
    });

    expect(result.kind).toBe('waiting');
    if (result.kind !== 'waiting') throw new Error('unreachable');
    expect(result.maxedProviders).toEqual(['claude']);
    expect(result.unavailableProviders).toEqual(['codex']);
    expect(result.diagnostics).toEqual([
      {
        provider: 'codex',
        account: 'codex:pro',
        code: 'usage_source_unavailable',
        reason: 'account unavailable',
      },
    ]);
  });

  it('places on the first non-maxed ranked provider instead of waiting on a maxed top candidate', () => {
    const decision = floatingDecision([
      { provider: 'claude', usedPct: 99, resetAt: RESET_SOON },
      { provider: 'codex', usedPct: 20, resetAt: RESET_LATER },
    ]);
    const result = resolveDispatch(decision, [], { nowMs: NOW });
    expect(result.kind).toBe('placed');
    if (result.kind !== 'placed') throw new Error('unreachable');
    expect(result.placement.provider).toBe('codex');
  });

  it('names the skipped selected provider when hysteresis held an incumbent that is now maxed', () => {
    const rankedItems: readonly RankedCandidate[] = [
      {
        provider: 'codex',
        account: 'codex:pro',
        score: 80,
        usedPct: 20,
        resetAt: RESET_LATER,
        placement: stubPlacement('codex'),
      },
      {
        provider: 'claude',
        account: 'claude:max',
        score: 1,
        usedPct: 99,
        resetAt: RESET_SOON,
        placement: stubPlacement('claude'),
      },
    ];
    const decision: PlacementDecision = {
      kind: 'floating',
      placement: stubPlacement('claude'),
      reason: "floating role 'implementer' → 'claude'; held on previous 'claude' by hysteresis",
      ranked: rankedItems,
    };

    const result = resolveDispatch(decision, [], { nowMs: NOW });

    expect(result.kind).toBe('placed');
    if (result.kind !== 'placed') throw new Error('unreachable');
    expect(result.placement.provider).toBe('codex');
    expect(result.reason).toMatch(/selected account 'claude:max' was maxed/i);
    expect(result.reason).not.toMatch(/top-ranked provider was maxed/i);
  });

  it('keeps the balancer-selected hysteresis placement when the top challenger is still below threshold', () => {
    const rankedItems: readonly RankedCandidate[] = [
      {
        provider: 'claude',
        account: 'claude:max',
        score: 90,
        usedPct: 10,
        resetAt: RESET_LATER,
        placement: stubPlacement('claude'),
      },
      {
        provider: 'codex',
        account: 'codex:pro',
        score: 88,
        usedPct: 12,
        resetAt: RESET_LATER,
        placement: stubPlacement('codex'),
      },
    ];
    const decision: PlacementDecision = {
      kind: 'floating',
      placement: stubPlacement('codex'),
      reason: "floating role 'implementer' → 'codex'; held on previous 'codex' by hysteresis",
      ranked: rankedItems,
    };

    const result = resolveDispatch(decision, [], { nowMs: NOW });

    expect(result.kind).toBe('placed');
    if (result.kind !== 'placed') throw new Error('unreachable');
    expect(result.placement.provider).toBe('codex');
  });

  it('waiting message is LOUD — contains ETA and provider names (P9, spec §3)', () => {
    const decision = floatingDecision([{ provider: 'claude', usedPct: 100, resetAt: RESET_SOON }]);
    const result = resolveDispatch(decision, [], { nowMs: NOW });
    expect(result.kind).toBe('waiting');
    if (result.kind !== 'waiting') throw new Error('unreachable');
    expect(result.message).toContain(RESET_SOON);
    expect(result.message).toContain('claude');
  });

  it('no silent tier downgrade: waiting, never placed on a cheaper provider (P9, P13)', () => {
    // All ranked (suitable) providers are maxed — result must be WAITING, not a swapped-to-cheaper placed.
    const decision = floatingDecision([{ provider: 'claude', usedPct: 100, resetAt: RESET_SOON }]);
    // codex is available in candidates but the balancer ranked only claude (that is the constraint);
    // the throttle must WAIT, never silently re-route to a cheaper model.
    const result = resolveDispatch(decision, [healthy('codex', 10)], { nowMs: NOW });
    expect(result.kind).toBe('waiting');
  });

  it('custom threshold: placed when usedPct is below custom threshold', () => {
    const decision = floatingDecision([{ provider: 'claude', usedPct: 80, resetAt: RESET_LATER }]);
    const result = resolveDispatch(decision, [], { nowMs: NOW, maxedThresholdPct: 90 });
    expect(result.kind).toBe('placed');
  });

  it('custom threshold: waiting when usedPct is at custom threshold', () => {
    const decision = floatingDecision([{ provider: 'claude', usedPct: 90, resetAt: RESET_LATER }]);
    const result = resolveDispatch(decision, [], { nowMs: NOW, maxedThresholdPct: 90 });
    expect(result.kind).toBe('waiting');
  });

  it('floating: same-provider accounts — places on the below-threshold account when chosen is maxed (RL4-MS)', () => {
    const decision = floatingDecisionWithAccounts(
      [
        { provider: 'claude', account: 'claude:max', usedPct: 99, resetAt: RESET_SOON },
        { provider: 'claude', account: 'claude:team', usedPct: 50, resetAt: RESET_LATER },
      ],
      'claude:max',
    );
    const result = resolveDispatch(decision, [], { nowMs: NOW });
    expect(result.kind).toBe('placed');
    if (result.kind !== 'placed') throw new Error('expected placed');
    expect(result.placement.account).toBe('claude:team');
  });

  it('does not drop unavailable diagnostics for another provider account', () => {
    const decision = floatingDecisionWithAccounts(
      [{ provider: 'claude', account: 'claude:max', usedPct: 100, resetAt: RESET_SOON }],
      'claude:max',
    );

    const result = resolveDispatch(
      decision,
      [maxed('claude', 100, RESET_SOON, 'claude:max'), unavail('codex', RESET_SOON, 'codex:pro')],
      { nowMs: NOW },
    );

    expect(result.kind).toBe('waiting');
    if (result.kind !== 'waiting') throw new Error('unreachable');
    expect(result.unavailableAccounts).toEqual(['codex:pro']);
    expect(result.diagnostics?.[0]?.account).toBe('codex:pro');
  });
});

describe('resolveDispatch — pinned', () => {
  it('placed when pinned provider is healthy and below threshold', () => {
    const decision = pinnedDecision('claude');
    const result = resolveDispatch(decision, [healthy('claude', 50)], { nowMs: NOW });
    expect(result.kind).toBe('placed');
    if (result.kind !== 'placed') throw new Error('unreachable');
    expect(result.placement.provider).toBe('claude');
  });

  it("waiting when pinned provider is maxed — ETA from that provider's reset", () => {
    const decision = pinnedDecision('claude');
    const result = resolveDispatch(
      decision,
      [maxed('claude', MAXED_THRESHOLD_PCT_DEFAULT, RESET_SOON)],
      { nowMs: NOW },
    );
    expect(result.kind).toBe('waiting');
    if (result.kind !== 'waiting') throw new Error('unreachable');
    expect(result.maxedProviders).toEqual(['claude']);
    expect(result.unavailableProviders).toEqual([]);
    expect(result.etaResetAt).toBe(RESET_SOON);
  });

  it('waiting for pinned provider even when another is healthy — never re-routes (P13)', () => {
    // codex is healthy but claude is pinned and maxed — must WAIT for claude, never move to codex.
    const decision = pinnedDecision('claude');
    const result = resolveDispatch(decision, [maxed('claude'), healthy('codex', 10)], {
      nowMs: NOW,
    });
    expect(result.kind).toBe('waiting');
    if (result.kind !== 'waiting') throw new Error('unreachable');
    expect(result.maxedProviders).toEqual(['claude']); // only the pinned provider
    expect(result.unavailableProviders).toEqual([]);
  });

  it('waiting when pinned provider is unavailable — ETA from its resetAt', () => {
    const decision = pinnedDecision('claude');
    const result = resolveDispatch(decision, [unavail('claude', RESET_SOON)], { nowMs: NOW });
    expect(result.kind).toBe('waiting');
    if (result.kind !== 'waiting') throw new Error('unreachable');
    expect(result.maxedProviders).toEqual([]);
    expect(result.unavailableProviders).toEqual(['claude']);
    expect(result.etaResetAt).toBe(RESET_SOON);
  });

  it('waiting when pinned provider is absent from candidates — etaResetAt absent', () => {
    const decision = pinnedDecision('claude');
    const result = resolveDispatch(decision, [], { nowMs: NOW });
    expect(result.kind).toBe('waiting');
    if (result.kind !== 'waiting') throw new Error('unreachable');
    expect(result.maxedProviders).toEqual([]);
    expect(result.unavailableProviders).toEqual(['claude']);
    expect(result.etaResetAt).toBeUndefined();
  });

  it('pinned provider just below threshold: placed', () => {
    const decision = pinnedDecision('claude');
    const result = resolveDispatch(decision, [healthy('claude', MAXED_THRESHOLD_PCT_DEFAULT - 1)], {
      nowMs: NOW,
    });
    expect(result.kind).toBe('placed');
  });

  it('pinned: same-provider accounts — waits on the pinned account if maxed, never re-routes (RL4-MS)', () => {
    // Balancer picked claude:max for the pinned seat; claude:max is maxed; throttle must WAIT.
    const decision = pinnedDecision('claude'); // account = 'claude:max'
    const result = resolveDispatch(
      decision,
      [
        maxed('claude', 99, RESET_SOON, 'claude:max'),
        healthy('claude', 50, RESET_LATER, 'claude:team'),
      ],
      { nowMs: NOW },
    );
    expect(result.kind).toBe('waiting');
    if (result.kind !== 'waiting') throw new Error('expected waiting');
    expect(result.maxedProviders).toEqual(['claude']);
    expect(result.etaResetAt).toBe(RESET_SOON);
  });
});

describe('resolveDispatch — no-candidate', () => {
  it('waiting with ETA when soonestResetAt is present', () => {
    const decision = noCandidateDecision(['claude', 'codex'], RESET_SOON);
    const result = resolveDispatch(decision, [], { nowMs: NOW });
    expect(result.kind).toBe('waiting');
    if (result.kind !== 'waiting') throw new Error('unreachable');
    expect(result.etaResetAt).toBe(RESET_SOON);
    expect(result.maxedProviders).toEqual([]);
    expect(result.unavailableProviders).toEqual(['claude', 'codex']);
  });

  it('waiting without ETA when soonestResetAt is absent — still loud and not silent (P9)', () => {
    const decision = noCandidateDecision(['claude']);
    const result = resolveDispatch(decision, [], { nowMs: NOW });
    expect(result.kind).toBe('waiting');
    if (result.kind !== 'waiting') throw new Error('unreachable');
    expect(result.etaResetAt).toBeUndefined();
    expect(result.message.length).toBeGreaterThan(0); // LOUD even without ETA (P9 — never silent)
    expect(result.message).toContain('delayed');
  });

  it('unavailable candidates surface usage-source diagnostics instead of capacity wording', () => {
    const decision = noCandidateDecision(['claude']);
    const result = resolveDispatch(decision, [], { nowMs: NOW });
    expect(result.kind).toBe('waiting');
    if (result.kind !== 'waiting') throw new Error('unreachable');
    expect(result.message).toMatch(/usage source unavailable/i);
    expect(result.message).not.toMatch(/all providers at capacity/i);
    expect(result.maxedProviders).toEqual([]);
    expect(result.unavailableProviders).toEqual(['claude']);
    expect(result.diagnostics).toEqual([
      {
        provider: 'claude',
        code: 'usage_source_unavailable',
        reason: 'unavailable',
      },
    ]);
  });

  it('waiting even with empty excluded list — never silent (P9)', () => {
    const decision = noCandidateDecision([]);
    const result = resolveDispatch(decision, [], { nowMs: NOW });
    expect(result.kind).toBe('waiting');
    if (result.kind !== 'waiting') throw new Error('unreachable');
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.message).toMatch(/no provider candidates available/i);
    expect(result.message).not.toMatch(/all providers at capacity/i);
  });

  it('propagates all excluded providers into unavailableProviders, not maxedProviders', () => {
    const decision = noCandidateDecision(['claude', 'codex'], RESET_SOON);
    const result = resolveDispatch(decision, [], { nowMs: NOW });
    if (result.kind !== 'waiting') throw new Error('unreachable');
    expect(result.maxedProviders).toEqual([]);
    expect(result.unavailableProviders).toEqual(['claude', 'codex']);
  });

  it('no-candidate: same-provider excluded accounts — resolves to waiting with both listed (RL4-MS)', () => {
    const decision: PlacementDecision = {
      kind: 'no-candidate',
      reason: 'all provider accounts excluded',
      excluded: [
        { provider: 'claude', account: 'claude:max', why: 'maxed' },
        { provider: 'claude', account: 'claude:team', why: 'unavailable' },
      ],
    };
    const result = resolveDispatch(decision, [], { nowMs: NOW });
    expect(result.kind).toBe('waiting');
    if (result.kind !== 'waiting') throw new Error('expected waiting');
    expect(result.unavailableAccounts).toEqual(['claude:max', 'claude:team']);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// canResume — the pure re-wake predicate (AC4, P16)
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe('canResume', () => {
  it('false when all candidates are maxed at threshold', () => {
    const candidates = [maxed('claude'), maxed('codex')];
    expect(canResume(candidates, { nowMs: NOW })).toBe(false);
  });

  it('false when all candidates are unavailable', () => {
    const candidates = [unavail('claude'), unavail('codex')];
    expect(canResume(candidates, { nowMs: NOW })).toBe(false);
  });

  it('false when candidates array is empty', () => {
    expect(canResume([], { nowMs: NOW })).toBe(false);
  });

  it('false when candidate has unknown headroom (never treated as healthy — P9, AC3)', () => {
    const candidate: ProviderHeadroom = {
      provider: 'claude',
      account: 'claude:max',
      available: true,
      headroom: { kind: 'unknown', reason: 'not yet sampled' },
    };
    expect(canResume([candidate], { nowMs: NOW })).toBe(false);
  });

  it('true when at least one candidate is healthy and below threshold', () => {
    const candidates = [maxed('claude'), healthy('codex', 50)];
    expect(canResume(candidates, { nowMs: NOW })).toBe(true);
  });

  it('honors a provider filter for pinned WAITING seats', () => {
    const candidates = [maxed('claude'), healthy('codex', 50)];
    expect(canResume(candidates, { nowMs: NOW, providers: ['claude'] })).toBe(false);
    expect(
      canResume([healthy('claude', 50), healthy('codex', 50)], {
        nowMs: NOW,
        providers: ['claude'],
      }),
    ).toBe(true);
  });

  it('honors an account filter for pinned/custom account WAITING seats', () => {
    const candidates = [healthy('claude', 50, RESET_LATER, 'claude:max'), maxed('codex')];

    expect(
      canResume(candidates, { nowMs: NOW, providers: ['codex'], accounts: ['codex:pro'] }),
    ).toBe(false);
    expect(
      canResume(candidates, { nowMs: NOW, providers: ['claude'], accounts: ['claude:max'] }),
    ).toBe(true);
  });

  it('canResume: provider+accounts filter selects only matching (provider, account) pairs (RL4-MS)', () => {
    // Only claude:max is offered; it is maxed — filter to it → false.
    expect(
      canResume([maxed('claude', 99, RESET_SOON, 'claude:max')], {
        nowMs: NOW,
        providers: ['claude'],
        accounts: ['claude:max', 'claude:team'],
      }),
    ).toBe(false);
  });

  it('canResume: same-provider multiple accounts — true when at least one is healthy (RL4-MS)', () => {
    const candidates = [
      maxed('claude', 99, RESET_SOON, 'claude:max'),
      healthy('claude', 50, RESET_LATER, 'claude:team'),
    ];
    expect(canResume(candidates, { nowMs: NOW })).toBe(true);
  });

  it('true when candidate is just below threshold (boundary)', () => {
    const candidates = [healthy('claude', MAXED_THRESHOLD_PCT_DEFAULT - 0.1)];
    expect(canResume(candidates, { nowMs: NOW })).toBe(true);
  });

  it('false when candidate is exactly at threshold (boundary)', () => {
    const candidates = [healthy('claude', MAXED_THRESHOLD_PCT_DEFAULT)];
    expect(canResume(candidates, { nowMs: NOW })).toBe(false);
  });

  it('custom threshold: true when candidate is below custom threshold', () => {
    const candidates = [healthy('claude', 80)];
    expect(canResume(candidates, { nowMs: NOW, maxedThresholdPct: 90 })).toBe(true);
  });

  it('custom threshold: false when candidate is at custom threshold', () => {
    const candidates = [healthy('claude', 90)];
    expect(canResume(candidates, { nowMs: NOW, maxedThresholdPct: 90 })).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Determinism — identical inputs → identical output (AC10, P16)
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe('determinism', () => {
  it('resolveDispatch: identical inputs produce identical resolution', () => {
    const decision = floatingDecision([{ provider: 'claude', usedPct: 100, resetAt: RESET_SOON }]);
    const opts = { nowMs: NOW };
    const r1 = resolveDispatch(decision, [], opts);
    const r2 = resolveDispatch(decision, [], opts);
    expect(r1).toEqual(r2);
  });

  it('canResume: identical inputs produce identical boolean', () => {
    const candidates = [healthy('claude', 50)];
    const opts = { nowMs: NOW };
    expect(canResume(candidates, opts)).toBe(canResume(candidates, opts));
  });

  it('resolveDispatch: same pinned input → same result', () => {
    const decision = pinnedDecision('claude');
    const candidates = [maxed('claude', 99, RESET_SOON)];
    const opts = { nowMs: NOW };
    const r1 = resolveDispatch(decision, candidates, opts);
    const r2 = resolveDispatch(decision, candidates, opts);
    expect(r1).toEqual(r2);
  });
});
