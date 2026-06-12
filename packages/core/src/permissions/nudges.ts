/**
 * L6a Phase D1 — Reactive-nudge catalog as DATA (permissions.md:42-66).
 *
 * The catalog is DATA — substrate-independent policy. Break-detection rides the Conductor / runtime
 * substrate and is L7 (permissions.md:64-66, Principle 16); the liveness watchdog
 * ({@link ../pty/liveness-watchdog.js}) detects the break and calls {@link injectNudge}. As of L7 E1
 * `injectNudge` is the REAL injector: it looks the nudge up by id and writes it into the agent's live
 * pane via C2's injection primitive ({@link ../pty/mail-injector.js injectMail}). It stays fail-loud
 * (Principle 9) — an unknown trigger id throws rather than silently no-op'ing.
 */
import type { Pane } from '../pty/pty-host.js';
import { injectMail, type InjectMailOptions } from '../pty/mail-injector.js';

/** A single reactive-nudge entry: a detected protocol break and the corrective reminder. */
export interface NudgeRule {
  /** Stable unique id for this nudge. */
  readonly id: string;
  /** One-line description of the protocol break that triggers this nudge. */
  readonly trigger: string;
  /** The gentle corrective message injected by the Conductor. */
  readonly nudge: string;
}

/**
 * The canonical nudge catalog — representative entries from permissions.md:42-66.
 *
 * Every entry is a `(trigger, nudge)` pair the Conductor uses when it detects the described
 * protocol break. The catalog is open for extension at L7+; these entries capture the
 * representative set documented in permissions.md.
 */
export const NUDGE_CATALOG: readonly NudgeRule[] = [
  {
    id: 'finish-before-yield',
    trigger:
      'An implementer ends its turn without a worker_done or any outgoing mail (turn ending without co_finish).',
    nudge:
      "You're wrapping up but haven't finished through `co_finish` or sent a `worker_done` — do that before you yield.",
  },
  {
    id: 'publish-without-pass',
    trigger:
      'An agent attempts to publish (merge/push/PR) without a recorded PASS verdict from the review gate.',
    nudge:
      'Publishing requires a recorded PASS — use `co_merge` / `co_push` / `co_pr_merge` which enforce the review gate.',
  },
  {
    id: 'reviewer-editing-code',
    trigger: 'A reviewer edits code that is currently under its own review.',
    nudge:
      'Reviewers read, run tests, and stamp verdicts — they do not edit the code under review. Read/run/judge, then return your verdict.',
  },
  {
    id: 'busy-polling',
    trigger:
      'An agent is busy-waiting / polling in a loop waiting for a condition instead of yielding.',
    nudge:
      'Busy-polling is unnecessary — the warm-session model wakes you when work arrives. Yield your turn and wait for a mail.',
  },
  {
    id: 'raw-shell-over-mcp',
    trigger: 'An agent invokes a `co` CLI subcommand in the shell instead of the MCP surface.',
    nudge:
      'Use the `co_*` MCP tools (e.g. `co_finish`, `co_merge`) rather than the `co` CLI — the single-surface decision applies.',
  },
];

/**
 * Looks up a nudge by stable id. Returns `undefined` when the id is unknown (not a hard error —
 * unknown ids mean the trigger is not in this catalog revision).
 */
export function nudgeFor(triggerId: string): NudgeRule | undefined {
  return NUDGE_CATALOG.find((n) => n.id === triggerId);
}

/**
 * The L7 nudge-injection seam — REAL injector (L7 E1).
 *
 * Looks the nudge up by `triggerId` against {@link NUDGE_CATALOG} and writes its corrective text into
 * the agent's live `pane`, reusing C2's injection primitive ({@link injectMail}: write → echo-verify →
 * one Enter, with the continuous dialog-watcher). The watchdog
 * ({@link ../pty/liveness-watchdog.js LivenessWatchdog}) calls this on a detected break (e.g.
 * `finish-before-yield` for a silent-stop) before escalating to STUCK.
 *
 * Fail-loud (Principle 9 / Principle 16): an unknown `triggerId` — no catalog entry — throws rather
 * than silently no-op'ing, so a missing/typo'd trigger is never invisible.
 */
export async function injectNudge(
  pane: Pane,
  triggerId: string,
  opts: InjectMailOptions = {},
): Promise<void> {
  const rule = nudgeFor(triggerId);
  if (rule === undefined) {
    throw new Error(
      `injectNudge: no nudge in NUDGE_CATALOG for trigger id "${triggerId}" — ` +
        'an unknown trigger must fail loud, never silently no-op (Principle 9). ' +
        'This injector rides the L7 Conductor (permissions.md:64-66).',
    );
  }
  await injectMail(pane, rule.nudge, opts);
}
