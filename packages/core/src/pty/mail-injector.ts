/**
 * L7 C2 — the mail-injection protocol (PURE over a {@link Pane}).
 *
 * {@link injectMail} drives a LIVE interactive session to act on exactly ONE mail, using the
 * live-probe-verified P2 protocol:
 *   - **Write → settle → Enter.** Write the text, let the composer render it, then submit with a `\r`.
 *   - **Bracketed paste for multi-line AND long single-line.** Multi-line text — and any single line
 *     at/above {@link PASTE_LENGTH_THRESHOLD} (#92) — is wrapped in the bracketed-paste markers
 *     (`ESC[200~` … `ESC[201~`) BEFORE the `\r`, so it arrives as one paste (byte-exact, no per-line
 *     turn fan-out, and no composer soft-wrap reflow to defeat the echo scan). Short single-line text
 *     needs no wrapper.
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

/**
 * [host-live · PLACEHOLDER] Codex collapsed-paste composer-preview needles (#77).
 *
 * Like Claude — which renders a `[Pasted text #N +M lines]` preview instead of echoing a long
 * bracketed paste — the Codex TUI is believed to COLLAPSE a multi-line bracketed paste into a
 * composer-side preview rather than echoing the full pasted text. Because every daemon kickoff is
 * multiline, `injectMail`'s echo-verify never matches the literal text, the multiline branch THROWS,
 * the turn errors, and (pre-#77) the daemon re-pasted the kickoff every tick forever.
 *
 * The EXACT bytes Codex emits are UNKNOWN until the host-live capture harness
 * (`CO_HOST_LIVE_CAPTURE`) records a real paste against a live `codex` binary — these are PLACEHOLDER
 * needles, NOT a verified contract (see `needsLiveVerification`). LOOP-SAFETY DOES NOT DEPEND ON THEM:
 * the engine's bounded kickoff-attempt cap (#77) retracts the kickoff after N failed injects whether
 * or not this fast-path ever matches. This branch is a best-effort accelerator so that, once the real
 * needle lands, a codex kickoff settles on its first turn instead of burning the whole attempt budget.
 */
const CODEX_COLLAPSED_PASTE_NEEDLES: readonly string[] = ['pasted', 'lines'];

const DEFAULT_MAX_ECHO_ATTEMPTS = 5;
/** Production-only fallback settle window (ms). The TESTABLE path injects `retryDelay` instead. */
const DEFAULT_SETTLE_MS = 250;
/**
 * Host-tunable heuristic: payloads at/above this length take the bracketed-paste path even with NO
 * explicit newline (#92). A long single line (~400 chars in the reported failure) soft-wraps in the
 * composer; the reflowed echo no longer matches the literal text byte-for-byte, so the bare-write echo
 * scan fails and the kickoff is wrongly retracted. Pasting it (like multi-line text) makes the composer
 * treat it as one paste — no soft-wrap reflow to defeat the echo scan. Chosen below the ~400-char single
 * line that FAILED and above the short single lines that SUCCEED on the bare path.
 */
const PASTE_LENGTH_THRESHOLD = 256;
/**
 * Adaptive default-settle scaling (#92): a longer paste takes longer to render/collapse, so the
 * production fallback window grows with payload length (the injected `retryDelay` test seam is
 * authoritative in the testable path and is NOT affected by this). Window = base + perChar·len, capped.
 */
const DEFAULT_SETTLE_PER_CHAR_MS = 0.5;
const DEFAULT_SETTLE_MAX_MS = 2_000;
/** Cap on retained echo-scan output (the typed text always echoes within the recent tail). */
const MAX_ECHO_BUFFER_CHARS = 64 * 1024;

/**
 * Pure length→settle scaler for the PRODUCTION fallback window (#92). Deterministic, no wall clock —
 * unit-tested directly so adaptiveness is provable without timers. A longer payload yields a strictly
 * larger window until the cap; below the cap it is monotonic in `payloadLength`.
 */
export function adaptiveSettleMs(payloadLength: number): number {
  const scaled = DEFAULT_SETTLE_MS + DEFAULT_SETTLE_PER_CHAR_MS * Math.max(0, payloadLength);
  return Math.min(DEFAULT_SETTLE_MAX_MS, Math.round(scaled));
}

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
  /**
   * Host-live escape hatch for providers/versions whose TUI accepts input but does not echo composer
   * contents to pty output. Defaults false; callers that enable it must verify a downstream side
   * effect for the injected turn (e.g. a nonce-bearing MCP tool call) because echo proof is absent.
   */
  readonly allowUnverifiedSubmit?: boolean;
  /**
   * [host-live capture] OPTIONAL observation tap: invoked with each composer echo chunk seen during
   * the inject phase. The second argument preserves the legacy `multiline` semantic for compatibility;
   * the third reports whether the inject was delivered as a bracketed PASTE (true for multi-line OR long
   * single-line payloads, see {@link PASTE_LENGTH_THRESHOLD}). Inert by default; the host-live capture
   * harness (`CO_HOST_LIVE_CAPTURE`) wires it to RECORD a real provider's composer echo so the codex
   * collapsed-paste preview bytes (#77 `CODEX_COLLAPSED_PASTE_NEEDLES`) can be identified from a real
   * run. NEVER affects echo-verify, submit, or timing — it is a pure observer (never throws into the
   * inject path; the harness wraps its own failures).
   */
  readonly onPasteEcho?: (chunk: string, multiline: boolean, pasted: boolean) => void;
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

  // Paste-wrap multi-line text AND long single-line text (#92); short single-line is written bare. The
  // echo we verify is the rendered TEXT (the paste markers are not echoed as visible glyphs), so the
  // echo predicate matches on the normalized text either way. A long single line soft-wraps in the
  // composer and its reflowed echo no longer matches byte-for-byte — pasting it dodges that reflow.
  const hasNewline = /[\r\n]/.test(text);
  const usePaste = hasNewline || normalizedText.length >= PASTE_LENGTH_THRESHOLD;
  const payload = usePaste ? `${PASTE_START}${text}${PASTE_END}` : text;

  // The injected `retryDelay` test seam is authoritative (deterministic, no wall clock); the production
  // default is ADAPTIVE — its settle window scales with payload length (#92) so a long paste that takes
  // longer to render/collapse is given proportionally longer to echo before a retry fires.
  const retryDelay =
    opts.retryDelay ?? ((signal?: AbortSignal) => defaultRetryDelay(payload.length, signal));

  let echoBuffer = '';
  let notifyEcho: (() => void) | null = null;
  const echoed = (): boolean => {
    const normalizedEcho = normalizeStartupOutput(echoBuffer);
    if (normalizedEcho.includes(normalizedText)) return true;
    // [host-live] Claude Code 2.1.158 collapses longer bracketed pastes into a composer-side
    // `[Pasted text #N +M lines]` preview instead of echoing the full pasted text. That preview is
    // still the provider acknowledging the paste landed in the composer; submit exactly once. Keyed on
    // `usePaste` (not strictly newline-multiline) so a long single line that collapses also verifies.
    if (
      usePaste &&
      opts.provider === 'claude' &&
      normalizedEcho.toLowerCase().includes('pasted text #') &&
      normalizedEcho.toLowerCase().includes('paste again to expand')
    ) {
      return true;
    }
    // [host-live · PLACEHOLDER] Codex is believed to collapse a multiline paste the same way (#77).
    // Accept its composer-side preview as a landed paste once ALL placeholder needles appear. The real
    // bytes are pending the capture harness; this fast-path is purely an accelerator and is NEVER the
    // loop-safety guarantee (the engine's #77 attempt cap is). See CODEX_COLLAPSED_PASTE_NEEDLES.
    // Keep this tied to explicit newlines until host-live capture verifies the real Codex preview bytes;
    // long single-line pastes must prove landing by literal echo rather than unverified common words.
    return (
      hasNewline &&
      opts.provider === 'codex' &&
      CODEX_COLLAPSED_PASTE_NEEDLES.every((needle) =>
        normalizedEcho.toLowerCase().includes(needle.toLowerCase()),
      )
    );
  };

  const unsubEcho = pane.onData((chunk) => {
    echoBuffer += chunk;
    if (echoBuffer.length > MAX_ECHO_BUFFER_CHARS) {
      echoBuffer = echoBuffer.slice(-MAX_ECHO_BUFFER_CHARS);
    }
    // [host-live capture] Tap the raw composer echo so the capture harness can record a real
    // provider's paste preview (#77). Pure observer — guarded so it never disturbs echo-verify.
    if (opts.onPasteEcho != null) {
      try {
        opts.onPasteEcho(chunk, hasNewline, usePaste);
      } catch {
        /* capture is best-effort; never let it break the inject path */
      }
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
      if (usePaste) {
        if (opts.allowUnverifiedSubmit) {
          submitted = true;
          break;
        }
        throw new Error(
          'injectMail: paste composer did not echo before the retry window; refusing an ' +
            'uncertain paste retry',
        );
      }
      // else: the settle window elapsed with no echo — loop and re-write (retry).
    }
    if (!submitted) {
      if (opts.allowUnverifiedSubmit) submitted = true;
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

/**
 * Production fallback settle: a short real delay (ADAPTIVE in `payloadLength`, see
 * {@link adaptiveSettleMs}), cleared the instant the echo aborts it. Only the production default uses
 * this — the injected `retryDelay` test seam never touches a wall clock.
 */
function defaultRetryDelay(payloadLength: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, adaptiveSettleMs(payloadLength));
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
