import { assertNever, TranscriptTailAccumulator, TRANSCRIPT_TAIL_HARD_MAX_CHARS } from '@co/core';
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
  readonly transcriptGeneration: number;
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
    transcriptGeneration: 0,
    transcriptOffset: 0,
    connection: 'degraded',
  };
  private readonly listeners = new Set<(state: AgentsConsoleState) => void>();
  private readonly transcriptAccumulator = new TranscriptTailAccumulator({
    softMaxChars: CONSOLE_TRANSCRIPT_MAX_CHARS,
    hardMaxChars: CONSOLE_TRANSCRIPT_MAX_CHARS,
  });
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
      transcriptGeneration: 0,
      transcriptOffset: 0,
    };
    this.transcriptSegments = [];
    this.transcriptAccumulator.clear();
    this.emit();
  }

  clearSelectedTranscript(): void {
    if (this._state.selectedAgentId == null) return;
    this.transcriptSegments = [];
    this.transcriptAccumulator.clear();
    this._state = {
      ...this._state,
      transcript: '',
      transcriptOffset: 0,
    };
    this.emit();
  }

  setTranscriptTail(tail: TranscriptTail): void {
    if (tail.agentId !== this._state.selectedAgentId) return;
    const generation = tail.generation ?? 0;
    if (generation < this._state.transcriptGeneration) return;
    if (generation > this._state.transcriptGeneration) {
      this.transcriptSegments = [];
      this.transcriptAccumulator.clear();
    }
    this._state = { ...this._state, transcriptGeneration: generation };
    this.applyTranscriptSegment(tail.offset, tail.tail);
  }

  appendChunk(chunk: OperatorIpcTranscript): TranscriptApplyResult {
    if (chunk.agentId !== this._state.selectedAgentId) return 'ignored';
    const generation = chunk.generation ?? 0;
    if (generation < this._state.transcriptGeneration) return 'ignored';
    if (generation > this._state.transcriptGeneration) {
      this.transcriptSegments = [];
      this.transcriptAccumulator.clear();
      this._state = { ...this._state, transcriptGeneration: generation };
    }
    let offset = chunk.offset;
    let text = chunk.chunk;
    if (text.length === 0) return 'ignored';

    const range = this.transcriptRange();
    if (range != null) {
      if (offset === 0 && range.start > 0) {
        this.transcriptSegments = [];
        this.transcriptAccumulator.clear();
        this.applyTranscriptSegment(offset, text);
        return 'applied';
      }
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
      if (resetPrefix.length > 0) this.transcriptAccumulator.replace(resetPrefix, 0);
      else this.transcriptAccumulator.clear();
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
    const range = this.transcriptRange();
    if (
      this.transcriptSegments.length === 1 &&
      range != null &&
      offset === range.end &&
      this.transcriptAccumulator.snapshot().nextOffset === offset
    ) {
      this.applyAccumulatorSnapshot(this.transcriptAccumulator.append(text));
      return;
    }

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

    // Never render discontiguous byte ranges as one transcript. If backfill/live races leave a gap, keep
    // the newest contiguous suffix so xterm does not parse missing PTY bytes as if they were present.
    const contiguous = this.newestContiguousSuffix(merged);
    const start = contiguous[0]?.offset ?? offset;
    const joined = contiguous.map((segment) => segment.text).join('');
    this.applyAccumulatorSnapshot(this.transcriptAccumulator.replace(joined, start));
  }

  private newestContiguousSuffix(segments: readonly TranscriptSegment[]): TranscriptSegment[] {
    const last = segments.at(-1);
    if (last == null) return [];
    const suffix: TranscriptSegment[] = [{ ...last }];
    let start = last.offset;
    for (let i = segments.length - 2; i >= 0; i--) {
      const segment = segments[i]!;
      if (segment.offset + segment.text.length !== start) break;
      suffix.unshift({ ...segment });
      start = segment.offset;
    }
    return suffix;
  }

  private applyAccumulatorSnapshot(snapshot: {
    readonly tail: string;
    readonly offset: number;
  }): void {
    this.transcriptSegments =
      snapshot.tail.length > 0 ? [{ offset: snapshot.offset, text: snapshot.tail }] : [];
    this._state = {
      ...this._state,
      transcript: snapshot.tail,
      transcriptOffset: snapshot.offset,
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
