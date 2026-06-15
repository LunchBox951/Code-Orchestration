import { contextBridge, ipcRenderer } from 'electron';
import type { NavView } from '../shared/nav-vm.js';
import type { NavState } from '../shared/nav-vm.js';
import type { ConnectionState } from '../shared/connection-vm.js';
import type { DashboardState } from '../shared/dashboard-vm.js';

export interface CoShellBridge {
  navigate(view: NavView): void;
  refreshConnection(): Promise<ConnectionState | null>;
  onNavState(listener: (state: NavState) => void): () => void;
  onConnectionState(listener: (state: ConnectionState) => void): () => void;
  onDashboardState(listener: (state: DashboardState) => void): () => void;
  refreshDashboard(): Promise<DashboardState | null>;
}

const bridge: CoShellBridge = {
  navigate(view: NavView) {
    void ipcRenderer.invoke('nav:navigate', view);
  },
  async refreshConnection(): Promise<ConnectionState | null> {
    return ipcRenderer.invoke('connection:refresh') as Promise<ConnectionState | null>;
  },
  onNavState(listener: (state: NavState) => void) {
    const handler = (_event: Electron.IpcRendererEvent, state: NavState): void => listener(state);
    ipcRenderer.on('nav:state', handler);
    return () => ipcRenderer.removeListener('nav:state', handler);
  },
  onConnectionState(listener: (state: ConnectionState) => void) {
    const handler = (_event: Electron.IpcRendererEvent, state: ConnectionState): void =>
      listener(state);
    ipcRenderer.on('connection:state', handler);
    return () => ipcRenderer.removeListener('connection:state', handler);
  },
  onDashboardState(listener: (state: DashboardState) => void) {
    const handler = (_event: Electron.IpcRendererEvent, state: DashboardState): void =>
      listener(state);
    ipcRenderer.on('dashboard:state', handler);
    return () => ipcRenderer.removeListener('dashboard:state', handler);
  },
  async refreshDashboard(): Promise<DashboardState | null> {
    return ipcRenderer.invoke('dashboard:refresh') as Promise<DashboardState | null>;
  },
};

contextBridge.exposeInMainWorld('coShell', bridge);
