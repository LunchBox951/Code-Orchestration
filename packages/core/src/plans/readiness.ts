/**
 * L6b E3/D5 — the PHASE-READINESS FOLD. The single riskiest unit in L6b: a pure, clock-free,
 * deterministic decision (no I/O — it takes injected records, mirroring
 * {@link import('../review/serialize.js').foldActiveSlot} and `tools/completeness.ts`) computing
 * whether a phase — and the task as a whole — is ready.
 *
 * D5 phase-ready = `workersComplete ∧ phaseVerifiedPass`, where:
 *   - `workersComplete`  = every NON-REVIEWER worker has `branchMerged === true` (vacuously true when
 *     a phase has no non-reviewer workers).
 *   - `phaseVerifiedPass` = the phase's `verifiedPass === true` — the single green `phase.verified`
 *     record (the phase-tester's mechanical run: criteria-tests pass AND no regression vs
 *     `baselineSha`). PINNED DESIGN DECISION: the fold READS `verifiedPass`; it does NOT re-run
 *     criteria, does NOT look for a distinct phase-tester signal, and does NOT call `validateCriteria`
 *     (that is the ingestion gate, not a runtime check).
 *
 * TWO MUST-NOT-REGRESS INVARIANTS (the prototype's two named bugs; each has an explicit regression
 * test in `readiness.test.ts`):
 *   1. Reviewers are EXCLUDED from worker-completion accounting. A `reviewer`-role child never holds a
 *      phase not-ready. (Prototype bug: the ready-flag overcounted reviewers.)
 *   2. A worker whose branch is MERGED is COMPLETE — completion is defined by `branchMerged`, NEVER by
 *      the worker's process-state. A terminal/WAITING-but-merged worker is complete. (Prototype bug: a
 *      WAITING-but-merged worker was counted not-ready, so readiness was unreachable.)
 */
import type { Role } from '../tools/scoping.js';

/**
 * One worker contributing to a phase's readiness, reduced to the three facts the fold needs. `role`
 * decides reviewer-exclusion (INVARIANT 1); `branchMerged` is the ONLY completion signal (INVARIANT 2
 * — never a process-state); `workerId` names the worker in a not-ready reason.
 */
export interface PhaseWorkerInput {
  readonly workerId: string;
  readonly role: Role;
  readonly branchMerged: boolean;
}

/** The abstract, store-free input for one phase's readiness fold (the tool assembles it from stores). */
export interface PhaseReadinessInput {
  readonly phaseId: string;
  readonly workers: readonly PhaseWorkerInput[];
  /** The phase's `phase.verified` outcome: `true` iff a green record exists. */
  readonly verifiedPass: boolean | undefined;
}

/** The structured per-phase readiness result. `reasonsNotReady` is `[]` exactly when `ready`. */
export interface PhaseReadiness {
  readonly phaseId: string;
  readonly ready: boolean;
  readonly reasonsNotReady: string[];
}

/** The task-level rollup: ready iff every phase is ready. */
export interface TaskReadiness {
  readonly ready: boolean;
  readonly phases: readonly PhaseReadiness[];
}

/**
 * Fold one phase's workers + `verifiedPass` into its {@link PhaseReadiness}. Pure + deterministic — no
 * clock, no I/O. Enumerates one human-readable reason per unmet condition (so a not-ready phase
 * explains itself); `reasonsNotReady` is `[]` exactly when the phase is ready.
 */
export function foldPhaseReadiness(input: PhaseReadinessInput): PhaseReadiness {
  const reasonsNotReady: string[] = [];

  // INVARIANT 1 — reviewers are excluded from worker-completion accounting (a reviewer child never
  // holds the phase not-ready). INVARIANT 2 — a non-reviewer worker is complete iff its BRANCH is
  // merged, regardless of its process-state. workersComplete is vacuously true with no such workers.
  for (const worker of input.workers) {
    if (worker.role === 'reviewer') continue;
    if (!worker.branchMerged) {
      reasonsNotReady.push(`worker ${worker.workerId} branch not merged`);
    }
  }

  // phaseVerifiedPass — a single green phase.verified record (the mechanical suite outcome).
  if (input.verifiedPass !== true) {
    reasonsNotReady.push('phase not verified (no green phase.verified)');
  }

  return { phaseId: input.phaseId, ready: reasonsNotReady.length === 0, reasonsNotReady };
}

/**
 * Roll a task's phases up: fold each phase, then the task is ready iff EVERY phase is ready.
 * An empty phase list is not a runnable plan, so it is never ready.
 */
export function foldTaskReadiness(phases: readonly PhaseReadinessInput[]): TaskReadiness {
  const phaseResults = phases.map(foldPhaseReadiness);
  return {
    ready: phaseResults.length > 0 && phaseResults.every((p) => p.ready),
    phases: phaseResults,
  };
}
