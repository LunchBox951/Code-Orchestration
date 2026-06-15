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
    this.applyTranscriptSegment(chunk.offset, chunk.chunk);
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

    let total = merged.reduce((sum, segment) => sum + segment.text.length, 0);
    while (total > CONSOLE_TRANSCRIPT_MAX_CHARS && merged.length > 0) {
      const first = merged[0]!;
      const drop = Math.min(first.text.length, total - CONSOLE_TRANSCRIPT_MAX_CHARS);
      first.offset += drop;
      first.text = first.text.slice(drop);
      total -= drop;
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
