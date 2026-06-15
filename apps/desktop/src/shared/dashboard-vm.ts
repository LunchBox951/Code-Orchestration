import type { OperatorObservation, DeliveredMail, AgentLiveView, AgentRecord } from '@co/core';

export type AgentStatus = 'warm' | 'waiting' | 'stuck' | 'paused' | 'unknown';

export interface TreeNode {
  readonly agentId: string;
  readonly role: string;
  readonly subRole?: string;
  readonly parent: string;
  readonly status: AgentStatus;
  readonly children: readonly TreeNode[];
}

export interface FleetStats {
  readonly total: number;
  readonly warm: number;
  readonly waiting: number;
  readonly stuck: number;
  readonly paused: number;
}

export interface ActionableRow {
  readonly seq: number;
  readonly type: string;
  readonly subject: string;
  readonly sender: string;
  readonly ts: number;
}

export interface DashboardState {
  readonly tree: readonly TreeNode[];
  readonly stats: FleetStats;
  readonly actionables: readonly ActionableRow[];
  readonly connection: 'live' | 'degraded';
}

type AgentEntry = {
  agentId: string;
  role: string;
  subRole?: string;
  parent: string;
};

function deriveStatusLive(a: AgentLiveView): AgentStatus {
  if (a.stuck) return 'stuck';
  if (a.paused) return 'paused';
  if (a.hosted) return 'warm';
  if (a.outstandingMail > 0) return 'waiting';
  return 'unknown';
}

function buildTree(
  agents: ReadonlyArray<AgentEntry>,
  statusMap: ReadonlyMap<string, AgentStatus>,
): readonly TreeNode[] {
  const agentIds = new Set(agents.map((a) => a.agentId));
  const childrenOf = new Map<string, AgentEntry[]>();

  for (const a of agents) {
    let list = childrenOf.get(a.parent);
    if (list == null) {
      list = [];
      childrenOf.set(a.parent, list);
    }
    list.push(a);
  }

  const roots = agents.filter((a) => !agentIds.has(a.parent));

  function buildNode(a: AgentEntry, visited: ReadonlySet<string>): TreeNode {
    if (visited.has(a.agentId)) {
      // Cycle detected — return a leaf to avoid infinite recursion (Principle 9: never throw)
      return {
        agentId: a.agentId,
        role: a.role,
        ...(a.subRole != null ? { subRole: a.subRole } : {}),
        parent: a.parent,
        status: 'unknown',
        children: [],
      };
    }
    const nextVisited = new Set([...visited, a.agentId]);
    const kids = childrenOf.get(a.agentId) ?? [];
    return {
      agentId: a.agentId,
      role: a.role,
      ...(a.subRole != null ? { subRole: a.subRole } : {}),
      parent: a.parent,
      status: statusMap.get(a.agentId) ?? 'unknown',
      children: kids.map((k) => buildNode(k, nextVisited)),
    };
  }

  return roots.map((r) => buildNode(r, new Set()));
}

function deriveFromObservation(observation: OperatorObservation | null): {
  tree: readonly TreeNode[];
  stats: FleetStats;
  connection: 'live' | 'degraded';
} {
  const empty: FleetStats = { total: 0, warm: 0, waiting: 0, stuck: 0, paused: 0 };

  if (observation == null) {
    return { tree: [], stats: empty, connection: 'degraded' };
  }

  if (observation.kind === 'live') {
    const agents = observation.snapshot.agents;
    const statusMap = new Map<string, AgentStatus>(
      agents.map((a) => [a.agentId, deriveStatusLive(a)]),
    );
    const tree = buildTree(agents as ReadonlyArray<AgentLiveView & AgentEntry>, statusMap);
    const stats: FleetStats = {
      total: agents.length,
      warm: agents.filter((a) => statusMap.get(a.agentId) === 'warm').length,
      waiting: agents.filter((a) => statusMap.get(a.agentId) === 'waiting').length,
      stuck: agents.filter((a) => statusMap.get(a.agentId) === 'stuck').length,
      paused: agents.filter((a) => statusMap.get(a.agentId) === 'paused').length,
    };
    return { tree, stats, connection: 'live' };
  }

  // Static observation (conductor not running)
  const agents = observation.snapshot.agents;
  const statusMap = new Map<string, AgentStatus>(
    agents.map((a: AgentRecord) => [a.agentId, 'unknown' as const]),
  );
  const tree = buildTree(agents as ReadonlyArray<AgentRecord & AgentEntry>, statusMap);
  const stats: FleetStats = { total: agents.length, warm: 0, waiting: 0, stuck: 0, paused: 0 };
  return { tree, stats, connection: 'degraded' };
}

export class DashboardVM {
  private _state: DashboardState = {
    tree: [],
    stats: { total: 0, warm: 0, waiting: 0, stuck: 0, paused: 0 },
    actionables: [],
    connection: 'degraded',
  };
  private readonly listeners = new Set<(state: DashboardState) => void>();

  get state(): DashboardState {
    return this._state;
  }

  update(observation: OperatorObservation | null, actionables: readonly DeliveredMail[]): void {
    const { tree, stats, connection } = deriveFromObservation(observation);
    const actionableRows: ActionableRow[] = actionables.map((m) => ({
      seq: m.seq,
      type: m.type,
      subject: m.subject,
      sender: m.sender,
      ts: m.ts,
    }));
    this._state = { tree, stats, actionables: actionableRows, connection };
    this.emit();
  }

  subscribe(listener: (state: DashboardState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const state = this._state;
    for (const listener of [...this.listeners]) listener(state);
  }
}
