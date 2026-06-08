import { openDispatchStore, type DispatchStore } from './dispatch-store.js';
import { candidatesFromStore, placeAgent, resolvePinTable } from './balancer.js';
import type { ProviderAccount } from './balancer.js';
import { resolveDispatch } from './throttle.js';
import type { DispatchDiagnostic, DispatchResolution } from './throttle.js';
import type { WorkSize, ReasoningBudget } from './tier.js';
import { accountForProvider, readProviderUsageCached } from './provider-source.js';
import type { CachedUsageReadOptions } from './provider-source.js';
import {
  USAGE_UNAVAILABLE_CODE,
  UsageUnavailableError,
  type Provider,
  type ProviderUsageSource,
} from './usage-source.js';

// ── Usage report ─────────────────────────────────────────────────────────────────────────────────

/**
 * Render a human-readable usage report for `projectId` — all known provider-account usage buckets
 * with their headroom and reset times. Reads program-data only (never the repo). `store` is
 * injectable for headless tests; defaults to opening + closing one internally. CLI only (P3 —
 * render-per-audience; the rich app view is L9). AC8: never agent-facing.
 */
export function renderUsageReport(projectId: string, store?: DispatchStore): string {
  const ds = store ?? openDispatchStore(projectId);
  const ownsStore = store === undefined;
  try {
    const buckets = ds.readBuckets();
    const statuses = ds.readAccountStatuses();
    if (buckets.length === 0 && statuses.length === 0) {
      return 'co usage: no usage data recorded for this project.\n';
    }
    const lines: string[] = ['co usage report', '═══════════════'];
    for (const status of statuses) {
      if (status.available) continue;
      lines.push(
        `  ${status.provider}/${status.account}  unavailable  ${status.reason ?? 'usage source unavailable'}`,
      );
    }
    for (const status of statuses) {
      if (!status.available) continue;
      const hasBucket = buckets.some(
        (b) => b.provider === status.provider && b.account === status.account,
      );
      if (hasBucket) continue;
      lines.push(`  ${status.provider}/${status.account}  unknown  no window data recorded`);
    }
    for (const b of buckets) {
      const status = statuses.find((s) => s.provider === b.provider && s.account === b.account);
      if (status !== undefined && !status.available) continue;
      const pct = b.usedPct.toFixed(1);
      const free = (100 - b.usedPct).toFixed(1);
      const resetShort = b.resetAt.replace('T', ' ').replace(/\..+$/, '');
      lines.push(
        `  ${b.provider}/${b.account}  [${b.windowKind}]  ${pct}% used  ${free}% free  reset ${resetShort}`,
      );
    }
    return lines.join('\n') + '\n';
  } finally {
    if (ownsStore) ds.close();
  }
}

// ── Cost report ──────────────────────────────────────────────────────────────────────────────────

/**
 * Render a human-readable cost report for `projectId` — per-agent and per-task rollups, plus any
 * recorded near-budget crossings. Reads program-data only. `store` is injectable for headless
 * tests. AC8: never agent-facing; the rich app view is L9.
 */
export function renderCostReport(projectId: string, store?: DispatchStore): string {
  const ds = store ?? openDispatchStore(projectId);
  const ownsStore = store === undefined;
  try {
    const rollups = ds.readRollups();
    const nearBudget = ds.readNearBudget();

    if (rollups.length === 0 && nearBudget.length === 0) {
      return 'co cost: no cost data recorded for this project.\n';
    }

    const lines: string[] = ['co cost report', '══════════════'];
    if (rollups.length > 0) {
      lines.push('', 'Rollups:');
      for (const r of rollups) {
        const cost = r.costUsdObservations > 0 ? `  $${r.totalCostUsd.toFixed(4)}` : '';
        const tokens = r.tokenObservations > 0 ? `  ${r.totalTokens} tokens` : '';
        const usagePct = r.usedPctObservations > 0 ? `  ${r.usedPct.toFixed(1)} usage%` : '';
        lines.push(`  [${r.kind}] ${r.id}  obs=${r.observations}${cost}${tokens}${usagePct}`);
      }
    }
    if (nearBudget.length > 0) {
      lines.push('', 'Near-budget crossings (observability only — never a gate):');
      for (const nb of nearBudget) {
        const capUsd = (nb.capCents / 100).toFixed(2);
        lines.push(
          `  task=${nb.task}  $${nb.totalCostUsd.toFixed(4)} of $${capUsd} cap ` +
            `(${nb.thresholdPct}% threshold crossed)`,
        );
      }
    }
    return lines.join('\n') + '\n';
  } finally {
    if (ownsStore) ds.close();
  }
}

// ── Placement preview ────────────────────────────────────────────────────────────────────────────

export interface PreviewPlacementInput {
  readonly projectId: string;
  readonly agent?: string;
  readonly role: string;
  readonly workSize: WorkSize;
  readonly reasoningBudget: ReasoningBudget;
  readonly accounts: readonly ProviderAccount[];
  readonly nowMs: number;
  /** Injectable for headless tests (avoids opening a second store connection). */
  readonly store?: DispatchStore;
}

/** Host-provided factory for passive provider usage reads. */
export type UsageSourceFactory = (account: ProviderAccount) => ProviderUsageSource;

export interface RefreshUsageInput {
  readonly store: DispatchStore;
  readonly accounts: readonly ProviderAccount[];
  readonly usageSourceFactory: UsageSourceFactory;
  readonly nowMs: number;
}

export type UsageRefreshDiagnostic = DispatchDiagnostic;

/**
 * Refresh the usage buckets needed for dispatch, through the cached passive/live source seam. A fresh
 * program-data cache returns without live I/O; stale/missing buckets read the source and record the
 * resulting snapshot. A thrown source marks that exact provider/account unavailable so placement sees
 * loud unknown headroom instead of fabricating healthy capacity.
 */
export async function refreshUsageForAccounts(
  input: RefreshUsageInput,
): Promise<readonly UsageRefreshDiagnostic[]> {
  const seen = new Set<string>();
  const diagnostics: UsageRefreshDiagnostic[] = [];
  for (const account of input.accounts) {
    const key = `${account.provider}\0${account.account}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const options: CachedUsageReadOptions = {
      account: account.account,
      nowMs: input.nowMs,
    };
    try {
      await readProviderUsageCached(
        input.usageSourceFactory(account),
        account.provider,
        input.store,
        options,
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const code = cause instanceof UsageUnavailableError ? cause.code : USAGE_UNAVAILABLE_CODE;
      diagnostics.push({
        provider: account.provider,
        account: account.account,
        code,
        reason: message,
      });
    }
  }
  return diagnostics;
}

function withDiagnostics(
  resolution: DispatchResolution,
  diagnostics: readonly DispatchDiagnostic[],
): DispatchResolution {
  if (diagnostics.length === 0) return resolution;
  const relevantDiagnostics =
    resolution.kind === 'waiting'
      ? filterBlockingDiagnostics(resolution, diagnostics)
      : diagnostics;
  if (relevantDiagnostics.length === 0) return resolution;
  const refreshKeys = new Set(relevantDiagnostics.map((d) => `${d.provider}\0${d.code}`));
  const combined = [
    ...(resolution.diagnostics ?? []).filter((d) => !refreshKeys.has(`${d.provider}\0${d.code}`)),
    ...relevantDiagnostics,
  ];
  if (resolution.kind === 'waiting') {
    const diagnosticProviders = uniqueProviders(combined);
    const diagnosticAccounts = uniqueAccounts(combined);
    return {
      ...resolution,
      message: usageUnavailableMessage(resolution.etaResetAt, combined),
      unavailableProviders: uniqueProviderList([
        ...resolution.unavailableProviders,
        ...diagnosticProviders,
      ]),
      unavailableAccounts: uniqueStringList([
        ...resolution.unavailableAccounts,
        ...diagnosticAccounts,
      ]),
      diagnostics: combined,
    };
  }
  return { ...resolution, diagnostics: combined };
}

function filterBlockingDiagnostics(
  resolution: Extract<DispatchResolution, { readonly kind: 'waiting' }>,
  diagnostics: readonly DispatchDiagnostic[],
): readonly DispatchDiagnostic[] {
  const blockingProviders = new Set([
    ...resolution.maxedProviders,
    ...resolution.unavailableProviders,
  ]);
  return diagnostics.filter((d) => blockingProviders.has(d.provider));
}

function usageUnavailableMessage(
  etaResetAt: string | undefined,
  diagnostics: readonly DispatchDiagnostic[],
): string {
  const eta =
    etaResetAt !== undefined ? `delayed until ${etaResetAt}` : 'delayed — reset ETA unknown';
  const detail = diagnostics.map((d) => `${d.provider}: ${d.reason}`).join('; ');
  return `${eta} — usage source unavailable (${detail})`;
}

function previousPlacement(store: DispatchStore, role: string, agent: string | undefined) {
  if (agent === undefined) return undefined;
  const previous = [...store.readPlacements(agent)]
    .reverse()
    .find((p) => p.kind === 'placed' && p.role === role);
  if (!previous || !previous.provider || !previous.model || !previous.effort || !previous.context) {
    return undefined;
  }
  return {
    role: previous.role,
    provider: previous.provider as Provider,
    account: previous.account ?? accountForProvider(previous.provider as Provider),
    model: previous.model,
    effort: previous.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
    context: previous.context as 'standard' | 'extended',
  };
}

/**
 * The shared dispatch-policy resolver: `resolvePinTable → candidatesFromStore → placeAgent →
 * resolveDispatch`. Called from both the record path (`co_sling` handler) and preview paths so the two
 * never drift. Pure over the injected store + inputs; side effects stay at the CALL SITES
 * (`co_sling` records `placement.decided`, while CLI dry-run may refresh program-data usage cache before
 * calling this). AC10/P16.
 */
export function runDispatchPolicy(
  store: DispatchStore,
  projectId: string,
  role: string,
  workSize: WorkSize,
  reasoningBudget: ReasoningBudget,
  accounts: readonly ProviderAccount[],
  nowMs: number,
  agent?: string,
): DispatchResolution {
  const pins = resolvePinTable(projectId);
  const candidates = candidatesFromStore(store, accounts, { nowMs });
  const decision = placeAgent({
    role,
    workSize,
    reasoningBudget,
    pins,
    candidates,
    nowMs,
    previous: previousPlacement(store, role, agent),
  });
  return resolveDispatch(decision, candidates, { nowMs });
}

/**
 * Preview where a dispatch WOULD land for the given inputs — purely read-only: resolves the same policy
 * as `co_sling` with routing inputs but writes NOTHING (no `placement.decided` event, no worktree, no
 * side-effects). The CLI dry-run wrapper may refresh program-data usage cache first, then calls this
 * read-only resolver. Injectable `store` for headless tests; defaults to opening + closing one internally.
 * AC9/P12: repo-pristine.
 */
export function previewPlacement(input: PreviewPlacementInput): DispatchResolution {
  const { projectId, agent, role, workSize, reasoningBudget, accounts, nowMs } = input;
  const ds = input.store ?? openDispatchStore(projectId);
  const ownsStore = input.store === undefined;
  try {
    return runDispatchPolicy(
      ds,
      projectId,
      role,
      workSize,
      reasoningBudget,
      accounts,
      nowMs,
      agent,
    );
  } finally {
    if (ownsStore) ds.close();
  }
}

export async function previewPlacementWithUsage(
  input: PreviewPlacementInput & { readonly usageSourceFactory: UsageSourceFactory },
): Promise<DispatchResolution> {
  const { projectId, agent, role, workSize, reasoningBudget, accounts, nowMs } = input;
  const ds = input.store ?? openDispatchStore(projectId);
  const ownsStore = input.store === undefined;
  try {
    const diagnostics = await refreshUsageForAccounts({
      store: ds,
      accounts,
      usageSourceFactory: input.usageSourceFactory,
      nowMs,
    });
    return withDiagnostics(
      runDispatchPolicy(ds, projectId, role, workSize, reasoningBudget, accounts, nowMs, agent),
      diagnostics,
    );
  } finally {
    if (ownsStore) ds.close();
  }
}

/**
 * Render a `DispatchResolution` as operator-readable text — the output of `co sling --dry-run`.
 * Pure text; the rich interactive display is L9. P3: render-per-audience.
 */
export function renderDispatchResolution(resolution: DispatchResolution): string {
  if (resolution.kind === 'placed') {
    const p = resolution.placement;
    return (
      `co sling --dry-run: PLACED\n` +
      `  provider=${p.provider}  account=${p.account}  model=${p.model}  effort=${p.effort}  context=${p.context}\n` +
      renderDiagnostics(resolution.diagnostics) +
      `  reason: ${resolution.reason}\n`
    );
  }
  // waiting
  const eta =
    resolution.etaResetAt !== undefined
      ? `  eta_reset_at=${resolution.etaResetAt}\n`
      : '  eta_reset_at=(unknown)\n';
  const unavailableProviders = uniqueProviderList([
    ...resolution.unavailableProviders,
    ...uniqueProviders(resolution.diagnostics),
  ]);
  const unavailableAccounts = uniqueStringList([
    ...resolution.unavailableAccounts,
    ...uniqueAccounts(resolution.diagnostics),
  ]);
  const unavailable =
    unavailableProviders.length > 0
      ? `  unavailable_providers=${unavailableProviders.join(', ')}\n`
      : '';
  const unavailableAccountLine =
    unavailableAccounts.length > 0
      ? `  unavailable_accounts=${unavailableAccounts.join(', ')}\n`
      : '';
  const maxedProviders = resolution.maxedProviders.filter((p) => !unavailableProviders.includes(p));
  const maxedAccounts = resolution.maxedAccounts.filter((a) => !unavailableAccounts.includes(a));
  const maxed = maxedProviders.length > 0 ? `  maxed_providers=${maxedProviders.join(', ')}\n` : '';
  const maxedAccountLine =
    maxedAccounts.length > 0 ? `  maxed_accounts=${maxedAccounts.join(', ')}\n` : '';
  return (
    `co sling --dry-run: WAITING\n` +
    `  ${resolution.message}\n` +
    eta +
    unavailable +
    unavailableAccountLine +
    maxed +
    maxedAccountLine +
    renderDiagnostics(resolution.diagnostics) +
    `  reason: ${resolution.reason}\n`
  );
}

function uniqueProviders(diagnostics: readonly DispatchDiagnostic[] | undefined): Provider[] {
  if (diagnostics === undefined) return [];
  return uniqueProviderList(diagnostics.map((d) => d.provider));
}

function uniqueAccounts(diagnostics: readonly DispatchDiagnostic[] | undefined): string[] {
  if (diagnostics === undefined) return [];
  return uniqueStringList(diagnostics.flatMap((d) => (d.account === undefined ? [] : [d.account])));
}

function uniqueProviderList(providers: readonly Provider[]): Provider[] {
  return [...new Set(providers)];
}

function uniqueStringList(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function renderDiagnostics(diagnostics: readonly DispatchDiagnostic[] | undefined): string {
  if (diagnostics === undefined || diagnostics.length === 0) return '';
  return diagnostics
    .map(
      (d) =>
        `  warning: ${d.code} provider=${d.provider}` +
        `${d.account !== undefined ? ` account=${d.account}` : ''} ${d.reason}\n`,
    )
    .join('');
}
