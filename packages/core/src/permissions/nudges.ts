/**
 * L6a Phase D1 — Reactive-nudge catalog as DATA (permissions.md:42-66).
 *
 * The catalog is DATA — substrate-independent policy. Break-detection and injection ride the
 * Conductor / runtime substrate and are L7 (permissions.md:64-66, Principle 16). The
 * `injectNudge` seam is the L7 plug-point: a typed stub that throws loudly rather than silently
 * no-op'ing (Principle 9).
 */

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
 * The L7 nudge-injection seam — TYPED STUB that THROWS loudly.
 *
 * The production implementation rides the Conductor's event stream: when a break is detected,
 * the Conductor looks up the nudge from this catalog and injects it into the agent's context.
 * That mechanism depends on the runtime substrate and is built in L7 (permissions.md:64-66).
 *
 * The catalog/policy DATA is here (substrate-independent). The break-detection + injection is
 * L7. Calling this stub before L7 is wired is a contract violation — it throws loudly rather
 * than returning silently, so the missing wiring is never invisible (Principle 9 / Principle 16).
 */
export function injectNudge(): never {
  throw new Error(
    'injectNudge: reactive-nudge injection rides the Conductor — L7 (permissions.md:64-66). ' +
      'The NUDGE_CATALOG data is declared here; break-detection and injection are L7. ' +
      'This stub must never be a silent no-op (Principle 9).',
  );
}
