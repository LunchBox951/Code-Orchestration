import { contextBridge, ipcRenderer } from 'electron';
import type { NavView } from '../shared/nav-vm.js';
import type { NavState } from '../shared/nav-vm.js';
import type { ConnectionState } from '../shared/connection-vm.js';
import type { DashboardState } from '../shared/dashboard-vm.js';
import type { LimitsCostState } from '../shared/limits-cost-vm.js';
import type { MailState } from '../shared/mail-vm.js';

export interface CoShellBridge {
  navigate(view: NavView): void;
  refreshConnection(): Promise<ConnectionState | null>;
  onNavState(listener: (state: NavState) => void): () => void;
  onConnectionState(listener: (state: ConnectionState) => void): () => void;
  onDashboardState(listener: (state: DashboardState) => void): () => void;
  refreshDashboard(): Promise<DashboardState | null>;
  // ── Mail ──────────────────────────────────────────────────────────────────
  onMailState(listener: (state: MailState) => void): () => void;
  onMailError(listener: (message: string) => void): () => void;
  mailSelectBus(busId: string): Promise<MailState | null>;
  mailSelectTab(tab: 'inbox' | 'outbox'): Promise<MailState | null>;
  mailSelect(seq: number): Promise<MailState | null>;
  mailOpenComposer(
    targetSeq: number,
    targetRecipient: string,
    replyType: string,
    subject: string,
  ): Promise<MailState | null>;
  mailUpdateComposer(field: 'type' | 'subject' | 'body', value: string): Promise<MailState | null>;
  mailCloseComposer(): Promise<MailState | null>;
  mailSubmitReply(): Promise<MailState | null>;
  mailQuickApprove(approvalSeq: number): Promise<MailState | null>;
  mailQuickDecline(approvalSeq: number): Promise<MailState | null>;
  mailRefresh(): Promise<MailState | null>;
  // ── Limits / Cost ─────────────────────────────────────────────────────────
  onLimitsCostState(listener: (state: LimitsCostState) => void): () => void;
  refreshLimitsCost(): Promise<LimitsCostState | null>;
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
  // ── Mail ──────────────────────────────────────────────────────────────────
  onMailState(listener: (state: MailState) => void) {
    const handler = (_event: Electron.IpcRendererEvent, state: MailState): void => listener(state);
    ipcRenderer.on('mail:state', handler);
    return () => ipcRenderer.removeListener('mail:state', handler);
  },
  onMailError(listener: (message: string) => void) {
    const handler = (_event: Electron.IpcRendererEvent, message: string): void => listener(message);
    ipcRenderer.on('mail:error', handler);
    return () => ipcRenderer.removeListener('mail:error', handler);
  },
  async mailSelectBus(busId: string): Promise<MailState | null> {
    return ipcRenderer.invoke('mail:selectBus', busId) as Promise<MailState | null>;
  },
  async mailSelectTab(tab: 'inbox' | 'outbox'): Promise<MailState | null> {
    return ipcRenderer.invoke('mail:selectTab', tab) as Promise<MailState | null>;
  },
  async mailSelect(seq: number): Promise<MailState | null> {
    return ipcRenderer.invoke('mail:select', seq) as Promise<MailState | null>;
  },
  async mailOpenComposer(
    targetSeq: number,
    targetRecipient: string,
    replyType: string,
    subject: string,
  ): Promise<MailState | null> {
    return ipcRenderer.invoke(
      'mail:openComposer',
      targetSeq,
      targetRecipient,
      replyType,
      subject,
    ) as Promise<MailState | null>;
  },
  async mailUpdateComposer(
    field: 'type' | 'subject' | 'body',
    value: string,
  ): Promise<MailState | null> {
    return ipcRenderer.invoke('mail:updateComposer', field, value) as Promise<MailState | null>;
  },
  async mailCloseComposer(): Promise<MailState | null> {
    return ipcRenderer.invoke('mail:closeComposer') as Promise<MailState | null>;
  },
  async mailSubmitReply(): Promise<MailState | null> {
    return ipcRenderer.invoke('mail:submitReply') as Promise<MailState | null>;
  },
  async mailQuickApprove(approvalSeq: number): Promise<MailState | null> {
    return ipcRenderer.invoke('mail:quickApprove', approvalSeq) as Promise<MailState | null>;
  },
  async mailQuickDecline(approvalSeq: number): Promise<MailState | null> {
    return ipcRenderer.invoke('mail:quickDecline', approvalSeq) as Promise<MailState | null>;
  },
  async mailRefresh(): Promise<MailState | null> {
    return ipcRenderer.invoke('mail:refresh') as Promise<MailState | null>;
  },
  // ── Limits / Cost ─────────────────────────────────────────────────────────
  onLimitsCostState(listener: (state: LimitsCostState) => void) {
    const handler = (_event: Electron.IpcRendererEvent, state: LimitsCostState): void =>
      listener(state);
    ipcRenderer.on('limitsCost:state', handler);
    return () => ipcRenderer.removeListener('limitsCost:state', handler);
  },
  async refreshLimitsCost(): Promise<LimitsCostState | null> {
    return ipcRenderer.invoke('limitsCost:refresh') as Promise<LimitsCostState | null>;
  },
};

contextBridge.exposeInMainWorld('coShell', bridge);
