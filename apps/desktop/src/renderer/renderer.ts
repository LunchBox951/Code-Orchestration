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

const OPERATOR_BUS = '@operator';
const MAIL_REVIEW_REQUEST = 'review_request';
const MAIL_REVIEW_RESPONSE = 'review_response';
const knownMailBuses = new Set<string>([OPERATOR_BUS]);
let latestMailState: MailState | null = null;

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
  for (const agentId of collectAgentIds(state.tree)) {
    knownMailBuses.add(agentId);
  }
}

function replyTypeFor(mailType: string): string {
  return mailType === MAIL_REVIEW_REQUEST ? MAIL_REVIEW_RESPONSE : 'clarify_response';
}

function replyLabelFor(mailType: string): string {
  return mailType === MAIL_REVIEW_REQUEST ? 'Submit verdict' : 'Reply';
}

function activateView(view: NavView): void {
  for (const el of document.querySelectorAll('.nav-item')) {
    el.classList.toggle('active', el.getAttribute('data-view') === view);
  }
  for (const el of document.querySelectorAll('.view')) {
    el.classList.toggle('active', el.id === `view-${view}`);
  }
  if (view === 'agents' && latestAgentsState != null) {
    renderAgentsTranscript(latestAgentsState);
  }
}

function setLiveStatus(status: string): void {
  const dot = document.getElementById('live-dot');
  const label = document.getElementById('live-label');
  if (dot) dot.classList.toggle('live', status === 'live');
  if (label) label.textContent = status === 'live' ? 'live' : 'offline';
}

function showAppError(message: string): void {
  const toast = document.createElement('div');
  toast.className = 'app-error-toast';
  toast.textContent = message;
  document.body.append(toast);
  setTimeout(() => toast.remove(), 7000);
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

// ── Mail rendering ─────────────────────────────────────────────────────────────

function mailAgeStr(ts: number): string {
  const age = Math.floor((Date.now() - ts) / 60000);
  if (age < 60) return `${age}m`;
  if (age < 1440) return `${Math.floor(age / 60)}h`;
  return `${Math.floor(age / 1440)}d`;
}

function renderMailSidebar(state: MailState): void {
  const busSelector = document.getElementById('mail-bus-selector');
  if (busSelector) {
    const buses = [OPERATOR_BUS, ...[...knownMailBuses].filter((bus) => bus !== OPERATOR_BUS)];
    if (!buses.includes(state.activeBus)) {
      buses.push(state.activeBus);
    }
    busSelector.innerHTML = buses
      .map(
        (bus) =>
          `<button class="bus-option${bus === state.activeBus ? ' active' : ''}" data-bus="${esc(bus)}" type="button" aria-pressed="${bus === state.activeBus ? 'true' : 'false'}">${esc(bus)}</button>`,
      )
      .join('');
  }

  const inboxTab = document.getElementById('mail-tab-inbox');
  const outboxTab = document.getElementById('mail-tab-outbox');
  inboxTab?.classList.toggle('active', state.tab === 'inbox');
  outboxTab?.classList.toggle('active', state.tab === 'outbox');
  inboxTab?.setAttribute('aria-selected', state.tab === 'inbox' ? 'true' : 'false');
  outboxTab?.setAttribute('aria-selected', state.tab === 'outbox' ? 'true' : 'false');

  const mailList = document.getElementById('mail-list');
  if (!mailList) return;

  const rows = state.tab === 'inbox' ? state.inbox : state.outbox;
  if (rows.length === 0) {
    mailList.innerHTML = `<div class="empty-state">No messages</div>`;
    return;
  }

  mailList.innerHTML = rows
    .map((row) => {
      const isSelected = state.selected?.seq === row.seq;
      const isActionable = row.kind === 'actionable';
      const isUnread = !row.read;
      const counterpart = state.tab === 'inbox' ? row.sender : row.recipient;
      return [
        `<div class="mail-row${isSelected ? ' selected' : ''}${isActionable ? ' actionable' : ''}"`,
        ` data-seq="${row.seq}" role="button" tabindex="0">`,
        `<div class="mail-row-type${isActionable ? ' actionable' : ''}">${esc(row.type)}</div>`,
        `<div class="mail-row-subject${isUnread ? ' unread' : ''}">${esc(row.subject)}</div>`,
        `<div class="mail-row-meta">`,
        `<span class="mail-row-sender">${esc(counterpart)}</span>`,
        `<span class="mail-row-age">${esc(mailAgeStr(row.ts))}</span>`,
        `</div></div>`,
      ].join('');
    })
    .join('');
}

function renderMailDetail(state: MailState): void {
  const detailPane = document.getElementById('mail-detail-pane');
  if (!detailPane) return;

  const { selected, composer } = state;

  if (selected == null) {
    detailPane.innerHTML = `<div class="empty-state">Select a message to read it</div>`;
    return;
  }

  const isActionable = selected.kind === 'actionable';
  const isApproval = selected.type === 'approval';
  const isReviewComposer = composer.type === MAIL_REVIEW_RESPONSE;
  const pendingAttr = composer.pending ? ' disabled' : '';

  let actionButtons = '';
  if (isApproval) {
    actionButtons = [
      `<div class="mail-card-actions">`,
      `<button class="btn btn-approve" data-action="approve" data-seq="${selected.seq}"${pendingAttr}>Approve</button>`,
      `<button class="btn btn-decline" data-action="decline" data-seq="${selected.seq}"${pendingAttr}>Decline</button>`,
      `<button class="btn btn-reply btn-secondary" data-action="open-composer"`,
      ` data-seq="${selected.seq}" data-recipient="${esc(selected.recipient)}"`,
      ` data-type="approval_response" data-subject="${esc(`Re: ${selected.subject}`)}"${pendingAttr}>Add note</button>`,
      `</div>`,
    ].join('');
  } else if (isActionable) {
    const replyType = replyTypeFor(selected.type);
    const replyLabel = replyLabelFor(selected.type);
    actionButtons = [
      `<div class="mail-card-actions">`,
      `<button class="btn btn-reply" data-action="open-composer"`,
      ` data-seq="${selected.seq}" data-recipient="${esc(selected.recipient)}"`,
      ` data-type="${replyType}" data-subject="${esc(`Re: ${selected.subject}`)}"${pendingAttr}>${replyLabel}</button>`,
      `</div>`,
    ].join('');
  }

  const composerFooter = isApproval
    ? [
        `<button class="btn btn-secondary" data-action="close-composer"${pendingAttr}>Cancel</button>`,
        `<button class="btn btn-decline" data-action="decline-with-composer" data-seq="${selected.seq}"${pendingAttr}>Decline with note</button>`,
        `<button class="btn btn-approve" data-action="approve-with-composer" data-seq="${selected.seq}"${pendingAttr}>Approve with note</button>`,
      ].join('')
    : [
        `<button class="btn btn-secondary" data-action="close-composer"${pendingAttr}>Cancel</button>`,
        `<button class="btn btn-reply" data-action="submit-reply"${pendingAttr}>${isReviewComposer ? 'Submit verdict' : 'Send'}</button>`,
      ].join('');

  const composerTitle = isApproval
    ? 'Decision note'
    : isReviewComposer
      ? 'Review verdict'
      : 'Reply';
  const composerPlaceholder = isReviewComposer ? 'PASS or ISSUES' : 'Type your reply…';
  const composerHtml = composer.active
    ? [
        `<div class="mail-composer">`,
        `<div class="mail-composer-header">${composerTitle}`,
        `<button class="mail-composer-close" data-action="close-composer" aria-label="Close composer"${pendingAttr}>×</button>`,
        `</div>`,
        `<div class="mail-composer-body">`,
        `<textarea class="composer-textarea" id="composer-body" placeholder="${composerPlaceholder}"${pendingAttr}>${esc(composer.body)}</textarea>`,
        `</div>`,
        `<div class="mail-composer-footer">`,
        composerFooter,
        `</div>`,
        `</div>`,
      ].join('')
    : '';

  detailPane.innerHTML = [
    `<div class="mail-card${isApproval ? ' approval-card' : ''}">`,
    `<div class="mail-card-header">`,
    `<div class="mail-card-type${isActionable ? ' actionable' : ''}">${esc(selected.type)}</div>`,
    `<div class="mail-card-subject">${esc(selected.subject)}</div>`,
    `<div class="mail-card-meta">From: ${esc(selected.sender)} · To: ${esc(selected.recipient)}</div>`,
    `</div>`,
    `<div class="mail-card-body">${esc(selected.renderedBody)}</div>`,
    actionButtons,
    `</div>`,
    composerHtml,
  ].join('');

  // Wire composer textarea live-sync
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

  // Update nav badge with actionable count
  const totalActionables = state.inbox.filter((r) => r.kind === 'actionable').length;
  const badge = document.getElementById('mail-badge');
  if (badge) {
    if (totalActionables > 0) {
      badge.textContent = String(totalActionables);
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }
}

// ── Limits / Cost rendering ────────────────────────────────────────────────────

function headroomDotCls(usedPct: number): string {
  if (usedPct >= 80) return 'headroom-dot-high';
  if (usedPct >= 50) return 'headroom-dot-mid';
  return 'headroom-dot-low';
}

function resetEta(resetAt: string): string {
  const ms = Date.parse(resetAt) - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return 'resetting';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (h > 0) return `resets in ${h}h ${m}m`;
  return `resets in ${m}m`;
}

function renderLimitsPopover(state: LimitsCostState): void {
  const body = document.getElementById('limits-popover-body');
  if (!body) return;

  if (state.headroomRows.length === 0) {
    body.innerHTML = `<div class="empty-state">No usage data</div>`;
    return;
  }

  // Group rows by (provider, account)
  const groups = new Map<string, LimitsCostHeadroomRow[]>();
  for (const row of state.headroomRows) {
    const key = `${row.provider}:${row.account}`;
    let arr = groups.get(key);
    if (arr == null) {
      arr = [];
      groups.set(key, arr);
    }
    arr.push(row);
  }

  const cards = [...groups.entries()]
    .map(([key, rows]) => {
      const [provider, account] = key.split(':') as [string, string];

      // Compute worst headroom dot for this account header
      const knownRows = rows.filter((r) => r.headroom.kind === 'known') as Array<
        LimitsCostHeadroomRow & { headroom: { kind: 'known'; used_pct: number; reset_at: string } }
      >;
      const worstPct =
        knownRows.length > 0 ? Math.max(...knownRows.map((r) => r.headroom.used_pct)) : undefined;
      const dotCls = worstPct !== undefined ? headroomDotCls(worstPct) : 'headroom-dot-unknown';

      const barRowsHtml = rows
        .map((row) => {
          if (row.headroom.kind === 'unknown') {
            return `<div class="limits-unknown-row">${esc(row.windowKind)}: no data — ${esc(row.headroom.reason)}</div>`;
          }
          const pct = Math.min(100, Math.round(row.headroom.used_pct));
          const fillCls =
            pct >= 80
              ? 'limits-bar-fill limits-bar-fill-high'
              : pct >= 50
                ? 'limits-bar-fill limits-bar-fill-mid'
                : 'limits-bar-fill';
          return `
            <div class="limits-bar-row">
              <div class="limits-bar-meta">
                <span class="limits-bar-label">${esc(row.windowKind)}</span>
                <span class="limits-bar-pct">${pct}% used</span>
              </div>
              <div class="limits-bar-track">
                <div class="${esc(fillCls)}" style="width:${pct}%"></div>
              </div>
              <div class="limits-bar-reset">${esc(resetEta(row.headroom.reset_at))}</div>
            </div>
          `;
        })
        .join('');

      return `
        <div class="limits-provider-card">
          <div class="limits-provider-header">
            <span class="headroom-dot ${esc(dotCls)}"></span>
            ${esc(provider)}
            <span style="color:var(--muted);font-weight:400">${esc(account)}</span>
          </div>
          <div class="limits-bar-rows">${barRowsHtml}</div>
        </div>
      `;
    })
    .join('');

  body.innerHTML = cards;
}

function renderCostView(state: LimitsCostState): void {
  const container = document.getElementById('cost-content');
  if (!container) return;

  if (state.agentCosts.length === 0 && state.taskCosts.length === 0) {
    container.innerHTML = `<div class="empty-state">No cost data yet</div>`;
    return;
  }

  function costRowsHtml(rows: readonly LimitsCostCostRow[]): string {
    if (rows.length === 0) return `<div class="empty-state">No entries</div>`;
    return rows
      .map(
        (r) => `
          <div class="cost-row">
            <span class="cost-row-id" title="${esc(r.id)}">${esc(r.id)}</span>
            <span class="cost-row-usd">$${r.totalCostUsd.toFixed(4)}</span>
          </div>
        `,
      )
      .join('');
  }

  container.innerHTML = `
    <div class="cost-sections">
      <div class="cost-section">
        <div class="cost-section-heading">Per agent</div>
        <div class="cost-list">${costRowsHtml(state.agentCosts)}</div>
      </div>
      <div class="cost-section">
        <div class="cost-section-heading">Per task</div>
        <div class="cost-list">${costRowsHtml(state.taskCosts)}</div>
      </div>
    </div>
  `;
}

// ── Agents Console rendering ──────────────────────────────────────────────────

let agentsTerm: XtermTerminal | null = null;
let lastAgentId: string | null = null;
let lastTranscript = '';
let latestAgentsState: AgentsConsoleState | null = null;

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
  const agentsMain = document.querySelector<HTMLElement>('#view-agents .agents-main');
  if (!agentsMain || !message) return;
  const toast = document.createElement('div');
  toast.className = 'mail-error-toast';
  toast.textContent = message;
  agentsMain.prepend(toast);
  setTimeout(() => toast.remove(), 5000);
}

function setComposerEnabled(enabled: boolean): void {
  const steerInput = document.getElementById('steer-input') as HTMLTextAreaElement | null;
  if (steerInput) steerInput.disabled = !enabled;
  for (const btn of document.querySelectorAll<HTMLButtonElement>('#view-agents .steer-btn')) {
    btn.disabled = !enabled;
  }
}

function renderAgents(state: AgentsConsoleState): void {
  latestAgentsState = state;

  const roster = document.getElementById('agents-roster');
  if (roster) {
    if (state.roster.length === 0) {
      roster.innerHTML = `<div class="empty-state">No agents</div>`;
    } else {
      roster.innerHTML = state.roster
        .map((agent) => {
          const isSelected = agent.agentId === state.selectedAgentId;
          return [
            `<div class="agents-roster-row${isSelected ? ' selected' : ''}"`,
            ` data-agent-id="${esc(agent.agentId)}"`,
            ` role="option" tabindex="0"`,
            ` aria-selected="${isSelected ? 'true' : 'false'}">`,
            statusDotHtml(agent.status),
            `<span class="agents-row-role">${esc(agent.role)}</span>`,
            `<span class="agents-row-id">${esc(agent.agentId)}</span>`,
            `</div>`,
          ].join('');
        })
        .join('');
    }
  }

  const composerEnabled =
    state.selectedAgentId != null && state.connection === 'live' && state.selectedStatus === 'warm';
  setComposerEnabled(composerEnabled);

  renderAgentsTranscript(state);
}

function renderAgentsTranscript(state: AgentsConsoleState): void {
  if (!isAgentsViewActive()) return;

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

  bridge.onConnectionError((message) => {
    showAppError(message);
  });

  bridge.onDashboardState((state) => {
    rememberMailBuses(state);
    renderDashboard(state);
    if (latestMailState != null) renderMail(latestMailState);
  });

  // ── Mail ────────────────────────────────────────────────────────────────────

  bridge.onMailState((state) => {
    renderMail(state);
  });

  bridge.onMailError((message) => {
    const detailPane = document.getElementById('mail-detail-pane');
    if (!detailPane) return;
    const toast = document.createElement('div');
    toast.className = 'mail-error-toast';
    toast.textContent = message;
    detailPane.prepend(toast);
    setTimeout(() => toast.remove(), 5000);
  });

  // Request initial mail state on load
  void bridge.mailRefresh();

  // ── Limits / Cost ──────────────────────────────────────────────────────────

  bridge.onLimitsCostState((state) => {
    renderLimitsPopover(state);
    renderCostView(state);
  });

  void bridge.refreshLimitsCost();

  function selectMailRow(row: HTMLElement): void {
    const seq = row.dataset['seq'];
    if (seq != null) void bridge.mailSelect(Number(seq));
  }

  // Header limits button toggle (renderer-local; no main round-trip needed)
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

  // Close popover when clicking outside
  document.addEventListener('click', (e) => {
    const wrapper = document.getElementById('limits-wrapper');
    if (wrapper == null || limitsPopover == null) return;
    if (!wrapper.contains(e.target as Node)) {
      limitsPopover.setAttribute('hidden', '');
      limitsBtn?.classList.remove('open');
      limitsBtn?.setAttribute('aria-expanded', 'false');
    }
  });

  // ── Agents Console ─────────────────────────────────────────────────────────

  bridge.onAgentsConsoleState((state) => {
    renderAgents(state);
  });

  function selectAgentRow(agentId: string): void {
    void bridge.agentsSelect(agentId);
  }

  document.getElementById('view-agents')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    const row = target.closest<HTMLElement>('.agents-roster-row');
    if (row?.dataset['agentId'] != null) {
      selectAgentRow(row.dataset['agentId']);
      return;
    }

    const btn = target.closest<HTMLElement>('.steer-btn');
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
    const row = (e.target as HTMLElement).closest<HTMLElement>('.agents-roster-row');
    if (row?.dataset['agentId'] == null) return;
    e.preventDefault();
    selectAgentRow(row.dataset['agentId']);
  });

  // ── Mail event delegation ──────────────────────────────────────────────────

  document.getElementById('view-mail')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    // Mail list row
    const row = target.closest<HTMLElement>('.mail-row');
    if (row?.dataset['seq'] != null) {
      selectMailRow(row);
      return;
    }

    // Bus selector
    const busOption = target.closest<HTMLElement>('.bus-option');
    if (busOption?.dataset['bus'] != null) {
      void bridge.mailSelectBus(busOption.dataset['bus']);
      return;
    }

    // Tabs
    const tab = target.closest<HTMLElement>('.mail-tab');
    if (tab?.dataset['tab'] != null) {
      const tabVal = tab.dataset['tab'];
      if (tabVal === 'inbox' || tabVal === 'outbox') {
        void bridge.mailSelectTab(tabVal);
      }
      return;
    }

    // Action buttons
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
      case 'open-composer': {
        if (seq != null) {
          const recipient = btn.dataset['recipient'] ?? '';
          const replyType = btn.dataset['type'] ?? 'clarify_response';
          const subject = btn.dataset['subject'] ?? '';
          void bridge.mailOpenComposer(seq, recipient, replyType, subject);
        }
        break;
      }
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
    selectMailRow(row);
  });
});
