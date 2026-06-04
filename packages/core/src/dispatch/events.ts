import { z } from 'zod';
import type { NewEvent } from '../store/types.js';
import type { SchemaMap } from '../replay/decode.js';
import type { UpcasterRegistry } from '../replay/upcaster.js';
import type { Provider } from './usage-source.js';

/**
 * L4 dispatch events live in the PROJECT store (one per registered project), exactly like the L1 mail
 * and L3 worktree events — pure ORCHESTRATION state, event-sourced over L0 (Principle 14 —
 * recoverable), kept ONLY in program-data, NEVER the target repo (Principle 12 — pristine-repo; the
 * store openers already enforce the location). The event types are DOTTED to mark them L0-style
 * infrastructure events, mirroring `worktree.created` / `config.set`.
 *
 * Three streams, each keyed by the L0 `${entity}:${id}` scope pattern:
 *   - `usage:<account>` — passive samples of a provider account's live rate-limit usage.
 *   - `cost:<agent>`    — a per-turn cost observation, filed under the acting agent's stream.
 *   - `cost:<task>`     — the near-budget observability signal, filed under the task's stream.
 *
 * The cost ROLLUP read-model (per agent AND per task) is derived from a SINGLE `cost.recorded` event:
 * the event is filed once (under the acting agent) and the projector folds it into BOTH the agent and
 * the task rollup from the payload, so the log is never double-counted while both views stay exact.
 */

/** Current payload schema version — v1; no upcasters yet (an empty chain is the identity upcast). */
export const DISPATCH_EVENT_V = 1;

/** A passive sample of one provider account's usage (one event per window, or an unavailable marker). */
export const EVENT_USAGE_OBSERVED = 'usage.observed' as const;
/** A per-turn cost observation (a provider `result`-style readout), rolled up per agent AND per task. */
export const EVENT_COST_RECORDED = 'cost.recorded' as const;
/** Observability ONLY (never a gate): a task's accumulated cost crossed into the near-budget band. */
export const EVENT_COST_NEAR_BUDGET = 'cost.near_budget' as const;

/** Scope prefix for the per-account usage-sample stream; the suffix is the account. */
export const USAGE_SCOPE_PREFIX = 'usage:';
/** Scope prefix shared by the cost streams (`cost:<agent>` records, `cost:<task>` near-budget). */
export const COST_SCOPE_PREFIX = 'cost:';

/** A provider account's usage-sample stream scope: `usage:<account>`. */
export function usageScope(account: string): string {
  return USAGE_SCOPE_PREFIX + account;
}

/**
 * A cost stream scope: `cost:<id>`. `cost.recorded` is filed under the acting AGENT id; the derived
 * task rollup comes from the payload, not the scope. `cost.near_budget` is filed under the TASK id.
 */
export function costScope(id: string): string {
  return COST_SCOPE_PREFIX + id;
}

/** zod provider enum — the runtime guard for the frozen {@link Provider} union. */
export const providerSchema = z.enum(['claude', 'codex']);

// ── usage.observed ───────────────────────────────────────────────────────────────────────────────
/**
 * `usage.observed` is a discriminated union on `available`, so an unavailable sample can NEVER masquerade
 * as a `used_pct: 0` healthy one (AC6, Principle 9). An AVAILABLE sample carries one window's data
 * (a multi-window {@link import('./usage-source.js').UsageSnapshot} folds into one event per window); an
 * UNAVAILABLE sample carries the reason and marks the whole account's headroom `unknown`.
 *
 * The window fields are all-or-none OPTIONAL on the available variant: a reachable account that reports
 * no window data still marks itself available (its per-window headroom then reads `unknown` — nothing
 * observed — rather than a fabricated 0%). The all-or-none invariant is enforced fail-loud at
 * construction by {@link makeUsageObservedEvent}, and the projector defensively writes a bucket only
 * when all three window fields are present.
 */
export const usageObservedAvailableSchema = z.object({
  available: z.literal(true),
  provider: providerSchema,
  account: z.string().min(1),
  window_kind: z.string().min(1).optional(),
  used_pct: z.number().min(0).optional(), // 0..100 expected; not upper-bounded so a real adapter can't be rejected.
  reset_at: z.string().min(1).optional(), // ISO-8601 when this window refreshes.
  source: z.string().min(1),
  sampled_at: z.string().min(1), // ISO-8601 when sampled.
});
export const usageObservedUnavailableSchema = z.object({
  available: z.literal(false),
  provider: providerSchema,
  account: z.string().min(1),
  reason: z.string().min(1), // user-facing explanation (not-logged-in / offline / over-limit / unknown).
  source: z.string().min(1),
  sampled_at: z.string().min(1),
});
export const usageObservedSchema = z.discriminatedUnion('available', [
  usageObservedAvailableSchema,
  usageObservedUnavailableSchema,
]);
export type UsageObservedAvailable = z.infer<typeof usageObservedAvailableSchema>;
export type UsageObservedUnavailable = z.infer<typeof usageObservedUnavailableSchema>;
export type UsageObserved = z.infer<typeof usageObservedSchema>;

// ── cost.recorded ────────────────────────────────────────────────────────────────────────────────
/**
 * A per-turn cost observation (spec §4.2). It accommodates BOTH provider shapes with ONE schema:
 * Claude reports a dollar cost (`cost_usd`, from the stream-json `result`'s `total_cost_usd`); Codex
 * reports tokens / usage-% with NO native dollar cost (v1 carries `used_pct` + token fields and ships
 * NO price table). `cost_usd` is therefore OPTIONAL — absent for Codex — and the rollup sums dollars
 * only where present. `turn` identifies which turn the cost is for; `agent` + `task` drive the dual
 * rollup.
 */
export const costRecordedSchema = z.object({
  provider: providerSchema,
  agent: z.string().min(1),
  task: z.string().min(1),
  turn: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative().optional(), // Claude dollar cost; absent for Codex (no price table).
  input_tokens: z.number().int().nonnegative().optional(),
  output_tokens: z.number().int().nonnegative().optional(),
  total_tokens: z.number().int().nonnegative().optional(),
  used_pct: z.number().min(0).optional(), // Codex usage-% readout (the dollar-cost-free expression).
});
export type CostRecorded = z.infer<typeof costRecordedSchema>;

// ── cost.near_budget ─────────────────────────────────────────────────────────────────────────────
/**
 * Recorded when a task's accumulated dollar cost first crosses into the near-budget band (≥
 * `threshold_pct` of the configured cap). This is OBSERVABILITY ONLY — it never gates or blocks work
 * (Principle 9 / throttle-don't-surprise); the operator is informed, not stopped. `total_cost_usd` is
 * the task rollup total at the crossing; `cap_cents` is the resolved budget cap; `agent` is the actor
 * whose recorded cost triggered the crossing.
 */
export const costNearBudgetSchema = z.object({
  task: z.string().min(1),
  agent: z.string().min(1),
  provider: providerSchema,
  total_cost_usd: z.number().nonnegative(),
  cap_cents: z.number().nonnegative(),
  threshold_pct: z.number().min(0).max(100),
});
export type CostNearBudget = z.infer<typeof costNearBudgetSchema>;

/** Current-version schema per L4 dispatch event type — validated on append AND on read (decode). */
export const dispatchSchemas: SchemaMap = new Map<string, z.ZodType>([
  [EVENT_USAGE_OBSERVED, usageObservedSchema],
  [EVENT_COST_RECORDED, costRecordedSchema],
  [EVENT_COST_NEAR_BUDGET, costNearBudgetSchema],
]);

/** No payload migrations at v1 (an empty chain is the identity upcast). */
export const dispatchUpcasters: UpcasterRegistry = new Map();

/**
 * Build + validate a `usage.observed` `NewEvent`, keyed on the account's usage stream. Self-validating
 * like the other `make*Event`s; the acting source is NOT an agent, so no `actor` is set. Enforces the
 * available variant's all-or-none window invariant fail-loud (Principle 9) — a partial window (e.g.
 * `window_kind` without `used_pct`) is a programming error, never a silently dropped field.
 */
export function makeUsageObservedEvent(projectId: string, obs: UsageObserved): NewEvent {
  const payload = usageObservedSchema.parse(obs);
  if (payload.available) {
    const present = [payload.window_kind, payload.used_pct, payload.reset_at].filter(
      (f) => f !== undefined,
    ).length;
    if (present !== 0 && present !== 3) {
      throw new Error(
        'makeUsageObservedEvent: an available usage.observed must carry all of ' +
          '{window_kind, used_pct, reset_at} or none of them.',
      );
    }
  }
  return {
    projectId,
    scope: usageScope(payload.account),
    type: EVENT_USAGE_OBSERVED,
    v: DISPATCH_EVENT_V,
    payload,
  };
}

/**
 * Build + validate a `cost.recorded` `NewEvent`, filed under the acting AGENT's cost stream (the task
 * rollup is derived from the payload). The acting agent is recorded as the event `actor`, mirroring how
 * a mail's sender lands on `actor`.
 */
export function makeCostRecordedEvent(projectId: string, rec: CostRecorded): NewEvent {
  const payload = costRecordedSchema.parse(rec);
  return {
    projectId,
    scope: costScope(payload.agent),
    type: EVENT_COST_RECORDED,
    v: DISPATCH_EVENT_V,
    payload,
    actor: payload.agent,
  };
}

/** Build + validate a `cost.near_budget` `NewEvent`, filed under the TASK's cost stream. */
export function makeCostNearBudgetEvent(projectId: string, nb: CostNearBudget): NewEvent {
  const payload = costNearBudgetSchema.parse(nb);
  return {
    projectId,
    scope: costScope(payload.task),
    type: EVENT_COST_NEAR_BUDGET,
    v: DISPATCH_EVENT_V,
    payload,
    actor: payload.agent,
  };
}

// ── Read-model record shapes (what the store facade returns) ───────────────────────────────────────
/**
 * The latest KNOWN per-window usage observation — one row per `(account, window_kind)`. `sampledAt` /
 * `resetAt` are the persisted ISO strings from the event payload (not wall-clock — freeze #6); the
 * staleness predicate reads them. An account whose latest sample was UNAVAILABLE keeps any prior bucket
 * row, but it is shadowed by {@link UsageAccountStatus}`.available = false` — see `deriveHeadroom`.
 */
export interface UsageBucket {
  readonly provider: Provider;
  readonly account: string;
  readonly windowKind: string;
  readonly usedPct: number;
  readonly resetAt: string;
  readonly source: string;
  readonly sampledAt: string;
}

/**
 * The latest availability status of a provider account — one row per account. `available: false`
 * (with its `reason`) is what makes a whole account's headroom read `unknown` regardless of any stale
 * per-window bucket (AC6). `observedTs` is the persisted event ts (freeze #6).
 */
export interface UsageAccountStatus {
  readonly provider: Provider;
  readonly account: string;
  readonly available: boolean;
  /** The reason headroom is unknown, when `available: false`; absent when available. */
  readonly reason?: string;
  readonly source: string;
  readonly sampledAt: string;
  readonly observedTs: number;
}

/** Which side of the dual cost rollup a row belongs to. */
export type CostRollupKind = 'agent' | 'task';

/**
 * A cost rollup total — one row per `(kind, id)`: the per-agent view (`kind: 'agent'`) AND the per-task
 * view (`kind: 'task'`), both folded from the same `cost.recorded` events. Dollars are summed only
 * where reported (Claude); tokens are summed across all observations; `usedPct` is summed for the Codex
 * usage-% expression. `observations` is the count of folded events.
 */
export interface CostRollup {
  readonly kind: CostRollupKind;
  readonly id: string;
  readonly totalCostUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly usedPct: number;
  readonly observations: number;
}

/**
 * A recorded near-budget crossing (observability). `seq` is the persisted L0 sequence of the
 * `cost.near_budget` event (its stable identity); `recordedTs` is the persisted event ts (freeze #6).
 */
export interface NearBudgetRecord {
  readonly seq: number;
  readonly task: string;
  readonly agent: string;
  readonly provider: Provider;
  readonly totalCostUsd: number;
  readonly capCents: number;
  readonly thresholdPct: number;
  readonly recordedTs: number;
}
