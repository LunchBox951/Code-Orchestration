type NavView = 'dashboard' | 'agents' | 'mail' | 'review' | 'source' | 'cost';
type NavState = { readonly activeView: NavView };
type ConnectionState = unknown;
type DashboardState = unknown;
type LimitsCostState = unknown;
type MailState = unknown;

interface ContextBridgeLike {
  exposeInMainWorld(key: string, api: unknown): void;
}

interface IpcRendererLike {
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  on<T>(channel: string, listener: (event: unknown, payload: T) => void): void;
  removeListener<T>(channel: string, listener: (event: unknown, payload: T) => void): void;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports -- Electron sandboxed preloads run as CJS, not ESM.
const { contextBridge, ipcRenderer } = require('electron') as {
  readonly contextBridge: ContextBridgeLike;
  readonly ipcRenderer: IpcRendererLike;
};

interface CoShellBridge {
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
  mailApproveWithComposer(approvalSeq: number): Promise<MailState | null>;
  mailDeclineWithComposer(approvalSeq: number): Promise<MailState | null>;
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
    return ipcRenderer.invoke<ConnectionState | null>('connection:refresh');
  },
  onNavState(listener: (state: NavState) => void) {
    const handler = (_event: unknown, state: NavState): void => listener(state);
    ipcRenderer.on('nav:state', handler);
    return () => ipcRenderer.removeListener('nav:state', handler);
  },
  onConnectionState(listener: (state: ConnectionState) => void) {
    const handler = (_event: unknown, state: ConnectionState): void => listener(state);
    ipcRenderer.on('connection:state', handler);
    return () => ipcRenderer.removeListener('connection:state', handler);
  },
  onDashboardState(listener: (state: DashboardState) => void) {
    const handler = (_event: unknown, state: DashboardState): void => listener(state);
    ipcRenderer.on('dashboard:state', handler);
    return () => ipcRenderer.removeListener('dashboard:state', handler);
  },
  async refreshDashboard(): Promise<DashboardState | null> {
    return ipcRenderer.invoke<DashboardState | null>('dashboard:refresh');
  },
  // ── Mail ──────────────────────────────────────────────────────────────────
  onMailState(listener: (state: MailState) => void) {
    const handler = (_event: unknown, state: MailState): void => listener(state);
    ipcRenderer.on('mail:state', handler);
    return () => ipcRenderer.removeListener('mail:state', handler);
  },
  onMailError(listener: (message: string) => void) {
    const handler = (_event: unknown, message: string): void => listener(message);
    ipcRenderer.on('mail:error', handler);
    return () => ipcRenderer.removeListener('mail:error', handler);
  },
  async mailSelectBus(busId: string): Promise<MailState | null> {
    return ipcRenderer.invoke<MailState | null>('mail:selectBus', busId);
  },
  async mailSelectTab(tab: 'inbox' | 'outbox'): Promise<MailState | null> {
    return ipcRenderer.invoke<MailState | null>('mail:selectTab', tab);
  },
  async mailSelect(seq: number): Promise<MailState | null> {
    return ipcRenderer.invoke<MailState | null>('mail:select', seq);
  },
  async mailOpenComposer(
    targetSeq: number,
    targetRecipient: string,
    replyType: string,
    subject: string,
  ): Promise<MailState | null> {
    return ipcRenderer.invoke<MailState | null>(
      'mail:openComposer',
      targetSeq,
      targetRecipient,
      replyType,
      subject,
    );
  },
  async mailUpdateComposer(
    field: 'type' | 'subject' | 'body',
    value: string,
  ): Promise<MailState | null> {
    return ipcRenderer.invoke<MailState | null>('mail:updateComposer', field, value);
  },
  async mailCloseComposer(): Promise<MailState | null> {
    return ipcRenderer.invoke<MailState | null>('mail:closeComposer');
  },
  async mailSubmitReply(): Promise<MailState | null> {
    return ipcRenderer.invoke<MailState | null>('mail:submitReply');
  },
  async mailQuickApprove(approvalSeq: number): Promise<MailState | null> {
    return ipcRenderer.invoke<MailState | null>('mail:quickApprove', approvalSeq);
  },
  async mailQuickDecline(approvalSeq: number): Promise<MailState | null> {
    return ipcRenderer.invoke<MailState | null>('mail:quickDecline', approvalSeq);
  },
  async mailApproveWithComposer(approvalSeq: number): Promise<MailState | null> {
    return ipcRenderer.invoke<MailState | null>('mail:approveWithComposer', approvalSeq);
  },
  async mailDeclineWithComposer(approvalSeq: number): Promise<MailState | null> {
    return ipcRenderer.invoke<MailState | null>('mail:declineWithComposer', approvalSeq);
  },
  async mailRefresh(): Promise<MailState | null> {
    return ipcRenderer.invoke<MailState | null>('mail:refresh');
  },
  // ── Limits / Cost ─────────────────────────────────────────────────────────
  onLimitsCostState(listener: (state: LimitsCostState) => void) {
    const handler = (_event: unknown, state: LimitsCostState): void => listener(state);
    ipcRenderer.on('limitsCost:state', handler);
    return () => ipcRenderer.removeListener('limitsCost:state', handler);
  },
  async refreshLimitsCost(): Promise<LimitsCostState | null> {
    return ipcRenderer.invoke<LimitsCostState | null>('limitsCost:refresh');
  },
};

contextBridge.exposeInMainWorld('coShell', bridge);
