import { describe, it, expect, vi } from 'vitest';
import { ConnectionVM } from './connection-vm.js';
import type { OperatorObservation, ObservabilitySnapshot, OperatorIpcTick } from '@co/core';
import type { OperatorIpcClient } from '@co/mcp';

const emptyStatic: ObservabilitySnapshot = {
  agents: [],
  plans: [],
  reviews: [],
  costRollups: [],
};

const staticObs: OperatorObservation = {
  kind: 'static',
  snapshot: emptyStatic,
  reason: 'conductor-not-running',
};

const liveObs: OperatorObservation = {
  kind: 'live',
  snapshot: { snapshot: emptyStatic, agents: [] },
};

function makeClient(overrides: Partial<OperatorIpcClient> = {}): OperatorIpcClient {
  return {
    connected: false,
    connect: vi.fn().mockResolvedValue(true),
    observe: vi.fn().mockResolvedValue(staticObs),
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    unstick: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue({} as never),
    approve: vi.fn().mockResolvedValue({} as never),
    onTick: vi.fn().mockReturnValue(() => {}),
    close: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as OperatorIpcClient;
}

describe('ConnectionVM', () => {
  it('starts in connecting state', () => {
    const vm = new ConnectionVM({ client: makeClient() });
    expect(vm.state.status).toBe('connecting');
    expect(vm.state.observation).toBeNull();
  });

  it('transitions to degraded when conductor is not running', async () => {
    const vm = new ConnectionVM({ client: makeClient() });
    await vm.start();
    expect(vm.state.status).toBe('degraded');
  });

  it('transitions to live when conductor responds', async () => {
    const client = makeClient({ observe: vi.fn().mockResolvedValue(liveObs) });
    const vm = new ConnectionVM({ client });
    await vm.start();
    expect(vm.state.status).toBe('live');
    expect(vm.state.observation).toEqual(liveObs);
  });

  it('calls onState with updated state', async () => {
    const onState = vi.fn();
    const vm = new ConnectionVM({ client: makeClient(), onState });
    await vm.start();
    expect(onState).toHaveBeenCalledOnce();
    expect(onState).toHaveBeenCalledWith(expect.objectContaining({ status: 'degraded' }));
  });

  it('registers a tick listener on start', async () => {
    const client = makeClient();
    const vm = new ConnectionVM({ client });
    await vm.start();
    expect(client.onTick).toHaveBeenCalledOnce();
  });

  it('forwards ticks to onTick callback', async () => {
    const onTick = vi.fn();
    const listeners: Array<(tick: OperatorIpcTick) => void> = [];
    const client = makeClient({
      onTick: vi.fn().mockImplementation((cb: (tick: OperatorIpcTick) => void) => {
        listeners.push(cb);
        return () => {};
      }),
    });
    const vm = new ConnectionVM({ client, onTick });
    await vm.start();
    const tick = { snapshot: liveObs } as unknown as OperatorIpcTick;
    listeners[0]?.(tick);
    expect(onTick).toHaveBeenCalledWith(tick);
    vm.close();
  });

  it('close unregisters the tick listener', async () => {
    const unsub = vi.fn();
    const client = makeClient({ onTick: vi.fn().mockReturnValue(unsub) });
    const vm = new ConnectionVM({ client });
    await vm.start();
    vm.close();
    expect(unsub).toHaveBeenCalledOnce();
  });

  it('refresh updates the observation', async () => {
    const vm = new ConnectionVM({ client: makeClient() });
    await vm.start();
    const firstObs = vm.state.observation;
    await vm.refresh();
    expect(vm.state.observation).toEqual(firstObs);
  });
});
