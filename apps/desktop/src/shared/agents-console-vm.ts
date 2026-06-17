import { assertNever } from '@co/core';
import type {
  OperatorObservation,
  AgentLiveView,
  AgentRecord,
  OperatorIpcTranscript,
  TranscriptTail,
} from '@co/core';
import type { AgentStatus } from './dashboard-vm.js';

export const CONSOLE_TRANSCRIPT_MAX_CHARS = 64 * 1024;

export interface AgentConsoleRow {
  readonly agentId: string;
  readonly role: string;
  readonly parent: string;
  readonly status: AgentStatus;
}

export interface AgentsConsoleState {
  readonly roster: readonly AgentConsoleRow[];
  readonly selectedAgentId: string | null;
  readonly selectedStatus: AgentStatus | null;
  readonly transcript: string;
  /**
   * A persistent transcript-fetch error for the selected agent (Principle 9 — no-silent-failures).
   * Non-null after a `transcript()` fetch rejects; the renderer shows it with a Retry button instead of
   * leaving the pane empty. Cleared on agent switch, an explicit transcript clear, or a successful fetch.
   */
  readonly transcriptError: string | null;
  readonly connection: 'live' | 'degraded';
}

function deriveStatusLive(a: AgentLiveView): AgentStatus {
  if (a.stuck) return 'stuck';
  if (a.paused) return 'paused';
  if (a.hosted) return 'warm';
  if (a.outstandingMail > 0) return 'waiting';
  return 'unknown';
}

function boundTranscript(text: string): string {
  if (text.length <= CONSOLE_TRANSCRIPT_MAX_CHARS) return text;
  return text.slice(text.length - CONSOLE_TRANSCRIPT_MAX_CHARS);
}

const ESC = 0x1b;

/**
 * Return the index just past the escape sequence that begins at `esc` (where `text.charCodeAt(esc) ===
 * ESC`), or `text.length` if it is unterminated within `text`. Covers the cases that appear in a raw pty
 * stream: CSI (`ESC [` … final byte 0x40–0x7e — e.g. the SGR `ESC[31m`), OSC (`ESC ]` … BEL or ST), and
 * the generic 2-byte / intermediate-then-final escape.
 */
function escapeSequenceEnd(text: string, esc: number): number {
  const n = text.length;
  if (esc + 1 >= n) return n; // a lone trailing ESC — unterminated
  const next = text.charCodeAt(esc + 1);
  if (next === 0x5b /* [ */) {
    for (let i = esc + 2; i < n; i++) {
      const c = text.charCodeAt(i);
      if (c >= 0x40 && c <= 0x7e) return i + 1; // CSI final byte
    }
    return n;
  }
  if (next === 0x5d /* ] */) {
    for (let i = esc + 2; i < n; i++) {
      const c = text.charCodeAt(i);
      if (c === 0x07) return i + 1; // BEL terminator
      if (c === ESC && i + 1 < n && text.charCodeAt(i + 1) === 0x5c /* \ */) return i + 2; // ST
    }
    return n;
  }
  // Generic escape: optional intermediate bytes (0x20–0x2f) then one final byte.
  let i = esc + 1;
  while (i < n && text.charCodeAt(i) >= 0x20 && text.charCodeAt(i) <= 0x2f) i++;
  return i < n ? i + 1 : n;
}

/**
 * Adjust a head-trim cut so the retained tail `text.slice(cut)` never BEGINS in the middle of an escape
 * sequence. If the nearest ESC before `cut` opens a sequence that straddles `cut` (its end is at/after
 * `cut`), advance the cut to that sequence's end so the dangling remnant (`[31m`, `1m`, `m`, …) is dropped
 * — a half-cut ESC at the start would otherwise corrupt xterm's emulator. Returns `cut` unchanged when the
 * tail already starts on a clean boundary (normal text, or a complete sequence start).
 */
function escapeSafeCut(text: string, cut: number): number {
  let esc = -1;
  for (let i = cut - 1; i >= 0; i--) {
    if (text.charCodeAt(i) === ESC) {
      esc = i;
      break;
    }
  }
  if (esc === -1) return cut; // no ESC in the dropped head → the tail cannot start mid-sequence
  const end = escapeSequenceEnd(text, esc);
  return end > cut ? end : cut;
}

interface TranscriptSegment {
  offset: number;
  text: string;
}

export class AgentsConsoleVM {
  private _state: AgentsConsoleState = {
    roster: [],
    selectedAgentId: null,
    selectedStatus: null,
    transcript: '',
    transcriptError: null,
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
      transcriptError: null,
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
      transcriptError: null,
    };
    this.emit();
  }

  /**
   * Record a transcript-fetch failure for the selected agent. Ignored when `agentId` is not the current
   * selection (a stale/again-switched request must never clobber a fresh pane). Pairs with the renderer's
   * in-pane error + Retry (Principle 9 — no-silent-failures).
   */
  setTranscriptError(agentId: string, message: string): void {
    if (agentId !== this._state.selectedAgentId) return;
    this._state = { ...this._state, transcriptError: message };
    this.emit();
  }

  setTranscriptTail(tail: TranscriptTail): void {
    if (tail.agentId !== this._state.selectedAgentId) return;
    // A successful fetch clears any stale error. Empty tails still resolve the error (the fetch
    // succeeded) but `applyTranscriptSegment` short-circuits on empty text and would not emit — so
    // clear + emit here, then let `applyTranscriptSegment` emit the segment when there is text.
    const hadError = this._state.transcriptError != null;
    if (hadError) this._state = { ...this._state, transcriptError: null };
    if (tail.tail.length === 0) {
      if (hadError) this.emit();
      return;
    }
    this.applyTranscriptSegment(tail.offset, tail.tail);
  }

  appendChunk(chunk: OperatorIpcTranscript): void {
    if (chunk.agentId !== this._state.selectedAgentId) return;
    const resetPrefix = this.resetPrefixForLiveChunk(chunk.offset, chunk.chunk);
    if (resetPrefix != null) {
      this.transcriptSegments = resetPrefix.length > 0 ? [{ offset: 0, text: resetPrefix }] : [];
    }
    this.applyTranscriptSegment(chunk.offset, chunk.chunk);
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

    // Trim the head to the transcript bound. The cut is computed on the joined string (what xterm
    // consumes) and advanced past any dangling escape sequence so a half-cut ESC never lands at the START
    // of the retained transcript (which would corrupt xterm's emulator). The bound stays a MAX — the
    // escape-safety only ever drops a few extra leading bytes. The join allocation is skipped entirely in
    // the common (under-bound) case — total length is summed cheaply from the segments first.
    const total = merged.reduce((sum, segment) => sum + segment.text.length, 0);
    let remaining = 0;
    if (total > CONSOLE_TRANSCRIPT_MAX_CHARS) {
      const joined = merged.map((segment) => segment.text).join('');
      remaining = escapeSafeCut(joined, joined.length - CONSOLE_TRANSCRIPT_MAX_CHARS);
    }
    while (remaining > 0 && merged.length > 0) {
      const first = merged[0]!;
      const drop = Math.min(first.text.length, remaining);
      first.offset += drop;
      first.text = first.text.slice(drop);
      remaining -= drop;
      if (first.text.length === 0) merged.shift();
    }

    const transcript = merged.map((segment) => segment.text).join('');
    this.transcriptSegments = merged;
    this._state = {
      ...this._state,
      transcript: boundTranscript(transcript),
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
