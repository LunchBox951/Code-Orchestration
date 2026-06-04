import { assertNever } from '../assert-never.js';
import type { Provider } from './usage-source.js';
import type { Placement, PlacementDecision, ProviderHeadroom } from './balancer.js';

/**
 * L4 Phase 4 — pure throttle-as-WAITING policy (AC4, AC10, P16).
 *
 * Layered on top of the Phase 3 balancer: a {@link PlacementDecision} + live candidate headrooms →
 * {@link DispatchResolution}. The only two outcomes are PLACED (real headroom) and WAITING (ride the
 * refresh). Never a silent tier downgrade or forced re-route to a cheaper model (P9, P13).
 *
 * PURE: no I/O, no clock reads (inject `nowMs`), no randomness — identical inputs always produce
 * identical outputs (AC10, P16). Cited invariants: P9 (no-silent-failures), P13 (provider-neutral),
 * P14 (recoverable), P16 (decisions-deferred).
 */

/**
 * A provider's binding-window `used_pct` at or above this value is considered "maxed" — effectively
 * at capacity. 95 (near-ceiling) means a provider at 95%+ is treated as full: the remaining 5% is
 * insufficient to reliably absorb a new turn, and triggering WAITING before a hard 100% hit avoids
 * surfacing rate-limit errors to the agent.
 */
export const MAXED_THRESHOLD_PCT_DEFAULT = 95;

/**
 * The final dispatch resolution — two exclusive, loud outcomes (never a silent degrade).
 *
 * - `placed`  — a healthy provider with real headroom accepted the seat.
 * - `waiting` — all suitable providers are maxed or unhealthy; retry when `canResume` is true.
 */
export type DispatchResolution =
  | { readonly kind: 'placed'; readonly placement: Placement; readonly reason: string }
  | {
      readonly kind: 'waiting';
      /** ISO-8601 when the soonest binding window refreshes — the wake-up ETA. Absent if unknown. */
      readonly etaResetAt?: string;
      /** Human-readable reason: which providers are maxed or unhealthy. */
      readonly reason: string;
      /** LOUD agent-facing message (spec §3) — never silent (P9). */
      readonly message: string;
      /** Every provider at capacity or unhealthy that caused this WAITING decision. */
      readonly maxedProviders: readonly Provider[];
    };

// ─── Pure ETA helper ─────────────────────────────────────────────────────────

/** Soonest `resetAt` among a collection of items that optionally carry one. Pure over injected values. */
function soonestReset(items: readonly { readonly resetAt?: string }[]): string | undefined {
  let bestMs = Infinity;
  let bestIso: string | undefined;
  for (const item of items) {
    if (item.resetAt === undefined) continue;
    const ms = Date.parse(item.resetAt);
    if (Number.isNaN(ms) || ms >= bestMs) continue;
    bestMs = ms;
    bestIso = item.resetAt;
  }
  return bestIso;
}

/** Build the LOUD agent-facing WAITING message (spec §3, P9 — never silent). */
function waitingMessage(etaResetAt: string | undefined, providers: readonly Provider[]): string {
  const who = providers.length > 0 ? providers.join(', ') : 'all providers';
  const eta =
    etaResetAt !== undefined ? `delayed until ${etaResetAt}` : 'delayed — reset ETA unknown';
  return `${eta} — all providers at capacity (${who})`;
}

/** Construct a WAITING {@link DispatchResolution}. */
function waiting(
  maxedProviders: readonly Provider[],
  etaResetAt: string | undefined,
  reason: string,
): DispatchResolution {
  return {
    kind: 'waiting',
    ...(etaResetAt !== undefined ? { etaResetAt } : {}),
    reason,
    message: waitingMessage(etaResetAt, maxedProviders),
    maxedProviders,
  };
}

// ─── Main resolver ────────────────────────────────────────────────────────────

/**
 * Turn a {@link PlacementDecision} + live candidate headrooms into a final {@link DispatchResolution}.
 * PURE — no I/O, no clock reads (AC10, P16). `nowMs` is injected for determinism.
 *
 * - **floating** — `ranked[0]` is the roomiest healthy provider. Below `maxedThresholdPct` → PLACED.
 *   At or above the threshold → ALL suitable providers are maxed → WAITING with ETA = soonest `resetAt`
 *   among the ranked candidates.
 * - **pinned** — look the pinned provider up in `candidates`. Healthy AND below threshold → PLACED.
 *   Otherwise WAITING for that specific provider's reset. Never re-routes to another provider (P9, P13).
 * - **no-candidate** — WAITING; ETA from `decision.soonestResetAt` (may be absent — still loud, P9).
 *
 * Never degrades quality: a PLACED result has real headroom; every other case is WAITING
 * (P9 — no-silent-failures; P13 — provider-neutral, no forced tier drop; P16 — deferred decision).
 */
export function resolveDispatch(
  decision: PlacementDecision,
  candidates: readonly ProviderHeadroom[],
  opts: { nowMs: number; maxedThresholdPct?: number },
): DispatchResolution {
  const threshold = opts.maxedThresholdPct ?? MAXED_THRESHOLD_PCT_DEFAULT;

  switch (decision.kind) {
    case 'floating': {
      const best = decision.ranked[0];
      // Invariant: floating always has ≥1 ranked candidate (the balancer returns no-candidate
      // otherwise). The undefined guard below is a defensive backstop that should never fire.
      if (best === undefined || best.usedPct >= threshold) {
        const maxedProviders = decision.ranked.map((r) => r.provider);
        const eta = soonestReset(decision.ranked);
        const reason =
          maxedProviders.length === 0
            ? 'no healthy candidates available for floating placement'
            : `all ${maxedProviders.length} suitable provider(s) maxed (≥${threshold}% used): ${maxedProviders.join(', ')}`;
        return waiting(maxedProviders, eta, reason);
      }
      return { kind: 'placed', placement: decision.placement, reason: decision.reason };
    }

    case 'pinned': {
      const pinned = decision.placement.provider;
      const candidate = candidates.find((c) => c.provider === pinned);

      if (
        candidate !== undefined &&
        candidate.available &&
        candidate.headroom.kind === 'known' &&
        candidate.headroom.used_pct < threshold
      ) {
        return { kind: 'placed', placement: decision.placement, reason: decision.reason };
      }

      // Pinned but not healthy or maxed — WAITING for THIS provider's reset. Never re-routes (P9, P13).
      const resetAt = candidate?.resetAt;
      const whyMaxed =
        candidate === undefined
          ? 'not present in candidates'
          : !candidate.available
            ? 'account unavailable'
            : candidate.headroom.kind === 'unknown'
              ? `headroom unknown: ${candidate.headroom.reason}`
              : `at capacity (${candidate.headroom.used_pct}% ≥ ${threshold}%)`;
      const reason = `pinned provider '${pinned}' is ${whyMaxed} — waiting for its reset, never re-routes (P13)`;
      return waiting([pinned], resetAt, reason);
    }

    case 'no-candidate': {
      // All tier-capable providers excluded (unhealthy). WAITING; ETA from soonestResetAt.
      const maxedProviders = decision.excluded.map((e) => e.provider);
      return waiting(maxedProviders, decision.soonestResetAt, decision.reason);
    }

    default:
      return assertNever(decision);
  }
}

// ─── Resume predicate ─────────────────────────────────────────────────────────

/**
 * Returns `true` once at least one suitable provider is HEALTHY (account available + known headroom)
 * AND its binding-window `used_pct` is below `maxedThresholdPct`. This is the predicate the Conductor
 * (L7, stubbed) re-evaluates as headroom refreshes to re-wake a WAITING agent. PURE over injected
 * candidates + threshold — identical inputs always return the same boolean (AC10, P16). The actual
 * re-wake mechanism is L7; this predicate is the policy substrate only.
 */
export function canResume(
  candidates: readonly ProviderHeadroom[],
  opts: { nowMs: number; maxedThresholdPct?: number },
): boolean {
  const threshold = opts.maxedThresholdPct ?? MAXED_THRESHOLD_PCT_DEFAULT;
  return candidates.some(
    (c) => c.available && c.headroom.kind === 'known' && c.headroom.used_pct < threshold,
  );
}
