/**
 * L7 B1 — the startup driver: wire the pure {@link classifyStartup} to a live {@link Pane}.
 *
 * It subscribes to the pane's output, accumulates + whitespace-normalizes it, classifies the current
 * startup state, and on each recognized interstitial writes the documented answer bytes — until the
 * session reaches `ready` (authed) or a terminal `login_required` menu (surfaced to the operator, NOT
 * driven). Because it talks only to the `Pane` interface, the exact same code path runs over `FakePty`
 * in-sandbox and `NodePtyHost` in production.
 *
 * Each interstitial is answered AT MOST ONCE: the driver records answered names and passes them to the
 * classifier so the persistent earlier anchor (still sitting in the accumulated buffer) cannot trigger
 * a re-answer, and the flow advances to the next dialog.
 */
import type { Pane } from './pty-host.js';
import { assertNever } from '../assert-never.js';
import {
  classifyStartup,
  normalizeStartupOutput,
  type Provider,
  type StartupInterstitialName,
} from './startup-classifier.js';

/**
 * Cap on retained startup output (~64 KB of UTF-16 units). Startup dialogs are full-screen repaints,
 * so a signature always lands within the recent tail; keeping only the tail bounds memory and the
 * per-chunk re-normalization cost when a slow startup streams many spinner frames (review #178). The
 * cap is far larger than any single TUI screen, so it never truncates an in-flight prompt; the exact
 * value can be tuned host-side once real startup output volume is known.
 */
const MAX_STARTUP_BUFFER_CHARS = 64 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;

/** The terminal result of driving a freshly-spawned session through its startup dialogs. */
export interface StartupOutcome {
  /** True iff the session reached the ready composer (authed). */
  readonly authed: boolean;
  /** Present iff the session stopped at a terminal login menu; carries the surfaced methods. */
  readonly loginRequired?: { readonly methods: readonly string[] };
}

export interface StartupDriverOptions {
  /** Fail loud if no terminal startup state is reached within this bound. */
  readonly timeoutMs?: number;
}

/**
 * Drive `pane` (a freshly-spawned `provider` session) through its startup interstitials to readiness.
 *
 * Resolves with `{ authed: true }` on `ready`, or `{ authed: false, loginRequired }` on a terminal
 * login menu. Rejects (fail-loud, Principle 9) if the pty exits before either terminal state is
 * reached. The returned promise settles exactly once; all pane subscriptions are torn down on settle.
 */
export function driveToReady(
  pane: Pane,
  provider: Provider,
  opts: StartupDriverOptions = {},
): Promise<StartupOutcome> {
  return new Promise<StartupOutcome>((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const answered = new Set<StartupInterstitialName>();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;

    const cleanups = new Set<() => void>();
    const timeout = setTimeout(() => {
      settle(() =>
        reject(
          new Error(
            `timed out during ${provider} startup before reaching ready after ${timeoutMs}ms`,
          ),
        ),
      );
    }, timeoutMs);
    (timeout as { unref?: () => void }).unref?.();

    const settle = (run: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      for (const cleanup of cleanups) cleanup();
      cleanups.clear();
      run();
    };

    const registerCleanup = (cleanup: () => void): void => {
      if (settled) {
        cleanup();
        return;
      }
      cleanups.add(cleanup);
    };

    const evaluate = (): void => {
      const phase = classifyStartup(provider, normalizeStartupOutput(buffer), answered);
      switch (phase.kind) {
        case 'starting':
          return;
        case 'interstitial':
          // classifyStartup already skips answered names, so reaching here means this is new.
          answered.add(phase.name);
          pane.write(phase.answer);
          return;
        case 'ready':
          settle(() => resolve({ authed: true }));
          return;
        case 'login_required':
          settle(() => resolve({ authed: false, loginRequired: { methods: phase.methods } }));
          return;
        default:
          return assertNever(phase);
      }
    };

    registerCleanup(
      pane.onExit((ev) => {
        settle(() =>
          reject(
            new Error(
              `pty exited during ${provider} startup before reaching ready ` +
                `(code=${ev.code}, signal=${ev.signal})`,
            ),
          ),
        );
      }),
    );
    if (settled) return;

    registerCleanup(
      pane.onData((chunk) => {
        buffer += chunk;
        // Drop already-processed leading output once past the cap. Safe: `answered` (not the buffer)
        // tracks interstitial progress, and the current screen's signature is always within the tail.
        if (buffer.length > MAX_STARTUP_BUFFER_CHARS) {
          buffer = buffer.slice(-MAX_STARTUP_BUFFER_CHARS);
        }
        evaluate();
      }),
    );
  });
}
