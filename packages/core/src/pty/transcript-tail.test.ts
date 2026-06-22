import { describe, expect, it } from 'vitest';
import {
  retainTranscriptTail,
  scanTranscriptReplayBoundaries,
  transcriptTailFrom,
  TranscriptTailAccumulator,
  TRANSCRIPT_TAIL_HARD_MAX_CHARS,
  TRANSCRIPT_TAIL_MAX_CHARS,
} from './transcript-tail.js';

const ESC = '\u001B';
const CSI = '\u009B';
const ALT_ENTER = ESC + '[?1049h';
const C1_ALT_ENTER = CSI + '?1049h';

describe('transcript tail retention policy', () => {
  it('recognizes C1 CSI alt-screen enter and clear boundaries', () => {
    const c1Alt = C1_ALT_ENTER + 'F'.repeat(TRANSCRIPT_TAIL_MAX_CHARS * 2);
    expect(transcriptTailFrom(c1Alt).tail.startsWith(C1_ALT_ENTER)).toBe(true);

    const c1Clear = 'P'.repeat(TRANSCRIPT_TAIL_MAX_CHARS) + CSI + '2J' + CSI + 'Hfresh';
    expect(transcriptTailFrom(c1Clear).tail.startsWith(CSI + '2J')).toBe(true);
  });

  it('can apply the same boundary policy with a renderer-sized hard cap', () => {
    const rendererCap = 8 * 64 * 1024;
    const head = 'H'.repeat(rendererCap);
    const clearFrame = ESC + '[2J' + ESC + '[Hfresh frame';
    const retained = retainTranscriptTail(head + clearFrame, {
      softMaxChars: rendererCap,
      hardMaxChars: rendererCap,
    });

    expect(retained.tail).toBe(clearFrame);
    expect(retained.dropped).toBe(head.length);
  });

  it('exports the engine soft and hard ceilings as one shared contract', () => {
    expect(TRANSCRIPT_TAIL_MAX_CHARS).toBe(64 * 1024);
    expect(TRANSCRIPT_TAIL_HARD_MAX_CHARS).toBe(4 * TRANSCRIPT_TAIL_MAX_CHARS);

    const staleAlt = ALT_ENTER + 'x'.repeat(TRANSCRIPT_TAIL_HARD_MAX_CHARS);
    expect(transcriptTailFrom(staleAlt).tail).toHaveLength(TRANSCRIPT_TAIL_MAX_CHARS);
  });

  it('exposes the shared boundary scanner for incremental engine retention', () => {
    const input = `older${ALT_ENTER}frame${CSI}2Jfresh${C1_ALT_ENTER}new`;

    expect(scanTranscriptReplayBoundaries(input)).toEqual([
      { kind: 'alt-screen-enter', index: 'older'.length, end: 'older'.length + ALT_ENTER.length },
      {
        kind: 'full-screen-clear',
        index: 'older'.length + ALT_ENTER.length + 'frame'.length,
        end: 'older'.length + ALT_ENTER.length + 'frame'.length + (CSI + '2J').length,
      },
      {
        kind: 'alt-screen-enter',
        index: 'older'.length + ALT_ENTER.length + 'frame'.length + (CSI + '2Jfresh').length,
        end:
          'older'.length +
          ALT_ENTER.length +
          'frame'.length +
          (CSI + '2Jfresh').length +
          C1_ALT_ENTER.length,
      },
    ]);
  });

  it('incrementally retains the same alt-screen tail as the pure helper', () => {
    const accumulator = new TranscriptTailAccumulator();
    accumulator.append(ALT_ENTER + ESC + '[2J');
    accumulator.append('F'.repeat(TRANSCRIPT_TAIL_MAX_CHARS));
    const snapshot = accumulator.append('F'.repeat(20_000) + 'LIVE');
    const full = ALT_ENTER + ESC + '[2J' + 'F'.repeat(TRANSCRIPT_TAIL_MAX_CHARS + 20_000) + 'LIVE';

    expect(snapshot).toEqual({
      tail: transcriptTailFrom(full).tail,
      offset: transcriptTailFrom(full).dropped,
      nextOffset: full.length,
    });
  });

  it('recognizes replay boundaries split across accumulator appends', () => {
    const accumulator = new TranscriptTailAccumulator();
    accumulator.append(C1_ALT_ENTER.slice(0, 2));
    accumulator.append(C1_ALT_ENTER.slice(2));
    const snapshot = accumulator.append('F'.repeat(TRANSCRIPT_TAIL_MAX_CHARS + 1_000));

    expect(snapshot.tail.startsWith(C1_ALT_ENTER)).toBe(true);
    expect(snapshot.offset).toBe(0);
  });

  it('can replace an existing bounded window at a nonzero absolute offset', () => {
    const accumulator = new TranscriptTailAccumulator({ softMaxChars: 10, hardMaxChars: 20 });
    accumulator.replace('older' + ESC + '[2Jfresh', 100);
    const snapshot = accumulator.append('!');

    expect(snapshot.tail).toBe(ESC + '[2Jfresh!');
    expect(snapshot.offset).toBe(105);
    expect(snapshot.nextOffset).toBe(115);
  });
});
