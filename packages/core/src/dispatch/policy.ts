import type { CostRollup, UsageAccountStatus, UsageBucket } from './events.js';

/**
 * L4 Phase 1 PURE policy (AC10, Principle 16 — decisions-deferred / substrate). Every function here is
 * a deterministic function of its INJECTED inputs — no I/O, no clock, no `Date.now()` / `Math.random()`
 * / Map-iteration order (the same determinism `worktrees/messages.ts` / `repo-mode.ts` hold to). `now`
 * is always a PARAMETER (epoch ms), never read from the clock, so replay is deterministic. The live
 * usage signal arrives through the injected `ProviderUsageSource`; this module never reaches for it.
 *
 * Later phases consume these: the balancer (Phase 3) reads {@link deriveHeadroom} + {@link isStale} to
 * pick the roomier provider and treat `unknown` conservatively; {@link nearBudget} backs the
 * observability emit Phase 1 wires into the cost store.
 */

/**
 * Headroom expressed as a DISCRIMINATED value — never a magic number (AC6). `known` carries the live
 * window reading; `unknown` carries a human reason. The balancer (Phase 3) treats `unknown`
 * conservatively (pin-only, never "healthy"), so a failed / unavailable source can never read as 0%
 * used. This is exactly why headroom is a union and not a `number` with a sentinel.
 */
export type Headroom =
  | { readonly kind: 'known'; readonly used_pct: number; readonly reset_at: string }
  | { readonly kind: 'unknown'; readonly reason: string };

/** Default near-budget threshold — a task's cost is "nearing" its cap at ≥ 80% of it. */
export const NEAR_BUDGET_THRESHOLD_PCT_DEFAULT = 80;

/**
 * Default usage-bucket freshness TTL: 5 minutes (epoch ms). A passive sample is trusted for this long
 * after `sampled_at`, but never past `reset_at` — see {@link isStale}. Phase 6 layers source ordering
 * on top; this is the baseline staleness bound.
 */
export const USAGE_BUCKET_TTL_MS_DEFAULT = 5 * 60 * 1000;

/** The two fields {@link isStale} needs — accepts a full {@link UsageBucket} or a bare pair. */
export type StaleInput = Pick<UsageBucket, 'sampledAt' | 'resetAt'>;

/**
 * Is a usage bucket stale at `nowMs`? PURE, with `now` injected (epoch ms) — never the wall clock, so
 * replay is deterministic. A sample is fresh from `sampled_at` until the EARLIER of (a) `sampled_at +
 * ttl` and (b) `reset_at` — because once the window has refreshed (`reset_at`) the old `used_pct` is
 * meaningless, so freshness is bounded by it regardless of TTL. An unparseable timestamp reads as stale
 * (fail-safe: we cannot prove freshness ⇒ do not trust it).
 */
export function isStale(
  bucket: StaleInput,
  nowMs: number,
  ttlMs: number = USAGE_BUCKET_TTL_MS_DEFAULT,
): boolean {
  const sampledMs = Date.parse(bucket.sampledAt);
  const resetMs = Date.parse(bucket.resetAt);
  if (Number.isNaN(sampledMs) || Number.isNaN(resetMs)) return true; // cannot prove fresh ⇒ stale.
  const deadline = Math.min(sampledMs + ttlMs, resetMs);
  return nowMs >= deadline;
}

/** The dollar total a near-budget check reads — accepts a full {@link CostRollup} or a bare total. */
export type BudgetInput = Pick<CostRollup, 'totalCostUsd'>;

/**
 * Is a rollup's dollar spend in the near-budget band? PURE. The cap is in CENTS (heir to
 * `cost_budget_cents`); `thresholdPct` is the fraction of the cap that counts as "nearing" (default
 * {@link NEAR_BUDGET_THRESHOLD_PCT_DEFAULT}). A non-positive cap is treated as "no cap" ⇒ never nearing
 * (avoids a divide-by-zero and a spurious signal when no budget is configured). Codex turns carry no
 * dollar cost, so a Codex-only task stays at `totalCostUsd = 0` and never trips this — v1 bounds DOLLAR
 * spend (there is no Codex price table).
 */
export function nearBudget(
  rollup: BudgetInput,
  capCents: number,
  thresholdPct: number = NEAR_BUDGET_THRESHOLD_PCT_DEFAULT,
): boolean {
  if (capCents <= 0) return false;
  const capUsd = capCents / 100;
  return rollup.totalCostUsd >= capUsd * (thresholdPct / 100);
}

/**
 * Did recording a cost CROSS into the near-budget band? PURE edge trigger: true iff the spend was below
 * the band before and at/over it after. This is what makes the observability event fire ONCE at the
 * crossing rather than on every subsequent over-threshold turn.
 */
export function crossesNearBudget(
  before: BudgetInput,
  after: BudgetInput,
  capCents: number,
  thresholdPct: number = NEAR_BUDGET_THRESHOLD_PCT_DEFAULT,
): boolean {
  return !nearBudget(before, capCents, thresholdPct) && nearBudget(after, capCents, thresholdPct);
}

/**
 * Derive a window's {@link Headroom} from the account's availability + the window bucket. PURE. The
 * account availability is checked FIRST (AC6): an unavailable account is `unknown` for ALL its windows,
 * shadowing any stale bucket — so a failed source can never read as healthy. An available account with
 * no bucket for the window is also `unknown` (nothing observed yet), never a fabricated 0%.
 */
export function deriveHeadroom(
  accountStatus: UsageAccountStatus | undefined,
  bucket: UsageBucket | undefined,
): Headroom {
  if (accountStatus === undefined) {
    return { kind: 'unknown', reason: 'no usage observed for this account' };
  }
  if (!accountStatus.available) {
    return { kind: 'unknown', reason: accountStatus.reason ?? 'usage source unavailable' };
  }
  if (bucket === undefined) {
    return { kind: 'unknown', reason: 'no usage observed for this window' };
  }
  return { kind: 'known', used_pct: bucket.usedPct, reset_at: bucket.resetAt };
}
