/**
 * L7 E1 — the liveness watchdog (PURE classifier + an injected-seam escalation driver).
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS (AC-L7-5 / must-not-regress): a wedged or silently-stopped session must be caught in
 * a BOUNDED window (~8 s), never a multi-hour reap. {@link classifyLiveness} turns the P4-measured byte
 * signatures into an `alive | wedged | dead` verdict (+ a distinct silent-stop break), and
 * {@link LivenessWatchdog} drives the must-not-regress escalation: **detect break → injectNudge (gentle
 * corrective) → if the break persists, STUCK.** The classifier is PURE (time is DATA — the event `at`s
 * + an injected `observedAt`, never a wall clock); the STUCK transition and the live monitor loop are
 * INTEGRATION (the runtime router owns agent-state; `co unstick` flips it back), so they enter here only
 * as constructor-injected seams.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * The P4 live-probe signatures this encodes:
 *   - **alive** — bytes are flowing. A working session is NEVER byte-silent: the TUI spinner renders
 *     continuously (2.7–12.5 KB / 5 s) even during a command-silent `sleep`. Bytes within the window ⇒
 *     alive, regardless of whether the underlying command produces output.
 *   - **wedged** — `SIGSTOP` mid-turn ⇒ 0 bytes in every window while the pid is still alive
 *     (`kill(pid,0)` succeeds). The rule that fired at exactly 8.0 s and never in the alive phase:
 *     **pid-alive ∧ zero-pty-bytes ≥ {@link WEDGE_MS} during an ACTIVE turn ⇒ wedged**. `SIGCONT`
 *     resumes rendering ⇒ back to alive.
 *   - **dead** — the pane exited (`Pane.onExit` fired). Highest precedence, trivially detectable.
 *
 * Silent-stop is a DISTINCT break (not a liveness state): a turn that has gone idle
 * (`detectTurnEnd.idle`) with NO completion verb and a quiet pty = the agent ended its turn WITHOUT
 * `co_finish`/`worker_done` (the `finish-before-yield` break). The process is `alive`; it just stopped
 * without finishing — so silent-stop rides alongside `liveness: 'alive'` as a `break`, never a reap.
 *
 * ── wedged vs silent-stop ([synthesized] reconciliation) ─────────────────────────────────────────────
 * Both are byte-quiet, so bytes alone cannot tell them apart. The separator is {@link LivenessInput.turnActive}
 * — a SEMANTIC signal owned by the runtime (a mail was injected and the agent has NOT yet yielded its
 * turn back to the warm-session waiter), NOT recomputed from byte-quiescence here. A frozen (SIGSTOP)
 * turn is byte-quiet yet STILL ACTIVE (it never yielded) ⇒ wedged; a silent-stop turn went byte-quiet
 * BECAUSE it yielded without finishing ⇒ alive + silent-stop break. This is the integration-layer
 * reading of "active turn = a mail was injected and the turn has neither gone idle nor produced a
 * completion verb" — host-side confirm.
 */
import { detectTurnEnd, type DetectorEvent, type TurnEndConfig } from './turn-end-detector.js';
import type { Pane } from './pty-host.js';
import { injectNudge as defaultInjectNudge } from '../permissions/nudges.js';

/** The liveness triad. `wedged`/`dead` are breaks; `alive` may still carry a silent-stop break. */
export type Liveness = 'alive' | 'wedged' | 'dead';

/**
 * Zero pty bytes for this long, while the pid is alive during an ACTIVE turn, ⇒ wedged. Measured at
 * exactly 8.0 s by the P4 probe and never in the alive phase. Named constant; tunable host-side.
 */
export const WEDGE_MS = 8000;

/**
 * A detected break that warrants escalation: a frozen pane, an exited pane, a finish-before-yield,
 * or an errored-turn with outstanding actionable mail (the MNR-2 re-wake signal).
 */
export type BreakKind = 'wedged' | 'dead' | 'silent_stop' | 'errored_waiting';

/** The `finish-before-yield` nudge id (NUDGE_CATALOG) injected on a silent-stop break. */
export const SILENT_STOP_TRIGGER = 'finish-before-yield';

/** A break the monitor escalates on, plus the gentle-corrective nudge id (when one applies). */
export interface BreakInfo {
  readonly kind: BreakKind;
  /** The NUDGE_CATALOG id to inject as a gentle corrective, or undefined when none applies. */
  readonly triggerId: string | undefined;
  /** Human-readable diagnosis (reporting only — drives nothing). */
  readonly reason: string;
}

/**
 * The observation the classifier judges. Mirrors C2's detector: time is DATA (the event `at`s +
 * `observedAt`), never a wall clock, so tests drive the 8 s boundary exactly.
 */
export interface LivenessInput {
  /** The byte-activity stream (+ mcp/osc0), the same trace {@link detectTurnEnd} consumes. */
  readonly trace: readonly DetectorEvent[];
  /** True once `Pane.onExit` has fired. Highest-precedence: an exited pane is `dead`. */
  readonly exited: boolean;
  /** `kill(pid, 0)` succeeds — the OS process still exists (SIGSTOP keeps a frozen process alive). */
  readonly pidAlive: boolean;
  /**
   * The runtime believes a turn is IN FLIGHT: a mail was injected and the agent has not yielded its
   * turn back to the warm-session waiter. A SEMANTIC signal (host-side), NOT recomputed from
   * byte-quiescence — this is what separates a frozen (still-active) turn from a yielded silent-stop.
   */
  readonly turnActive: boolean;
  /**
   * Optional monotonic timestamp for the current turn start. When present, liveness ignores prior
   * turn activity; zero bytes since this timestamp for the wedge window is a wedge.
   */
  readonly turnStartedAt?: number;
  /**
   * True when the PREVIOUS turn threw (errored) without consuming its mail (MNR-2 seam). When
   * combined with `hasWaitingItems` + `hasOutstandingActionable`, the watchdog emits the
   * `errored_waiting` re-wake signal so the conductor re-injects the outstanding mail.
   * Additive/injected — defaults false, so existing reconcile tests are unaffected.
   */
  readonly lastTurnErrored?: boolean;
  /**
   * True when the agent has at least one unanswered `clarify_request` it raised (`waitingItems`
   * from `mail/escalation.ts`). Injected by the host-side `livenessInputFor` seam.
   */
  readonly hasWaitingItems?: boolean;
  /**
   * True when the agent's inbox contains at least one outstanding (unresolved) actionable mail
   * (`mail.outstanding(agent)` non-empty). Injected by the host-side `livenessInputFor` seam.
   */
  readonly hasOutstandingActionable?: boolean;
}

/** Classifier config. Extends the C2 detector config (provider/quiet window) with the wedge window. */
export interface LivenessConfig extends TurnEndConfig {
  /** Override {@link WEDGE_MS} (named constant; tunable host-side). */
  readonly wedgeMs?: number;
}

/** The verdict: the liveness state plus an optional break to escalate on (undefined when healthy). */
export interface LivenessVerdict {
  readonly liveness: Liveness;
  readonly break: BreakInfo | undefined;
}

/**
 * Classify a session from one observation. PURE and deterministic. Precedence: dead > wedged >
 * silent-stop > alive.
 */
export function classifyLiveness(
  input: LivenessInput,
  observedAt: number,
  config: LivenessConfig = {},
): LivenessVerdict {
  const wedgeMs = config.wedgeMs ?? WEDGE_MS;

  // dead — highest precedence: an exited pane overrides every byte signal.
  if (input.exited) {
    return {
      liveness: 'dead',
      break: { kind: 'dead', triggerId: undefined, reason: 'pane exited' },
    };
  }

  // errored_waiting — the last turn threw without consuming its mail, the agent is waiting on
  // an unanswered clarify, and it still has outstanding actionable mail. This is the MNR-2
  // re-wake signal: surface it so the conductor re-injects the still-outstanding item. Checked
  // before byte-silence signals because the agent may be healthy byte-wise; the outstanding mail
  // is the reason to re-wake, not a liveness failure.
  if (
    input.lastTurnErrored === true &&
    input.hasWaitingItems === true &&
    input.hasOutstandingActionable === true
  ) {
    return {
      liveness: 'alive',
      break: {
        kind: 'errored_waiting',
        triggerId: undefined, // no pane nudge — the conductor re-injects the outstanding mail
        reason: 'last turn errored; agent is waiting with outstanding actionable mail — re-inject',
      },
    };
  }

  // Byte-silence is measured from the last rendered byte (a working session renders continuously, so
  // "had bytes, then went silent" is the wedge signature). With no byte ever rendered there is nothing
  // to have gone quiet FROM — we do not synthesize a wedge from absence alone (mirrors detectTurnEnd).
  let lastByteAt: number | undefined;
  for (const ev of input.trace) {
    if (
      ev.kind === 'bytes' &&
      (input.turnStartedAt == null || ev.at >= input.turnStartedAt) &&
      (lastByteAt === undefined || ev.at > lastByteAt)
    ) {
      lastByteAt = ev.at;
    }
  }
  const silenceStartedAt = lastByteAt ?? input.turnStartedAt;
  const byteSilentForWedge =
    silenceStartedAt !== undefined && observedAt - silenceStartedAt >= wedgeMs;

  // wedged — pid alive ∧ ACTIVE turn ∧ zero pty bytes ≥ WEDGE_MS. The process is frozen mid-turn: it
  // never yielded (turnActive) yet renders nothing (byte-silent) while the pid still exists (pidAlive).
  if (input.turnActive && input.pidAlive && byteSilentForWedge) {
    return {
      liveness: 'wedged',
      break: {
        kind: 'wedged',
        triggerId: undefined, // a frozen process cannot echo a nudge — escalate straight to STUCK
        reason: `no pty bytes for >= ${wedgeMs}ms while pid alive during an active turn`,
      },
    };
  }

  // silent-stop — the agent YIELDED its turn (no longer active) but went idle with NO completion verb
  // and a quiet pty: it stopped without finishing. Reuse C2's detector for the idle + no-verb gate.
  if (!input.turnActive) {
    const trace =
      input.turnStartedAt == null
        ? input.trace
        : input.trace.filter((ev) => ev.at >= input.turnStartedAt!);
    const turnEnd = detectTurnEnd(trace, observedAt, config);
    if (turnEnd.idle && !turnEnd.sawCompletionVerb) {
      return {
        liveness: 'alive',
        break: {
          kind: 'silent_stop',
          triggerId: SILENT_STOP_TRIGGER,
          reason: 'turn went idle without co_finish/worker_done',
        },
      };
    }
  }

  // alive — bytes flowing (or quiet but still mid-turn and not yet wedged); healthy, no break.
  return { liveness: 'alive', break: undefined };
}

/** Break-signal seam: the monitor records a detected break against `agent`. */
export type BreakSignal = (agent: string, info: BreakInfo) => void;
/** STUCK-escalation seam: the runtime router flips `agent` into the STUCK state (`co unstick` reverts). */
export type MarkStuck = (agent: string) => void;
/** Nudge-injection seam (defaults to the real {@link defaultInjectNudge}; a spy in tests). */
export type InjectNudgeFn = (pane: Pane, triggerId: string) => Promise<void>;

/** Constructor-injected monitor seams. `injectNudge` defaults to the real catalog injector. */
export interface MonitorSeams {
  /** The agent's live pane (the nudge is injected here). */
  readonly pane: Pane;
  /** Emit the break-signal the L6 monitor escalates on. */
  readonly onBreak: BreakSignal;
  /** Escalate to STUCK once a break persists past the gentle corrective. */
  readonly markStuck: MarkStuck;
  /** Override the nudge injector (defaults to the real {@link defaultInjectNudge}). */
  readonly injectNudge?: InjectNudgeFn;
}

/**
 * Drives the bounded escalation over repeated observations using injected seams — sandbox-testable with
 * a fake monitor, NO live monitor loop. The policy:
 *   - **healthy** → clear any in-flight break (e.g. SIGCONT resumed rendering ⇒ recovered).
 *   - **new break** (wedged / silent_stop) → inject the gentle corrective (if the break has a nudge),
 *     then emit the break-signal. STUCK is NOT triggered yet — the nudge gets a chance to resolve it.
 *   - **persisting break** (same kind seen again) → escalate to STUCK.
 *   - **dead** → emit the break-signal once; a dead process is reaped by the runtime, not nudged or
 *     marked stuck.
 */
export class LivenessWatchdog {
  private readonly pane: Pane;
  private readonly onBreak: BreakSignal;
  private readonly markStuck: MarkStuck;
  private readonly injectNudge: InjectNudgeFn;
  /** The break kind already signaled this episode (so a repeat is "persisting"); cleared on recovery. */
  private signaled: BreakKind | undefined;

  constructor(seams: MonitorSeams) {
    this.pane = seams.pane;
    this.onBreak = seams.onBreak;
    this.markStuck = seams.markStuck;
    this.injectNudge = seams.injectNudge ?? defaultInjectNudge;
  }

  /**
   * Judge one observation and drive the escalation. Returns the {@link LivenessVerdict} for the caller
   * to log/inspect. Async because the gentle corrective ({@link injectNudge}) drives the live pane.
   */
  async assess(
    agent: string,
    input: LivenessInput,
    observedAt: number,
    config: LivenessConfig = {},
  ): Promise<LivenessVerdict> {
    const verdict = classifyLiveness(input, observedAt, config);
    const detected = verdict.break;

    if (detected === undefined) {
      this.signaled = undefined; // healthy (or recovered) — reset the episode
      return verdict;
    }

    if (detected.kind === 'dead') {
      if (this.signaled !== 'dead') {
        this.signaled = 'dead';
        this.onBreak(agent, detected); // emit once; the runtime reaps a dead pane (no nudge, no STUCK)
      }
      return verdict;
    }

    if (detected.kind === 'errored_waiting') {
      if (this.signaled !== 'errored_waiting') {
        this.signaled = 'errored_waiting';
        this.onBreak(agent, detected); // emit once; the conductor re-injects the outstanding mail
      }
      return verdict;
    }

    // wedged | silent_stop — break-signal first (never lose the diagnosis), then gentle corrective,
    // then STUCK if it persists.
    if (this.signaled === detected.kind) {
      this.markStuck(agent); // the break survived the corrective ⇒ escalate
    } else {
      this.signaled = detected.kind;
      this.onBreak(agent, detected);
      if (detected.triggerId !== undefined) await this.injectNudge(this.pane, detected.triggerId);
    }
    return verdict;
  }
}
