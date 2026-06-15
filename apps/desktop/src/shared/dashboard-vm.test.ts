import { describe, it, expect, vi } from 'vitest';
import { DashboardVM, type TreeNode } from './dashboard-vm.js';
import type {
  OperatorObservation,
  ObservabilitySnapshot,
  AgentLiveView,
  AgentRecord,
  DeliveredMail,
} from '@co/core';

// ── fixtures ──────────────────────────────────────────────────────────────────

const emptyStatic: ObservabilitySnapshot = {
  agents: [],
  plans: [],
  reviews: [],
  costRollups: [],
};

function makeAgent(
  agentId: string,
  parent: string,
  overrides: Partial<AgentLiveView> = {},
): AgentLiveView {
  return {
    agentId,
    role: 'implementer',
    parent,
    hosted: false,
    outstandingMail: 0,
    paused: false,
    stuck: false,
    costUsd: 0,
    ...overrides,
  };
}

function makeStaticAgent(
  agentId: string,
  parent: string,
  overrides: Partial<AgentRecord> = {},
): AgentRecord {
  return { agentId, role: 'implementer', parent, registeredTs: 1000, ...overrides };
}

function makeMail(overrides: Partial<DeliveredMail> = {}): DeliveredMail {
  return {
    seq: 1,
    recipient: '@operator',
    sender: 'lead-abc',
    type: 'clarify_request',
    subject: 'Need clarification',
    body: 'body',
    ts: 1000,
    ...overrides,
  } as DeliveredMail;
}

const liveObs = (agents: readonly AgentLiveView[]): OperatorObservation => ({
  kind: 'live',
  snapshot: { snapshot: emptyStatic, agents },
});

const staticObs = (agents: readonly AgentRecord[]): OperatorObservation => ({
  kind: 'static',
  snapshot: { ...emptyStatic, agents },
  reason: 'conductor-not-running',
});

function flattenTree(nodes: readonly TreeNode[]): string[] {
  return nodes.flatMap((node) => [node.agentId, ...flattenTree(node.children)]);
}

// ── DashboardVM ───────────────────────────────────────────────────────────────

describe('DashboardVM — initial state', () => {
  it('starts degraded with empty tree, stats, actionables', () => {
    const vm = new DashboardVM();
    expect(vm.state.connection).toBe('degraded');
    expect(vm.state.tree).toHaveLength(0);
    expect(vm.state.actionables).toHaveLength(0);
    expect(vm.state.stats).toEqual({ total: 0, warm: 0, waiting: 0, stuck: 0, paused: 0 });
  });
});

describe('DashboardVM — live observation', () => {
  it('sets connection to live', () => {
    const vm = new DashboardVM();
    vm.update(liveObs([]), []);
    expect(vm.state.connection).toBe('live');
  });

  it('derives spawn tree from parent edges', () => {
    const vm = new DashboardVM();
    const agents = [
      makeAgent('lead-1', '@operator'),
      makeAgent('impl-1', 'lead-1'),
      makeAgent('impl-2', 'lead-1'),
    ];
    vm.update(liveObs(agents), []);
    const tree = vm.state.tree;
    expect(tree).toHaveLength(1);
    expect(tree[0]?.agentId).toBe('lead-1');
    expect(tree[0]?.children).toHaveLength(2);
    const childIds = tree[0]?.children.map((c) => c.agentId) ?? [];
    expect(childIds).toContain('impl-1');
    expect(childIds).toContain('impl-2');
  });

  it('maps hosted agent to warm status', () => {
    const vm = new DashboardVM();
    const agents = [makeAgent('a1', '@operator', { hosted: true })];
    vm.update(liveObs(agents), []);
    expect(vm.state.tree[0]?.status).toBe('warm');
  });

  it('maps stuck agent to stuck status', () => {
    const vm = new DashboardVM();
    const agents = [makeAgent('a1', '@operator', { stuck: true })];
    vm.update(liveObs(agents), []);
    expect(vm.state.tree[0]?.status).toBe('stuck');
  });

  it('maps paused agent to paused status', () => {
    const vm = new DashboardVM();
    const agents = [makeAgent('a1', '@operator', { paused: true })];
    vm.update(liveObs(agents), []);
    expect(vm.state.tree[0]?.status).toBe('paused');
  });

  it('maps !hosted + outstandingMail>0 to waiting status', () => {
    const vm = new DashboardVM();
    const agents = [makeAgent('a1', '@operator', { hosted: false, outstandingMail: 2 })];
    vm.update(liveObs(agents), []);
    expect(vm.state.tree[0]?.status).toBe('waiting');
  });

  it('maps cold agent with no mail to unknown status', () => {
    const vm = new DashboardVM();
    const agents = [makeAgent('a1', '@operator', { hosted: false, outstandingMail: 0 })];
    vm.update(liveObs(agents), []);
    expect(vm.state.tree[0]?.status).toBe('unknown');
  });

  it('stuck takes priority over hosted (warm)', () => {
    const vm = new DashboardVM();
    const agents = [makeAgent('a1', '@operator', { hosted: true, stuck: true })];
    vm.update(liveObs(agents), []);
    expect(vm.state.tree[0]?.status).toBe('stuck');
  });

  it('paused takes priority over warm', () => {
    const vm = new DashboardVM();
    const agents = [makeAgent('a1', '@operator', { hosted: true, paused: true })];
    vm.update(liveObs(agents), []);
    expect(vm.state.tree[0]?.status).toBe('paused');
  });

  it('derives fleet stats correctly', () => {
    const vm = new DashboardVM();
    const agents = [
      makeAgent('a1', '@operator', { hosted: true }),
      makeAgent('a2', '@operator', { outstandingMail: 1 }),
      makeAgent('a3', '@operator', { stuck: true }),
      makeAgent('a4', '@operator', { paused: true }),
      makeAgent('a5', '@operator'),
    ];
    vm.update(liveObs(agents), []);
    expect(vm.state.stats).toEqual({ total: 5, warm: 1, waiting: 1, stuck: 1, paused: 1 });
  });

  it('handles multiple root agents', () => {
    const vm = new DashboardVM();
    const agents = [makeAgent('a1', '@operator'), makeAgent('a2', '@operator')];
    vm.update(liveObs(agents), []);
    expect(vm.state.tree).toHaveLength(2);
  });

  it('places orphan (parent not in set) at root level — never throws', () => {
    const vm = new DashboardVM();
    const agents = [makeAgent('orphan-1', 'ghost-parent')];
    expect(() => vm.update(liveObs(agents), [])).not.toThrow();
    expect(vm.state.tree).toHaveLength(1);
    expect(vm.state.tree[0]?.agentId).toBe('orphan-1');
  });

  it('handles empty agent list', () => {
    const vm = new DashboardVM();
    vm.update(liveObs([]), []);
    expect(vm.state.tree).toHaveLength(0);
    expect(vm.state.stats.total).toBe(0);
  });
});

describe('DashboardVM — static (daemon-down) observation', () => {
  it('sets connection to degraded', () => {
    const vm = new DashboardVM();
    vm.update(staticObs([]), []);
    expect(vm.state.connection).toBe('degraded');
  });

  it('renders tree from AgentRecord parent edges (no dots)', () => {
    const vm = new DashboardVM();
    const agents = [makeStaticAgent('lead-1', '@operator'), makeStaticAgent('impl-1', 'lead-1')];
    vm.update(staticObs(agents), []);
    expect(vm.state.tree).toHaveLength(1);
    expect(vm.state.tree[0]?.agentId).toBe('lead-1');
    expect(vm.state.tree[0]?.children[0]?.agentId).toBe('impl-1');
  });

  it('all agents get unknown status in static mode', () => {
    const vm = new DashboardVM();
    const agents = [makeStaticAgent('a1', '@operator'), makeStaticAgent('a2', '@operator')];
    vm.update(staticObs(agents), []);
    expect(vm.state.tree.every((n) => n.status === 'unknown')).toBe(true);
  });

  it('never throws on static observation — daemon-down graceful', () => {
    const vm = new DashboardVM();
    expect(() => vm.update(staticObs([]), [])).not.toThrow();
  });
});

describe('DashboardVM — null observation', () => {
  it('stays degraded with empty tree when observation is null', () => {
    const vm = new DashboardVM();
    vm.update(null, []);
    expect(vm.state.connection).toBe('degraded');
    expect(vm.state.tree).toHaveLength(0);
  });
});

describe('DashboardVM — actionables', () => {
  it('maps DeliveredMail to ActionableRow (seq, type, subject, sender, ts)', () => {
    const vm = new DashboardVM();
    const mail = makeMail({
      seq: 42,
      type: 'clarify_request',
      subject: 'Help!',
      sender: 'lead-x',
      ts: 9999,
    });
    vm.update(null, [mail]);
    expect(vm.state.actionables).toHaveLength(1);
    expect(vm.state.actionables[0]).toEqual({
      seq: 42,
      type: 'clarify_request',
      subject: 'Help!',
      sender: 'lead-x',
      ts: 9999,
    });
  });

  it('preserves all actionables in order', () => {
    const vm = new DashboardVM();
    const mails = [makeMail({ seq: 1 }), makeMail({ seq: 2 }), makeMail({ seq: 3 })];
    vm.update(null, mails);
    expect(vm.state.actionables.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it('MNR #1: DashboardVM never calls markRead — rendered rows equal input 1:1', () => {
    // markRead is structurally impossible: DashboardVM is pure with no MailStore
    // reference. The VM only maps DeliveredMail → ActionableRow (read projection).
    // Assert the guarantee holds: every injected actionable appears in the output
    // with the same seq, and no item is dropped (which markRead would effectively do).
    const vm = new DashboardVM();
    const mails = [makeMail({ seq: 10 }), makeMail({ seq: 20 }), makeMail({ seq: 30 })];
    vm.update(null, mails);
    expect(vm.state.actionables).toHaveLength(mails.length);
    expect(vm.state.actionables.map((r) => r.seq)).toEqual([10, 20, 30]);
  });
});

describe('DashboardVM — subscribe / emit', () => {
  it('notifies subscriber on update', () => {
    const vm = new DashboardVM();
    const listener = vi.fn();
    vm.subscribe(listener);
    vm.update(liveObs([]), []);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ connection: 'live' }));
  });

  it('allows multiple subscribers', () => {
    const vm = new DashboardVM();
    const a = vi.fn();
    const b = vi.fn();
    vm.subscribe(a);
    vm.subscribe(b);
    vm.update(liveObs([]), []);
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('unsubscribe stops notifications', () => {
    const vm = new DashboardVM();
    const listener = vi.fn();
    const unsub = vm.subscribe(listener);
    unsub();
    vm.update(liveObs([]), []);
    expect(listener).not.toHaveBeenCalled();
  });

  it('pushed tick reflects immediately in state (one-cycle update)', () => {
    const vm = new DashboardVM();
    vm.update(staticObs([]), []);
    expect(vm.state.connection).toBe('degraded');
    // Simulate a pushed tick (live obs)
    vm.update(liveObs([makeAgent('a1', '@operator', { hosted: true })]), []);
    expect(vm.state.connection).toBe('live');
    expect(vm.state.tree[0]?.status).toBe('warm');
  });
});

describe('DashboardVM — cycle safety', () => {
  it('handles a cyclic parent graph without throwing', () => {
    const vm = new DashboardVM();
    // A → B → A (cycle), with C → A entering from outside
    const agents = [makeAgent('A', 'B'), makeAgent('B', 'A'), makeAgent('C', 'ghost')];
    expect(() => vm.update(liveObs(agents), [])).not.toThrow();
  });

  it('surfaces agents trapped in a cyclic rootless graph', () => {
    const vm = new DashboardVM();
    const agents = [makeAgent('A', 'B'), makeAgent('B', 'A'), makeAgent('C', 'ghost')];

    vm.update(liveObs(agents), []);

    expect(flattenTree(vm.state.tree)).toEqual(expect.arrayContaining(['A', 'B', 'C']));
  });
});
