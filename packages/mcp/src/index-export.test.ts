import { describe, expect, it } from 'vitest';
import type { AgentTokenEconomy, AgentToolEfficiency } from '@co/core';
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

    expect(stopOptions.waitForInFlight).toBe(false);
    expect(scores.correctness).toBe(0);
  });
});
