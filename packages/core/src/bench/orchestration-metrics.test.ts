import { describe, it, expect } from 'vitest';
import {
  summarizeRun,
  toJsonl,
  renderScorecard,
  correctnessScore,
  tokenEconomyScore,
  cacheEfficiency,
  contextEfficiencyScore,
  buildTokenEconomy,
  buildToolEfficiency,
  budgetTokensForScenario,
  clamp01,
  CONTEXT_EFFICIENCY_WEIGHTS,
  type OrchestrationRunInput,
  type AgentRunMetric,
  type MergeOutcome,
} from './orchestration-metrics.js';
// Import from the declaring module here; the public barrel export is covered by packages/mcp's guard.
import type { AgentCostRollup, AgentToolUsage } from './bench-econ-types.js';
import type { ArtifactCheck } from './orchestration-scenarios.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────────────────

/** A SANDBOX agent: no cost rollup (live-only) → null token economy; a tool rollup → real context score. */
function sandboxAgent(over: Partial<AgentRunMetric> = {}): AgentRunMetric {
  return {
    agentId: 'a',
    role: 'implementer',
    provider: 'claude',
    turnsUsed: 2,
    wallClockMs: 4000,
    escalations: 0,
    tokenEconomy: buildTokenEconomy(null, budgetTokensForScenario('calc-lib')),
    toolEfficiency: buildToolEfficiency(null),
    ...over,
  };
}

/** A LIVE agent built from injected fake cost + tool rollups (the per-provider corpus signal). */
function liveAgent(
  cost: AgentCostRollup | null,
  tool: AgentToolUsage | null,
  over: Partial<AgentRunMetric> = {},
): AgentRunMetric {
  return {
    agentId: 'a',
    role: 'implementer',
    provider: 'claude',
    turnsUsed: 2,
    wallClockMs: 4000,
    escalations: 0,
    tokenEconomy: buildTokenEconomy(cost, budgetTokensForScenario('calc-lib')),
    toolEfficiency: buildToolEfficiency(tool),
    ...over,
  };
}

const PASS_ARTIFACT: ArtifactCheck = {
  correct: true,
  detail: 'calc.mjs correct',
  casesPassed: 13,
  casesTotal: 13,
};

const agents: AgentRunMetric[] = [
  liveAgent(
    {
      agentId: 'coord-1',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 150,
      costUsd: 0.1,
    },
    {
      agentId: 'coord-1',
      toolCalls: 10,
      toolErrors: 0,
      redundantReads: 0,
      permissionAsks: 0,
      turnsToFirstProductiveCoCall: 1,
    },
    { agentId: 'coord-1', role: 'coordinator', turnsUsed: 4, wallClockMs: 8000, escalations: 0 },
  ),
  liveAgent(
    {
      agentId: 'lead-1',
      inputTokens: 80,
      outputTokens: 40,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 120,
      costUsd: 0.08,
    },
    {
      agentId: 'lead-1',
      toolCalls: 10,
      toolErrors: 1,
      redundantReads: 0,
      permissionAsks: 0,
      turnsToFirstProductiveCoCall: 1,
    },
    { agentId: 'lead-1', role: 'lead', turnsUsed: 3, wallClockMs: 6000, escalations: 1 },
  ),
  liveAgent(
    {
      agentId: 'impl-ops',
      inputTokens: 60,
      outputTokens: 30,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 90,
      costUsd: 0.06,
    },
    {
      agentId: 'impl-ops',
      toolCalls: 10,
      toolErrors: 0,
      redundantReads: 0,
      permissionAsks: 0,
      turnsToFirstProductiveCoCall: 1,
    },
    { agentId: 'impl-ops', role: 'implementer', turnsUsed: 2, wallClockMs: 4000, escalations: 0 },
  ),
  liveAgent(
    {
      agentId: 'impl-tok',
      inputTokens: 65,
      outputTokens: 35,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 100,
      costUsd: 0.07,
    },
    {
      agentId: 'impl-tok',
      toolCalls: 10,
      toolErrors: 0,
      redundantReads: 0,
      permissionAsks: 0,
      turnsToFirstProductiveCoCall: 1,
    },
    { agentId: 'impl-tok', role: 'implementer', turnsUsed: 2, wallClockMs: 4500, escalations: 0 },
  ),
];

const merges: MergeOutcome[] = [
  {
    branch: 'impl-ops',
    target: 'lead-1',
    reviewRounds: 1,
    kickbacks: 0,
    firstTryPass: true,
    mergeCommitSha: 'a1',
  },
  {
    branch: 'impl-tok',
    target: 'lead-1',
    reviewRounds: 2,
    kickbacks: 1,
    firstTryPass: false,
    mergeCommitSha: 'b2',
  },
  {
    branch: 'lead-1',
    target: 'integration',
    reviewRounds: 1,
    kickbacks: 0,
    firstTryPass: true,
    mergeCommitSha: 'c3',
  },
];

function baseInput(overrides: Partial<OrchestrationRunInput> = {}): OrchestrationRunInput {
  return {
    runId: 'run-1',
    scenarioId: 'calc-lib',
    nonce: 'n1',
    providerMode: 'claude-only',
    fidelity: 'host-live',
    completed: true,
    artifact: PASS_ARTIFACT,
    agents,
    merges,
    stopReason: 'task-complete',
    implementerBranchesMergedUp: 2,
    requiredImplementerMerges: 2,
    ...overrides,
  };
}

describe('summarizeRun — the hard structural PASS verdict + totals', () => {
  it('passes a complete, correct, fully-merged, fully-reviewed run and rolls up the totals', () => {
    const s = summarizeRun(baseInput());
    expect(s.pass).toBe(true);
    expect(s.failures).toEqual([]);
    expect(s.totalTurns).toBe(11);
    expect(s.totalWallClockMs).toBe(22500);
    expect(s.totalReviewRounds).toBe(4);
    expect(s.totalKickbacks).toBe(1);
    expect(s.totalEscalations).toBe(1);
    expect(s.agentsByRole).toEqual({ coordinator: 1, lead: 1, implementer: 2 });
  });

  it('normalizes legacy public inputs that predate case counts and score blocks', () => {
    const legacyAgent = {
      agentId: 'legacy-a',
      role: 'implementer',
      provider: 'claude',
      turnsUsed: 1,
      wallClockMs: 10,
      escalations: 0,
    } satisfies AgentRunMetric;

    const s = summarizeRun(
      baseInput({
        artifact: { correct: true, detail: 'legacy binary pass' },
        agents: [legacyAgent],
      }),
    );

    expect(s.pass).toBe(true);
    expect(s.artifact.casesPassed).toBe(1);
    expect(s.artifact.casesTotal).toBe(1);
    expect(s.scores.correctness).toBe(1);
    expect(s.agents[0]!.tokenEconomy.tokenEconomy).toBeNull();
    expect(s.agents[0]!.toolEfficiency.contextEfficiency).toBeNull();
    expect(toJsonl(s)).toContain('"artifactCasesPassed":1');
  });

  it('fails when the chain did not complete', () => {
    const s = summarizeRun(baseInput({ completed: false }));
    expect(s.pass).toBe(false);
    expect(s.failures.join(' ')).toMatch(/did not complete/);
  });

  it('fails when the executed oracle was incorrect (surfacing the concrete reason)', () => {
    const s = summarizeRun(
      baseInput({
        artifact: {
          correct: false,
          detail: 'add(2, 3) = -1, want 5',
          casesPassed: 0,
          casesTotal: 13,
        },
      }),
    );
    expect(s.pass).toBe(false);
    expect(s.failures.join(' ')).toMatch(/add\(2, 3\) = -1/);
  });

  it('fails when fewer implementer branches merged up than the decomposition requires', () => {
    const s = summarizeRun(baseInput({ implementerBranchesMergedUp: 1 }));
    expect(s.pass).toBe(false);
    expect(s.failures.join(' ')).toMatch(/only 1 of 2 implementer/);
  });

  it('fails when a merge landed without a review round (the gate was skipped)', () => {
    const ungated: MergeOutcome[] = [
      {
        branch: 'impl-ops',
        target: 'lead-1',
        reviewRounds: 0,
        kickbacks: 0,
        firstTryPass: true,
        mergeCommitSha: 'x',
      },
      ...merges.slice(1),
    ];
    const s = summarizeRun(baseInput({ merges: ungated }));
    expect(s.pass).toBe(false);
    expect(s.failures.join(' ')).toMatch(/without a review round/);
  });

  it('fails when no merges were recorded at all', () => {
    const s = summarizeRun(baseInput({ merges: [] }));
    expect(s.pass).toBe(false);
    expect(s.failures.join(' ')).toMatch(/review gate never ran/);
  });

  it.each(['wedged', 'error'] as const)(
    'fails closed when stopReason is %s even if durable stores otherwise look successful',
    (stopReason) => {
      const s = summarizeRun(baseInput({ stopReason }));
      expect(s.pass).toBe(false);
      expect(s.failures.join(' ')).toMatch(new RegExp(stopReason));
    },
  );
});

describe('the three scores — correctness math (objective; both arms)', () => {
  it('a clean pass scores correctness = 1', () => {
    const s = summarizeRun(baseInput());
    expect(s.scores.correctness).toBe(1);
  });

  it('refines a partial oracle pass into a fraction of cases (7/13), gated by completion + merge + review', () => {
    const s = summarizeRun(
      baseInput({
        artifact: { correct: false, detail: 'mul wrong', casesPassed: 7, casesTotal: 13 },
      }),
    );
    expect(s.scores.correctness).toBeCloseTo(7 / 13, 10);
  });

  it('an incomplete chain zeroes correctness even with a perfect oracle tally', () => {
    const s = summarizeRun(baseInput({ completed: false }));
    expect(s.scores.correctness).toBe(0);
  });

  it('a half-merged-up chain halves correctness (the merge-up factor)', () => {
    const s = summarizeRun(
      baseInput({ implementerBranchesMergedUp: 1, requiredImplementerMerges: 2 }),
    );
    expect(s.scores.correctness).toBeCloseTo(0.5, 10);
  });

  it('an ungated merge (a skipped review) zeroes correctness (the gate factor)', () => {
    const ungated: MergeOutcome[] = [
      {
        branch: 'impl-ops',
        target: 'lead-1',
        reviewRounds: 0,
        kickbacks: 0,
        firstTryPass: true,
        mergeCommitSha: 'x',
      },
      ...merges.slice(1),
    ];
    const s = summarizeRun(baseInput({ merges: ungated }));
    expect(s.scores.correctness).toBe(0);
  });

  it('correctnessScore is fail-closed on a zero-case oracle (no evidence ⇒ 0, never 1)', () => {
    expect(
      correctnessScore({
        artifact: { correct: true, detail: 'no cases', casesPassed: 0, casesTotal: 0 },
        completed: true,
        implementerBranchesMergedUp: 2,
        requiredImplementerMerges: 2,
        everyMergeHadReview: true,
      }),
    ).toBe(0);
  });
});

describe('the three scores — LAZY-AGENT: economy cannot mask a correctness miss', () => {
  // A lazy agent spends almost NO tokens (so token-economy is sky-high → 1) but produces a WRONG artifact
  // (correctness ≈ 0). The two scores are independent: a high economy must NEVER paper over a correctness
  // miss — that is the whole point of three separate scores (this fails if correctness folded economy in).
  it('high token-economy + a wrong artifact ⇒ correctness ≈ 0 while token-economy = 1', () => {
    const lazyCost: AgentCostRollup = {
      agentId: 'lazy-1',
      inputTokens: 5,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 6, // far under the 2,000,000 calc-lib budget ⇒ economy clamps to 1
      costUsd: 0.0001,
    };
    const lazyTool: AgentToolUsage = {
      agentId: 'lazy-1',
      toolCalls: 1,
      toolErrors: 0,
      redundantReads: 0,
      permissionAsks: 0,
      turnsToFirstProductiveCoCall: 0,
    };
    const s = summarizeRun(
      baseInput({
        completed: false, // the lazy agent never finished the chain
        artifact: {
          correct: false,
          detail: 'add(2,3) = -1, want 5',
          casesPassed: 0,
          casesTotal: 13,
        },
        agents: [liveAgent(lazyCost, lazyTool, { agentId: 'lazy-1', role: 'implementer' })],
      }),
    );
    // Economy is maxed out (the agent was cheap) …
    expect(s.scores.tokenEconomy).toBe(1);
    // … but correctness is 0 (wrong artifact + incomplete chain). Economy did NOT mask the miss.
    expect(s.scores.correctness).toBe(0);
    expect(s.pass).toBe(false);
  });
});

describe('the three scores — TOKEN-ECONOMY (live-only; N/A in the sandbox arm)', () => {
  it('SANDBOX arm: tokenEconomy is null (N/A), NOT a silent zero', () => {
    const s = summarizeRun(baseInput({ fidelity: 'sandbox-fake', agents: [sandboxAgent()] }));
    // The run-level and per-agent token economy are both null in the sandbox arm — never 0.
    expect(s.scores.tokenEconomy).toBeNull();
    expect(s.agents[0]!.tokenEconomy.tokenEconomy).toBeNull();
    expect(s.agents[0]!.tokenEconomy.totalTokens).toBeNull();
    expect(s.agents[0]!.tokenEconomy.cacheEfficiency).toBeNull();
  });

  it('tokenEconomyScore: at-or-under budget ⇒ 1; over budget ⇒ degrades below 1; null cost ⇒ null', () => {
    const under: AgentCostRollup = {
      agentId: 'a',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 1000,
      costUsd: 0,
    };
    const over: AgentCostRollup = {
      agentId: 'a',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 4000,
      costUsd: 0,
    };
    expect(tokenEconomyScore(under, 2000)).toBe(1); // 2000/1000 clamps to 1
    expect(tokenEconomyScore(over, 2000)).toBeCloseTo(0.5, 10); // 2000/4000
    expect(tokenEconomyScore(null, 2000)).toBeNull();
  });

  it('cacheEfficiency: read share of cacheable tokens; null cost ⇒ null', () => {
    const cached: AgentCostRollup = {
      agentId: 'a',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 80,
      cacheCreationTokens: 20,
      totalTokens: 100,
      costUsd: 0,
    };
    expect(cacheEfficiency(cached)).toBeCloseTo(0.8, 10);
    expect(cacheEfficiency(null)).toBeNull();
  });

  it('budgetTokensForScenario: known scenario uses its budget; unknown falls back to the default', () => {
    expect(budgetTokensForScenario('calc-lib')).toBe(2_000_000);
    expect(budgetTokensForScenario('does-not-exist')).toBe(1_000_000);
  });
});

describe('the three scores — CONTEXT/TOOL-EFFICIENCY (both arms; weighted blend)', () => {
  it('a clean run (no errors/redundant-reads/permission-asks) scores 1', () => {
    const clean: AgentToolUsage = {
      agentId: 'a',
      toolCalls: 10,
      toolErrors: 0,
      redundantReads: 0,
      permissionAsks: 0,
      turnsToFirstProductiveCoCall: 1,
    };
    expect(contextEfficiencyScore(clean)).toBe(1);
  });

  it('matches the documented weighted formula 0.4·(1−fail)+0.4·(1−redundant)+0.2·(1−perm)', () => {
    const tool: AgentToolUsage = {
      agentId: 'a',
      toolCalls: 10,
      toolErrors: 2, // failRate 0.2
      redundantReads: 1, // redundantReadRate 0.1
      permissionAsks: 5, // permissionAskRate 0.5
      turnsToFirstProductiveCoCall: 1,
    };
    const w = CONTEXT_EFFICIENCY_WEIGHTS;
    const expected =
      w.toolFail * (1 - 0.2) + w.redundantRead * (1 - 0.1) + w.permissionAsk * (1 - 0.5);
    expect(contextEfficiencyScore(tool)).toBeCloseTo(expected, 10);
  });

  it('null tool rollup ⇒ null (N/A), never a silent zero', () => {
    expect(contextEfficiencyScore(null)).toBeNull();
  });

  it('a tool rollup with ZERO calls still scores (max(toolCalls,1) guard) — a real "no friction" observation', () => {
    const idle: AgentToolUsage = {
      agentId: 'a',
      toolCalls: 0,
      toolErrors: 0,
      redundantReads: 0,
      permissionAsks: 0,
      turnsToFirstProductiveCoCall: 0,
    };
    expect(contextEfficiencyScore(idle)).toBe(1);
  });

  it('reports the un-scored diagnostics raw on the metric (turnsToFirstProductiveCoCall from the rollup, toolCallsPerCompletedTask DERIVED by the driver)', () => {
    const tool: AgentToolUsage = {
      agentId: 'a',
      toolCalls: 8,
      toolErrors: 0,
      redundantReads: 0,
      permissionAsks: 0,
      turnsToFirstProductiveCoCall: 3,
    };
    // toolCallsPerCompletedTask is NOT a store field — the driver derives it and passes it as the 2nd arg.
    const ef = buildToolEfficiency(tool, 8);
    expect(ef.turnsToFirstProductiveCoCall).toBe(3);
    expect(ef.toolCallsPerCompletedTask).toBe(8);
  });

  it('a null tool rollup forces toolCallsPerCompletedTask to null even if a derived value is offered (no rollup ⇒ no diagnostic)', () => {
    const ef = buildToolEfficiency(null, 8);
    expect(ef.toolCallsPerCompletedTask).toBeNull();
  });
});

describe('per-role score aggregates (the fine-tuning corpus fold)', () => {
  it('folds per-role agent-means; a role with no non-null reporters has mean=null (never 0)', () => {
    const s = summarizeRun(baseInput());
    // Live arm: every role reports a context-efficiency mean (a real number).
    expect(s.scores.contextEfficiencyByRole['implementer']?.count).toBe(2);
    expect(s.scores.contextEfficiencyByRole['implementer']?.mean).toBeGreaterThan(0);
    // Sandbox arm: token economy is null for every agent ⇒ each role aggregate is { count: 0, mean: null }.
    const sandbox = summarizeRun(
      baseInput({ fidelity: 'sandbox-fake', agents: [sandboxAgent({ role: 'coordinator' })] }),
    );
    expect(sandbox.scores.tokenEconomyByRole['coordinator']).toEqual({ count: 0, mean: null });
  });
});

describe('clamp01', () => {
  it('clamps into [0,1] and collapses non-finite (NaN, ±Infinity) to 0 (fail-closed, never NaN in the corpus)', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(Number.NaN)).toBe(0);
    // Non-finite is fail-closed to 0 (a corrupt/missing measurement must never read as a perfect 1).
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('toJsonl + renderScorecard', () => {
  it('emits one JSON record per agent (with all three per-agent score blocks) plus a run-summary record', () => {
    const scorecard = summarizeRun(baseInput());
    const jsonl = toJsonl(scorecard);
    const records = jsonl
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const agentRecords = records.filter((r) => r['type'] === 'agent');
    expect(agentRecords).toHaveLength(agents.length);
    // Each agent record carries the token-economy + tool-efficiency blocks (the per-provider corpus).
    expect(agentRecords[0]!['tokenEconomy']).toEqual(scorecard.agents[0]!.tokenEconomy);
    expect(agentRecords[0]!['toolEfficiency']).toEqual(scorecard.agents[0]!.toolEfficiency);
    const run = records.find((r) => r['type'] === 'run') as Record<string, unknown> | undefined;
    expect(run).toBeDefined();
    expect(run!['pass']).toBe(true);
    expect(run!['totalTurns']).toBe(11);
    // The run record carries the three run-level scores + the per-role folds + the artifact case tally.
    expect(run!['scores']).toEqual(scorecard.scores);
    expect(run!['artifactCasesPassed']).toBe(13);
    expect(run!['artifactCasesTotal']).toBe(13);
  });

  it('SANDBOX run JSONL: per-agent tokenEconomy.tokenEconomy is null (N/A), never 0', () => {
    const jsonl = toJsonl(
      summarizeRun(baseInput({ fidelity: 'sandbox-fake', agents: [sandboxAgent()] })),
    );
    const agentRecord = jsonl
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((r) => r['type'] === 'agent') as Record<string, unknown>;
    const te = agentRecord['tokenEconomy'] as Record<string, unknown>;
    expect(te['tokenEconomy']).toBeNull();
  });

  it('renders a human scorecard with the verdict, totals, and the three scores', () => {
    const text = renderScorecard(summarizeRun(baseInput()));
    expect(text).toMatch(/orchestration-benchmark calc-lib — PASS/);
    expect(text).toMatch(/turns=11/);
    expect(text).toMatch(/implementer×2/);
    expect(text).toMatch(/correctness=1\.00/);
    expect(text).toMatch(/token-economy=/);
    expect(text).toMatch(/context-efficiency=/);
  });

  it('renders N/A (not 0) for a null score in the sandbox arm', () => {
    const text = renderScorecard(
      summarizeRun(baseInput({ fidelity: 'sandbox-fake', agents: [sandboxAgent()] })),
    );
    expect(text).toMatch(/token-economy=N\/A/);
  });
});
