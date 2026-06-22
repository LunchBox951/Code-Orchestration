/**
 * [host-live capture] tests — the observation harness gating + record shaping (#77/#78).
 *
 * The harness is wired UNCONDITIONALLY into the real launch path, so the load-bearing property is:
 *   - UNSET env ⇒ INERT (armed=false, no `onPasteEcho`, every `capture*` a no-op, zero writes);
 *   - SET env ⇒ ARMED (`onPasteEcho` present, observations shaped + appended through the sink).
 * The sink is injected so the gating/shaping is proven WITHOUT real I/O or a live binary.
 */
import { describe, expect, it } from 'vitest';
import {
  CAPTURE_FILES,
  CO_HOST_LIVE_CAPTURE_ENV,
  injectCaptureOptions,
  openHostLiveCapture,
  type HostLiveCaptureSink,
} from './host-live-capture.js';

function recordingSink(): {
  sink: HostLiveCaptureSink;
  records: Array<{ file: string; record: unknown }>;
} {
  const records: Array<{ file: string; record: unknown }> = [];
  return { sink: { append: (file, record) => records.push({ file, record }) }, records };
}

describe('openHostLiveCapture — inert when the env is unset', () => {
  it('returns an INERT capture (armed=false, no onPasteEcho) when CO_HOST_LIVE_CAPTURE is unset', () => {
    const { sink, records } = recordingSink();
    const capture = openHostLiveCapture({}, sink);
    expect(capture.armed).toBe(false);
    expect(capture.onPasteEcho).toBeUndefined();
    // Every capture method is a no-op: it must not write a single record.
    capture.captureMcpApproval({
      agent: 'a',
      provider: 'codex',
      tool: 'co_finish',
      paneExcerpt: 'x',
      promptDetected: true,
    });
    capture.captureClaudeStatusLine({ agent: 'a', rawLine: 'usage 10%' });
    capture.captureUsageSample({
      provider: 'claude',
      account: 'claude:max',
      source: 'fake',
      raw: {},
    });
    expect(records).toHaveLength(0);
  });

  it('treats a blank/whitespace env value as unset (inert)', () => {
    expect(openHostLiveCapture({ [CO_HOST_LIVE_CAPTURE_ENV]: '   ' }).armed).toBe(false);
    expect(openHostLiveCapture({ [CO_HOST_LIVE_CAPTURE_ENV]: '' }).armed).toBe(false);
  });

  it('injectCaptureOptions adds NOTHING for an inert capture (no explicit onPasteEcho: undefined)', () => {
    const capture = openHostLiveCapture({});
    const spread = injectCaptureOptions(capture);
    expect('onPasteEcho' in spread).toBe(false);
    expect(Object.keys(spread)).toHaveLength(0);
  });
});

describe('openHostLiveCapture — armed when CO_HOST_LIVE_CAPTURE=<dir>', () => {
  const env = { [CO_HOST_LIVE_CAPTURE_ENV]: '/tmp/co-capture-test' };

  it('arms (armed=true, onPasteEcho present) and records a paste echo through the sink', () => {
    const { sink, records } = recordingSink();
    const capture = openHostLiveCapture(env, sink);
    expect(capture.armed).toBe(true);
    expect(typeof capture.onPasteEcho).toBe('function');

    capture.onPasteEcho!('[Pasted preview +12 lines]', true);
    expect(records).toHaveLength(1);
    expect(records[0]!.file).toBe(CAPTURE_FILES.pasteEcho);
    const rec = records[0]!.record as {
      multiline?: boolean;
      chunk?: string;
      chunkEscaped?: string;
    };
    expect(rec.multiline).toBe(true);
    expect(rec.chunk).toBe('[Pasted preview +12 lines]');
    // The escape-visible rendering round-trips through JSON (so a captured control byte is readable).
    expect(rec.chunkEscaped).toBe(JSON.stringify('[Pasted preview +12 lines]'));
  });

  it('routes each capture kind to its own file', () => {
    const { sink, records } = recordingSink();
    const capture = openHostLiveCapture(env, sink);
    capture.captureMcpApproval({
      agent: 'impl-1',
      provider: 'codex',
      tool: 'co_finish',
      paneExcerpt: 'Allow this MCP tool? (y/n)',
      promptDetected: true,
    });
    capture.captureClaudeStatusLine({ agent: 'impl-1', rawLine: 'context 42% used' });
    capture.captureUsageSample({
      provider: 'claude',
      account: 'claude:max',
      source: 'statusLine',
      raw: { used_pct: 42 },
    });
    expect(records.map((r) => r.file)).toEqual([
      CAPTURE_FILES.mcpApproval,
      CAPTURE_FILES.claudeStatusLine,
      CAPTURE_FILES.usageSample,
    ]);
  });

  it('injectCaptureOptions yields { onPasteEcho } for an armed capture', () => {
    const capture = openHostLiveCapture(env, recordingSink().sink);
    const spread = injectCaptureOptions(capture);
    expect('onPasteEcho' in spread).toBe(true);
    expect(typeof (spread as { onPasteEcho?: unknown }).onPasteEcho).toBe('function');
  });
});
