import { operatorIpcSocketPath } from '@co/mcp';
import type { ProjectId } from '@co/core';
import { projectDataDir } from '@co/core';
import { OperatorIpcClient } from '@co/mcp';
import { NavVM } from '../shared/nav-vm.js';
import { ConnectionVM } from '../shared/connection-vm.js';
import type { ConnectionState } from '../shared/connection-vm.js';
import type { NavState } from '../shared/nav-vm.js';

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
  readonly onNavState?: (state: NavState) => void;
  readonly onConnectionState?: (state: ConnectionState) => void;
}

export interface AppShell {
  readonly nav: NavVM;
  readonly connection: ConnectionVM;
  readonly client: OperatorIpcClient;
  start(): Promise<void>;
  close(): Promise<void>;
}

export function createAppShell(deps: AppShellDeps): AppShell {
  const socketPath = deps.socketPath ?? defaultOperatorSocketPath(deps.projectId);

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
    onState: deps.onConnectionState,
  });
  connVmRef.current = connVm;

  return {
    nav,
    connection: connVm,
    client,
    async start() {
      await connVm.start();
    },
    async close() {
      connVm.close();
      await client.close();
    },
  };
}
