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
    // Always show @operator; include the active bus if it's an agent
    const buses = ['@operator'];
    if (state.activeBus !== '@operator' && !buses.includes(state.activeBus)) {
      buses.push(state.activeBus);
    }
    busSelector.innerHTML = buses
      .map(
        (bus) =>
          `<div class="bus-option${bus === state.activeBus ? ' active' : ''}" data-bus="${esc(bus)}">${esc(bus)}</div>`,
      )
      .join('');
  }

  document.getElementById('mail-tab-inbox')?.classList.toggle('active', state.tab === 'inbox');
  document.getElementById('mail-tab-outbox')?.classList.toggle('active', state.tab === 'outbox');

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

  let actionButtons = '';
  if (isApproval) {
    actionButtons = [
      `<div class="mail-card-actions">`,
      `<button class="btn btn-approve" data-action="approve" data-seq="${selected.seq}">Approve</button>`,
      `<button class="btn btn-decline" data-action="decline" data-seq="${selected.seq}">Decline</button>`,
      `<button class="btn btn-reply btn-secondary" data-action="open-composer"`,
      ` data-seq="${selected.seq}" data-recipient="${esc(selected.sender)}"`,
      ` data-type="clarify_response" data-subject="${esc(`Re: ${selected.subject}`)}">Reply with note</button>`,
      `</div>`,
    ].join('');
  } else if (isActionable) {
    actionButtons = [
      `<div class="mail-card-actions">`,
      `<button class="btn btn-reply" data-action="open-composer"`,
      ` data-seq="${selected.seq}" data-recipient="${esc(selected.sender)}"`,
      ` data-type="clarify_response" data-subject="${esc(`Re: ${selected.subject}`)}">Reply</button>`,
      `</div>`,
    ].join('');
  }

  const composerHtml = composer.active
    ? [
        `<div class="mail-composer">`,
        `<div class="mail-composer-header">Reply`,
        `<button class="mail-composer-close" data-action="close-composer">×</button>`,
        `</div>`,
        `<div class="mail-composer-body">`,
        `<textarea class="composer-textarea" id="composer-body" placeholder="Type your reply…">${esc(composer.body)}</textarea>`,
        `</div>`,
        `<div class="mail-composer-footer">`,
        `<button class="btn btn-secondary" data-action="close-composer">Cancel</button>`,
        `<button class="btn btn-reply" data-action="submit-reply">Send</button>`,
        `</div></div>`,
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

  // ── Mail event delegation ──────────────────────────────────────────────────

  document.getElementById('view-mail')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    // Mail list row
    const row = target.closest<HTMLElement>('.mail-row');
    if (row?.dataset['seq'] != null) {
      void bridge.mailSelect(Number(row.dataset['seq']));
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
    }
  });
});
