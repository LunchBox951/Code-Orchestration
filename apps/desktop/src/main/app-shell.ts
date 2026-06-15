import { operatorIpcSocketPath } from '@co/mcp';
import type {
  ApprovalReply,
  CostRollup,
  DeliveredMail,
  OperatorIpcTick,
  OperatorMailRef,
  OperatorObservation,
  ProjectId,
  RendererRegistry,
  ReplyDraft,
  UsageAccountStatus,
  UsageBucket,
} from '@co/core';
import {
  createRendererRegistry,
  MAIL_APPROVAL,
  MAIL_CLARIFY_REQUEST,
  MAIL_REVIEW_REQUEST,
  MAIL_REVIEW_RESPONSE,
  openDispatchStore,
  openMailStore,
  projectDataDir,
} from '@co/core';
import { ConductorUnavailableError, OperatorIpcClient } from '@co/mcp';
import { NavVM } from '../shared/nav-vm.js';
import { ConnectionVM } from '../shared/connection-vm.js';
import { DashboardVM } from '../shared/dashboard-vm.js';
import { LimitsCostVM } from '../shared/limits-cost-vm.js';
import { MailVM } from '../shared/mail-vm.js';
import { AgentsConsoleVM } from '../shared/agents-console-vm.js';
import type { ConnectionState } from '../shared/connection-vm.js';
import type { NavState } from '../shared/nav-vm.js';
import type { DashboardState } from '../shared/dashboard-vm.js';
import type { LimitsCostState } from '../shared/limits-cost-vm.js';
import type { MailState } from '../shared/mail-vm.js';
import type { AgentsConsoleState } from '../shared/agents-console-vm.js';

/**
 * The canonical socket path the server listens on for a given project.
 * Exported so tests can assert client↔server path agreement without
 * relying on the internal formula surviving a refactor silently.
 */
export function defaultOperatorSocketPath(projectId: ProjectId): string {
  return operatorIpcSocketPath(projectDataDir(projectId));
}

export interface AppShellDeps {
  readonly projectId: ProjectId;
  readonly socketPath?: string;
  /** Injectable for tests — production leaves this undefined (creates a real client). */
  readonly client?: OperatorIpcClient;
  /** Injectable for tests — production opens a real MailStore. */
  readonly actionablesReader?: () => readonly DeliveredMail[];
  /** Injectable for tests — reads a recipient's inbox (default: real MailStore). */
  readonly inboxReader?: (recipient: string) => readonly DeliveredMail[];
  /** Injectable for tests — reads a sender's outbox (default: real MailStore sentBy). */
  readonly outboxReader?: (sender: string) => readonly DeliveredMail[];
  /** Injectable for tests — provides the renderer registry (default: one with built-in type cards). */
  readonly registry?: RendererRegistry;
  /** Injectable for tests — reads usage buckets (default: real DispatchStore). */
  readonly bucketsReader?: () => readonly UsageBucket[];
  /** Injectable for tests — reads account statuses (default: real DispatchStore). */
  readonly accountStatusesReader?: () => readonly UsageAccountStatus[];
  /** Injectable for tests — reads cost rollups (default: real DispatchStore). */
  readonly rollupsReader?: () => readonly CostRollup[];
  readonly onNavState?: (state: NavState) => void;
  readonly onConnectionState?: (state: ConnectionState) => void;
  readonly onConnectionError?: (message: string) => void;
  readonly onDashboardState?: (state: DashboardState) => void;
  readonly onMailState?: (state: MailState) => void;
  readonly onMailError?: (message: string) => void;
  readonly onLimitsCostState?: (state: LimitsCostState) => void;
  readonly onAgentsConsoleState?: (state: AgentsConsoleState) => void;
}

export interface AppShell {
  readonly nav: NavVM;
  readonly connection: ConnectionVM;
  readonly dashboard: DashboardVM;
  readonly mail: MailVM;
  readonly limitsCost: LimitsCostVM;
  readonly agentsConsole: AgentsConsoleVM;
  readonly client: OperatorIpcClient;
  start(): Promise<void>;
  close(): Promise<void>;
  refreshMail(busId?: string): void;
  refreshLimitsCost(): void;
  selectAgent(agentId: string | null): void;
}

function buildRegistry(override?: RendererRegistry): RendererRegistry {
  if (override != null) return override;
  const registry = createRendererRegistry();
  registry.register(
    MAIL_APPROVAL,
    (m) =>
      `### Approval Request\n\n**Subject:** ${m.subject}\n\n${m.body}\n\n> Approve or decline this request.`,
  );
  registry.register(
    MAIL_CLARIFY_REQUEST,
    (m) =>
      `### Clarification Request\n\n**Subject:** ${m.subject}\n\n${m.body}\n\n> Reply with your clarification.`,
  );
  registry.register(
    MAIL_REVIEW_REQUEST,
    (m) =>
      `### Review Request\n\n**Subject:** ${m.subject}\n\n${m.body}\n\n> Submit PASS or ISSUES.`,
  );
  registry.register(MAIL_REVIEW_RESPONSE, (m) => {
    const verdict = m.reviewVerdict ?? 'UNKNOWN';
    return `### Review Response — ${verdict}\n\n**Subject:** ${m.subject}\n\n${m.body}`;
  });
  return registry;
}

function safeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createAppShell(deps: AppShellDeps): AppShell {
  const socketPath = deps.socketPath ?? defaultOperatorSocketPath(deps.projectId);

  // Open the mail store for the app's lifetime (D5 hybrid: static reads go direct,
  // daemon-down-safe). Only opened when no readers are injected (production mode).
  // Tests that inject actionablesReader get ownedStore=null; mail reads return [] safely.
  const ownedStore = deps.actionablesReader == null ? openMailStore(deps.projectId) : null;
  const readActionables: () => readonly DeliveredMail[] =
    deps.actionablesReader ?? (() => ownedStore!.outstanding('@operator'));
  // Reuse ownedStore for mail reads in production; fall back to empty arrays in test mode.
  const readInbox: (r: string) => readonly DeliveredMail[] =
    deps.inboxReader ?? (ownedStore != null ? (r) => ownedStore.inbox(r) : () => []);
  const readOutbox: (s: string) => readonly DeliveredMail[] =
    deps.outboxReader ?? (ownedStore != null ? (s) => ownedStore.sentBy(s) : () => []);

  // Open the dispatch store for usage/cost static reads (D5: daemon-down-safe pure reads).
  // Opened when no readers are injected (production mode); tests inject reader fns directly.
  const ownedDispatchStore = deps.bucketsReader == null ? openDispatchStore(deps.projectId) : null;
  const readBuckets: () => readonly UsageBucket[] =
    deps.bucketsReader ??
    (ownedDispatchStore != null ? () => ownedDispatchStore.readBuckets() : () => []);
  const readAccountStatuses: () => readonly UsageAccountStatus[] =
    deps.accountStatusesReader ??
    (ownedDispatchStore != null ? () => ownedDispatchStore.readAccountStatuses() : () => []);
  const readRollups: () => readonly CostRollup[] =
    deps.rollupsReader ??
    (ownedDispatchStore != null ? () => ownedDispatchStore.readRollups() : () => []);

  const dash = new DashboardVM();
  const limitsCostVm = new LimitsCostVM();
  const agentsConsoleVm = new AgentsConsoleVM();
  let transcriptRequestSeq = 0;
  agentsConsoleVm.subscribe((state) => deps.onAgentsConsoleState?.(state));

  function doRefreshLimitsCost(): void {
    limitsCostVm.update({
      buckets: readBuckets(),
      accountStatuses: readAccountStatuses(),
      rollups: readRollups(),
    });
    deps.onLimitsCostState?.(limitsCostVm.state);
  }

  // Declare the ref before the client so the onState closure is TDZ-safe and
  // refactor-safe: the handler always resolves through the ref, not the variable.
  const connVmRef: { current?: ConnectionVM } = {};

  const client =
    deps.client ??
    new OperatorIpcClient({
      projectId: deps.projectId,
      socketPath,
      onState: (s) => {
        if (s === 'disconnected') {
          void connVmRef.current?.refresh();
        }
      },
      onError: (e) => {
        deps.onConnectionError?.(`operator IPC connection error: ${safeError(e)}`);
      },
    });

  client.onTranscript((t) => agentsConsoleVm.appendChunk(t));

  const mailVm = new MailVM({
    registry: buildRegistry(deps.registry),
    onMarkRead: (recipient, seq) => {
      void client
        .markRead(recipient, seq)
        .then(() => {
          doRefreshMail();
        })
        .catch((e: unknown) => {
          // Conductor down or gone mid-call — show a clear message, never crash.
          if (!(e instanceof ConductorUnavailableError)) {
            deps.onMailError?.(safeError(e));
          }
        });
    },
    onReply: async (target: OperatorMailRef, draft: ReplyDraft) => {
      try {
        await client.reply(target, draft);
        doRefreshMail();
      } catch (e: unknown) {
        deps.onMailError?.(
          e instanceof ConductorUnavailableError
            ? 'Conductor not running — start `co serve` to send mail.'
            : safeError(e),
        );
        throw e;
      }
    },
    onApprove: async (approvalSeq: number, reply: ApprovalReply) => {
      try {
        await client.approve(approvalSeq, reply);
        doRefreshMail();
        // Refresh dashboard to update outstandingCount after actionable clears.
        void connVmRef.current?.refresh();
      } catch (e: unknown) {
        deps.onMailError?.(
          e instanceof ConductorUnavailableError
            ? 'Conductor not running — start `co serve` to approve/decline.'
            : safeError(e),
        );
        throw e;
      }
    },
    onSelectBus: (busId: string) => {
      doRefreshMail(busId);
    },
  });

  function doRefreshMail(busId?: string): void {
    const bus = busId ?? mailVm.state.activeBus;
    const inbox = readInbox(bus);
    const outbox = readOutbox(bus);
    mailVm.update(inbox, outbox);
  }

  mailVm.subscribe((state) => deps.onMailState?.(state));

  const nav = new NavVM();
  if (deps.onNavState) nav.subscribe(deps.onNavState);

  const connVm = new ConnectionVM({
    client,
    onState: (state: ConnectionState) => {
      deps.onConnectionState?.(state);
      dash.update(state.observation, readActionables());
      deps.onDashboardState?.(dash.state);
      agentsConsoleVm.update(state.observation);
      doRefreshMail();
      doRefreshLimitsCost();
    },
    onTick: (tick: OperatorIpcTick) => {
      const liveObs: OperatorObservation = { kind: 'live', snapshot: tick.snapshot };
      dash.update(liveObs, readActionables());
      deps.onDashboardState?.(dash.state);
      agentsConsoleVm.update(liveObs);
      doRefreshMail();
      doRefreshLimitsCost();
    },
  });
  connVmRef.current = connVm;

  return {
    nav,
    connection: connVm,
    dashboard: dash,
    mail: mailVm,
    limitsCost: limitsCostVm,
    agentsConsole: agentsConsoleVm,
    client,
    refreshMail: doRefreshMail,
    refreshLimitsCost: doRefreshLimitsCost,
    selectAgent(agentId: string | null): void {
      const requestSeq = ++transcriptRequestSeq;
      agentsConsoleVm.selectAgent(agentId);
      if (agentId != null) {
        void client
          .transcript(agentId)
          .then((tail) => {
            if (
              requestSeq === transcriptRequestSeq &&
              agentsConsoleVm.state.selectedAgentId === agentId
            ) {
              agentsConsoleVm.setTranscriptTail(tail);
            }
          })
          .catch(() => {});
      }
    },
    async start() {
      await connVm.start();
    },
    async close() {
      connVm.close();
      await client.close();
      ownedStore?.close();
      ownedDispatchStore?.close();
    },
  };
}
