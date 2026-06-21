import { describe, expect, it } from 'vitest';
import type { DeliveredMail, StartSessionParams, StartSessionResult } from '@co/core';
import {
  deleteAgentAndRefresh,
  rewakeAgentAndRefresh,
  startSessionAndRefresh,
  stopAgentAndRefresh,
  type LifecycleActionShell,
} from './lifecycle-actions.js';

const MAIL: DeliveredMail = {
  seq: 1,
  recipient: 'coord-1',
  sender: '@operator',
  type: 'clarify_request',
  subject: 'Re-wake',
  body: 'continue',
  ts: 10,
  kind: 'actionable',
} as DeliveredMail;

const START_RESULT: StartSessionResult = {
  coordinator: 'coord-1',
  worktreePath: '/tmp/co/coord-1',
  branch: 'co/coord-1',
  baseRef: 'main',
  baseSha: 'abc123',
};

function makeShell(log: string[] = []): LifecycleActionShell {
  return {
    client: {
      async stop(agentId: string): Promise<void> {
        log.push(`stop:${agentId}`);
      },
      async deleteAgent(agentId: string): Promise<void> {
        log.push(`delete:${agentId}`);
      },
      async rewake(agentId: string, message: string): Promise<DeliveredMail> {
        log.push(`rewake:${agentId}:${message}`);
        return MAIL;
      },
      async startSession(params: StartSessionParams): Promise<StartSessionResult> {
        log.push(`start:${params.name}`);
        return START_RESULT;
      },
    },
    connection: {
      async refresh(): Promise<void> {
        log.push('refresh');
      },
    },
  };
}

describe('desktop lifecycle actions', () => {
  it('refreshes immediately after a successful stop', async () => {
    const log: string[] = [];
    await stopAgentAndRefresh(makeShell(log), 'coord-1');
    expect(log).toEqual(['stop:coord-1', 'refresh']);
  });

  it('refreshes immediately after a successful delete', async () => {
    const log: string[] = [];
    await deleteAgentAndRefresh(makeShell(log), 'coord-1');
    expect(log).toEqual(['delete:coord-1', 'refresh']);
  });

  it('refreshes immediately after re-wake and returns the delivered mail', async () => {
    const log: string[] = [];
    const delivered = await rewakeAgentAndRefresh(makeShell(log), 'coord-1', 'continue');
    expect(delivered).toBe(MAIL);
    expect(log).toEqual(['rewake:coord-1:continue', 'refresh']);
  });

  it('refreshes immediately after starting a coordinator session', async () => {
    const log: string[] = [];
    const result = await startSessionAndRefresh(makeShell(log), {
      name: 'Docs',
      prompt: 'write docs',
    });
    expect(result).toBe(START_RESULT);
    expect(log).toEqual(['start:Docs', 'refresh']);
  });

  it('does not refresh when the lifecycle mutation fails', async () => {
    const log: string[] = [];
    const shell: LifecycleActionShell = {
      ...makeShell(log),
      client: {
        ...makeShell(log).client,
        async stop(): Promise<void> {
          log.push('stop');
          throw new Error('stop failed');
        },
      },
    };
    await expect(stopAgentAndRefresh(shell, 'coord-1')).rejects.toThrow('stop failed');
    expect(log).toEqual(['stop']);
  });
});
