import { openDispatchStore, type DispatchStore } from './dispatch-store.js';
import { candidatesFromStore, placeAgent, resolvePinTable } from './balancer.js';
import type { ProviderAccount } from './balancer.js';
import { resolveDispatch } from './throttle.js';
import type { DispatchResolution } from './throttle.js';
import type { WorkSize, ReasoningBudget } from './tier.js';

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
    if (buckets.length === 0) {
      return 'co usage: no usage data recorded for this project.\n';
    }
    const lines: string[] = ['co usage report', '═══════════════'];
    for (const b of buckets) {
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
        const cost = r.totalCostUsd > 0 ? `  $${r.totalCostUsd.toFixed(4)}` : '';
        const tokens = r.totalTokens > 0 ? `  ${r.totalTokens} tokens` : '';
        lines.push(`  [${r.kind}] ${r.id}  obs=${r.observations}${cost}${tokens}`);
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
  readonly role: string;
  readonly workSize: WorkSize;
  readonly reasoningBudget: ReasoningBudget;
  readonly accounts: readonly ProviderAccount[];
  readonly nowMs: number;
  /** Injectable for headless tests (avoids opening a second store connection). */
  readonly store?: DispatchStore;
}

/**
 * The shared dispatch-policy resolver: `resolvePinTable → candidatesFromStore → placeAgent →
 * resolveDispatch`. Called from both the record path (`co_sling` handler) and the read-only
 * preview path (`previewPlacement`/`co sling --dry-run`) so the two never drift. Pure over
 * the injected store + inputs; the write vs. read-only distinction stays at the CALL SITES
 * (only `co_sling` records `placement.decided`; preview writes nothing). AC10/P16.
 */
export function runDispatchPolicy(
  store: DispatchStore,
  projectId: string,
  role: string,
  workSize: WorkSize,
  reasoningBudget: ReasoningBudget,
  accounts: readonly ProviderAccount[],
  nowMs: number,
): DispatchResolution {
  const pins = resolvePinTable(projectId);
  const candidates = candidatesFromStore(store, accounts);
  const decision = placeAgent({ role, workSize, reasoningBudget, pins, candidates, nowMs });
  return resolveDispatch(decision, candidates, { nowMs });
}

/**
 * Preview where a dispatch WOULD land for the given inputs — purely read-only: resolves the same
 * policy as `co_sling` with routing inputs but writes NOTHING (no `placement.decided` event, no
 * worktree, no side-effects). This is the operator's dry-run preview (spec §E, AC8). Injectable
 * `store` for headless tests; defaults to opening + closing one internally. AC9/P12: repo-pristine.
 */
export function previewPlacement(input: PreviewPlacementInput): DispatchResolution {
  const { projectId, role, workSize, reasoningBudget, accounts, nowMs } = input;
  const ds = input.store ?? openDispatchStore(projectId);
  const ownsStore = input.store === undefined;
  try {
    return runDispatchPolicy(ds, projectId, role, workSize, reasoningBudget, accounts, nowMs);
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
      `  provider=${p.provider}  model=${p.model}  effort=${p.effort}  context=${p.context}\n` +
      `  reason: ${resolution.reason}\n`
    );
  }
  // waiting
  const eta =
    resolution.etaResetAt !== undefined
      ? `  eta_reset_at=${resolution.etaResetAt}\n`
      : '  eta_reset_at=(unknown)\n';
  const maxed =
    resolution.maxedProviders.length > 0
      ? `  maxed_providers=${resolution.maxedProviders.join(', ')}\n`
      : '';
  return (
    `co sling --dry-run: WAITING\n` +
    `  ${resolution.message}\n` +
    eta +
    maxed +
    `  reason: ${resolution.reason}\n`
  );
}
