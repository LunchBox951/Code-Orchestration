import { describe, it, expect } from 'vitest';
import { foldPhaseReadiness, foldTaskReadiness, type PhaseReadinessInput } from './readiness.js';

// L6b E3/D5 — the phase-readiness fold. Phase-ready = workersComplete ∧ phaseVerifiedPass.
// The two MUST-NOT-REGRESS invariants (the prototype's named bugs) each get an explicit test:
//   1. reviewers are EXCLUDED from worker-completion accounting;
//   2. a branch-MERGED worker is COMPLETE regardless of process-state.

describe('foldPhaseReadiness — phase-ready = workersComplete ∧ phaseVerifiedPass', () => {
  it('is READY when every non-reviewer worker branch is merged AND the phase is verified', () => {
    const result = foldPhaseReadiness({
      phaseId: 'pA',
      workers: [
        { workerId: 'impl-1', role: 'implementer', branchMerged: true },
        { workerId: 'impl-2', role: 'implementer', branchMerged: true },
      ],
      verifiedPass: true,
    });
    expect(result).toEqual({ phaseId: 'pA', ready: true, reasonsNotReady: [] });
  });

  it('is READY with NO non-reviewer workers (workersComplete is vacuously true) when verified', () => {
    const result = foldPhaseReadiness({ phaseId: 'pEmpty', workers: [], verifiedPass: true });
    expect(result.ready).toBe(true);
    expect(result.reasonsNotReady).toEqual([]);
  });
});

describe('REGRESSION 1 — reviewers are EXCLUDED from worker-completion accounting', () => {
  it('a phase whose only outstanding worker is a reviewer is READY (the reviewer never holds it back)', () => {
    // Prototype bug: the ready-flag overcounted reviewers. An unmerged reviewer must NOT block.
    const result = foldPhaseReadiness({
      phaseId: 'pA',
      workers: [
        { workerId: 'impl-1', role: 'implementer', branchMerged: true },
        { workerId: 'rev-1', role: 'reviewer', branchMerged: false },
      ],
      verifiedPass: true,
    });
    expect(result.ready).toBe(true);
    expect(result.reasonsNotReady).toEqual([]);
  });

  it('a phase with ONLY a reviewer worker is READY when verified (reviewer fully excluded)', () => {
    const result = foldPhaseReadiness({
      phaseId: 'pA',
      workers: [{ workerId: 'rev-1', role: 'reviewer', branchMerged: false }],
      verifiedPass: true,
    });
    expect(result.ready).toBe(true);
  });
});

describe('REGRESSION 2 — a branch-MERGED worker is COMPLETE regardless of process-state', () => {
  it('a worker whose process is terminal/WAITING but whose branch IS merged is COMPLETE → READY', () => {
    // Prototype bug: a WAITING-but-merged worker was counted not-ready, so readiness was unreachable.
    // The fold sees ONLY `branchMerged` — there is no process-state input, by design. A merged branch
    // is complete, full stop, so a normal-completion path reaches readiness.
    const result = foldPhaseReadiness({
      phaseId: 'pA',
      workers: [{ workerId: 'impl-terminal', role: 'implementer', branchMerged: true }],
      verifiedPass: true,
    });
    expect(result.ready).toBe(true);
    expect(result.reasonsNotReady).toEqual([]);
  });
});

describe('foldPhaseReadiness — not-ready reasons are enumerated', () => {
  it('names each unmerged non-reviewer worker AND the missing verification', () => {
    const result = foldPhaseReadiness({
      phaseId: 'pA',
      workers: [
        { workerId: 'impl-1', role: 'implementer', branchMerged: true },
        { workerId: 'impl-2', role: 'implementer', branchMerged: false },
        { workerId: 'impl-3', role: 'implementer', branchMerged: false },
        { workerId: 'rev-1', role: 'reviewer', branchMerged: false }, // excluded → no reason
      ],
      verifiedPass: false,
    });
    expect(result.ready).toBe(false);
    expect(result.reasonsNotReady).toEqual([
      'worker impl-2 branch not merged',
      'worker impl-3 branch not merged',
      'phase not verified (no green phase.verified)',
    ]);
  });

  it('is NOT ready when verifiedPass is false even though every worker is merged', () => {
    const result = foldPhaseReadiness({
      phaseId: 'pA',
      workers: [{ workerId: 'impl-1', role: 'implementer', branchMerged: true }],
      verifiedPass: false,
    });
    expect(result.ready).toBe(false);
    expect(result.reasonsNotReady).toEqual(['phase not verified (no green phase.verified)']);
  });

  it('is NOT ready when verifiedPass is ABSENT (undefined ≠ true)', () => {
    const result = foldPhaseReadiness({
      phaseId: 'pA',
      workers: [{ workerId: 'impl-1', role: 'implementer', branchMerged: true }],
      verifiedPass: undefined,
    });
    expect(result.ready).toBe(false);
    expect(result.reasonsNotReady).toEqual(['phase not verified (no green phase.verified)']);
  });
});

describe('foldTaskReadiness — the task is ready iff EVERY phase is ready', () => {
  it('rolls up: ready when all phases ready', () => {
    const phases: PhaseReadinessInput[] = [
      {
        phaseId: 'pA',
        workers: [{ workerId: 'i1', role: 'implementer', branchMerged: true }],
        verifiedPass: true,
      },
      { phaseId: 'pB', workers: [], verifiedPass: true },
    ];
    const task = foldTaskReadiness(phases);
    expect(task.ready).toBe(true);
    expect(task.phases.map((p) => p.ready)).toEqual([true, true]);
  });

  it('rolls up: NOT ready when any single phase is not ready', () => {
    const phases: PhaseReadinessInput[] = [
      {
        phaseId: 'pA',
        workers: [{ workerId: 'i1', role: 'implementer', branchMerged: true }],
        verifiedPass: true,
      },
      {
        phaseId: 'pB',
        workers: [{ workerId: 'i2', role: 'implementer', branchMerged: false }],
        verifiedPass: true,
      },
    ];
    const task = foldTaskReadiness(phases);
    expect(task.ready).toBe(false);
    expect(task.phases.find((p) => p.phaseId === 'pB')?.reasonsNotReady).toEqual([
      'worker i2 branch not merged',
    ]);
  });

  it('a task with no phases is vacuously ready', () => {
    expect(foldTaskReadiness([])).toEqual({ ready: true, phases: [] });
  });
});

describe('foldPhaseReadiness — determinism (clock-free, pure)', () => {
  it('identical inputs always produce identical output', () => {
    const input: PhaseReadinessInput = {
      phaseId: 'pA',
      workers: [
        { workerId: 'impl-1', role: 'implementer', branchMerged: false },
        { workerId: 'rev-1', role: 'reviewer', branchMerged: false },
      ],
      verifiedPass: false,
    };
    expect(foldPhaseReadiness(input)).toEqual(foldPhaseReadiness(input));
  });
});
