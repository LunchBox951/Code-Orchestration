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

/** The terminal result of driving a freshly-spawned session through its startup dialogs. */
export interface StartupOutcome {
  /** True iff the session reached the ready composer (authed). */
  readonly authed: boolean;
  /** Present iff the session stopped at a terminal login menu; carries the surfaced methods. */
  readonly loginRequired?: { readonly methods: readonly string[] };
}

/**
 * Drive `pane` (a freshly-spawned `provider` session) through its startup interstitials to readiness.
 *
 * Resolves with `{ authed: true }` on `ready`, or `{ authed: false, loginRequired }` on a terminal
 * login menu. Rejects (fail-loud, Principle 9) if the pty exits before either terminal state is
 * reached. The returned promise settles exactly once; all pane subscriptions are torn down on settle.
 */
export function driveToReady(pane: Pane, provider: Provider): Promise<StartupOutcome> {
  return new Promise<StartupOutcome>((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const answered = new Set<StartupInterstitialName>();

    let unsubData: () => void = () => {};
    let unsubExit: () => void = () => {};

    const settle = (run: () => void): void => {
      if (settled) return;
      settled = true;
      unsubData();
      unsubExit();
      run();
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

    unsubData = pane.onData((chunk) => {
      buffer += chunk;
      evaluate();
    });
    unsubExit = pane.onExit((ev) => {
      settle(() =>
        reject(
          new Error(
            `pty exited during ${provider} startup before reaching ready ` +
              `(code=${ev.code}, signal=${ev.signal})`,
          ),
        ),
      );
    });
  });
}
