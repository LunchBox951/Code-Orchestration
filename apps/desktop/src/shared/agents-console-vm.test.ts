import { describe, it, expect, vi } from 'vitest';
import {
  AgentsConsoleVM,
  CONSOLE_TRANSCRIPT_MAX_CHARS,
  boundConsoleTranscript,
} from './agents-console-vm.js';
import { TRANSCRIPT_TAIL_HARD_MAX_CHARS } from '@co/core';
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
    stopped: false,
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

  it('maps stopped agent with outstanding mail to stopped status', () => {
    const vm = new AgentsConsoleVM();
    vm.update(
      liveObs([
        makeAgent('a1', '@operator', {
          outstandingMail: 2,
          stopped: true,
        }),
      ]),
    );
    expect(vm.state.roster[0]?.status).toBe('stopped');
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

  it('roster carries operator-provided names', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('coord-auth-9f3a1c', '@operator', { name: 'Auth refactor' })]));
    expect(vm.state.roster[0]).toMatchObject({
      agentId: 'coord-auth-9f3a1c',
      name: 'Auth refactor',
    });
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

  it('roster carries operator-provided names in static mode', () => {
    const vm = new AgentsConsoleVM();
    vm.update(
      staticObs([makeStaticAgent('coord-auth-9f3a1c', '@operator', { name: 'Auth refactor' })]),
    );
    expect(vm.state.roster[0]).toMatchObject({
      agentId: 'coord-auth-9f3a1c',
      name: 'Auth refactor',
    });
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

  it('treats a selected-agent offset reset push as a new transcript generation', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator')]));
    vm.selectAgent('a1');
    vm.setTranscriptTail(tail('a1', 'old pane output\n'));

    vm.appendChunk(push('a1', 'new pane output\n', 0));

    expect(vm.state.transcript).toBe('new pane output\n');
  });

  it('does not truncate a fetched tail when a duplicate offset-zero push arrives late', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator')]));
    vm.selectAgent('a1');
    vm.setTranscriptTail(tail('a1', 'hello world\n'));

    vm.appendChunk(push('a1', 'hello', 0));

    expect(vm.state.transcript).toBe('hello world\n');
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

// ── #66 sub-bug B — the renderer-side alt-screen-aware bound (boundConsoleTranscript) ─────────────
// The OLD flat front-drop sliced off the early `ESC[?1049h` an interactive TUI emits ONCE to enter the
// alternate screen, so a long session's reconstructed transcript lost its alt-screen setup and the garble
// returned. The bound must NEVER cut past the last alt-screen-enter within the kept window — mirroring the
// engine's `transcriptTailFrom` policy. These assert the PURE exported function directly (no electron); the
// alt-screen cases would FAIL under the old flat slice.
// ESC authored as a `\u` escape so the SOURCE holds no raw control byte (the C2 pristine-repo rule).
const ESC = '\u001B';
const CSI = '\u009B';
const ALT_ENTER = ESC + '[?1049h'; // DEC private mode 1049 set — switch to the alternate screen
const C1_ALT_ENTER = CSI + '?1049h';
describe('boundConsoleTranscript (#66 sub-bug B) — never slices away the alternate-screen setup', () => {
  it('keeps the FULL text verbatim when at/under the cap (common case, unchanged)', () => {
    const under = ALT_ENTER + 'a small frame';
    expect(boundConsoleTranscript(under)).toBe(under);
    const exact = 'z'.repeat(CONSOLE_TRANSCRIPT_MAX_CHARS);
    expect(boundConsoleTranscript(exact)).toBe(exact);
  });

  it('retains back to the early alt-screen-enter on a >cap stream (the fix; FAILS under flat front-drop)', () => {
    // A long session: scrollback that will be dropped, then the alt-screen setup, then redraw frames.
    // The whole stream exceeds the cap, but the enter still sits WITHIN the most-recent-cap window — so it
    // is reachable and MUST be retained (an alt-screen-UNAWARE flat drop would slice it away mid-window).
    const head = 'H'.repeat(CONSOLE_TRANSCRIPT_MAX_CHARS); // older scrollback — pushes total past the cap
    const setup = ALT_ENTER + ESC + '[2J' + ESC + '[H'; // enter alt screen, clear, home
    const frames = 'F'.repeat(Math.floor(CONSOLE_TRANSCRIPT_MAX_CHARS / 2)); // redraws, < cap after the enter
    const buf = head + setup + frames;
    expect(buf.length).toBeGreaterThan(CONSOLE_TRANSCRIPT_MAX_CHARS); // the stream is genuinely over the cap

    const bounded = boundConsoleTranscript(buf);

    // The load-bearing invariant: the alt-screen-enter is STILL present in the bound result…
    expect(bounded.includes(ALT_ENTER)).toBe(true);
    // …and it leads the kept transcript (we anchored on exactly that boundary).
    expect(bounded.startsWith(ALT_ENTER)).toBe(true);
    // Anchoring keeps the same-or-less than the flat window, so the footprint stays bounded.
    expect(bounded.length).toBeLessThanOrEqual(CONSOLE_TRANSCRIPT_MAX_CHARS);
    // The OLD flat front-drop would have kept only the last `cap` chars — which START mid-`H`-scrollback
    // and so SLICE the alt-screen-enter even though it is inside the window: exactly the garble we prevent.
    expect(buf.slice(buf.length - CONSOLE_TRANSCRIPT_MAX_CHARS).startsWith(ALT_ENTER)).toBe(false);
  });

  it('anchors on the LAST alt-screen-enter when several are present (re-entered the alt screen)', () => {
    const firstEnter = ALT_ENTER + 'one'.repeat(CONSOLE_TRANSCRIPT_MAX_CHARS); // pushed well past the cap
    const lastEnter = ALT_ENTER + 'two'; // the re-enter we must anchor on
    const buf = firstEnter + lastEnter;

    const bounded = boundConsoleTranscript(buf);

    expect(bounded.startsWith(ALT_ENTER)).toBe(true);
    expect(bounded).toBe(lastEnter); // anchored on the LAST enter, not the first
    expect(bounded.split(ALT_ENTER).length - 1).toBe(1); // exactly one enter survives
  });

  it('honours the cap: an unreachably-old alt-screen-enter is NOT dragged in', () => {
    // Alt-screen-enter, then MORE than the cap of bytes after it → it falls outside the kept window.
    const buf = ALT_ENTER + 'G'.repeat(CONSOLE_TRANSCRIPT_MAX_CHARS + 5_000);

    const bounded = boundConsoleTranscript(buf);

    expect(bounded.length).toBeLessThanOrEqual(CONSOLE_TRANSCRIPT_MAX_CHARS); // memory stays bounded
    expect(bounded.includes(ALT_ENTER)).toBe(false); // the stale enter is beyond reach — not retained
  });

  it('with NO alt-screen, is exactly the flat most-recent-N drop (legacy behavior preserved)', () => {
    const buf = 'A'.repeat(CONSOLE_TRANSCRIPT_MAX_CHARS) + 'B'.repeat(1_000);

    const bounded = boundConsoleTranscript(buf);

    expect(bounded.length).toBe(CONSOLE_TRANSCRIPT_MAX_CHARS);
    expect(bounded).toBe(buf.slice(buf.length - CONSOLE_TRANSCRIPT_MAX_CHARS));
    expect(bounded.endsWith('B'.repeat(1_000))).toBe(true);
  });

  it('recognizes C1 CSI alt-screen enter as the same replay boundary', () => {
    const head = 'H'.repeat(CONSOLE_TRANSCRIPT_MAX_CHARS);
    const frames = 'F'.repeat(Math.floor(CONSOLE_TRANSCRIPT_MAX_CHARS / 2));
    const bounded = boundConsoleTranscript(head + C1_ALT_ENTER + frames);

    expect(bounded.startsWith(C1_ALT_ENTER)).toBe(true);
  });

  it('snaps to a full-screen clear when no alt-screen enter is reachable', () => {
    const head = 'H'.repeat(CONSOLE_TRANSCRIPT_MAX_CHARS);
    const clearFrame = ESC + '[2J' + ESC + '[Hfresh frame';
    const bounded = boundConsoleTranscript(head + clearFrame);

    expect(bounded).toBe(clearFrame);
  });
});

// The engine's HARD ceiling on the retained tail (`TRANSCRIPT_TAIL_HARD_MAX_CHARS` in `@co/mcp` — 4 × 64
// KiB). Imported from the shared core contract so the test fails if the engine ceiling changes without
// preserving renderer headroom.
const ENGINE_TRANSCRIPT_TAIL_HARD_MAX_CHARS = TRANSCRIPT_TAIL_HARD_MAX_CHARS;

describe('AgentsConsoleVM — renderer cap has STRICT headroom over the engine ceiling (#66 round-2)', () => {
  it('a ceiling-sized engine tail leading with ESC[?1049h + a live append STILL leads with ESC[?1049h', () => {
    // Round-2 regression: the engine hands the renderer a tail up to its HARD ceiling that LEADS with the
    // alt-screen-enter. The renderer then appends live chunks on top before re-bounding. If the renderer cap
    // EQUALLED the engine ceiling (the round-1 bug), `ceiling-sized tail + append` would exceed the cap and
    // the alt-screen-aware front-drop would re-slice the leading enter away at that boundary — re-introducing
    // the garble. With the renderer cap sitting strictly ABOVE the engine ceiling, the join fits and the
    // leading enter survives. This assertion FAILS when the cap == the engine ceiling, PASSES with headroom.
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator')]));
    vm.selectAgent('a1');

    // A ceiling-sized engine tail: exactly TRANSCRIPT_TAIL_HARD_MAX_CHARS chars that LEAD with the enter,
    // just as `transcriptTailFrom` produces when it anchors back to the alt-screen-enter at the ceiling.
    const engineTail =
      ALT_ENTER + 'E'.repeat(ENGINE_TRANSCRIPT_TAIL_HARD_MAX_CHARS - ALT_ENTER.length);
    expect(engineTail.length).toBe(ENGINE_TRANSCRIPT_TAIL_HARD_MAX_CHARS);
    vm.setTranscriptTail(tail('a1', engineTail));
    // Sanity: the ceiling-sized backfill alone still leads with the enter (it is < the renderer cap).
    expect(vm.state.transcript.startsWith(ALT_ENTER)).toBe(true);

    // A live append on top of the ceiling-sized tail — this is what re-slices the front under the old cap.
    const liveAppend = 'L'.repeat(4_096);
    vm.appendChunk(push('a1', liveAppend, engineTail.length));

    // The load-bearing invariant: the reconstructed transcript STILL leads with the alt-screen-enter, so a
    // real TUI redraw replays cleanly. The renderer's headroom over the engine ceiling is what guarantees it.
    expect(vm.state.transcript.startsWith(ALT_ENTER)).toBe(true);
    expect(vm.state.transcript.includes(ALT_ENTER)).toBe(true);
    expect(vm.state.transcript.endsWith(liveAppend)).toBe(true);
    // The renderer cap must be strictly above the engine ceiling for the headroom invariant to hold at all.
    expect(CONSOLE_TRANSCRIPT_MAX_CHARS).toBeGreaterThan(ENGINE_TRANSCRIPT_TAIL_HARD_MAX_CHARS);
  });
});

describe('AgentsConsoleVM — alt-screen-aware bound over the reconstructed transcript (#66 sub-bug B)', () => {
  it('keeps the early ESC[?1049h after a >cap stream (FAILS under the old flat segment-store drop)', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator')]));
    vm.selectAgent('a1');

    // Older scrollback, then the alt-screen setup, then redraw frames — streamed as successive chunks so
    // the segment store has to bound itself. The whole reconstruction exceeds the cap but the enter stays
    // inside the most-recent-cap window; the old alt-screen-UNAWARE segment-store drop sliced it off.
    const head = 'H'.repeat(CONSOLE_TRANSCRIPT_MAX_CHARS);
    const setup = ALT_ENTER + ESC + '[2J' + ESC + '[H';
    const frames = 'F'.repeat(Math.floor(CONSOLE_TRANSCRIPT_MAX_CHARS / 2));
    vm.setTranscriptTail(tail('a1', head));
    vm.appendChunk(push('a1', setup, head.length));
    vm.appendChunk(push('a1', frames, head.length + setup.length));

    // The reconstructed transcript STILL leads with the alt-screen-enter — the garble is prevented.
    expect(vm.state.transcript.includes(ALT_ENTER)).toBe(true);
    expect(vm.state.transcript.startsWith(ALT_ENTER)).toBe(true);
    expect(vm.state.transcript.length).toBeLessThanOrEqual(CONSOLE_TRANSCRIPT_MAX_CHARS);
  });
});

describe('AgentsConsoleVM — nonzero transcript offsets and live gaps', () => {
  it('tracks the retained transcript offset in state', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator')]));
    vm.selectAgent('a1');

    vm.setTranscriptTail(tail('a1', 'retained', 100));

    expect(vm.state.transcript).toBe('retained');
    expect(vm.state.transcriptOffset).toBe(100);
  });

  it('ignores stale live chunks wholly before a nonzero retained tail', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator')]));
    vm.selectAgent('a1');
    vm.setTranscriptTail(tail('a1', 'retained-tail', 100));

    const result = vm.appendChunk(push('a1', 'old-', 50));

    expect(result).toBe('ignored');
    expect(vm.state.transcript).toBe('retained-tail');
    expect(vm.state.transcriptOffset).toBe(100);
  });

  it('does not let an older conflicting overlap replace a nonzero retained tail', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator')]));
    vm.selectAgent('a1');
    vm.setTranscriptTail(tail('a1', 'CDE', 100));

    const result = vm.appendChunk(push('a1', 'ABXY', 98));

    expect(result).toBe('ignored');
    expect(vm.state.transcript).toBe('CDE');
    expect(vm.state.transcriptOffset).toBe(100);
  });

  it('reports a forward live gap instead of silently concatenating missing bytes', () => {
    const vm = new AgentsConsoleVM();
    vm.update(liveObs([makeAgent('a1', '@operator')]));
    vm.selectAgent('a1');
    vm.setTranscriptTail(tail('a1', 'base', 100));

    const result = vm.appendChunk(push('a1', 'later', 120));

    expect(result).toBe('gap');
    expect(vm.state.transcript).toBe('base');
    expect(vm.state.transcriptOffset).toBe(100);
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
