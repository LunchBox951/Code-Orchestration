import { describe, it, expect } from 'vitest';
import {
  detectTurnEnd,
  parseOsc0Titles,
  QUIET_WINDOW_MS,
  type DetectorEvent,
} from './turn-end-detector.js';

const ESC = '\u001B';
const BEL = '\u0007';

describe('detectTurnEnd — byte-quiescence is the necessary idle gate (AC-L7-4)', () => {
  it('working→idle: continuous bytes then a >= quiet-window gap → idle, no completion emitted', () => {
    const trace: DetectorEvent[] = [];
    for (let t = 0; t <= 2000; t += 250) trace.push({ kind: 'bytes', at: t, bytes: 120 });
    const observedAt = 2000 + QUIET_WINDOW_MS + 100; // 2.6 s since the last byte

    const r = detectTurnEnd(trace, observedAt, { provider: 'claude' });

    expect(r.idle).toBe(true);
    expect(r.idleSignals).toContain('byte-quiescence');
    expect(r.sawCompletionVerb).toBe(false);
  });

  it('CRITICAL must-not-regress: idle WITHOUT co_finish in the call-log emits NO completion', () => {
    // turn-end ≠ work-end: the turn is byte-idle, but no terminal verb arrived, so completion is NOT
    // implied. Only co_finish/worker_done (elsewhere) completes work — this detector merely reports.
    const trace: DetectorEvent[] = [
      { kind: 'bytes', at: 0 },
      { kind: 'bytes', at: 500 },
      { kind: 'bytes', at: 1000 },
      { kind: 'mcp', at: 600, verb: 'co_mail_send' }, // turn activity, but NOT a completion verb
    ];

    const r = detectTurnEnd(trace, 1000 + QUIET_WINDOW_MS + 1, { provider: 'claude' });

    expect(r.idle).toBe(true); // the turn went idle…
    expect(r.sawCompletionVerb).toBe(false); // …but no completion verb was seen
    // The verdict type has NO completion field — the detector cannot express "work done".
    expect(Object.keys(r).sort()).toEqual(['idle', 'idleSignals', 'sawCompletionVerb']);
  });

  it('reports sawCompletionVerb when co_finish IS present, but still ONLY reports (no emission path)', () => {
    const trace: DetectorEvent[] = [
      { kind: 'bytes', at: 0 },
      { kind: 'bytes', at: 800 },
      { kind: 'mcp', at: 700, verb: 'co_finish' },
    ];

    const r = detectTurnEnd(trace, 800 + QUIET_WINDOW_MS + 1, { provider: 'claude' });

    expect(r.sawCompletionVerb).toBe(true);
    expect(r.idle).toBe(true);
    expect(Object.keys(r).sort()).toEqual(['idle', 'idleSignals', 'sawCompletionVerb']);
  });

  it('long-silent-but-working: a long turn whose spinner keeps rendering bytes is NOT idle', () => {
    const trace: DetectorEvent[] = [];
    for (let t = 0; t <= 30000; t += 200) trace.push({ kind: 'bytes', at: t, bytes: 80 }); // spinner frames
    const observedAt = 30000 + 100; // only 100 ms since the last spinner frame

    const r = detectTurnEnd(trace, observedAt, { provider: 'claude' });

    expect(r.idle).toBe(false); // bytes still flowing ⇒ alive
    expect(r.idleSignals).toEqual([]);
  });
});

describe('detectTurnEnd — OSC0 corroboration (codex edge; claude ✳ is not an edge)', () => {
  it('codex OSC0 idle edge: plain-dirname title corroborates idle (codex-osc0 signal)', () => {
    const trace: DetectorEvent[] = [
      { kind: 'bytes', at: 0 },
      { kind: 'bytes', at: 500 },
      { kind: 'bytes', at: 1000 },
      { kind: 'osc0', at: 200, title: '⠋ my-project' }, // working: braille spinner + dirname
      { kind: 'osc0', at: 1005, title: 'my-project' }, // idle edge: plain dirname
    ];

    const r = detectTurnEnd(trace, 1000 + QUIET_WINDOW_MS + 1, { provider: 'codex' });

    expect(r.idle).toBe(true);
    expect(r.idleSignals).toContain('byte-quiescence');
    expect(r.idleSignals).toContain('codex-osc0');
  });

  it('codex still-working: spinner title + bytes flowing → not idle (OSC0 never overrides liveness)', () => {
    const trace: DetectorEvent[] = [
      { kind: 'bytes', at: 0 },
      { kind: 'bytes', at: 1000 },
      { kind: 'osc0', at: 1000, title: '⠹ my-project' }, // still spinning
    ];

    const r = detectTurnEnd(trace, 1100, { provider: 'codex' }); // only 100 ms quiet

    expect(r.idle).toBe(false);
    expect(r.idleSignals).toEqual([]);
  });

  it('claude ✳-persisting: a title that keeps the ✳ at idle still goes idle on byte-quiescence', () => {
    const trace: DetectorEvent[] = [
      { kind: 'bytes', at: 0 },
      { kind: 'bytes', at: 1000 },
      { kind: 'osc0', at: 1000, title: '✳ Forging' }, // ✳ persists at idle — activity glyph, not "working"
    ];

    const r = detectTurnEnd(trace, 1000 + QUIET_WINDOW_MS + 1, { provider: 'claude' });

    expect(r.idle).toBe(true); // byte-quiescence wins; the persistent ✳ does NOT hang detection
    expect(r.idleSignals).toEqual(['byte-quiescence', 'mcp-quiescence']); // no codex-osc0 for claude
  });
});

describe('detectTurnEnd — MCP-sentinel corroborates only alongside byte-quiet', () => {
  it('a recent MCP call does not block the byte-governed idle, and is not reported as quiescent', () => {
    const trace: DetectorEvent[] = [
      { kind: 'bytes', at: 0 },
      { kind: 'bytes', at: 100 },
      { kind: 'mcp', at: 3000, verb: 'co_status' }, // a recent-ish call after bytes went quiet
    ];

    const r = detectTurnEnd(trace, 3100, { provider: 'claude' }); // bytes quiet since t=100 (3.0 s)

    expect(r.idle).toBe(true); // byte-quiescence governs
    expect(r.idleSignals).toContain('byte-quiescence');
    expect(r.idleSignals).not.toContain('mcp-quiescence'); // the MCP call was only 100 ms ago
  });
});

describe('parseOsc0Titles — pure OSC-0 extraction from raw pty bytes', () => {
  it('extracts BEL- and ST-terminated titles in order', () => {
    const chunk = `before${ESC}]0;⠋ my-project${BEL}middle${ESC}]0;my-project${ESC}\\after`;
    expect(parseOsc0Titles(chunk)).toEqual(['⠋ my-project', 'my-project']);
  });

  it('returns [] when no OSC-0 title is present', () => {
    expect(parseOsc0Titles('plain output, no title set')).toEqual([]);
  });
});
