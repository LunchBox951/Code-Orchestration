/**
 * Orchestration-benchmark metrics — the reusable, fine-tuning-oriented scorecard schema + PURE
 * aggregation (no host graph, no clock, no I/O: the driver measures wall-clock / turns and passes them
 * in, so this module is deterministic and hermetically testable).
 *
 * The scorecard is the durable output a run produces: per-agent performance (turns, wall-clock,
 * escalations), per-merge review quality (rounds, kickbacks, first-try-PASS), and the hard PASS verdict.
 * A corpus of these across providers/models over time is the per-provider fine-tuning signal the operator
 * asked for. `summarizeRun` computes the totals + the STRUCTURAL pass; whether a pass may be banked as
 * host-live evidence is the driver's call (it derives fidelity from the real pty host — a sandbox run is
 * structurally barred from being recorded as live evidence; Principle 9).
 */
import type { ArtifactCheck } from './orchestration-scenarios.js';

export type ProviderMode = 'claude-only' | 'codex-only' | 'mixed';
export type RunFidelity = 'host-live' | 'sandbox-fake';
export type StopReason = 'task-complete' | 'turn-budget' | 'wall-budget' | 'wedged' | 'error';

/** Per-agent performance over the run (the fine-tuning signal, captured per coordinator/lead/implementer/reviewer). */
export interface AgentRunMetric {
  readonly agentId: string;
  readonly role: string;
  readonly provider: string;
  readonly turnsUsed: number;
  readonly wallClockMs: number;
  /** RL-3 escalations this agent fired (clarify-timeout forwards + watchdog STUCK escalations). */
  readonly escalations: number;
}

/** Per-merge review quality over the run. */
export interface MergeOutcome {
  readonly branch: string;
  readonly target: string;
  /** review_request→verdict cycles for this merge. */
  readonly reviewRounds: number;
  /** How many of those rounds were KICKBACKS (FAIL→fix→re-review). */
  readonly kickbacks: number;
  readonly firstTryPass: boolean;
  readonly mergeCommitSha: string | null;
}

/** The measured inputs the driver hands to {@link summarizeRun}. */
export interface OrchestrationRunInput {
  readonly runId: string;
  readonly scenarioId: string;
  readonly nonce: string;
  readonly providerMode: ProviderMode;
  readonly fidelity: RunFidelity;
  readonly completed: boolean;
  readonly artifact: ArtifactCheck;
  readonly agents: readonly AgentRunMetric[];
  readonly merges: readonly MergeOutcome[];
  readonly stopReason: StopReason;
  /** Distinct implementer branches observed merged up the chain (git log / worktree store). */
  readonly implementerBranchesMergedUp: number;
  /** The decomposition's intended implementer count — the merge-up floor for a structural pass. */
  readonly requiredImplementerMerges: number;
}

/** The aggregated scorecard: the input plus the hard PASS verdict and the rolled-up totals. */
export interface OrchestrationScorecard extends OrchestrationRunInput {
  /** The STRUCTURAL pass: chain completed, oracle correct, every implementer merged up, every merge reviewed. */
  readonly pass: boolean;
  /** Why the structural pass failed (empty when `pass`). */
  readonly failures: readonly string[];
  readonly totalTurns: number;
  readonly totalWallClockMs: number;
  readonly totalReviewRounds: number;
  readonly totalKickbacks: number;
  readonly totalEscalations: number;
  readonly agentsByRole: Readonly<Record<string, number>>;
}

/**
 * Fold the measured inputs into a scorecard. The PASS verdict is hard and objective: the chain completed,
 * the executed oracle was correct, at least the intended number of implementer branches merged up, AND
 * every merge held at least one review round (the gate held). Anything else is a concrete failure reason.
 */
export function summarizeRun(input: OrchestrationRunInput): OrchestrationScorecard {
  const failures: string[] = [];
  if (!input.completed) failures.push('chain did not complete (no task.completed)');
  if (!input.artifact.correct) failures.push(`artifact oracle failed: ${input.artifact.detail}`);
  if (input.implementerBranchesMergedUp < input.requiredImplementerMerges) {
    failures.push(
      `only ${input.implementerBranchesMergedUp} of ${input.requiredImplementerMerges} implementer ` +
        'branches merged up',
    );
  }
  if (input.merges.length === 0) {
    failures.push('no merges recorded (the review gate never ran)');
  } else {
    const ungated = input.merges.filter((m) => m.reviewRounds < 1);
    if (ungated.length > 0) {
      failures.push(`${ungated.length} merge(s) landed without a review round`);
    }
  }

  const agentsByRole: Record<string, number> = {};
  for (const a of input.agents) agentsByRole[a.role] = (agentsByRole[a.role] ?? 0) + 1;

  return {
    ...input,
    pass: failures.length === 0,
    failures,
    totalTurns: sum(input.agents.map((a) => a.turnsUsed)),
    totalWallClockMs: sum(input.agents.map((a) => a.wallClockMs)),
    totalReviewRounds: sum(input.merges.map((m) => m.reviewRounds)),
    totalKickbacks: sum(input.merges.map((m) => m.kickbacks)),
    totalEscalations: sum(input.agents.map((a) => a.escalations)),
    agentsByRole,
  };
}

/**
 * Serialize a scorecard to JSONL: one record per agent (for the per-provider corpus) plus one run-summary
 * record. Append-only friendly — a CO_BENCH_CORPUS_DIR can accumulate runs across providers/models.
 */
export function toJsonl(scorecard: OrchestrationScorecard): string {
  const lines: string[] = [];
  for (const agent of scorecard.agents) {
    lines.push(
      JSON.stringify({
        type: 'agent',
        runId: scorecard.runId,
        scenarioId: scorecard.scenarioId,
        providerMode: scorecard.providerMode,
        fidelity: scorecard.fidelity,
        ...agent,
      }),
    );
  }
  lines.push(
    JSON.stringify({
      type: 'run',
      runId: scorecard.runId,
      scenarioId: scorecard.scenarioId,
      nonce: scorecard.nonce,
      providerMode: scorecard.providerMode,
      fidelity: scorecard.fidelity,
      pass: scorecard.pass,
      completed: scorecard.completed,
      artifactCorrect: scorecard.artifact.correct,
      artifactDetail: scorecard.artifact.detail,
      stopReason: scorecard.stopReason,
      implementerBranchesMergedUp: scorecard.implementerBranchesMergedUp,
      totalTurns: scorecard.totalTurns,
      totalWallClockMs: scorecard.totalWallClockMs,
      totalReviewRounds: scorecard.totalReviewRounds,
      totalKickbacks: scorecard.totalKickbacks,
      totalEscalations: scorecard.totalEscalations,
      agentsByRole: scorecard.agentsByRole,
      merges: scorecard.merges,
      failures: scorecard.failures,
    }),
  );
  return lines.join('\n') + '\n';
}

/** A compact human-legible scorecard for the test/CLI output (the operator reviews this, not a checkbox). */
export function renderScorecard(scorecard: OrchestrationScorecard): string {
  const verdict = scorecard.pass ? 'PASS' : 'FAIL';
  const lines = [
    `orchestration-benchmark ${scorecard.scenarioId} — ${verdict} (${scorecard.fidelity}, ${scorecard.providerMode})`,
    `  run:        ${scorecard.runId}  stop=${scorecard.stopReason}`,
    `  completed:  ${scorecard.completed}   artifact: ${scorecard.artifact.correct} — ${scorecard.artifact.detail}`,
    `  merged-up:  ${scorecard.implementerBranchesMergedUp}/${scorecard.requiredImplementerMerges} implementer branches`,
    `  totals:     turns=${scorecard.totalTurns} wall=${scorecard.totalWallClockMs}ms reviews=${scorecard.totalReviewRounds} kickbacks=${scorecard.totalKickbacks} escalations=${scorecard.totalEscalations}`,
    `  agents:     ${Object.entries(scorecard.agentsByRole)
      .map(([role, n]) => `${role}×${n}`)
      .join(' ')}`,
  ];
  for (const a of scorecard.agents) {
    lines.push(
      `    - ${a.role} ${a.agentId} [${a.provider}]: turns=${a.turnsUsed} wall=${a.wallClockMs}ms esc=${a.escalations}`,
    );
  }
  for (const f of scorecard.failures) lines.push(`  ✗ ${f}`);
  return lines.join('\n') + '\n';
}

function sum(xs: readonly number[]): number {
  return xs.reduce((acc, x) => acc + x, 0);
}
