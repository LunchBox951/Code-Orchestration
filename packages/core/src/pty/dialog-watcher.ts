/**
 * L7 C2 — the continuous permission/approval dialog-watcher (PURE classifier + a thin Pane attach).
 *
 * While a live `claude`/`codex` session runs a turn, a permission/approval dialog can interleave with
 * the work at any moment. An UNANSWERED dialog looks exactly like a hung turn (the byte stream goes
 * quiet behind the modal), so it must be classified-and-answered CONTINUOUSLY through the turn — on
 * every output chunk — never just once up front. This module is the analogue of B1's startup
 * classifier ({@link import('./startup-classifier.js')}): it matches the documented *prompt text*,
 * whitespace-normalized, and emits the bytes that answer the dialog. It is pure of timers and I/O —
 * {@link classifyDialog} is a pure function and {@link watchDialogs} only subscribes to a `Pane`.
 *
 * Provenance: the exact dialog bytes were not embedded in the C2 spec, so the anchors below are
 * `[synthesized]` — documented-plausible prompt text the operator's host-side live-binary E2E
 * confirms/corrects. The pure-logic guarantee (drive MY fixtures to the right answer) holds either
 * way; only the real anchor text is host-verified.
 */
import type { Pane } from './pty-host.js';
import { normalizeStartupOutput, type Provider } from './startup-classifier.js';

/** The interleaving dialogs we know how to answer mid-turn. */
export type DialogName = 'claude_permission' | 'codex_approval';

/** A classified dialog: its `name` and the bytes that answer it. */
export interface DialogMatch {
  readonly name: DialogName;
  readonly answer: string;
  readonly signature: string;
}

interface DialogSig {
  readonly name: DialogName;
  /** Bytes to write to answer this dialog (≤2 keypresses), authored as escapes — no raw control bytes. */
  readonly answer: string;
  /** Lowercased anchors; ALL must be present (whitespace-normalized) for this dialog to match. */
  readonly anchors: readonly string[];
}

const DIALOG_SIGNATURES: Readonly<Record<Provider, readonly DialogSig[]>> = {
  claude: [
    // [synthesized] Claude's MCP-tool permission prompt ("Do you want to proceed?" + a Yes/No menu).
    // The highlighted default is the affirmative option, so a single Enter answers it.
    {
      name: 'claude_permission',
      answer: '\r',
      anchors: ['do you want to proceed', '1. yes', '2. no'],
    },
  ],
  codex: [
    // [synthesized] Codex's MCP approval dialog, e.g. `Allow the co_probe MCP server to run tool …?`
    // with a numbered Yes/No menu. Policy for co's own (trusted) MCP server is approve-once → select
    // option 1 (Yes) explicitly (number + Enter), mirroring B1's codex `2\r` answer style.
    {
      name: 'codex_approval',
      answer: '1\r',
      anchors: ['mcp server to run tool', '1. yes', '2. no'],
    },
    // [host-live] Codex 0.139.0 renders MCP approval as an Allow/Cancel menu with option 1 already
    // highlighted. Submit the highlighted Allow option with Enter; do not choose session/future allow.
    {
      name: 'codex_approval',
      answer: '\r',
      anchors: ['mcp server to run tool', '1. allow', '4. cancel'],
    },
  ],
};

/**
 * Classify the CURRENT (whitespace-normalized) output buffer as a known interleaving dialog, or
 * `null` if none is up. When `provider` is given, only that provider's dialogs are considered (the
 * caller knows which binary the pane runs); when omitted, every known dialog is tried.
 */
export function classifyDialog(
  provider: Provider | undefined,
  normalizedOutput: string,
): DialogMatch | null {
  const hay = normalizedOutput.toLowerCase();
  const providers: readonly Provider[] = provider ? [provider] : ['claude', 'codex'];
  for (const p of providers) {
    for (const sig of DIALOG_SIGNATURES[p]) {
      if (sig.anchors.every((a) => hay.includes(a))) {
        return {
          name: sig.name,
          answer: sig.answer,
          signature: `${sig.name}:${sig.anchors.join('|')}`,
        };
      }
    }
  }
  return null;
}

/**
 * Cap on retained dialog-scan output. A dialog is a full-screen modal, so its signature always lands
 * within the recent tail; keeping only the tail bounds memory + per-chunk re-normalization cost.
 */
const MAX_DIALOG_BUFFER_CHARS = 64 * 1024;
const SCREEN_RESET_PATTERNS: readonly string[] = ['\u001B[2J', '\u001Bc'];
const SCREEN_RESET_TAIL_CHARS =
  Math.max(...SCREEN_RESET_PATTERNS.map((pattern) => pattern.length)) - 1;

export interface WatchDialogsOptions {
  /** The provider whose dialogs we know how to answer (narrows {@link classifyDialog}). */
  readonly provider?: Provider;
  /** Diagnostics hook fired each time a dialog is answered (the E1 watchdog / tests observe it). */
  readonly onAnswered?: (name: DialogName, answer: string) => void;
}

/**
 * Attach a continuous dialog-watcher to `pane`: on every output chunk, classify the accumulated
 * (whitespace-normalized) buffer and, when a known dialog is up, write its answer bytes. Returns an
 * unsubscribe function — the caller controls the watcher's lifetime (the injection phase, or the whole
 * turn). The exact same code path runs over `FakePty` in-sandbox and `NodePtyHost` in production.
 *
 * Dedup: after answering a dialog we reset the scan buffer, so the persistent on-screen anchor does
 * NOT re-trigger an answer; a genuinely new dialog accumulates fresh and re-matches. (Host-side
 * hardening can debounce until the modal actually clears; in-sandbox the test drives exact emits.)
 */
export function watchDialogs(pane: Pane, opts: WatchDialogsOptions = {}): () => void {
  let buffer = '';
  let activeDialogSignature: string | undefined;
  let resetScanTail = '';
  return pane.onData((chunk) => {
    const resetScanInput = resetScanTail + chunk;
    resetScanTail = resetScanInput.slice(-SCREEN_RESET_TAIL_CHARS);
    const postResetChunk = suffixAfterLastScreenReset(resetScanInput);
    if (postResetChunk != null) {
      activeDialogSignature = undefined;
      buffer = '';
      chunk = postResetChunk;
    }
    buffer += chunk;
    if (buffer.length > MAX_DIALOG_BUFFER_CHARS) buffer = buffer.slice(-MAX_DIALOG_BUFFER_CHARS);
    const match = classifyDialog(opts.provider, normalizeStartupOutput(buffer));
    if (activeDialogSignature != null) {
      if (match?.signature === activeDialogSignature) {
        buffer = '';
        return;
      }
      if (match == null) {
        buffer = '';
        return;
      }
    }
    if (match) {
      pane.write(match.answer);
      activeDialogSignature = match.signature;
      buffer = '';
      opts.onAnswered?.(match.name, match.answer);
    }
  });
}

function suffixAfterLastScreenReset(chunk: string): string | undefined {
  let lastResetEnd = -1;
  for (const pattern of SCREEN_RESET_PATTERNS) {
    const start = chunk.lastIndexOf(pattern);
    if (start >= 0) lastResetEnd = Math.max(lastResetEnd, start + pattern.length);
  }
  return lastResetEnd >= 0 ? chunk.slice(lastResetEnd) : undefined;
}
