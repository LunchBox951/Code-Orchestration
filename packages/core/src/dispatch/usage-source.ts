/**
 * L4 Phase 1 — the **substrate seam** the whole dispatch/cost/usage stack rides on. This file is the
 * FROZEN CONTRACT (spec §4.4): the four types below are pinned verbatim and later L4 phases (tier
 * matrix, balancer, throttle, dispatch integration, live adapters) read these EXACT shapes. Do not
 * rename or reshape a field — a downstream phase keys on it.
 *
 * The signal flows in through one injected, read-only port — {@link ProviderUsageSource}. The default
 * production implementation is the real per-provider adapters (Claude status-line / Codex sqlite),
 * which land in **Phase 6**; this phase ships only the INTERFACE plus a production-quality
 * {@link FakeUsageSource} double that drives every headless policy test in phases 3–5.
 *
 * **AC11 (HARD RULE — Principle 2 authentic-terminal + billing):** the usage-retrieval contract must
 * NEVER run inference or spend API-billed tokens. `ProviderUsageSource.read` is a passive / metadata
 * read ONLY (a status-line probe, a local sqlite read) and runs in `co`'s host process, NEVER inside
 * an agent sandbox. The real adapters (Phase 6) must honour this; the contract is documented here so
 * they cannot drift. (The test that asserts the real Claude adapter never reaches an inference path
 * is Phase 6 — it needs the real adapter to assert against.)
 */

/** The two first-class providers `co` routes across (Principle 13 — provider-neutral). */
export type Provider = 'claude' | 'codex';

/**
 * One refresh window of a provider account's usage (FROZEN — spec §4.4). A subscription typically has
 * more than one (e.g. Claude `five_hour` + `weekly`; a generic `primary` + `secondary`), so a snapshot
 * carries a list. Each window tracks how much is consumed AND when it refreshes — the balancer
 * (Phase 3) reads both to pick the roomier provider and to know when a throttled one frees up.
 */
export interface UsageWindow {
  readonly kind: string; // window label, e.g. 'five_hour' | 'weekly' | 'primary' | 'secondary'
  readonly used_pct: number; // 0..100 percent of this window consumed
  readonly reset_at: string; // ISO-8601 timestamp when this window refreshes
}

/**
 * A single passive sample of one provider account's live usage (FROZEN — spec §4.4). `available:
 * false` is a first-class state — not-logged-in / offline / over-limit / unknown — and it is NEVER the
 * same as "0% used": the bucket headroom for an unavailable snapshot is `unknown`, never healthy (AC6,
 * Principle 9 — no-silent-failures). `source` records WHICH source produced it ('statusLine' |
 * 'sqlite' | 'fake' …) so the layered ordering Phase 6 wires can be audited; `sampled_at` is when the
 * sample was taken (the staleness predicate reads it).
 */
export interface UsageSnapshot {
  readonly provider: Provider;
  readonly account: string; // per-account identity (e.g. 'claude:max', 'codex:pro')
  readonly windows: readonly UsageWindow[];
  readonly available: boolean; // false ⇒ unavailable/unhealthy (not-logged-in/offline/limit/unknown)
  readonly source: string; // which source produced it (e.g. 'statusLine','sqlite','fake')
  readonly sampled_at: string; // ISO-8601 when sampled
}

/**
 * The read-only, injected port the usage signal arrives through (FROZEN — spec §4.4). The default
 * implementation is the real adapters (Phase 6); the probe runs in `co`'s HOST process, NEVER an agent
 * sandbox.
 *
 * **MUST be a passive / metadata read only (AC11):** an implementation MUST NOT run inference or spend
 * API-billed tokens — no `claude -p`, no `codex exec`, no streaming completion. It reads metadata a
 * subscription already exposes (a status-line value, a local sqlite usage table). This is a billing +
 * authentic-terminal invariant (Principle 2), not a performance note.
 */
export interface ProviderUsageSource {
  read(provider: Provider): Promise<UsageSnapshot>;
}

/**
 * The stable, user-facing code for "no usage source succeeded" — surfaced when a source read fails or
 * yields an unavailable snapshot. A code (not just a message string) so the app / CLI can branch on it
 * and the balancer (Phase 3) can recognise the unknown-headroom condition deterministically.
 */
export const USAGE_UNAVAILABLE_CODE = 'usage_source_unavailable' as const;

/**
 * The loud, typed failure raised when usage cannot be read for a provider (a source threw, or it
 * returned an `available: false` snapshot). Fail-loud over a silent "looks healthy" default
 * (Principle 9, AC6): the caller must SEE the failure, and the bucket headroom must read `unknown`
 * (never 0%, never healthy). Carries the provider, an optional account (present when the unavailable
 * snapshot named one), and a user-facing `message`, while preserving the underlying `cause`.
 */
export class UsageUnavailableError extends Error {
  /** Stable machine code — {@link USAGE_UNAVAILABLE_CODE}. */
  readonly code = USAGE_UNAVAILABLE_CODE;
  /** The provider whose usage could not be read. */
  readonly provider: Provider;
  /** The account, when the failure carried one (an `available: false` snapshot does; a throw may not). */
  readonly account?: string;

  constructor(provider: Provider, message: string, opts?: { account?: string; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'UsageUnavailableError';
    this.provider = provider;
    if (opts?.account !== undefined) this.account = opts.account;
  }
}

/**
 * How to seed a {@link FakeUsageSource}: either a bare `Map` of canned snapshots per provider, or an
 * options object pairing canned snapshots with simulated read errors. A provider present in `errors`
 * makes {@link FakeUsageSource.read} THROW that error (simulating a failed/unhealthy source); a
 * provider with neither a snapshot nor an error throws a {@link UsageUnavailableError} (an unconfigured
 * provider reads as unavailable, never as silently healthy).
 */
export type FakeUsageSourceInit =
  | ReadonlyMap<Provider, UsageSnapshot>
  | {
      readonly snapshots?:
        | ReadonlyMap<Provider, UsageSnapshot>
        | Partial<Record<Provider, UsageSnapshot>>;
      readonly errors?: ReadonlyMap<Provider, Error> | Partial<Record<Provider, Error>>;
    };

/** Normalize the `Map | Record` seed forms into a single lookup `Map`. */
function toMap<V>(
  seed: ReadonlyMap<Provider, V> | Partial<Record<Provider, V>> | undefined,
): ReadonlyMap<Provider, V> {
  if (seed === undefined) return new Map();
  if (seed instanceof Map) return seed;
  const map = new Map<Provider, V>();
  for (const [provider, value] of Object.entries(seed) as [Provider, V | undefined][]) {
    if (value !== undefined) map.set(provider, value);
  }
  return map;
}

/**
 * A production-quality {@link ProviderUsageSource} double driven by recorded / canned snapshots — NOT
 * a test-only file. It is the source every headless policy test in phases 3–5 injects, and it never
 * touches a network or a provider binary (so it trivially honours AC11). It is also fully passive:
 * `read` returns canned data or throws a configured error; it computes nothing and spends nothing.
 *
 * Behaviour of {@link read}:
 *   - provider in `errors`    → throws that error (simulate a failed / unhealthy source).
 *   - provider in `snapshots` → resolves with the canned snapshot (may itself be `available: false`).
 *   - otherwise               → throws {@link UsageUnavailableError} (unconfigured ⇒ unavailable).
 */
export class FakeUsageSource implements ProviderUsageSource {
  private readonly snapshots: ReadonlyMap<Provider, UsageSnapshot>;
  private readonly errors: ReadonlyMap<Provider, Error>;

  constructor(init: FakeUsageSourceInit = {}) {
    if (init instanceof Map) {
      this.snapshots = init;
      this.errors = new Map();
    } else {
      // The only non-Map member of the union is the options object (a ReadonlyMap is handled above).
      const opts = init as Exclude<FakeUsageSourceInit, ReadonlyMap<Provider, UsageSnapshot>>;
      this.snapshots = toMap(opts.snapshots);
      this.errors = toMap(opts.errors);
    }
  }

  read(provider: Provider): Promise<UsageSnapshot> {
    const error = this.errors.get(provider);
    if (error) return Promise.reject(error);
    const snapshot = this.snapshots.get(provider);
    if (snapshot) return Promise.resolve(snapshot);
    return Promise.reject(
      new UsageUnavailableError(
        provider,
        `FakeUsageSource has no canned snapshot for provider '${provider}'.`,
      ),
    );
  }
}
