import { describe, it, expect, vi } from 'vitest';
import { createAppShell, defaultOperatorSocketPath } from './app-shell.js';
import type { OperatorObservation } from '@co/core';
import type { ProjectId } from '@co/core';
import { projectDataDir } from '@co/core';
import { operatorIpcSocketPath } from '@co/mcp';
import type { OperatorIpcClient } from '@co/mcp';

const FAKE_PROJECT_ID = 'test-project' as ProjectId;
const FAKE_SOCKET = '/tmp/co-test.sock';

import type { ObservabilitySnapshot } from '@co/core';

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

function makeClient(obs: OperatorObservation = staticObs): OperatorIpcClient {
  return {
    connected: obs.kind === 'live',
    connect: vi.fn().mockResolvedValue(obs.kind === 'live'),
    observe: vi.fn().mockResolvedValue(obs),
    onTick: vi.fn().mockReturnValue(() => {}),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as OperatorIpcClient;
}

describe('defaultOperatorSocketPath — client↔server path agreement', () => {
  it('equals operatorIpcSocketPath(projectDataDir(projectId)) — the server formula', () => {
    const projectId = 'a1b2c3d4-0000-0000-0000-000000000000' as ProjectId;
    // The server calls operatorIpcSocketPath(registry.dataDirFor(projectId)),
    // and dataDirFor returns projectDataDir(projectId). Assert the client uses
    // the same formula so a mismatch breaks loudly rather than silently degrading.
    expect(defaultOperatorSocketPath(projectId)).toBe(
      operatorIpcSocketPath(projectDataDir(projectId)),
    );
  });
});

describe('createAppShell — view-model bridge wiring', () => {
  it('creates a NavVM starting on dashboard', () => {
    const shell = createAppShell({
      projectId: FAKE_PROJECT_ID,
      socketPath: FAKE_SOCKET,
      client: makeClient(),
    });
    expect(shell.nav.state.activeView).toBe('dashboard');
  });

  it('creates a ConnectionVM in connecting state', () => {
    const shell = createAppShell({
      projectId: FAKE_PROJECT_ID,
      socketPath: FAKE_SOCKET,
      client: makeClient(),
    });
    expect(shell.connection.state.status).toBe('connecting');
  });

  it('start() calls client.observe() via connection.start()', async () => {
    const client = makeClient();
    const shell = createAppShell({ projectId: FAKE_PROJECT_ID, socketPath: FAKE_SOCKET, client });
    await shell.start();
    expect(client.observe).toHaveBeenCalledOnce();
  });

  it('notifies onNavState when nav.navigate() is called', () => {
    const onNavState = vi.fn();
    const shell = createAppShell({
      projectId: FAKE_PROJECT_ID,
      socketPath: FAKE_SOCKET,
      client: makeClient(),
      onNavState,
    });
    shell.nav.navigate('mail');
    expect(onNavState).toHaveBeenCalledWith({ activeView: 'mail' });
  });

  it('notifies onConnectionState after start()', async () => {
    const onConnectionState = vi.fn();
    const shell = createAppShell({
      projectId: FAKE_PROJECT_ID,
      socketPath: FAKE_SOCKET,
      client: makeClient(),
      onConnectionState,
    });
    await shell.start();
    expect(onConnectionState).toHaveBeenCalledOnce();
    expect(onConnectionState).toHaveBeenCalledWith(expect.objectContaining({ status: 'degraded' }));
  });

  it('close() closes the client', async () => {
    const client = makeClient();
    const shell = createAppShell({ projectId: FAKE_PROJECT_ID, socketPath: FAKE_SOCKET, client });
    await shell.close();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('transitions to live when conductor is up', async () => {
    const client = makeClient(liveObs);
    const shell = createAppShell({ projectId: FAKE_PROJECT_ID, socketPath: FAKE_SOCKET, client });
    await shell.start();
    expect(shell.connection.state.status).toBe('live');
  });

  it('all 6 nav views are reachable', () => {
    const shell = createAppShell({
      projectId: FAKE_PROJECT_ID,
      socketPath: FAKE_SOCKET,
      client: makeClient(),
    });
    const views = ['dashboard', 'agents', 'mail', 'review', 'source', 'cost'] as const;
    for (const view of views) {
      shell.nav.navigate(view);
      expect(shell.nav.state.activeView).toBe(view);
    }
  });
});
