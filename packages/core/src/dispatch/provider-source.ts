/**
 * L4 Phase 6 — the default {@link ProviderUsageSource} factory + the program-data cache wrapper + the
 * gated-live-E2E predicate (spec §4.3; AC7). This is where the live adapters are "wired as default":
 *
 *   - {@link createProviderUsageSource} / {@link defaultProviderUsageSource} return the REAL per-provider
 *     adapter ({@link ClaudeUsageSource} / {@link CodexUsageSource}) with real I/O seams by default, so
 *     production (the host) gets live measurement. Tests inject fixture seams via the same config object,
 *     so default `pnpm test` constructs ZERO real I/O.
 *   - {@link readProviderUsageCached} layers the spec §4.3 cache: serve the last normalized sample from
 *     the Phase-1 program-data buckets until it goes stale (reusing {@link isStale} +
 *     {@link USAGE_BUCKET_TTL_MS_DEFAULT}), and only then do a fresh live read via the fail-loud
 *     {@link observeUsage} seam — which records the new sample (AC9 — program-data only, never the repo).
 *   - {@link isLiveE2EEnabled} is the explicit opt-in gate ({@link CO_LIVE_E2E_ENV}) the gated local live
 *     E2E rides; in the sandbox (no opt-in) it reads `false`, so the live suite SKIPS LOUDLY (never
 *     fails, never mock-passes).
 *
 * AC8: no new agent MCP tool / registry change — these are internal substrate. AC10/P16: the policy
 * (Phases 2–4) is unchanged; the adapters sit behind the frozen interface.
 */

import { assertNever } from '../assert-never.js';
import type { Provider, ProviderUsageSource, UsageSnapshot, UsageWindow } from './usage-source.js';
import { isStale, USAGE_BUCKET_TTL_MS_DEFAULT } from './policy.js';
import { observeUsage, type DispatchStore } from './dispatch-store.js';
import type { ProviderAccount } from './balancer.js';
import { accountForProvider } from './provider-account.js';
import {
  ClaudeUsageSource,
  defaultClaudeDeps,
  type ClaudeUsageSourceOptions,
  type DefaultClaudeDepsOptions,
} from './claude-source.js';
import {
  CodexUsageSource,
  defaultCodexDeps,
  type CodexUsageSourceOptions,
  type DefaultCodexDepsOptions,
} from './codex-source.js';

/** Construction config for the Claude adapter: its I/O-seam overrides plus its static options. */
export interface ClaudeSourceConfig extends DefaultClaudeDepsOptions, ClaudeUsageSourceOptions {}

/** Construction config for the Codex adapter: its I/O-seam overrides plus its static options. */
export interface CodexSourceConfig extends DefaultCodexDepsOptions, CodexUsageSourceOptions {}

export { accountForProvider } from './provider-account.js';

export function createProviderUsageSource(
  provider: 'claude',
  config?: ClaudeSourceConfig,
): ClaudeUsageSource;
export function createProviderUsageSource(
  provider: 'codex',
  config?: CodexSourceConfig,
): CodexUsageSource;
/**
 * Construct the real {@link ProviderUsageSource} adapter for a provider, with real I/O seams by default
 * (AC7 — wired as default). Pass a `config` to override individual seams (tests inject fixtures) or the
 * static options (account label, the Claude operator gate). Constructing the adapter does NO I/O — the
 * seams only run when `read` is called — so a non-live test can construct one freely, and a hermetic
 * test injects fixture seams so `read` touches no network / process / disk.
 */
export function createProviderUsageSource(
  provider: Provider,
  config: ClaudeSourceConfig | CodexSourceConfig = {},
): ProviderUsageSource {
  switch (provider) {
    case 'claude': {
      const c = config as ClaudeSourceConfig;
      return new ClaudeUsageSource(defaultClaudeDeps(c), c);
    }
    case 'codex': {
      const c = config as CodexSourceConfig;
      return new CodexUsageSource(defaultCodexDeps(c), c);
    }
    default:
      return assertNever(provider);
  }
}

/** Alias for {@link createProviderUsageSource} — the "default ProviderUsageSource" production wires in. */
export const defaultProviderUsageSource = createProviderUsageSource;

/** Union-friendly default factory for mounts/adapters that receive provider as a `Provider` union. */
export function defaultUsageSourceFactory(account: ProviderAccount): ProviderUsageSource {
  return account.provider === 'claude'
    ? createProviderUsageSource('claude', { account: account.account })
    : createProviderUsageSource('codex', { account: account.account });
}

/** The `source` tag a snapshot served from the program-data cache carries. */
export const CACHE_SOURCE = 'cache' as const;

/** Options for {@link readProviderUsageCached}: the account, the clock, and the freshness TTL. */
export interface CachedUsageReadOptions {
  /** Account to cache under; default {@link accountForProvider}. */
  readonly account?: string;
  /** Now (epoch ms) for the staleness check; default the wall clock. */
  readonly nowMs?: number;
  /** Freshness TTL (epoch ms); default {@link USAGE_BUCKET_TTL_MS_DEFAULT}. Bounded by each window's reset. */
  readonly ttlMs?: number;
}

/**
 * Read a provider's usage with the spec §4.3 cache in front (program-data only, AC9). If the account's
 * last sample is available AND every one of its window buckets is still fresh ({@link isStale} = false at
 * `nowMs`, bounded by each window's `reset_at`), reconstruct and return that cached {@link UsageSnapshot}
 * WITHOUT a live read (the `source` tag becomes {@link CACHE_SOURCE}). Otherwise do a fresh live read via
 * the fail-loud {@link observeUsage} — which records the new sample (superseding the cache) and throws
 * {@link import('./usage-source.js').UsageUnavailableError} when no source succeeds. An active probe
 * therefore fires only on stale-and-needed; a fresh passive sample is served straight from the buckets.
 */
export async function readProviderUsageCached(
  source: ProviderUsageSource,
  provider: Provider,
  store: DispatchStore,
  options: CachedUsageReadOptions = {},
): Promise<UsageSnapshot> {
  const account = options.account ?? accountForProvider(provider);
  const nowMs = options.nowMs ?? Date.now();
  const ttlMs = options.ttlMs ?? USAGE_BUCKET_TTL_MS_DEFAULT;

  const cached = readFreshCache(store, provider, account, nowMs, ttlMs);
  if (cached) return cached;
  return observeUsage(source, provider, store, {
    expectedAccount: account,
    nowMs,
  });
}

/**
 * Reconstruct a fresh cached {@link UsageSnapshot} from the program-data buckets, or undefined when the
 * cache is unavailable / empty / stale. The account must be available (an `unknown`/unavailable account
 * never serves a "healthy" cache — AC6), and EVERY window bucket must be fresh; one stale window forces a
 * live re-read of the whole account.
 */
function readFreshCache(
  store: DispatchStore,
  provider: Provider,
  account: string,
  nowMs: number,
  ttlMs: number,
): UsageSnapshot | undefined {
  const status = store.getAccountStatus(provider, account);
  if (!status || !status.available || status.provider !== provider) return undefined;

  const buckets = store
    .readBuckets()
    .filter((b) => b.provider === provider && b.account === account);
  if (buckets.length === 0) return undefined;
  for (const bucket of buckets) {
    if (isStale(bucket, nowMs, ttlMs)) return undefined;
  }

  const windows: UsageWindow[] = buckets.map((b) => ({
    kind: b.windowKind,
    used_pct: b.usedPct,
    reset_at: b.resetAt,
  }));
  return {
    provider,
    account,
    windows,
    available: true,
    source: CACHE_SOURCE,
    sampled_at: status.sampledAt,
  };
}

/** The env var the gated local live E2E opts in through. */
export const CO_LIVE_E2E_ENV = 'CO_LIVE_E2E';

/**
 * Is the gated local live E2E explicitly opted in? True only when {@link CO_LIVE_E2E_ENV} is set to a
 * truthy value (`1`/`true`/`yes`/`on`). In the sandbox (and CI) the var is unset, so this is `false` and
 * the live suite SKIPS LOUDLY — it never fails and never mock-passes. PURE over the injected env, so the
 * skip behaviour is asserted hermetically.
 */
export function isLiveE2EEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[CO_LIVE_E2E_ENV];
  return raw !== undefined && /^(1|true|yes|on)$/i.test(raw.trim());
}
