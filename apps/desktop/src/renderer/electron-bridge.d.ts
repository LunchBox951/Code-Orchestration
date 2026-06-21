// Renderer-side type declarations for the contextBridge surface exposed by preload.cts.
// Declared inline (no Node/shared imports) because the renderer is isolated from Node context.

type NavView = 'dashboard' | 'agents' | 'mail' | 'review' | 'source' | 'usage' | 'settings';
type ConnectionStatus = 'connecting' | 'live' | 'degraded';

interface ProjectInfo {
  id: string;
}
type AgentStatus = 'warm' | 'waiting' | 'stuck' | 'paused' | 'unknown';

interface ConnectionObservation {
  kind: 'live' | 'static';
  snapshot: unknown;
}

interface ConnectionState {
  status: ConnectionStatus;
  observation: ConnectionObservation | null;
}

interface TreeNode {
  agentId: string;
  role: string;
  subRole?: string;
  parent: string;
  status: AgentStatus;
  children: readonly TreeNode[];
}

interface FleetStats {
  total: number;
  warm: number;
  waiting: number;
  stuck: number;
  paused: number;
}

interface ActionableRow {
  seq: number;
  type: string;
  subject: string;
  sender: string;
  ts: number;
}

interface DashboardState {
  tree: readonly TreeNode[];
  stats: FleetStats;
  actionables: readonly ActionableRow[];
  connection: 'live' | 'degraded';
}

type MailKind = 'actionable' | 'informational';

interface MailRow {
  seq: number;
  type: string;
  subject: string;
  sender: string;
  recipient: string;
  ts: number;
  renderedBody: string;
  kind: MailKind;
  read: boolean;
  resolved: boolean;
  idempotencyKey?: string;
  decision?: string;
  reviewVerdict?: string;
}

interface ComposerState {
  active: boolean;
  targetSeq: number | null;
  targetRecipient: string | null;
  type: string;
  subject: string;
  body: string;
  pending: boolean;
  idempotencyKey: string | null;
}

interface MailState {
  activeBus: string;
  tab: 'inbox' | 'outbox';
  inbox: readonly MailRow[];
  outbox: readonly MailRow[];
  selected: MailRow | null;
  composer: ComposerState;
}

// ── Agents Console (inline — renderer is isolated from Node context) ──────────

interface AgentConsoleRow {
  agentId: string;
  role: string;
  parent: string;
  status: AgentStatus;
}

interface AgentsConsoleState {
  roster: readonly AgentConsoleRow[];
  selectedAgentId: string | null;
  selectedStatus: AgentStatus | null;
  transcript: string;
  connection: 'live' | 'degraded';
}

type Steer = { kind: 'answer' | 'redirect'; text: string } | { kind: 'interrupt' };

interface XtermTerminal {
  open(el: HTMLElement): void;
  write(data: string): void;
  reset(): void;
  clear(): void;
  dispose(): void;
  // Load an xterm addon (e.g. the fit addon) — `unknown` keeps the renderer free of an xterm type import.
  loadAddon(addon: unknown): void;
  // Interactive stdin: fires for every keystroke/paste chunk the operator types into the pane.
  onData(cb: (data: string) => void): void;
  // The fitted grid dimensions (read AFTER fit) — drive PTY.resize(cols, rows) for width-agreement.
  readonly cols: number;
  readonly rows: number;
}

// The vendored `@xterm/addon-fit` UMD build assigns `globalThis.FitAddon = { FitAddon: <constructor> }`.
interface XtermFitAddon {
  fit(): void;
  activate(terminal: unknown): void;
  dispose(): void;
}

interface XtermFitAddonModule {
  FitAddon: new () => XtermFitAddon;
}

// ── Review (inline — renderer is isolated from Node context) ─────────────────

interface ReviewRow {
  reviewId: string;
  seq: number;
  sender: string;
  subject: string;
  ts: number;
}

type SelectedContext = { status: 'loading' } | { status: 'loaded'; value: ReviewContext } | null;

interface VerdictComposer {
  active: boolean;
  verdict: 'PASS' | 'ISSUES';
  body: string;
  pending: boolean;
}

interface ReviewState {
  pending: readonly ReviewRow[];
  selectedReviewId: string | null;
  context: SelectedContext;
  composer: VerdictComposer;
}

type ReviewDiff =
  | { kind: 'patch'; patch: string }
  | { kind: 'unavailable'; reason: 'worktree-missing' | 'git-failed' };

interface ReviewCriterion {
  text: string;
  verify?: string;
}

type ReviewCriteria =
  | { kind: 'criteria'; specRef: string; criteria: readonly ReviewCriterion[] }
  | { kind: 'no-locked-spec' };

type ReviewContext =
  | {
      kind: 'resolved';
      reviewId: string;
      evidenceFingerprint: string;
      branch: string;
      target: string;
      scope: string;
      diff: ReviewDiff;
      criteria: ReviewCriteria;
    }
  | { kind: 'not-found'; reviewId: string }
  | { kind: 'conductor-down'; reviewId: string };

// ── Limits / Cost (inline — renderer is isolated from Node context) ──────────

interface LimitsCostHeadroom {
  kind: 'known';
  used_pct: number;
  reset_at: string;
}

interface LimitsCostHeadroomUnknown {
  kind: 'unknown';
  reason: string;
}

interface LimitsCostHeadroomRow {
  provider: string;
  account: string;
  windowKind: string;
  headroom: LimitsCostHeadroom | LimitsCostHeadroomUnknown;
}

interface LimitsCostCostRow {
  id: string;
  totalCostUsd: number;
}

interface LimitsCostState {
  headroomRows: readonly LimitsCostHeadroomRow[];
  agentCosts: readonly LimitsCostCostRow[];
  taskCosts: readonly LimitsCostCostRow[];
}

// ── Source / Daemon / Project on-ramp (inline — renderer is isolated from Node context) ──────

interface BranchCommit {
  sha: string;
  subject: string;
  committedAt?: string;
  author?: string;
}

interface BranchInfo {
  name: string;
  isCurrent: boolean;
  upstream?: string;
  lastCommit: BranchCommit;
}

interface PullRequestInfo {
  number: number;
  ref: string;
  source: string;
  lastCommit: BranchCommit;
}

type SourceState =
  | { kind: 'source'; branches: readonly BranchInfo[]; pullRequests: readonly PullRequestInfo[] }
  | { kind: 'no-project' }
  | { kind: 'path-missing'; projectId: string; message: string }
  | { kind: 'error'; message: string };

type DaemonStatus = 'starting' | 'healthy' | 'restarting' | 'failed' | 'stopped';

interface DaemonStatusPayload {
  status: DaemonStatus;
  detail: string | null;
}

type CurrentProjectState = { projectId: string; path: string | null } | null;

// ── Settings (inline mirror of @co/core SettingDescriptor + shared SettingsVM types) ──────────
type SettingsLayer = 'global' | 'project';
type SettingSource = 'override' | 'inherited' | 'default';

type SettingControl =
  | { kind: 'toggle' }
  | { kind: 'integer'; min: number; max?: number; unit?: string }
  | { kind: 'enum'; options: readonly { value: string; label: string }[]; clearable?: boolean }
  | { kind: 'persona' }
  | { kind: 'provider-set'; providers: readonly string[] }
  | {
      kind: 'model-tier';
      provider: 'claude' | 'codex';
      tiers: readonly { key: string; label: string }[];
      suggestions: readonly string[];
    };

interface SettingDescriptor {
  key: string;
  section: string;
  label: string;
  description: string;
  control: SettingControl;
  defaultValue: unknown;
  perProject: boolean;
  primaryLayer: SettingsLayer;
  dependsOn?: { key: string; equals: string | number | boolean | null };
}

interface SettingsRow {
  descriptor: SettingDescriptor;
  effectiveValue: unknown;
  source: SettingSource;
  canReset: boolean;
  disabledReason: string | null;
}

interface SettingsState {
  activeLayer: SettingsLayer;
  projectId: string | null;
  hasProject: boolean;
  rows: readonly SettingsRow[];
}

type SettingWriteResult = { ok: boolean; error?: string };

interface CoShellBridge {
  navigate(view: NavView): void;
  projectInfo(): Promise<ProjectInfo | null>;
  refreshConnection(): Promise<ConnectionState | null>;
  onNavState(listener: (state: { activeView: NavView }) => void): () => void;
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
  settingsClear(layer: SettingsLayer, key: string): Promise<SettingWriteResult>;
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

interface Window {
  coShell: CoShellBridge;
  Terminal: new (opts?: unknown) => XtermTerminal;
  FitAddon: XtermFitAddonModule;
}
