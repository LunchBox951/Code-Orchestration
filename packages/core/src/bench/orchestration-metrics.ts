/**
 * Orchestration-benchmark metrics — the reusable, fine-tuning-oriented scorecard schema + PURE
 * aggregation (no host graph, no clock, no I/O: the driver measures wall-clock / turns / tokens / tool
 * usage and passes them in, so this module is deterministic and hermetically testable).
 *
 * The scorecard is the durable output a run produces: per-agent performance (turns, wall-clock,
 * escalations), per-merge review quality (rounds, kickbacks, first-try-PASS), the hard PASS verdict, AND
 * the THREE comparable scores — CORRECTNESS, TOKEN-ECONOMY, CONTEXT/TOOL-EFFICIENCY (each ∈ [0,1] or
 * `null` = N/A), reported per-run, per-agent, and per-role. A corpus of these across providers/models over
 * time is the per-provider fine-tuning signal the operator asked for. `summarizeRun` computes the totals,
 * the STRUCTURAL pass, and folds the per-role score aggregates; whether a pass may be banked as host-live
 * evidence is the driver's call (it derives fidelity from the real pty host — a sandbox run is
 * structurally barred from being recorded as live evidence; Principle 9).
 *
 * THE THREE SCORES (each ∈ [0,1], or `null` when not applicable — NEVER a silent zero):
 *   1. CORRECTNESS (objective; both arms): the artifact's oracle case fraction, gated by structural
 *      completeness — see {@link correctnessScore}.
 *   2. TOKEN-ECONOMY (LIVE-ONLY; `null` in the sandbox arm): tokens-vs-budget — see {@link tokenEconomyScore}.
 *   3. CONTEXT/TOOL-EFFICIENCY (both arms): a weighted blend of (1−failRate)/(1−redundantReadRate)/
 *      (1−permissionAskRate) — see {@link contextEfficiencyScore}.
 */
import type { ArtifactCheck } from './orchestration-scenarios.js';
import type { AgentCostRollup, AgentToolUsage } from './bench-econ-types.js';

export type { AgentCostRollup, AgentToolUsage } from './bench-econ-types.js';

export type ProviderMode = 'claude-only' | 'codex-only' | 'mixed';
export type RunFidelity = 'host-live' | 'sandbox-fake';
export type StopReason = 'task-complete' | 'turn-budget' | 'wall-budget' | 'wedged' | 'error';

/**
 * Per-scenario TOKEN BUDGET placeholder (UNCALIBRATED — the first live runs are the calibration). The
 * token-economy score is `clamp01(budget / max(actual, 1))`, so a run at-or-under budget scores 1 and an
 * over-budget run degrades toward 0. These numbers were NOT measured against a real binary driving the
 * full chain; treat them as a relative yardstick, not an absolute target, and tune them as the corpus
 * grows. An unknown scenario falls back to {@link DEFAULT_BUDGET_TOKENS}.
 */
export const BUDGET_TOKENS_BY_SCENARIO: Readonly<Record<string, number>> = {
  'calc-lib': 2_000_000,
  'add-module': 200_000,
};

/** The token budget used when a scenario id is not in {@link BUDGET_TOKENS_BY_SCENARIO} (uncalibrated). */
export const DEFAULT_BUDGET_TOKENS = 1_000_000;

/**
 * The CONTEXT/TOOL-EFFICIENCY blend weights (TUNABLE). The score is
 * `wFail·(1−toolFailRate) + wRedundant·(1−redundantReadRate) + wPermission·(1−permissionAskRate)`; the
 * three weights sum to 1. They were chosen by judgement (tool failures and redundant reads are the
 * costliest context inefficiencies, permission asks a lighter friction), NOT calibrated — tune them as
 * the corpus shows which signal best predicts a good agent.
 */
export const CONTEXT_EFFICIENCY_WEIGHTS = {
  toolFail: 0.4,
  redundantRead: 0.4,
  permissionAsk: 0.2,
} as const;

/** Resolve the (uncalibrated) per-scenario token budget for the economy score. */
export function budgetTokensForScenario(scenarioId: string): number {
  return BUDGET_TOKENS_BY_SCENARIO[scenarioId] ?? DEFAULT_BUDGET_TOKENS;
}

/** Clamp a number into [0, 1]; non-finite inputs collapse to 0 (fail-closed, never NaN in the corpus). */
export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * The CORRECTNESS score (objective; BOTH arms). Refines the binary `artifact.correct` into a fraction of
 * oracle cases passed, gated by structural completeness so token-economy can NEVER mask a correctness miss:
 *
 *   correctness = (casesPassed / casesTotal)
 *               × (completed ? 1 : 0)
 *               × (implementerBranchesMergedUp / requiredImplementerMerges)   [clamped to ≤ 1]
 *               × (everyMergeHadReview ? 1 : 0)
 *
 * `casesTotal === 0` (a scenario with no oracle cases) yields 0 (we cannot claim correctness with no
 * evidence — fail-closed). The merge-up ratio is clamped to 1 so over-merging cannot inflate the score.
 */
export function correctnessScore(input: {
  readonly artifact: ArtifactCheck;
  readonly completed: boolean;
  readonly implementerBranchesMergedUp: number;
  readonly requiredImplementerMerges: number;
  readonly everyMergeHadReview: boolean;
}): number {
  const { artifact, completed, implementerBranchesMergedUp, requiredImplementerMerges } = input;
  if (artifact.casesTotal <= 0) return 0;
  const caseFraction = clamp01(artifact.casesPassed / artifact.casesTotal);
  const completedFactor = completed ? 1 : 0;
  const mergeFactor =
    requiredImplementerMerges <= 0
      ? 1
      : clamp01(implementerBranchesMergedUp / requiredImplementerMerges);
  const reviewFactor = input.everyMergeHadReview ? 1 : 0;
  return clamp01(caseFraction * completedFactor * mergeFactor * reviewFactor);
}

/**
 * The TOKEN-ECONOMY score (LIVE-ONLY). `null` when no cost rollup is available — i.e. a SANDBOX run spends
 * no real tokens, so the driver passes `null` and this returns `null` (N/A), NEVER 0 (the silent-zero trap
 * that already afflicts live `turnsUsed`). When a rollup IS present:
 *   tokenEconomy = clamp01(budgetTokens / max(actualTokens, 1))
 */
export function tokenEconomyScore(
  cost: AgentCostRollup | null,
  budgetTokens: number,
): number | null {
  if (cost == null) return null;
  return clamp01(budgetTokens / Math.max(cost.totalTokens, 1));
}

/**
 * The cache-efficiency SUB-SIGNAL (LIVE-ONLY): `cacheReadTokens / max(cacheReadTokens + cacheCreationTokens, 1)`
 * — the share of cacheable prompt tokens served from the cache rather than (re)written into it. `null`
 * with no cost rollup (sandbox).
 */
export function cacheEfficiency(cost: AgentCostRollup | null): number | null {
  if (cost == null) return null;
  const denom = cost.cacheReadTokens + cost.cacheCreationTokens;
  return clamp01(cost.cacheReadTokens / Math.max(denom, 1));
}

/**
 * The CONTEXT/TOOL-EFFICIENCY score (BOTH arms). `null` when no tool-usage rollup is available. When a
 * rollup IS present (even with zero tool calls — a real "no friction" observation, not a missing one):
 *   toolFailRate       = toolErrors    / max(toolCalls, 1)
 *   redundantReadRate  = redundantReads / max(toolCalls, 1)
 *   permissionAskRate  = permissionAsks / max(toolCalls, 1)
 *   contextEfficiency  = wFail·(1−toolFailRate) + wRedundant·(1−redundantReadRate)
 *                                               + wPermission·(1−permissionAskRate)
 * (weights from {@link CONTEXT_EFFICIENCY_WEIGHTS} — tunable). A clean run (no errors / redundant reads /
 * permission asks) scores 1.
 */
export function contextEfficiencyScore(tool: AgentToolUsage | null): number | null {
  if (tool == null) return null;
  const denom = Math.max(tool.toolCalls, 1);
  const toolFailRate = clamp01(tool.toolErrors / denom);
  const redundantReadRate = clamp01(tool.redundantReads / denom);
  const permissionAskRate = clamp01(tool.permissionAsks / denom);
  const w = CONTEXT_EFFICIENCY_WEIGHTS;
  return clamp01(
    w.toolFail * (1 - toolFailRate) +
      w.redundantRead * (1 - redundantReadRate) +
      w.permissionAsk * (1 - permissionAskRate),
  );
}

/**
 * The raw per-agent token economy fields lifted onto the scorecard (LIVE-ONLY; every field `null` in the
 * sandbox arm, where no real tokens are spent — never a silent zero). Mirrors {@link AgentCostRollup}
 * plus the derived `tokenEconomy` / `cacheEfficiency` scores.
 */
export interface AgentTokenEconomy {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheCreationTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  /** clamp01(budgetTokens / max(totalTokens, 1)); `null` in the sandbox arm. */
  readonly tokenEconomy: number | null;
  /** cacheRead / (cacheRead + cacheCreation); `null` in the sandbox arm. */
  readonly cacheEfficiency: number | null;
}

/**
 * The raw per-agent tool-efficiency fields lifted onto the scorecard (BOTH arms; `null` only when the
 * driver had no tool-usage rollup at all). The three rates + the derived `contextEfficiency` score, plus
 * two un-scored DIAGNOSTICS reported raw.
 */
export interface AgentToolEfficiency {
  readonly toolCalls: number | null;
  readonly toolErrors: number | null;
  readonly redundantReads: number | null;
  readonly permissionAsks: number | null;
  /** 0.4·(1−failRate)+0.4·(1−redundantReadRate)+0.2·(1−permissionAskRate); `null` with no rollup. */
  readonly contextEfficiency: number | null;
  /** DIAGNOSTIC (un-scored): turns before the agent's first productive `co_` call. */
  readonly turnsToFirstProductiveCoCall: number | null;
  /** DIAGNOSTIC (un-scored): tool calls per completed task. */
  readonly toolCallsPerCompletedTask: number | null;
}

/**
 * Build the per-agent {@link AgentTokenEconomy} (LIVE-ONLY) from a raw cost rollup. A `null` rollup (the
 * SANDBOX arm, where no real tokens are spent) yields all-`null` fields + a `null` economy score — NEVER a
 * silent zero. `budgetTokens` is the (uncalibrated) per-scenario budget the economy score is measured
 * against. Exported so the `@co/mcp` driver builds the metric without duplicating the null-vs-zero logic.
 */
export function buildTokenEconomy(
  cost: AgentCostRollup | null,
  budgetTokens: number,
): AgentTokenEconomy {
  return {
    inputTokens: cost?.inputTokens ?? null,
    outputTokens: cost?.outputTokens ?? null,
    cacheReadTokens: cost?.cacheReadTokens ?? null,
    cacheCreationTokens: cost?.cacheCreationTokens ?? null,
    totalTokens: cost?.totalTokens ?? null,
    costUsd: cost?.costUsd ?? null,
    tokenEconomy: tokenEconomyScore(cost, budgetTokens),
    cacheEfficiency: cacheEfficiency(cost),
  };
}

/**
 * Build the per-agent {@link AgentToolEfficiency} (BOTH arms) from a raw tool-usage rollup. A `null` rollup
 * (no tool observations available) yields all-`null` fields + a `null` context-efficiency score. The two
 * diagnostics ride along raw (un-scored). Exported so the driver stays a thin adapter.
 */
export function buildToolEfficiency(tool: AgentToolUsage | null): AgentToolEfficiency {
  return {
    toolCalls: tool?.toolCalls ?? null,
    toolErrors: tool?.toolErrors ?? null,
    redundantReads: tool?.redundantReads ?? null,
    permissionAsks: tool?.permissionAsks ?? null,
    contextEfficiency: contextEfficiencyScore(tool),
    turnsToFirstProductiveCoCall: tool?.turnsToFirstProductiveCoCall ?? null,
    toolCallsPerCompletedTask: tool?.toolCallsPerCompletedTask ?? null,
  };
}

/** Per-agent performance over the run (the fine-tuning signal, captured per coordinator/lead/implementer/reviewer). */
export interface AgentRunMetric {
  readonly agentId: string;
  readonly role: string;
  readonly provider: string;
  readonly turnsUsed: number;
  readonly wallClockMs: number;
  /** RL-3 escalations this agent fired (clarify-timeout forwards + watchdog STUCK escalations). */
  readonly escalations: number;
  /** LIVE-ONLY token economy (raw tokens + economy/cache scores); every field `null` in the sandbox arm. */
  readonly tokenEconomy: AgentTokenEconomy;
  /** Context/tool efficiency (raw tool rates + the contextEfficiency score); `null` fields with no rollup. */
  readonly toolEfficiency: AgentToolEfficiency;
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

/**
 * A per-role aggregate of one of the three scores. `null` members (an N/A score for that arm) are skipped:
 * `count` is the number of agents in the role that reported a non-null value, and `mean` is the average
 * over those (or `null` when none reported — never a misleading 0).
 */
export interface RoleScoreAggregate {
  readonly count: number;
  readonly mean: number | null;
}

/** The three run-level scores + their per-role folds (the comparable per-provider corpus signal). */
export interface RunScores {
  /** CORRECTNESS (objective; both arms) — the run-level value (never null: a run always has a correctness). */
  readonly correctness: number;
  /** TOKEN-ECONOMY (live-only) — the agent-mean, or `null` in the sandbox arm (no real tokens). */
  readonly tokenEconomy: number | null;
  /** CONTEXT/TOOL-EFFICIENCY (both arms) — the agent-mean, or `null` when no tool rollup was available. */
  readonly contextEfficiency: number | null;
  /** Per-role agent-mean of the token-economy score (live-only). */
  readonly tokenEconomyByRole: Readonly<Record<string, RoleScoreAggregate>>;
  /** Per-role agent-mean of the context-efficiency score. */
  readonly contextEfficiencyByRole: Readonly<Record<string, RoleScoreAggregate>>;
}

/** The aggregated scorecard: the input plus the hard PASS verdict, the rolled-up totals, and the scores. */
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
  /** The three comparable scores + their per-role folds. */
  readonly scores: RunScores;
}

/**
 * Fold the measured inputs into a scorecard. The PASS verdict is hard and objective: the chain completed,
 * the executed oracle was correct, at least the intended number of implementer branches merged up, AND
 * every merge held at least one review round (the gate held). Anything else is a concrete failure reason.
 * It ALSO folds the three comparable scores: the run-level CORRECTNESS (objective), the agent-mean
 * TOKEN-ECONOMY (live-only — `null` in the sandbox arm), and the agent-mean CONTEXT/TOOL-EFFICIENCY, plus
 * their per-role aggregates (the per-provider fine-tuning corpus signal).
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
  const everyMergeHadReview =
    input.merges.length > 0 && input.merges.every((m) => m.reviewRounds >= 1);
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

  const correctness = correctnessScore({
    artifact: input.artifact,
    completed: input.completed,
    implementerBranchesMergedUp: input.implementerBranchesMergedUp,
    requiredImplementerMerges: input.requiredImplementerMerges,
    everyMergeHadReview,
  });
  const scores: RunScores = {
    correctness,
    tokenEconomy: agentMean(input.agents.map((a) => a.tokenEconomy.tokenEconomy)),
    contextEfficiency: agentMean(input.agents.map((a) => a.toolEfficiency.contextEfficiency)),
    tokenEconomyByRole: byRole(input.agents, (a) => a.tokenEconomy.tokenEconomy),
    contextEfficiencyByRole: byRole(input.agents, (a) => a.toolEfficiency.contextEfficiency),
  };

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
    scores,
  };
}

/**
 * Serialize a scorecard to JSONL: one record per agent (for the per-provider corpus) plus one run-summary
 * record. Append-only friendly — a CO_BENCH_CORPUS_DIR can accumulate runs across providers/models. Each
 * agent record carries all three per-agent scores (correctness is run-level, so it rides the run record),
 * and the run record carries the run-level scores + the per-role aggregates.
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
        agentId: agent.agentId,
        role: agent.role,
        provider: agent.provider,
        turnsUsed: agent.turnsUsed,
        wallClockMs: agent.wallClockMs,
        escalations: agent.escalations,
        tokenEconomy: agent.tokenEconomy,
        toolEfficiency: agent.toolEfficiency,
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
      artifactCasesPassed: scorecard.artifact.casesPassed,
      artifactCasesTotal: scorecard.artifact.casesTotal,
      artifactDetail: scorecard.artifact.detail,
      stopReason: scorecard.stopReason,
      implementerBranchesMergedUp: scorecard.implementerBranchesMergedUp,
      totalTurns: scorecard.totalTurns,
      totalWallClockMs: scorecard.totalWallClockMs,
      totalReviewRounds: scorecard.totalReviewRounds,
      totalKickbacks: scorecard.totalKickbacks,
      totalEscalations: scorecard.totalEscalations,
      agentsByRole: scorecard.agentsByRole,
      scores: scorecard.scores,
      merges: scorecard.merges,
      failures: scorecard.failures,
    }),
  );
  return lines.join('\n') + '\n';
}

/** A compact human-legible scorecard for the test/CLI output (the operator reviews this, not a checkbox). */
export function renderScorecard(scorecard: OrchestrationScorecard): string {
  const verdict = scorecard.pass ? 'PASS' : 'FAIL';
  const s = scorecard.scores;
  const lines = [
    `orchestration-benchmark ${scorecard.scenarioId} — ${verdict} (${scorecard.fidelity}, ${scorecard.providerMode})`,
    `  run:        ${scorecard.runId}  stop=${scorecard.stopReason}`,
    `  completed:  ${scorecard.completed}   artifact: ${scorecard.artifact.correct} (${scorecard.artifact.casesPassed}/${scorecard.artifact.casesTotal} cases) — ${scorecard.artifact.detail}`,
    `  merged-up:  ${scorecard.implementerBranchesMergedUp}/${scorecard.requiredImplementerMerges} implementer branches`,
    `  scores:     correctness=${fmtScore(s.correctness)} token-economy=${fmtScore(s.tokenEconomy)} context-efficiency=${fmtScore(s.contextEfficiency)}`,
    `  totals:     turns=${scorecard.totalTurns} wall=${scorecard.totalWallClockMs}ms reviews=${scorecard.totalReviewRounds} kickbacks=${scorecard.totalKickbacks} escalations=${scorecard.totalEscalations}`,
    `  agents:     ${Object.entries(scorecard.agentsByRole)
      .map(([role, n]) => `${role}×${n}`)
      .join(' ')}`,
  ];
  for (const a of scorecard.agents) {
    const te = a.tokenEconomy;
    const ef = a.toolEfficiency;
    lines.push(
      `    - ${a.role} ${a.agentId} [${a.provider}]: turns=${a.turnsUsed} wall=${a.wallClockMs}ms esc=${a.escalations}`,
    );
    lines.push(
      `        tokens=${fmtNum(te.totalTokens)} (in=${fmtNum(te.inputTokens)} out=${fmtNum(te.outputTokens)} cacheR=${fmtNum(te.cacheReadTokens)} cacheC=${fmtNum(te.cacheCreationTokens)}) cost=${fmtUsd(te.costUsd)} econ=${fmtScore(te.tokenEconomy)} cacheEff=${fmtScore(te.cacheEfficiency)}`,
    );
    lines.push(
      `        tools=${fmtNum(ef.toolCalls)} err=${fmtNum(ef.toolErrors)} redundantReads=${fmtNum(ef.redundantReads)} permAsks=${fmtNum(ef.permissionAsks)} ctxEff=${fmtScore(ef.contextEfficiency)} [diag: firstCoCall=${fmtNum(ef.turnsToFirstProductiveCoCall)} tools/task=${fmtNum(ef.toolCallsPerCompletedTask)}]`,
    );
  }
  for (const f of scorecard.failures) lines.push(`  ✗ ${f}`);
  return lines.join('\n') + '\n';
}

// ── Score-fold helpers (pure) ─────────────────────────────────────────────────────────────────────────

/** The mean of the non-null members of `xs`, or `null` when none are non-null (never a misleading 0). */
function agentMean(xs: readonly (number | null)[]): number | null {
  const present = xs.filter((x): x is number => x != null);
  if (present.length === 0) return null;
  return present.reduce((acc, x) => acc + x, 0) / present.length;
}

/** Fold a per-agent score into a per-role aggregate (count of reporters + mean over them). */
function byRole(
  agents: readonly AgentRunMetric[],
  pick: (a: AgentRunMetric) => number | null,
): Readonly<Record<string, RoleScoreAggregate>> {
  const buckets = new Map<string, number[]>();
  for (const a of agents) {
    const v = pick(a);
    if (v == null) continue;
    const bucket = buckets.get(a.role) ?? [];
    bucket.push(v);
    buckets.set(a.role, bucket);
  }
  const out: Record<string, RoleScoreAggregate> = {};
  for (const a of agents) {
    if (out[a.role] != null) continue;
    const bucket = buckets.get(a.role);
    out[a.role] =
      bucket == null || bucket.length === 0
        ? { count: 0, mean: null }
        : { count: bucket.length, mean: bucket.reduce((acc, x) => acc + x, 0) / bucket.length };
  }
  return out;
}

/** Render a score as a 2-dp number or `N/A` (a null score is a deliberate N/A, never shown as 0). */
function fmtScore(x: number | null): string {
  return x == null ? 'N/A' : x.toFixed(2);
}

/** Render a raw count as itself or `N/A` (a null is a missing observation, never shown as 0). */
function fmtNum(x: number | null): string {
  return x == null ? 'N/A' : String(x);
}

/** Render a dollar cost as `$x.xxxx` or `N/A`. */
function fmtUsd(x: number | null): string {
  return x == null ? 'N/A' : `$${x.toFixed(4)}`;
}

function sum(xs: readonly number[]): number {
  return xs.reduce((acc, x) => acc + x, 0);
}
