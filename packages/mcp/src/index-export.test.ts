import { describe, expect, it } from 'vitest';
import type {
  AgentCostRollup,
  AgentTokenEconomy,
  AgentToolEfficiency,
  AgentToolUsage,
} from '@co/core';
import type { ConductorHostRunnerStopOptions, WorkerScores } from './index.js';

describe('@co/mcp public barrel type exports', () => {
  it('exports public option/result helper types needed to name returned shapes', () => {
    const stopOptions = { waitForInFlight: false } satisfies ConductorHostRunnerStopOptions;
    const tokenEconomy: AgentTokenEconomy = {
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheCreationTokens: null,
      totalTokens: null,
      costUsd: null,
      tokenEconomy: null,
      cacheEfficiency: null,
    };
    const toolEfficiency: AgentToolEfficiency = {
      toolCalls: null,
      toolErrors: null,
      redundantReads: null,
      permissionAsks: null,
      contextEfficiency: null,
      turnsToFirstProductiveCoCall: null,
      toolCallsPerCompletedTask: null,
    };
    const scores = {
      correctness: 0,
      tokenEconomy,
      toolEfficiency,
    } satisfies WorkerScores;
    const cost = {
      agentId: 'a',
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheCreationTokens: 4,
      totalTokens: 10,
      costUsd: null,
    } satisfies AgentCostRollup;
    const tool = {
      agentId: 'a',
      toolCalls: 1,
      toolErrors: 0,
      redundantReads: 0,
      permissionAsks: 0,
      turnsToFirstProductiveCoCall: null,
    } satisfies AgentToolUsage;

    expect(stopOptions.waitForInFlight).toBe(false);
    expect(scores.correctness).toBe(0);
    expect(cost.totalTokens).toBe(10);
    expect(tool.toolCalls).toBe(1);
  });
});
