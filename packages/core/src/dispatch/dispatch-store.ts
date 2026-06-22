import type { DatabaseSync } from 'node:sqlite';
import { decode } from '../replay/decode.js';
import { applyEvent, type Projector } from '../replay/projector.js';
import {
  makeReviewRequestedEvent,
  reviewSchemas,
  reviewUpcasters,
  type ReviewRequestRecord,
  type ReviewRequested,
} from '../review/events.js';
import {
  ensureReviewTables,
  ReviewProjector,
  selectReviewRequest,
} from '../review/review-projector.js';
import { openProjectStore } from '../store/sqlite-store.js';
import { openConfigStore, type ConfigStore } from '../config/config-store.js';
import {
  dispatchSchemas,
  dispatchUpcasters,
  makeCostNearBudgetEvent,
  makeCostRecordedEvent,
  makePlacementDecidedEvent,
  makeToolInvokedEvent,
  makeUsageObservedEvent,
  type AgentToolUsage,
  type CostRecorded,
  type CostRollup,
  type CostRollupKind,
  type NearBudgetRecord,
  type PlacementDecided,
  type PlacementRecord,
  type ToolInvoked,
  type UsageAccountStatus,
  type UsageBucket,
  type UsageObserved,
} from './events.js';
import {
  CostProjector,
  ensureCostTables,
  selectAllCostRollups,
  selectCostRollup,
  selectNearBudgetBySeq,
  selectNearBudgetEvents,
} from './cost-projector.js';
import {
  ToolUsageProjector,
  ensureToolUsageTables,
  selectAgentToolUsage,
} from './tool-usage-projector.js';
import {
  PlacementProjector,
  ensurePlacementTable,
  selectAllPlacements,
  selectPlacementBySeq,
  selectPlacementsByAgent,
} from './placement-projector.js';
import {
  UsageProjector,
  ensureUsageTables,
  selectAllUsageAccounts,
  selectAllUsageBuckets,
  selectUsageAccount,
  selectUsageBucket,
} from './usage-projector.js';
import {
  crossesNearBudget,
  deriveHeadroom,
  NEAR_BUDGET_THRESHOLD_PCT_DEFAULT,
  type Headroom,
} from './policy.js';
import {
  UsageUnavailableError,
  type Provider,
  type ProviderUsageSource,
  type UsageSnapshot,
} from './usage-source.js';

/** The config-cascade key the per-project budget cap lives under (heir to the prototype's setting). */
export const COST_BUDGET_CENTS_KEY = 'cost_budget_cents';

/**
 * A resolved budget cap for the near-budget check: the cap in CENTS plus the "nearing" threshold
 * (default {@link NEAR_BUDGET_THRESHOLD_PCT_DEFAULT}). Passed to {@link DispatchStore.recordCost}; when
 * omitted, no near-budget evaluation happens (observability is opt-in, never a gate).
 */
export interface BudgetCap {
  readonly capCents: number;
  readonly thresholdPct?: number;
}

/** What {@link DispatchStore.recordCost} returns: the two updated rollups + the near-budget event iff one fired. */
export interface CostRecordResult {
  readonly agent: CostRollup;
  readonly task: CostRollup;
  /** Present iff this cost CROSSED into the near-budget band (the observability event was recorded). */
  readonly nearBudget?: NearBudgetRecord;
}

/**
 * The canonical per-agent cost read-model {@link DispatchStore.getAgentCostRollup} returns — the agent's
 * `cost.recorded` totals projected onto the operator-facing shape: summed token counts (input / output /
 * the two prompt-cache buckets / total) and `costUsd` (the summed dollar cost where any was reported,
 * else null — Codex reports no dollars). Derived from the agent-side {@link CostRollup}.
 */
export interface AgentCostRollup {
  readonly agentId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number | null;
}

/** What {@link DispatchStore.recordUsageObserved} returns: the account status + the window bucket iff one was written. */
export interface UsageObservedResult {
  readonly account: UsageAccountStatus;
  readonly bucket?: UsageBucket;
}

/** What {@link DispatchStore.recordSnapshot} returns: the account status + every window bucket it touched. */
export interface SnapshotIngestResult {
  readonly account: UsageAccountStatus;
  readonly buckets: readonly UsageBucket[];
}

/**
 * The headless L4 dispatch store over a single project store (the L4 analogue of L3's
 * {@link import('../worktrees/worktree-store.js').WorktreeStore}). It records the orchestration facts
 * of usage + cost — per-provider-account usage buckets and per-agent/per-task cost rollups — entirely
 * in program-data, never the repo (AC9, Principle 12). A recording event-sources its read-model row in
 * the same transaction as the append (so the log and projection commit atomically), then reads it
 * straight back; plain reads are projections.
 *
 * Opening this alongside the mail / worktree stores on the SAME per-project `store.db` is safe:
 * `node:sqlite` is synchronous/single-threaded so transactions never interleave in-process, and this
 * store owns DIFFERENT scopes (`usage:`/`cost:`) and read-model tables (`usage_buckets`/`usage_accounts`/
 * `cost_rollup`/`cost_near_budget`) than the others.
 */
export interface DispatchStore {
  /** Record one usage observation (append `usage.observed` + fold); returns the account status + bucket. */
  recordUsageObserved(obs: UsageObserved): UsageObservedResult;
  /**
   * Ingest a whole {@link UsageSnapshot} into the buckets (append one `usage.observed` per window + fold,
   * all in one tx). An `available: false` snapshot marks the account headroom `unknown` (AC6) — it never
   * writes a fake 0%. Returns the account status + the touched window buckets.
   */
  recordSnapshot(snapshot: UsageSnapshot): SnapshotIngestResult;
  /** Every known window bucket, in (provider, account, window_kind) order. */
  readBuckets(): readonly UsageBucket[];
  /** Every known provider-account availability status. */
  readAccountStatuses(): readonly UsageAccountStatus[];
  /** The latest known window bucket for `(provider, account, window_kind)`, or undefined. */
  getBucket(provider: Provider, account: string, windowKind: string): UsageBucket | undefined;
  /** Back-compat account-only lookup; ambiguous account labels should use the provider-aware overload. */
  getBucket(account: string, windowKind: string): UsageBucket | undefined;
  /** The latest availability status for `account`, or undefined (no sample yet). */
  getAccountStatus(provider: Provider, account: string): UsageAccountStatus | undefined;
  /** Back-compat account-only lookup; ambiguous account labels should use the provider-aware overload. */
  getAccountStatus(account: string): UsageAccountStatus | undefined;
  /**
   * The {@link Headroom} for a window as a DISCRIMINATED value (AC6) — `known` with the live reading, or
   * `unknown` with a reason when the account is unavailable / never observed. Never a magic number.
   */
  getHeadroom(provider: Provider, account: string, windowKind: string): Headroom;
  /** Back-compat account-only lookup; ambiguous account labels should use the provider-aware overload. */
  getHeadroom(account: string, windowKind: string): Headroom;
  /**
   * Record a per-turn cost (append `cost.recorded` + fold into the agent AND task rollups). When a
   * `budget` is supplied and this cost CROSSES into the near-budget band, also append + fold a
   * `cost.near_budget` observability event (never a gate). Returns both rollups + any near-budget event.
   */
  recordCost(obs: CostRecorded, budget?: BudgetCap): CostRecordResult;
  /** The rollup total for `(kind, id)`, or undefined. */
  getRollup(kind: CostRollupKind, id: string): CostRollup | undefined;
  /** Every rollup total, in (kind, id) order. */
  readRollups(): readonly CostRollup[];
  /** Every recorded near-budget crossing in seq order; optionally filtered to one task. */
  readNearBudget(task?: string): readonly NearBudgetRecord[];
  /**
   * The canonical per-agent cost read-model for `agentId` — the agent's `cost.recorded` totals projected
   * onto {@link AgentCostRollup}, or null when no cost has been recorded for it. `costUsd` is null when no
   * observation reported a dollar cost (Codex), the summed dollars otherwise.
   */
  getAgentCostRollup(agentId: string): AgentCostRollup | null;
  /**
   * Record one agent tool call (append `tool.invoked` + fold into the durable per-agent tool-usage
   * projection). Returns the updated {@link AgentToolUsage} rollup.
   */
  recordToolInvoked(inv: ToolInvoked): AgentToolUsage;
  /** The canonical per-agent tool-usage read-model for `agentId`, or null when no tool call recorded. */
  getAgentToolUsage(agentId: string): AgentToolUsage | null;
  /** Record a placement decision (append `placement.decided` + fold); returns the stored record. */
  recordPlacement(agent: string, payload: PlacementDecided): PlacementRecord;
  /** Record a placement decision and its review request atomically. */
  recordPlacementWithReviewRequest(
    agent: string,
    payload: PlacementDecided,
    request: ReviewRequested,
  ): { readonly placement: PlacementRecord; readonly request: ReviewRequestRecord };
  /** All recorded placement decisions in seq order; optionally filtered to one agent. */
  readPlacements(agent?: string): readonly PlacementRecord[];
  /** Close the underlying project store. */
  close(): void;
}

/**
 * Open the project dispatch store: open the PROJECT store, wire the {@link UsageProjector} +
 * {@link CostProjector}, and return the {@link DispatchStore} facade. Mirrors `openWorktreeStore`.
 */
export function openDispatchStore(projectId: string): DispatchStore {
  const store = openProjectStore(projectId);
  const projectors: readonly Projector[] = [
    new UsageProjector(),
    new CostProjector(),
    new PlacementProjector(),
    new ToolUsageProjector(),
  ];
  const reviewProjectors: readonly Projector[] = [new ReviewProjector()];

  /** Ensure all read-model table sets exist before a read/record path touches them. */
  const ensureTables = (db: DatabaseSync): void => {
    ensureUsageTables(db);
    ensureCostTables(db);
    ensurePlacementTable(db);
    ensureToolUsageTables(db);
  };

  const applyStored = (
    tx: Parameters<typeof applyEvent>[0],
    event: Parameters<typeof decode>[0],
  ) => {
    if (projectors.some((projector) => projector.handles(event.type))) {
      applyEvent(tx, decode(event, dispatchUpcasters, dispatchSchemas), projectors);
      return;
    }
    applyEvent(tx, decode(event, reviewUpcasters, reviewSchemas), reviewProjectors);
  };

  return {
    recordUsageObserved(obs: UsageObserved): UsageObservedResult {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureTables(db);
        const [stored] = tx.append([makeUsageObservedEvent(projectId, obs)]);
        applyEvent(tx, decode(stored!, dispatchUpcasters, dispatchSchemas), projectors);
        const account = selectUsageAccount(db, obs.provider, obs.account);
        if (!account) {
          throw new Error(
            `openDispatchStore.recordUsageObserved: account row missing after projection ` +
              `(account='${obs.account}')`,
          );
        }
        const bucket =
          obs.available && obs.window_kind !== undefined
            ? selectUsageBucket(db, obs.provider, obs.account, obs.window_kind)
            : undefined;
        return bucket ? { account, bucket } : { account };
      });
    },

    recordSnapshot(snapshot: UsageSnapshot): SnapshotIngestResult {
      const events = snapshotToObservedEvents(projectId, snapshot);
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureTables(db);
        const stored = tx.append(events);
        for (const event of stored) {
          applyEvent(tx, decode(event, dispatchUpcasters, dispatchSchemas), projectors);
        }
        const account = selectUsageAccount(db, snapshot.provider, snapshot.account);
        if (!account) {
          throw new Error(
            `openDispatchStore.recordSnapshot: account row missing after projection ` +
              `(account='${snapshot.account}')`,
          );
        }
        const touchedWindowKinds = new Set(snapshot.windows.map((w) => w.kind));
        const buckets =
          touchedWindowKinds.size > 0
            ? selectAllUsageBuckets(db).filter(
                (b) =>
                  b.provider === snapshot.provider &&
                  b.account === snapshot.account &&
                  touchedWindowKinds.has(b.windowKind),
              )
            : [];
        return { account, buckets };
      });
    },

    readBuckets(): readonly UsageBucket[] {
      return store.transaction((tx) => selectAllUsageBuckets(tx.raw as DatabaseSync));
    },

    readAccountStatuses(): readonly UsageAccountStatus[] {
      return store.transaction((tx) => selectAllUsageAccounts(tx.raw as DatabaseSync));
    },

    getBucket(
      providerOrAccount: Provider | string,
      accountOrWindowKind: string,
      maybeWindowKind?: string,
    ): UsageBucket | undefined {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        if (maybeWindowKind !== undefined) {
          return selectUsageBucket(
            db,
            providerOrAccount as Provider,
            accountOrWindowKind,
            maybeWindowKind,
          );
        }
        const account = String(providerOrAccount);
        assertAccountOnlyUnambiguous(
          'bucket',
          account,
          selectAllUsageBuckets(db)
            .filter((b) => b.account === account)
            .map((b) => ({ provider: b.provider })),
        );
        return singleAccountOnlyMatch(
          'bucket',
          account,
          selectAllUsageBuckets(db).filter(
            (b) => b.account === providerOrAccount && b.windowKind === accountOrWindowKind,
          ),
        );
      });
    },

    getAccountStatus(
      providerOrAccount: Provider | string,
      maybeAccount?: string,
    ): UsageAccountStatus | undefined {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        if (maybeAccount !== undefined) {
          return selectUsageAccount(db, providerOrAccount as Provider, maybeAccount);
        }
        return singleAccountOnlyMatch(
          'account status',
          String(providerOrAccount),
          selectAllUsageAccounts(db).filter((a) => a.account === providerOrAccount),
        );
      });
    },

    getHeadroom(
      providerOrAccount: Provider | string,
      accountOrWindowKind: string,
      maybeWindowKind?: string,
    ): Headroom {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        if (maybeWindowKind !== undefined) {
          const provider = providerOrAccount as Provider;
          const account = accountOrWindowKind;
          return deriveHeadroom(
            selectUsageAccount(db, provider, account),
            selectUsageBucket(db, provider, account, maybeWindowKind),
          );
        }
        const account = providerOrAccount;
        const windowKind = accountOrWindowKind;
        assertAccountOnlyUnambiguous(
          'headroom',
          String(account),
          [
            ...selectAllUsageAccounts(db).filter((a) => a.account === account),
            ...selectAllUsageBuckets(db).filter((b) => b.account === account),
          ].map((row) => ({ provider: row.provider })),
        );
        const accountStatus = singleAccountOnlyMatch(
          'account status',
          String(account),
          selectAllUsageAccounts(db).filter((a) => a.account === account),
        );
        const bucket = singleAccountOnlyMatch(
          'bucket',
          String(account),
          selectAllUsageBuckets(db).filter(
            (b) => b.account === account && b.windowKind === windowKind,
          ),
        );
        return deriveHeadroom(accountStatus, bucket);
      });
    },

    recordCost(obs: CostRecorded, budget?: BudgetCap): CostRecordResult {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureTables(db);
        // Capture the task rollup BEFORE the fold so the near-budget edge trigger can fire exactly once.
        const before = budget ? selectCostRollup(db, 'task', obs.task) : undefined;

        const [stored] = tx.append([makeCostRecordedEvent(projectId, obs)]);
        applyEvent(tx, decode(stored!, dispatchUpcasters, dispatchSchemas), projectors);

        const agent = selectCostRollup(db, 'agent', obs.agent);
        const task = selectCostRollup(db, 'task', obs.task);
        if (!agent || !task) {
          throw new Error(
            `openDispatchStore.recordCost: rollup row missing after projection ` +
              `(agent='${obs.agent}', task='${obs.task}')`,
          );
        }

        let nearBudget: NearBudgetRecord | undefined;
        if (budget) {
          const thresholdPct = budget.thresholdPct ?? NEAR_BUDGET_THRESHOLD_PCT_DEFAULT;
          const beforeTotal = { totalCostUsd: before?.totalCostUsd ?? 0 };
          if (crossesNearBudget(beforeTotal, task, budget.capCents, thresholdPct)) {
            const [nb] = tx.append([
              makeCostNearBudgetEvent(projectId, {
                task: obs.task,
                agent: obs.agent,
                provider: obs.provider,
                total_cost_usd: task.totalCostUsd,
                cap_cents: budget.capCents,
                threshold_pct: thresholdPct,
              }),
            ]);
            applyEvent(tx, decode(nb!, dispatchUpcasters, dispatchSchemas), projectors);
            nearBudget = selectNearBudgetBySeq(db, nb!.seq);
          }
        }

        return nearBudget ? { agent, task, nearBudget } : { agent, task };
      });
    },

    getRollup(kind: CostRollupKind, id: string): CostRollup | undefined {
      return store.transaction((tx) => selectCostRollup(tx.raw as DatabaseSync, kind, id));
    },

    readRollups(): readonly CostRollup[] {
      return store.transaction((tx) => selectAllCostRollups(tx.raw as DatabaseSync));
    },

    readNearBudget(task?: string): readonly NearBudgetRecord[] {
      return store.transaction((tx) => selectNearBudgetEvents(tx.raw as DatabaseSync, task));
    },

    getAgentCostRollup(agentId: string): AgentCostRollup | null {
      return store.transaction((tx) => {
        const rollup = selectCostRollup(tx.raw as DatabaseSync, 'agent', agentId);
        return rollup ? toAgentCostRollup(rollup) : null;
      });
    },

    recordToolInvoked(inv: ToolInvoked): AgentToolUsage {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureTables(db);
        const [stored] = tx.append([makeToolInvokedEvent(projectId, inv)]);
        applyEvent(tx, decode(stored!, dispatchUpcasters, dispatchSchemas), projectors);
        const usage = selectAgentToolUsage(db, inv.agent);
        if (!usage) {
          throw new Error(
            `openDispatchStore.recordToolInvoked: tool-usage row missing after projection ` +
              `(agent='${inv.agent}', tool='${inv.tool}')`,
          );
        }
        return usage;
      });
    },

    getAgentToolUsage(agentId: string): AgentToolUsage | null {
      return store.transaction(
        (tx) => selectAgentToolUsage(tx.raw as DatabaseSync, agentId) ?? null,
      );
    },

    recordPlacement(agent: string, payload: PlacementDecided): PlacementRecord {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureTables(db);
        const [stored] = tx.append([makePlacementDecidedEvent(projectId, agent, payload)]);
        applyEvent(tx, decode(stored!, dispatchUpcasters, dispatchSchemas), projectors);
        const record = selectPlacementBySeq(db, stored!.seq);
        if (!record) {
          throw new Error(
            `openDispatchStore.recordPlacement: placement row missing after projection ` +
              `(agent='${agent}', kind='${payload.kind}')`,
          );
        }
        return record;
      });
    },

    recordPlacementWithReviewRequest(
      agent: string,
      payload: PlacementDecided,
      request: ReviewRequested,
    ): { readonly placement: PlacementRecord; readonly request: ReviewRequestRecord } {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureTables(db);
        ensureReviewTables(db);
        const stored = tx.append([
          makePlacementDecidedEvent(projectId, agent, payload),
          makeReviewRequestedEvent(projectId, request),
        ]);
        for (const event of stored) applyStored(tx, event);
        const placement = selectPlacementBySeq(db, stored[0]!.seq);
        if (!placement) {
          throw new Error(
            `openDispatchStore.recordPlacementWithReviewRequest: placement row missing after ` +
              `projection (agent='${agent}', kind='${payload.kind}')`,
          );
        }
        const record = selectReviewRequest(db, request.target, request.branch);
        if (!record) {
          throw new Error(
            `openDispatchStore.recordPlacementWithReviewRequest: review request row missing after ` +
              `projection (target='${request.target}', branch='${request.branch}')`,
          );
        }
        return { placement, request: record };
      });
    },

    readPlacements(agent?: string): readonly PlacementRecord[] {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        return agent !== undefined ? selectPlacementsByAgent(db, agent) : selectAllPlacements(db);
      });
    },

    close(): void {
      store.close();
    },
  };
}

/**
 * Project an agent-side {@link CostRollup} onto the canonical {@link AgentCostRollup}. `costUsd` is null
 * when NO observation reported a dollar cost (`costUsdObservations === 0` — Codex never does), the summed
 * dollars otherwise, so a genuine $0 (a dollar-reporting provider that happened to bill nothing) is
 * distinguishable from "no dollar cost reported".
 */
function toAgentCostRollup(rollup: CostRollup): AgentCostRollup {
  return {
    agentId: rollup.id,
    inputTokens: rollup.inputTokens,
    outputTokens: rollup.outputTokens,
    cacheReadTokens: rollup.cacheReadTokens,
    cacheCreationTokens: rollup.cacheCreationTokens,
    totalTokens: rollup.totalTokens,
    costUsd: rollup.costUsdObservations > 0 ? rollup.totalCostUsd : null,
  };
}

function singleAccountOnlyMatch<T extends { readonly provider: Provider }>(
  kind: string,
  account: string,
  matches: readonly T[],
): T | undefined {
  assertAccountOnlyUnambiguous(kind, account, matches);
  return matches[0];
}

function assertAccountOnlyUnambiguous<T extends { readonly provider: Provider }>(
  kind: string,
  account: string,
  matches: readonly T[],
): void {
  if (new Set(matches.map((m) => m.provider)).size <= 1) return;
  const providers = [...new Set(matches.map((m) => m.provider))].sort().join(', ');
  throw new Error(
    `openDispatchStore: ambiguous account-only ${kind} lookup for account '${account}' matched providers: ${providers}; use the provider-aware overload`,
  );
}

/**
 * Lower an injected {@link UsageSnapshot} into the `usage.observed` events that ingest it: one AVAILABLE
 * event per window (or a single windowless available marker when a reachable account reports no
 * windows), or one UNAVAILABLE event marking the account headroom `unknown` (AC6). The unavailable
 * reason is synthesised from the source — the frozen snapshot carries no reason field, only `available`.
 */
function snapshotToObservedEvents(projectId: string, snapshot: UsageSnapshot) {
  const { provider, account, source, sampled_at } = snapshot;
  if (!snapshot.available) {
    const unavailable: UsageObserved = {
      available: false,
      provider,
      account,
      reason: `usage source '${source}' reported account '${account}' unavailable`,
      source,
      sampled_at,
    };
    if (snapshot.windows.length === 0) {
      return [makeUsageObservedEvent(projectId, unavailable)];
    }
    const clear: UsageObserved = { available: true, provider, account, source, sampled_at };
    return [
      makeUsageObservedEvent(projectId, clear),
      ...snapshot.windows.map((w) =>
        makeUsageObservedEvent(projectId, {
          available: true,
          provider,
          account,
          window_kind: w.kind,
          used_pct: w.used_pct,
          reset_at: w.reset_at,
          source,
          sampled_at,
        }),
      ),
      makeUsageObservedEvent(projectId, unavailable),
    ];
  }
  if (snapshot.windows.length === 0) {
    const obs: UsageObserved = { available: true, provider, account, source, sampled_at };
    return [makeUsageObservedEvent(projectId, obs)];
  }
  const clear: UsageObserved = { available: true, provider, account, source, sampled_at };
  return [
    makeUsageObservedEvent(projectId, clear),
    ...snapshot.windows.map((w) =>
      makeUsageObservedEvent(projectId, {
        available: true,
        provider,
        account,
        window_kind: w.kind,
        used_pct: w.used_pct,
        reset_at: w.reset_at,
        source,
        sampled_at,
      }),
    ),
  ];
}

/**
 * Read the budget cap (in cents) from the L0 config cascade for `projectId` — the resolved
 * `cost_budget_cents` (global ⊕ project-override, project wins), or undefined when none is configured.
 * A configured-but-malformed value throws fail-loud (P9) instead of silently disabling budget
 * observability. Reads program-data ONLY (never the repo). `config` is injectable for headless tests; the
 * default opens + closes a config store internally (mirrors `resolveRepoMode`).
 */
export function resolveBudgetCapCents(projectId: string, config?: ConfigStore): number | undefined {
  const cfg = config ?? openConfigStore();
  const ownsConfig = config === undefined;
  try {
    const raw = cfg.resolveEffective(projectId)[COST_BUDGET_CENTS_KEY];
    if (raw === undefined) return undefined;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
      throw new Error(
        `co dispatch: malformed '${COST_BUDGET_CENTS_KEY}' config: expected a non-negative finite number`,
      );
    }
    return raw;
  } finally {
    if (ownsConfig) cfg.close();
  }
}

/**
 * Resolve the full {@link BudgetCap} from the config cascade — the cap in cents plus a threshold
 * (default {@link NEAR_BUDGET_THRESHOLD_PCT_DEFAULT}) — or undefined when no cap is configured. The
 * convenience a caller passes straight to {@link DispatchStore.recordCost}.
 */
export function resolveBudgetCap(
  projectId: string,
  opts?: { config?: ConfigStore; thresholdPct?: number },
): BudgetCap | undefined {
  const capCents = resolveBudgetCapCents(projectId, opts?.config);
  if (capCents === undefined) return undefined;
  if (
    opts?.thresholdPct !== undefined &&
    (!Number.isFinite(opts.thresholdPct) || opts.thresholdPct < 0 || opts.thresholdPct > 100)
  ) {
    throw new Error(
      `co dispatch: malformed near-budget threshold: expected a finite percentage between 0 and 100`,
    );
  }
  return opts?.thresholdPct !== undefined
    ? { capCents, thresholdPct: opts.thresholdPct }
    : { capCents };
}

/**
 * Read a provider's usage through an injected {@link ProviderUsageSource} and ingest it, FAIL-LOUD
 * (AC6, Principle 9). On a thrown read or an `available: false` snapshot it raises a typed
 * {@link UsageUnavailableError} (carrying the user-facing {@link import('./usage-source.js').USAGE_UNAVAILABLE_CODE}),
 * AND the ingest leaves the account headroom `unknown` — never silently healthy, never 0%. On success
 * the snapshot is recorded and returned.
 *
 * This is the single-source read seam; Phase 6 layers source ordering (statusLine → sqlite → …) on top.
 * It honours AC11 by construction: it only READS through the passive source and records — it never runs
 * inference.
 */
export async function observeUsage(
  source: ProviderUsageSource,
  provider: Provider,
  store: DispatchStore,
  options: { readonly expectedAccount?: string; readonly nowMs?: number } = {},
): Promise<UsageSnapshot> {
  let snapshot: UsageSnapshot;
  try {
    snapshot = await source.read(provider);
  } catch (cause) {
    if (cause instanceof UsageUnavailableError) {
      const account = cause.account ?? options.expectedAccount;
      if (account !== undefined) {
        markAccountUnavailable(store, provider, account, cause.message, options.nowMs);
      }
      throw cause;
    }
    const err = new UsageUnavailableError(
      provider,
      `usage source read failed: ${errorMessage(cause)}`,
      {
        cause,
      },
    );
    if (options.expectedAccount !== undefined) {
      markAccountUnavailable(store, provider, options.expectedAccount, err.message, options.nowMs);
    }
    throw err;
  }
  if (options.expectedAccount !== undefined && snapshot.account !== options.expectedAccount) {
    const reason = `usage source returned account '${snapshot.account}' while '${options.expectedAccount}' was requested`;
    markAccountUnavailable(store, provider, options.expectedAccount, reason, options.nowMs);
    throw new UsageUnavailableError(provider, reason, { account: options.expectedAccount });
  }
  // Record first so headroom is marked unknown for an unavailable snapshot BEFORE we surface the error.
  store.recordSnapshot(snapshot);
  if (!snapshot.available) {
    throw new UsageUnavailableError(
      provider,
      `usage source '${snapshot.source}' reported account '${snapshot.account}' unavailable`,
      { account: snapshot.account },
    );
  }
  return snapshot;
}

function markAccountUnavailable(
  store: DispatchStore,
  provider: Provider,
  account: string,
  reason: string,
  nowMs: number | undefined,
): void {
  store.recordUsageObserved({
    available: false,
    provider,
    account,
    reason,
    source: 'usage-source',
    sampled_at: new Date(nowMs ?? Date.now()).toISOString(),
  });
}

/** Best-effort message extraction from an unknown thrown value (no `String(err)` `[object Object]`). */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
