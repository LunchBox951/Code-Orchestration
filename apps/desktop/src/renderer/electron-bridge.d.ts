// Renderer-side type declarations for the contextBridge surface exposed by preload.ts.
// Declared inline (no Node/shared imports) because the renderer is isolated from Node context.

type NavView = 'dashboard' | 'agents' | 'mail' | 'review' | 'source' | 'cost';
type ConnectionStatus = 'connecting' | 'live' | 'degraded';
type AgentStatus = 'warm' | 'waiting' | 'stuck' | 'paused' | 'unknown';

interface ConnectionState {
  status: ConnectionStatus;
  observation: unknown;
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

interface CoShellBridge {
  navigate(view: NavView): void;
  refreshConnection(): Promise<ConnectionState | null>;
  onNavState(listener: (state: { activeView: NavView }) => void): () => void;
  onConnectionState(listener: (state: ConnectionState) => void): () => void;
  onDashboardState(listener: (state: DashboardState) => void): () => void;
  refreshDashboard(): Promise<DashboardState | null>;
}

interface Window {
  coShell: CoShellBridge;
}
