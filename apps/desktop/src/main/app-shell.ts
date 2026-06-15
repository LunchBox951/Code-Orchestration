import { operatorIpcSocketPath } from '@co/mcp';
import type {
  ApprovalReply,
  DeliveredMail,
  OperatorIpcTick,
  OperatorMailRef,
  OperatorObservation,
  ProjectId,
  RendererRegistry,
  ReplyDraft,
} from '@co/core';
import {
  createRendererRegistry,
  MAIL_APPROVAL,
  MAIL_CLARIFY_REQUEST,
  MAIL_REVIEW_REQUEST,
  MAIL_REVIEW_RESPONSE,
  openMailStore,
  projectDataDir,
} from '@co/core';
import { ConductorUnavailableError, OperatorIpcClient } from '@co/mcp';
import { NavVM } from '../shared/nav-vm.js';
import { ConnectionVM } from '../shared/connection-vm.js';
import { DashboardVM } from '../shared/dashboard-vm.js';
import { MailVM } from '../shared/mail-vm.js';
import type { ConnectionState } from '../shared/connection-vm.js';
import type { NavState } from '../shared/nav-vm.js';
import type { DashboardState } from '../shared/dashboard-vm.js';
import type { MailState } from '../shared/mail-vm.js';

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
  readonly onNavState?: (state: NavState) => void;
  readonly onConnectionState?: (state: ConnectionState) => void;
  readonly onDashboardState?: (state: DashboardState) => void;
  readonly onMailState?: (state: MailState) => void;
  readonly onMailError?: (message: string) => void;
}

export interface AppShell {
  readonly nav: NavVM;
  readonly connection: ConnectionVM;
  readonly dashboard: DashboardVM;
  readonly mail: MailVM;
  readonly client: OperatorIpcClient;
  start(): Promise<void>;
  close(): Promise<void>;
  refreshMail(busId?: string): void;
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

  const dash = new DashboardVM();

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
    });

  const mailVm = new MailVM({
    registry: buildRegistry(deps.registry),
    onMarkRead: (recipient, seq) => {
      void client.markRead(recipient, seq).catch((e: unknown) => {
        // Conductor down or gone mid-call — show a clear message, never crash.
        if (!(e instanceof ConductorUnavailableError)) {
          deps.onMailError?.(safeError(e));
        }
      });
    },
    onReply: (target: OperatorMailRef, draft: ReplyDraft) => {
      void client
        .reply(target, draft)
        .then(() => {
          doRefreshMail();
        })
        .catch((e: unknown) => {
          deps.onMailError?.(
            e instanceof ConductorUnavailableError
              ? 'Conductor not running — start `co serve` to send mail.'
              : safeError(e),
          );
        });
    },
    onApprove: (approvalSeq: number, reply: ApprovalReply) => {
      void client
        .approve(approvalSeq, reply)
        .then(() => {
          doRefreshMail();
          // Refresh dashboard to update outstandingCount after actionable clears.
          void connVmRef.current?.refresh();
        })
        .catch((e: unknown) => {
          deps.onMailError?.(
            e instanceof ConductorUnavailableError
              ? 'Conductor not running — start `co serve` to approve/decline.'
              : safeError(e),
          );
        });
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
    deps.onMailState?.(mailVm.state);
  }

  const nav = new NavVM();
  if (deps.onNavState) nav.subscribe(deps.onNavState);

  const connVm = new ConnectionVM({
    client,
    onState: (state: ConnectionState) => {
      deps.onConnectionState?.(state);
      dash.update(state.observation, readActionables());
      deps.onDashboardState?.(dash.state);
      doRefreshMail();
    },
    onTick: (tick: OperatorIpcTick) => {
      const liveObs: OperatorObservation = { kind: 'live', snapshot: tick.snapshot };
      dash.update(liveObs, readActionables());
      deps.onDashboardState?.(dash.state);
      doRefreshMail();
    },
  });
  connVmRef.current = connVm;

  return {
    nav,
    connection: connVm,
    dashboard: dash,
    mail: mailVm,
    client,
    refreshMail: doRefreshMail,
    async start() {
      await connVm.start();
    },
    async close() {
      connVm.close();
      await client.close();
      ownedStore?.close();
    },
  };
}
