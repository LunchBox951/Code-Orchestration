import { describe, it, expect, vi } from 'vitest';
import { createAppShell, defaultOperatorSocketPath } from './app-shell.js';
import type { OperatorObservation, DeliveredMail, OperatorIpcTick, CostRollup } from '@co/core';
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
    reply: vi.fn().mockResolvedValue(undefined),
    approve: vi.fn().mockResolvedValue(undefined),
    markRead: vi.fn().mockResolvedValue(undefined),
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

describe('createAppShell — dashboard VM wiring', () => {
  const FAKE_MAIL: DeliveredMail = {
    seq: 1,
    recipient: '@operator',
    sender: 'lead-1',
    type: 'clarify_request',
    subject: 'Q',
    body: 'body',
    ts: 1000,
  } as DeliveredMail;

  it('exposes dashboard VM starting degraded', () => {
    const shell = createAppShell({
      projectId: FAKE_PROJECT_ID,
      socketPath: FAKE_SOCKET,
      client: makeClient(),
      actionablesReader: () => [],
    });
    expect(shell.dashboard.state.connection).toBe('degraded');
  });

  it('notifies onDashboardState after start() with connection status', async () => {
    const onDashboardState = vi.fn();
    const shell = createAppShell({
      projectId: FAKE_PROJECT_ID,
      socketPath: FAKE_SOCKET,
      client: makeClient(staticObs),
      actionablesReader: () => [],
      onDashboardState,
    });
    await shell.start();
    expect(onDashboardState).toHaveBeenCalledOnce();
    expect(onDashboardState).toHaveBeenCalledWith(
      expect.objectContaining({ connection: 'degraded' }),
    );
  });

  it('dashboard connection becomes live when conductor is up', async () => {
    const shell = createAppShell({
      projectId: FAKE_PROJECT_ID,
      socketPath: FAKE_SOCKET,
      client: makeClient(liveObs),
      actionablesReader: () => [],
    });
    await shell.start();
    expect(shell.dashboard.state.connection).toBe('live');
  });

  it('actionables from injected reader appear in dashboard state', async () => {
    const shell = createAppShell({
      projectId: FAKE_PROJECT_ID,
      socketPath: FAKE_SOCKET,
      client: makeClient(staticObs),
      actionablesReader: () => [FAKE_MAIL],
    });
    await shell.start();
    expect(shell.dashboard.state.actionables).toHaveLength(1);
    expect(shell.dashboard.state.actionables[0]?.seq).toBe(1);
  });

  it('a pushed tick updates the dashboard within one cycle', async () => {
    const tickListeners: Array<(tick: OperatorIpcTick) => void> = [];
    const client = {
      connected: false,
      connect: vi.fn().mockResolvedValue(false),
      observe: vi.fn().mockResolvedValue(staticObs),
      onTick: vi.fn().mockImplementation((cb: (tick: OperatorIpcTick) => void) => {
        tickListeners.push(cb);
        return () => {};
      }),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as OperatorIpcClient;

    const onDashboardState = vi.fn();
    const shell = createAppShell({
      projectId: FAKE_PROJECT_ID,
      socketPath: FAKE_SOCKET,
      client,
      actionablesReader: () => [],
      onDashboardState,
    });
    await shell.start();
    onDashboardState.mockClear();

    const tick: OperatorIpcTick = { snapshot: { snapshot: emptyStatic, agents: [] } };
    tickListeners[0]?.(tick);

    expect(onDashboardState).toHaveBeenCalledOnce();
    expect(onDashboardState).toHaveBeenCalledWith(expect.objectContaining({ connection: 'live' }));
    expect(shell.dashboard.state.connection).toBe('live');
  });
});

describe('createAppShell — limitsCost VM wiring', () => {
  const FAKE_ROLLUP: CostRollup = {
    kind: 'agent',
    id: 'impl-1',
    totalCostUsd: 0.05,
    costUsdObservations: 1,
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    tokenObservations: 1,
    usedPct: 0,
    usedPctObservations: 0,
    observations: 1,
  };

  it('exposes limitsCost VM starting with empty state', () => {
    const shell = createAppShell({
      projectId: FAKE_PROJECT_ID,
      socketPath: FAKE_SOCKET,
      client: makeClient(),
      bucketsReader: () => [],
      accountStatusesReader: () => [],
      rollupsReader: () => [],
    });
    expect(shell.limitsCost.state.headroomRows).toHaveLength(0);
    expect(shell.limitsCost.state.agentCosts).toHaveLength(0);
    expect(shell.limitsCost.state.taskCosts).toHaveLength(0);
  });

  it('notifies onLimitsCostState after start()', async () => {
    const onLimitsCostState = vi.fn();
    const shell = createAppShell({
      projectId: FAKE_PROJECT_ID,
      socketPath: FAKE_SOCKET,
      client: makeClient(),
      bucketsReader: () => [],
      accountStatusesReader: () => [],
      rollupsReader: () => [],
      onLimitsCostState,
    });
    await shell.start();
    expect(onLimitsCostState).toHaveBeenCalledOnce();
  });

  it('injected rollups appear in limitsCost state after start()', async () => {
    const shell = createAppShell({
      projectId: FAKE_PROJECT_ID,
      socketPath: FAKE_SOCKET,
      client: makeClient(),
      bucketsReader: () => [],
      accountStatusesReader: () => [],
      rollupsReader: () => [FAKE_ROLLUP],
    });
    await shell.start();
    expect(shell.limitsCost.state.agentCosts).toHaveLength(1);
    expect(shell.limitsCost.state.agentCosts[0]?.id).toBe('impl-1');
    expect(shell.limitsCost.state.agentCosts[0]?.totalCostUsd).toBe(0.05);
  });
});

describe('createAppShell — mail VM bridge wiring', () => {
  const INFO_MAIL: DeliveredMail = {
    seq: 10,
    recipient: '@operator',
    sender: 'lead-1',
    type: 'chat',
    subject: 'FYI',
    body: 'hello',
    ts: 1000,
    read: false,
  } as DeliveredMail;

  const ACTION_MAIL: DeliveredMail = {
    seq: 11,
    recipient: '@operator',
    sender: 'lead-1',
    type: 'clarify_request',
    subject: 'Need input',
    body: 'what next?',
    ts: 1000,
  } as DeliveredMail;

  it('notifies onMailState when MailVM mutates selection and composer state', () => {
    const onMailState = vi.fn();
    const shell = createAppShell({
      projectId: FAKE_PROJECT_ID,
      socketPath: FAKE_SOCKET,
      client: makeClient(),
      actionablesReader: () => [],
      inboxReader: () => [ACTION_MAIL],
      outboxReader: () => [],
      onMailState,
    });

    shell.refreshMail();
    onMailState.mockClear();

    shell.mail.selectMail(ACTION_MAIL.seq);
    expect(onMailState).toHaveBeenCalledWith(
      expect.objectContaining({ selected: expect.objectContaining({ seq: ACTION_MAIL.seq }) }),
    );

    onMailState.mockClear();
    shell.mail.openComposer(
      ACTION_MAIL.seq,
      ACTION_MAIL.recipient,
      'clarify_response',
      'Re: Need input',
    );
    expect(onMailState).toHaveBeenCalledWith(
      expect.objectContaining({
        composer: expect.objectContaining({ active: true, targetSeq: ACTION_MAIL.seq }),
      }),
    );

    onMailState.mockClear();
    shell.mail.closeComposer();
    expect(onMailState).toHaveBeenCalledWith(
      expect.objectContaining({ composer: expect.objectContaining({ active: false }) }),
    );
  });

  it('submits review_request replies with a structured review verdict', async () => {
    const reviewRequest = {
      ...ACTION_MAIL,
      type: 'review_request',
      subject: 'Review merge',
    } as DeliveredMail;
    const client = makeClient();
    const shell = createAppShell({
      projectId: FAKE_PROJECT_ID,
      socketPath: FAKE_SOCKET,
      client,
      actionablesReader: () => [],
      inboxReader: () => [reviewRequest],
      outboxReader: () => [],
    });

    shell.refreshMail();
    shell.mail.selectMail(reviewRequest.seq);
    shell.mail.openComposer(
      reviewRequest.seq,
      reviewRequest.recipient,
      'review_response',
      'Re: Review merge',
    );
    shell.mail.updateComposerField('body', 'ISSUES\nneeds tests');
    await shell.mail.submitReply();

    await vi.waitFor(() => {
      expect(client.reply).toHaveBeenCalledWith(
        { seq: reviewRequest.seq, recipient: '@operator' },
        expect.objectContaining({
          type: 'review_response',
          reviewVerdict: 'ISSUES',
          body: 'ISSUES\nneeds tests',
        }),
      );
    });
  });

  it('refreshes mail after informational markRead succeeds', async () => {
    let mail = INFO_MAIL;
    const onMailState = vi.fn();
    const client = {
      ...makeClient(),
      markRead: vi.fn().mockImplementation(async (_recipient: string, seq: number) => {
        mail = { ...mail, seq, read: true } as DeliveredMail;
        return mail;
      }),
    } as unknown as OperatorIpcClient;
    const shell = createAppShell({
      projectId: FAKE_PROJECT_ID,
      socketPath: FAKE_SOCKET,
      client,
      actionablesReader: () => [],
      inboxReader: () => [mail],
      outboxReader: () => [],
      onMailState,
    });

    shell.refreshMail();
    onMailState.mockClear();
    shell.mail.selectMail(INFO_MAIL.seq);

    await vi.waitFor(() => {
      expect(client.markRead).toHaveBeenCalledWith('@operator', INFO_MAIL.seq);
      expect(shell.mail.state.inbox[0]?.read).toBe(true);
      expect(onMailState).toHaveBeenCalledWith(
        expect.objectContaining({
          inbox: expect.arrayContaining([
            expect.objectContaining({ seq: INFO_MAIL.seq, read: true }),
          ]),
        }),
      );
    });
  });
});
