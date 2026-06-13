/**
 * SF-2 (Stage 9 tail L7-F) — the mid-turn STEER protocol (PURE over a {@link Pane}).
 *
 * {@link steerPane} lets the operator steer a LIVE agent from its terminal pane WITHOUT tearing it down
 * (Principle 1 — the session continues; never a kill/respawn). It is the operator-initiated sibling of
 * {@link injectMail} (the C2 mail-injection protocol), and reuses that exact discipline for the
 * text-bearing steers:
 *   - **`answer`**    — the operator answers a question the agent asked mid-turn: write the text and
 *     submit (one Enter), via {@link injectMail}'s write -> echo-verify -> exactly-one-Enter path.
 *   - **`redirect`**  — the operator injects a NEW instruction mid-turn: the same write + submit.
 *   - **`interrupt`** — the operator halts the current action: write the provider's interrupt key
 *     (ESC / Ctrl-C) and nothing else. The pane stays ALIVE — interrupt halts the action, it never
 *     kills/closes the pane (Principle 1).
 *
 * Control bytes (ESC and Ctrl-C, plus the submit CR inside injectMail) are authored via their codepoints
 * (ESC = 0x1B, Ctrl-C = 0x03), never as raw bytes, so the SOURCE holds NO raw control byte (a leaked raw
 * ESC would break later tooling — the C2 pristine-repo rule; grep-verified).
 *
 * Determinism (mirrors C2): timing is an INJECTED seam — `answer`/`redirect` forward {@link injectMail}'s
 * `retryDelay`, and `interrupt` is a single synchronous write — so there is no wall clock in the testable
 * path. The whole protocol is exercised in-sandbox over `FakePty`.
 *
 * Provider-awareness: the interrupt key is gated on the provider (the way the C2 dialog-watcher gates its
 * answers). Each per-provider key is `[synthesized]` from the probe-documented interrupt signature
 * (ESC / Ctrl-C); the REAL key that actually halts a turn against a live binary is `[host-live]`
 * (deferred) — correcting it is a one-line change to {@link INTERRUPT_KEY}.
 */
import type { Pane } from './pty-host.js';
import { injectMail, type InjectMailOptions } from './mail-injector.js';
import type { Provider } from './startup-classifier.js';
import { assertNever } from '../assert-never.js';

/**
 * A mid-turn steer the operator applies to a live pane. Three kinds: `answer` a question the agent
 * asked, `redirect` with a new instruction, or `interrupt` the current action. `answer`/`redirect`
 * carry the operator text; `interrupt` carries nothing — the provider's interrupt key is the whole
 * payload. (`answer` and `redirect` are distinct kinds because the operator's INTENT differs even
 * though the bytes are identical; keeping them separate lets the upstream surface label them.)
 */
export type Steer =
  | { readonly kind: 'answer'; readonly text: string }
  | { readonly kind: 'redirect'; readonly text: string }
  | { readonly kind: 'interrupt' };

/** Options for {@link steerPane}. `provider` selects the interrupt key + narrows the dialog-watcher. */
export interface SteerOptions {
  /** The provider this pane runs (selects the interrupt key; narrows injectMail's dialog-watcher). */
  readonly provider?: Provider;
  /**
   * Settle/retry seam forwarded to {@link injectMail} for `answer`/`redirect` (write -> echo-verify ->
   * Enter). Injected so the text-steer timing is deterministic in the testable path; UNUSED by
   * `interrupt` (a single synchronous write with no timing).
   */
  readonly retryDelay?: InjectMailOptions['retryDelay'];
  /** Max echo-verify write attempts for `answer`/`redirect` (forwarded to {@link injectMail}). */
  readonly maxEchoAttempts?: number;
}

// Control-byte constants, built from their codepoints so the SOURCE carries no raw control byte (the C2
// pristine-repo rule). ESC = 0x1B, CTRL_C = 0x03 (ETX) — the bytes a TUI reads as the interrupt key.
// This is the same runtime byte the C2 modules write via their `\u`-escape string literals.
const ESC = String.fromCharCode(0x1b);
const CTRL_C = String.fromCharCode(0x03);

/**
 * Provider interrupt keys (the bytes that halt the current action). Each is `[synthesized]` from the
 * probe-documented interrupt signature; the EXACT per-provider key against a live binary is host-verified
 * ([host-live]).
 *   - `claude` -> ESC: Claude Code interrupts the current action on Escape (it does NOT quit the TUI).
 *   - `codex`  -> Ctrl-C: Codex signals interrupt with Ctrl-C.
 */
const INTERRUPT_KEY: Readonly<Record<Provider, string>> = {
  claude: ESC,
  codex: CTRL_C,
};

/**
 * Fallback interrupt when the provider is unknown: ESC — the most universal "halt the current action,
 * don't kill" key for an interactive TUI. (The engine always supplies the authoritative provider; this
 * default only covers a direct caller that omits it.)
 */
const DEFAULT_INTERRUPT_KEY = ESC;

/** The interrupt key for `provider`, or the universal ESC fallback when the provider is unknown. */
function interruptKey(provider: Provider | undefined): string {
  return provider != null ? INTERRUPT_KEY[provider] : DEFAULT_INTERRUPT_KEY;
}

/**
 * Apply one mid-turn {@link Steer} to a live `pane`, WITHOUT tearing it down (Principle 1 — the turn
 * continues). `answer`/`redirect` write the operator text and submit exactly one Enter (reusing
 * {@link injectMail}'s echo-verify discipline, so a busy composer never swallows the input nor
 * double-submits); `interrupt` writes EXACTLY the provider's interrupt key and nothing else. The pane is
 * never killed, closed, or signalled here. Resolves once the steer bytes have been written (and, for the
 * text steers, echo-verified + submitted); rejects fail-loud (Principle 9) if a text steer never echoes.
 */
export async function steerPane(pane: Pane, steer: Steer, opts: SteerOptions = {}): Promise<void> {
  switch (steer.kind) {
    case 'answer':
    case 'redirect':
      // Operator text injected mid-turn — identical mechanics for both kinds (the distinction is the
      // operator's INTENT, surfaced upstream). Reuse injectMail so the composer-busy echo-verify and the
      // continuous dialog-watch are byte-for-byte the C2 path, not re-derived here.
      await injectMail(pane, steer.text, {
        provider: opts.provider,
        retryDelay: opts.retryDelay,
        maxEchoAttempts: opts.maxEchoAttempts,
      });
      return;
    case 'interrupt':
      // Halt the current action with the provider's interrupt key. EXACTLY the interrupt sequence is
      // written — nothing else — and the pane stays ALIVE: we never kill/close/signal it (Principle 1).
      pane.write(interruptKey(opts.provider));
      return;
    default:
      return assertNever(steer);
  }
}
