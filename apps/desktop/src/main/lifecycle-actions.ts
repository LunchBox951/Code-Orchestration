import type { DeliveredMail, StartSessionParams, StartSessionResult } from '@co/core';

export interface LifecycleActionShell {
  readonly client: {
    stop(agentId: string): Promise<void>;
    deleteAgent(agentId: string): Promise<void>;
    rewake(agentId: string, message: string): Promise<DeliveredMail>;
    startSession(params: StartSessionParams): Promise<StartSessionResult>;
  };
  readonly connection: {
    refresh(): Promise<void>;
  };
}

async function refreshAfter<T>(shell: LifecycleActionShell, action: () => Promise<T>): Promise<T> {
  const result = await action();
  await shell.connection.refresh();
  return result;
}

export function stopAgentAndRefresh(shell: LifecycleActionShell, agentId: string): Promise<void> {
  return refreshAfter(shell, () => shell.client.stop(agentId));
}

export function deleteAgentAndRefresh(shell: LifecycleActionShell, agentId: string): Promise<void> {
  return refreshAfter(shell, () => shell.client.deleteAgent(agentId));
}

export function rewakeAgentAndRefresh(
  shell: LifecycleActionShell,
  agentId: string,
  message: string,
): Promise<DeliveredMail> {
  return refreshAfter(shell, () => shell.client.rewake(agentId, message));
}

export function startSessionAndRefresh(
  shell: LifecycleActionShell,
  params: StartSessionParams,
): Promise<StartSessionResult> {
  return refreshAfter(shell, () => shell.client.startSession(params));
}
