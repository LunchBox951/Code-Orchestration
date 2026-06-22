/**
 * Pure / injectable helpers for the live-session terminal in the Agents view
 * (Stage 15 · GitHub #40 — a FAITHFUL, INTERACTIVE in-app terminal).
 *
 * THE BUG (operator-filed, screenshot-confirmed): the Agents transcript renders garbled — stacked
 * in-place-redraw frames (claude's `✻ …` spinner and the `attempt N/10` retry counter pile up on top of
 * each other with `────` artifacts), wrong-width wrapping, AND it was read-only so the operator could not
 * answer a permission prompt or steer by typing. Three coupled causes, all fixed here:
 *   1. No fit / no width-agreement — the hosted pty ran at a fixed grid while the xterm fit narrower, so
 *      cursor-addressed redraws (`\r`, cursor-up) landed on the wrong visual row. FIX: fit the xterm AND
 *      drive `PTY.resize(cols, rows)` from the fitted grid so the pty's idea of the grid matches the
 *      rendered grid (the design's anti-warp requirement — a warped pane is almost always a pty whose
 *      cols/rows don't match the element).
 *   2. `convertEol` on a raw cursor-addressed stream rewrites `\n` → `\r\n` and corrupts an already
 *      CR/LF-correct TUI stream. FIX: never set `convertEol`; feed the raw bytes verbatim and let xterm's
 *      emulator own alt-screen + cursor addressing.
 *   3. Read-only (`disableStdin`) — the operator could not type. FIX: stdin is ENABLED and `onData`
 *      forwards every keystroke to the hosted pty's stdin (the operator answers prompts / steers in-pane,
 *      exactly like a terminal on their desktop).
 *
 * A faithful terminal needs a STABLE monospace cell grid: a fixed `IBM Plex Mono` (bundled woff2,
 * preloaded — the renderer gates terminal construction on `document.fonts.ready`) with a fixed font-size
 * and line-height. A mismeasured/proportional fallback font is the other classic warp source.
 *
 * These helpers isolate the construction + I/O wiring behind minimal structural interfaces so they are
 * unit-testable WITHOUT a DOM (this repo has no jsdom/happy-dom) — mirroring how `review-render-helpers.ts`
 * / `live-render-helpers.ts` stay framework-free.
 */

// ── Terminal construction options ──────────────────────────────────────────────

/**
 * The xterm construction options for the Agents terminal. `convertEol` is deliberately ABSENT (raw,
 * cursor-addressed stream). `disableStdin` is `false` — the pane is INTERACTIVE; `onData` (wired in
 * {@link createAgentsTerminal}) forwards keystrokes to the hosted pty. The fixed `IBM Plex Mono` grid is
 * what lets xterm measure stable cells (the anti-warp requirement).
 */
export interface AgentsTerminalOptions {
  readonly disableStdin: boolean;
  readonly cursorBlink: boolean;
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly scrollback: number;
  readonly theme: Readonly<Record<string, string>>;
}

export const AGENTS_TERMINAL_OPTIONS: AgentsTerminalOptions = {
  disableStdin: false,
  cursorBlink: true,
  // Bundled, preloaded IBM Plex Mono — a fixed monospace metric (no proportional fallback) so the cell
  // grid is stable. `monospace` is only a last-resort fallback if the woff2 somehow failed to load.
  fontFamily: "'IBM Plex Mono', ui-monospace, monospace",
  fontSize: 12,
  lineHeight: 1.35,
  scrollback: 5000,
  // Matches the cockpit `bg/base` / `text/body` tokens. xterm parses hex reliably; the sRGB hexes below
  // approximate the OKLCH surface tokens so the terminal reads as one surface with the app.
  theme: {
    background: '#0e0f13',
    foreground: '#d4d7dd',
    cursor: '#7aa2f7',
    cursorAccent: '#0e0f13',
    selectionBackground: '#2b3552',
  },
};

/** Minimal structural view of the xterm fit addon (UMD `window.FitAddon.FitAddon`). */
export interface FitAddonLike {
  fit(): void;
}

/**
 * Minimal structural view of the xterm Terminal this module wires: construction (loadAddon + open), the
 * interactive input hook (`onData`), and the measured grid dimensions (`cols`/`rows`, read AFTER `fit`).
 */
export interface FitTerminalLike {
  loadAddon(addon: FitAddonLike): void;
  open(el: HTMLElement): void;
  onData(cb: (data: string) => void): void;
  readonly cols: number;
  readonly rows: number;
}

/**
 * xterm can synchronously emit device/status replies through `onData` while replay bytes are being parsed
 * (for example, `ESC[6n` can produce a cursor-position response). Replay bytes are historical output, not
 * operator input, so those generated replies must not be forwarded back into the live PTY.
 */
export interface TerminalInputGuard {
  isSuppressed(): boolean;
  suppressUntilDone(write: (done: () => void) => void): void;
}

export function createTerminalInputGuard(): TerminalInputGuard {
  let suppressDepth = 0;

  return {
    isSuppressed: () => suppressDepth > 0,
    suppressUntilDone: (write) => {
      suppressDepth += 1;
      let released = false;
      const done = (): void => {
        if (released) return;
        released = true;
        suppressDepth = Math.max(0, suppressDepth - 1);
      };
      write(done);
    },
  };
}

/**
 * Injected construction seams — the renderer wires these to `window.Terminal` / `window.FitAddon` /
 * `ResizeObserver` and the operator-IPC bridge; tests pass fakes (no DOM required).
 */
export interface AgentsTerminalDeps<T extends FitTerminalLike> {
  createTerminal(options: AgentsTerminalOptions): T;
  createFitAddon(): FitAddonLike;
  /** Install a resize hook on `el` that calls `onResize` whenever the pane is resized. */
  observeResize(el: HTMLElement, onResize: () => void): void;
  /** Forward a raw keystroke chunk from xterm to the hosted pty's stdin. Omitted ⇒ read-only. */
  onInput?(data: string): void;
  /** Report the fitted grid dimensions so the caller can drive `PTY.resize(cols, rows)`. */
  onResize?(cols: number, rows: number): void;
}

/**
 * Construct, wire, open, and fit the Agents terminal. Order matters: `loadAddon` BEFORE `open` (so the
 * addon is active when the terminal mounts), `fit()` AFTER `open` (the addon measures the now-mounted
 * element). Then wire `onData` → `onInput` (interactive stdin), report the initial fitted grid via
 * `onResize`, and re-fit + re-report on every pane resize (width-agreement with the hosted pty). Returns
 * the terminal + its fit addon.
 */
export function createAgentsTerminal<T extends FitTerminalLike>(
  el: HTMLElement,
  deps: AgentsTerminalDeps<T>,
): { term: T; fit: FitAddonLike; inputGuard: TerminalInputGuard } {
  const term = deps.createTerminal({ ...AGENTS_TERMINAL_OPTIONS });
  const fit = deps.createFitAddon();
  const inputGuard = createTerminalInputGuard();
  term.loadAddon(fit);
  term.open(el);
  fit.fit();
  if (deps.onInput) {
    const onInput = deps.onInput;
    term.onData((data) => {
      if (!inputGuard.isSuppressed()) onInput(data);
    });
  }
  const reportResize = (): void => deps.onResize?.(term.cols, term.rows);
  reportResize();
  deps.observeResize(el, () => {
    fit.fit();
    reportResize();
  });
  return { term, fit, inputGuard };
}

// ── Raw-stream feed decision ───────────────────────────────────────────────────

/** Minimal structural view of the terminal write surface (raw bytes in, verbatim). */
export interface TermWriter {
  write(data: string, callback?: () => void): void;
  reset(): void;
}

/**
 * What to feed xterm for a new transcript state, given the last-fed state. In the steady state the
 * transcript is an append-only string, so when it only GREW (the new value starts with the old) we write
 * just the delta and let xterm's emulator advance; on agent-switch or any non-prefix change we reset and
 * rewrite the whole transcript. Every `data` is a VERBATIM slice of the raw transcript — no EOL
 * conversion, no sanitization.
 */
export type TermFeed =
  | { readonly kind: 'reset'; readonly data: string }
  | { readonly kind: 'append'; readonly data: string }
  | { readonly kind: 'noop' };

export interface TermFeedInput {
  readonly selectedAgentId: string | null;
  readonly lastAgentId: string | null;
  readonly transcript: string;
  readonly transcriptOffset?: number;
  readonly lastTranscript: string;
  readonly lastTranscriptOffset?: number;
}

/**
 * Decide what to feed xterm. Mirrors the prior inline logic in `renderAgentsTranscript`:
 *   - agent switched → reset + write the whole transcript,
 *   - same agent and the transcript still starts with what we last wrote → append only the new delta
 *     (an empty delta is a no-op),
 *   - otherwise (a non-prefix change: truncation, reset generation) → reset + rewrite.
 */
export function decideTermFeed(input: TermFeedInput): TermFeed {
  const { selectedAgentId, lastAgentId, transcript, lastTranscript } = input;
  if (selectedAgentId !== lastAgentId) {
    return { kind: 'reset', data: transcript };
  }
  if (transcript.startsWith(lastTranscript)) {
    const delta = transcript.slice(lastTranscript.length);
    return delta.length > 0 ? { kind: 'append', data: delta } : { kind: 'noop' };
  }
  if (input.transcriptOffset != null && input.lastTranscriptOffset != null) {
    const transcriptOffset = input.transcriptOffset;
    const lastTranscriptOffset = input.lastTranscriptOffset;
    const transcriptEnd = transcriptOffset + transcript.length;
    const lastTranscriptEnd = lastTranscriptOffset + lastTranscript.length;
    if (transcriptOffset >= lastTranscriptOffset && transcriptOffset <= lastTranscriptEnd) {
      if (transcriptEnd <= lastTranscriptEnd) return { kind: 'noop' };
      const delta = transcript.slice(lastTranscriptEnd - transcriptOffset);
      return delta.length > 0 ? { kind: 'append', data: delta } : { kind: 'noop' };
    }
  }
  return { kind: 'reset', data: transcript };
}

/** Apply a feed decision to a terminal, writing raw bytes VERBATIM (no conversion, no sanitization). */
export function applyTermFeed(
  term: TermWriter,
  feed: TermFeed,
  inputGuard?: TerminalInputGuard,
): void {
  const writeReplay = (data: string): void => {
    if (inputGuard == null) {
      term.write(data);
      return;
    }
    inputGuard.suppressUntilDone((done) => term.write(data, done));
  };

  if (feed.kind === 'reset') {
    term.reset();
    if (feed.data.length > 0) writeReplay(feed.data);
    return;
  }
  if (feed.kind === 'append') {
    if (feed.data.length > 0) writeReplay(feed.data);
  }
  // kind === 'noop' → nothing to write.
}
