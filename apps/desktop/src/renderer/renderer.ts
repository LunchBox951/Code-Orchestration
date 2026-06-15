// Renderer entry: wires DOM nav switching, connection-state, and dashboard
// to the coShell bridge exposed by the preload via contextBridge.

const NAV_VIEWS = ['dashboard', 'agents', 'mail', 'review', 'source', 'cost'] as const;
type NavView = (typeof NAV_VIEWS)[number];

function isNavView(v: unknown): v is NavView {
  return typeof v === 'string' && (NAV_VIEWS as ReadonlyArray<string>).includes(v);
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function activateView(view: NavView): void {
  for (const el of document.querySelectorAll('.nav-item')) {
    el.classList.toggle('active', el.getAttribute('data-view') === view);
  }
  for (const el of document.querySelectorAll('.view')) {
    el.classList.toggle('active', el.id === `view-${view}`);
  }
}

function setLiveStatus(status: string): void {
  const dot = document.getElementById('live-dot');
  const label = document.getElementById('live-label');
  if (dot) dot.classList.toggle('live', status === 'live');
  if (label) label.textContent = status === 'live' ? 'live' : 'offline';
}

// ── Dashboard rendering ────────────────────────────────────────────────────────

function statusDotHtml(status: AgentStatus): string {
  const cls: Record<AgentStatus, string> = {
    warm: 'dot-warm',
    waiting: 'dot-waiting',
    stuck: 'dot-stuck',
    paused: 'dot-paused',
    unknown: 'dot-unknown',
  };
  return `<span class="status-dot ${cls[status]}" title="${esc(status)}"></span>`;
}

function renderTreeNodes(nodes: readonly TreeNode[], depth: number): string {
  return nodes
    .map((node) => {
      const indent = depth * 20;
      const label = node.subRole ? `${esc(node.role)}:${esc(node.subRole)}` : esc(node.role);
      return `
        <div class="tree-node" style="padding-left:${indent}px">
          ${statusDotHtml(node.status)}
          <span class="tree-role">${label}</span>
          <span class="tree-id">${esc(node.agentId)}</span>
        </div>
        ${renderTreeNodes(node.children, depth + 1)}
      `;
    })
    .join('');
}

function renderDashboard(state: DashboardState): void {
  const container = document.getElementById('view-dashboard');
  if (!container) return;

  const isLive = state.connection === 'live';
  const s = state.stats;

  const degradedBanner = isLive
    ? ''
    : `<div class="degraded-banner">Conductor not running — showing last known state</div>`;

  const tiles = [
    { label: 'TOTAL', value: s.total, cls: '' },
    { label: 'WARM', value: s.warm, cls: 'tile-warm' },
    { label: 'WAITING', value: s.waiting, cls: 'tile-waiting' },
    { label: 'STUCK', value: s.stuck, cls: 'tile-stuck' },
    { label: 'PAUSED', value: s.paused, cls: 'tile-paused' },
  ]
    .map(
      (t) => `
      <div class="stat-tile ${esc(t.cls)}">
        <div class="stat-label">${esc(t.label)}</div>
        <div class="stat-value">${t.value}</div>
      </div>
    `,
    )
    .join('');

  const treeHtml =
    state.tree.length === 0
      ? `<div class="empty-state">No agents registered</div>`
      : renderTreeNodes(state.tree, 0);

  const agentCount = s.total;
  const subline = isLive
    ? `Conductor driving ${agentCount} agent${agentCount !== 1 ? 's' : ''}`
    : 'Conductor offline';

  const actionableRows =
    state.actionables.length === 0
      ? `<div class="empty-state">No outstanding actions</div>`
      : state.actionables
          .map((a) => {
            const age = Math.floor((Date.now() - a.ts) / 60000);
            const ageStr = age < 60 ? `${age}m` : `${Math.floor(age / 60)}h`;
            return `
          <div class="actionable-row">
            <span class="action-type">${esc(a.type)}</span>
            <span class="action-subject">${esc(a.subject)}</span>
            <span class="action-sender">${esc(a.sender)}</span>
            <span class="action-age">${esc(ageStr)}</span>
          </div>
        `;
          })
          .join('');

  container.innerHTML = `
    <div class="mc-header">
      <div class="mc-title">Mission Control</div>
      <div class="mc-subline">${esc(subline)}</div>
    </div>
    ${degradedBanner}
    <div class="stat-tiles">${tiles}</div>
    <div class="section-card">
      <div class="section-heading">Fleet</div>
      <div class="tree-view">${treeHtml}</div>
    </div>
    <div class="section-card action-panel">
      <div class="section-heading">Action required <span class="action-count">${state.actionables.length}</span></div>
      <div class="actionable-list">${actionableRows}</div>
    </div>
  `;
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const bridge = window.coShell;

  // Nav clicks → bridge
  document.getElementById('nav-rail')?.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('.nav-item');
    const view = item?.dataset['view'];
    if (isNavView(view)) {
      activateView(view);
      bridge.navigate(view);
    }
  });

  // Main → renderer state pushes
  bridge.onNavState((state) => {
    if (isNavView(state.activeView)) activateView(state.activeView);
  });

  bridge.onConnectionState((state) => {
    setLiveStatus(state.status);
  });

  bridge.onDashboardState((state) => {
    renderDashboard(state);
  });
});
