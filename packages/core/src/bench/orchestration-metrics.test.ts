import { describe, it, expect } from 'vitest';
import {
  summarizeRun,
  toJsonl,
  renderScorecard,
  type OrchestrationRunInput,
  type AgentRunMetric,
  type MergeOutcome,
} from './orchestration-metrics.js';

const agents: AgentRunMetric[] = [
  {
    agentId: 'coord-1',
    role: 'coordinator',
    provider: 'claude',
    turnsUsed: 4,
    wallClockMs: 8000,
    escalations: 0,
  },
  {
    agentId: 'lead-1',
    role: 'lead',
    provider: 'claude',
    turnsUsed: 3,
    wallClockMs: 6000,
    escalations: 1,
  },
  {
    agentId: 'impl-ops',
    role: 'implementer',
    provider: 'claude',
    turnsUsed: 2,
    wallClockMs: 4000,
    escalations: 0,
  },
  {
    agentId: 'impl-tok',
    role: 'implementer',
    provider: 'claude',
    turnsUsed: 2,
    wallClockMs: 4500,
    escalations: 0,
  },
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
    fidelity: 'sandbox-fake',
    completed: true,
    artifact: { correct: true, detail: 'calc.mjs correct' },
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

  it('fails when the chain did not complete', () => {
    const s = summarizeRun(baseInput({ completed: false }));
    expect(s.pass).toBe(false);
    expect(s.failures.join(' ')).toMatch(/did not complete/);
  });

  it('fails when the executed oracle was incorrect (surfacing the concrete reason)', () => {
    const s = summarizeRun(
      baseInput({ artifact: { correct: false, detail: 'add(2, 3) = -1, want 5' } }),
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
});

describe('toJsonl + renderScorecard', () => {
  it('emits one JSON record per agent plus a run-summary record', () => {
    const jsonl = toJsonl(summarizeRun(baseInput()));
    const records = jsonl
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string });
    expect(records.filter((r) => r.type === 'agent')).toHaveLength(agents.length);
    const run = records.find((r) => r.type === 'run') as Record<string, unknown> | undefined;
    expect(run).toBeDefined();
    expect(run!['pass']).toBe(true);
    expect(run!['totalTurns']).toBe(11);
  });

  it('renders a human scorecard with the verdict and totals', () => {
    const text = renderScorecard(summarizeRun(baseInput()));
    expect(text).toMatch(/orchestration-benchmark calc-lib — PASS/);
    expect(text).toMatch(/turns=11/);
    expect(text).toMatch(/implementer×2/);
  });
});
