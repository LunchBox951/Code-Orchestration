import { assertNever } from '../assert-never.js';
import type { Provider } from './usage-source.js';
import type {
  Placement,
  PlacementDecision,
  ProviderHeadroom,
  RankedCandidate,
} from './balancer.js';

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

/** A user-facing dispatch diagnostic, e.g. a provider usage-source failure surfaced per AC6/P9. */
export interface DispatchDiagnostic {
  readonly provider: Provider;
  readonly account?: string;
  readonly code: string;
  readonly reason: string;
}

/**
 * The final dispatch resolution — two exclusive, loud outcomes (never a silent degrade).
 *
 * - `placed`  — a healthy provider with real headroom accepted the seat.
 * - `waiting` — all suitable providers are maxed or unhealthy; retry when `canResume` is true.
 */
export type DispatchResolution =
  | {
      readonly kind: 'placed';
      readonly placement: Placement;
      readonly reason: string;
      readonly diagnostics?: readonly DispatchDiagnostic[];
    }
  | {
      readonly kind: 'waiting';
      /** ISO-8601 when the soonest binding window refreshes — the wake-up ETA. Absent if unknown. */
      readonly etaResetAt?: string;
      /** Human-readable reason: which providers are maxed or unhealthy. */
      readonly reason: string;
      /** LOUD agent-facing message (spec §3) — never silent (P9). */
      readonly message: string;
      /** Providers blocked because their binding usage window is at capacity. */
      readonly maxedProviders: readonly Provider[];
      /** Provider accounts blocked because their binding usage window is at capacity. */
      readonly maxedAccounts: readonly string[];
      /** Providers blocked because usage/account health is unavailable or unknown. */
      readonly unavailableProviders: readonly Provider[];
      /** Provider accounts blocked because usage/account health is unavailable or unknown. */
      readonly unavailableAccounts: readonly string[];
      readonly diagnostics?: readonly DispatchDiagnostic[];
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
  if (providers.length === 0) {
    const eta =
      etaResetAt !== undefined ? `delayed until ${etaResetAt}` : 'delayed — reset ETA unknown';
    return `${eta} — no provider candidates available`;
  }
  const who = providers.length > 0 ? providers.join(', ') : 'all providers';
  const eta =
    etaResetAt !== undefined ? `delayed until ${etaResetAt}` : 'delayed — reset ETA unknown';
  return `${eta} — all providers at capacity (${who})`;
}

function unavailableMessage(
  etaResetAt: string | undefined,
  diagnostics: readonly DispatchDiagnostic[],
): string {
  const eta =
    etaResetAt !== undefined ? `delayed until ${etaResetAt}` : 'delayed — reset ETA unknown';
  const detail = diagnostics.map((d) => `${d.provider}: ${d.reason}`).join('; ');
  return `${eta} — usage source unavailable (${detail})`;
}

/** Construct a WAITING {@link DispatchResolution}. */
function waiting(
  maxedProviders: readonly Provider[],
  maxedAccounts: readonly string[],
  unavailableProviders: readonly Provider[],
  unavailableAccounts: readonly string[],
  etaResetAt: string | undefined,
  reason: string,
  diagnostics: readonly DispatchDiagnostic[] = [],
): DispatchResolution {
  return {
    kind: 'waiting',
    ...(etaResetAt !== undefined ? { etaResetAt } : {}),
    reason,
    message:
      diagnostics.length > 0
        ? unavailableMessage(etaResetAt, diagnostics)
        : waitingMessage(etaResetAt, maxedProviders),
    maxedProviders,
    maxedAccounts,
    unavailableProviders,
    unavailableAccounts,
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}

function diagnosticForCandidate(candidate: ProviderHeadroom): DispatchDiagnostic | undefined {
  if (candidate.available && candidate.headroom.kind === 'known') return undefined;
  const reason =
    candidate.headroom.kind === 'unknown' ? candidate.headroom.reason : 'usage source unavailable';
  return {
    provider: candidate.provider,
    account: candidate.account,
    code: 'usage_source_unavailable',
    reason,
  };
}

// ─── Main resolver ────────────────────────────────────────────────────────────

/**
 * Turn a {@link PlacementDecision} + live candidate headrooms into a final {@link DispatchResolution}.
 * PURE — no I/O, no clock reads (AC10, P16). `nowMs` is injected for determinism.
 *
 * - **floating** — choose the roomiest ranked provider BELOW `maxedThresholdPct`. If every ranked
 *   provider is at/above the threshold → WAITING with ETA = soonest `resetAt` among them.
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
  assertSingleAccountPerProvider([...providerAccountsFromDecision(decision), ...candidates]);

  switch (decision.kind) {
    case 'floating': {
      const chosen = decision.ranked.find(
        (r) =>
          r.provider === decision.placement.provider && r.account === decision.placement.account,
      );
      const best =
        chosen !== undefined && chosen.usedPct < threshold
          ? chosen
          : decision.ranked.find((r) => r.usedPct < threshold);
      // Invariant: floating always has ≥1 ranked candidate (the balancer returns no-candidate
      // otherwise). If none are below threshold, every suitable provider is maxed.
      if (best === undefined) {
        const maxedProviders = uniqueProviderList(decision.ranked.map((r) => r.provider));
        const maxedAccounts = decision.ranked.map((r) => r.account);
        const rankedAccounts = new Set(decision.ranked.map(providerAccountKey));
        const unavailableCandidates = candidates.filter(
          (c) =>
            !rankedAccounts.has(providerAccountKey(c)) &&
            (!c.available || c.headroom.kind === 'unknown'),
        );
        const unavailableProviders = uniqueProviderList(
          unavailableCandidates.map((c) => c.provider),
        );
        const unavailableAccounts = unavailableCandidates.map((c) => c.account);
        const diagnostics = unavailableCandidates
          .map(diagnosticForCandidate)
          .filter((d) => d !== undefined);
        const eta = soonestReset([...decision.ranked, ...unavailableCandidates]);
        const reason =
          maxedProviders.length === 0
            ? 'no healthy candidates available for floating placement'
            : `all ${maxedProviders.length} suitable provider(s) maxed (≥${threshold}% used): ${maxedProviders.join(', ')}`;
        return waiting(
          maxedProviders,
          maxedAccounts,
          unavailableProviders,
          unavailableAccounts,
          eta,
          reason,
          diagnostics,
        );
      }
      const skipped = chosen ?? decision.ranked[0];
      const stayedOnChosen =
        best.provider === decision.placement.provider &&
        best.account === decision.placement.account;
      const reason = stayedOnChosen
        ? decision.reason
        : `${decision.reason}; selected account '${skipped?.account ?? decision.placement.account}' was maxed, placed on next account below ${threshold}%`;
      return { kind: 'placed', placement: best.placement, reason };
    }

    case 'pinned': {
      const pinned = decision.placement.provider;
      const candidate = candidates.find(
        (c) => c.provider === pinned && c.account === decision.placement.account,
      );

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
      const diagnostics =
        candidate !== undefined
          ? [diagnosticForCandidate(candidate)].filter((d) => d !== undefined)
          : [
              {
                provider: pinned,
                account: decision.placement.account,
                code: 'usage_source_unavailable',
                reason: 'not present in candidates',
              },
            ];
      const whyMaxed =
        candidate === undefined
          ? 'not present in candidates'
          : !candidate.available
            ? 'account unavailable'
            : candidate.headroom.kind === 'unknown'
              ? `headroom unknown: ${candidate.headroom.reason}`
              : `at capacity (${candidate.headroom.used_pct}% ≥ ${threshold}%)`;
      const reason = `pinned provider '${pinned}' is ${whyMaxed} — waiting for its reset, never re-routes (P13)`;
      const isCapacity =
        candidate !== undefined &&
        candidate.available &&
        candidate.headroom.kind === 'known' &&
        candidate.headroom.used_pct >= threshold;
      return waiting(
        isCapacity ? [pinned] : [],
        isCapacity ? [decision.placement.account] : [],
        isCapacity ? [] : [pinned],
        isCapacity ? [] : [decision.placement.account],
        resetAt,
        reason,
        diagnostics,
      );
    }

    case 'no-candidate': {
      // All tier-capable providers excluded (unhealthy). WAITING; ETA from soonestResetAt.
      const unavailableProviders = decision.excluded.map((e) => e.provider);
      const unavailableAccounts = decision.excluded.flatMap((e) =>
        e.account === undefined ? [] : [e.account],
      );
      const diagnostics = decision.excluded.map((e) => ({
        provider: e.provider,
        ...(e.account !== undefined ? { account: e.account } : {}),
        code: 'usage_source_unavailable',
        reason: e.why,
      }));
      return waiting(
        [],
        [],
        unavailableProviders,
        unavailableAccounts,
        decision.soonestResetAt,
        decision.reason,
        diagnostics,
      );
    }

    default:
      return assertNever(decision);
  }
}

function providerAccountKey(
  value:
    | Pick<ProviderHeadroom, 'provider' | 'account'>
    | Pick<RankedCandidate, 'provider' | 'account'>,
): string {
  return `${value.provider}\0${value.account}`;
}

function providerAccountsFromDecision(
  decision: PlacementDecision,
): Array<{ readonly provider: Provider; readonly account: string }> {
  switch (decision.kind) {
    case 'floating':
      return [
        { provider: decision.placement.provider, account: decision.placement.account },
        ...decision.ranked.map((ranked) => ({
          provider: ranked.provider,
          account: ranked.account,
        })),
      ];
    case 'pinned':
      return [{ provider: decision.placement.provider, account: decision.placement.account }];
    case 'no-candidate':
      return decision.excluded.flatMap((excluded) =>
        excluded.account === undefined
          ? []
          : [{ provider: excluded.provider, account: excluded.account }],
      );
    default:
      return assertNever(decision);
  }
}

function assertSingleAccountPerProvider(
  values: readonly { readonly provider: Provider; readonly account: string }[],
): void {
  const byProvider = new Map<Provider, Set<string>>();
  for (const value of values) {
    const accounts = byProvider.get(value.provider) ?? new Set<string>();
    accounts.add(value.account);
    byProvider.set(value.provider, accounts);
  }
  for (const [provider, accounts] of byProvider) {
    if (accounts.size <= 1) continue;
    const list = [...accounts].sort((a, b) => a.localeCompare(b)).join(', ');
    throw new Error(
      `same-provider multi-subscription routing is unsupported for provider '${provider}'; candidates offered multiple accounts: ${list}`,
    );
  }
}

function uniqueProviderList(providers: readonly Provider[]): Provider[] {
  return [...new Set(providers)];
}

// ─── Resume predicate ─────────────────────────────────────────────────────────

/**
 * Returns `true` once at least one suitable provider is HEALTHY (account available + known headroom)
 * AND its binding-window `used_pct` is below `maxedThresholdPct`. This is the predicate the Conductor
 * (L7, stubbed) re-evaluates as headroom refreshes to re-wake a WAITING agent. PURE over injected
 * candidates + threshold — identical inputs always return the same boolean (AC10, P16). The actual
 * re-wake mechanism is L7; this predicate is the policy substrate only.
 *
 * `opts.nowMs` mirrors the `resolveDispatch` signature for API symmetry; it is not used internally
 * because the resume check is purely over current headroom percentages, not wall-clock time.
 */
export function canResume(
  candidates: readonly ProviderHeadroom[],
  opts: {
    nowMs: number;
    maxedThresholdPct?: number;
    providerAccounts?: readonly { readonly provider: Provider; readonly account: string }[];
    providers?: readonly Provider[];
    accounts?: readonly string[];
  },
): boolean {
  const threshold = opts.maxedThresholdPct ?? MAXED_THRESHOLD_PCT_DEFAULT;
  const filterPairs = resumeFilterProviderAccounts(opts);
  assertSingleAccountPerProvider([...candidates, ...filterPairs]);
  const allowedPairs = resumeAllowedPairs(opts, filterPairs);
  return candidates.some(
    (c) =>
      matchesResumeFilter(c, opts, allowedPairs) &&
      c.available &&
      c.headroom.kind === 'known' &&
      c.headroom.used_pct < threshold,
  );
}

function matchesResumeFilter(
  candidate: ProviderHeadroom,
  opts: {
    readonly providers?: readonly Provider[];
    readonly accounts?: readonly string[];
  },
  allowedPairs: ReadonlySet<string> | undefined,
): boolean {
  if (allowedPairs !== undefined) return allowedPairs.has(providerAccountKey(candidate));
  return (
    (opts.providers === undefined || opts.providers.includes(candidate.provider)) &&
    (opts.accounts === undefined || opts.accounts.includes(candidate.account))
  );
}

function resumeAllowedPairs(
  opts: {
    readonly providerAccounts?: readonly {
      readonly provider: Provider;
      readonly account: string;
    }[];
    readonly providers?: readonly Provider[];
    readonly accounts?: readonly string[];
  },
  filterPairs: readonly { readonly provider: Provider; readonly account: string }[],
): ReadonlySet<string> | undefined {
  if (opts.providerAccounts !== undefined) {
    return new Set(opts.providerAccounts.map(providerAccountKey));
  }
  if (filterPairs.length > 0) return new Set(filterPairs.map(providerAccountKey));
  return undefined;
}

function resumeFilterProviderAccounts(opts: {
  readonly providerAccounts?: readonly { readonly provider: Provider; readonly account: string }[];
  readonly providers?: readonly Provider[];
  readonly accounts?: readonly string[];
}): Array<{ readonly provider: Provider; readonly account: string }> {
  if (opts.providerAccounts !== undefined) return [...opts.providerAccounts];
  if (opts.providers === undefined || opts.accounts === undefined) return [];
  if (opts.providers.length === 0 || opts.accounts.length === 0) return [];
  if (opts.providers.length === 1) {
    const provider = opts.providers[0]!;
    return opts.accounts.map((account) => ({ provider, account }));
  }
  if (opts.accounts.length === 1) {
    const account = opts.accounts[0]!;
    return opts.providers.map((provider) => ({ provider, account }));
  }
  if (opts.providers.length !== opts.accounts.length) {
    throw new Error(
      'canResume: providers/accounts filters are ambiguous for provider-account matching; pass providerAccounts',
    );
  }
  return opts.providers.map((provider, index) => ({
    provider,
    account: opts.accounts![index]!,
  }));
}
