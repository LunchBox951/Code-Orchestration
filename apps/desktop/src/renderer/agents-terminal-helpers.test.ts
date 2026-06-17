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
  constructor(private readonly order: string[]) {}
  loadAddon(addon: FitAddonLike): void {
    this.loadedAddons.push(addon);
    this.order.push('loadAddon');
  }
  open(): void {
    this.opened = true;
    this.order.push('open');
  }
  write(data: string): void {
    this.writes.push(data);
    this.order.push('write');
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

function setup() {
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

  it('disables stdin (the pane is read-only)', () => {
    expect(AGENTS_TERMINAL_OPTIONS.disableStdin).toBe(true);
  });
});

describe('createAgentsTerminal', () => {
  it('constructs the Terminal WITHOUT convertEol', () => {
    const s = setup();
    expect(s.optionsSeen).not.toBeNull();
    expect(s.optionsSeen && 'convertEol' in s.optionsSeen).toBe(false);
    expect(s.optionsSeen?.disableStdin).toBe(true);
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
