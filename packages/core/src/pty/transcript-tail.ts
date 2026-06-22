/**
 * Shared transcript retention policy for hosted terminal panes.
 *
 * The engine and desktop renderer both replay bounded raw terminal bytes into a fresh xterm. Keeping this
 * policy in core prevents the producer and consumer from drifting on escape boundaries or cap invariants.
 */

export const TRANSCRIPT_TAIL_MAX_CHARS = 64 * 1024;
export const TRANSCRIPT_TAIL_HARD_MAX_CHARS = 4 * TRANSCRIPT_TAIL_MAX_CHARS;
export const TRANSCRIPT_REPLAY_BOUNDARY_SCAN_OVERLAP = 16;

export interface RetainedTail {
  readonly tail: string;
  readonly dropped: number;
}

export interface TranscriptTailRetentionOptions {
  readonly softMaxChars: number;
  readonly hardMaxChars: number;
}

export type TranscriptReplayBoundaryKind = 'alt-screen-enter' | 'full-screen-clear';

export interface TranscriptReplayBoundary {
  readonly kind: TranscriptReplayBoundaryKind;
  readonly index: number;
  readonly end: number;
}

export interface TranscriptTailAccumulatorSnapshot {
  readonly tail: string;
  readonly offset: number;
  readonly nextOffset: number;
}

const CSI = '(?:\\u001B\\[|\\u009B)';

const ALT_SCREEN_ENTER = new RegExp(`${CSI}\\?(?:1049|1047|47)h`, 'g');
const FULL_SCREEN_CLEAR = new RegExp(`${CSI}[23]J`, 'g');

function lastBoundaryAtOrAfter(buffer: string, pattern: RegExp, minStart: number): number {
  pattern.lastIndex = minStart > 0 ? minStart : 0;
  let found = -1;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(buffer)) !== null) {
    found = m.index;
    if (m.index === pattern.lastIndex) pattern.lastIndex += 1;
  }
  pattern.lastIndex = 0;
  return found;
}

function collectBoundaryMatches(
  buffer: string,
  pattern: RegExp,
  kind: TranscriptReplayBoundaryKind,
  out: TranscriptReplayBoundary[],
): void {
  pattern.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(buffer)) !== null) {
    out.push({ kind, index: m.index, end: pattern.lastIndex });
    if (m.index === pattern.lastIndex) pattern.lastIndex += 1;
  }
  pattern.lastIndex = 0;
}

export function scanTranscriptReplayBoundaries(
  buffer: string,
): readonly TranscriptReplayBoundary[] {
  const out: TranscriptReplayBoundary[] = [];
  collectBoundaryMatches(buffer, ALT_SCREEN_ENTER, 'alt-screen-enter', out);
  collectBoundaryMatches(buffer, FULL_SCREEN_CLEAR, 'full-screen-clear', out);
  return out.sort((a, b) => a.index - b.index || a.end - b.end);
}

/**
 * Retain a bounded terminal transcript suffix while preferring replay-safe boundaries.
 *
 * Policy:
 * - under `softMaxChars`, keep the buffer verbatim;
 * - otherwise, anchor to the last reachable alt-screen enter inside the hard window;
 * - otherwise, snap to the last full-screen clear inside the soft window;
 * - otherwise, keep the flat most-recent soft window.
 */
export function retainTranscriptTail(
  buffer: string,
  options: TranscriptTailRetentionOptions,
): RetainedTail {
  const softMaxChars = Math.max(0, Math.floor(options.softMaxChars));
  const hardMaxChars = Math.max(softMaxChars, Math.floor(options.hardMaxChars));
  if (buffer.length <= softMaxChars) return { tail: buffer, dropped: 0 };

  const softStart = buffer.length - softMaxChars;
  const hardStart = Math.max(0, buffer.length - hardMaxChars);

  const altEnter = lastBoundaryAtOrAfter(buffer, ALT_SCREEN_ENTER, hardStart);
  if (altEnter !== -1) return { tail: buffer.slice(altEnter), dropped: altEnter };

  const clear = lastBoundaryAtOrAfter(buffer, FULL_SCREEN_CLEAR, softStart);
  const start = clear !== -1 ? clear : softStart;
  return { tail: buffer.slice(start), dropped: start };
}

export function transcriptTailFrom(buffer: string): RetainedTail {
  return retainTranscriptTail(buffer, {
    softMaxChars: TRANSCRIPT_TAIL_MAX_CHARS,
    hardMaxChars: TRANSCRIPT_TAIL_HARD_MAX_CHARS,
  });
}

export class TranscriptTailAccumulator {
  private readonly softMaxChars: number;
  private readonly hardMaxChars: number;
  private readonly scanOverlapChars: number;
  private tail = '';
  private offset = 0;
  private nextOffset = 0;
  private boundaryCarry = '';
  private lastAltEnterOffset: number | undefined;
  private lastClearOffset: number | undefined;

  constructor(options: Partial<TranscriptTailRetentionOptions> = {}) {
    this.softMaxChars = Math.max(0, Math.floor(options.softMaxChars ?? TRANSCRIPT_TAIL_MAX_CHARS));
    this.hardMaxChars = Math.max(
      this.softMaxChars,
      Math.floor(options.hardMaxChars ?? TRANSCRIPT_TAIL_HARD_MAX_CHARS),
    );
    this.scanOverlapChars = TRANSCRIPT_REPLAY_BOUNDARY_SCAN_OVERLAP;
  }

  snapshot(): TranscriptTailAccumulatorSnapshot {
    return { tail: this.tail, offset: this.offset, nextOffset: this.nextOffset };
  }

  clear(nextOffset = 0): TranscriptTailAccumulatorSnapshot {
    this.tail = '';
    this.offset = nextOffset;
    this.nextOffset = nextOffset;
    this.boundaryCarry = '';
    this.lastAltEnterOffset = undefined;
    this.lastClearOffset = undefined;
    return this.snapshot();
  }

  replace(tail: string, offset: number): TranscriptTailAccumulatorSnapshot {
    const retained = retainTranscriptTail(tail, {
      softMaxChars: this.softMaxChars,
      hardMaxChars: this.hardMaxChars,
    });
    this.tail = retained.tail;
    this.offset = offset + retained.dropped;
    this.nextOffset = this.offset + this.tail.length;
    this.boundaryCarry = this.tail.slice(-this.scanOverlapChars);
    this.lastAltEnterOffset = undefined;
    this.lastClearOffset = undefined;
    for (const boundary of scanTranscriptReplayBoundaries(this.tail)) {
      const absoluteIndex = this.offset + boundary.index;
      if (boundary.kind === 'alt-screen-enter') this.lastAltEnterOffset = absoluteIndex;
      else this.lastClearOffset = absoluteIndex;
    }
    return this.snapshot();
  }

  append(chunk: string): TranscriptTailAccumulatorSnapshot {
    if (chunk.length === 0) return this.snapshot();
    const chunkOffset = this.nextOffset;
    this.recordBoundaries(chunk, chunkOffset);
    const next = this.tail + chunk;
    this.nextOffset = chunkOffset + chunk.length;
    const retained = this.retain(next, this.offset, this.nextOffset);
    this.tail = retained.tail;
    this.offset = retained.offset;
    return this.snapshot();
  }

  private recordBoundaries(chunk: string, chunkOffset: number): void {
    const scanned = this.boundaryCarry + chunk;
    const scannedOffset = chunkOffset - this.boundaryCarry.length;
    for (const boundary of scanTranscriptReplayBoundaries(scanned)) {
      if (boundary.end <= this.boundaryCarry.length) continue;
      const absoluteIndex = scannedOffset + boundary.index;
      if (boundary.kind === 'alt-screen-enter') this.lastAltEnterOffset = absoluteIndex;
      else this.lastClearOffset = absoluteIndex;
    }
    this.boundaryCarry = scanned.slice(-this.scanOverlapChars);
  }

  private retain(
    buffer: string,
    bufferStartOffset: number,
    bufferEndOffset: number,
  ): { readonly tail: string; readonly offset: number } {
    if (buffer.length <= this.softMaxChars) {
      return { tail: buffer, offset: bufferStartOffset };
    }

    const softStart = bufferEndOffset - this.softMaxChars;
    const hardStart = bufferEndOffset - this.hardMaxChars;
    const start =
      this.lastAltEnterOffset != null &&
      this.lastAltEnterOffset >= hardStart &&
      this.lastAltEnterOffset >= bufferStartOffset
        ? this.lastAltEnterOffset
        : this.lastClearOffset != null &&
            this.lastClearOffset >= softStart &&
            this.lastClearOffset >= bufferStartOffset
          ? this.lastClearOffset
          : softStart;

    return { tail: buffer.slice(start - bufferStartOffset), offset: start };
  }
}
