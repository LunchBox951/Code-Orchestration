// Renderer-side type declarations for the contextBridge surface exposed by preload.ts.
// Declared inline (no Node/shared imports) because the renderer is isolated from Node context.

type NavView = 'dashboard' | 'agents' | 'mail' | 'review' | 'source' | 'cost';
type ConnectionStatus = 'connecting' | 'live' | 'degraded';
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
}

interface MailState {
  activeBus: string;
  tab: 'inbox' | 'outbox';
  inbox: readonly MailRow[];
  outbox: readonly MailRow[];
  selected: MailRow | null;
  composer: ComposerState;
}

interface CoShellBridge {
  navigate(view: NavView): void;
  refreshConnection(): Promise<ConnectionState | null>;
  onNavState(listener: (state: { activeView: NavView }) => void): () => void;
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
}

interface Window {
  coShell: CoShellBridge;
}
