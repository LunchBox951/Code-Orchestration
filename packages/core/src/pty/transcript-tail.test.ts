import { describe, expect, it } from 'vitest';
import {
  retainTranscriptTail,
  transcriptTailFrom,
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
});
