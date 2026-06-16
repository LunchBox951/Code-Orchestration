/**
 * Pure / injectable helpers for the live-session terminal in the Agents view
 * (Stage 15 · P-DT2 · GitHub #40 — in-sandbox terminal fit + raw-stream feed).
 *
 * THE BUG (operator-filed, screenshot-confirmed): the Agents transcript renders garbled — stacked
 * in-place-redraw frames (claude's `✻ …` spinner and the `attempt N/10` retry counter pile up on top of
 * each other with `────` artifacts) plus wrong-width wrapping. Two coupled, confirmed causes, both fixed
 * here:
 *   1. No fit / no resize — the xterm sat at its default 80×24, so a wider/narrower pane wrapped at the
 *      wrong column and cursor-addressed redraws (`\r`, cursor-up) landed on the wrong visual row.
 *   2. `convertEol: true` on a raw, cursor-addressed pty stream — it rewrites `\n` → `\r\n` and corrupts
 *      an already-CR/LF-correct TUI stream. `OperatorIpcTranscript` is the raw pane string with ANSI/ESC
 *      control bytes PRESERVED (see packages/core/src/operator-ipc/contract.ts); xterm's own emulator
 *      reproduces the final screen if the control bytes are intact and the width is right.
 *
 * THE FIX: construct the terminal WITHOUT `convertEol`, load the fit addon, `fit()` after `open()` and on
 * every resize, and feed the raw bytes VERBATIM (delta-append while the transcript only grows; reset +
 * rewrite on agent-switch or a non-prefix change). These helpers isolate the construction wiring and the
 * feed decision behind minimal structural interfaces so they are unit-testable WITHOUT a DOM (this repo
 * has no jsdom/happy-dom) — mirroring how `review-render-helpers.ts` / `live-render-helpers.ts` stay
 * framework-free.
 *
 * NOTE — the live PTY width handshake (making the hosted pty's width agree with the in-app terminal's) is
 * the operator's live-run item and is explicitly OUT of scope here; this module is the in-sandbox
 * renderer-fit + raw-stream half only.
 */

// ── Terminal construction + fit wiring ─────────────────────────────────────────

/**
 * The xterm construction options for the Agents terminal. `convertEol` is deliberately ABSENT: the stream
 * is raw and cursor-addressed, so converting `\n` → `\r\n` would corrupt it. `disableStdin` because the
 * pane is read-only — the operator steers via the composer, not by typing into xterm.
 */
export interface AgentsTerminalOptions {
  readonly disableStdin: boolean;
}

export const AGENTS_TERMINAL_OPTIONS: AgentsTerminalOptions = { disableStdin: true };

/** Minimal structural view of the xterm fit addon (UMD `window.FitAddon.FitAddon`). */
export interface FitAddonLike {
  fit(): void;
}

/** Minimal structural view of the xterm Terminal this module wires (loadAddon + open). */
export interface FitTerminalLike {
  loadAddon(addon: FitAddonLike): void;
  open(el: HTMLElement): void;
}

/**
 * Injected construction seams — the renderer wires these to `window.Terminal` / `window.FitAddon` /
 * `ResizeObserver`; tests pass fakes (no DOM required).
 */
export interface AgentsTerminalDeps<T extends FitTerminalLike> {
  createTerminal(options: AgentsTerminalOptions): T;
  createFitAddon(): FitAddonLike;
  /** Install a resize hook on `el` that calls `onResize` whenever the pane is resized. */
  observeResize(el: HTMLElement, onResize: () => void): void;
}

/**
 * Construct, wire, open, and fit the Agents terminal. Order matters: `loadAddon` BEFORE `open` (so the
 * addon is active when the terminal mounts), `fit()` AFTER `open` (the addon measures the now-mounted
 * element), and a resize hook that re-fits on every pane resize. Returns the terminal + its fit addon.
 */
export function createAgentsTerminal<T extends FitTerminalLike>(
  el: HTMLElement,
  deps: AgentsTerminalDeps<T>,
): { term: T; fit: FitAddonLike } {
  const term = deps.createTerminal({ ...AGENTS_TERMINAL_OPTIONS });
  const fit = deps.createFitAddon();
  term.loadAddon(fit);
  term.open(el);
  fit.fit();
  deps.observeResize(el, () => fit.fit());
  return { term, fit };
}

// ── Raw-stream feed decision ───────────────────────────────────────────────────

/** Minimal structural view of the terminal write surface (raw bytes in, verbatim). */
export interface TermWriter {
  write(data: string): void;
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
  readonly lastTranscript: string;
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
  return { kind: 'reset', data: transcript };
}

/** Apply a feed decision to a terminal, writing raw bytes VERBATIM (no conversion, no sanitization). */
export function applyTermFeed(term: TermWriter, feed: TermFeed): void {
  if (feed.kind === 'reset') {
    term.reset();
    if (feed.data.length > 0) term.write(feed.data);
    return;
  }
  if (feed.kind === 'append') {
    if (feed.data.length > 0) term.write(feed.data);
  }
  // kind === 'noop' → nothing to write.
}
