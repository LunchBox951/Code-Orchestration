// Renderer entry — the operator-facing Cockpit. Vanilla DOM, no framework.
// Ports the "co Cockpit" design handoff (dark IBM-Plex mission-control system)
// onto live @co/core state delivered over the coShell bridge (preload contextBridge).
//
// Mock data and the demo phase-stepper from the reference are intentionally dropped:
// every surface derives from real registry/daemon/agent-tree/mail/usage signals, and
// renders honest empty states where live data does not exist yet (Principle: empty
// states are first-class — never fake data).

const NAV_VIEWS = ['dashboard', 'agents', 'mail', 'source', 'usage'] as const;
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
let latestLimitsState: LimitsCostState | null = null;
let projectInfo: { id: string; name: string; branch?: string } | null = null;
let sourceTab: 'branches' | 'prs' | 'commits' = 'branches';

const OPERATOR_BUS = '@operator';
const knownMailBuses = new Set<string>([OPERATOR_BUS]);

function collectAgentIds(nodes: readonly TreeNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    out.push(node.agentId);
    collectAgentIds(node.children, out);
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

// ── Navigation ──────────────────────────────────────────────────────────────────

function activateView(view: LocalNavView): void {
  for (const el of document.querySelectorAll('.nav-item')) {
    el.classList.toggle('active', el.getAttribute('data-view') === view);
  }
  for (const el of document.querySelectorAll('.view')) {
    el.classList.toggle('active', el.id === `view-${view}`);
  }
  if (view === 'agents' && latestAgentsState != null) renderAgentsTranscript(latestAgentsState);
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

  // daemon pill — degraded means the conductor IPC is down
  const daemonDot = document.getElementById('daemon-dot');
  const daemonLabel = document.getElementById('daemon-label');
  if (daemonDot) daemonDot.style.background = isLive ? 'var(--success)' : 'oklch(0.6 0.02 30)';
  if (daemonLabel) {
    daemonLabel.textContent = status === 'connecting' ? 'starting' : isLive ? 'healthy' : 'stopped';
  }

  // project pill
  const pill = document.getElementById('project-pill');
  const nameEl = document.getElementById('project-name');
  const branchEl = document.getElementById('project-branch');
  const titlebar = document.getElementById('titlebar-title');
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
    if (titlebar) titlebar.textContent = `co · Code Orchestration · ${projectInfo.name}`;
  }

  renderLimitsSummary();
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
    body.innerHTML = `<div class="empty-inline"><span class="lead">No usage data</span></div>`;
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
      const indent = depth * 16;
      return `
        <button class="fleet-row" data-agent-id="${esc(node.agentId)}" type="button">
          <span style="width:${indent}px;flex:0 0 ${indent}px"></span>
          <span class="state-dot${meta.pulse ? ' pulse' : ''}" style="background:${meta.color};box-shadow:0 0 0 3px ${tint(meta.color, '22%')}"></span>
          <span class="mid">
            <span class="line1">
              <span class="name">${esc(node.agentId)}</span>
              <span class="role-badge" style="background:${tint(rc, '18%')};color:${rc}">${esc(roleLabel)}</span>
            </span>
            <span class="last">${esc(node.parent ? `child of ${node.parent}` : 'root coordinator')}</span>
          </span>
          <span class="right">
            <span class="state" style="color:${meta.color}">${meta.label}</span>
          </span>
        </button>
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
    if (form) form.innerHTML = '';
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

  const stats = dash?.stats ?? { total: 0, warm: 0, waiting: 0, stuck: 0, paused: 0 };
  const actionables = dash?.actionables ?? [];
  const actionCount = actionables.length;

  const subline =
    phase === 'fleet'
      ? `Conductor driving ${stats.total} agent${stats.total !== 1 ? 's' : ''}`
      : phase === 'coord'
        ? 'Conductor driving 1 agent · coordinator session live'
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

  const fleetBody =
    dash != null && dash.tree.length > 0
      ? renderTreeRows(dash.tree, 0)
      : `<div class="empty-inline">
           <span class="glyph">∅</span>
           <span class="lead">No agents yet.</span>
           <span class="sub">Start a coordinator session — it locks the spec and spawns the fleet.</span>
         </div>`;

  // Right column varies by phase
  let rightCol = '';
  if (phase === 'coord') {
    rightCol = `
      <div class="coord-cta">
        <div class="row"><span class="dot pulse"></span><span class="ttl">Coordinator session is live</span></div>
        <p>The root coordinator is reading the handoff and may be waiting on an approval before it locks the spec and fans out the fleet.</p>
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
           <div class="panel-hd"><span class="ttl">Fleet</span><span class="meta">spawn tree · click to open console</span></div>
           <div class="panel-body">${fleetBody}</div>
         </div>`
      : `<div class="mc-grid">
           <div class="panel">
             <div class="panel-hd"><span class="ttl">Fleet</span><span class="meta">spawn tree · click to open console</span></div>
             <div class="panel-body">${fleetBody}</div>
           </div>
           <div class="mc-right">${rightCol}</div>
         </div>`;

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
    ${grid}`;

  // Kickoff composer lives in the sibling #session-start-form (so dashboard rerenders
  // never wipe an in-progress draft). Shown only in the "opened" phase.
  if (form) {
    if (phase === 'opened') {
      renderSessionStartForm();
      form.style.display = '';
    } else {
      form.innerHTML = '';
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
let lastAgentId: string | null = null;
let lastTranscript = '';

function getOrCreateTerm(): XtermTerminal {
  if (agentsTerm != null) return agentsTerm;
  const term = new window.Terminal({ convertEol: true, disableStdin: true });
  const el = document.getElementById('agents-transcript');
  if (el) term.open(el);
  agentsTerm = term;
  return term;
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

function renderAgents(state: AgentsConsoleState): void {
  latestAgentsState = state;

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
          return [
            `<button class="sess-row${isSelected ? ' selected' : ''}" data-agent-id="${esc(agent.agentId)}"`,
            ` role="option" aria-selected="${isSelected ? 'true' : 'false'}" type="button">`,
            `<span class="state-dot${meta.pulse ? ' pulse' : ''}" style="background:${meta.color}"></span>`,
            `<span class="mid">`,
            `<span class="name">${esc(agent.agentId)}</span>`,
            `<span class="role" style="color:${rc}">${esc(agent.role)}</span>`,
            `<span class="sess-actions">`,
            `<button class="btn btn-ghost" data-agent-action="stop" data-agent-id="${esc(agent.agentId)}" type="button" aria-label="Stop agent ${esc(agent.agentId)}">Stop</button>`,
            `<button class="btn btn-ghost" data-agent-action="unstick" data-agent-id="${esc(agent.agentId)}" type="button" aria-label="Unstick agent ${esc(agent.agentId)}">Unstick</button>`,
            `</span>`,
            `</span>`,
            `<span class="state" style="color:${meta.color}">${meta.label}</span>`,
            `</button>`,
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
    consoleEl?.classList.remove('codex');
    if (consoleHd) {
      consoleHd.hidden = false;
      consoleHd.innerHTML = [
        `<span class="state-dot${meta.pulse ? ' pulse' : ''}" style="background:${meta.color}"></span>`,
        `<span class="name">${esc(selected.agentId)}</span>`,
        `<span class="role-badge" style="background:${tint(rc, '18%')};color:${rc}">${esc(selected.role)}</span>`,
        `<span class="spacer"></span>`,
        `<span class="meta" style="color:${meta.color}">${meta.label}</span>`,
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
  if (state.selectedAgentId !== lastAgentId) {
    term.reset();
    if (state.transcript) term.write(state.transcript);
  } else if (state.transcript.startsWith(lastTranscript)) {
    const delta = state.transcript.slice(lastTranscript.length);
    if (delta) term.write(delta);
  } else {
    term.reset();
    if (state.transcript) term.write(state.transcript);
  }
  lastAgentId = state.selectedAgentId;
  lastTranscript = state.transcript;
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
    const buses = [OPERATOR_BUS, ...[...knownMailBuses].filter((b) => b !== OPERATOR_BUS)];
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

function renderMailDetail(state: MailState): void {
  const detailPane = document.getElementById('mail-detail-pane');
  if (!detailPane) return;
  const { selected, composer } = state;

  if (selected == null) {
    detailPane.innerHTML = `<div class="empty-inline"><span class="glyph">✉</span><span class="lead">Select a message to read it</span></div>`;
    return;
  }

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
  latestMailState = state;
  renderMailSidebar(state);
  renderMailDetail(state);
  const totalActionables = state.inbox.filter((r) => r.kind === 'actionable').length;
  setBadge('mail-badge', totalActionables);
}

// ── Source ──────────────────────────────────────────────────────────────────────

function renderSource(): void {
  const repoName = document.getElementById('source-repo-name');
  const branchLabel = document.getElementById('source-branch-label');
  if (repoName) repoName.textContent = projectInfo?.name ?? 'repository';
  if (branchLabel) branchLabel.textContent = projectInfo?.branch ?? '—';

  for (const el of document.querySelectorAll<HTMLElement>('.source-tab')) {
    el.classList.toggle('active', el.getAttribute('data-src') === sourceTab);
  }

  const body = document.getElementById('source-body');
  if (!body) return;

  // Source is not yet wired to live git/gh data in this build — render the design's
  // honest first-class empty states (PRs are deferred to gh+network; branches/commits
  // surface once the conductor exposes git over the operator IPC).
  if (sourceTab === 'branches') {
    body.innerHTML = `<div class="empty-inline" style="padding:70px 40px">
        <span class="glyph">⎇</span>
        <span class="lead">Branch list not wired yet</span>
        <span class="sub">Worktree branches will surface here once the Conductor exposes git over the operator IPC.</span>
      </div>`;
  } else if (sourceTab === 'prs') {
    body.innerHTML = `<div class="empty-inline" style="padding:70px 40px">
        <span class="glyph">⇄</span>
        <span class="lead">No pull requests</span>
        <span class="sub">Gated PRs appear here once a phase passes its full five-command gate (deferred to gh + network).</span>
      </div>`;
  } else {
    body.innerHTML = renderGitGraph([]);
  }
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

// ── Bootstrap ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const bridge = window.coShell;

  // Project identity for the header pill.
  void bridge.projectInfo?.().then((info) => {
    if (info != null) {
      const raw = info.id;
      const base = raw.includes('/') ? (raw.split('/').pop() ?? raw) : raw;
      projectInfo = { id: raw, name: base };
      renderHeader();
      renderSource();
    }
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

  bridge.onDashboardState((state) => {
    latestDashboard = state;
    rememberMailBuses(state);
    renderHeader();
    renderDashboard();
    if (latestMailState != null) renderMail(latestMailState);
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

  // ── Mission Control interactions ──────────────────────────────────────────────
  document.getElementById('view-dashboard')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    const fleetRow = target.closest<HTMLElement>('.fleet-row');
    if (fleetRow?.dataset['agentId'] != null) {
      const id = fleetRow.dataset['agentId'];
      activateView('agents');
      bridge.navigate('agents');
      void bridge.agentsSelect(id);
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
      }
    }
  });

  // Session start (kickoff composer)
  document.getElementById('session-start-form')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('#session-demo-spec')) {
      const ta = document.getElementById('session-prompt-input') as HTMLTextAreaElement | null;
      if (ta) {
        ta.value =
          'Finish stage-15 convergence: fix the unstick bug (key on agentId), land routing, and get PR #41 review-ready. Lock the spec, then fan out a lead with phase workers.';
        ta.focus();
      }
      return;
    }
    if (!target.closest('#session-start-btn')) return;
    const textarea = document.getElementById('session-prompt-input') as HTMLTextAreaElement | null;
    const prompt = textarea?.value.trim() ?? '';
    void bridge.sessionStart(prompt.length > 0 ? prompt : null, null).then((r) => {
      if (r.ok && textarea) textarea.value = '';
      else if (!r.ok) showAppError(r.error ?? 'Failed to start coordinator session');
    });
  });

  // ── Agents Console ──────────────────────────────────────────────────────────
  bridge.onAgentsConsoleState((state) => renderAgents(state));

  document.getElementById('view-agents')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

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
      }
      return;
    }

    const row = target.closest<HTMLElement>('.sess-row');
    if (row?.dataset['agentId'] != null) {
      void bridge.agentsSelect(row.dataset['agentId']);
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

  document.getElementById('view-agents')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = (e.target as HTMLElement).closest<HTMLElement>('.sess-row');
    if (row?.dataset['agentId'] == null) return;
    e.preventDefault();
    void bridge.agentsSelect(row.dataset['agentId']);
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
    }
  });

  document.getElementById('view-mail')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = (e.target as HTMLElement).closest<HTMLElement>('.mail-row');
    if (row?.dataset['seq'] == null) return;
    e.preventDefault();
    void bridge.mailSelect(Number(row.dataset['seq']));
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
    if (target.closest('#source-fetch')) flashToast('Source not yet wired to git');
  });

  renderSource();
});
