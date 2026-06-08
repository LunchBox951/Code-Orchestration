import { assertNever } from '../assert-never.js';
import { openConfigStore } from '../config/config-store.js';
import { z } from 'zod';
import type { ConfigStore } from '../config/config-store.js';
import { accountForProvider } from './provider-source.js';
import { deriveHeadroom } from './policy.js';
import type { Headroom } from './policy.js';
import { isStale } from './policy.js';
import { providerSchema } from './events.js';
import type { UsageAccountStatus, UsageBucket } from './events.js';
import { effortSchema, resolveTier } from './tier.js';
import type { ContextWindow, Effort, ReasoningBudget, WorkSize } from './tier.js';
import type { Provider } from './usage-source.js';
import type { DispatchStore } from './dispatch-store.js';

/**
 * L4 Phase 3 — the rate-limit-aware provider **balancer** (spec §2.2/§4.1; AC1–AC3). This is the heart
 * of the routing policy and the cure for the prototype's defining failure: it defaulted floating roles
 * onto a non-functional Codex because the balancer had policy but no live signal and no exclusion. Here,
 * the live signal arrives as INJECTED data and an unhealthy provider is EXCLUDED first-class.
 *
 * The core {@link placeAgent} is PURE (AC10, Principle 16 — decisions-deferred): a deterministic
 * function of its injected inputs — NO store reads, NO clock (`nowMs` is a parameter), NO randomness, NO
 * Map-iteration nondeterminism (it ranks an ARRAY of candidates with a total tie-break order). Identical
 * inputs always produce an identical {@link PlacementDecision}, independent of the live transport — the
 * same determinism `worktrees/repo-mode.ts` holds to. The `previous`/hysteresis state is an INJECTED
 * input, not hidden mutable state.
 *
 * The non-pure helpers ({@link candidatesFromStore}, {@link resolvePinTable}, {@link placeAgentFromStore})
 * are clearly separated below: they only READ program-data (the {@link DispatchStore} + the config
 * cascade) and call the pure core (AC9, Principle 12 — the pure core writes nothing; the adapter reads
 * only). No new MCP tool / registry / scoping is added (AC8 — dispatch integration is Phase 5).
 *
 * Cited invariants: P13 (provider-neutral), P9 (no-silent-failures), P16 (decisions-deferred).
 */

// ─── Pins (the operator's quality-critical seats) ─────────────────────────────

/**
 * One resolved pin: a role/sub-role nailed to a specific provider, optionally overriding the model and
 * effort (Coordinator → Opus, `reviewer:pr` → Opus). Any field the pin leaves unset falls back to the
 * default tier ({@link resolveTier}). The context window is never pinned — it always comes from the tier.
 */
export const pinSchema = z.object({
  provider: providerSchema,
  model: z.string().min(1).optional(),
  effort: effortSchema.optional(),
});
export type Pin = z.infer<typeof pinSchema>;

/**
 * The resolved pin table — `role | sub-role → pin`. Keyed by the EXACT role string a seat is placed
 * for, e.g. `'implementer'` (base role) or `'reviewer:pr'` (sub-role). Sub-role lookup falls back to the
 * base role (`'reviewer:pr'` → `'reviewer'`). Injected into the pure {@link placeAgent} already-resolved.
 */
export const pinTableSchema = z.record(z.string().min(1), pinSchema);
export type PinTable = z.infer<typeof pinTableSchema>;

/** The config-cascade key the per-project pin table lives under (`dispatch.pins`). */
export const DISPATCH_PINS_CONFIG_KEY = 'dispatch.pins';

// ─── The live signal (one injected provider-account candidate per tier-capable provider) ───────

/**
 * A provider's effective headroom + availability — the live signal {@link placeAgent} ranks over. The
 * non-pure adapter derives one of these per **tier-capable** provider account; v1 accepts at most one
 * account per provider until same-provider multi-subscription routing is specified. The pure core treats
 * every candidate as tier-capable; tier filtering is the adapter's job. A provider account is **HEALTHY**
 * iff it is `available` AND its binding-window {@link Headroom} is `known`. An unavailable account
 * (not-logged-in / offline / over-limit) OR an `unknown` headroom ⇒ NOT healthy ⇒ EXCLUDED from floating
 * placement (AC3, P9 — never silently treated as healthy / 0% used).
 */
export interface ProviderHeadroom {
  readonly provider: Provider;
  readonly account: string;
  /** Account availability. `false` (not-logged-in / offline / over-limit) ⇒ never healthy (AC3, P9). */
  readonly available: boolean;
  /** The binding-window headroom (most-constrained window). `unknown` ⇒ never healthy (AC3, P9). */
  readonly headroom: Headroom;
  /**
   * The binding window's reset timestamp (ISO-8601), when a window has been observed — carried even for
   * an EXCLUDED provider (over-limit / unavailable but previously sampled) so Phase 4 can compute a
   * refresh ETA from the soonest reset. Mirrors `headroom.reset_at` when the headroom is `known`; a
   * provider that was never sampled with windows (e.g. never-logged-in) has none.
   */
  readonly resetAt?: string;
}

// ─── Placement + the decision union ───────────────────────────────────────────

/**
 * A concrete dispatch target for one seat — a {@link import('./tier.js').TierPlacement} plus the `role`
 * echo (useful to Phase 5's `placement.decided`). Returned inside every {@link PlacementDecision}.
 */
export interface Placement {
  readonly role: string;
  readonly provider: Provider;
  readonly account: string;
  readonly model: string;
  readonly effort: Effort;
  readonly context: ContextWindow;
}

/** One scored, eligible (healthy) provider in a floating decision's ranking — roomiest first. */
export interface RankedCandidate {
  readonly provider: Provider;
  readonly account: string;
  /** Effective free-headroom score (higher = roomier); see {@link headroomScore}. */
  readonly score: number;
  /** The binding window's nominal usage percent (0..100). */
  readonly usedPct: number;
  /** The binding window's reset timestamp (ISO-8601). */
  readonly resetAt: string;
  /** Concrete placement for this ranked provider, so throttle can skip maxed leaders without guessing. */
  readonly placement: Placement;
}

/** One excluded (unhealthy) provider in a {@link PlacementDecision} of kind `no-candidate`. */
export interface ExcludedCandidate {
  readonly provider: Provider;
  readonly account?: string;
  /** Why this provider was excluded (unavailable / unknown headroom) — legible, never silent (P9). */
  readonly why: string;
}

/**
 * The balancer's decision — a discriminated union so Phase 4 (throttle-as-WAITING) can compose cleanly:
 *
 *   - `pinned`       — the seat is pinned; `placement` is the pin (never overridden — AC1).
 *   - `floating`     — placed on the roomiest HEALTHY provider; `ranked` is the eligible ranking (AC2).
 *   - `no-candidate` — every tier-capable provider was EXCLUDED (AC3). A FIRST-CLASS variant (not a
 *                      thrown error, not a silent degrade — P9) carrying the `excluded` list + the
 *                      `soonestResetAt` so Phase 4 can compute WAITING + an ETA. This phase only SURFACES
 *                      the signal — it implements no WAITING / ETA / throttle and no tier degradation.
 */
export type PlacementDecision =
  | { readonly kind: 'pinned'; readonly placement: Placement; readonly reason: string }
  | {
      readonly kind: 'floating';
      readonly placement: Placement;
      readonly reason: string;
      readonly ranked: readonly RankedCandidate[];
    }
  | {
      readonly kind: 'no-candidate';
      readonly reason: string;
      readonly excluded: readonly ExcludedCandidate[];
      readonly soonestResetAt?: string;
    };

// ─── Hysteresis (anti-flapping) ───────────────────────────────────────────────

/**
 * Hysteresis configuration — how much roomier a challenger must be before the balancer flips a seat away
 * from where it last ran. Without it, tiny headroom deltas would make a floating seat flap between
 * providers turn-to-turn. See {@link HYSTERESIS_MARGIN_DEFAULT}.
 */
export interface HysteresisConfig {
  /**
   * The minimum score advantage (in effective free-headroom points, 0..100) a challenger must beat the
   * incumbent (`previous`) by to win the seat. A challenger AHEAD by `<= marginPct` loses to the
   * incumbent (the seat holds). Default {@link HYSTERESIS_MARGIN_DEFAULT}.
   */
  readonly marginPct?: number;
}

/** Default hysteresis margin: a challenger must be > 10 effective-free points roomier to flip a seat. */
export const HYSTERESIS_MARGIN_DEFAULT = 10;

// ─── Reset-aware scoring ──────────────────────────────────────────────────────

/** Default reset horizon for {@link headroomScore}: 5h (matches Claude's `five_hour` window), in ms. */
export const RESET_HORIZON_MS_DEFAULT = 5 * 60 * 60 * 1000;

/**
 * The reset-aware headroom score — higher means roomier (AC2). PURE: a function of the injected
 * `usedPct`, `resetAt`, and `nowMs` only (never the wall clock), so identical inputs score identically.
 *
 * Nominal free headroom is `100 - usedPct`. We then CREDIT BACK the used portion in proportion to how
 * IMMINENT the window's reset is, because a nearly-reset window frees up sooner:
 *
 *   score = 100 - usedPct * resetWeight,   resetWeight = clamp(msUntilReset / horizon, 0, 1)
 *
 *   - reset ≥ horizon away (or far)  → resetWeight = 1 → score = 100 - usedPct  (nominal free).
 *   - reset imminent / already passed → resetWeight = 0 → score = 100           (effectively fresh).
 *   - reset half a horizon away       → resetWeight = 0.5 → score = 100 - usedPct/2.
 *
 * So a provider with HIGHER nominal usage but an imminent reset can out-score one with lower usage but a
 * far reset ("roomier-by-reset beats lower-nominal"). An unparseable `resetAt` falls back to nominal free
 * (fail-safe: we cannot prove an imminent reset ⇒ we do not credit one).
 */
export function headroomScore(
  usedPct: number,
  resetAt: string,
  nowMs: number,
  horizonMs: number = RESET_HORIZON_MS_DEFAULT,
): number {
  const resetMs = Date.parse(resetAt);
  if (Number.isNaN(resetMs)) return 100 - usedPct; // cannot prove imminent reset ⇒ nominal free only.
  const msUntilReset = Math.max(0, resetMs - nowMs);
  const resetWeight = Math.min(1, msUntilReset / horizonMs);
  return 100 - usedPct * resetWeight;
}

// ─── The pure resolver ────────────────────────────────────────────────────────

/** Injected inputs to the pure {@link placeAgent}. */
export interface PlaceAgentInput {
  /** Base role OR sub-role, e.g. `'reviewer:pr'` or `'implementer'` — drives pin lookup + the echo. */
  readonly role: string;
  readonly workSize: WorkSize;
  readonly reasoningBudget: ReasoningBudget;
  /** Resolved pin table (injected; from {@link resolvePinTable}). */
  readonly pins: PinTable;
  /** Provider-account candidates (injected; from {@link candidatesFromStore}); v1 allows one per provider. */
  readonly candidates: readonly ProviderHeadroom[];
  /** Injected, replay-safe clock (epoch ms) for reset-aware scoring — never the wall clock (AC10). */
  readonly nowMs: number;
  /** The seat's last placement — drives hysteresis (injected state, never hidden — AC10). */
  readonly previous?: Placement;
  readonly hysteresis?: HysteresisConfig;
}

/**
 * Resolve where a seat should run (AC1–AC3). PURE + deterministic (AC10, P16). Order:
 *
 *   1. **Pinned (AC1)** — if `role` (or, for a sub-role, its base role) has a pin, return it UNCHANGED.
 *      The balancer NEVER re-routes a pinned seat — not even around a dead provider. Unset pin fields
 *      fall back to {@link resolveTier}.
 *   2. **Floating (AC2/AC3)** — otherwise EXCLUDE every unhealthy candidate (unavailable / `unknown`
 *      headroom — AC3, P9), then among the HEALTHY ones pick the roomiest by {@link headroomScore}
 *      (reset-aware), holding to `previous` unless a challenger beats it by more than the hysteresis
 *      margin. The model comes from `resolveTier(workSize, reasoningBudget, chosenProvider)`.
 *   3. **No candidate (AC3)** — if NO healthy candidate remains, return the first-class `no-candidate`
 *      decision (never a throw, never a silent pick) for Phase 4.
 */
export function placeAgent(input: PlaceAgentInput): PlacementDecision {
  const { role, workSize, reasoningBudget, pins, candidates, nowMs, previous, hysteresis } = input;
  assertSingleAccountPerProvider(candidates);

  // 1) Pinned seats are never overridden (AC1).
  const pin = lookupPin(pins, role);
  if (pin !== undefined) {
    const account = accountForPinnedProvider(pin.provider, candidates);
    return {
      kind: 'pinned',
      placement: placementFromPin(role, pin, workSize, reasoningBudget, account),
      reason: `role '${role}' is pinned to provider '${pin.provider}' (pins are never overridden — AC1)`,
    };
  }

  // 2) Floating: rank the HEALTHY candidates (excluding the unhealthy — AC3).
  const scored: ScoredCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.available && candidate.headroom.kind === 'known') {
      scored.push({
        provider: candidate.provider,
        account: candidate.account,
        score: headroomScore(candidate.headroom.used_pct, candidate.headroom.reset_at, nowMs),
        usedPct: candidate.headroom.used_pct,
        resetAt: candidate.headroom.reset_at,
      });
    }
  }

  // 3) No healthy candidate ⇒ first-class no-candidate signal for Phase 4 (AC3, P9).
  if (scored.length === 0) {
    return {
      kind: 'no-candidate',
      reason:
        candidates.length === 0
          ? `no tier-capable candidate offered for role '${role}'`
          : `all ${candidates.length} tier-capable provider(s) excluded as unhealthy for role '${role}'`,
      excluded: candidates.map((c) => ({
        provider: c.provider,
        account: c.account,
        why: exclusionReason(c),
      })),
      ...withSoonestReset(candidates),
    };
  }

  // Total, deterministic order: roomiest score first, ties broken by provider name (no Map nondeterminism).
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      compareProvider(a.provider, b.provider) ||
      a.account.localeCompare(b.account),
  );

  const chosen = applyHysteresis(scored, previous, hysteresis);
  const placement: Placement = {
    role,
    account: chosen.account,
    ...resolveTier(workSize, reasoningBudget, chosen.provider),
  };
  return {
    kind: 'floating',
    placement,
    reason: floatingReason(role, chosen, scored, previous),
    ranked: scored.map((s) => ({
      provider: s.provider,
      account: s.account,
      score: s.score,
      usedPct: s.usedPct,
      resetAt: s.resetAt,
      placement: {
        role,
        account: s.account,
        ...resolveTier(workSize, reasoningBudget, s.provider),
      },
    })),
  };
}

/** A healthy candidate with its computed score (internal to ranking). */
interface ScoredCandidate {
  readonly provider: Provider;
  readonly account: string;
  readonly score: number;
  readonly usedPct: number;
  readonly resetAt: string;
}

/**
 * Apply hysteresis: keep `previous` unless the top-ranked challenger beats it by MORE than the margin.
 * The incumbent must still be HEALTHY this round (present in `scored`) to be held — a `previous` provider
 * that has since gone unhealthy is never held (the seat moves to the roomiest healthy provider). `scored`
 * is assumed pre-sorted roomiest-first and non-empty.
 */
function applyHysteresis(
  scored: readonly ScoredCandidate[],
  previous: Placement | undefined,
  hysteresis: HysteresisConfig | undefined,
): ScoredCandidate {
  const top = scored[0]!; // non-empty by contract.
  if (previous === undefined) return top;
  const incumbent = scored.find(
    (s) => s.provider === previous.provider && s.account === previous.account,
  );
  if (
    incumbent === undefined ||
    (incumbent.provider === top.provider && incumbent.account === top.account)
  ) {
    return top;
  }
  const margin = hysteresis?.marginPct ?? HYSTERESIS_MARGIN_DEFAULT;
  // Hold the incumbent unless the challenger's lead EXCEEDS the margin (a lead within margin doesn't flip).
  return top.score - incumbent.score > margin ? top : incumbent;
}

/** Look a pin up for `role`: exact (sub-role) first, then the base role before the first `:` (AC1). */
function lookupPin(pins: PinTable, role: string): Pin | undefined {
  const exact = pins[role];
  if (exact !== undefined) return exact;
  const colon = role.indexOf(':');
  if (colon > 0) {
    const basePin = pins[role.slice(0, colon)];
    if (basePin !== undefined) return basePin;
  }
  return undefined;
}

/** Build a {@link Placement} from a pin, falling back to {@link resolveTier} for any unset field (AC1). */
function placementFromPin(
  role: string,
  pin: Pin,
  workSize: WorkSize,
  reasoningBudget: ReasoningBudget,
  account: string,
): Placement {
  const tier = resolveTier(workSize, reasoningBudget, pin.provider);
  return {
    role,
    provider: pin.provider,
    account,
    model: pin.model ?? tier.model,
    effort: pin.effort ?? tier.effort,
    context: tier.context, // context is never pinned — always the default tier's.
  };
}

function accountForPinnedProvider(
  provider: Provider,
  candidates: readonly ProviderHeadroom[],
): string {
  const accounts = [
    ...new Set(
      candidates
        .filter((candidate) => candidate.provider === provider)
        .map((candidate) => candidate.account),
    ),
  ].sort((a, b) => a.localeCompare(b));
  if (accounts.length > 1) {
    throw new Error(
      `same-provider multi-subscription routing is unsupported for pinned provider '${provider}'; candidates offered multiple accounts: ${accounts.join(', ')}`,
    );
  }
  return accounts[0] ?? accountForProvider(provider);
}

function assertSingleAccountPerProvider(candidates: readonly ProviderHeadroom[]): void {
  const byProvider = new Map<Provider, Set<string>>();
  for (const candidate of candidates) {
    const accounts = byProvider.get(candidate.provider) ?? new Set<string>();
    accounts.add(candidate.account);
    byProvider.set(candidate.provider, accounts);
  }
  for (const [provider, accounts] of byProvider) {
    if (accounts.size <= 1) continue;
    const list = [...accounts].sort((a, b) => a.localeCompare(b)).join(', ');
    throw new Error(
      `same-provider multi-subscription routing is unsupported for provider '${provider}'; candidates offered multiple accounts: ${list}`,
    );
  }
}

/**
 * A legible exclusion reason for an unhealthy candidate (P9 — never a silent drop). Only ever called on
 * EXCLUDED candidates, so a `known` headroom can ONLY reach here when the account is unavailable —
 * availability shadows the reading, and a `known` + available candidate is healthy (scored, not
 * excluded). An `unknown` headroom is excluded whether or not the account is nominally available.
 */
function exclusionReason(candidate: ProviderHeadroom): string {
  switch (candidate.headroom.kind) {
    case 'known':
      return 'account unavailable'; // known + excluded ⇒ unavailable (a healthy candidate is scored).
    case 'unknown':
      return candidate.available
        ? `headroom unknown: ${candidate.headroom.reason}`
        : `account unavailable: ${candidate.headroom.reason}`;
    default:
      return assertNever(candidate.headroom);
  }
}

/** The soonest binding-window reset across candidates (for the no-candidate ETA), or nothing if none. */
function withSoonestReset(candidates: readonly ProviderHeadroom[]): { soonestResetAt?: string } {
  let bestMs = Infinity;
  let bestIso: string | undefined;
  for (const candidate of candidates) {
    const iso =
      candidate.resetAt ??
      (candidate.headroom.kind === 'known' ? candidate.headroom.reset_at : undefined);
    if (iso === undefined) continue;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms) || ms >= bestMs) continue;
    bestMs = ms;
    bestIso = iso;
  }
  return bestIso !== undefined ? { soonestResetAt: bestIso } : {};
}

/** A legible reason for a floating placement, noting when hysteresis held the seat. */
function floatingReason(
  role: string,
  chosen: ScoredCandidate,
  scored: readonly ScoredCandidate[],
  previous: Placement | undefined,
): string {
  const top = scored[0]!;
  const base = `floating role '${role}' → '${chosen.provider}' (roomiest healthy provider; score ${chosen.score})`;
  if (
    previous !== undefined &&
    (chosen.provider !== top.provider || chosen.account !== top.account)
  ) {
    return `${base}; held on previous '${previous.provider}/${previous.account}' by hysteresis over '${top.provider}/${top.account}'`;
  }
  return base;
}

/** Deterministic provider tie-break: ascending by name (a total order over the candidate set). */
function compareProvider(a: Provider, b: Provider): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ─── Non-pure adapter: read program-data, then call the pure core ─────────────
//
// Everything below only READS (the config cascade + the DispatchStore) and delegates the DECISION to the
// pure placeAgent. It writes nothing (AC9, Principle 12). No new MCP tool is added (AC8) — these are
// internal helpers Phase 5 wires into dispatch.

/** A provider account to consider as a candidate — the (provider, account) pairs the runtime knows of. */
export interface ProviderAccount {
  readonly provider: Provider;
  readonly account: string;
}

/** Default provider-account candidates for floating dispatch: both first-class providers. */
export function defaultProviderAccounts(): readonly ProviderAccount[] {
  return [
    { provider: 'claude', account: accountForProvider('claude') },
    { provider: 'codex', account: accountForProvider('codex') },
  ];
}

/** Freshness options for turning stored usage buckets into routing candidates. */
export interface CandidateReadOptions {
  readonly nowMs?: number;
  readonly ttlMs?: number;
}

/**
 * Reduce one account's observed windows to a single {@link ProviderHeadroom}. PURE (exposed for testing).
 * The **binding window** is the MOST-CONSTRAINED one — the highest `used_pct` (ties broken by window
 * kind, deterministically) — carrying its `reset_at`, because the tightest window is what gates the
 * provider. The headroom is derived via {@link deriveHeadroom}, so an unavailable account (AC6, P9) reads
 * `unknown` for ALL its windows (shadowing any stale bucket) — never a fabricated 0%.
 */
export function bindingProviderHeadroom(
  provider: Provider,
  accountStatus: UsageAccountStatus | undefined,
  buckets: readonly UsageBucket[],
  account: string = accountStatus?.account ?? buckets[0]?.account ?? accountForProvider(provider),
): ProviderHeadroom {
  let binding: UsageBucket | undefined;
  for (const bucket of buckets) {
    if (
      binding === undefined ||
      bucket.usedPct > binding.usedPct ||
      (bucket.usedPct === binding.usedPct && bucket.windowKind < binding.windowKind)
    ) {
      binding = bucket;
    }
  }
  const headroom = deriveHeadroom(accountStatus, binding);
  const base: ProviderHeadroom = {
    provider,
    account,
    available: accountStatus?.available ?? false,
    headroom,
  };
  return binding !== undefined ? { ...base, resetAt: binding.resetAt } : base;
}

/**
 * Build the injected candidate list from the {@link DispatchStore} for the given provider accounts. READS
 * only (the account status + window buckets per account); writes nothing (AC9, P12). The caller supplies
 * the `(provider, account)` pairs because the store models usage per account, not a provider→account map.
 */
export function candidatesFromStore(
  store: DispatchStore,
  accounts: readonly ProviderAccount[],
  options: CandidateReadOptions = {},
): ProviderHeadroom[] {
  const allBuckets = store.readBuckets();
  return accounts.map(({ provider, account }) => {
    const nowMs = options.nowMs;
    const accountBuckets = allBuckets.filter(
      (b) => b.provider === provider && b.account === account,
    );
    const staleBuckets =
      nowMs === undefined ? [] : accountBuckets.filter((b) => isStale(b, nowMs, options.ttlMs));
    if (nowMs !== undefined && staleBuckets.length > 0) {
      const candidate = bindingProviderHeadroom(
        provider,
        store.getAccountStatus(provider, account),
        [],
        account,
      );
      const resetAt = soonestFutureReset(accountBuckets, nowMs);
      return resetAt === undefined ? candidate : { ...candidate, resetAt };
    }
    const freshBuckets = accountBuckets.filter((b) =>
      nowMs === undefined ? true : !isStale(b, nowMs, options.ttlMs),
    );
    const candidate = bindingProviderHeadroom(
      provider,
      store.getAccountStatus(provider, account),
      freshBuckets,
      account,
    );
    if (candidate.resetAt !== undefined || nowMs === undefined) return candidate;
    const resetAt = soonestFutureReset(accountBuckets, nowMs);
    return resetAt === undefined ? candidate : { ...candidate, resetAt };
  });
}

function soonestFutureReset(buckets: readonly UsageBucket[], nowMs: number): string | undefined {
  return buckets
    .map((b) => b.resetAt)
    .filter((resetAt) => {
      const resetMs = Date.parse(resetAt);
      return !Number.isNaN(resetMs) && resetMs > nowMs;
    })
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];
}

/**
 * Resolve the {@link PinTable} from the config cascade (`global ⊕ project-overrides`, project wins) for
 * `projectId`. The cascade merges at the config-KEY granularity, so a project-level `dispatch.pins`
 * REPLACES the global one wholesale (per-key project-wins — there is no per-role sub-merge); this reads
 * the already-resolved value. A malformed value throws fail-loud (P9). `config` is injectable for
 * headless tests; the default opens + closes a config store internally (mirrors `resolveBudgetCapCents`).
 */
export function resolvePinTable(projectId: string, config?: ConfigStore): PinTable {
  const cfg = config ?? openConfigStore();
  const ownsConfig = config === undefined;
  try {
    const raw = cfg.resolveEffective(projectId)[DISPATCH_PINS_CONFIG_KEY];
    if (raw === undefined) return {};
    try {
      return pinTableSchema.parse(raw);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`co dispatch: malformed '${DISPATCH_PINS_CONFIG_KEY}' config: ${detail}`, {
        cause,
      });
    }
  } finally {
    if (ownsConfig) cfg.close();
  }
}

/** Inputs to {@link placeAgentFromStore} — the pure inputs minus the read-derived `pins` + `candidates`. */
export interface PlaceFromStoreInput {
  readonly projectId: string;
  readonly role: string;
  readonly workSize: WorkSize;
  readonly reasoningBudget: ReasoningBudget;
  /** The provider accounts to consider as candidates. */
  readonly accounts: readonly ProviderAccount[];
  readonly nowMs: number;
  readonly previous?: Placement;
  readonly hysteresis?: HysteresisConfig;
}

/** Read-only dependencies for {@link placeAgentFromStore}. */
export interface PlaceFromStoreDeps {
  readonly store: DispatchStore;
  readonly config?: ConfigStore;
}

/**
 * The thin, non-pure adapter: read the {@link PinTable} (config cascade) + the candidate headrooms (the
 * {@link DispatchStore}), then delegate the DECISION to the pure {@link placeAgent}. READS program-data
 * only — writes nothing (AC9, Principle 12). Determinism still holds end-to-end for a fixed store/config
 * state + `nowMs` (AC10): the reads are pure projections, the decision is the pure core.
 */
export function placeAgentFromStore(
  input: PlaceFromStoreInput,
  deps: PlaceFromStoreDeps,
): PlacementDecision {
  const pins = resolvePinTable(input.projectId, deps.config);
  const candidates = candidatesFromStore(deps.store, input.accounts, { nowMs: input.nowMs });
  return placeAgent({
    role: input.role,
    workSize: input.workSize,
    reasoningBudget: input.reasoningBudget,
    pins,
    candidates,
    nowMs: input.nowMs,
    previous: input.previous,
    hysteresis: input.hysteresis,
  });
}
