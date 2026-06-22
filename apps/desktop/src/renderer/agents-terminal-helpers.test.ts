import { describe, it, expect } from 'vitest';
import {
  AGENTS_TERMINAL_OPTIONS,
  applyTermFeed,
  createAgentsTerminal,
  decideTermFeed,
  type AgentsTerminalOptions,
  type FitAddonLike,
  type FitTerminalLike,
  type TermWriter,
} from './agents-terminal-helpers.js';

// ANSI/ESC bytes are built from a char code — never pasted raw into source (raw control bytes corrupt
// the file). 0x1b is ESC; 0x07 is BEL.
const ESC = String.fromCharCode(0x1b);

// A fake xterm Terminal: records construction wiring + raw writes into a shared order log so a test can
// assert call ORDERING (loadAddon → open → fit) without a DOM.
class FakeTerminal implements FitTerminalLike, TermWriter {
  readonly loadedAddons: FitAddonLike[] = [];
  readonly writes: string[] = [];
  resets = 0;
  opened = false;
  cols = 80;
  rows = 24;
  dataCb: ((data: string) => void) | null = null;
  dataOnWrite: string | null = null;
  pendingWriteCallback: (() => void) | null = null;
  constructor(private readonly order: string[]) {}
  loadAddon(addon: FitAddonLike): void {
    this.loadedAddons.push(addon);
    this.order.push('loadAddon');
  }
  open(): void {
    this.opened = true;
    this.order.push('open');
  }
  onData(cb: (data: string) => void): void {
    this.dataCb = cb;
    this.order.push('onData');
  }
  write(data: string, callback?: () => void): void {
    this.writes.push(data);
    this.order.push('write');
    if (this.dataOnWrite != null) this.dataCb?.(this.dataOnWrite);
    this.pendingWriteCallback = callback ?? null;
  }
  reset(): void {
    this.resets++;
    this.order.push('reset');
  }
}

class FakeFitAddon implements FitAddonLike {
  fits = 0;
  constructor(private readonly order: string[]) {}
  fit(): void {
    this.fits++;
    this.order.push('fit');
  }
}

function setup(io?: {
  onInput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
}) {
  const order: string[] = [];
  const term = new FakeTerminal(order);
  const fit = new FakeFitAddon(order);
  let optionsSeen: AgentsTerminalOptions | null = null;
  let resizeCb: (() => void) | null = null;
  let observedEl: HTMLElement | null = null;
  const el = {} as unknown as HTMLElement;

  const result = createAgentsTerminal<FakeTerminal>(el, {
    createTerminal: (options) => {
      optionsSeen = options;
      order.push('createTerminal');
      return term;
    },
    createFitAddon: () => fit,
    observeResize: (target, onResize) => {
      observedEl = target;
      resizeCb = onResize;
    },
    ...(io?.onInput ? { onInput: io.onInput } : {}),
    ...(io?.onResize ? { onResize: io.onResize } : {}),
  });

  return {
    order,
    term,
    fit,
    el,
    result,
    get optionsSeen() {
      return optionsSeen;
    },
    get resizeCb() {
      return resizeCb;
    },
    get observedEl() {
      return observedEl;
    },
  };
}

describe('AGENTS_TERMINAL_OPTIONS', () => {
  it('does NOT set convertEol (the raw cursor-addressed stream must not be \\n→\\r\\n rewritten)', () => {
    expect('convertEol' in AGENTS_TERMINAL_OPTIONS).toBe(false);
  });

  it('ENABLES stdin (the pane is interactive — the operator types/answers/steers in-pane)', () => {
    expect(AGENTS_TERMINAL_OPTIONS.disableStdin).toBe(false);
  });

  it('pins a fixed IBM Plex Mono cell grid (stable measurement — the anti-warp requirement)', () => {
    expect(AGENTS_TERMINAL_OPTIONS.fontFamily).toMatch(/IBM Plex Mono/);
    expect(AGENTS_TERMINAL_OPTIONS.fontSize).toBeGreaterThan(0);
    expect(AGENTS_TERMINAL_OPTIONS.lineHeight).toBeGreaterThan(0);
  });
});

describe('createAgentsTerminal', () => {
  it('constructs the Terminal WITHOUT convertEol, with stdin enabled', () => {
    const s = setup();
    expect(s.optionsSeen).not.toBeNull();
    expect(s.optionsSeen && 'convertEol' in s.optionsSeen).toBe(false);
    expect(s.optionsSeen?.disableStdin).toBe(false);
  });

  it('forwards xterm keystrokes to onInput (interactive stdin → hosted pty)', () => {
    const typed: string[] = [];
    const s = setup({ onInput: (d) => typed.push(d) });
    expect(s.term.dataCb).not.toBeNull();
    s.term.dataCb?.('1');
    s.term.dataCb?.('\r');
    expect(typed).toEqual(['1', '\r']);
  });

  it('does NOT wire onData when no onInput is provided (stays read-only)', () => {
    const s = setup();
    expect(s.term.dataCb).toBeNull();
    expect(s.order).not.toContain('onData');
  });

  it('reports the fitted grid via onResize — initially and on every pane resize (width-agreement)', () => {
    const dims: Array<[number, number]> = [];
    const s = setup({ onResize: (cols, rows) => dims.push([cols, rows]) });
    // Initial report uses the terminal's measured cols/rows after fit().
    expect(dims).toEqual([[80, 24]]);
    // A pane resize re-fits AND re-reports the (possibly new) grid.
    s.term.cols = 120;
    s.term.rows = 30;
    s.resizeCb?.();
    expect(dims).toEqual([
      [80, 24],
      [120, 30],
    ]);
  });

  it('loads the fit addon onto the terminal', () => {
    const s = setup();
    expect(s.term.loadedAddons).toHaveLength(1);
    expect(s.term.loadedAddons[0]).toBe(s.fit);
  });

  it('fits AFTER open (open mounts the element; the addon measures the mounted pane)', () => {
    const s = setup();
    expect(s.term.opened).toBe(true);
    expect(s.fit.fits).toBe(1);
    // loadAddon before open before fit.
    expect(s.order).toEqual(['createTerminal', 'loadAddon', 'open', 'fit']);
  });

  it('re-fits when the ResizeObserver callback fires', () => {
    const s = setup();
    expect(s.fit.fits).toBe(1);
    expect(s.observedEl).toBe(s.el);
    expect(s.resizeCb).not.toBeNull();
    s.resizeCb?.();
    expect(s.fit.fits).toBe(2);
    s.resizeCb?.();
    expect(s.fit.fits).toBe(3);
  });

  it('returns the constructed terminal and its fit addon', () => {
    const s = setup();
    expect(s.result.term).toBe(s.term);
    expect(s.result.fit).toBe(s.fit);
  });
});

describe('decideTermFeed', () => {
  it('resets + writes the whole transcript on agent switch', () => {
    const feed = decideTermFeed({
      selectedAgentId: 'a2',
      lastAgentId: 'a1',
      transcript: 'hello',
      lastTranscript: 'previous',
    });
    expect(feed).toEqual({ kind: 'reset', data: 'hello' });
  });

  it('appends only the delta when the transcript grew (same agent, prefix match)', () => {
    const feed = decideTermFeed({
      selectedAgentId: 'a1',
      lastAgentId: 'a1',
      transcript: 'line1\nline2\n',
      lastTranscript: 'line1\n',
    });
    expect(feed).toEqual({ kind: 'append', data: 'line2\n' });
  });

  it('is a no-op when the transcript is unchanged', () => {
    const feed = decideTermFeed({
      selectedAgentId: 'a1',
      lastAgentId: 'a1',
      transcript: 'same',
      lastTranscript: 'same',
    });
    expect(feed).toEqual({ kind: 'noop' });
  });

  it('appends only new bytes when the retained transcript window front-trimmed', () => {
    const feed = decideTermFeed({
      selectedAgentId: 'a1',
      lastAgentId: 'a1',
      lastTranscript: 'abcdefghij',
      lastTranscriptOffset: 100,
      transcript: 'efghijKL',
      transcriptOffset: 104,
    });

    expect(feed).toEqual({ kind: 'append', data: 'KL' });
  });

  it('appends only the delta when offsets are unchanged and the retained window grew', () => {
    const feed = decideTermFeed({
      selectedAgentId: 'a1',
      lastAgentId: 'a1',
      lastTranscript: 'frame',
      lastTranscriptOffset: 100,
      transcript: 'frame-next',
      transcriptOffset: 100,
    });

    expect(feed).toEqual({ kind: 'append', data: '-next' });
  });

  it('resets when transcript generation changes even if offset and prefix look appendable', () => {
    const feed = decideTermFeed({
      selectedAgentId: 'a1',
      lastAgentId: 'a1',
      lastTranscript: 'startup',
      lastTranscriptGeneration: 1,
      lastTranscriptOffset: 0,
      transcript: 'startup fresh',
      transcriptGeneration: 2,
      transcriptOffset: 0,
    });

    expect(feed).toEqual({ kind: 'reset', data: 'startup fresh' });
  });

  it('resets when transcript offsets rewind even if the new text shares the old prefix', () => {
    const feed = decideTermFeed({
      selectedAgentId: 'a1',
      lastAgentId: 'a1',
      lastTranscript: 'hello',
      lastTranscriptOffset: 100,
      transcript: 'hello world',
      transcriptOffset: 0,
    });

    expect(feed).toEqual({ kind: 'reset', data: 'hello world' });
  });

  it('resets when absolute overlap bytes do not match', () => {
    const feed = decideTermFeed({
      selectedAgentId: 'a1',
      lastAgentId: 'a1',
      lastTranscript: 'ABCDE',
      lastTranscriptOffset: 100,
      transcript: 'XY',
      transcriptOffset: 102,
    });

    expect(feed).toEqual({ kind: 'reset', data: 'XY' });
  });

  it('resets + rewrites on a non-prefix change (truncation / new generation)', () => {
    const feed = decideTermFeed({
      selectedAgentId: 'a1',
      lastAgentId: 'a1',
      transcript: 'totally different',
      lastTranscript: 'line1\n',
    });
    expect(feed).toEqual({ kind: 'reset', data: 'totally different' });
  });
});

describe('applyTermFeed — raw bytes are written VERBATIM', () => {
  function fakeWriter() {
    const order: string[] = [];
    return new FakeTerminal(order);
  }

  it('reset feed: resets then writes the exact bytes (ANSI/ESC preserved byte-for-byte)', () => {
    const term = fakeWriter();
    // A cursor-addressed frame: red SGR, text, reset SGR, CR, cursor-up — exactly the kind of bytes the
    // bug garbled. It must reach the terminal unchanged.
    const raw = `${ESC}[31m✻ Canoodling… 3s${ESC}[0m\r${ESC}[1A`;
    applyTermFeed(term, { kind: 'reset', data: raw });
    expect(term.resets).toBe(1);
    expect(term.writes).toEqual([raw]);
    expect(term.writes[0]).toBe(raw); // byte-for-byte
  });

  it('append feed: writes the exact delta bytes, no reset', () => {
    const term = fakeWriter();
    const delta = `attempt 2/10${ESC}[0m\n`;
    applyTermFeed(term, { kind: 'append', data: delta });
    expect(term.resets).toBe(0);
    expect(term.writes).toEqual([delta]);
  });

  it('reset feed with empty data: resets but writes nothing', () => {
    const term = fakeWriter();
    applyTermFeed(term, { kind: 'reset', data: '' });
    expect(term.resets).toBe(1);
    expect(term.writes).toEqual([]);
  });

  it('suppresses xterm-generated onData while replay writes are being parsed', () => {
    const typed: string[] = [];
    const s = setup({ onInput: (d) => typed.push(d) });
    s.term.dataOnWrite = ESC + '[1;1R';

    applyTermFeed(s.term, { kind: 'reset', data: ESC + '[6n' }, s.result.inputGuard);

    expect(typed).toEqual([]);
    s.term.dataCb?.('k');
    expect(typed).toEqual([]);

    s.term.pendingWriteCallback?.();
    s.term.dataCb?.('k');
    expect(typed).toEqual(['k']);
  });

  it('noop feed: neither resets nor writes', () => {
    const term = fakeWriter();
    applyTermFeed(term, { kind: 'noop' });
    expect(term.resets).toBe(0);
    expect(term.writes).toEqual([]);
  });

  it('end-to-end: decide → apply round-trips raw ESC bytes verbatim on agent switch', () => {
    const term = fakeWriter();
    const raw = `${ESC}[2J${ESC}[H${ESC}[32mready${ESC}[0m`;
    applyTermFeed(
      term,
      decideTermFeed({
        selectedAgentId: 'a1',
        lastAgentId: null,
        transcript: raw,
        lastTranscript: '',
      }),
    );
    expect(term.resets).toBe(1);
    expect(term.writes).toEqual([raw]);
  });
});
