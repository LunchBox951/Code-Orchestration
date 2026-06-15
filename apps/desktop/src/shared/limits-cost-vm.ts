import { deriveHeadroom } from '@co/core';
import type { CostRollup, Headroom, UsageAccountStatus, UsageBucket } from '@co/core';

export type { Headroom };

export interface HeadroomRow {
  readonly provider: string;
  readonly account: string;
  readonly windowKind: string;
  readonly headroom: Headroom;
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

  const headroomRows: HeadroomRow[] = inputs.buckets.map((bucket) => ({
    provider: bucket.provider,
    account: bucket.account,
    windowKind: bucket.windowKind,
    headroom: deriveHeadroom(statusMap.get(`${bucket.provider}:${bucket.account}`), bucket),
  }));

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
