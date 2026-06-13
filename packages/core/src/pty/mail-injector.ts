/**
 * L7 C2 — the mail-injection protocol (PURE over a {@link Pane}).
 *
 * {@link injectMail} drives a LIVE interactive session to act on exactly ONE mail, using the
 * live-probe-verified P2 protocol:
 *   - **Write → settle → Enter.** Write the text, let the composer render it, then submit with a `\r`.
 *   - **Bracketed paste for multi-line.** Multi-line text is wrapped in the bracketed-paste markers
 *     (`ESC[200~` … `ESC[201~`) BEFORE the `\r`, so it arrives as one paste (byte-exact, no per-line
 *     turn fan-out). Single-line needs no wrapper.
 *   - **Echo-verify before Enter.** Input is swallowed during history replay / busy render, so we
 *     confirm the composer actually echoed the typed text (watch `onData`, whitespace-normalized)
 *     BEFORE sending `\r`, and RETRY the write otherwise — never blind-fire Enter.
 *   - **Continuous dialog-watcher.** A permission/approval dialog can interleave with the injection
 *     (it looks like a hung turn), so {@link watchDialogs} runs throughout, classifying-and-answering
 *     dialogs on every chunk.
 *
 * Determinism (AC-L7-3): all timing is an INJECTED seam (`retryDelay`) — no wall-clock timer sits in
 * the testable path — and the protocol is event-driven on the echo, so the happy path settles the
 * instant the echo renders. The whole thing is exercised in-sandbox over `FakePty`.
 *
 * Scope: `injectMail` owns the watcher for the injection phase (write → submit). For the FULL turn the
 * Conductor keeps a {@link watchDialogs} attached (integration / host-side) — the watcher is exported
 * so that wiring reuses this exact code path rather than re-deriving it.
 */
import type { Pane } from './pty-host.js';
import { normalizeStartupOutput, type Provider } from './startup-classifier.js';
import { watchDialogs } from './dialog-watcher.js';

// Bracketed-paste markers + the submit key, authored as `\u`/`\r` escapes so the SOURCE holds no raw
// control bytes (a leaked raw ESC would break later tooling — see the C2 pristine-repo rule).
const PASTE_START = '\u001B[200~';
const PASTE_END = '\u001B[201~';
const SUBMIT = '\r';
const CLEAR_COMPOSER = '\u0015'; // Ctrl-U: clear the current input line before an uncertain retry.

const DEFAULT_MAX_ECHO_ATTEMPTS = 5;
/** Production-only fallback settle window (ms). The TESTABLE path injects `retryDelay` instead. */
const DEFAULT_SETTLE_MS = 250;
/** Cap on retained echo-scan output (the typed text always echoes within the recent tail). */
const MAX_ECHO_BUFFER_CHARS = 64 * 1024;

export interface InjectMailOptions {
  /** The provider whose interleaving dialogs the watcher should answer (narrows the classifier). */
  readonly provider?: Provider;
  /**
   * Settle/retry seam: awaited (racing the echo) after each write; if it wins (echo not yet rendered)
   * the write is retried. Tests inject a controllable promise so timing is deterministic; production
   * defaults to a short real delay. The optional `AbortSignal` is aborted the instant the echo wins,
   * so the default implementation can clear its timer (no dangling wall-clock work).
   */
  readonly retryDelay?: (signal?: AbortSignal) => Promise<void>;
  /** Max echo-verify write attempts before failing loud (default {@link DEFAULT_MAX_ECHO_ATTEMPTS}). */
  readonly maxEchoAttempts?: number;
}

/**
 * Drive `pane` to act on the single mail `text`, exactly once. Resolves once the text has been
 * echo-verified and submitted (one `\r`); rejects (fail-loud, Principle 9) if the composer never
 * echoes the text within `maxEchoAttempts`. Subscriptions are torn down on settle.
 */
export async function injectMail(
  pane: Pane,
  text: string,
  opts: InjectMailOptions = {},
): Promise<void> {
  const normalizedText = normalizeStartupOutput(text);
  if (normalizedText === '') {
    throw new Error('injectMail: refusing to inject empty text (nothing to render or submit)');
  }
  const maxAttempts = opts.maxEchoAttempts ?? DEFAULT_MAX_ECHO_ATTEMPTS;
  const retryDelay = opts.retryDelay ?? defaultRetryDelay;

  // Multi-line text is delivered as ONE bracketed paste; single-line is written bare. The echo we
  // verify is the rendered TEXT (the paste markers are not echoed as visible glyphs), so the echo
  // predicate matches on the normalized text either way.
  const multiline = /[\r\n]/.test(text);
  const payload = multiline ? `${PASTE_START}${text}${PASTE_END}` : text;

  let echoBuffer = '';
  let notifyEcho: (() => void) | null = null;
  const echoed = (): boolean => {
    const normalizedEcho = normalizeStartupOutput(echoBuffer);
    if (normalizedEcho.includes(normalizedText)) return true;
    // [host-live] Claude Code 2.1.158 collapses longer bracketed pastes into a composer-side
    // `[Pasted text #N +M lines]` preview instead of echoing the full pasted text. That preview is
    // still the provider acknowledging the paste landed in the composer; submit exactly once.
    return (
      multiline &&
      opts.provider === 'claude' &&
      normalizedEcho.toLowerCase().includes('pasted text #') &&
      normalizedEcho.toLowerCase().includes('paste again to expand')
    );
  };

  const unsubEcho = pane.onData((chunk) => {
    echoBuffer += chunk;
    if (echoBuffer.length > MAX_ECHO_BUFFER_CHARS) {
      echoBuffer = echoBuffer.slice(-MAX_ECHO_BUFFER_CHARS);
    }
    if (notifyEcho && echoed()) {
      const fire = notifyEcho;
      notifyEcho = null;
      fire();
    }
  });
  // The continuous dialog-watcher runs alongside the echo scan for the whole injection phase.
  const unsubDialogs = watchDialogs(pane, { provider: opts.provider });

  try {
    let submitted = false;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) echoBuffer = '';
      pane.write(attempt === 0 ? payload : CLEAR_COMPOSER + payload);
      if (echoed()) {
        submitted = true;
        break;
      }
      // Race the echo against the settle/retry window. Echo wins ⇒ submit; the window wins ⇒ retry.
      const controller = new AbortController();
      const echoSeen = new Promise<void>((resolve) => {
        notifyEcho = resolve;
      });
      const outcome = await Promise.race([
        echoSeen.then(() => 'echo' as const),
        retryDelay(controller.signal).then(() => 'retry' as const),
      ]);
      notifyEcho = null;
      controller.abort();
      if (outcome === 'echo' || echoed()) {
        submitted = true;
        break;
      }
      if (multiline) {
        throw new Error(
          'injectMail: multiline composer did not echo before the retry window; refusing an ' +
            'uncertain multiline retry',
        );
      }
      // else: the settle window elapsed with no echo — loop and re-write (retry).
    }
    if (!submitted) {
      throw new Error(
        `injectMail: composer did not echo the typed text after ${maxAttempts} attempt(s); ` +
          'refusing to blind-fire Enter',
      );
    }
    pane.write(SUBMIT);
  } finally {
    unsubEcho();
    unsubDialogs();
  }
}

/** Production fallback settle: a short real delay, cleared the instant the echo aborts it. */
function defaultRetryDelay(signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, DEFAULT_SETTLE_MS);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
