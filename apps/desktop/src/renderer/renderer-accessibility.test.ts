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
    expect(htmlSource).toContain('role="listbox"');
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
    expect(rendererSource).toContain('role="option"');
    expect(rendererSource).toContain("aria-selected=\"${isSelected ? 'true' : 'false'}\"");
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
    expect(rendererSource).toContain('aria-label="Stop agent ${esc(agent.agentId)}"');
    expect(rendererSource).toContain('aria-label="Unstick agent ${esc(agent.agentId)}"');
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
