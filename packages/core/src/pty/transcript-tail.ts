/**
 * Shared transcript retention policy for hosted terminal panes.
 *
 * The engine and desktop renderer both replay bounded raw terminal bytes into a fresh xterm. Keeping this
 * policy in core prevents the producer and consumer from drifting on escape boundaries or cap invariants.
 */

export const TRANSCRIPT_TAIL_MAX_CHARS = 64 * 1024;
export const TRANSCRIPT_TAIL_HARD_MAX_CHARS = 4 * TRANSCRIPT_TAIL_MAX_CHARS;

export interface RetainedTail {
  readonly tail: string;
  readonly dropped: number;
}

export interface TranscriptTailRetentionOptions {
  readonly softMaxChars: number;
  readonly hardMaxChars: number;
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
