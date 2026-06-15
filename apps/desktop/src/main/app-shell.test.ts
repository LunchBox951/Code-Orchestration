import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAppShell, defaultOperatorSocketPath } from './app-shell.js';
import type {
  OperatorObservation,
  DeliveredMail,
  OperatorIpcTick,
  OperatorIpcTranscript,
  CostRollup,
  TranscriptTail,
} from '@co/core';
import type { ProjectId } from '@co/core';
import { MAIL_REVIEW_REQUEST, MAIL_REVIEW_RESPONSE, OPERATOR, projectDataDir } from '@co/core';
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

const flushPromises = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const transcriptTail = (agentId: string, tail: string, offset = 0): TranscriptTail => ({
  agentId,
  offset,
  tail,
});
const transcriptPush = (agentId: string, chunk: string, offset = 0): OperatorIpcTranscript => ({
  agentId,
  offset,
  chunk,
});

function makeClient(obs: OperatorObservation = staticObs): OperatorIpcClient {
  return {
    connected: obs.kind === 'live',
    connect: vi.fn().mockResolvedValue(obs.kind === 'live'),
    observe: vi.fn().mockResolvedValue(obs),
    onTick: vi.fn().mockReturnValue(() => {}),
    onTranscript: vi.fn().mockReturnValue(() => {}),
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

  it('surfaces unexpected operator IPC connect failures from the production client wiring', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'co-desktop-opipc-'));
    const blockedParent = join(dir, 'not-a-directory');
    writeFileSync(blockedParent, '');
    const onConnectionError = vi.fn();
    const shell = createAppShell({
      projectId: FAKE_PROJECT_ID,
      socketPath: join(blockedParent, 'operator.sock'),
      actionablesReader: () => [],
      inboxReader: () => [],
      outboxReader: () => [],
      bucketsReader: () => [],
      accountStatusesReader: () => [],
      rollupsReader: () => [],
      onConnectionError,
    });

    try {
      await shell.start();
    } finally {
      await shell.close();
      rmSync(dir, { recursive: true, force: true });
    }

    expect(shell.connection.state.status).toBe('degraded');
    expect(onConnectionError).toHaveBeenCalledOnce();
    expect(onConnectionError.mock.calls[0]?.[0]).toMatch(/operator IPC connection/i);
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
      onTranscript: vi.fn().mockReturnValue(() => {}),
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

describe('createAppShell — review VM bridge wiring', () => {
  const REVIEW_MAIL = {
    seq: 77,
    recipient: OPERATOR,
    sender: 'lead-1',
    type: MAIL_REVIEW_REQUEST,
    subject: 'Review merge',
    body: 'Please review this branch.',
    ts: 1700000000000,
    idempotencyKey: 'review-request:rev-shell',
    resolved: false,
  } as DeliveredMail;

  const REVIEW_CONTEXT = {
    kind: 'resolved',
    reviewId: 'rev-shell',
    branch: 'co/review-shell',
    target: 'main',
    scope: 'merge',
    diff: { kind: 'patch', patch: '@@ -1 +1 @@\n-old\n+new' },
    criteria: {
      kind: 'criteria',
      specRef: 'spec:task-review-shell#locked',
      criteria: [{ text: 'change is reviewable', verify: 'pnpm test' }],
    },
  } as const;

  it('selects a review, fetches context, and submits PASS through operator IPC', async () => {
    let inbox: readonly DeliveredMail[] = [REVIEW_MAIL];
    const client = {
      ...makeClient(),
      reviewContext: vi.fn().mockResolvedValue(REVIEW_CONTEXT),
      reply: vi.fn().mockImplementation(async () => {
        inbox = [{ ...REVIEW_MAIL, resolved: true } as DeliveredMail];
      }),
    } as unknown as OperatorIpcClient;
    const onReviewState = vi.fn();
    const shell = createAppShell({
      projectId: FAKE_PROJECT_ID,
      socketPath: FAKE_SOCKET,
      client,
      actionablesReader: () => [],
      inboxReader: () => inbox,
      outboxReader: () => [],
      onReviewState,
    });

    expect(shell.reviewRefresh().pending).toEqual([
      expect.objectContaining({ reviewId: 'rev-shell', seq: REVIEW_MAIL.seq }),
    ]);
    expect(shell.reviewSelect('rev-shell').context).toEqual({ status: 'loading' });
    expect(client.reviewContext).toHaveBeenCalledWith('rev-shell');

    await vi.waitFor(() => {
      expect(onReviewState.mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({
          context: { status: 'loaded', value: REVIEW_CONTEXT },
        }),
      );
    });

    shell.reviewBeginVerdict('PASS');
    shell.reviewUpdateComposerBody('looks good');
    const state = await shell.reviewSubmitVerdict();

    expect(client.reply).toHaveBeenCalledWith(
      { seq: REVIEW_MAIL.seq, recipient: OPERATOR },
      expect.objectContaining({
        type: MAIL_REVIEW_RESPONSE,
        reviewVerdict: 'PASS',
        body: 'PASS\nlooks good',
      }),
    );
    expect(state.pending).toEqual([]);
    expect(state.composer.active).toBe(false);
  });
});

describe('createAppShell — agentsConsole VM wiring', () => {
  it('roster from observation: tick with agents emits console state with roster', async () => {
    const tickListeners: Array<(tick: OperatorIpcTick) => void> = [];
    const client = {
      connected: false,
      connect: vi.fn().mockResolvedValue(false),
      observe: vi.fn().mockResolvedValue(staticObs),
      onTick: vi.fn().mockImplementation((cb: (tick: OperatorIpcTick) => void) => {
        tickListeners.push(cb);
        return () => {};
      }),
      onTranscript: vi.fn().mockReturnValue(() => {}),
      transcript: vi.fn().mockResolvedValue(transcriptTail('impl-x', 'hello world')),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as OperatorIpcClient;

    const onAgentsConsoleState = vi.fn();
    const shell = createAppShell({
      projectId: FAKE_PROJECT_ID,
      socketPath: FAKE_SOCKET,
      client,
      onAgentsConsoleState,
    });
    await shell.start();
    onAgentsConsoleState.mockClear();

    const tick: OperatorIpcTick = {
      snapshot: {
        snapshot: emptyStatic,
        agents: [
          {
            agentId: 'impl-x',
            role: 'implementer',
            parent: 'lead-1',
            hosted: true,
            outstandingMail: 0,
            paused: false,
            stuck: false,
            costUsd: 0,
          },
        ],
      },
    };
    tickListeners[0]?.(tick);

    expect(onAgentsConsoleState).toHaveBeenCalledOnce();
    expect(onAgentsConsoleState).toHaveBeenCalledWith(
      expect.objectContaining({
        roster: expect.arrayContaining([
          expect.objectContaining({ agentId: 'impl-x', status: 'warm' }),
        ]),
      }),
    );
  });

  it('selectAgent backfill: calls transcript and sets selectedAgentId + transcript in state', async () => {
    const client = {
      connected: false,
      connect: vi.fn().mockResolvedValue(false),
      observe: vi.fn().mockResolvedValue(staticObs),
      onTick: vi.fn().mockReturnValue(() => {}),
      onTranscript: vi.fn().mockReturnValue(() => {}),
      transcript: vi.fn().mockResolvedValue(transcriptTail('impl-x', 'hello world')),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as OperatorIpcClient;

    const onAgentsConsoleState = vi.fn();
    const shell = createAppShell({
      projectId: FAKE_PROJECT_ID,
      socketPath: FAKE_SOCKET,
      client,
      onAgentsConsoleState,
    });
    await shell.start();

    shell.selectAgent('impl-x');

    await vi.waitFor(() => {
      expect(client.transcript).toHaveBeenCalledWith('impl-x');
      const lastState = onAgentsConsoleState.mock.calls.at(-1)?.[0];
      expect(lastState).toMatchObject({
        selectedAgentId: 'impl-x',
        transcript: 'hello world',
      });
    });
  });

  it('backfills the selected transcript again after a live tick reconnects', async () => {
    const tickListeners: Array<(tick: OperatorIpcTick) => void> = [];
    const client = {
      connected: false,
      connect: vi.fn().mockResolvedValue(false),
      observe: vi.fn().mockResolvedValue(staticObs),
      onTick: vi.fn().mockImplementation((cb: (tick: OperatorIpcTick) => void) => {
        tickListeners.push(cb);
        return () => {};
      }),
      onTranscript: vi.fn().mockReturnValue(() => {}),
      transcript: vi
        .fn()
        .mockResolvedValueOnce(transcriptTail('impl-x', ''))
        .mockResolvedValueOnce(transcriptTail('impl-x', 'missed while offline\n'))
        .mockResolvedValue(transcriptTail('impl-x', 'unexpected extra fetch\n')),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as OperatorIpcClient;

    const onAgentsConsoleState = vi.fn();
    const shell = createAppShell({
      projectId: FAKE_PROJECT_ID,
      socketPath: FAKE_SOCKET,
      client,
      onAgentsConsoleState,
    });
    await shell.start();

    shell.selectAgent('impl-x');
    await flushPromises();
    expect(shell.agentsConsole.state.transcript).toBe('');

    tickListeners[0]?.({
      snapshot: {
        snapshot: emptyStatic,
        agents: [
          {
            agentId: 'impl-x',
            role: 'implementer',
            parent: 'lead-1',
            hosted: true,
            outstandingMail: 0,
            paused: false,
            stuck: false,
            costUsd: 0,
          },
        ],
      },
    });

    await vi.waitFor(() => {
      expect(client.transcript).toHaveBeenCalledTimes(2);
      expect(onAgentsConsoleState.mock.calls.at(-1)?.[0]).toMatchObject({
        selectedAgentId: 'impl-x',
        transcript: 'missed while offline\n',
      });
    });
  });

  it('replaces stale selected transcript when reconnect starts a new offset generation', async () => {
    const tickListeners: Array<(tick: OperatorIpcTick) => void> = [];
    const client = {
      connected: false,
      connect: vi.fn().mockResolvedValue(false),
      observe: vi.fn().mockResolvedValue(staticObs),
      onTick: vi.fn().mockImplementation((cb: (tick: OperatorIpcTick) => void) => {
        tickListeners.push(cb);
        return () => {};
      }),
      onTranscript: vi.fn().mockReturnValue(() => {}),
      transcript: vi
        .fn()
        .mockResolvedValueOnce(transcriptTail('impl-x', 'old pane output\n'))
        .mockResolvedValueOnce(transcriptTail('impl-x', 'new pane output\n', 0)),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as OperatorIpcClient;

    const shell = createAppShell({
      projectId: FAKE_PROJECT_ID,
      socketPath: FAKE_SOCKET,
      client,
    });
    await shell.start();

    shell.selectAgent('impl-x');
    await vi.waitFor(() => {
      expect(shell.agentsConsole.state.transcript).toBe('old pane output\n');
    });

    tickListeners[0]?.({
      snapshot: {
        snapshot: emptyStatic,
        agents: [
          {
            agentId: 'impl-x',
            role: 'implementer',
            parent: 'lead-1',
            hosted: true,
            outstandingMail: 0,
            paused: false,
            stuck: false,
            costUsd: 0,
          },
        ],
      },
    });

    await vi.waitFor(() => {
      expect(shell.agentsConsole.state.transcript).toBe('new pane output\n');
    });
  });

  it('does not refetch the selected transcript on every live tick after reconnect backfill', async () => {
    const tickListeners: Array<(tick: OperatorIpcTick) => void> = [];
    const liveTick: OperatorIpcTick = {
      snapshot: {
        snapshot: emptyStatic,
        agents: [
          {
            agentId: 'impl-x',
            role: 'implementer',
            parent: 'lead-1',
            hosted: true,
            outstandingMail: 0,
            paused: false,
            stuck: false,
            costUsd: 0,
          },
        ],
      },
    };
    const client = {
      connected: false,
      connect: vi.fn().mockResolvedValue(false),
      observe: vi.fn().mockResolvedValue(staticObs),
      onTick: vi.fn().mockImplementation((cb: (tick: OperatorIpcTick) => void) => {
        tickListeners.push(cb);
        return () => {};
      }),
      onTranscript: vi.fn().mockReturnValue(() => {}),
      transcript: vi
        .fn()
        .mockResolvedValueOnce(transcriptTail('impl-x', ''))
        .mockResolvedValueOnce(transcriptTail('impl-x', 'missed while offline\n'))
        .mockResolvedValue(transcriptTail('impl-x', 'unexpected extra fetch\n')),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as OperatorIpcClient;

    const shell = createAppShell({
      projectId: FAKE_PROJECT_ID,
      socketPath: FAKE_SOCKET,
      client,
    });
    await shell.start();

    shell.selectAgent('impl-x');
    await flushPromises();

    tickListeners[0]?.(liveTick);
    await vi.waitFor(() => {
      expect(client.transcript).toHaveBeenCalledTimes(2);
      expect(shell.agentsConsole.state.transcript).toBe('missed while offline\n');
    });

    tickListeners[0]?.(liveTick);
    await flushPromises();

    expect(client.transcript).toHaveBeenCalledTimes(2);
  });

  it('backfills the selected transcript on a live refresh even when the console was already live', async () => {
    const liveWithImpl: OperatorObservation = {
      kind: 'live',
      snapshot: {
        snapshot: emptyStatic,
        agents: [
          {
            agentId: 'impl-x',
            role: 'implementer',
            parent: 'lead-1',
            hosted: true,
            outstandingMail: 0,
            paused: false,
            stuck: false,
            costUsd: 0,
          },
        ],
      },
    };
    const client = {
      connected: true,
      connect: vi.fn().mockResolvedValue(true),
      observe: vi.fn().mockResolvedValue(liveWithImpl),
      onTick: vi.fn().mockReturnValue(() => {}),
      onTranscript: vi.fn().mockReturnValue(() => {}),
      transcript: vi
        .fn()
        .mockResolvedValueOnce(transcriptTail('impl-x', 'before disconnect\n'))
        .mockResolvedValueOnce(transcriptTail('impl-x', 'missed during disconnect\n', 0)),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as OperatorIpcClient;

    const shell = createAppShell({
      projectId: FAKE_PROJECT_ID,
      socketPath: FAKE_SOCKET,
      client,
    });
    await shell.start();

    shell.selectAgent('impl-x');
    await vi.waitFor(() => {
      expect(shell.agentsConsole.state.connection).toBe('live');
      expect(shell.agentsConsole.state.transcript).toBe('before disconnect\n');
    });

    await shell.connection.refresh();

    await vi.waitFor(() => {
      expect(client.transcript).toHaveBeenCalledTimes(2);
      expect(shell.agentsConsole.state.transcript).toBe('missed during disconnect\n');
    });
  });

  it('live append: onTranscript chunk appends for selected agent; different agentId is ignored', async () => {
    const transcriptListeners: Array<(t: OperatorIpcTranscript) => void> = [];
    const client = {
      connected: false,
      connect: vi.fn().mockResolvedValue(false),
      observe: vi.fn().mockResolvedValue(staticObs),
      onTick: vi.fn().mockReturnValue(() => {}),
      onTranscript: vi.fn().mockImplementation((cb: (t: OperatorIpcTranscript) => void) => {
        transcriptListeners.push(cb);
        return () => {};
      }),
      transcript: vi.fn().mockResolvedValue(transcriptTail('impl-x', 'base')),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as OperatorIpcClient;

    const onAgentsConsoleState = vi.fn();
    const shell = createAppShell({
      projectId: FAKE_PROJECT_ID,
      socketPath: FAKE_SOCKET,
      client,
      onAgentsConsoleState,
    });
    await shell.start();

    shell.selectAgent('impl-x');
    await vi.waitFor(() => {
      const lastState = onAgentsConsoleState.mock.calls.at(-1)?.[0];
      expect(lastState?.transcript).toBe('base');
    });

    onAgentsConsoleState.mockClear();

    // Chunk for the selected agent appends
    transcriptListeners[0]?.(transcriptPush('impl-x', ' chunk', 'base'.length));
    expect(onAgentsConsoleState).toHaveBeenCalledOnce();
    expect(onAgentsConsoleState.mock.calls.at(-1)?.[0]).toMatchObject({
      transcript: 'base chunk',
    });

    onAgentsConsoleState.mockClear();

    // Chunk for a different agentId is ignored (per-agent isolation through the VM)
    transcriptListeners[0]?.(transcriptPush('other-agent', ' ignored'));
    expect(onAgentsConsoleState).not.toHaveBeenCalled();
  });

  it('selectAgent backfill preserves live chunks that arrive before transcript() resolves', async () => {
    const transcriptListeners: Array<(t: OperatorIpcTranscript) => void> = [];
    let resolveTranscript!: (tail: TranscriptTail) => void;
    const transcriptP = new Promise<TranscriptTail>((resolve) => {
      resolveTranscript = resolve;
    });
    const client = {
      connected: false,
      connect: vi.fn().mockResolvedValue(false),
      observe: vi.fn().mockResolvedValue(staticObs),
      onTick: vi.fn().mockReturnValue(() => {}),
      onTranscript: vi.fn().mockImplementation((cb: (t: OperatorIpcTranscript) => void) => {
        transcriptListeners.push(cb);
        return () => {};
      }),
      transcript: vi.fn().mockReturnValue(transcriptP),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as OperatorIpcClient;

    const onAgentsConsoleState = vi.fn();
    const shell = createAppShell({
      projectId: FAKE_PROJECT_ID,
      socketPath: FAKE_SOCKET,
      client,
      onAgentsConsoleState,
    });
    await shell.start();

    shell.selectAgent('impl-x');
    transcriptListeners[0]?.(transcriptPush('impl-x', 'live chunk\n', 'existing tail\n'.length));
    expect(onAgentsConsoleState.mock.calls.at(-1)?.[0]).toMatchObject({
      selectedAgentId: 'impl-x',
      transcript: 'live chunk\n',
    });

    resolveTranscript(transcriptTail('impl-x', 'existing tail\n'));

    await vi.waitFor(() => {
      expect(onAgentsConsoleState.mock.calls.at(-1)?.[0]).toMatchObject({
        selectedAgentId: 'impl-x',
        transcript: 'existing tail\nlive chunk\n',
      });
    });
  });

  it('selectAgent preserves repeated live bytes when stale backfill ends with the same text', async () => {
    const transcriptListeners: Array<(t: OperatorIpcTranscript) => void> = [];
    let resolveTranscript!: (tail: TranscriptTail) => void;
    const transcriptP = new Promise<TranscriptTail>((resolve) => {
      resolveTranscript = resolve;
    });
    const client = {
      connected: false,
      connect: vi.fn().mockResolvedValue(false),
      observe: vi.fn().mockResolvedValue(staticObs),
      onTick: vi.fn().mockReturnValue(() => {}),
      onTranscript: vi.fn().mockImplementation((cb: (t: OperatorIpcTranscript) => void) => {
        transcriptListeners.push(cb);
        return () => {};
      }),
      transcript: vi.fn().mockReturnValue(transcriptP),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as OperatorIpcClient;

    const onAgentsConsoleState = vi.fn();
    const shell = createAppShell({
      projectId: FAKE_PROJECT_ID,
      socketPath: FAKE_SOCKET,
      client,
      onAgentsConsoleState,
    });
    await shell.start();

    shell.selectAgent('impl-x');
    transcriptListeners[0]?.(transcriptPush('impl-x', 'prompt\n', 'older prompt\n'.length));
    resolveTranscript(transcriptTail('impl-x', 'older prompt\n'));

    await vi.waitFor(() => {
      expect(onAgentsConsoleState.mock.calls.at(-1)?.[0]).toMatchObject({
        selectedAgentId: 'impl-x',
        transcript: 'older prompt\nprompt\n',
      });
    });
  });

  it('ignores an older same-agent backfill after selecting away and back', async () => {
    let resolveFirst!: (tail: TranscriptTail) => void;
    let resolveSecond!: (tail: TranscriptTail) => void;
    const firstP = new Promise<TranscriptTail>((resolve) => {
      resolveFirst = resolve;
    });
    const secondP = new Promise<TranscriptTail>((resolve) => {
      resolveSecond = resolve;
    });
    const client = {
      connected: false,
      connect: vi.fn().mockResolvedValue(false),
      observe: vi.fn().mockResolvedValue(staticObs),
      onTick: vi.fn().mockReturnValue(() => {}),
      onTranscript: vi.fn().mockReturnValue(() => {}),
      transcript: vi.fn().mockReturnValueOnce(firstP).mockReturnValueOnce(secondP),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as OperatorIpcClient;

    const onAgentsConsoleState = vi.fn();
    const shell = createAppShell({
      projectId: FAKE_PROJECT_ID,
      socketPath: FAKE_SOCKET,
      client,
      onAgentsConsoleState,
    });
    await shell.start();

    shell.selectAgent('impl-x');
    shell.selectAgent(null);
    shell.selectAgent('impl-x');
    resolveSecond(transcriptTail('impl-x', 'fresh tail\n'));

    await vi.waitFor(() => {
      expect(onAgentsConsoleState.mock.calls.at(-1)?.[0]).toMatchObject({
        selectedAgentId: 'impl-x',
        transcript: 'fresh tail\n',
      });
    });

    resolveFirst(transcriptTail('impl-x', 'stale tail\n'));
    await flushPromises();

    expect(onAgentsConsoleState.mock.calls.at(-1)?.[0]).toMatchObject({
      selectedAgentId: 'impl-x',
      transcript: 'fresh tail\n',
    });
  });
});
