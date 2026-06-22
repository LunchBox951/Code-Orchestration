import { assertNever } from '@co/core';
import type {
  OperatorObservation,
  AgentLiveView,
  AgentRecord,
  OperatorIpcTranscript,
  TranscriptTail,
} from '@co/core';
import type { AgentStatus } from './dashboard-vm.js';

/**
 * #66 sub-bug B — the renderer-side bound on the reconstructed transcript. Kept in lockstep with the
 * engine's HARD ceiling (`TRANSCRIPT_TAIL_HARD_MAX_CHARS` in `@co/mcp` — 4 × 64 KiB = 256 KiB), NOT the
 * old flat 64 KiB. The engine now retains its tail back to the last alternate-screen-enter (`ESC[?1049h`)
 * so the alt-screen setup an interactive TUI needs to replay cleanly is never sliced away — up to that
 * 256 KiB ceiling. Bounding the renderer to the SAME ceiling means this VM never re-slices below what the
 * engine carefully preserved (which would re-drop the `ESC[?1049h` and re-introduce the stacked-frame
 * garble). Mirrored as a literal — desktop imports `@co/core`/`@co/mcp` but this stays the single
 * renderer knob; if the engine ceiling changes, change this with it.
 */
export const CONSOLE_TRANSCRIPT_MAX_CHARS = 4 * 64 * 1024;

/**
 * The alternate-screen-ENTER control sequence — DEC private mode SET for 1049 (and the legacy 1047 / 47
 * curses variants): `ESC[?1049h`, `ESC[?1047h`, `ESC[?47h`. Mirrors `ALT_SCREEN_ENTER` in the engine
 * (`@co/mcp` `transcriptTailFrom`). Built via `new RegExp` with `\u` escapes so the SOURCE holds no raw
 * control byte (C2 — pristine-repo; the control char only exists at runtime). An interactive TUI emits
 * this ONCE early to switch xterm into its own buffer; it is the load-bearing frame boundary the
 * reconstructed transcript must retain. `g` flag — {@link boundConsoleTranscript} scans for the LAST match.
 */
const CONSOLE_ALT_SCREEN_ENTER = new RegExp(
  // eslint-disable-next-line no-control-regex
  '[\\u001B\\u009B]\\[\\?(?:1049|1047|47)h',
  'g',
);

/**
 * Index of the LAST match of `pattern` at-or-after `minStart` in `buffer`, or `-1` when there is none.
 * Mirrors `lastBoundaryAtOrAfter` in the engine. `pattern` MUST carry the `g` flag (so `exec` advances);
 * `lastIndex` is reset on entry and left clean on exit so the shared module-level regex is reusable.
 */
function lastConsoleBoundaryAtOrAfter(buffer: string, pattern: RegExp, minStart: number): number {
  pattern.lastIndex = minStart > 0 ? minStart : 0;
  let found = -1;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(buffer)) !== null) {
    found = m.index;
    // Guard against a zero-width match wedging the loop (defensive — these patterns are non-empty).
    if (m.index === pattern.lastIndex) pattern.lastIndex += 1;
  }
  pattern.lastIndex = 0;
  return found;
}

/**
 * #66 sub-bug B — bound the renderer-side reconstructed transcript WITHOUT slicing away the early
 * alternate-screen-enter (`ESC[?1049h`) that an interactive TUI emits ONCE to switch xterm into its own
 * buffer. PURE (no I/O, no mutation, deterministic) and exported so it is unit-testable WITHOUT loading
 * electron. Mirrors the engine's `transcriptTailFrom` anchoring policy (`@co/mcp`), bounded to the single
 * {@link CONSOLE_TRANSCRIPT_MAX_CHARS} ceiling the renderer keeps:
 *
 *  - Under the cap: the whole `text` is kept verbatim (the common case — byte-for-byte unchanged).
 *  - Over the cap: the kept window is the most-recent {@link CONSOLE_TRANSCRIPT_MAX_CHARS} chars, but the
 *    front-drop is anchored so it NEVER cuts past the LAST `ESC[?1049h` inside that window — the start is
 *    moved BACK to that enter so the alt-screen setup leads the kept transcript. Anchoring only ever keeps
 *    the same or LESS than the flat window (the enter sits at-or-after the flat start), so the footprint
 *    stays ≤ the cap. If no enter lives in the window, this is exactly the old flat most-recent-N drop.
 *
 * Without this, the old alt-screen-UNAWARE flat front-drop slices off the leading `ESC[?1049h` on any long
 * session; `decideTermFeed` then `reset()`s and rewrites the alt-stripped transcript → the #66 garble.
 */
export function boundConsoleTranscript(text: string): string {
  if (text.length <= CONSOLE_TRANSCRIPT_MAX_CHARS) return text;
  const flatStart = text.length - CONSOLE_TRANSCRIPT_MAX_CHARS;
  // Anchor at the last alt-screen-enter within the kept window so the setup is never sliced away.
  const altEnter = lastConsoleBoundaryAtOrAfter(text, CONSOLE_ALT_SCREEN_ENTER, flatStart);
  const start = altEnter !== -1 ? altEnter : flatStart;
  return text.slice(start);
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

export class AgentsConsoleVM {
  private _state: AgentsConsoleState = {
    roster: [],
    selectedAgentId: null,
    selectedStatus: null,
    transcript: '',
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
    };
    this.emit();
  }

  setTranscriptTail(tail: TranscriptTail): void {
    if (tail.agentId !== this._state.selectedAgentId) return;
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

    // Bound the segment store with the SAME alt-screen-aware policy as the displayed transcript so the
    // store and `state.transcript` stay in lockstep AND the leading `ESC[?1049h` survives into the join.
    // A flat front-drop here (the old logic) would strip the early alt-screen-enter from the store before
    // `boundConsoleTranscript` ever saw it, so the displayed bound could not recover it (#66 sub-bug B).
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
