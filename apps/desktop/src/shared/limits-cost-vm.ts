import { deriveHeadroom } from '@co/core';
import type { CostRollup, Headroom, UsageAccountStatus, UsageBucket } from '@co/core';

export type { Headroom };

export interface HeadroomRow {
  readonly provider: string;
  readonly account: string;
  readonly windowKind: string;
  /**
   * Human-facing window label, derived from {@link labelWindowKind}. The renderer prints this
   * instead of the raw `windowKind` so a provider's internal keys (Codex `primary`/`secondary`,
   * Claude `five_hour`/`weekly`) all read as `session`/`weekly`. `windowKind` stays as the frozen
   * key for any non-display consumers.
   */
  readonly displayLabel: string;
  readonly headroom: Headroom;
}

/**
 * Map a provider's internal window key to a human-facing label. Codex emits `primary`/`secondary`
 * and Claude emits `five_hour`/`weekly`; both denote the same two windows, so they collapse to a
 * single `session`/`weekly` vocabulary in the UI. The mapping is provider-agnostic (keyed on the
 * canonical kind, not the provider) and NEVER throws — any unrecognized key (Claude can emit
 * verbatim non-canonical keys via `canonicalWindowKind` passthrough) is returned as-is so the UI
 * still shows something rather than crashing. This is a DISPLAY-only concern: `windowKind` in core
 * is a frozen contract (balancer/throttle key on `five_hour`) and must not be renamed there.
 */
export function labelWindowKind(_provider: string, windowKind: string): string {
  switch (windowKind.toLowerCase()) {
    case 'primary':
    case 'five_hour':
    case 'session':
      return 'session';
    case 'secondary':
    case 'weekly':
      return 'weekly';
    default:
      return windowKind;
  }
}

export interface CostRow {
  readonly id: string;
  readonly totalCostUsd: number;
}

export interface LimitsCostState {
  readonly headroomRows: readonly HeadroomRow[];
  readonly agentCosts: readonly CostRow[];
  readonly taskCosts: readonly CostRow[];
}

export interface LimitsCostInputs {
  readonly buckets: readonly UsageBucket[];
  readonly accountStatuses: readonly UsageAccountStatus[];
  readonly rollups: readonly CostRollup[];
}

const EMPTY_STATE: LimitsCostState = { headroomRows: [], agentCosts: [], taskCosts: [] };

function deriveState(inputs: LimitsCostInputs): LimitsCostState {
  const statusMap = new Map<string, UsageAccountStatus>();
  for (const s of inputs.accountStatuses) {
    statusMap.set(`${s.provider}:${s.account}`, s);
  }

  // Rows derive from the UNION of buckets and account statuses. Buckets carry a window, so each
  // yields a row directly. An account that has a STATUS but no bucket yet (e.g. a Claude account
  // that has only ever produced an unavailable read) would otherwise vanish from the UI entirely —
  // instead we synthesize a single `unknown` row so it renders as a visible "no data" card.
  const headroomRows: HeadroomRow[] = inputs.buckets.map((bucket) => ({
    provider: bucket.provider,
    account: bucket.account,
    windowKind: bucket.windowKind,
    displayLabel: labelWindowKind(bucket.provider, bucket.windowKind),
    headroom: deriveHeadroom(statusMap.get(`${bucket.provider}:${bucket.account}`), bucket),
  }));

  const accountsWithBuckets = new Set(inputs.buckets.map((b) => `${b.provider}:${b.account}`));
  for (const status of inputs.accountStatuses) {
    const key = `${status.provider}:${status.account}`;
    if (accountsWithBuckets.has(key)) continue;
    headroomRows.push({
      provider: status.provider,
      account: status.account,
      windowKind: 'unknown',
      displayLabel: labelWindowKind(status.provider, 'unknown'),
      // No bucket for this account → deriveHeadroom yields `unknown` (unavailable reason when the
      // status itself is unavailable, "no usage observed for this window" when available-but-empty).
      headroom: deriveHeadroom(status, undefined),
    });
  }

  const agentCosts: CostRow[] = inputs.rollups
    .filter((r) => r.kind === 'agent')
    .map((r) => ({ id: r.id, totalCostUsd: r.totalCostUsd }))
    .sort((a, b) => b.totalCostUsd - a.totalCostUsd);

  const taskCosts: CostRow[] = inputs.rollups
    .filter((r) => r.kind === 'task')
    .map((r) => ({ id: r.id, totalCostUsd: r.totalCostUsd }))
    .sort((a, b) => b.totalCostUsd - a.totalCostUsd);

  return { headroomRows, agentCosts, taskCosts };
}

export class LimitsCostVM {
  private _state: LimitsCostState = EMPTY_STATE;
  private readonly listeners = new Set<(state: LimitsCostState) => void>();

  get state(): LimitsCostState {
    return this._state;
  }

  update(inputs: LimitsCostInputs): void {
    this._state = deriveState(inputs);
    this.emit();
  }

  subscribe(listener: (state: LimitsCostState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const state = this._state;
    for (const listener of [...this.listeners]) listener(state);
  }
}
