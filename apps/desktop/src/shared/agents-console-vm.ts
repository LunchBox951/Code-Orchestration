import { assertNever, retainTranscriptTail, TRANSCRIPT_TAIL_HARD_MAX_CHARS } from '@co/core';
import type {
  OperatorObservation,
  AgentLiveView,
  AgentRecord,
  OperatorIpcTranscript,
  TranscriptTail,
} from '@co/core';
import type { AgentStatus } from './dashboard-vm.js';

/**
 * #66 sub-bug B — the renderer-side bound on the reconstructed transcript. Must sit with STRICT headroom
 * ABOVE the engine's HARD ceiling (`TRANSCRIPT_TAIL_HARD_MAX_CHARS` in `@co/core` — 4 × 64 KiB = 256 KiB),
 * NOT equal to it. The engine retains its tail back to the last alternate-screen-enter (`ESC[?1049h`) — up
 * to a 256 KiB ceiling-sized tail that LEADS with that enter. The renderer then APPENDS live chunks on top
 * of that tail before re-bounding. If the renderer cap equalled the 256 KiB engine ceiling (the round-1
 * bug), a ceiling-sized engine tail plus even one live append would push the join past the cap, and the
 * alt-screen-aware front-drop would re-slice the leading `ESC[?1049h` away at that boundary — re-introducing
 * the stacked-frame garble exactly where the engine had carefully preserved it. Sizing the renderer cap to
 * 512 KiB (2× the engine ceiling) gives room for a full ceiling-sized engine tail PLUS a generous live
 * append, so the alt-screen-aware bound holds: the leading enter is never re-sliced at the boundary.
 * Derived from the shared core ceiling so the headroom invariant fails loudly if the engine cap changes.
 *
 * Caveat — this is a string-boundary invariant (the leading `ESC[?1049h` survives the bound), proven by
 * the unit tests. That the surviving bytes actually replay into a clean, un-garbled frame in a real xterm
 * still needs live verification against an interactive TUI; the unit tests do not exercise the terminal.
 */
export const CONSOLE_TRANSCRIPT_MAX_CHARS = 2 * TRANSCRIPT_TAIL_HARD_MAX_CHARS;

/**
 * #66 sub-bug B — bound the renderer-side reconstructed transcript WITHOUT slicing away the early
 * alternate-screen-enter (`ESC[?1049h`) that an interactive TUI emits ONCE to switch xterm into its own
 * buffer. PURE (no I/O, no mutation, deterministic) and exported so it is unit-testable WITHOUT loading
 * electron. Uses the same core boundary policy as the engine, bounded to the single
 * {@link CONSOLE_TRANSCRIPT_MAX_CHARS} ceiling the renderer keeps:
 *
 *  - Under the cap: the whole `text` is kept verbatim (the common case — byte-for-byte unchanged).
 *  - Over the cap: anchor at the last reachable alt-screen enter, else at the last reachable full-screen
 *    clear, else fall back to the flat most-recent-N drop.
 *
 * Without this, the old alt-screen-UNAWARE flat front-drop slices off the leading `ESC[?1049h` on any long
 * session; `decideTermFeed` then `reset()`s and rewrites the alt-stripped transcript → the #66 garble.
 */
export function boundConsoleTranscript(text: string): string {
  return retainTranscriptTail(text, {
    softMaxChars: CONSOLE_TRANSCRIPT_MAX_CHARS,
    hardMaxChars: CONSOLE_TRANSCRIPT_MAX_CHARS,
  }).tail;
}

export interface AgentConsoleRow {
  readonly agentId: string;
  readonly name?: string;
  readonly role: string;
  readonly parent: string;
  readonly status: AgentStatus;
}

export interface AgentsConsoleState {
  readonly roster: readonly AgentConsoleRow[];
  readonly selectedAgentId: string | null;
  readonly selectedStatus: AgentStatus | null;
  readonly transcript: string;
  readonly transcriptOffset: number;
  readonly connection: 'live' | 'degraded';
}

function deriveStatusLive(a: AgentLiveView): AgentStatus {
  if (a.stuck) return 'stuck';
  if (a.stopped) return 'stopped';
  if (a.paused) return 'paused';
  if (a.hosted) return 'warm';
  if (a.outstandingMail > 0) return 'waiting';
  return 'unknown';
}

interface TranscriptSegment {
  offset: number;
  text: string;
}

export type TranscriptApplyResult = 'applied' | 'ignored' | 'gap';

export class AgentsConsoleVM {
  private _state: AgentsConsoleState = {
    roster: [],
    selectedAgentId: null,
    selectedStatus: null,
    transcript: '',
    transcriptOffset: 0,
    connection: 'degraded',
  };
  private readonly listeners = new Set<(state: AgentsConsoleState) => void>();
  private transcriptSegments: TranscriptSegment[] = [];

  get state(): AgentsConsoleState {
    return this._state;
  }

  update(observation: OperatorObservation | null): void {
    if (observation == null) {
      this._state = {
        ...this._state,
        roster: [],
        connection: 'degraded',
        selectedStatus: null,
      };
      this.emit();
      return;
    }

    switch (observation.kind) {
      case 'live': {
        const agents = observation.snapshot.agents;
        const roster: AgentConsoleRow[] = agents.map((a: AgentLiveView) => ({
          agentId: a.agentId,
          ...(a.name != null ? { name: a.name } : {}),
          role: a.role,
          parent: a.parent,
          status: deriveStatusLive(a),
        }));
        const selectedStatus = this._deriveSelectedStatus(roster);
        this._state = {
          ...this._state,
          roster,
          connection: 'live',
          selectedStatus,
        };
        this.emit();
        return;
      }
      case 'static': {
        const agents = observation.snapshot.agents;
        const roster: AgentConsoleRow[] = agents.map((a: AgentRecord) => ({
          agentId: a.agentId,
          ...(a.name != null ? { name: a.name } : {}),
          role: a.role,
          parent: a.parent,
          status: 'unknown' as const,
        }));
        const selectedStatus = this._deriveSelectedStatus(roster);
        this._state = {
          ...this._state,
          roster,
          connection: 'degraded',
          selectedStatus,
        };
        this.emit();
        return;
      }
      default:
        return assertNever(observation);
    }
  }

  selectAgent(agentId: string | null): void {
    if (this._state.selectedAgentId === agentId) return;
    const selectedStatus =
      agentId != null
        ? (this._state.roster.find((r) => r.agentId === agentId)?.status ?? null)
        : null;
    this._state = {
      ...this._state,
      selectedAgentId: agentId,
      selectedStatus,
      transcript: '',
      transcriptOffset: 0,
    };
    this.transcriptSegments = [];
    this.emit();
  }

  clearSelectedTranscript(): void {
    if (this._state.selectedAgentId == null) return;
    this.transcriptSegments = [];
    this._state = {
      ...this._state,
      transcript: '',
      transcriptOffset: 0,
    };
    this.emit();
  }

  setTranscriptTail(tail: TranscriptTail): void {
    if (tail.agentId !== this._state.selectedAgentId) return;
    this.applyTranscriptSegment(tail.offset, tail.tail);
  }

  appendChunk(chunk: OperatorIpcTranscript): TranscriptApplyResult {
    if (chunk.agentId !== this._state.selectedAgentId) return 'ignored';
    let offset = chunk.offset;
    let text = chunk.chunk;
    if (text.length === 0) return 'ignored';

    const range = this.transcriptRange();
    if (range != null) {
      const chunkEnd = offset + text.length;
      if (offset < range.start) {
        if (chunkEnd <= range.end) return 'ignored';
        const drop = range.start - offset;
        offset = range.start;
        text = text.slice(drop);
      }
      if (offset > range.end) return 'gap';
    }

    const resetPrefix = this.resetPrefixForLiveChunk(offset, text);
    if (resetPrefix != null) {
      this.transcriptSegments = resetPrefix.length > 0 ? [{ offset: 0, text: resetPrefix }] : [];
    }
    this.applyTranscriptSegment(offset, text);
    return 'applied';
  }

  private transcriptRange(): { readonly start: number; readonly end: number } | undefined {
    const first = this.transcriptSegments[0];
    const last = this.transcriptSegments.at(-1);
    if (first == null || last == null) return undefined;
    return { start: first.offset, end: last.offset + last.text.length };
  }

  private resetPrefixForLiveChunk(offset: number, text: string): string | null {
    if (text.length === 0 || this.transcriptSegments.length === 0) return null;
    const chunkEnd = offset + text.length;
    let overlapped = false;
    for (const segment of this.transcriptSegments) {
      const segmentEnd = segment.offset + segment.text.length;
      const start = Math.max(offset, segment.offset);
      const end = Math.min(chunkEnd, segmentEnd);
      if (start >= end) continue;
      overlapped = true;
      const existing = segment.text.slice(start - segment.offset, end - segment.offset);
      const incoming = text.slice(start - offset, end - offset);
      if (existing !== incoming) return this.contiguousPrefixBefore(offset);
    }
    if (!overlapped && offset === 0) return '';
    return null;
  }

  private contiguousPrefixBefore(offset: number): string {
    if (offset <= 0) return '';
    let cursor = 0;
    let prefix = '';
    for (const segment of this.transcriptSegments) {
      if (segment.offset > cursor) break;
      const startInSegment = Math.max(0, cursor - segment.offset);
      const endInSegment = Math.min(segment.text.length, offset - segment.offset);
      if (endInSegment > startInSegment) {
        prefix += segment.text.slice(startInSegment, endInSegment);
        cursor = segment.offset + endInSegment;
      }
      if (cursor >= offset) return prefix.slice(0, offset);
    }
    return '';
  }

  private applyTranscriptSegment(offset: number, text: string): void {
    if (text.length === 0) return;
    const segments = [...this.transcriptSegments, { offset, text }]
      .filter((segment) => segment.text.length > 0)
      .sort((a, b) => a.offset - b.offset);
    const merged: TranscriptSegment[] = [];
    for (const segment of segments) {
      const last = merged.at(-1);
      if (last == null) {
        merged.push({ ...segment });
        continue;
      }
      const lastEnd = last.offset + last.text.length;
      if (segment.offset <= lastEnd) {
        const overlap = lastEnd - segment.offset;
        if (overlap < segment.text.length) {
          last.text += segment.text.slice(overlap);
        }
      } else {
        merged.push({ ...segment });
      }
    }

    // Bound the segment store with the SAME alt-screen-aware policy as the displayed transcript so the
    // store and `state.transcript` carry the same window AND the leading `ESC[?1049h` survives into the
    // join. Because the renderer cap ({@link CONSOLE_TRANSCRIPT_MAX_CHARS}) sits ABOVE the engine ceiling,
    // a ceiling-sized engine tail plus a live append still fits under the cap, so this bound does not slice
    // the leading enter away at that boundary. A flat front-drop here (the old logic) would strip the early
    // alt-screen-enter from the store before `boundConsoleTranscript` ever saw it (#66 sub-bug B).
    const joined = merged.map((segment) => segment.text).join('');
    const bounded = boundConsoleTranscript(joined);
    let dropped = joined.length - bounded.length;
    while (dropped > 0 && merged.length > 0) {
      const first = merged[0]!;
      const drop = Math.min(first.text.length, dropped);
      first.offset += drop;
      first.text = first.text.slice(drop);
      dropped -= drop;
      if (first.text.length === 0) merged.shift();
    }

    this.transcriptSegments = merged;
    this._state = {
      ...this._state,
      transcript: bounded,
      transcriptOffset: merged[0]?.offset ?? 0,
    };
    this.emit();
  }

  subscribe(listener: (state: AgentsConsoleState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private _deriveSelectedStatus(roster: readonly AgentConsoleRow[]): AgentStatus | null {
    const { selectedAgentId } = this._state;
    if (selectedAgentId == null) return null;
    return roster.find((r) => r.agentId === selectedAgentId)?.status ?? null;
  }

  private emit(): void {
    const state = this._state;
    for (const listener of [...this.listeners]) listener(state);
  }
}
