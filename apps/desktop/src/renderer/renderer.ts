// Renderer entry: wires DOM nav switching, connection-state, and dashboard
// to the coShell bridge exposed by the preload via contextBridge.

import { reviewDetailNeedsRebuild, reviewDetailSignature } from './review-render-helpers.js';
import { mailDetailNeedsRebuild, mailDetailSignature } from './mail-render-helpers.js';

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

let latestReviewState: ReviewState | null = null;

const OPERATOR_BUS = '@operator';
const MAIL_REVIEW_REQUEST = 'review_request';
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
  if (mailType === MAIL_REVIEW_REQUEST) return 'review';
  return 'clarify_response';
}

function replyLabelFor(mailType: string): string {
  return mailType === MAIL_REVIEW_REQUEST ? 'Open in Reviews' : 'Reply';
}

function reviewIdFromMailRow(row: MailRow): string | null {
  const key = row.idempotencyKey;
  if (key?.startsWith('review-request:') === true) {
    return key.slice('review-request:'.length);
  }
  return null;
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
  if (view === 'review' && latestReviewState != null) {
    renderReview(latestReviewState);
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
  const container = document.getElementById('dashboard-content');
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

function renderMailDetail(state: MailState, prevState: MailState | null): void {
  const detailPane = document.getElementById('mail-detail-pane');
  if (!detailPane) return;

  const { selected, composer } = state;

  if (selected == null) {
    detailPane.innerHTML = `<div class="empty-state">Select a message to read it</div>`;
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
  } else if (selected.type === MAIL_REVIEW_REQUEST) {
    const reviewId = reviewIdFromMailRow(selected);
    const reviewIdAttr = reviewId != null ? ` data-review-id="${esc(reviewId)}"` : '';
    actionButtons = [
      `<div class="mail-card-actions">`,
      `<button class="btn btn-reply" data-action="open-review-view"${reviewIdAttr}${pendingAttr}>${replyLabelFor(selected.type)}</button>`,
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
        `<button class="btn btn-reply" data-action="submit-reply"${pendingAttr}>Send</button>`,
      ].join('');

  const composerTitle = isApproval ? 'Decision note' : 'Reply';
  const composerPlaceholder = 'Type your reply…';
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
  const prevState = latestMailState;
  latestMailState = state;
  renderMailSidebar(state);
  renderMailDetail(state, prevState);

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
            `<div class="agents-row-actions">`,
            `<button class="btn btn-secondary agents-agent-btn" data-agent-action="stop"`,
            ` data-agent-id="${esc(agent.agentId)}" type="button"`,
            ` aria-label="Stop agent ${esc(agent.agentId)}">Stop</button>`,
            `<button class="btn btn-secondary agents-agent-btn" data-agent-action="unstick"`,
            ` data-agent-id="${esc(agent.agentId)}" type="button"`,
            ` aria-label="Unstick agent ${esc(agent.agentId)}">Unstick</button>`,
            `</div>`,
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

// ── Review rendering ──────────────────────────────────────────────────────────

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

function renderReviewDetail(context: SelectedContext, composer: VerdictComposer): string {
  if (context == null) {
    return `<div class="empty-state">Select a review to inspect it</div>`;
  }
  if (context.status === 'loading') {
    return `<div class="empty-state">Loading review context…</div>`;
  }

  const { value } = context;

  if (value.kind === 'not-found') {
    return `<div class="empty-state">Review not found: ${esc(value.reviewId)}</div>`;
  }
  if (value.kind === 'conductor-down') {
    return `<div class="empty-state">Conductor not running — start \`co-mcp serve <projectId>\` to load review context.</div>`;
  }

  // kind === 'resolved'
  const { diff, criteria } = value;
  const canSubmitVerdict = diff.kind === 'patch' && criteria.kind === 'criteria';

  let diffHtml: string;
  if (diff.kind === 'unavailable') {
    const reason =
      diff.reason === 'worktree-missing'
        ? 'Worktree not found — the branch may have been cleaned up.'
        : 'Git diff failed — check the conductor logs.';
    diffHtml = `<div class="empty-state">${esc(reason)}</div>`;
  } else {
    diffHtml = `<pre class="review-diff-pre">${renderDiffLines(diff.patch)}</pre>`;
  }

  let criteriaHtml: string;
  if (criteria.kind === 'no-locked-spec') {
    criteriaHtml = `<div class="empty-state">No locked spec — acceptance criteria not available.</div>`;
  } else {
    criteriaHtml = criteria.criteria
      .map(
        (c) =>
          `<div class="review-criterion">
            <div>· ${esc(c.text)}</div>
            ${c.verify != null ? `<div class="review-criterion-verify">$ ${esc(c.verify)}</div>` : ''}
          </div>`,
      )
      .join('');
  }

  const pendingAttr = composer.pending ? ' disabled' : '';

  let verdictBody = '';
  if (composer.active && canSubmitVerdict) {
    verdictBody = [
      `<div class="review-verdict-body">`,
      `<textarea class="review-body-textarea" id="review-composer-body"`,
      ` aria-label="Review verdict notes"${pendingAttr}`,
      ` placeholder="${composer.verdict === 'ISSUES' ? 'Describe the issues…' : 'Optional notes…'}">${esc(composer.body)}</textarea>`,
      `</div>`,
      `<div class="review-verdict-footer">`,
      `<button class="btn btn-secondary" data-review-action="cancel-verdict"${pendingAttr}>Cancel</button>`,
      `<button class="btn ${composer.verdict === 'PASS' ? 'btn-pass' : 'btn-issues'}"`,
      ` data-review-action="submit-verdict"${pendingAttr}>`,
      `Submit ${esc(composer.verdict)}</button>`,
      `</div>`,
    ].join('');
  }

  const verdictActions =
    !composer.active && canSubmitVerdict
      ? [
          `<div class="review-verdict-actions">`,
          `<button class="btn btn-pass" data-review-action="begin-pass"`,
          ` aria-label="Submit PASS verdict"${pendingAttr}>PASS</button>`,
          `<button class="btn btn-issues" data-review-action="begin-issues"`,
          ` aria-label="Submit ISSUES verdict"${pendingAttr}>ISSUES</button>`,
          `</div>`,
        ].join('')
      : '';
  const verdictUnavailable = !canSubmitVerdict
    ? `<div class="empty-state">Verdict unavailable until diff and locked criteria load.</div>`
    : '';

  return [
    `<div class="review-diff-block">`,
    `<div class="review-diff-header">Diff · ${esc(value.branch)} → ${esc(value.target)}</div>`,
    diffHtml,
    `</div>`,
    `<div class="review-criteria-block">`,
    `<div class="review-criteria-header">Acceptance Criteria`,
    criteria.kind === 'criteria' ? ` · ${esc(criteria.specRef)}` : '',
    `</div>`,
    `<div class="review-criteria-list" aria-label="Acceptance criteria">${criteriaHtml}</div>`,
    `</div>`,
    `<div class="review-verdict-block">`,
    `<div class="review-verdict-header">Verdict</div>`,
    verdictActions,
    verdictUnavailable,
    verdictBody,
    `</div>`,
  ].join('');
}

function renderReview(state: ReviewState): void {
  const prevState = latestReviewState;
  latestReviewState = state;

  // Update pending list
  const reviewList = document.getElementById('review-list');
  if (reviewList) {
    if (state.pending.length === 0) {
      reviewList.innerHTML = `<div class="empty-state">No pending reviews</div>`;
    } else {
      reviewList.innerHTML = state.pending
        .map((row) => {
          const isSelected = row.reviewId === state.selectedReviewId;
          return [
            `<div class="review-row${isSelected ? ' selected' : ''}"`,
            ` data-review-id="${esc(row.reviewId)}"`,
            ` role="option"`,
            ` aria-selected="${isSelected ? 'true' : 'false'}"`,
            ` tabindex="0">`,
            `<div class="review-row-subject">${esc(row.subject)}</div>`,
            `<div class="review-row-meta">`,
            `<span class="review-row-sender">${esc(row.sender)}</span>`,
            `<span class="review-row-age">${esc(reviewAgeStr(row.ts))}</span>`,
            `</div>`,
            `</div>`,
          ].join('');
        })
        .join('');
    }
  }

  // Update detail pane — but PRESERVE the caret while typing in the verdict composer (review #316
  // follow-up): when the ONLY change is composer.body and that textarea is focused, skip the rebuild
  // (the live textarea already holds the typed value). The list + badge still update.
  const detailPane = document.getElementById('review-detail-pane');
  if (detailPane) {
    const composerFocused = document.activeElement?.id === 'review-composer-body';
    const needsRebuild = reviewDetailNeedsRebuild(
      prevState != null ? reviewDetailSignature(prevState) : null,
      reviewDetailSignature(state),
      composerFocused,
    );
    if (needsRebuild) {
      detailPane.innerHTML = renderReviewDetail(state.context, state.composer);
    }
  }

  // Update nav badge with pending count
  const badge = document.getElementById('review-badge');
  if (badge) {
    if (state.pending.length > 0) {
      badge.textContent = String(state.pending.length);
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }
}

// ── Session start form rendering ───────────────────────────────────────────────

function renderSessionStartForm(): void {
  const form = document.getElementById('session-start-form');
  if (!form) return;
  form.innerHTML = [
    `<div class="session-form-heading">Start a coordinator session</div>`,
    `<div class="session-form-body">`,
    `<textarea id="session-prompt-input" class="composer-textarea session-prompt-textarea"`,
    ` placeholder="Describe the task for the root coordinator…"`,
    ` aria-label="Coordinator session prompt"></textarea>`,
    `</div>`,
    `<div class="session-form-footer">`,
    `<button class="btn btn-reply" id="session-start-btn" type="button"`,
    ` aria-label="Start coordinator session">Start session</button>`,
    `</div>`,
  ].join('');
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

  // ── Review ─────────────────────────────────────────────────────────────────

  bridge.onReviewState((state) => {
    renderReview(state);
  });

  bridge.onReviewError((message) => {
    showAppError(message);
  });

  void bridge.reviewRefresh();

  // ── Session start ──────────────────────────────────────────────────────────

  renderSessionStartForm();

  document.getElementById('session-start-form')?.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('#session-start-btn');
    if (!btn) return;
    const textarea = document.getElementById('session-prompt-input') as HTMLTextAreaElement | null;
    const prompt = textarea?.value.trim() ?? '';
    void bridge.sessionStart(prompt.length > 0 ? prompt : null, null).then((r) => {
      if (r.ok && textarea) textarea.value = '';
      else if (!r.ok) showAppError(r.error ?? 'Failed to start coordinator session');
    });
  });

  document.getElementById('view-review')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    const row = target.closest<HTMLElement>('.review-row');
    if (row?.dataset['reviewId'] != null) {
      void bridge.reviewSelect(row.dataset['reviewId']).then((s) => {
        if (s != null) renderReview(s);
      });
      return;
    }

    const btn = target.closest<HTMLElement>('[data-review-action]');
    if (!btn) return;
    const action = btn.dataset['reviewAction'];

    switch (action) {
      case 'begin-pass':
        void bridge.reviewBeginVerdict('PASS').then((s) => {
          if (s != null) renderReview(s);
        });
        break;
      case 'begin-issues':
        void bridge.reviewBeginVerdict('ISSUES').then((s) => {
          if (s != null) renderReview(s);
        });
        break;
      case 'cancel-verdict':
        void bridge.reviewCancelVerdict().then((s) => {
          if (s != null) renderReview(s);
        });
        break;
      case 'submit-verdict':
        void bridge.reviewSubmitVerdict().then((s) => {
          if (s != null) renderReview(s);
        });
        break;
    }
  });

  document.getElementById('view-review')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = (e.target as HTMLElement).closest<HTMLElement>('.review-row');
    if (row?.dataset['reviewId'] == null) return;
    e.preventDefault();
    void bridge.reviewSelect(row.dataset['reviewId']).then((s) => {
      if (s != null) renderReview(s);
    });
  });

  document.getElementById('view-review')?.addEventListener('input', (e) => {
    const textarea = (e.target as HTMLElement).closest<HTMLTextAreaElement>(
      '#review-composer-body',
    );
    if (textarea) {
      void bridge.reviewUpdateComposerBody(textarea.value);
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

    // Stop / Unstick per-agent buttons — check before row selection so clicks on the buttons
    // do not also trigger agent selection.
    const agentBtn = target.closest<HTMLElement>('.agents-agent-btn');
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
      case 'open-review-view':
        activateView('review');
        bridge.navigate('review');
        {
          const reviewId = btn.dataset['reviewId'];
          if (reviewId != null && reviewId.length > 0) {
            void bridge.reviewSelect(reviewId).then((s) => {
              if (s != null) renderReview(s);
            });
          } else {
            void bridge.reviewRefresh().then((s) => {
              if (s != null) renderReview(s);
            });
          }
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
    selectMailRow(row);
  });
});
