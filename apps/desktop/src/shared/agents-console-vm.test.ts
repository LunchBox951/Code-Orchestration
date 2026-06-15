import { describe, it, expect, vi } from 'vitest';
import { AgentsConsoleVM, CONSOLE_TRANSCRIPT_MAX_CHARS } from './agents-console-vm.js';
import type {
  OperatorObservation,
  ObservabilitySnapshot,
  AgentLiveView,
  AgentRecord,
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

const liveObs = (agents: readonly AgentLiveView[]): OperatorObservation => ({
  kind: 'live',
  snapshot: { snapshot: emptyStatic, agents },
});

const staticObs = (agents: readonly AgentRecord[]): OperatorObservation => ({
  kind: 'static',
  snapshot: { ...emptyStatic, agents },
  reason: 'conductor-not-running',
});

const tail = (agentId: string, text: string, offset = 0) => ({ agentId, offset, tail: text });
const push = (agentId: string, chunk: string, offset = 0) => ({ agentId, offset, chunk });

// ── AgentsConsoleVM ───────────────────────────────────────────────────────────

describe('AgentsConsoleVM — initial state', () => {
  it('starts degraded with empty roster, no selection, empty transcript', () => {
    const vm = new AgentsConsoleVM();
    expect(vm.state.connection).toBe('degraded');
    expect(vm.state.roster).toHaveLength(0);
    expect(vm.state.selectedAgentId).toBeNull();
    expect(vm.state.selectedStatus).toBeNull();
    expect(vm.state.transcript).toBe('');
  });
});

describe('AgentsConsoleVM — live observation', () => {
  it('sets connection to live', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([]));
    expect(vm.state.connection).toBe('live');
  });

  it('maps hosted agent to warm status', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator', { hosted: true })]));
    expect(vm.state.roster[0]?.status).toBe('warm');
  });

  it('maps stuck agent to stuck status', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator', { stuck: true })]));
    expect(vm.state.roster[0]?.status).toBe('stuck');
  });

  it('maps paused agent to paused status', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator', { paused: true })]));
    expect(vm.state.roster[0]?.status).toBe('paused');
  });

  it('maps !hosted + outstandingMail>0 to waiting status', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator', { hosted: false, outstandingMail: 2 })]));
    expect(vm.state.roster[0]?.status).toBe('waiting');
  });

  it('maps cold agent with no mail to unknown status', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator', { hosted: false, outstandingMail: 0 })]));
    expect(vm.state.roster[0]?.status).toBe('unknown');
  });

  it('stuck takes priority over warm (hosted + stuck)', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator', { hosted: true, stuck: true })]));
    expect(vm.state.roster[0]?.status).toBe('stuck');
  });

  it('paused takes priority over warm (hosted + paused)', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator', { hosted: true, paused: true })]));
    expect(vm.state.roster[0]?.status).toBe('paused');
  });

  it('stuck takes priority over paused', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator', { stuck: true, paused: true })]));
    expect(vm.state.roster[0]?.status).toBe('stuck');
  });

  it('roster carries agentId, role, parent fields', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('lead-1', '@operator', { role: 'lead' })]));
    const row = vm.state.roster[0];
    expect(row?.agentId).toBe('lead-1');
    expect(row?.role).toBe('lead');
    expect(row?.parent).toBe('@operator');
  });

  it('handles empty agent list without throwing', () => {
    const vm = new AgentsConsoleVM();
    expect(() => vm.update(liveObs([]))).not.toThrow();
    expect(vm.state.roster).toHaveLength(0);
  });

  it('never throws on orphan agent', () => {
    const vm = new AgentsConsoleVM();
    expect(() => vm.update(liveObs([makeAgent('orphan', 'ghost-parent')]))).not.toThrow();
    expect(vm.state.roster[0]?.agentId).toBe('orphan');
  });
});

describe('AgentsConsoleVM — static (daemon-down) observation', () => {
  it('sets connection to degraded', () => {
    const vm = new AgentsConsoleVM();
    vm.update(staticObs([]));
    expect(vm.state.connection).toBe('degraded');
  });

  it('all agents get unknown status in static mode', () => {
    const vm = new AgentsConsoleVM();
    vm.update(staticObs([makeStaticAgent('a1', '@operator'), makeStaticAgent('a2', '@operator')]));
    expect(vm.state.roster.every((r) => r.status === 'unknown')).toBe(true);
  });

  it('never throws on static observation', () => {
    const vm = new AgentsConsoleVM();
    expect(() => vm.update(staticObs([]))).not.toThrow();
  });
});

describe('AgentsConsoleVM — null observation', () => {
  it('stays degraded with empty roster when observation is null', () => {
    const vm = new AgentsConsoleVM();
    vm.update(null);
    expect(vm.state.connection).toBe('degraded');
    expect(vm.state.roster).toHaveLength(0);
  });

  it('never throws on null observation', () => {
    const vm = new AgentsConsoleVM();
    expect(() => vm.update(null)).not.toThrow();
  });
});

describe('AgentsConsoleVM — selectAgent', () => {
  it('sets selectedAgentId on selection', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator')]));
    vm.selectAgent('a1');
    expect(vm.state.selectedAgentId).toBe('a1');
  });

  it('resets transcript to empty on selection', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator')]));
    vm.selectAgent('a1');
    vm.setTranscriptTail(tail('a1', 'some text'));
    vm.selectAgent('a1'); // no-op (same id)
    expect(vm.state.transcript).toBe('some text'); // unchanged — same agent
    vm.selectAgent(null);
    expect(vm.state.transcript).toBe('');
  });

  it('resets transcript when switching to a different agent', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator'), makeAgent('a2', '@operator')]));
    vm.selectAgent('a1');
    vm.setTranscriptTail(tail('a1', 'agent1 output'));
    vm.selectAgent('a2');
    expect(vm.state.transcript).toBe('');
    expect(vm.state.selectedAgentId).toBe('a2');
  });

  it('selectAgent(null) clears selection and transcript', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator')]));
    vm.selectAgent('a1');
    vm.setTranscriptTail(tail('a1', 'hello'));
    vm.selectAgent(null);
    expect(vm.state.selectedAgentId).toBeNull();
    expect(vm.state.selectedStatus).toBeNull();
    expect(vm.state.transcript).toBe('');
  });

  it('selectedStatus reflects the selected agent live status', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator', { hosted: true })]));
    vm.selectAgent('a1');
    expect(vm.state.selectedStatus).toBe('warm');
  });

  it('selectedStatus is null when selected agent is not in roster', () => {
    const vm = new AgentsConsoleVM();
    vm.selectAgent('ghost-agent');
    expect(vm.state.selectedStatus).toBeNull();
  });

  it('emits on selection change', () => {
    const vm = new AgentsConsoleVM();
    const listener = vi.fn();
    vm.subscribe(listener);
    vm.update(liveObs([makeAgent('a1', '@operator')]));
    listener.mockClear();
    vm.selectAgent('a1');
    expect(listener).toHaveBeenCalledOnce();
  });

  it('does not emit when selecting the same agentId again', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator')]));
    vm.selectAgent('a1');
    const listener = vi.fn();
    vm.subscribe(listener);
    vm.selectAgent('a1'); // same — no-op
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('AgentsConsoleVM — update does not clear selection or transcript', () => {
  it('a tick update after selecting preserves selectedAgentId', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator')]));
    vm.selectAgent('a1');
    vm.update(liveObs([makeAgent('a1', '@operator', { hosted: true })]));
    expect(vm.state.selectedAgentId).toBe('a1');
  });

  it('a tick update after selecting does NOT wipe transcript', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator')]));
    vm.selectAgent('a1');
    vm.setTranscriptTail(tail('a1', 'my output'));
    vm.update(liveObs([makeAgent('a1', '@operator')]));
    expect(vm.state.transcript).toBe('my output');
  });

  it('selectedStatus updates on the next tick', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator')]));
    vm.selectAgent('a1');
    expect(vm.state.selectedStatus).toBe('unknown');
    vm.update(liveObs([makeAgent('a1', '@operator', { hosted: true })]));
    expect(vm.state.selectedStatus).toBe('warm');
  });

  it('selectedStatus becomes null when agent leaves the roster', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator')]));
    vm.selectAgent('a1');
    vm.update(liveObs([])); // a1 removed from roster
    expect(vm.state.selectedAgentId).toBe('a1'); // selection preserved
    expect(vm.state.selectedStatus).toBeNull(); // status null — agent gone
  });
});

describe('AgentsConsoleVM — setTranscriptTail', () => {
  it('replaces transcript for the selected agent', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator')]));
    vm.selectAgent('a1');
    vm.setTranscriptTail(tail('a1', 'hello world'));
    expect(vm.state.transcript).toBe('hello world');
  });

  it('ignored when tail.agentId differs from selection (race safety)', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator')]));
    vm.selectAgent('a1');
    vm.setTranscriptTail(tail('a2', 'stale backfill'));
    expect(vm.state.transcript).toBe('');
  });

  it('ignored when no agent is selected', () => {
    const vm = new AgentsConsoleVM();
    vm.setTranscriptTail(tail('a1', 'text'));
    expect(vm.state.transcript).toBe('');
  });

  it('preserves live chunks that arrived before the async backfill resolves', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator')]));
    vm.selectAgent('a1');
    vm.appendChunk(push('a1', 'live chunk\n', 'existing tail\n'.length));

    vm.setTranscriptTail(tail('a1', 'existing tail\n'));

    expect(vm.state.transcript).toBe('existing tail\nlive chunk\n');
  });

  it('preserves a live chunk even when stale backfill already ends with the same bytes', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator')]));
    vm.selectAgent('a1');
    const backfill = 'older prompt\n';
    const repeatedLive = 'prompt\n';

    vm.appendChunk(push('a1', repeatedLive, backfill.length));
    vm.setTranscriptTail(tail('a1', backfill));

    expect(vm.state.transcript).toBe(backfill + repeatedLive);
  });

  it('deduplicates partial overlap when a backfill already contains the first live chunk', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator')]));
    vm.selectAgent('a1');
    vm.appendChunk(push('a1', 'B', 1));
    vm.appendChunk(push('a1', 'C', 2));

    vm.setTranscriptTail(tail('a1', 'AB'));

    expect(vm.state.transcript).toBe('ABC');
  });

  it('emits after applying', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator')]));
    vm.selectAgent('a1');
    const listener = vi.fn();
    vm.subscribe(listener);
    vm.setTranscriptTail(tail('a1', 'hi'));
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe('AgentsConsoleVM — appendChunk', () => {
  it('appends chunk for the selected agent', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator')]));
    vm.selectAgent('a1');
    vm.setTranscriptTail(tail('a1', 'line1\n'));
    vm.appendChunk(push('a1', 'line2\n', 'line1\n'.length));
    expect(vm.state.transcript).toBe('line1\nline2\n');
  });

  it('ignored for a different agentId (per-agent isolation)', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator')]));
    vm.selectAgent('a1');
    vm.setTranscriptTail(tail('a1', 'a1 output'));
    vm.appendChunk(push('a2', 'a2 push'));
    expect(vm.state.transcript).toBe('a1 output');
  });

  it('ignored when no agent is selected', () => {
    const vm = new AgentsConsoleVM();
    vm.appendChunk(push('a1', 'data'));
    expect(vm.state.transcript).toBe('');
  });

  it('emits after applying a chunk', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator')]));
    vm.selectAgent('a1');
    const listener = vi.fn();
    vm.subscribe(listener);
    vm.appendChunk(push('a1', 'x'));
    expect(listener).toHaveBeenCalledOnce();
  });

  it('bounds transcript — keeps most-recent chars when past CONSOLE_TRANSCRIPT_MAX_CHARS', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator')]));
    vm.selectAgent('a1');
    // Fill to exactly the limit
    const base = 'A'.repeat(CONSOLE_TRANSCRIPT_MAX_CHARS);
    vm.setTranscriptTail(tail('a1', base));
    // Append a chunk that pushes past the limit
    const chunk = 'BBBB';
    vm.appendChunk(push('a1', chunk, base.length));
    expect(vm.state.transcript).toHaveLength(CONSOLE_TRANSCRIPT_MAX_CHARS);
    // The tail must end with the new chunk (most-recent preserved)
    expect(vm.state.transcript.endsWith(chunk)).toBe(true);
    // The transcript must NOT be the full original base (some A's were dropped)
    expect(vm.state.transcript).not.toBe(base);
    // Exactly chunk.length A's were dropped from the front
    const expectedStart = 'A'.repeat(CONSOLE_TRANSCRIPT_MAX_CHARS - chunk.length);
    expect(vm.state.transcript).toBe(expectedStart + chunk);
  });

  it('setTranscriptTail also applies the bound', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator')]));
    vm.selectAgent('a1');
    const oversize = 'X'.repeat(CONSOLE_TRANSCRIPT_MAX_CHARS + 100);
    vm.setTranscriptTail(tail('a1', oversize));
    expect(vm.state.transcript).toHaveLength(CONSOLE_TRANSCRIPT_MAX_CHARS);
    expect(vm.state.transcript.endsWith('X')).toBe(true);
  });
});

describe('AgentsConsoleVM — subscribe / emit / unsubscribe', () => {
  it('notifies subscriber on update', () => {
    const vm = new AgentsConsoleVM();
    const listener = vi.fn();
    vm.subscribe(listener);
    vm.update(liveObs([]));
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ connection: 'live' }));
  });

  it('allows multiple subscribers', () => {
    const vm = new AgentsConsoleVM();
    const a = vi.fn();
    const b = vi.fn();
    vm.subscribe(a);
    vm.subscribe(b);
    vm.update(liveObs([]));
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it('unsubscribe stops notifications', () => {
    const vm = new AgentsConsoleVM();
    const listener = vi.fn();
    const unsub = vm.subscribe(listener);
    unsub();
    vm.update(liveObs([]));
    expect(listener).not.toHaveBeenCalled();
  });

  it('pushed tick reflects immediately in state', () => {
    const vm = new AgentsConsoleVM();
    vm.update(staticObs([]));
    expect(vm.state.connection).toBe('degraded');
    vm.update(liveObs([makeAgent('a1', '@operator', { hosted: true })]));
    expect(vm.state.connection).toBe('live');
    expect(vm.state.roster[0]?.status).toBe('warm');
  });
});
