import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const rendererSource = readFileSync(join(here, 'renderer.ts'), 'utf8');
const htmlSource = readFileSync(join(here, 'index.html'), 'utf8');
const appShellSource = readFileSync(join(here, '../main/app-shell.ts'), 'utf8');
const mainSource = readFileSync(join(here, '../main/index.ts'), 'utf8');

describe('cockpit information architecture', () => {
  it('exposes the six v1 surfaces incl. the Review view (the SH-1 human gate)', () => {
    for (const view of ['dashboard', 'agents', 'mail', 'review', 'source', 'usage']) {
      expect(htmlSource).toContain(`id="view-${view}"`);
      expect(htmlSource).toContain(`data-view="${view}"`);
    }
    // The legacy 'cost' view was renamed to 'usage'.
    expect(htmlSource).not.toContain('data-view="cost"');
  });

  it('renders the chrome: project pill, connection + daemon pills, limits, buddy dock', () => {
    expect(htmlSource).toContain('id="project-pill"');
    expect(htmlSource).toContain('id="connection-pill"');
    expect(htmlSource).toContain('id="daemon-pill"');
    expect(htmlSource).toContain('id="limits-btn"');
    expect(htmlSource).toContain('Vellum');
  });

  it('hydrates the project pill from the bridge projectInfo channel', () => {
    expect(rendererSource).toContain('bridge.projectInfo');
    expect(mainSource).toContain("ipcMain.handle('project:info'");
  });
});

describe('agents console', () => {
  it('agents view markup has required structural elements', () => {
    expect(htmlSource).toContain('id="agents-transcript"');
    expect(htmlSource).toContain('aria-label="Agent transcript"');
    expect(htmlSource).toContain('id="agents-roster"');
    expect(htmlSource).toContain('id="agents-roster" class="agents-rail-body" role="list"');
    expect(htmlSource).toContain('aria-label="Agents"');
    expect(htmlSource).toContain('id="steer-input"');
    expect(htmlSource).toContain('aria-label="Answer agent"');
    expect(htmlSource).toContain('aria-label="Redirect agent"');
    expect(htmlSource).toContain('aria-label="Interrupt agent"');
  });

  it('renderer wires agents console bridge methods and xterm', () => {
    expect(rendererSource).toContain('bridge.agentsSteer(');
    expect(rendererSource).toContain('bridge.agentsSelect(');
    expect(rendererSource).toContain('window.Terminal');
    expect(rendererSource).not.toContain(
      '<div class="sess-row${isSelected ? \' selected\' : \'\'}" data-agent-id="${esc(agent.agentId)}" role="option"',
    );
    expect(rendererSource).toContain('<button class="sess-row-open"');
    expect(rendererSource).toContain("aria-current=\"${isSelected ? 'true' : 'false'}\"");
  });

  it('defers xterm open until the Agents view is visible', () => {
    expect(rendererSource).toContain('function isAgentsViewActive()');
    expect(rendererSource).toContain('if (!isAgentsViewActive()) return;');
    expect(rendererSource).toContain("if (view === 'agents' && latestAgentsState != null)");
  });

  it('only enables steer controls for a selected warm live agent', () => {
    expect(rendererSource).toContain("state.selectedStatus === 'warm'");
  });
});

describe('agents stop / unstick', () => {
  it('per-agent Stop and Unstick buttons render in the session rail with aria-labels', () => {
    expect(rendererSource).toContain('data-agent-action="stop"');
    expect(rendererSource).toContain('data-agent-action="unstick"');
    expect(rendererSource).toContain('aria-label="Stop agent ${esc(accessibleName)}"');
    expect(rendererSource).toContain('aria-label="Unstick agent ${esc(accessibleName)}"');
  });

  it('renderer wires stop/unstick agent buttons to the bridge', () => {
    expect(rendererSource).toContain('bridge.agentsStop(');
    expect(rendererSource).toContain('bridge.agentsUnstick(');
    expect(rendererSource).toContain("agentAction === 'stop'");
    expect(rendererSource).toContain("agentAction === 'unstick'");
  });

  it('stop/unstick click handler stops propagation so row selection is not also triggered', () => {
    const clickBlock = rendererSource.slice(
      rendererSource.indexOf("const agentBtn = target.closest<HTMLElement>('[data-agent-action]')"),
    );
    expect(clickBlock.slice(0, 200)).toContain('e.stopPropagation()');
  });

  it('bridge exposes agentsStop and agentsUnstick methods', () => {
    const preloadSource = readFileSync(join(here, '../preload/preload.cts'), 'utf8');
    expect(preloadSource).toContain('agentsStop(');
    expect(preloadSource).toContain('agentsUnstick(');
    expect(preloadSource).toContain("'agent:stop'");
    expect(preloadSource).toContain("'agent:unstick'");
  });
});

describe('renderer accessibility states', () => {
  it('surfaces active mail tab and bus state with ARIA attributes', () => {
    expect(htmlSource).toContain('role="tablist"');
    expect(htmlSource).toContain('aria-selected="true"');
    expect(htmlSource).toContain('aria-pressed="true"');
    expect(rendererSource).toContain("setAttribute('aria-selected'");
    expect(rendererSource).toContain('aria-pressed');
  });

  it('keeps the limits popover expanded state in sync', () => {
    expect(htmlSource).toContain('aria-controls="limits-popover"');
    expect(htmlSource).toContain('aria-haspopup="dialog"');
    expect(htmlSource).toContain('role="dialog"');
    expect(rendererSource).toContain("setAttribute('aria-expanded', 'true')");
    expect(rendererSource).toContain("setAttribute('aria-expanded', 'false')");
  });

  it('labels the icon-only composer close button', () => {
    expect(rendererSource).toContain('aria-label="Close composer"');
  });

  it('opens non-approval replies against the selected mail recipient inbox', () => {
    const nonApprovalBranch = rendererSource.slice(
      rendererSource.indexOf('} else if (isActionable)'),
    );
    expect(nonApprovalBranch).toContain('data-recipient="${esc(selected.recipient)}"');
    expect(nonApprovalBranch).not.toContain('data-recipient="${esc(selected.sender)}"');
  });

  it('populates the agent-bus selector from dashboard agents', () => {
    expect(rendererSource).toContain('function rememberMailBuses(state: DashboardState)');
    expect(rendererSource).toContain('knownMailBuses.add(agentId)');
    expect(rendererSource).toContain('if (latestMailState != null) renderMail(latestMailState)');
  });

  it('points operator-facing conductor guidance at the shipped co-mcp binary', () => {
    expect(appShellSource).toContain('start `co-mcp serve <projectId>`');
    expect(appShellSource).not.toContain('start `co serve`');
    expect(rendererSource).toContain('co-mcp serve');
  });
});

describe('session start', () => {
  it('session-start-form container is a sibling AFTER dashboard-content (survives rerenders)', () => {
    expect(htmlSource).toContain('id="session-start-form"');
    const dashContent = htmlSource.indexOf('id="dashboard-content"');
    const sessionForm = htmlSource.indexOf('id="session-start-form"');
    expect(dashContent).toBeGreaterThan(-1);
    expect(sessionForm).toBeGreaterThan(dashContent);
  });

  it('renderSessionStartForm injects a labelled textarea and a start button', () => {
    expect(rendererSource).toContain('function renderSessionStartForm()');
    expect(rendererSource).toContain('aria-label="Coordinator session prompt"');
    expect(rendererSource).toContain('id="session-start-btn"');
    expect(rendererSource).toContain('aria-label="Start coordinator session"');
  });

  it('renderer wires session:start to the bridge on button click', () => {
    expect(rendererSource).toContain('bridge.sessionStart(');
    expect(rendererSource).toContain("'#session-start-btn'");
    expect(rendererSource).toContain("textarea.value = ''");
  });

  it('renderer validates a coordinator name before starting a session', () => {
    const startIndex = rendererSource.indexOf("target.closest('#session-start-btn')");
    expect(startIndex).toBeGreaterThan(-1);
    const startBlock = rendererSource.slice(startIndex, startIndex + 900);
    expect(startBlock).toContain('if (nameVal == null)');
    expect(startBlock).toContain('Coordinator name is required');
    expect(startBlock).toContain('bridge.sessionStart(promptVal, null, nameVal)');
  });

  it('demo-spec launcher passes the coordinator name field through the bridge', () => {
    const demoIndex = rendererSource.indexOf('sessionStartFromDemoSpec');
    expect(demoIndex).toBeGreaterThan(-1);
    const demoBlock = rendererSource.slice(demoIndex - 400, demoIndex + 400);
    expect(demoBlock).toContain("document.getElementById('session-name-input')");
    expect(demoBlock).toContain('bridge.sessionStartFromDemoSpec');
    expect(demoBlock).toContain('nameVal');
  });

  it('clears archive UI state when the current project changes', () => {
    const projectIndex = rendererSource.indexOf('function applyCurrentProject');
    expect(projectIndex).toBeGreaterThan(-1);
    const projectBlock = rendererSource.slice(projectIndex, projectIndex + 2200);
    expect(projectBlock).toContain('previousProjectId');
    expect(projectBlock).toContain('latestConnection = null');
    expect(projectBlock).toContain('latestDashboard = null');
    expect(projectBlock).toContain('latestMailState = null');
    expect(projectBlock).toContain('latestAgentsState = null');
    expect(projectBlock).toContain('latestReviewState = null');
    expect(projectBlock).toContain('latestLimitsState = null');
    expect(projectBlock).toContain('latestSource = null');
    expect(projectBlock).toContain('latestArchive = []');
    expect(projectBlock).toContain('pendingDeleteId = null');
    expect(projectBlock).toContain('activeRewakeAgentId = null');
    expect(projectBlock).toContain('archiveRefreshGeneration += 1');
    expect(projectBlock).toContain('reviewInvokeGeneration += 1');
    expect(projectBlock).toContain('renderDashboard()');
    expect(projectBlock).toContain('renderAgents(');
    expect(projectBlock).toContain('renderMail(');
    expect(projectBlock).toContain('renderReview(');
    expect(projectBlock).toContain('renderSource()');
  });

  it('does not describe spec lock as a coordinator side effect', () => {
    expect(rendererSource).not.toContain('it locks the spec');
    expect(rendererSource).not.toContain('before it locks the spec');
    expect(rendererSource).not.toContain('after you lock the spec with `co spec lock`');
    expect(rendererSource).toContain('after you approve the spec-lock request in Mail');
  });

  it('labels approval actions generically because approvals can lock specs, file issues, or publish', () => {
    expect(rendererSource).not.toContain('Approve &amp; merge');
    expect(rendererSource).toContain('Approve request');
  });

  it('renderDashboard targets dashboard-content (not view-dashboard), preserving the session form', () => {
    expect(rendererSource).toContain("document.getElementById('dashboard-content')");
    const renderDashFn = rendererSource.slice(rendererSource.indexOf('function renderDashboard('));
    const fnBody = renderDashFn.slice(0, renderDashFn.indexOf('\nfunction '));
    expect(fnBody).not.toContain("getElementById('view-dashboard')");
  });

  it('session:start request errors surface exactly once through the returned result', () => {
    const returnedErrorDisplays = rendererSource.match(
      /showAppError\(r\.error \?\? 'Failed to start coordinator session'\)/g,
    );
    expect(rendererSource).not.toContain('bridge.onSessionError(');
    expect(rendererSource).toContain('else if (!r.ok)');
    expect(returnedErrorDisplays).toHaveLength(1);
    expect(mainSource).not.toContain("sendToRenderer('session:error'");
  });
});

describe('New-coordinator composer — always-on + name field (C1)', () => {
  it('New-coordinator composer has a name field and is not gated to total===0', () => {
    expect(rendererSource).toContain('id="session-name-input"');
    expect(rendererSource).toContain('bridge.sessionStart('); // still wired
  });

  it('main session:start accepts a name arg', () => {
    // prettier may wrap to ipcMain.handle(\n  'session:start', — match both forms
    expect(mainSource).toMatch(/ipcMain\.handle\(\s*'session:start'/);
    expect(mainSource).toContain('if (nameStr == null)');
    expect(mainSource).toContain('name: nameStr');
  });

  it('composer is shown in coord and fleet phases (not only opened)', () => {
    // The phase gate must cover coord and fleet, not just opened
    const phaseGateRegion = rendererSource.slice(
      rendererSource.indexOf('// Kickoff composer'),
      rendererSource.indexOf('// nav badges'),
    );
    expect(phaseGateRegion).toContain("'coord'");
    expect(phaseGateRegion).toContain("'fleet'");
  });

  it('empty phase does not wipe the form innerHTML (draft survives offline flicker)', () => {
    // The empty early-return must NOT clear form.innerHTML
    const emptyBlock = rendererSource.slice(
      rendererSource.indexOf("if (phase === 'empty')"),
      rendererSource.indexOf('const stats = dash?.stats'),
    );
    expect(emptyBlock).not.toContain('form.innerHTML');
  });
});

describe('Subtree grouping in the fleet tree (C2)', () => {
  it('renderer wraps each top-level node in a subtree-group div', () => {
    expect(rendererSource).toContain('subtree-group');
    // Each root is individually mapped — confirm the per-root renderTreeRows call pattern
    expect(rendererSource).toContain('.map((root) =>');
    expect(rendererSource).toContain('renderTreeRows([root]');
  });

  it('index.html defines .subtree-group CSS', () => {
    expect(htmlSource).toContain('.subtree-group');
  });

  it('fleet rows are not buttons when they contain action buttons', () => {
    expect(rendererSource).not.toContain('<button class="fleet-row"');
    expect(rendererSource).not.toContain(
      '<div class="fleet-row" data-agent-id="${esc(node.agentId)}" role="button" tabindex="0">',
    );
    expect(rendererSource).toContain(
      '<button class="fleet-row-open" data-agent-id="${esc(node.agentId)}" type="button"',
    );
  });

  it('dashboard fleet rows open through a dedicated button instead of a focusable wrapper', () => {
    const clickIndex = rendererSource.indexOf('const fleetOpen = target.closest<HTMLElement>');
    expect(clickIndex).toBeGreaterThan(-1);
    const clickBlock = rendererSource.slice(clickIndex, clickIndex + 350);
    expect(clickBlock).toContain("target.closest<HTMLElement>('.fleet-row-open')");
    expect(clickBlock).toContain("fleetOpen?.dataset['agentId']");
    expect(clickBlock).toContain('openFleetRow');
    expect(rendererSource).not.toContain("target.closest<HTMLElement>('.fleet-row')");
  });

  it('clear-finished does not hide suppressed or queued subtrees', () => {
    const activeFn = rendererSource.slice(
      rendererSource.indexOf('function subtreeActive'),
      rendererSource.indexOf('\nfunction countSubtree'),
    );
    expect(activeFn).toContain("node.status === 'stopped'");
    expect(activeFn).toContain("node.status === 'paused'");
    expect(activeFn).toContain("node.status === 'waiting'");
  });

  it('single-coordinator dashboard copy is status-aware instead of always live', () => {
    expect(rendererSource).toContain('function coordinatorPhaseCopy');
    expect(rendererSource).toContain("case 'stopped':");
    expect(rendererSource).toContain('Coordinator stopped');
    expect(rendererSource).toContain('requires re-wake');
    const dashboardFn = rendererSource.slice(rendererSource.indexOf('function renderDashboard()'));
    expect(dashboardFn).toContain('coordinatorPhaseCopy(');
  });

  it('single-coordinator sublines only say Conductor is driving for warm roots', () => {
    const copyFn = rendererSource.slice(
      rendererSource.indexOf('function coordinatorPhaseCopy'),
      rendererSource.indexOf('\n// ── Navigation'),
    );
    expect(copyFn).toContain("subline: 'Conductor driving 1 agent · coordinator session live'");
    expect(copyFn).toContain("subline: '1 coordinator registered · waiting'");
    expect(copyFn).toContain("subline: '1 coordinator registered · stopped · requires re-wake'");
    expect(copyFn).toContain("subline: '1 coordinator registered · stuck · needs decision'");
    expect(copyFn).toContain("subline: '1 coordinator registered · paused'");
    expect(copyFn).toContain("subline: '1 coordinator registered · status unknown'");
    expect(copyFn).not.toContain("subline: 'Conductor driving 1 agent · coordinator waiting'");
    expect(copyFn).not.toContain("subline: 'Conductor driving 1 agent · coordinator stopped'");
    expect(copyFn).not.toContain("subline: 'Conductor driving 1 agent · coordinator stuck'");
    expect(copyFn).not.toContain("subline: 'Conductor driving 1 agent · coordinator paused'");
    expect(copyFn).not.toContain(
      "subline: 'Conductor driving 1 agent · coordinator status unknown'",
    );
    const dashboardFn = rendererSource.slice(rendererSource.indexOf('function renderDashboard()'));
    expect(dashboardFn).toContain(
      "coordCopy?.subline ?? '1 coordinator registered · status unknown'",
    );
  });
});

describe('Per-coordinator Delete with in-app confirm (C3)', () => {
  it('renderTreeRows emits a Delete button with data-agent-action="delete" for root coordinators', () => {
    expect(rendererSource).toContain('data-agent-action="delete"');
    expect(rendererSource).toContain('aria-label="Delete coordinator ${esc(accessibleName)}"');
    // Must be guarded to depth===0 + coordinator role only
    expect(rendererSource).toContain("depth === 0 && node.role.toLowerCase() === 'coordinator'");
  });

  it('renderer wires agentsDelete to the bridge in the dashboard dispatcher', () => {
    expect(rendererSource).toContain('bridge.agentsDelete(');
    expect(rendererSource).toContain("agentAction === 'delete'");
  });

  it('delete confirmation describes subtree teardown and archive behavior in-app', () => {
    expect(rendererSource).toContain('delete-confirm');
    expect(rendererSource).toContain('const subtreeCount = 1 + countSubtree(node.children)');
    expect(rendererSource).toContain('Delete subtree (${subtreeLabel})');
    expect(rendererSource).not.toContain('Delete ${esc(node.agentId)} and ${1 + countSubtree');
    expect(rendererSource).toContain('unmerged branches archive for 14 days');
    expect(rendererSource).toContain('btn btn-danger');
    expect(htmlSource).toContain('.btn-danger');
  });

  it('moves focus into the delete confirmation after rendering it', () => {
    const deleteIndex = rendererSource.indexOf("agentAction === 'delete'");
    expect(deleteIndex).toBeGreaterThan(-1);
    const deleteBlock = rendererSource.slice(deleteIndex, deleteIndex + 220);
    expect(deleteBlock).toContain('renderDashboard()');
    expect(deleteBlock).toContain('focusDashboardAgentAction');
    expect(deleteBlock).toContain("'delete-cancel'");
  });

  it('dashboard delete dispatcher calls e.stopPropagation() before acting', () => {
    // Locate the dashboard [data-agent-action] branch and verify stopPropagation is called early
    const dashSection = rendererSource.slice(
      rendererSource.indexOf("document.getElementById('view-dashboard')"),
    );
    const actionBlock = dashSection.slice(dashSection.indexOf('[data-agent-action]'));
    expect(actionBlock.slice(0, 300)).toContain('e.stopPropagation()');
  });

  it('main process registers ipcMain.handle for agent:delete', () => {
    expect(mainSource).toMatch(/ipcMain\.handle\(\s*'agent:delete'/);
  });

  it('bridge exposes agentsDelete in both preload and electron-bridge type declarations', () => {
    const preloadSource = readFileSync(join(here, '../preload/preload.cts'), 'utf8');
    const bridgeSource = readFileSync(join(here, 'electron-bridge.d.ts'), 'utf8');
    expect(preloadSource).toContain('agentsDelete(');
    expect(preloadSource).toContain("'agent:delete'");
    expect(bridgeSource).toContain('agentsDelete(');
  });
});

describe('Per-agent Re-wake (C4)', () => {
  it('renderAgents emits a Re-wake button with data-agent-action="rewake" for non-warm agents', () => {
    expect(rendererSource).toContain('data-agent-action="rewake"');
    expect(rendererSource).toContain('aria-label="Re-wake agent ${esc(accessibleName)}"');
    // Must be guarded to agents that are not warm
    expect(rendererSource).toContain("agent.status !== 'warm'");
  });

  it('session rows use a dedicated open button outside sibling action buttons', () => {
    expect(rendererSource).not.toContain('<button class="sess-row"');
    expect(rendererSource).not.toContain(
      '<div class="sess-row${isSelected ? \' selected\' : \'\'}" data-agent-id="${esc(agent.agentId)}" role="option"',
    );
    expect(rendererSource).not.toContain('tabindex="0">');
    expect(rendererSource).toContain('<button class="sess-row-open"');
    expect(rendererSource).toContain('<span class="sess-actions">');
  });

  it('keeps the re-wake composer inside the agent list item', () => {
    expect(rendererSource).toContain('<div class="sess-item" role="listitem">');
    const rowIndex = rendererSource.indexOf('<div class="sess-row${isSelected');
    const composerIndex = rendererSource.indexOf('rewakeComposer,\n', rowIndex);
    expect(rowIndex).toBeGreaterThan(-1);
    expect(composerIndex).toBeGreaterThan(rowIndex);
    expect(rendererSource.slice(composerIndex, composerIndex + 80)).toContain(
      'rewakeComposer,\n            `</div>`,',
    );
  });

  it('re-wake composer state is render-owned so live roster ticks preserve drafts', () => {
    expect(rendererSource).toContain('activeRewakeAgentId');
    expect(rendererSource).toContain('activeRewakeDraft');
  });

  it('renderer wires agentsRewake to the bridge in the agents dispatcher', () => {
    expect(rendererSource).toContain('bridge.agentsRewake(');
    expect(rendererSource).toContain("agentAction === 'rewake'");
  });

  it('agents rewake click handler stops propagation so row selection is not also triggered', () => {
    const clickBlock = rendererSource.slice(
      rendererSource.indexOf("const agentBtn = target.closest<HTMLElement>('[data-agent-action]')"),
    );
    expect(clickBlock.slice(0, 200)).toContain('e.stopPropagation()');
  });

  it('native session open buttons handle keyboard activation', () => {
    expect(rendererSource).not.toContain(
      "document.getElementById('view-agents')?.addEventListener('keydown'",
    );
    const clickIndex = rendererSource.indexOf("target.closest<HTMLElement>('.sess-row-open')");
    expect(clickIndex).toBeGreaterThan(-1);
    const clickBlock = rendererSource.slice(clickIndex, clickIndex + 300);
    expect(clickBlock).toContain('bridge.agentsSelect');
  });

  it('re-wake send preserves the draft until IPC succeeds', () => {
    const sendIndex = rendererSource.indexOf("target.closest('.rewake-send')");
    expect(sendIndex).toBeGreaterThan(-1);
    const sendBlock = rendererSource.slice(sendIndex, sendIndex + 900);
    expect(sendBlock).toContain('void bridge.agentsRewake(agentId, text).then((r) => {');
    expect(sendBlock).toContain('if (r.ok)');
    expect(sendBlock).toContain('activeRewakeDraft =');
    expect(sendBlock.indexOf('activeRewakeDraft =')).toBeGreaterThan(
      sendBlock.indexOf('if (r.ok)'),
    );
  });

  it('main process registers ipcMain.handle for agent:rewake', () => {
    expect(mainSource).toMatch(/ipcMain\.handle\(\s*'agent:rewake'/);
  });

  it('bridge exposes agentsRewake in both preload and electron-bridge type declarations', () => {
    const preloadSource = readFileSync(join(here, '../preload/preload.cts'), 'utf8');
    const bridgeSource = readFileSync(join(here, 'electron-bridge.d.ts'), 'utf8');
    expect(preloadSource).toContain('agentsRewake(');
    expect(preloadSource).toContain("'agent:rewake'");
    expect(bridgeSource).toContain('agentsRewake(');
  });
});

describe('Coordinator name field styling', () => {
  it('input.field shares the dark composer styling with textarea.field', () => {
    expect(htmlSource).toContain('textarea.field,\n      input.field');
  });
});

describe('Archived section with Restore/Purge (C5)', () => {
  it('renderDashboard emits archive action buttons with data-archive-action attributes', () => {
    expect(rendererSource).toContain('data-archive-action="restore"');
    expect(rendererSource).toContain('data-archive-action="purge"');
  });

  it('renderer wires archiveList, archiveRestore, archivePurge to the bridge', () => {
    expect(rendererSource).toContain('bridge.archiveList(');
    expect(rendererSource).toContain('bridge.archiveRestore(');
    expect(rendererSource).toContain('bridge.archivePurge(');
  });

  it('ignores stale archiveList responses after a newer refresh starts', () => {
    expect(rendererSource).toContain('archiveRefreshGeneration');
    expect(rendererSource).toContain('const generation = ++archiveRefreshGeneration');
    expect(rendererSource).toContain('if (generation !== archiveRefreshGeneration) return;');
  });

  it('ignores stale source refresh responses after a newer project read starts', () => {
    expect(rendererSource).toContain('sourceRefreshGeneration');
    expect(rendererSource).toContain('const generation = ++sourceRefreshGeneration');
    expect(rendererSource).toContain('if (generation !== sourceRefreshGeneration) return;');
  });

  it('ignores stale review invoke responses after the current project changes', () => {
    expect(rendererSource).toContain('reviewInvokeGeneration');
    expect(rendererSource).toContain('function applyReviewResult');
    expect(rendererSource).toContain('const generation = reviewInvokeGeneration');
    expect(rendererSource).toContain(
      'if (generation !== reviewInvokeGeneration || state == null) return;',
    );

    const reviewSection = rendererSource.slice(
      rendererSource.indexOf('// ── Review (the SH-1 human gate)'),
      rendererSource.indexOf('// ── Source interactions'),
    );
    expect(reviewSection).toContain('applyReviewResult(bridge.reviewSelect(reviewId))');
    expect(reviewSection).toContain('applyReviewResult(bridge.reviewRefresh())');
    expect(reviewSection).toContain("applyReviewResult(bridge.reviewBeginVerdict('PASS'))");
    expect(reviewSection).toContain("applyReviewResult(bridge.reviewBeginVerdict('ISSUES'))");
    expect(reviewSection).toContain('applyReviewResult(bridge.reviewCancelVerdict())');
    expect(reviewSection).toContain('applyReviewResult(bridge.reviewSubmitVerdict())');
  });

  it('dashboard dispatcher handles data-archive-action and calls e.stopPropagation()', () => {
    const dashSection = rendererSource.slice(
      rendererSource.indexOf("document.getElementById('view-dashboard')"),
    );
    expect(dashSection).toContain('[data-archive-action]');
    // stopPropagation must appear within the archive branch
    const archiveBranch = dashSection.slice(dashSection.indexOf('[data-archive-action]'));
    expect(archiveBranch.slice(0, 400)).toContain('e.stopPropagation()');
  });

  it('archive purge uses a two-step confirmation before calling the bridge', () => {
    expect(rendererSource).toContain('pendingArchivePurgeId');
    expect(rendererSource).toContain('role="alert" data-archive-id');
    expect(rendererSource).toContain('data-archive-action="purge-confirm"');
    expect(rendererSource).toContain('data-archive-action="purge-cancel"');
    const purgeConfirmIndex = rendererSource.indexOf("archiveAction === 'purge-confirm'");
    const bridgePurgeIndex = rendererSource.indexOf('bridge.archivePurge(');
    expect(purgeConfirmIndex).toBeGreaterThan(-1);
    expect(bridgePurgeIndex).toBeGreaterThan(purgeConfirmIndex);
  });

  it('moves focus into the purge confirmation after rendering it', () => {
    const purgeIndex = rendererSource.indexOf("archiveAction === 'purge'");
    expect(purgeIndex).toBeGreaterThan(-1);
    const purgeBlock = rendererSource.slice(purgeIndex, purgeIndex + 220);
    expect(purgeBlock).toContain('renderDashboard()');
    expect(purgeBlock).toContain('focusDashboardArchiveAction');
    expect(purgeBlock).toContain("'purge-cancel'");
  });

  it('main process registers ipcMain.handle for archive:list, archive:restore, archive:purge', () => {
    expect(mainSource).toMatch(/ipcMain\.handle\(\s*'archive:list'/);
    expect(mainSource).toMatch(/ipcMain\.handle\(\s*'archive:restore'/);
    expect(mainSource).toMatch(/ipcMain\.handle\(\s*'archive:purge'/);
  });

  it('bridge exposes archiveList, archiveRestore, archivePurge in both preload and electron-bridge type declarations', () => {
    const preloadSource = readFileSync(join(here, '../preload/preload.cts'), 'utf8');
    const bridgeSource = readFileSync(join(here, 'electron-bridge.d.ts'), 'utf8');
    expect(preloadSource).toContain('archiveList(');
    expect(preloadSource).toContain('archiveRestore(');
    expect(preloadSource).toContain('archivePurge(');
    expect(preloadSource).toContain("'archive:list'");
    expect(preloadSource).toContain("'archive:restore'");
    expect(preloadSource).toContain("'archive:purge'");
    expect(bridgeSource).toContain('archiveList(');
    expect(bridgeSource).toContain('archiveRestore(');
    expect(bridgeSource).toContain('archivePurge(');
  });
});
