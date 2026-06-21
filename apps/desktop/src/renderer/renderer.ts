// Renderer entry — the operator-facing Cockpit. Vanilla DOM, no framework.
// Ports the "co Cockpit" design handoff (dark IBM-Plex mission-control system)
// onto live @co/core state delivered over the coShell bridge (preload contextBridge).
//
// Mock data and the demo phase-stepper from the reference are intentionally dropped:
// every surface derives from real registry/daemon/agent-tree/mail/usage signals, and
// renders honest empty states where live data does not exist yet (Principle: empty
// states are first-class — never fake data).

import { mailDetailNeedsRebuild, mailDetailSignature } from './mail-render-helpers.js';
import { applyTermFeed, createAgentsTerminal, decideTermFeed } from './agents-terminal-helpers.js';
import { reviewDetailNeedsRebuild, reviewDetailSignature } from './review-render-helpers.js';

const NAV_VIEWS = ['dashboard', 'agents', 'mail', 'review', 'source', 'usage', 'settings'] as const;
type LocalNavView = (typeof NAV_VIEWS)[number];

function isNavView(v: unknown): v is LocalNavView {
  return typeof v === 'string' && (NAV_VIEWS as ReadonlyArray<string>).includes(v);
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Design system (mirrors the handoff tokens) ──────────────────────────────────

const ROLE_COLORS: Record<string, string> = {
  coordinator: 'var(--role-coordinator)',
  lead: 'var(--role-lead)',
  implementer: 'var(--role-implementer)',
  reviewer: 'var(--role-reviewer)',
  researcher: 'var(--role-researcher)',
};

function roleColor(role: string): string {
  return ROLE_COLORS[role.toLowerCase()] ?? 'oklch(0.7 0.02 262)';
}

function tint(color: string, pct: string): string {
  return `color-mix(in oklch, ${color} ${pct}, transparent)`;
}

interface StatusMeta {
  color: string;
  label: string;
  pulse: boolean;
}

function statusMeta(status: AgentStatus): StatusMeta {
  switch (status) {
    case 'warm':
      return { color: 'var(--st-running)', label: 'WARM', pulse: true };
    case 'waiting':
      return { color: 'var(--st-waiting)', label: 'WAITING', pulse: false };
    case 'stopped':
      return { color: 'var(--st-stopped)', label: 'STOPPED', pulse: false };
    case 'stuck':
      return { color: 'var(--st-stuck)', label: 'STUCK', pulse: false };
    case 'paused':
      return { color: 'var(--st-paused)', label: 'PAUSED', pulse: false };
    default:
      return { color: 'var(--st-unknown)', label: 'UNKNOWN', pulse: false };
  }
}

// Typed-mail color language (matches the handoff's typeStyle map).
function mailTypeColor(type: string): string {
  const map: Record<string, string> = {
    approval: 'oklch(0.81 0.13 80)',
    clarify_request: 'oklch(0.79 0.12 200)',
    kickoff: 'oklch(0.75 0.14 300)',
    escalation: 'oklch(0.72 0.18 35)',
    review_verdict: 'oklch(0.78 0.14 150)',
    review_response: 'oklch(0.78 0.14 150)',
    review_request: 'oklch(0.71 0.14 255)',
    worker_done: 'oklch(0.69 0.1 255)',
    operator_message: 'oklch(0.74 0.1 300)',
  };
  return map[type] ?? 'oklch(0.7 0.02 262)';
}

function roleInitials(name: string): string {
  const trimmed = name.replace(/^@/, '');
  return trimmed.slice(0, 2).toUpperCase();
}

// ── Shared state holders ────────────────────────────────────────────────────────

let latestConnection: ConnectionState | null = null;
let latestDashboard: DashboardState | null = null;
let latestMailState: MailState | null = null;
let latestAgentsState: AgentsConsoleState | null = null;
let latestReviewState: ReviewState | null = null;
let latestLimitsState: LimitsCostState | null = null;
let latestSettingsState: SettingsState | null = null;
let projectInfo: { id: string; name: string; branch?: string } | null = null;
let sourceTab: 'branches' | 'prs' | 'commits' = 'branches';
// The app-supervised Conductor daemon's lifecycle status (P-ON1), pushed over `daemon:status`. Drives
// the header daemon pill independently of the operator-IPC connection's live/offline state.
let latestDaemon: DaemonStatusPayload | null = null;
// The latest read-only Source view state (P-ON4) from `source:refresh` — real branches/PR refs or a
// named empty/error state. `null` until the first fetch resolves.
let latestSource: SourceState | null = null;
let sourceRefreshGeneration = 0;
let reviewInvokeGeneration = 0;
// The agentId of a Delete button currently in the pending-confirm state (two-step confirm).
let pendingDeleteId: string | null = null;
// The archive id of a Purge button currently in the pending-confirm state (two-step confirm).
let pendingArchivePurgeId: string | null = null;
// Re-wake inline composer state. Kept outside the DOM so live roster rerenders preserve draft text.
let activeRewakeAgentId: string | null = null;
let activeRewakeDraft = '';
// The latest archive list from archive:list — refreshed on every dashboard push. Empty until the
// first fetch resolves; the main process can read static archive records when the daemon is down.
let latestArchive: readonly ArchiveEntry[] = [];
let archiveRefreshGeneration = 0;

const OPERATOR_BUS = '@operator';

const EMPTY_LIMITS_STATE: LimitsCostState = { headroomRows: [], agentCosts: [], taskCosts: [] };
const EMPTY_MAIL_STATE: MailState = {
  activeBus: OPERATOR_BUS,
  tab: 'inbox',
  inbox: [],
  outbox: [],
  selected: null,
  composer: {
    active: false,
    targetSeq: null,
    targetRecipient: null,
    type: 'clarify_response',
    subject: '',
    body: '',
    pending: false,
    idempotencyKey: null,
  },
};
const EMPTY_AGENTS_STATE: AgentsConsoleState = {
  roster: [],
  selectedAgentId: null,
  selectedStatus: null,
  transcript: '',
  connection: 'degraded',
};
const EMPTY_REVIEW_STATE: ReviewState = {
  pending: [],
  selectedReviewId: null,
  context: null,
  composer: { active: false, verdict: 'PASS', body: '', pending: false },
};
const knownMailBuses = new Set<string>([OPERATOR_BUS]);

function agentDisplayName(agent: { agentId: string; name?: string | null }): string {
  const name = agent.name?.trim();
  return name != null && name.length > 0 ? name : agent.agentId;
}

function agentAccessibleName(agent: { agentId: string; name?: string | null }): string {
  const name = agentDisplayName(agent);
  return name === agent.agentId ? name : `${name} (${agent.agentId})`;
}

function collectAgentIds(nodes: readonly TreeNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    out.push(node.agentId);
    collectAgentIds(node.children, out);
  }
  return out;
}

// ── Cleared agents — declutter the viewport of idle, finished agents (e.g. accumulated host-proof
// coordinators). VIEW-only: persisted in localStorage, never touches the roster/conductor, so nothing
// is lost. A cleared agent that becomes active or explicitly operator-suppressed again is auto-restored.
const DISMISSED_AGENTS_KEY = 'co.dismissedAgents';

function loadDismissedAgents(): Set<string> {
  try {
    const raw = window.localStorage.getItem(DISMISSED_AGENTS_KEY);
    const parsed: unknown = raw != null ? JSON.parse(raw) : [];
    return new Set(
      Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [],
    );
  } catch {
    return new Set();
  }
}

const dismissedAgents = loadDismissedAgents();

function persistDismissedAgents(): void {
  try {
    window.localStorage.setItem(DISMISSED_AGENTS_KEY, JSON.stringify([...dismissedAgents]));
  } catch {
    /* localStorage unavailable — in-memory dismissal still declutters this session. */
  }
}

/** True iff this node or any descendant is still relevant — such a subtree is never hidden. */
function subtreeActive(node: TreeNode): boolean {
  return (
    node.status === 'warm' ||
    node.status === 'waiting' ||
    node.status === 'stopped' ||
    node.status === 'stuck' ||
    node.status === 'paused' ||
    node.children.some(subtreeActive)
  );
}

function countSubtree(nodes: readonly TreeNode[]): number {
  return nodes.reduce((n, c) => n + 1 + countSubtree(c.children), 0);
}

/**
 * Filter cleared agents out of the tree for display. A cleared node is dropped only if its whole
 * subtree is idle; a cleared node that became active again is auto-restored. Returns the visible tree
 * and the count of agents hidden.
 */
function pruneDismissedAgents(nodes: readonly TreeNode[]): { tree: TreeNode[]; hidden: number } {
  let hidden = 0;
  const tree: TreeNode[] = [];
  for (const node of nodes) {
    if (dismissedAgents.has(node.agentId)) {
      if (subtreeActive(node)) {
        dismissedAgents.delete(node.agentId); // re-activated → restore
      } else {
        hidden += 1 + countSubtree(node.children);
        continue;
      }
    }
    const childResult = pruneDismissedAgents(node.children);
    hidden += childResult.hidden;
    tree.push({ ...node, children: childResult.tree });
  }
  return { tree, hidden };
}

/** Agent ids eligible to be cleared now: a fully idle subtree not already cleared. */
function clearableAgentIds(nodes: readonly TreeNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    if (!subtreeActive(node)) {
      if (!dismissedAgents.has(node.agentId)) out.push(node.agentId);
    } else {
      clearableAgentIds(node.children, out);
    }
  }
  return out;
}

function rememberMailBuses(state: DashboardState): void {
  knownMailBuses.clear();
  knownMailBuses.add(OPERATOR_BUS);
  for (const agentId of collectAgentIds(state.tree)) knownMailBuses.add(agentId);
}

// All operator replies to actionable mail normalize to the structured clarify_response
// envelope (free-text is allowed but typed on the bus — Principle 3, render-per-audience).
const REPLY_TYPE = 'clarify_response';

// ── Phase derivation (registry/daemon/agent-tree, not a hardcoded stepper) ───────

type Phase = 'empty' | 'opened' | 'coord' | 'fleet';

function connectionStatus(): ConnectionStatus {
  return latestConnection?.status ?? 'connecting';
}

function derivePhase(): Phase {
  const dash = latestDashboard;
  const status = connectionStatus();
  if (dash == null) return status === 'live' ? 'opened' : 'empty';
  const total = dash.stats.total;
  if (total === 0) return status === 'live' ? 'opened' : 'empty';
  if (total === 1) {
    const root = dash.tree[0];
    if (root != null && root.role.toLowerCase() === 'coordinator' && root.children.length === 0) {
      return 'coord';
    }
  }
  return 'fleet';
}

interface CoordinatorPhaseCopy {
  title: string;
  body: string;
  subline: string;
  pulse: boolean;
}

function coordinatorPhaseCopy(status: AgentStatus): CoordinatorPhaseCopy {
  switch (status) {
    case 'warm':
      return {
        title: 'Coordinator session is live',
        body:
          'The root coordinator is reading the handoff and may be waiting on operator approval; ' +
          'it fans out after you lock the spec with `co spec lock`.',
        subline: 'Conductor driving 1 agent · coordinator session live',
        pulse: true,
      };
    case 'waiting':
      return {
        title: 'Coordinator waiting',
        body: 'The root coordinator has queued work and will run on the next eligible Conductor tick.',
        subline: '1 coordinator registered · waiting',
        pulse: false,
      };
    case 'stopped':
      return {
        title: 'Coordinator stopped',
        body: 'The root coordinator is stopped and requires re-wake before the Conductor will select it again.',
        subline: '1 coordinator registered · stopped · requires re-wake',
        pulse: false,
      };
    case 'stuck':
      return {
        title: 'Coordinator stuck',
        body: 'The root coordinator needs operator attention before the Conductor will select it again.',
        subline: '1 coordinator registered · stuck · needs decision',
        pulse: false,
      };
    case 'paused':
      return {
        title: 'Coordinator paused',
        body: 'The root coordinator is paused. Resume it or send a re-wake when it should continue.',
        subline: '1 coordinator registered · paused',
        pulse: false,
      };
    case 'unknown':
      return {
        title: 'Coordinator not running',
        body: 'The root coordinator is registered, but the Conductor has no live status for it yet.',
        subline: '1 coordinator registered · status unknown',
        pulse: false,
      };
  }
}

// ── Navigation ──────────────────────────────────────────────────────────────────

function activateView(view: LocalNavView): void {
  for (const el of document.querySelectorAll('.nav-item')) {
    el.classList.toggle('active', el.getAttribute('data-view') === view);
  }
  for (const el of document.querySelectorAll('.view')) {
    el.classList.toggle('active', el.id === `view-${view}`);
  }
  if (view === 'agents' && latestAgentsState != null) renderAgentsTranscript(latestAgentsState);
  if (view === 'review' && latestReviewState != null) renderReview(latestReviewState);
  if (view === 'settings' && latestSettingsState != null) renderSettings(latestSettingsState);
}

function setNavEnabled(enabled: boolean): void {
  for (const el of document.querySelectorAll<HTMLElement>('.nav-item')) {
    el.classList.toggle('disabled', !enabled && el.getAttribute('data-view') !== 'dashboard');
  }
}

function setBadge(id: string, count: number): void {
  const el = document.getElementById(id);
  if (!el) return;
  if (count > 0) {
    el.textContent = String(count);
    el.classList.add('show');
  } else {
    el.classList.remove('show');
  }
}

function showAppError(message: string): void {
  const toast = document.createElement('div');
  toast.className = 'app-error-toast';
  toast.textContent = message;
  document.body.append(toast);
  setTimeout(() => toast.remove(), 7000);
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function flashToast(message: string): void {
  const existing = document.getElementById('co-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.id = 'co-toast';
  toast.innerHTML = `<span class="dot"></span>${esc(message)}`;
  document.body.append(toast);
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.remove(), 1800);
}

// ── Header ──────────────────────────────────────────────────────────────────────

function renderHeader(): void {
  const status = connectionStatus();
  const isLive = status === 'live';

  // connection pill
  const liveDot = document.getElementById('live-dot');
  const liveLabel = document.getElementById('live-label');
  if (liveDot) {
    liveDot.style.background = isLive ? 'var(--success)' : 'var(--st-unknown)';
    liveDot.classList.toggle('pulse', isLive);
  }
  if (liveLabel) {
    liveLabel.textContent = status === 'connecting' ? 'connecting…' : isLive ? 'live' : 'offline';
    liveLabel.style.color = isLive ? 'oklch(0.8 0.13 150)' : 'var(--text-dim)';
  }

  // daemon pill — reflects the app-supervised Conductor daemon lifecycle (P-ON1), not the IPC live state.
  // The app OWNS the daemon, so the operator sees its real status (starting/healthy/restarting/failed/
  // stopped) and can Retry a failed start by clicking the pill.
  const daemonDot = document.getElementById('daemon-dot');
  const daemonLabel = document.getElementById('daemon-label');
  const daemonPill = document.getElementById('daemon-pill');
  const daemonStatus = latestDaemon?.status ?? 'stopped';
  if (daemonDot) daemonDot.style.background = daemonDotColor(daemonStatus);
  if (daemonLabel) daemonLabel.textContent = daemonStatus;
  if (daemonPill) {
    // A failed daemon is the one retryable state — make the pill an affordance + surface the reason.
    const retryable = daemonStatus === 'failed';
    daemonPill.classList.toggle('retryable', retryable);
    daemonPill.title = latestDaemon?.detail ?? '';
  }

  // project pill — clickable "Open project" affordance. With a project open it shows the repo name; with
  // none open it stays in the honest empty state ("No project open") but remains the entry point.
  const pill = document.getElementById('project-pill');
  const nameEl = document.getElementById('project-name');
  const branchEl = document.getElementById('project-branch');
  if (pill instanceof HTMLButtonElement) pill.disabled = false;
  if (projectInfo != null) {
    pill?.classList.remove('empty');
    if (nameEl) nameEl.textContent = projectInfo.name;
    if (branchEl) {
      if (projectInfo.branch != null && projectInfo.branch.length > 0) {
        branchEl.textContent = projectInfo.branch;
        branchEl.hidden = false;
      } else {
        branchEl.hidden = true;
      }
    }
  } else {
    pill?.classList.add('empty');
    if (nameEl) nameEl.textContent = 'No project open';
    if (branchEl) branchEl.hidden = true;
  }

  renderLimitsSummary();
}

// Map the supervised daemon lifecycle status to the header dot colour. `healthy` is success-green;
// `starting`/`restarting` are an in-flight amber; `failed` is danger; `stopped` is neutral.
function daemonDotColor(status: DaemonStatus): string {
  switch (status) {
    case 'healthy':
      return 'var(--success)';
    case 'starting':
    case 'restarting':
      return 'var(--warn)';
    case 'failed':
      return 'var(--danger)';
    case 'stopped':
      return 'oklch(0.6 0.02 30)';
  }
}

// ── Limits popover ──────────────────────────────────────────────────────────────

interface ProviderGroup {
  provider: string;
  account: string;
  rows: LimitsCostHeadroomRow[];
}

function groupHeadroom(state: LimitsCostState): ProviderGroup[] {
  const groups = new Map<string, ProviderGroup>();
  for (const row of state.headroomRows) {
    const key = `${row.provider}:${row.account}`;
    let g = groups.get(key);
    if (g == null) {
      g = { provider: row.provider, account: row.account, rows: [] };
      groups.set(key, g);
    }
    g.rows.push(row);
  }
  return [...groups.values()];
}

function providerColor(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('codex') || n.includes('openai')) return 'var(--prov-codex)';
  return 'var(--accent)';
}

function fillColor(pct: number): string {
  if (pct >= 80) return 'var(--danger)';
  if (pct >= 50) return 'var(--warn)';
  return 'var(--success-deep)';
}

function resetEta(resetAt: string): string {
  const ms = Date.parse(resetAt) - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return 'resetting';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function renderLimitsSummary(): void {
  const summary = document.getElementById('limits-summary');
  if (!summary) return;
  const state = latestLimitsState;
  if (state == null || state.headroomRows.length === 0) {
    summary.hidden = true;
    return;
  }
  const parts = groupHeadroom(state).map((g) => {
    const known = g.rows.filter((r) => r.headroom.kind === 'known');
    if (known.length === 0) return '—';
    const worst = Math.max(
      ...known.map((r) => (r.headroom.kind === 'known' ? r.headroom.used_pct : 0)),
    );
    return `${Math.round(worst)}%`;
  });
  if (parts.length === 0) {
    summary.hidden = true;
    return;
  }
  summary.textContent = parts.join(' · ');
  summary.hidden = false;
}

function renderLimitsPopover(state: LimitsCostState): void {
  const body = document.getElementById('limits-popover-body');
  if (!body) return;
  if (state.headroomRows.length === 0) {
    body.innerHTML = `<div class="empty-inline"><span class="glyph">%</span><span class="lead">No usage recorded yet</span><span class="sub">Provider headroom appears once agents run real turns through the balancer.</span></div>`;
    return;
  }
  body.innerHTML = groupHeadroom(state)
    .map((g) => {
      const color = providerColor(g.provider);
      const bars = g.rows
        .map((row) => {
          if (row.headroom.kind === 'unknown') {
            return `<div class="bar-row"><div class="bar-meta"><span class="lbl">${esc(row.windowKind)}</span><span class="val" style="color:var(--text-faint)">no data</span></div></div>`;
          }
          const pct = Math.min(100, Math.round(row.headroom.used_pct));
          return `
            <div class="bar-row">
              <div class="bar-meta">
                <span class="lbl">${esc(row.windowKind)}</span>
                <span class="val" style="color:${color}">${pct}% · resets ${esc(resetEta(row.headroom.reset_at))}</span>
              </div>
              <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${fillColor(pct)}"></div></div>
            </div>`;
        })
        .join('');
      return `
        <div class="prov-card-mini">
          <div class="head">
            <span class="dot" style="background:${color}"></span>
            <span class="name">${esc(g.provider)}</span>
            <span class="plan">${esc(g.account)}</span>
          </div>
          ${bars}
        </div>`;
    })
    .join('');
}

// ── Mission Control ─────────────────────────────────────────────────────────────

function renderTreeRows(nodes: readonly TreeNode[], depth: number): string {
  return nodes
    .map((node) => {
      const meta = statusMeta(node.status);
      const rc = roleColor(node.role);
      const roleLabel = node.subRole ? `${node.role}:${node.subRole}` : node.role;
      const displayName = agentDisplayName(node);
      const accessibleName = agentAccessibleName(node);
      const indent = depth * 16;
      const isRootCoordinator = depth === 0 && node.role.toLowerCase() === 'coordinator';
      const subtreeCount = 1 + countSubtree(node.children);
      const subtreeLabel = `${subtreeCount} agent${subtreeCount === 1 ? '' : 's'}`;
      const deleteConfirm =
        pendingDeleteId === node.agentId
          ? `<div class="delete-confirm" role="alert" data-agent-id="${esc(node.agentId)}">
               <span class="lead">Delete subtree (${subtreeLabel}), including ${esc(node.agentId)}.</span>
               <span class="sub">Hosted panes stop, sessions end, merged branches are removed, and unmerged branches archive for 14 days.</span>
               <span class="actions">
                 <button class="btn btn-ghost" data-agent-action="delete-cancel" data-agent-id="${esc(node.agentId)}" type="button">Cancel</button>
                 <button class="btn btn-danger" data-agent-action="delete-confirm" data-agent-id="${esc(node.agentId)}" type="button">Delete subtree</button>
               </span>
             </div>`
          : '';
      return `
        <div class="fleet-row" data-agent-id="${esc(node.agentId)}">
          <button class="fleet-row-open" data-agent-id="${esc(node.agentId)}" type="button" aria-label="Open agent ${esc(accessibleName)}">
            <span style="width:${indent}px;flex:0 0 ${indent}px"></span>
            <span class="state-dot${meta.pulse ? ' pulse' : ''}" style="background:${meta.color};box-shadow:0 0 0 3px ${tint(meta.color, '22%')}"></span>
            <span class="mid">
              <span class="line1">
                <span class="name">${esc(displayName)}</span>
                <span class="role-badge" style="background:${tint(rc, '18%')};color:${rc}">${esc(roleLabel)}</span>
              </span>
              <span class="last">${esc(node.name != null ? `${node.agentId} · child of ${node.parent}` : node.parent ? `child of ${node.parent}` : 'root coordinator')}</span>
            </span>
            <span class="right">
              <span class="state" style="color:${meta.color}">${meta.label}</span>
            </span>
          </button>
          ${isRootCoordinator ? `<button class="btn btn-ghost" data-agent-action="delete" data-agent-id="${esc(node.agentId)}" type="button" aria-label="Delete coordinator ${esc(accessibleName)}">Delete</button>` : ''}
        </div>
        ${deleteConfirm}
        ${renderTreeRows(node.children, depth + 1)}`;
    })
    .join('');
}

function renderDashboard(): void {
  const container = document.getElementById('dashboard-content');
  const form = document.getElementById('session-start-form');
  if (!container) return;

  const dash = latestDashboard;
  const phase = derivePhase();
  const status = connectionStatus();
  const isDegraded = status !== 'live';

  // Buddy mood
  const buddyStatus = document.getElementById('buddy-status');
  if (buddyStatus) {
    buddyStatus.textContent =
      phase === 'fleet' ? 'idle · waves on gate pass' : phase === 'empty' ? 'asleep' : 'warm';
  }

  setNavEnabled(status === 'live' || (dash != null && dash.stats.total > 0));

  // Empty hero — conductor offline / nothing to show.
  if (phase === 'empty') {
    // Hide the composer but preserve any in-progress draft (don't wipe innerHTML).
    if (form) form.style.display = 'none';
    const heroTitle =
      status === 'connecting' ? 'Connecting to the Conductor…' : 'Conductor offline';
    const heroBody =
      status === 'connecting'
        ? 'Reaching the Conductor daemon for this project.'
        : 'The Conductor daemon is not running for this project. Start it to drive the fleet.';
    container.innerHTML = `
      <div class="empty-hero">
        <div class="icon">⊞</div>
        <h1>${esc(heroTitle)}</h1>
        <p>${esc(heroBody)}</p>
        <div class="hint">co-mcp serve &lt;projectId&gt;</div>
      </div>`;
    return;
  }

  const stats = dash?.stats ?? {
    total: 0,
    warm: 0,
    waiting: 0,
    stopped: 0,
    stuck: 0,
    paused: 0,
  };
  const actionables = dash?.actionables ?? [];
  const actionCount = actionables.length;
  const coordRoot = phase === 'coord' ? dash?.tree[0] : null;
  const coordCopy = coordRoot != null ? coordinatorPhaseCopy(coordRoot.status) : null;

  const subline =
    phase === 'fleet'
      ? `Conductor driving ${stats.total} agent${stats.total !== 1 ? 's' : ''}`
      : phase === 'coord'
        ? (coordCopy?.subline ?? '1 coordinator registered · status unknown')
        : 'Project open · Conductor idle · start a session to begin';

  const tiles: Array<{ label: string; value: number; color: string; sub: string }> = [
    {
      label: 'Total',
      value: stats.total,
      color: 'var(--accent)',
      sub: phase === 'fleet' ? 'in the fleet' : 'no agents',
    },
    {
      label: 'Running',
      value: stats.warm,
      color: 'var(--st-running)',
      sub: stats.warm > 0 ? 'executing turns' : 'idle',
    },
    {
      label: 'Waiting',
      value: stats.waiting,
      color: 'var(--st-waiting)',
      sub: stats.waiting > 0 ? 'eligible to wake' : '—',
    },
    {
      label: 'Stopped',
      value: stats.stopped,
      color: 'var(--st-stopped)',
      sub: stats.stopped > 0 ? 'requires re-wake' : '—',
    },
    {
      label: 'Stuck',
      value: stats.stuck,
      color: 'var(--st-stuck)',
      sub: stats.stuck > 0 ? 'needs decision' : 'all clear',
    },
    {
      label: 'Action req.',
      value: actionCount,
      color: 'var(--warn)',
      sub: actionCount > 0 ? 'in your inbox' : 'inbox clear',
    },
  ];
  const tilesHtml = tiles
    .map(
      (t) => `
      <div class="stat-tile">
        <div class="top"><span class="dot" style="background:${t.color}"></span><span class="lbl">${esc(t.label)}</span></div>
        <div class="val${t.value === 0 ? ' zero' : ''}">${t.value}</div>
        <div class="sub">${esc(t.sub)}</div>
      </div>`,
    )
    .join('');

  const headerActions =
    phase === 'fleet'
      ? `<div class="mc-actions">
           <button class="btn btn-ghost" data-mc-action="pause" type="button">Pause all</button>
           <button class="btn btn-primary" data-mc-action="console" type="button">Open console</button>
         </div>`
      : '';

  const degradedBanner = isDegraded
    ? `<div class="degraded-banner">Conductor not running — showing last known state</div>`
    : '';

  const dismissedSizeBefore = dismissedAgents.size;
  const pruned =
    dash != null ? pruneDismissedAgents(dash.tree) : { tree: [] as TreeNode[], hidden: 0 };
  if (dismissedAgents.size !== dismissedSizeBefore) persistDismissedAgents();
  const clearableCount = dash != null ? clearableAgentIds(dash.tree).length : 0;
  const fleetTools = [
    clearableCount > 0
      ? `<button class="link" data-mc-action="clear-finished" type="button">Clear finished (${clearableCount})</button>`
      : '',
    pruned.hidden > 0
      ? `<button class="link" data-mc-action="show-hidden" type="button">${pruned.hidden} hidden · show all</button>`
      : '',
  ].join('');
  const fleetHd = `<span class="ttl">Fleet</span><span class="meta">spawn tree · click to open console</span>${fleetTools}`;

  const fleetBody =
    pruned.tree.length > 0
      ? pruned.tree
          .map((root) => `<div class="subtree-group">${renderTreeRows([root], 0)}</div>`)
          .join('')
      : pruned.hidden > 0
        ? `<div class="empty-inline">
           <span class="glyph">✓</span>
           <span class="lead">All agents cleared from view.</span>
           <span class="sub"><button class="link" data-mc-action="show-hidden" type="button">Show ${pruned.hidden} hidden</button></span>
         </div>`
        : `<div class="empty-inline">
           <span class="glyph">∅</span>
           <span class="lead">No agents yet.</span>
          <span class="sub">Start a coordinator session — the fleet starts after you lock the spec with \`co spec lock\`.</span>
         </div>`;

  // Right column varies by phase
  let rightCol = '';
  if (phase === 'coord') {
    const copy = coordCopy ?? coordinatorPhaseCopy('unknown');
    const meta = statusMeta(coordRoot?.status ?? 'unknown');
    rightCol = `
      <div class="coord-cta">
        <div class="row"><span class="dot${copy.pulse ? ' pulse' : ''}" style="background:${meta.color}"></span><span class="ttl">${esc(copy.title)}</span></div>
        <p>${esc(copy.body)}</p>
        <button class="btn btn-primary" data-mc-action="console" type="button" style="align-self:flex-start">Open console →</button>
      </div>`;
  } else if (phase === 'fleet') {
    const cards =
      actionCount > 0
        ? actionables
            .map((a) => {
              const tc = mailTypeColor(a.type);
              const isEsc = a.type === 'escalation';
              return `
              <button class="action-card${isEsc ? ' escalation' : ''}" data-mail-seq="${a.seq}" type="button">
                <div class="top">
                  <span class="type-tag" style="background:${tint(tc, '20%')};color:${tc}">${esc(a.type)}</span>
                  <span class="from">${esc(a.sender)}</span>
                </div>
                <div class="subj">${esc(a.subject)}</div>
              </button>`;
            })
            .join('')
        : `<div class="empty-inline"><span class="glyph">✓</span><span class="lead">Inbox clear</span><span class="sub">No actions need you right now.</span></div>`;
    rightCol = `
      <div class="panel">
        <div class="panel-hd">
          <span class="ttl">Action required</span>
          ${actionCount > 0 ? `<span class="count">${actionCount}</span>` : ''}
          <button class="link" data-mc-action="mail" type="button">Open mail →</button>
        </div>
        <div class="panel-body">${cards}</div>
      </div>`;
  }

  const grid =
    phase === 'opened'
      ? `<div class="panel" style="flex:1;min-height:280px">
           <div class="panel-hd">${fleetHd}</div>
           <div class="panel-body">${fleetBody}</div>
         </div>`
      : `<div class="mc-grid">
           <div class="panel">
             <div class="panel-hd">${fleetHd}</div>
             <div class="panel-body">${fleetBody}</div>
           </div>
           <div class="mc-right">${rightCol}</div>
         </div>`;

  // Archived section — rendered below the fleet only when there are archived entries.
  const archivedSection =
    latestArchive.length > 0
      ? `<div class="panel" style="margin-top:16px">
           <div class="panel-hd"><span class="ttl">Archived</span><span class="meta">unmerged branches</span></div>
           <div class="panel-body">
             ${latestArchive
               .map((e) => {
                 const days = Math.max(0, Math.ceil((e.expiresAt - Date.now()) / 86_400_000));
                 const purgeConfirm =
                   pendingArchivePurgeId === e.id
                     ? `<span class="delete-confirm" role="alert" data-archive-id="${esc(e.id)}" style="flex:1">
                          <span class="lead">Permanently delete ${esc(e.branch)}.</span>
                          <span class="detail">This removes the archived branch and cannot be undone from co.</span>
                          <span class="actions">
                            <button class="btn btn-ghost" data-archive-action="purge-cancel" data-archive-id="${esc(e.id)}" type="button">Cancel</button>
                            <button class="btn btn-danger" data-archive-action="purge-confirm" data-archive-id="${esc(e.id)}" type="button">Purge branch</button>
                          </span>
                        </span>`
                     : `<button class="btn btn-ghost" data-archive-action="purge" data-archive-id="${esc(e.id)}" type="button">Purge</button>`;
                 return `<div class="fleet-row" style="display:flex;align-items:center;gap:8px;padding:8px 0">
                   <span style="flex:1">${esc(e.name)} · <code>${esc(e.branch)}</code> · expires in ${days} day${days === 1 ? '' : 's'}</span>
                   <button class="btn btn-ghost" data-archive-action="restore" data-archive-id="${esc(e.id)}" type="button">Restore</button>
                   ${purgeConfirm}
                 </div>`;
               })
               .join('')}
           </div>
         </div>`
      : '';

  container.innerHTML = `
    <div class="mc-head">
      <div>
        <h1 class="mc-title">Mission Control</h1>
        <p class="mc-sub">${esc(subline)}</p>
      </div>
      ${headerActions}
    </div>
    ${degradedBanner}
    <div class="stat-tiles">${tilesHtml}</div>
    ${grid}
    ${archivedSection}`;

  // Kickoff composer lives in the sibling #session-start-form (so dashboard rerenders
  // never wipe an in-progress draft). Shown whenever the daemon is live (opened/coord/fleet).
  if (form) {
    if (phase === 'opened' || phase === 'coord' || phase === 'fleet') {
      if (form.innerHTML === '') renderSessionStartForm();
      form.style.display = '';
    } else {
      form.style.display = 'none';
    }
  }

  // nav badges
  setBadge('agents-badge', stats.warm);
  setBadge('mail-badge', actionCount);
}

function renderSessionStartForm(): void {
  const form = document.getElementById('session-start-form');
  if (!form) return;
  form.innerHTML = [
    `<div class="kickoff" style="margin-top:16px">`,
    `<div class="kickoff-hd">Start a coordinator session</div>`,
    `<div class="kickoff-body">`,
    `<input id="session-name-input" class="field" type="text"`,
    ` placeholder="Coordinator name" aria-label="Coordinator name">`,
    `<textarea id="session-prompt-input" class="field" style="min-height:90px"`,
    ` placeholder="Describe the task for the root coordinator…  e.g. finish stage-15 convergence and get PR #41 review-ready"`,
    ` aria-label="Coordinator session prompt"></textarea>`,
    `<div class="kickoff-foot">`,
    `<button class="btn btn-ghost" id="session-demo-spec" type="button">Use demo spec</button>`,
    `<div class="header-spacer"></div>`,
    `<button class="btn btn-primary" id="session-start-btn" type="button" aria-label="Start coordinator session">Start session →</button>`,
    `</div>`,
    `</div>`,
    `</div>`,
  ].join('');
}

// ── Agents console ──────────────────────────────────────────────────────────────

let agentsTerm: XtermTerminal | null = null;
let agentsResizeObserver: ResizeObserver | null = null;
let lastAgentId: string | null = null;
let lastTranscript = '';
// Gate xterm construction on the bundled IBM Plex Mono being loaded — a mismeasured fallback font is a
// classic warp source, so we only build the terminal once the fixed monospace metric is available.
let fontsReady = false;
// Resize de-dupe + debounce so a drag doesn't spam PTY.resize; reset on agent-switch to force a resend.
let lastSentCols = 0;
let lastSentRows = 0;
let resizeDebounce: ReturnType<typeof setTimeout> | null = null;

// The selected agent that interactive input/resize should route to — but ONLY when the conductor is live
// (an offline pane has no pty to receive bytes).
function liveTerminalAgentId(): string | null {
  if (latestAgentsState == null || latestAgentsState.connection !== 'live') return null;
  return latestAgentsState.selectedAgentId;
}

// Forward a raw keystroke chunk from xterm to the selected live agent's pty stdin (the operator answers
// prompts / steers in-pane). Quietly dropped (console, not a per-key toast) when no agent is hosted.
function forwardTerminalInput(data: string): void {
  const agentId = liveTerminalAgentId();
  if (agentId == null) return;
  void window.coShell.agentsSendInput(agentId, data).then((r) => {
    if (!r.ok && r.error != null) console.warn(`terminal input dropped: ${r.error}`);
  });
}

// Drive PTY.resize(cols, rows) so the hosted pty grid matches the in-app xterm grid (width-agreement, #40).
function sendTerminalResize(cols: number, rows: number): void {
  const agentId = liveTerminalAgentId();
  if (agentId == null || cols <= 0 || rows <= 0) return;
  if (cols === lastSentCols && rows === lastSentRows) return;
  lastSentCols = cols;
  lastSentRows = rows;
  void window.coShell.agentsResize(agentId, cols, rows).then((r) => {
    if (!r.ok && r.error != null) console.warn(`terminal resize failed: ${r.error}`);
  });
}

function scheduleTerminalResize(cols: number, rows: number): void {
  if (resizeDebounce != null) clearTimeout(resizeDebounce);
  resizeDebounce = setTimeout(() => sendTerminalResize(cols, rows), 120);
}

// Construct the xterm lazily, on first render while the Agents pane is active+sized (the
// isAgentsViewActive() gate in renderAgentsTranscript) AND the bundled font is ready. The terminal is
// INTERACTIVE (stdin enabled): onData forwards keystrokes to the hosted pty, and the fitted grid drives
// PTY.resize so cursor-addressed redraws never warp (GitHub #40). Built WITHOUT convertEol (the stream is
// raw, cursor-addressed pty bytes). Returns null when the font isn't ready yet or the element is absent —
// the caller then skips the feed for this tick (a later tick / the fonts-ready handler re-renders).
function getOrCreateTerm(): XtermTerminal | null {
  if (agentsTerm != null) return agentsTerm;
  if (!fontsReady) return null;
  const el = document.getElementById('agents-transcript');
  if (el == null) return null;
  const { term } = createAgentsTerminal<XtermTerminal>(el, {
    createTerminal: (options) => new window.Terminal(options),
    createFitAddon: () => new window.FitAddon.FitAddon(),
    observeResize: (target, onResize) => {
      // getOrCreateTerm caches agentsTerm, so this closure runs exactly once per app lifetime; the
      // disconnect is a defensive guard against a future caller invoking it twice, not a live path.
      agentsResizeObserver?.disconnect();
      agentsResizeObserver = new ResizeObserver(() => onResize());
      agentsResizeObserver.observe(target);
    },
    onInput: forwardTerminalInput,
    onResize: scheduleTerminalResize,
  });
  agentsTerm = term;
  return term;
}

// Preload the bundled IBM Plex Mono, then build/refresh the terminal once it's measured. Called once at
// bootstrap. document.fonts always exists in Electron's Chromium; the guard is belt-and-suspenders.
function preloadTerminalFont(): void {
  const ready = (): void => {
    fontsReady = true;
    if (isAgentsViewActive() && latestAgentsState != null)
      renderAgentsTranscript(latestAgentsState);
  };
  try {
    void Promise.allSettled([
      document.fonts.load('12px "IBM Plex Mono"'),
      document.fonts.load('600 12px "IBM Plex Mono"'),
    ]).then(() => document.fonts.ready.then(ready, ready));
  } catch {
    ready();
  }
}

function isAgentsViewActive(): boolean {
  return document.getElementById('view-agents')?.classList.contains('active') === true;
}

function showTranscriptError(message: string | undefined): void {
  const console_ = document.getElementById('agents-console');
  if (!console_ || !message) return;
  const toast = document.createElement('div');
  toast.className = 'inline-error-toast';
  toast.textContent = message;
  console_.prepend(toast);
  setTimeout(() => toast.remove(), 5000);
}

function setSteerEnabled(enabled: boolean): void {
  const steerInput = document.getElementById('steer-input') as HTMLTextAreaElement | null;
  if (steerInput) steerInput.disabled = !enabled;
  for (const btn of document.querySelectorAll<HTMLButtonElement>('#steer-bar .btn')) {
    btn.disabled = !enabled;
  }
}

function syncActiveRewakeDraft(): void {
  if (activeRewakeAgentId == null) return;
  const input = document.querySelector<HTMLTextAreaElement>('.rewake-input');
  if (input != null) activeRewakeDraft = input.value;
}

function renderAgents(state: AgentsConsoleState): void {
  syncActiveRewakeDraft();
  latestAgentsState = state;
  if (
    activeRewakeAgentId != null &&
    !state.roster.some((agent) => agent.agentId === activeRewakeAgentId)
  ) {
    activeRewakeAgentId = null;
    activeRewakeDraft = '';
  }

  const railHd = document.getElementById('agents-rail-hd');
  if (railHd) railHd.textContent = `Sessions · ${state.roster.length}`;

  const roster = document.getElementById('agents-roster');
  if (roster) {
    if (state.roster.length === 0) {
      roster.innerHTML = `<div class="empty-inline"><span class="glyph">∅</span><span class="lead">No agents</span></div>`;
    } else {
      roster.innerHTML = state.roster
        .map((agent) => {
          const isSelected = agent.agentId === state.selectedAgentId;
          const meta = statusMeta(agent.status);
          const rc = roleColor(agent.role);
          const displayName = agentDisplayName(agent);
          const accessibleName = agentAccessibleName(agent);
          const rewakeComposer =
            activeRewakeAgentId === agent.agentId
              ? `<div class="rewake-composer" data-agent-id="${esc(agent.agentId)}">
                   <textarea class="rewake-input" rows="3" placeholder="New task for this agent…" aria-label="Re-wake message for agent ${esc(accessibleName)}">${esc(activeRewakeDraft)}</textarea>
                   <span class="rewake-actions">
                     <button class="btn btn-ghost rewake-send" type="button">Send</button>
                     <button class="btn btn-ghost rewake-cancel" type="button">Cancel</button>
                   </span>
                 </div>`
              : '';
          return [
            `<div class="sess-item" role="listitem">`,
            `<div class="sess-row${isSelected ? ' selected' : ''}" data-agent-id="${esc(agent.agentId)}">`,
            `<button class="sess-row-open" data-agent-id="${esc(agent.agentId)}" type="button" aria-current="${isSelected ? 'true' : 'false'}" aria-label="Open agent ${esc(accessibleName)}">`,
            `<span class="state-dot${meta.pulse ? ' pulse' : ''}" style="background:${meta.color}"></span>`,
            `<span class="mid">`,
            `<span class="name">${esc(displayName)}</span>`,
            agent.name != null ? `<span class="role">${esc(agent.agentId)}</span>` : '',
            `<span class="role" style="color:${rc}">${esc(agent.role)}</span>`,
            `</span>`,
            `<span class="state" style="color:${meta.color}">${meta.label}</span>`,
            `</button>`,
            `<span class="sess-actions">`,
            `<button class="btn btn-ghost" data-agent-action="stop" data-agent-id="${esc(agent.agentId)}" type="button" aria-label="Stop agent ${esc(accessibleName)}">Stop</button>`,
            `<button class="btn btn-ghost" data-agent-action="unstick" data-agent-id="${esc(agent.agentId)}" type="button" aria-label="Unstick agent ${esc(accessibleName)}">Unstick</button>`,
            agent.status !== 'warm'
              ? `<button class="btn btn-ghost" data-agent-action="rewake" data-agent-id="${esc(agent.agentId)}" type="button" aria-label="Re-wake agent ${esc(accessibleName)}">Re-wake</button>`
              : '',
            `</span>`,
            `</div>`,
            rewakeComposer,
            `</div>`,
          ].join('');
        })
        .join('');
    }
  }

  // console header + visibility
  const selected = state.roster.find((a) => a.agentId === state.selectedAgentId) ?? null;
  const consoleHd = document.getElementById('console-hd');
  const consoleEmpty = document.getElementById('console-empty');
  const transcriptEl = document.getElementById('agents-transcript');
  const steerBar = document.getElementById('steer-bar');
  const consoleEl = document.getElementById('agents-console');

  if (selected == null) {
    if (consoleHd) consoleHd.hidden = true;
    if (steerBar) steerBar.hidden = true;
    if (transcriptEl) transcriptEl.style.display = 'none';
    if (consoleEmpty) consoleEmpty.style.display = '';
  } else {
    const meta = statusMeta(selected.status);
    const rc = roleColor(selected.role);
    const displayName = agentDisplayName(selected);
    consoleEl?.classList.remove('codex');
    if (consoleHd) {
      consoleHd.hidden = false;
      consoleHd.innerHTML = [
        `<span class="state-dot${meta.pulse ? ' pulse' : ''}" style="background:${meta.color}"></span>`,
        `<span class="name">${esc(displayName)}</span>`,
        `<span class="role-badge" style="background:${tint(rc, '18%')};color:${rc}">${esc(selected.role)}</span>`,
        `<span class="spacer"></span>`,
        `<span class="meta" style="color:${meta.color}">${meta.label}</span>`,
        selected.name != null ? `<span class="meta">${esc(selected.agentId)}</span>` : '',
        `<span class="meta">${esc(selected.parent ? `child of ${selected.parent}` : 'root')}</span>`,
      ].join('');
    }
    if (consoleEmpty) consoleEmpty.style.display = 'none';
    if (transcriptEl) transcriptEl.style.display = '';
    if (steerBar) steerBar.hidden = false;

    const steerHint = document.getElementById('steer-hint');
    if (steerHint) {
      steerHint.textContent =
        state.connection === 'live'
          ? selected.status === 'warm'
            ? 'pushes a steer into the live session'
            : 'agent is not warm — steer is unavailable'
          : 'conductor offline — steer is unavailable';
    }
  }

  const steerEnabled =
    state.selectedAgentId != null && state.connection === 'live' && state.selectedStatus === 'warm';
  setSteerEnabled(steerEnabled);

  renderAgentsTranscript(state);
}

function renderAgentsTranscript(state: AgentsConsoleState): void {
  if (!isAgentsViewActive()) return;
  if (state.selectedAgentId == null) return;
  const term = getOrCreateTerm();
  if (term == null) return;
  const switched = state.selectedAgentId !== lastAgentId;
  // The transcript STRING is the raw pty output — feed it to xterm verbatim (no EOL conversion, no
  // sanitization). decideTermFeed appends the delta while the transcript only grows, and resets +
  // rewrites on agent-switch or a non-prefix change; xterm's emulator reproduces the final screen.
  applyTermFeed(
    term,
    decideTermFeed({
      selectedAgentId: state.selectedAgentId,
      lastAgentId,
      transcript: state.transcript,
      lastTranscript,
    }),
  );
  lastAgentId = state.selectedAgentId;
  lastTranscript = state.transcript;
  // On agent-switch, the newly-selected agent's pty must be told the current xterm grid (its width may
  // differ from the previous agent's). Force a resend past the de-dupe.
  if (switched) {
    lastSentCols = 0;
    lastSentRows = 0;
    sendTerminalResize(term.cols, term.rows);
  }
}

// ── Mail ────────────────────────────────────────────────────────────────────────

function mailAgeStr(ts: number): string {
  const age = Math.floor((Date.now() - ts) / 60000);
  if (age < 60) return `${age}m`;
  if (age < 1440) return `${Math.floor(age / 60)}h`;
  return `${Math.floor(age / 1440)}d`;
}

function renderMailSidebar(state: MailState): void {
  const busSelector = document.getElementById('mail-bus-selector');
  if (busSelector) {
    const buses = [
      OPERATOR_BUS,
      ...[...knownMailBuses].filter((b) => b !== OPERATOR_BUS && !dismissedAgents.has(b)),
    ];
    if (!buses.includes(state.activeBus)) buses.push(state.activeBus);
    busSelector.innerHTML = buses
      .map((bus) => {
        const label = bus === OPERATOR_BUS ? 'Operator' : bus;
        const active = bus === state.activeBus;
        return `<button class="${active ? 'active' : ''}" data-bus="${esc(bus)}" type="button" aria-pressed="${active ? 'true' : 'false'}" title="${esc(bus)}">${esc(label)}</button>`;
      })
      .join('');
  }

  const inboxTab = document.getElementById('mail-tab-inbox');
  const outboxTab = document.getElementById('mail-tab-outbox');
  inboxTab?.classList.toggle('active', state.tab === 'inbox');
  outboxTab?.classList.toggle('active', state.tab === 'outbox');
  inboxTab?.setAttribute('aria-selected', state.tab === 'inbox' ? 'true' : 'false');
  outboxTab?.setAttribute('aria-selected', state.tab === 'outbox' ? 'true' : 'false');

  const inboxActionables = state.inbox.filter((r) => r.kind === 'actionable').length;
  const inboxCount = document.getElementById('mail-inbox-count');
  if (inboxCount) {
    if (inboxActionables > 0) {
      inboxCount.textContent = String(inboxActionables);
      inboxCount.hidden = false;
    } else {
      inboxCount.hidden = true;
    }
  }

  const folderTitle = document.getElementById('mail-folder-title');
  if (folderTitle) {
    folderTitle.textContent =
      state.activeBus !== OPERATOR_BUS ? 'Agent bus' : state.tab === 'inbox' ? 'Inbox' : 'Sent';
  }

  const rows = state.tab === 'inbox' ? state.inbox : state.outbox;
  const countLabel = document.getElementById('mail-count-label');
  if (countLabel) countLabel.textContent = `${rows.length} message${rows.length !== 1 ? 's' : ''}`;

  const mailList = document.getElementById('mail-list');
  if (!mailList) return;
  if (rows.length === 0) {
    mailList.innerHTML = `<div class="empty-inline"><span class="glyph">✉</span><span class="lead">No messages</span></div>`;
    return;
  }
  mailList.innerHTML = rows
    .map((row) => {
      const isSelected = state.selected?.seq === row.seq;
      const isActionable = row.kind === 'actionable';
      const isUnread = !row.read;
      const counterpart = state.tab === 'inbox' ? row.sender : row.recipient;
      const tc = mailTypeColor(row.type);
      return [
        `<button class="mail-row${isSelected ? ' selected' : ''}${isActionable ? ' actionable' : ''}" data-seq="${row.seq}" role="tab" type="button" aria-selected="${isSelected ? 'true' : 'false'}">`,
        `<div class="r1">`,
        isUnread ? `<span class="unread-dot"></span>` : '',
        `<span class="from" style="color:${roleColor(counterpart)}">${esc(counterpart)}</span>`,
        `<span class="time">${esc(mailAgeStr(row.ts))}</span>`,
        `</div>`,
        `<div class="r2">`,
        `<span class="tag" style="background:${tint(tc, '20%')};color:${tc}">${esc(row.type)}</span>`,
        isActionable ? `<span class="tag action">action</span>` : '',
        `</div>`,
        `<div class="subj${isUnread ? ' unread' : ''}">${esc(row.subject)}</div>`,
        `<div class="preview">${esc(row.renderedBody.replace(/[#*>`]/g, '').slice(0, 120))}</div>`,
        `</button>`,
      ].join('');
    })
    .join('');
}

function renderMailDetail(state: MailState, prevState: MailState | null): void {
  const detailPane = document.getElementById('mail-detail-pane');
  if (!detailPane) return;
  const { selected, composer } = state;

  if (selected == null) {
    detailPane.innerHTML = `<div class="empty-inline"><span class="glyph">✉</span><span class="lead">Select a message to read it</span></div>`;
    return;
  }

  // Preserve the caret while typing in the reply/decision composer (bug #39): when the ONLY change is
  // composer.body and that textarea is focused, skip the rebuild — the live textarea already holds the
  // typed value, so recreating it would drop the caret to the start and reverse the text.
  const composerFocused = document.activeElement?.id === 'composer-body';
  const needsRebuild = mailDetailNeedsRebuild(
    prevState != null ? mailDetailSignature(prevState) : null,
    mailDetailSignature(state),
    composerFocused,
  );
  if (!needsRebuild) return;

  const isActionable = selected.kind === 'actionable';
  const isApproval = selected.type === 'approval';
  const pendingAttr = composer.pending ? ' disabled' : '';
  const tc = mailTypeColor(selected.type);
  const senderColor = roleColor(selected.sender);

  // optional typed payload card (from structured fields we do have)
  const payloadRows: Array<{ k: string; v: string; color: string }> = [];
  if (selected.decision != null) {
    payloadRows.push({ k: 'Decision', v: selected.decision, color: 'var(--text-body)' });
  }
  if (selected.reviewVerdict != null) {
    payloadRows.push({
      k: 'Verdict',
      v: selected.reviewVerdict,
      color: selected.reviewVerdict === 'PASS' ? 'oklch(0.78 0.13 150)' : 'oklch(0.78 0.16 40)',
    });
  }
  const payloadHtml =
    payloadRows.length > 0
      ? `<div class="payload-card">
           <div class="hd">Envelope</div>
           <div class="rows">${payloadRows
             .map(
               (r) =>
                 `<div class="kv"><span class="k">${esc(r.k)}</span><span class="v" style="color:${r.color}">${esc(r.v)}</span></div>`,
             )
             .join('')}</div>
         </div>`
      : '';

  let actionsHtml = '';
  if (isApproval) {
    actionsHtml = `
      <div class="mail-actions">
        <div class="lbl-row"><span class="lbl">Quick actions</span><span class="hint">one click sends a structured approval ack</span></div>
        <div class="btns">
          <button class="btn btn-success" data-action="approve" data-seq="${selected.seq}"${pendingAttr}>Approve &amp; merge</button>
          <button class="btn btn-ghost" data-action="open-composer" data-seq="${selected.seq}" data-recipient="${esc(selected.recipient)}" data-type="approval_response" data-subject="${esc(`Re: ${selected.subject}`)}"${pendingAttr}>Add note</button>
          <button class="btn btn-danger" data-action="decline" data-seq="${selected.seq}"${pendingAttr}>Decline</button>
        </div>
      </div>`;
  } else if (selected.type === 'review_request') {
    // The SH-1 human gate: route a review request to the Review view, where the operator records a
    // structured PASS / ISSUES verdict against the diff + locked acceptance criteria (a plain mail
    // reply would only send a clarify_response, never a review_response verdict).
    const reviewId = reviewIdFromMailRow(selected);
    const reviewIdAttr = reviewId != null ? ` data-review-id="${esc(reviewId)}"` : '';
    actionsHtml = `
      <div class="mail-actions">
        <div class="lbl-row"><span class="lbl">Quick actions</span><span class="hint">record a PASS / ISSUES verdict in the Review view</span></div>
        <div class="btns">
          <button class="btn btn-primary" data-action="open-review"${reviewIdAttr}${pendingAttr}>Open in Review →</button>
        </div>
      </div>`;
  } else if (isActionable) {
    const replyType = REPLY_TYPE;
    actionsHtml = `
      <div class="mail-actions">
        <div class="lbl-row"><span class="lbl">Quick actions</span><span class="hint">one click sends a structured reply</span></div>
        <div class="btns">
          <button class="btn btn-primary" data-action="open-composer" data-seq="${selected.seq}" data-recipient="${esc(selected.recipient)}" data-type="${esc(replyType)}" data-subject="${esc(`Re: ${selected.subject}`)}"${pendingAttr}>Reply</button>
        </div>
      </div>`;
  }

  const composerFooter = isApproval
    ? [
        `<button class="btn btn-ghost" data-action="close-composer"${pendingAttr}>Cancel</button>`,
        `<button class="btn btn-danger" data-action="decline-with-composer" data-seq="${selected.seq}"${pendingAttr}>Decline with note</button>`,
        `<button class="btn btn-success" data-action="approve-with-composer" data-seq="${selected.seq}"${pendingAttr}>Approve with note</button>`,
      ].join('')
    : [
        `<button class="btn btn-ghost" data-action="close-composer"${pendingAttr}>Cancel</button>`,
        `<button class="btn btn-primary" data-action="submit-reply"${pendingAttr}>Send</button>`,
      ].join('');

  const composerHtml = composer.active
    ? [
        `<div class="composer">`,
        `<div class="composer-hd">${isApproval ? 'Decision note' : 'Reply'}`,
        `<button class="composer-close" data-action="close-composer" aria-label="Close composer"${pendingAttr}>×</button>`,
        `</div>`,
        `<div class="composer-body"><textarea class="field" id="composer-body" placeholder="Type your reply…"${pendingAttr}>${esc(composer.body)}</textarea></div>`,
        `<div class="composer-foot">${composerFooter}</div>`,
        `</div>`,
      ].join('')
    : '';

  detailPane.innerHTML = [
    `<div class="mail-read">`,
    `<div class="chips">`,
    `<span class="chip" style="background:${tint(tc, '20%')};color:${tc}">${esc(selected.type)}</span>`,
    isActionable
      ? `<span class="chip" style="background:oklch(0.3 0.1 25);color:oklch(0.82 0.16 25)">action required</span>`
      : '',
    `<span class="time">${esc(mailAgeStr(selected.ts))}</span>`,
    `</div>`,
    `<h1>${esc(selected.subject)}</h1>`,
    `<div class="mail-from">`,
    `<span class="av" style="background:${tint(senderColor, '20%')};color:${senderColor}">${esc(roleInitials(selected.sender))}</span>`,
    `<div><div class="who">${esc(selected.sender)}</div><div class="route">→ ${esc(selected.recipient)}</div></div>`,
    `</div>`,
    `<div class="mail-body">${esc(selected.renderedBody)}</div>`,
    payloadHtml,
    actionsHtml,
    composerHtml,
    `</div>`,
  ].join('');

  const textarea = document.getElementById('composer-body') as HTMLTextAreaElement | null;
  if (textarea) {
    textarea.addEventListener('input', () => {
      void window.coShell.mailUpdateComposer('body', textarea.value);
    });
    textarea.focus();
  }
}

function renderMail(state: MailState): void {
  const prevState = latestMailState;
  latestMailState = state;
  renderMailSidebar(state);
  renderMailDetail(state, prevState);
  const totalActionables = state.inbox.filter((r) => r.kind === 'actionable').length;
  setBadge('mail-badge', totalActionables);
}

// ── Review (the SH-1 human gate: diff + locked acceptance criteria → PASS / ISSUES) ───────────────

function reviewAgeStr(ts: number): string {
  const age = Math.floor((Date.now() - ts) / 60000);
  if (age < 60) return `${age}m`;
  if (age < 1440) return `${Math.floor(age / 60)}h`;
  return `${Math.floor(age / 1440)}d`;
}

function renderDiffLines(patch: string): string {
  if (!patch) return '<span class="diff-hunk">(no changes)</span>';
  return patch
    .split('\n')
    .map((line) => {
      if (line.startsWith('+')) return `<span class="diff-add">${esc(line)}</span>`;
      if (line.startsWith('-')) return `<span class="diff-remove">${esc(line)}</span>`;
      if (line.startsWith('@@')) return `<span class="diff-hunk">${esc(line)}</span>`;
      return esc(line);
    })
    .join('\n');
}

/** A `review_request` mail carries its review id in the idempotency key (`review-request:<id>`). */
function reviewIdFromMailRow(row: MailRow): string | null {
  const key = row.idempotencyKey;
  if (key != null && key.startsWith('review-request:')) return key.slice('review-request:'.length);
  return null;
}

function renderReviewDetail(context: SelectedContext, composer: VerdictComposer): string {
  if (context == null) {
    return `<div class="empty-inline"><span class="glyph">✓</span><span class="lead">Select a review to inspect it</span></div>`;
  }
  if (context.status === 'loading') {
    return `<div class="empty-inline"><span class="lead">Loading review context…</span></div>`;
  }
  const { value } = context;
  if (value.kind === 'not-found') {
    return `<div class="empty-inline"><span class="lead">Review not found: ${esc(value.reviewId)}</span></div>`;
  }
  if (value.kind === 'conductor-down') {
    return `<div class="empty-inline"><span class="lead">Conductor not running — the app supervises the daemon; check the header daemon badge.</span></div>`;
  }

  const { diff, criteria } = value;
  const canSubmitVerdict = diff.kind === 'patch' && criteria.kind === 'criteria';
  const pendingAttr = composer.pending ? ' disabled' : '';

  let diffHtml: string;
  if (diff.kind === 'unavailable') {
    const reason =
      diff.reason === 'worktree-missing'
        ? 'Worktree not found — the branch may have been cleaned up.'
        : 'Git diff failed — check the conductor logs.';
    diffHtml = `<div class="empty-inline"><span class="lead">${esc(reason)}</span></div>`;
  } else {
    diffHtml = `<pre class="review-diff-pre">${renderDiffLines(diff.patch)}</pre>`;
  }

  let criteriaHtml: string;
  if (criteria.kind === 'no-locked-spec') {
    criteriaHtml = `<div class="empty-inline"><span class="lead">No locked spec — acceptance criteria not available.</span></div>`;
  } else {
    criteriaHtml = criteria.criteria
      .map(
        (c) =>
          `<div class="review-criterion"><div class="rc-text">· ${esc(c.text)}</div>${
            c.verify != null ? `<div class="rc-verify">$ ${esc(c.verify)}</div>` : ''
          }</div>`,
      )
      .join('');
  }

  let verdictBody = '';
  if (composer.active && canSubmitVerdict) {
    verdictBody = [
      `<div class="review-verdict-body">`,
      `<textarea class="review-body-textarea" id="review-composer-body" aria-label="Review verdict notes"${pendingAttr}`,
      ` placeholder="${composer.verdict === 'ISSUES' ? 'Describe the issues…' : 'Optional notes…'}">${esc(composer.body)}</textarea>`,
      `</div>`,
      `<div class="review-verdict-footer">`,
      `<button class="btn btn-ghost" data-review-action="cancel-verdict"${pendingAttr}>Cancel</button>`,
      `<button class="btn ${composer.verdict === 'PASS' ? 'btn-success' : 'btn-danger'}" data-review-action="submit-verdict"${pendingAttr}>Submit ${esc(composer.verdict)}</button>`,
      `</div>`,
    ].join('');
  }

  const verdictActions =
    !composer.active && canSubmitVerdict
      ? [
          `<div class="review-verdict-actions">`,
          `<button class="btn btn-success" data-review-action="begin-pass" aria-label="Submit PASS verdict"${pendingAttr}>PASS</button>`,
          `<button class="btn btn-danger" data-review-action="begin-issues" aria-label="Submit ISSUES verdict"${pendingAttr}>ISSUES</button>`,
          `</div>`,
        ].join('')
      : '';
  const verdictUnavailable = !canSubmitVerdict
    ? `<div class="empty-inline"><span class="lead">Verdict unavailable until the diff and locked criteria load.</span></div>`
    : '';

  return [
    `<div class="review-read">`,
    `<div class="review-block">`,
    `<div class="review-block-hd">Diff · ${esc(value.branch)} → ${esc(value.target)}</div>`,
    diffHtml,
    `</div>`,
    `<div class="review-block">`,
    `<div class="review-block-hd">Acceptance criteria${criteria.kind === 'criteria' ? ` · ${esc(criteria.specRef)}` : ''}</div>`,
    `<div class="review-criteria-list" aria-label="Acceptance criteria">${criteriaHtml}</div>`,
    `</div>`,
    `<div class="review-block">`,
    `<div class="review-block-hd">Verdict</div>`,
    verdictActions,
    verdictUnavailable,
    verdictBody,
    `</div>`,
    `</div>`,
  ].join('');
}

function renderReview(state: ReviewState): void {
  const prevState = latestReviewState;
  latestReviewState = state;

  const reviewList = document.getElementById('review-list');
  if (reviewList) {
    if (state.pending.length === 0) {
      reviewList.innerHTML = `<div class="empty-inline"><span class="glyph">✓</span><span class="lead">No pending reviews</span></div>`;
    } else {
      reviewList.innerHTML = state.pending
        .map((row) => {
          const isSelected = row.reviewId === state.selectedReviewId;
          return [
            `<button class="review-row${isSelected ? ' selected' : ''}" data-review-id="${esc(row.reviewId)}" type="button" role="option" aria-selected="${isSelected ? 'true' : 'false'}">`,
            `<div class="rr-subject">${esc(row.subject)}</div>`,
            `<div class="rr-meta"><span class="rr-sender">${esc(row.sender)}</span><span class="rr-age">${esc(reviewAgeStr(row.ts))}</span></div>`,
            `</button>`,
          ].join('');
        })
        .join('');
    }
  }

  const detailPane = document.getElementById('review-detail-pane');
  if (detailPane) {
    const composerFocused = document.activeElement?.id === 'review-composer-body';
    const needsRebuild = reviewDetailNeedsRebuild(
      prevState != null ? reviewDetailSignature(prevState) : null,
      reviewDetailSignature(state),
      composerFocused,
    );
    if (needsRebuild) detailPane.innerHTML = renderReviewDetail(state.context, state.composer);
  }

  setBadge('review-badge', state.pending.length);
}

// ── Source ──────────────────────────────────────────────────────────────────────

// The current Source view's live branches (from `source:refresh`); the header's branch label reflects the
// repo's actual current branch when known, falling back to the project pill's branch hint.
function sourceBranches(): readonly BranchInfo[] {
  return latestSource?.kind === 'source' ? latestSource.branches : [];
}

function currentBranchName(): string | null {
  const current = sourceBranches().find((b) => b.isCurrent);
  return current?.name ?? projectInfo?.branch ?? null;
}

function renderSource(): void {
  const repoName = document.getElementById('source-repo-name');
  const branchLabel = document.getElementById('source-branch-label');
  if (repoName) repoName.textContent = projectInfo?.name ?? 'repository';
  if (branchLabel) branchLabel.textContent = currentBranchName() ?? '—';

  // Reflect live counts on the tabs (branches + PR refs are the live reads; commits stays deferred).
  const branchCount = sourceBranches().length;
  const prCount = latestSource?.kind === 'source' ? latestSource.pullRequests.length : 0;
  setSourceTabCount('src-branches-count', branchCount);
  setSourceTabCount('src-prs-count', prCount);

  for (const el of document.querySelectorAll<HTMLElement>('.source-tab')) {
    el.classList.toggle('active', el.getAttribute('data-src') === sourceTab);
  }

  const body = document.getElementById('source-body');
  if (!body) return;

  // Named non-source states (Principle 9 — never a blank pane): no project open, the open project's path
  // is unavailable, or the git read failed. These outrank the per-tab views because no repo data exists.
  if (latestSource == null) {
    body.innerHTML = sourceMessage('⎇', 'Loading…', 'Reading branches from the open repository.');
    return;
  }
  if (latestSource.kind === 'no-project') {
    body.innerHTML = sourceMessage(
      '▣',
      'No project open',
      'Open a project from the header to read its branches.',
    );
    return;
  }
  if (latestSource.kind === 'path-missing') {
    body.innerHTML = sourceMessage('⎇', 'Repository path unavailable', esc(latestSource.message));
    return;
  }
  if (latestSource.kind === 'error') {
    body.innerHTML = sourceMessage('⚠', 'Could not read the repository', esc(latestSource.message));
    return;
  }

  // kind === 'source' — real, locally-read data. Branches are the live surface; PRs are local refs only
  // (the gated-PR list over gh+network stays deferred); commits stays the design's honest empty state.
  if (sourceTab === 'branches') {
    body.innerHTML = renderBranchList(latestSource.branches);
  } else if (sourceTab === 'prs') {
    body.innerHTML = renderPullRequestList(latestSource.pullRequests);
  } else {
    body.innerHTML = renderGitGraph([]);
  }
}

function setSourceTabCount(id: string, count: number): void {
  const el = document.getElementById(id);
  if (el) el.textContent = String(count);
}

function sourceMessage(glyph: string, lead: string, sub: string): string {
  return `<div class="empty-inline" style="padding:70px 40px">
      <span class="glyph">${glyph}</span>
      <span class="lead">${lead}</span>
      <span class="sub">${sub}</span>
    </div>`;
}

function renderBranchList(branches: readonly BranchInfo[]): string {
  if (branches.length === 0) {
    return sourceMessage(
      '⎇',
      'No branches',
      'This repository has no branches yet — the first commit creates one.',
    );
  }
  const rows = branches
    .map((b) => {
      const head = b.isCurrent
        ? '<span class="git-ref" style="margin-right:8px">◆ HEAD</span>'
        : '';
      const upstream =
        b.upstream != null ? `<span class="git-author">↑ ${esc(b.upstream)}</span>` : '';
      return `
        <div class="git-row" style="padding:0 18px">
          ${head}
          <span class="git-branch">${esc(b.name)}</span>
          <span class="git-msg">${esc(b.lastCommit.subject)}</span>
          ${upstream}
          <span class="git-sha">${esc(b.lastCommit.sha)}</span>
        </div>`;
    })
    .join('');
  return `<div class="git-graph">${rows}</div>`;
}

function renderPullRequestList(pullRequests: readonly PullRequestInfo[]): string {
  if (pullRequests.length === 0) {
    return sourceMessage(
      '⇄',
      'No pull requests',
      'Locally-fetched PR refs surface here; the gated-PR list over gh + network stays deferred.',
    );
  }
  const rows = pullRequests
    .map(
      (pr) => `
        <div class="git-row" style="padding:0 18px">
          <span class="git-ref" style="margin-right:8px">⇄ #${pr.number}</span>
          <span class="git-branch">${esc(pr.ref)}</span>
          <span class="git-msg">${esc(pr.lastCommit.subject)}</span>
          <span class="git-author">${esc(pr.source)}</span>
          <span class="git-sha">${esc(pr.lastCommit.sha)}</span>
        </div>`,
    )
    .join('');
  return `<div class="git-graph">${rows}</div>`;
}

// Lane-based VS-Code-style git graph (handoff §7). Renders nothing meaningful for an
// empty log today, but the layout math is ready for when commits are wired in.
interface GitCommit {
  sha: string;
  lane: number;
  msg: string;
  author: string;
  initials: string;
  when: string;
  parents: readonly string[];
  refs?: ReadonlyArray<{ t: string; lane: number; head?: boolean }>;
}

const LANE_COLORS: Record<number, string> = {
  0: 'var(--role-lead)',
  1: 'var(--role-coordinator)',
  2: 'var(--role-implementer)',
  3: 'var(--role-reviewer)',
};

function laneColor(lane: number): string {
  return LANE_COLORS[lane % 4] ?? 'var(--role-lead)';
}

function renderGitGraph(commits: readonly GitCommit[]): string {
  if (commits.length === 0) {
    return `<div class="empty-inline" style="padding:70px 40px">
        <span class="glyph">⏂</span>
        <span class="lead">No commit history</span>
        <span class="sub">The git graph renders here once the Conductor exposes commit data.</span>
      </div>`;
  }
  const GH = 44,
    LG = 20,
    LP = 22;
  const xOf = (l: number): number => LP + l * LG;
  const yOf = (i: number): number => i * GH + GH / 2;
  const rowOf: Record<string, number> = {};
  commits.forEach((c, i) => (rowOf[c.sha] = i));
  const maxLane = Math.max(0, ...commits.map((c) => c.lane));
  const graphW = LP + maxLane * LG + LP;
  const graphH = commits.length * GH;
  const gutter = `0 18px 0 ${graphW + 8}px`;

  const edges: string[] = [];
  const nodes: string[] = [];
  commits.forEach((c, i) => {
    if (c.parents.length === 0) {
      edges.push(
        `<path d="M${xOf(c.lane)} ${yOf(i)} L${xOf(c.lane)} ${graphH}" style="fill:none;stroke:${laneColor(c.lane)};stroke-width:2px;stroke-linecap:round"></path>`,
      );
    }
    for (const p of c.parents) {
      const j = rowOf[p];
      if (j === undefined) continue;
      const parent = commits[j];
      if (parent == null) continue;
      const x1 = xOf(c.lane),
        y1 = yOf(i),
        x2 = xOf(parent.lane),
        y2 = yOf(j);
      const col = laneColor(Math.max(c.lane, parent.lane));
      const d =
        c.lane === parent.lane
          ? `M${x1} ${y1} L${x2} ${y2}`
          : `M${x1} ${y1} C ${x1} ${y1 + GH * 0.6} ${x2} ${y2 - GH * 0.6} ${x2} ${y2}`;
      edges.push(
        `<path d="${d}" style="fill:none;stroke:${col};stroke-width:2px;stroke-linecap:round"></path>`,
      );
    }
  });
  commits.forEach((c, i) => {
    nodes.push(
      `<circle cx="${xOf(c.lane)}" cy="${yOf(i)}" r="5" style="fill:${laneColor(c.lane)};stroke:var(--bg-base);stroke-width:2.5px"></circle>`,
    );
  });

  const rows = commits
    .map((c) => {
      const refs = (c.refs ?? [])
        .map((r) => {
          const lc = laneColor(r.lane);
          const bg = r.head ? lc : tint(lc, '16%');
          const fg = r.head ? 'var(--on-accent)' : lc;
          return `<span class="git-ref" style="background:${bg};color:${fg};border:1px solid ${tint(lc, '42%')}">${r.head ? '◆' : '⏂'} ${esc(r.t)}</span>`;
        })
        .join('');
      return `
        <div class="git-row" style="padding:${gutter}">
          ${refs}
          <span class="git-msg">${esc(c.msg)}</span>
          <span class="git-av" style="background:${tint(laneColor(c.lane), '24%')};color:${laneColor(c.lane)}">${esc(c.initials)}</span>
          <span class="git-author">${esc(c.author)}</span>
          <span class="git-sha">${esc(c.sha)}</span>
          <span class="git-when">${esc(c.when)}</span>
        </div>`;
    })
    .join('');

  return `<div class="git-graph">
      <svg width="${graphW}" height="${graphH}">${edges.join('')}${nodes.join('')}</svg>
      ${rows}
    </div>`;
}

// ── Usage ───────────────────────────────────────────────────────────────────────

function renderUsage(state: LimitsCostState): void {
  const container = document.getElementById('usage-content');
  if (!container) return;

  const groups = groupHeadroom(state);
  const providerCards =
    groups.length > 0
      ? groups
          .map((g) => {
            const color = providerColor(g.provider);
            const windows = g.rows
              .map((row) => {
                const known = row.headroom.kind === 'known';
                const pct =
                  known && row.headroom.kind === 'known' ? Math.round(row.headroom.used_pct) : 0;
                const reset =
                  known && row.headroom.kind === 'known'
                    ? `resets in ${resetEta(row.headroom.reset_at)}`
                    : 'no data';
                return `
                <div class="prov-window">
                  <div class="big"><span class="num" style="color:${color}">${known ? `${pct}%` : '—'}</span><span class="unit">${esc(row.windowKind)}</span></div>
                  <div class="track"><div class="fill" style="width:${pct}%;background:${color}"></div></div>
                  <div class="reset">${esc(reset)}</div>
                </div>`;
              })
              .join('');
            return `
            <div class="prov-card">
              <div class="head">
                <span class="dot" style="background:${color}"></span>
                <span class="name">${esc(g.provider)}</span>
                <span class="plan">${esc(g.account)}</span>
              </div>
              <div class="prov-windows">${windows}</div>
            </div>`;
          })
          .join('')
      : `<div class="empty-inline" style="grid-column:1/-1"><span class="lead">No subscription headroom data yet</span></div>`;

  // Activity by agent (cost in USD — the live metric we have today).
  const maxCost = Math.max(0.0001, ...state.agentCosts.map((c) => c.totalCostUsd));
  const activityRows =
    state.agentCosts.length > 0
      ? [...state.agentCosts]
          .sort((a, b) => b.totalCostUsd - a.totalCostUsd)
          .map((c) => {
            const pct = (c.totalCostUsd / maxCost) * 100;
            return `
            <div class="activity-row">
              <div class="top">
                <span class="name">${esc(c.id)}</span>
                <span class="num">$${c.totalCostUsd.toFixed(4)}</span>
              </div>
              <div class="track"><div class="fill" style="width:${pct}%;background:var(--accent)"></div></div>
            </div>`;
          })
          .join('')
      : `<div class="empty-inline"><span class="lead">No turns run yet</span></div>`;

  const totalCost = state.agentCosts.reduce((s, c) => s + c.totalCostUsd, 0);
  const taskTotal = state.taskCosts.reduce((s, c) => s + c.totalCostUsd, 0);
  const throughput = [
    {
      k: 'Agents with usage',
      v: String(state.agentCosts.length),
      size: '20px',
      color: 'var(--text-hi)',
    },
    {
      k: 'Total agent cost',
      v: `$${totalCost.toFixed(2)}`,
      size: '14px',
      color: 'oklch(0.85 0.005 262)',
    },
    {
      k: 'Tasks tracked',
      v: String(state.taskCosts.length),
      size: '14px',
      color: 'oklch(0.85 0.005 262)',
    },
    {
      k: 'Total task cost',
      v: `$${taskTotal.toFixed(2)}`,
      size: '14px',
      color: 'oklch(0.78 0.13 150)',
    },
  ]
    .map(
      (t) =>
        `<div class="row"><span class="k">${esc(t.k)}</span><span class="v" style="font-size:${t.size};color:${t.color}">${esc(t.v)}</span></div>`,
    )
    .join('');

  container.innerHTML = `
    <div class="usage-providers">${providerCards}</div>
    <div class="usage-grid">
      <div class="panel">
        <div class="panel-hd"><span class="ttl">Activity by agent</span><span class="meta">cost · usd</span></div>
        <div class="panel-body" style="padding:13px 15px">${activityRows}</div>
      </div>
      <div class="panel" style="padding:16px 17px">
        <div class="ttl" style="font-size:13px;font-weight:600;color:oklch(0.92 0.004 262);margin-bottom:16px">Throughput</div>
        <div class="throughput">${throughput}
          <div class="note">The balancer pins roles to providers and paces when a 5-hour window runs low. Subscription-only — no spend caps, just headroom.</div>
        </div>
      </div>
    </div>`;
}

// ── Settings ──────────────────────────────────────────────────────────────────

function settingSourceLabel(row: SettingsRow, activeLayer: SettingsLayer): string {
  if (row.source === 'inherited') return 'inherited';
  if (row.source === 'default') return 'default';
  return activeLayer === 'project' ? 'project override' : 'set';
}

function renderSettingControl(row: SettingsRow): string {
  const d = row.descriptor;
  const c = d.control;
  const dis = row.disabledReason != null ? 'disabled' : '';
  const key = esc(d.key);
  switch (c.kind) {
    case 'toggle': {
      const on = row.effectiveValue === true;
      return `<label class="set-switch"><input type="checkbox" data-setting-key="${key}" data-control="toggle" ${on ? 'checked' : ''} ${dis}/><span></span></label>`;
    }
    case 'integer': {
      const v = typeof row.effectiveValue === 'number' ? String(row.effectiveValue) : '';
      const max = c.max != null ? `max="${c.max}"` : '';
      const unit = c.unit != null ? `<span class="set-unit">${esc(c.unit)}</span>` : '';
      return `<span class="set-int"><input type="number" data-setting-key="${key}" data-control="integer" value="${esc(v)}" min="${c.min}" ${max} ${dis}/>${unit}</span>`;
    }
    case 'enum': {
      const cur = typeof row.effectiveValue === 'string' ? row.effectiveValue : '';
      const clearOpt = c.clearable === true ? `<option value="">Auto-detect</option>` : '';
      const opts = c.options
        .map(
          (o) =>
            `<option value="${esc(o.value)}" ${o.value === cur ? 'selected' : ''}>${esc(o.label)}</option>`,
        )
        .join('');
      return `<select data-setting-key="${key}" data-control="enum" data-clearable="${c.clearable === true ? '1' : '0'}" ${dis}>${clearOpt}${opts}</select>`;
    }
    case 'provider-set': {
      const arr = Array.isArray(row.effectiveValue)
        ? (row.effectiveValue as unknown[]).map(String)
        : [];
      const boxes = c.providers
        .map(
          (p) =>
            `<label class="set-chip"><input type="checkbox" data-provider="${esc(p)}" ${arr.includes(p) ? 'checked' : ''} ${dis}/>${esc(p)}</label>`,
        )
        .join('');
      return `<span class="set-providers" data-setting-key="${key}" data-control="provider-set">${boxes}</span>`;
    }
    case 'persona': {
      const v =
        row.effectiveValue != null && typeof row.effectiveValue === 'object'
          ? (row.effectiveValue as { name?: string; email?: string })
          : {};
      return `<span class="set-persona" data-setting-key="${key}" data-control="persona"><input type="text" data-persona-field="name" placeholder="Name" value="${esc(v.name ?? '')}" ${dis}/><input type="email" data-persona-field="email" placeholder="email@example.com" value="${esc(v.email ?? '')}" ${dis}/></span>`;
    }
    case 'model-tier': {
      const obj = (v: unknown): Record<string, unknown> =>
        v != null && typeof v === 'object' ? (v as Record<string, unknown>) : {};
      // Only the ACTIVE layer's explicit override should fill the input value; an inherited/default
      // value is shown as a placeholder so editing one tier creates a partial override of JUST that
      // tier (it must NOT silently pin the other tiers' current defaults — review finding).
      const explicit = row.source === 'override' ? obj(row.effectiveValue) : {};
      const effective = obj(row.effectiveValue);
      const def = obj(d.defaultValue);
      const listId = `co-models-${esc(c.provider)}`;
      const datalist = `<datalist id="${listId}">${c.suggestions
        .map((s) => `<option value="${esc(s)}"></option>`)
        .join('')}</datalist>`;
      const inputs = c.tiers
        .map((t) => {
          const own = Object.prototype.hasOwnProperty.call(explicit, t.key) ? explicit[t.key] : '';
          const value = own != null && own !== '' ? String(own) : '';
          const placeholder = String(effective[t.key] ?? def[t.key] ?? '');
          return `<label class="set-model"><span>${esc(t.label)}</span><input type="text" list="${listId}" data-tier="${esc(t.key)}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${dis}/></label>`;
        })
        .join('');
      // A per-project override REPLACES the whole table for this provider (config keys don't deep-merge
      // across layers). When the current values are inherited from the global layer, say so — otherwise
      // the placeholders read like a promise that a partial override would silently break.
      const hint =
        row.source === 'inherited'
          ? `<div class="set-note">Setting any tier creates a per-project override that replaces the inherited table; tiers you leave blank then use the built-in default.</div>`
          : '';
      return `<span class="set-models" data-setting-key="${key}" data-control="model-tier">${datalist}${inputs}${hint}</span>`;
    }
    default: {
      // Exhaustiveness guard: a new SettingControl kind without a case here is a compile error,
      // and an unknown kind renders a visible marker rather than nothing (Principle 9).
      const exhaustive: never = c;
      return `<span class="set-note">Unsupported control: ${esc((exhaustive as { kind?: string }).kind ?? 'unknown')}</span>`;
    }
  }
}

function renderSettingRow(row: SettingsRow, activeLayer: SettingsLayer): string {
  const d = row.descriptor;
  const reset = row.canReset
    ? `<button class="set-reset" data-setting-reset="${esc(d.key)}" title="Reset to inherited/default">↺</button>`
    : '';
  const note =
    row.disabledReason != null ? `<div class="set-note">${esc(row.disabledReason)}</div>` : '';
  return `
    <div class="set-row${row.disabledReason != null ? ' disabled' : ''}">
      <div class="set-meta">
        <div class="set-label">${esc(d.label)}<span class="set-source set-source-${row.source}">${esc(settingSourceLabel(row, activeLayer))}</span></div>
        <div class="set-desc">${esc(d.description)}</div>
        ${note}
      </div>
      <div class="set-control">${renderSettingControl(row)}${reset}</div>
    </div>`;
}

function renderSettings(state: SettingsState): void {
  const container = document.getElementById('settings-content');
  if (!container) return;
  const sections: { title: string; rows: SettingsRow[] }[] = [];
  for (const row of state.rows) {
    let group = sections.find((s) => s.title === row.descriptor.section);
    if (group == null) {
      group = { title: row.descriptor.section, rows: [] };
      sections.push(group);
    }
    group.rows.push(row);
  }
  const toggle = `
    <div class="set-layer-toggle" role="tablist">
      <button class="set-layer${state.activeLayer === 'project' ? ' active' : ''}${state.hasProject ? '' : ' disabled'}" data-settings-layer="project" role="tab">This project</button>
      <button class="set-layer${state.activeLayer === 'global' ? ' active' : ''}" data-settings-layer="global" role="tab">All projects</button>
    </div>`;
  const body = sections
    .map(
      (s) => `
      <section class="set-section">
        <h2>${esc(s.title)}</h2>
        ${s.rows.map((r) => renderSettingRow(r, state.activeLayer)).join('')}
      </section>`,
    )
    .join('');
  container.innerHTML = `${toggle}${body}`;
}

function revertSettings(): void {
  if (latestSettingsState != null) renderSettings(latestSettingsState);
}

function applySettingSet(key: string, value: unknown): void {
  const layer: SettingsLayer = latestSettingsState?.activeLayer ?? 'project';
  void window.coShell
    .settingsSet(layer, key, value)
    .then((res) => {
      if (!res.ok) {
        flashToast(res.error ?? 'Invalid value');
        revertSettings(); // restore the input to the last good effective value
      }
      // On success the settings:state push re-renders with the new effective value + source badge.
    })
    .catch((err: unknown) => {
      flashToast(String(err));
      revertSettings();
    });
}

function applySettingClear(key: string): void {
  const layer: SettingsLayer = latestSettingsState?.activeLayer ?? 'project';
  void window.coShell
    .settingsClear(layer, key)
    .then((res) => {
      if (!res.ok) flashToast(res.error ?? 'Could not reset this setting');
      // On success the settings:state push re-renders.
    })
    .catch((err: unknown) => flashToast(String(err)));
}

/** Read the edited value (or a clear signal) out of a settings control's DOM. */
function settingChangeValue(container: HTMLElement): { clear: boolean; value?: unknown } {
  switch (container.dataset['control']) {
    case 'toggle':
      return { clear: false, value: (container as HTMLInputElement).checked };
    case 'integer': {
      const raw = (container as HTMLInputElement).value.trim();
      return raw === '' ? { clear: true } : { clear: false, value: Number(raw) };
    }
    case 'enum': {
      const v = (container as HTMLSelectElement).value;
      if (v === '' && container.dataset['clearable'] === '1') return { clear: true };
      return { clear: false, value: v };
    }
    case 'provider-set':
      return {
        clear: false,
        value: [...container.querySelectorAll<HTMLInputElement>('input[data-provider]')]
          .filter((i) => i.checked)
          .map((i) => i.dataset['provider'] as string),
      };
    case 'persona': {
      const name =
        container
          .querySelector<HTMLInputElement>('input[data-persona-field="name"]')
          ?.value.trim() ?? '';
      const email =
        container
          .querySelector<HTMLInputElement>('input[data-persona-field="email"]')
          ?.value.trim() ?? '';
      return name === '' && email === ''
        ? { clear: true }
        : { clear: false, value: { name, email } };
    }
    case 'model-tier': {
      const obj: Record<string, string> = {};
      for (const input of container.querySelectorAll<HTMLInputElement>('input[data-tier]')) {
        const v = input.value.trim();
        if (v !== '') obj[input.dataset['tier'] as string] = v;
      }
      return Object.keys(obj).length === 0 ? { clear: true } : { clear: false, value: obj };
    }
    default:
      return { clear: false };
  }
}

function bindSettingsView(): void {
  const root = document.getElementById('view-settings');
  if (root == null) return;

  root.addEventListener('click', (e) => {
    const layerBtn = (e.target as HTMLElement).closest<HTMLElement>('[data-settings-layer]');
    if (layerBtn != null && !layerBtn.classList.contains('disabled')) {
      const layer = layerBtn.dataset['settingsLayer'];
      if (layer === 'global' || layer === 'project') {
        void window.coShell
          .settingsSetLayer(layer)
          .then((s) => {
            if (s != null) {
              latestSettingsState = s;
              renderSettings(s);
            }
          })
          .catch((err: unknown) => flashToast(String(err)));
      }
      return;
    }
    const resetBtn = (e.target as HTMLElement).closest<HTMLElement>('[data-setting-reset]');
    if (resetBtn?.dataset['settingReset'] != null)
      applySettingClear(resetBtn.dataset['settingReset']);
  });

  root.addEventListener('change', (e) => {
    const container = (e.target as HTMLElement).closest<HTMLElement>('[data-setting-key]');
    const key = container?.dataset['settingKey'];
    if (container == null || key == null) return;
    const { clear, value } = settingChangeValue(container);
    if (clear) applySettingClear(key);
    else applySettingSet(key, value);
  });
}

// ── Bootstrap ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const bridge = window.coShell;

  // Preload IBM Plex Mono so the live terminal builds on a stable monospace grid (anti-warp, #40).
  preloadTerminalFont();

  // Derive the header pill's project identity from a projectId + optional path: prefer the repo dir name
  // from the path (the operator's mental model), falling back to the id.
  function applyCurrentProject(state: CurrentProjectState): void {
    const previousProjectId = projectInfo?.id ?? null;
    const nextProjectId = state?.projectId ?? null;
    if (state == null) {
      projectInfo = null;
    } else {
      const path = state.path;
      const name =
        path != null && path.length > 0
          ? (path.split(/[/\\]/).filter(Boolean).pop() ?? state.projectId)
          : state.projectId;
      projectInfo = { id: state.projectId, name };
    }
    if (previousProjectId !== nextProjectId) {
      latestConnection = null;
      latestDashboard = null;
      latestMailState = null;
      latestAgentsState = null;
      latestReviewState = null;
      latestLimitsState = null;
      latestDaemon = null;
      latestSource = null;
      sourceRefreshGeneration += 1;
      reviewInvokeGeneration += 1;
      latestArchive = [];
      pendingDeleteId = null;
      pendingArchivePurgeId = null;
      activeRewakeAgentId = null;
      activeRewakeDraft = '';
      knownMailBuses.clear();
      knownMailBuses.add(OPERATOR_BUS);
      lastAgentId = null;
      lastTranscript = '';
      archiveRefreshGeneration += 1;
      renderDashboard();
      renderAgents(EMPTY_AGENTS_STATE);
      latestAgentsState = null;
      renderMail(EMPTY_MAIL_STATE);
      latestMailState = null;
      renderReview(EMPTY_REVIEW_STATE);
      latestReviewState = null;
      renderLimitsPopover(EMPTY_LIMITS_STATE);
      renderLimitsSummary();
      renderUsage(EMPTY_LIMITS_STATE);
      renderSource();
      latestLimitsState = null;
    }
    renderHeader();
    // A project change means the open repo changed — re-read its branches.
    void refreshSource();
  }

  // Initial project identity (covers the startup race before the first `project:current` push lands).
  void bridge.projectInfo?.().then((info) => {
    if (info != null && projectInfo == null) {
      applyCurrentProject({ projectId: info.id, path: null });
    }
  });

  // Live current-project pushes (open / switch / no-project) from the controller.
  bridge.onCurrentProject?.(applyCurrentProject);

  // Live daemon lifecycle pushes (starting → healthy → restarting → failed → stopped) for the header pill.
  bridge.onDaemonStatus?.((payload) => {
    latestDaemon = payload;
    renderHeader();
  });

  // Controller-surfaced errors (e.g. an "Open project" register/open failure) — Principle 9 visible.
  bridge.onAppError?.((message) => showAppError(message));

  // Read the open repo's branches / local PR refs for the Source view.
  async function refreshSource(): Promise<void> {
    const generation = ++sourceRefreshGeneration;
    const source = (await bridge.refreshSource?.()) ?? null;
    if (generation !== sourceRefreshGeneration) return;
    latestSource = source;
    renderSource();
  }
  void refreshSource();

  function applyReviewResult(promise: Promise<ReviewState | null>): void {
    const generation = reviewInvokeGeneration;
    void promise.then((state) => {
      if (generation !== reviewInvokeGeneration || state == null) return;
      renderReview(state);
    });
  }

  // Project pill → the in-app "Open project" on-ramp (directory picker → register → start daemon + shell).
  document.getElementById('project-pill')?.addEventListener('click', () => {
    void bridge.openProject?.();
  });

  // Daemon pill → Retry a FAILED daemon start (the one retryable state). No-op for other states.
  document.getElementById('daemon-pill')?.addEventListener('click', () => {
    if (latestDaemon?.status !== 'failed') return;
    void bridge.daemonRetry?.().then((r) => {
      if (!r.ok && r.error != null) showAppError(r.error);
    });
  });

  // Nav clicks
  document.getElementById('nav-rail')?.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('.nav-item');
    if (item?.classList.contains('disabled')) return;
    const view = item?.dataset['view'];
    if (isNavView(view)) {
      activateView(view);
      bridge.navigate(view);
    }
  });

  bridge.onNavState((state) => {
    if (isNavView(state.activeView)) activateView(state.activeView);
  });

  bridge.onConnectionState((state) => {
    latestConnection = state;
    renderHeader();
    renderDashboard();
  });
  bridge.onConnectionError((message) => showAppError(message));

  // Fetch the archive list on every dashboard push and re-render once it arrives.
  // Loop-avoidance: archiveList() resolves to a plain data fetch — it does NOT push another
  // dashboard:state event, so this callback is not re-entered. We only re-render if the
  // serialised value actually changed (cheap JSON compare on small lists). The generation guard keeps
  // older in-flight reads from overwriting a newer post-Restore/Purge refresh.
  const refreshArchive = (): void => {
    const generation = ++archiveRefreshGeneration;
    void bridge.archiveList().then((a) => {
      if (generation !== archiveRefreshGeneration) return;
      const next = JSON.stringify(a);
      if (JSON.stringify(latestArchive) !== next) {
        latestArchive = a;
        renderDashboard();
      }
    });
  };

  bridge.onDashboardState((state) => {
    latestDashboard = state;
    rememberMailBuses(state);
    renderHeader();
    renderDashboard();
    if (latestMailState != null) renderMail(latestMailState);
    refreshArchive();
  });

  // ── Mail ──────────────────────────────────────────────────────────────────────
  bridge.onMailState((state) => renderMail(state));
  bridge.onMailError((message) => {
    const detailPane = document.getElementById('mail-detail-pane');
    if (!detailPane) return;
    const toast = document.createElement('div');
    toast.className = 'inline-error-toast';
    toast.textContent = message;
    detailPane.prepend(toast);
    setTimeout(() => toast.remove(), 5000);
  });
  void bridge.mailRefresh();

  // ── Limits / Usage ──────────────────────────────────────────────────────────
  bridge.onLimitsCostState((state) => {
    latestLimitsState = state;
    renderLimitsPopover(state);
    renderLimitsSummary();
    renderUsage(state);
  });
  void bridge.refreshLimitsCost();

  // Header limits popover toggle
  const limitsBtn = document.getElementById('limits-btn');
  const limitsPopover = document.getElementById('limits-popover');
  limitsBtn?.addEventListener('click', () => {
    const isOpen = limitsPopover != null && !limitsPopover.hasAttribute('hidden');
    if (isOpen) {
      limitsPopover?.setAttribute('hidden', '');
      limitsBtn.classList.remove('open');
      limitsBtn.setAttribute('aria-expanded', 'false');
    } else {
      limitsPopover?.removeAttribute('hidden');
      limitsBtn.classList.add('open');
      limitsBtn.setAttribute('aria-expanded', 'true');
    }
  });
  document.addEventListener('click', (e) => {
    const wrapper = document.getElementById('limits-wrapper');
    if (wrapper == null || limitsPopover == null) return;
    if (!wrapper.contains(e.target as Node)) {
      limitsPopover.setAttribute('hidden', '');
      limitsBtn?.classList.remove('open');
      limitsBtn?.setAttribute('aria-expanded', 'false');
    }
  });

  const openFleetRow = (id: string): void => {
    activateView('agents');
    bridge.navigate('agents');
    void bridge.agentsSelect(id);
  };

  const focusDashboardAgentAction = (agentAction: string, agentId: string): void => {
    for (const control of document.querySelectorAll<HTMLElement>('[data-agent-action]')) {
      if (
        control.dataset['agentAction'] === agentAction &&
        control.dataset['agentId'] === agentId
      ) {
        control.focus();
        return;
      }
    }
  };

  const focusDashboardArchiveAction = (archiveAction: string, archiveId: string): void => {
    for (const control of document.querySelectorAll<HTMLElement>('[data-archive-action]')) {
      if (
        control.dataset['archiveAction'] === archiveAction &&
        control.dataset['archiveId'] === archiveId
      ) {
        control.focus();
        return;
      }
    }
  };

  // ── Mission Control interactions ──────────────────────────────────────────────
  document.getElementById('view-dashboard')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    // ── Per-coordinator Delete (two-step in-app confirm) ──────────────────────
    const agentActionBtn = target.closest<HTMLElement>('[data-agent-action]');
    if (agentActionBtn?.dataset['agentId'] != null) {
      e.stopPropagation();
      const agentAction = agentActionBtn.dataset['agentAction'];
      const agentId = agentActionBtn.dataset['agentId'];
      if (agentAction === 'delete') {
        pendingDeleteId = agentId;
        renderDashboard();
        focusDashboardAgentAction('delete-cancel', agentId);
      } else if (agentAction === 'delete-cancel') {
        pendingDeleteId = null;
        renderDashboard();
      } else if (agentAction === 'delete-confirm') {
        pendingDeleteId = null;
        renderDashboard();
        void bridge.agentsDelete(agentId).then((r) => {
          if (!r.ok) showAppError(r.error ?? 'Failed to delete the coordinator');
        });
      }
      return;
    }

    // Reset any pending-confirm button when clicking elsewhere in the dashboard.
    if (pendingDeleteId != null) {
      pendingDeleteId = null;
      renderDashboard();
      return;
    }

    // ── Archive actions (Restore / Purge) ────────────────────────────────────
    const archiveBtn = target.closest<HTMLElement>('[data-archive-action]');
    if (archiveBtn?.dataset['archiveId'] != null) {
      e.stopPropagation();
      const archiveAction = archiveBtn.dataset['archiveAction'];
      const archiveId = archiveBtn.dataset['archiveId'];
      if (archiveAction === 'restore') {
        pendingArchivePurgeId = null;
        void bridge.archiveRestore(archiveId).then((r) => {
          if (!r.ok) showAppError(r.error ?? 'Failed to restore the archived branch');
          else refreshArchive();
        });
      } else if (archiveAction === 'purge') {
        pendingArchivePurgeId = archiveId;
        renderDashboard();
        focusDashboardArchiveAction('purge-cancel', archiveId);
      } else if (archiveAction === 'purge-cancel') {
        pendingArchivePurgeId = null;
        renderDashboard();
      } else if (archiveAction === 'purge-confirm') {
        pendingArchivePurgeId = null;
        renderDashboard();
        void bridge.archivePurge(archiveId).then((r) => {
          if (!r.ok) showAppError(r.error ?? 'Failed to purge the archived branch');
          else refreshArchive();
        });
      }
      return;
    }

    if (pendingArchivePurgeId != null) {
      pendingArchivePurgeId = null;
      renderDashboard();
      return;
    }

    const fleetOpen = target.closest<HTMLElement>('.fleet-row-open');
    if (fleetOpen?.dataset['agentId'] != null) {
      openFleetRow(fleetOpen.dataset['agentId']);
      return;
    }

    const actionCard = target.closest<HTMLElement>('.action-card');
    if (actionCard?.dataset['mailSeq'] != null) {
      activateView('mail');
      bridge.navigate('mail');
      void bridge.mailSelect(Number(actionCard.dataset['mailSeq']));
      return;
    }

    const mcBtn = target.closest<HTMLElement>('[data-mc-action]');
    if (mcBtn) {
      const action = mcBtn.dataset['mcAction'];
      if (action === 'console') {
        activateView('agents');
        bridge.navigate('agents');
      } else if (action === 'mail') {
        activateView('mail');
        bridge.navigate('mail');
      } else if (action === 'pause') {
        flashToast('Pause all — not yet wired');
      } else if (action === 'clear-finished') {
        if (latestDashboard != null) {
          for (const id of clearableAgentIds(latestDashboard.tree)) dismissedAgents.add(id);
          persistDismissedAgents();
          renderDashboard();
          if (latestMailState != null) renderMailSidebar(latestMailState);
        }
      } else if (action === 'show-hidden') {
        dismissedAgents.clear();
        persistDismissedAgents();
        renderDashboard();
        if (latestMailState != null) renderMailSidebar(latestMailState);
      }
    }
  });

  // Session start (kickoff composer)
  document.getElementById('session-start-form')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('#session-demo-spec')) {
      // P-ON3 — one-click launch a coordinator from the bundled predesigned demo spec (no terminal). The
      // main process reads dist/renderer/demo-spec.md and starts a root session from its body.
      const nameInput = document.getElementById('session-name-input') as HTMLInputElement | null;
      const nameVal =
        (nameInput?.value.trim() ?? '').length > 0 ? (nameInput?.value.trim() ?? '') : null;
      void bridge.sessionStartFromDemoSpec?.(nameVal).then((r) => {
        if (r.ok) flashToast('Launching coordinator from the demo spec…');
        else showAppError(r.error ?? 'Failed to start from the demo spec');
      });
      return;
    }
    if (!target.closest('#session-start-btn')) return;
    const textarea = document.getElementById('session-prompt-input') as HTMLTextAreaElement | null;
    const nameInput = document.getElementById('session-name-input') as HTMLInputElement | null;
    const promptVal =
      (textarea?.value.trim() ?? '').length > 0 ? (textarea?.value.trim() ?? '') : null;
    const nameVal =
      (nameInput?.value.trim() ?? '').length > 0 ? (nameInput?.value.trim() ?? '') : null;
    if (nameVal == null) {
      showAppError('Coordinator name is required.');
      nameInput?.focus();
      return;
    }
    void bridge.sessionStart(promptVal, null, nameVal).then((r) => {
      if (r.ok) {
        if (textarea) textarea.value = '';
        if (nameInput) nameInput.value = '';
      } else if (!r.ok) showAppError(r.error ?? 'Failed to start coordinator session');
    });
  });

  // ── Agents Console ──────────────────────────────────────────────────────────
  bridge.onAgentsConsoleState((state) => renderAgents(state));

  document.getElementById('view-agents')?.addEventListener('input', (e) => {
    const target = e.target as HTMLElement;
    if (target instanceof HTMLTextAreaElement && target.classList.contains('rewake-input')) {
      activeRewakeDraft = target.value;
    }
  });

  document.getElementById('view-agents')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    const rewakeComposer = target.closest<HTMLElement>('.rewake-composer');
    if (rewakeComposer != null) {
      e.stopPropagation();
      const agentId = rewakeComposer.dataset['agentId'] ?? activeRewakeAgentId;
      if (target.closest('.rewake-cancel')) {
        activeRewakeAgentId = null;
        activeRewakeDraft = '';
        if (latestAgentsState != null) renderAgents(latestAgentsState);
        return;
      }
      if (target.closest('.rewake-send') && agentId != null) {
        const textarea = rewakeComposer.querySelector<HTMLTextAreaElement>('.rewake-input');
        const text = textarea?.value.trim() ?? activeRewakeDraft.trim();
        if (!text) return;
        void bridge.agentsRewake(agentId, text).then((r) => {
          if (r.ok) {
            activeRewakeAgentId = null;
            activeRewakeDraft = '';
            if (latestAgentsState != null) renderAgents(latestAgentsState);
          } else {
            showTranscriptError(r.error);
          }
        });
        return;
      }
    }

    const agentBtn = target.closest<HTMLElement>('[data-agent-action]');
    if (agentBtn?.dataset['agentId'] != null) {
      e.stopPropagation();
      const agentAction = agentBtn.dataset['agentAction'];
      const agentId = agentBtn.dataset['agentId'];
      if (agentAction === 'stop') {
        void bridge.agentsStop(agentId).then((r) => {
          if (!r.ok) showTranscriptError(r.error);
        });
      } else if (agentAction === 'unstick') {
        void bridge.agentsUnstick(agentId).then((r) => {
          if (!r.ok) showTranscriptError(r.error);
        });
      } else if (agentAction === 'rewake') {
        syncActiveRewakeDraft();
        activeRewakeDraft = activeRewakeAgentId === agentId ? activeRewakeDraft : '';
        activeRewakeAgentId = agentId;
        if (latestAgentsState != null) renderAgents(latestAgentsState);
        document.querySelector<HTMLTextAreaElement>('.rewake-input')?.focus();
      }
      return;
    }

    const rowOpen = target.closest<HTMLElement>('.sess-row-open');
    if (rowOpen?.dataset['agentId'] != null) {
      void bridge.agentsSelect(rowOpen.dataset['agentId']);
      return;
    }

    const btn = target.closest<HTMLElement>('#steer-bar .btn');
    if (!btn) return;
    const action = btn.dataset['action'];
    const selectedAgentId = latestAgentsState?.selectedAgentId;
    if (!selectedAgentId) return;
    const steerInput = document.getElementById('steer-input') as HTMLTextAreaElement | null;
    const text = steerInput?.value.trim() ?? '';

    switch (action) {
      case 'answer':
        if (!text) return;
        void bridge.agentsSteer(selectedAgentId, { kind: 'answer', text }).then((r) => {
          if (!r.ok) showTranscriptError(r.error);
          else if (steerInput) steerInput.value = '';
        });
        break;
      case 'redirect':
        if (!text) return;
        void bridge.agentsSteer(selectedAgentId, { kind: 'redirect', text }).then((r) => {
          if (!r.ok) showTranscriptError(r.error);
          else if (steerInput) steerInput.value = '';
        });
        break;
      case 'interrupt':
        void bridge.agentsSteer(selectedAgentId, { kind: 'interrupt' }).then((r) => {
          if (!r.ok) showTranscriptError(r.error);
        });
        break;
    }
  });

  // ── Mail interactions ─────────────────────────────────────────────────────────
  document.getElementById('view-mail')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    const row = target.closest<HTMLElement>('.mail-row');
    if (row?.dataset['seq'] != null) {
      void bridge.mailSelect(Number(row.dataset['seq']));
      return;
    }

    const busOption = target.closest<HTMLElement>('[data-bus]');
    if (busOption?.dataset['bus'] != null) {
      void bridge.mailSelectBus(busOption.dataset['bus']);
      return;
    }

    const tab = target.closest<HTMLElement>('[data-tab]');
    if (tab?.dataset['tab'] != null) {
      const tabVal = tab.dataset['tab'];
      if (tabVal === 'inbox' || tabVal === 'outbox') void bridge.mailSelectTab(tabVal);
      return;
    }

    if (target.closest('#mail-compose')) {
      flashToast('Compose — open a message to reply');
      return;
    }

    const btn = target.closest<HTMLElement>('[data-action]');
    if (!btn) return;
    const action = btn.dataset['action'];
    const seq = btn.dataset['seq'] != null ? Number(btn.dataset['seq']) : null;

    switch (action) {
      case 'approve':
        if (seq != null) void bridge.mailQuickApprove(seq);
        break;
      case 'decline':
        if (seq != null) void bridge.mailQuickDecline(seq);
        break;
      case 'open-composer':
        if (seq != null) {
          void bridge.mailOpenComposer(
            seq,
            btn.dataset['recipient'] ?? '',
            btn.dataset['type'] ?? 'clarify_response',
            btn.dataset['subject'] ?? '',
          );
        }
        break;
      case 'close-composer':
        void bridge.mailCloseComposer();
        break;
      case 'submit-reply':
        void bridge.mailSubmitReply();
        break;
      case 'approve-with-composer':
        if (seq != null) void bridge.mailApproveWithComposer(seq);
        break;
      case 'decline-with-composer':
        if (seq != null) void bridge.mailDeclineWithComposer(seq);
        break;
      case 'open-review': {
        bridge.navigate('review');
        const reviewId = btn.dataset['reviewId'];
        if (reviewId != null) applyReviewResult(bridge.reviewSelect(reviewId));
        else applyReviewResult(bridge.reviewRefresh());
        break;
      }
    }
  });

  document.getElementById('view-mail')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = (e.target as HTMLElement).closest<HTMLElement>('.mail-row');
    if (row?.dataset['seq'] == null) return;
    e.preventDefault();
    void bridge.mailSelect(Number(row.dataset['seq']));
  });

  // ── Review (the SH-1 human gate) ───────────────────────────────────────────────
  bridge.onReviewState((state) => renderReview(state));
  bridge.onReviewError((message) => showAppError(message));
  applyReviewResult(bridge.reviewRefresh());

  // ── Settings ──────────────────────────────────────────────────────────────────
  bridge.onSettingsState((state) => {
    latestSettingsState = state;
    renderSettings(state);
  });
  void bridge.settingsGetState().then((state) => {
    if (state != null) {
      latestSettingsState = state;
      renderSettings(state);
    }
  });
  bindSettingsView();

  const handleReviewSelect = (reviewId: string): void => {
    applyReviewResult(bridge.reviewSelect(reviewId));
  };

  document.getElementById('view-review')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    const row = target.closest<HTMLElement>('.review-row');
    if (row?.dataset['reviewId'] != null) {
      handleReviewSelect(row.dataset['reviewId']);
      return;
    }

    const btn = target.closest<HTMLElement>('[data-review-action]');
    if (!btn) return;
    switch (btn.dataset['reviewAction']) {
      case 'begin-pass':
        applyReviewResult(bridge.reviewBeginVerdict('PASS'));
        break;
      case 'begin-issues':
        applyReviewResult(bridge.reviewBeginVerdict('ISSUES'));
        break;
      case 'cancel-verdict':
        applyReviewResult(bridge.reviewCancelVerdict());
        break;
      case 'submit-verdict':
        applyReviewResult(bridge.reviewSubmitVerdict());
        break;
    }
  });

  document.getElementById('view-review')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = (e.target as HTMLElement).closest<HTMLElement>('.review-row');
    if (row?.dataset['reviewId'] == null) return;
    e.preventDefault();
    handleReviewSelect(row.dataset['reviewId']);
  });

  document.getElementById('view-review')?.addEventListener('input', (e) => {
    const textarea = (e.target as HTMLElement).closest<HTMLTextAreaElement>(
      '#review-composer-body',
    );
    if (textarea) void bridge.reviewUpdateComposerBody(textarea.value);
  });

  // ── Source interactions ───────────────────────────────────────────────────────
  document.getElementById('view-source')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const tab = target.closest<HTMLElement>('.source-tab');
    if (tab?.dataset['src'] != null) {
      const s = tab.dataset['src'];
      if (s === 'branches' || s === 'prs' || s === 'commits') {
        sourceTab = s;
        renderSource();
      }
      return;
    }
    if (target.closest('#source-fetch')) {
      // Re-read the open repo's branches / local PR refs (a direct local git read — no network fetch).
      flashToast('Refreshing branches…');
      void refreshSource();
    }
  });

  renderSource();
});
