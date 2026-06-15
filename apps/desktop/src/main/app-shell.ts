import { operatorIpcSocketPath } from '@co/mcp';
import type { ProjectId, DeliveredMail, OperatorIpcTick, OperatorObservation } from '@co/core';
import { projectDataDir, openMailStore } from '@co/core';
import { OperatorIpcClient } from '@co/mcp';
import { NavVM } from '../shared/nav-vm.js';
import { ConnectionVM } from '../shared/connection-vm.js';
import { DashboardVM } from '../shared/dashboard-vm.js';
import type { ConnectionState } from '../shared/connection-vm.js';
import type { NavState } from '../shared/nav-vm.js';
import type { DashboardState } from '../shared/dashboard-vm.js';

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
  readonly onNavState?: (state: NavState) => void;
  readonly onConnectionState?: (state: ConnectionState) => void;
  readonly onDashboardState?: (state: DashboardState) => void;
}

export interface AppShell {
  readonly nav: NavVM;
  readonly connection: ConnectionVM;
  readonly dashboard: DashboardVM;
  readonly client: OperatorIpcClient;
  start(): Promise<void>;
  close(): Promise<void>;
}

export function createAppShell(deps: AppShellDeps): AppShell {
  const socketPath = deps.socketPath ?? defaultOperatorSocketPath(deps.projectId);

  // Open the mail store for the app's lifetime (D5 hybrid: static reads go direct).
  // When an actionablesReader is injected (tests), skip opening the store entirely.
  const ownedStore = deps.actionablesReader == null ? openMailStore(deps.projectId) : null;
  const readActionables: () => readonly DeliveredMail[] =
    deps.actionablesReader ?? (() => ownedStore!.outstanding('@operator'));

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

  const nav = new NavVM();
  if (deps.onNavState) nav.subscribe(deps.onNavState);

  const connVm = new ConnectionVM({
    client,
    onState: (state: ConnectionState) => {
      deps.onConnectionState?.(state);
      dash.update(state.observation, readActionables());
      deps.onDashboardState?.(dash.state);
    },
    onTick: (tick: OperatorIpcTick) => {
      const liveObs: OperatorObservation = { kind: 'live', snapshot: tick.snapshot };
      dash.update(liveObs, readActionables());
      deps.onDashboardState?.(dash.state);
    },
  });
  connVmRef.current = connVm;

  return {
    nav,
    connection: connVm,
    dashboard: dash,
    client,
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
