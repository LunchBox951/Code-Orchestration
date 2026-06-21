type NavView = 'dashboard' | 'agents' | 'mail' | 'review' | 'source' | 'usage' | 'settings';
type NavState = { readonly activeView: NavView };
type ProjectInfo = { id: string };
type ConnectionState = unknown;
type DashboardState = unknown;
type LimitsCostState = unknown;
type MailState = unknown;
type AgentsConsoleState = unknown;
type Steer = { kind: 'answer' | 'redirect'; text: string } | { kind: 'interrupt' };

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

type ReviewState = unknown;
type SettingsState = unknown;
type SettingsLayer = 'global' | 'project';
type SettingWriteResult = { ok: boolean; error?: string };
type SourceState = unknown;
type DaemonStatus = 'starting' | 'healthy' | 'restarting' | 'failed' | 'stopped';
type DaemonStatusPayload = { status: DaemonStatus; detail: string | null };
type CurrentProjectState = { projectId: string; path: string | null } | null;

interface CoShellBridge {
  navigate(view: NavView): void;
  projectInfo(): Promise<ProjectInfo | null>;
  refreshConnection(): Promise<ConnectionState | null>;
  onNavState(listener: (state: NavState) => void): () => void;
  onConnectionState(listener: (state: ConnectionState) => void): () => void;
  onConnectionError(listener: (message: string) => void): () => void;
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
  // ── Agents Console ────────────────────────────────────────────────────────
  onAgentsConsoleState(listener: (state: AgentsConsoleState) => void): () => void;
  agentsSelect(agentId: string | null): Promise<AgentsConsoleState | null>;
  agentsSteer(agentId: string, steer: Steer): Promise<{ ok: boolean; error?: string }>;
  agentsSendInput(agentId: string, data: string): Promise<{ ok: boolean; error?: string }>;
  agentsResize(
    agentId: string,
    cols: number,
    rows: number,
  ): Promise<{ ok: boolean; error?: string }>;
  agentsStop(agentId: string): Promise<{ ok: boolean; error?: string }>;
  agentsUnstick(agentId: string): Promise<{ ok: boolean; error?: string }>;
  // ── Review ────────────────────────────────────────────────────────────────
  onReviewState(listener: (state: ReviewState) => void): () => void;
  onReviewError(listener: (message: string) => void): () => void;
  reviewSelect(reviewId: string): Promise<ReviewState | null>;
  reviewBeginVerdict(verdict: 'PASS' | 'ISSUES'): Promise<ReviewState | null>;
  reviewUpdateComposerBody(text: string): Promise<ReviewState | null>;
  reviewCancelVerdict(): Promise<ReviewState | null>;
  reviewSubmitVerdict(): Promise<ReviewState | null>;
  reviewRefresh(): Promise<ReviewState | null>;
  // ── Settings ────────────────────────────────────────────────────────────────
  onSettingsState(listener: (state: SettingsState) => void): () => void;
  settingsGetState(): Promise<SettingsState | null>;
  settingsSet(layer: SettingsLayer, key: string, value: unknown): Promise<SettingWriteResult>;
  settingsClear(layer: SettingsLayer, key: string): Promise<{ ok: boolean }>;
  settingsSetLayer(layer: SettingsLayer): Promise<SettingsState | null>;
  // ── Session ───────────────────────────────────────────────────────────────
  sessionStart(
    prompt: string | null,
    specBody: string | null,
  ): Promise<{ ok: boolean; error?: string }>;
  sessionStartFromDemoSpec(): Promise<{ ok: boolean; error?: string }>;
  // ── Project + Daemon on-ramp ────────────────────────────────────────────────
  openProject(): Promise<void>;
  daemonRetry(): Promise<{ ok: boolean; error?: string }>;
  onDaemonStatus(listener: (payload: DaemonStatusPayload) => void): () => void;
  onCurrentProject(listener: (state: CurrentProjectState) => void): () => void;
  onAppError(listener: (message: string) => void): () => void;
  // ── Source ──────────────────────────────────────────────────────────────────
  refreshSource(): Promise<SourceState | null>;
}

const bridge: CoShellBridge = {
  navigate(view: NavView) {
    void ipcRenderer.invoke('nav:navigate', view);
  },
  async projectInfo(): Promise<ProjectInfo | null> {
    return ipcRenderer.invoke<ProjectInfo | null>('project:info');
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
  onConnectionError(listener: (message: string) => void) {
    const handler = (_event: unknown, message: string): void => listener(message);
    ipcRenderer.on('connection:error', handler);
    return () => ipcRenderer.removeListener('connection:error', handler);
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
  // ── Agents Console ────────────────────────────────────────────────────────
  onAgentsConsoleState(listener: (state: AgentsConsoleState) => void) {
    const handler = (_event: unknown, state: AgentsConsoleState): void => listener(state);
    ipcRenderer.on('agentsConsole:state', handler);
    return () => ipcRenderer.removeListener('agentsConsole:state', handler);
  },
  async agentsSelect(agentId: string | null): Promise<AgentsConsoleState | null> {
    return ipcRenderer.invoke<AgentsConsoleState | null>('agents:select', agentId);
  },
  async agentsSteer(agentId: string, steer: Steer): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke<{ ok: boolean; error?: string }>('agents:steer', agentId, steer);
  },
  async agentsSendInput(agentId: string, data: string): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke<{ ok: boolean; error?: string }>('agents:input', agentId, data);
  },
  async agentsResize(
    agentId: string,
    cols: number,
    rows: number,
  ): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke<{ ok: boolean; error?: string }>(
      'agents:resize',
      agentId,
      cols,
      rows,
    );
  },
  async agentsStop(agentId: string): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke<{ ok: boolean; error?: string }>('agent:stop', agentId);
  },
  async agentsUnstick(agentId: string): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke<{ ok: boolean; error?: string }>('agent:unstick', agentId);
  },
  // ── Review ────────────────────────────────────────────────────────────────
  onReviewState(listener: (state: ReviewState) => void) {
    const handler = (_event: unknown, state: ReviewState): void => listener(state);
    ipcRenderer.on('review:state', handler);
    return () => ipcRenderer.removeListener('review:state', handler);
  },
  onReviewError(listener: (message: string) => void) {
    const handler = (_event: unknown, message: string): void => listener(message);
    ipcRenderer.on('review:error', handler);
    return () => ipcRenderer.removeListener('review:error', handler);
  },
  async reviewSelect(reviewId: string): Promise<ReviewState | null> {
    return ipcRenderer.invoke<ReviewState | null>('review:select', reviewId);
  },
  async reviewBeginVerdict(verdict: 'PASS' | 'ISSUES'): Promise<ReviewState | null> {
    return ipcRenderer.invoke<ReviewState | null>('review:beginVerdict', verdict);
  },
  async reviewUpdateComposerBody(text: string): Promise<ReviewState | null> {
    return ipcRenderer.invoke<ReviewState | null>('review:updateComposerBody', text);
  },
  async reviewCancelVerdict(): Promise<ReviewState | null> {
    return ipcRenderer.invoke<ReviewState | null>('review:cancelVerdict');
  },
  async reviewSubmitVerdict(): Promise<ReviewState | null> {
    return ipcRenderer.invoke<ReviewState | null>('review:submitVerdict');
  },
  async reviewRefresh(): Promise<ReviewState | null> {
    return ipcRenderer.invoke<ReviewState | null>('review:refresh');
  },
  // ── Settings ────────────────────────────────────────────────────────────────
  onSettingsState(listener: (state: SettingsState) => void) {
    const handler = (_event: unknown, state: SettingsState): void => listener(state);
    ipcRenderer.on('settings:state', handler);
    return () => ipcRenderer.removeListener('settings:state', handler);
  },
  async settingsGetState(): Promise<SettingsState | null> {
    return ipcRenderer.invoke<SettingsState | null>('settings:getState');
  },
  async settingsSet(
    layer: SettingsLayer,
    key: string,
    value: unknown,
  ): Promise<SettingWriteResult> {
    return ipcRenderer.invoke<SettingWriteResult>('settings:set', { layer, key, value });
  },
  async settingsClear(layer: SettingsLayer, key: string): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke<{ ok: boolean }>('settings:clear', { layer, key });
  },
  async settingsSetLayer(layer: SettingsLayer): Promise<SettingsState | null> {
    return ipcRenderer.invoke<SettingsState | null>('settings:setLayer', layer);
  },
  // ── Session ───────────────────────────────────────────────────────────────
  async sessionStart(
    prompt: string | null,
    specBody: string | null,
  ): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke<{ ok: boolean; error?: string }>('session:start', prompt, specBody);
  },
  async sessionStartFromDemoSpec(): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke<{ ok: boolean; error?: string }>('session:startFromDemoSpec');
  },
  // ── Project + Daemon on-ramp ────────────────────────────────────────────────
  async openProject(): Promise<void> {
    await ipcRenderer.invoke('project:open');
  },
  async daemonRetry(): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke<{ ok: boolean; error?: string }>('daemon:retry');
  },
  onDaemonStatus(listener: (payload: DaemonStatusPayload) => void) {
    const handler = (_event: unknown, payload: DaemonStatusPayload): void => listener(payload);
    ipcRenderer.on('daemon:status', handler);
    return () => ipcRenderer.removeListener('daemon:status', handler);
  },
  onCurrentProject(listener: (state: CurrentProjectState) => void) {
    const handler = (_event: unknown, state: CurrentProjectState): void => listener(state);
    ipcRenderer.on('project:current', handler);
    return () => ipcRenderer.removeListener('project:current', handler);
  },
  onAppError(listener: (message: string) => void) {
    const handler = (_event: unknown, message: string): void => listener(message);
    ipcRenderer.on('app:error', handler);
    return () => ipcRenderer.removeListener('app:error', handler);
  },
  // ── Source ──────────────────────────────────────────────────────────────────
  async refreshSource(): Promise<SourceState | null> {
    return ipcRenderer.invoke<SourceState | null>('source:refresh');
  },
};

contextBridge.exposeInMainWorld('coShell', bridge);
