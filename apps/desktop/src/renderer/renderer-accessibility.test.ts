import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const rendererSource = readFileSync(join(here, 'renderer.ts'), 'utf8');
const htmlSource = readFileSync(join(here, 'index.html'), 'utf8');
const appShellSource = readFileSync(join(here, '../main/app-shell.ts'), 'utf8');
const mainSource = readFileSync(join(here, '../main/index.ts'), 'utf8');

describe('review view', () => {
  it('review view markup has required structural elements', () => {
    expect(htmlSource).toContain('id="view-review"');
    expect(htmlSource).toContain('aria-label="Pending reviews"');
    expect(htmlSource).toContain('aria-label="Review diff"');
    expect(htmlSource).toContain('id="review-badge"');
  });

  it('renderer wires review bridge methods', () => {
    expect(rendererSource).toContain('bridge.reviewSelect(');
    expect(rendererSource).toContain('bridge.reviewSubmitVerdict(');
    expect(rendererSource).toContain('bridge.reviewBeginVerdict(');
    expect(rendererSource).toContain('bridge.reviewUpdateComposerBody(');
    expect(rendererSource).toContain('bridge.reviewCancelVerdict(');
    expect(rendererSource).toContain('bridge.reviewRefresh(');
  });

  it('review list rows use ARIA option roles', () => {
    expect(rendererSource).toContain('role="option"');
    expect(rendererSource).toContain("aria-selected=\"${isSelected ? 'true' : 'false'}\"");
  });

  it('review view has activate hook', () => {
    expect(rendererSource).toContain("if (view === 'review' && latestReviewState != null)");
    expect(rendererSource).toContain('renderReview(latestReviewState)');
  });

  it('verdict buttons have aria-labels', () => {
    expect(rendererSource).toContain('aria-label="Submit PASS verdict"');
    expect(rendererSource).toContain('aria-label="Submit ISSUES verdict"');
  });

  it('gates the verdict-composer detail rebuild to preserve the caret while typing (review #316)', () => {
    // The detail pane must NOT be unconditionally rebuilt: typing in #review-composer-body would
    // recreate the focused textarea and drop the caret. renderReview gates the rebuild on the pure
    // reviewDetailNeedsRebuild helper, keyed on whether that textarea is focused.
    expect(rendererSource).toContain('reviewDetailNeedsRebuild(');
    expect(rendererSource).toContain("document.activeElement?.id === 'review-composer-body'");
  });

  it('points operator-facing conductor guidance at the app-owned daemon status badge + Retry', () => {
    // P-ON1: the app OWNS the Conductor daemon, so guidance must NOT tell the operator to run it by
    // hand. The old "start `co-mcp serve <projectId>`" (and the older `co serve`) copy is gone from
    // both the renderer and the main-process shell.
    expect(rendererSource).not.toContain('co-mcp serve');
    expect(appShellSource).not.toContain('co-mcp serve');
    expect(rendererSource).not.toContain('co serve');
    expect(appShellSource).not.toContain('co serve');
    // Instead it points at the app-owned lifecycle UX: the header status badge + the Retry action.
    expect(appShellSource).toContain('the app manages the daemon');
    expect(appShellSource).toContain('status badge in the header');
    expect(appShellSource).toContain('Retry');
    expect(rendererSource).toContain('the app manages the daemon');
    expect(rendererSource).toContain('status badge in the header');
  });

  it('only exposes verdict actions when the Review view has diff and locked criteria evidence', () => {
    expect(rendererSource).toContain(
      "const canSubmitVerdict = diff.kind === 'patch' && criteria.kind === 'criteria';",
    );
    expect(rendererSource).toContain('!composer.active && canSubmitVerdict');
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
    expect(rendererSource).toContain('aria-selected="${isSelected');
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

  it('gates the mail-composer detail rebuild to preserve the caret while typing (GitHub #39)', () => {
    // Typing in #composer-body must NOT unconditionally rebuild the detail pane: that recreates the
    // focused textarea and drops the caret to offset 0 on every keystroke (typed text reverses).
    // renderMailDetail gates the rebuild on the shared needsRebuild helper keyed on whether that
    // textarea is focused, and captures/restores the caret + scroll when a non-body change forces a
    // rebuild mid-edit. (Substantive behavioural coverage lives in live-render-helpers.test.ts.)
    expect(rendererSource).toContain("document.activeElement?.id === 'composer-body'");
    expect(rendererSource).toContain('mailDetailSignature(');
    expect(rendererSource).toContain('captureInteractionState(');
    expect(rendererSource).toContain('restoreInteractionState(');
  });

  it('opens non-approval replies against the selected mail recipient inbox', () => {
    const nonApprovalBranch = rendererSource.slice(
      rendererSource.indexOf('} else if (isActionable)'),
    );
    expect(nonApprovalBranch).toContain('data-recipient="${esc(selected.recipient)}"');
    expect(nonApprovalBranch).not.toContain('data-recipient="${esc(selected.sender)}"');
  });

  it('keeps review_request verdicts out of the Mail composer', () => {
    expect(rendererSource).toContain("if (mailType === MAIL_REVIEW_REQUEST) return 'review'");
    expect(rendererSource).not.toContain('mailType === MAIL_REVIEW_REQUEST ? MAIL_REVIEW_RESPONSE');
    expect(rendererSource).not.toContain("'Submit verdict'");
    expect(rendererSource).toContain('Open in Reviews');
    expect(rendererSource).toContain('data-review-id="${esc(reviewId)}"');
    expect(rendererSource).toContain('bridge.reviewSelect(reviewId)');
  });

  it('populates the agent-bus selector from dashboard agents', () => {
    expect(rendererSource).toContain('function rememberMailBuses(state: DashboardState)');
    expect(rendererSource).toContain('knownMailBuses.add(agentId)');
    expect(rendererSource).toContain('if (latestMailState != null) renderMail(latestMailState)');
  });
});

describe('session start (P4)', () => {
  it('session-start-form container is in the HTML (static, outside dashboard-content)', () => {
    expect(htmlSource).toContain('id="session-start-form"');
    // Must be a sibling of dashboard-content, not inside it (survives renderDashboard rewrites).
    const dashContent = htmlSource.indexOf('id="dashboard-content"');
    const sessionForm = htmlSource.indexOf('id="session-start-form"');
    expect(dashContent).toBeGreaterThan(-1);
    expect(sessionForm).toBeGreaterThan(-1);
    // session-start-form must appear AFTER dashboard-content in document order
    // (sibling, not nested inside dashboard-content which renderDashboard overwrites).
    expect(sessionForm).toBeGreaterThan(dashContent);
  });

  it('renderSessionStartForm injects a textarea with the correct aria-label and a start button', () => {
    expect(rendererSource).toContain('function renderSessionStartForm()');
    expect(rendererSource).toContain('aria-label="Coordinator session prompt"');
    expect(rendererSource).toContain('id="session-start-btn"');
    expect(rendererSource).toContain('aria-label="Start coordinator session"');
  });

  it('renderer wires session:start to the bridge on button click', () => {
    expect(rendererSource).toContain('bridge.sessionStart(');
    expect(rendererSource).toContain("'#session-start-btn'");
    // On success the textarea is cleared.
    expect(rendererSource).toContain("textarea.value = ''");
  });

  it('renderDashboard targets dashboard-content (not view-dashboard), preserving the session form', () => {
    expect(rendererSource).toContain("document.getElementById('dashboard-content')");
    // Must NOT target view-dashboard as the container (would wipe the form on every tick).
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
    expect(rendererSource).toContain(
      "showAppError(r.error ?? 'Failed to start coordinator session')",
    );
    expect(returnedErrorDisplays).toHaveLength(1);
    expect(mainSource).not.toContain("sendToRenderer('session:error'");
  });
});

describe('source read surface (P-ON4) + demo-spec launch (P-ON3)', () => {
  const preloadSource = readFileSync(join(here, '../preload/preload.cts'), 'utf8');

  it('replaces the Source stub with labelled Branches + local PR-ref containers', () => {
    expect(htmlSource).toContain('id="view-source"');
    expect(htmlSource).not.toContain('Coming in a later stage.');
    // Read-only Branches list + local pull-request refs (offline-safe; no gh/network dependency).
    expect(htmlSource).toContain('id="source-branches"');
    expect(htmlSource).toContain('aria-label="Branches"');
    expect(htmlSource).toContain('id="source-pull-requests"');
    expect(htmlSource).toContain('aria-label="Pull requests"');
    expect(htmlSource).not.toContain('deferred.');
    expect(htmlSource).toContain('id="source-refresh-btn"');
    expect(htmlSource).toContain('aria-label="Refresh branches"');
  });

  it('renderer renders the branch list read-only and wires sourceRefresh on activation + Refresh', () => {
    expect(rendererSource).toContain('function renderSource(state: SourceState)');
    // Source is pulled on view activation (no push channel) and via the Refresh/Retry controls. The
    // activation hook lives in module-scope activateView, so it calls the bridge via window.coShell.
    expect(rendererSource).toContain('const wasActive = isViewActive(view)');
    expect(rendererSource).toContain("if (view === 'source' && !wasActive)");
    expect(rendererSource).toContain("if (isViewActive('source')) refreshSource();");
    expect(rendererSource).toContain('createLatestAsyncRequest<SourceState | null>()');
    expect(rendererSource).toContain('sourceRefreshGate.run(');
    expect(rendererSource).toContain('.sourceRefresh(');
    expect(rendererSource).toContain('function renderPullRequests(');
    expect(rendererSource).toContain('state.pullRequests');
    expect(rendererSource).toContain('No local pull-request refs fetched.');
    expect(rendererSource).toContain("getElementById('view-source')");
    expect(rendererSource).toContain('data-source-action="retry"');
  });

  it('clears project-scoped renderer state and invalidates pending Source refreshes on project switch', () => {
    expect(rendererSource).toContain('function resetProjectScopedState(');
    expect(rendererSource).toContain('sourceRefreshGate.invalidate()');
    expect(rendererSource).toContain('latestDashboardState = null');
    expect(rendererSource).toContain('latestMailState = null');
    expect(rendererSource).toContain('latestReviewState = null');
    expect(rendererSource).toContain('latestAgentsState = null');
    expect(rendererSource).toContain('bridge.onCurrentProject((payload) => {');
    const handler = rendererSource.slice(rendererSource.indexOf('bridge.onCurrentProject'));
    expect(handler.indexOf('resetProjectScopedState(payload)')).toBeLessThan(
      handler.indexOf('setCurrentProject(payload)'),
    );
  });

  it('renderer renders explicit no-project + error states for Source (Principle 9)', () => {
    expect(rendererSource).toContain("state.kind === 'no-project'");
    expect(rendererSource).toContain("state.kind === 'path-missing'");
    expect(rendererSource).toContain("state.kind === 'error'");
    expect(rendererSource).toContain('No project open');
    expect(rendererSource).toContain('aria-label="Retry loading branches"');
  });

  it('exposes the "Start from demo spec" button wired to the bridge alongside Start session', () => {
    expect(rendererSource).toContain('id="session-start-demo-btn"');
    expect(rendererSource).toContain('aria-label="Start coordinator session from demo spec"');
    expect(rendererSource).toContain('bridge.startFromDemoSpec(');
    // The existing free-form Start session button stays wired + unchanged.
    expect(rendererSource).toContain('id="session-start-btn"');
    expect(rendererSource).toContain('bridge.sessionStart(');
  });

  it('bridge + IPC expose sourceRefresh + startFromDemoSpec end-to-end', () => {
    expect(preloadSource).toContain('sourceRefresh(');
    expect(preloadSource).toContain("'source:refresh'");
    expect(preloadSource).toContain("'path-missing'");
    expect(preloadSource).toContain('startFromDemoSpec(');
    expect(preloadSource).toContain("'session:startFromDemoSpec'");
    expect(mainSource).toContain("ipcMain.handle('source:refresh'");
    expect(mainSource).toContain("ipcMain.handle('session:startFromDemoSpec'");
    // Source consumes @co/core's listBranches via the helper — the adapter does not re-read git itself.
    expect(mainSource).toContain('resolveSourceState(');
    expect(mainSource).toContain('startFromDemoSpec(');
  });
});

describe('agents stop / unstick (P4)', () => {
  it('per-agent Stop and Unstick buttons render in agents roster with correct aria-labels', () => {
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
    // The agent-btn handler calls e.stopPropagation() before the roster-row handler fires.
    const clickBlock = rendererSource.slice(
      rendererSource.indexOf("const agentBtn = target.closest<HTMLElement>('.agents-agent-btn')"),
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

describe('no silent failures (AC-S15-11 [ST-3], Principle 9)', () => {
  const preloadSource = readFileSync(join(here, '../preload/preload.cts'), 'utf8');

  it('Site 1: transcript-fetch error renders a persistent in-pane Retry, wired end-to-end', () => {
    // Markup: a persistent error container (not a vanishing toast) lives in the agents pane.
    expect(htmlSource).toContain('id="agents-transcript-error"');
    // Renderer: render the banner from state.transcriptError + a Retry button → the refresh bridge.
    expect(rendererSource).toContain('function renderTranscriptError(');
    expect(rendererSource).toContain('data-agents-action="retry-transcript"');
    expect(rendererSource).toContain('bridge.agentsRefreshTranscript(');
    // Bridge + IPC + shell retry channel exist (a re-select of the same agent is a no-op).
    expect(preloadSource).toContain('agentsRefreshTranscript(');
    expect(preloadSource).toContain("'agents:refreshTranscript'");
    expect(mainSource).toContain("'agents:refreshTranscript'");
    expect(appShellSource).toContain('refreshTranscript()');
    // The swallow is gone — the catch surfaces the error to the VM instead of {}.
    expect(appShellSource).toContain('agentsConsoleVm.setTranscriptError(');
    expect(appShellSource).not.toContain('.catch(() => {});');
  });

  it('Sites 2 & 4: review-context error/timeout renders an in-pane Retry, wired end-to-end', () => {
    // Renderer: an error context renders a message + Retry that re-selects (re-enters loading).
    expect(rendererSource).toContain("context.status === 'error'");
    expect(rendererSource).toContain('data-review-action="retry-context"');
    expect(rendererSource).toContain("case 'retry-context'");
    // Shell: both the in-pane error state and the existing toast fire; a timeout guards eternal loading.
    expect(appShellSource).toContain('reviewVm.setReviewContextError(');
    expect(appShellSource).toContain('Timed out loading review context');
    expect(appShellSource).toContain('REVIEW_CONTEXT_TIMEOUT_MS');
    expect(appShellSource).toContain('clearTimeout(timer)');
  });

  it('Site 3: bootstrap fire-and-forget refreshes surface IPC rejections as a toast', () => {
    // Each bootstrap invoke attaches a .catch → showAppError instead of a bare `void bridge.*()`.
    expect(rendererSource).toContain('Failed to load mail');
    expect(rendererSource).toContain('Failed to load limits / cost');
    expect(rendererSource).toContain('Failed to load reviews');
    expect(rendererSource).not.toMatch(/void bridge\.mailRefresh\(\);/);
    expect(rendererSource).not.toMatch(/void bridge\.refreshLimitsCost\(\);/);
    expect(rendererSource).not.toMatch(/void bridge\.reviewRefresh\(\);/);
  });
});

describe('open project on-ramp (P-ON2)', () => {
  const preloadSource = readFileSync(join(here, '../preload/preload.cts'), 'utf8');

  it('header exposes the current-project pill + an Open project control', () => {
    expect(htmlSource).toContain('id="current-project-label"');
    expect(htmlSource).toContain('id="open-project-btn"');
    expect(htmlSource).toContain('aria-label="Open project"');
  });

  it('a "no project open" empty state is present and offers Open project', () => {
    expect(htmlSource).toContain('id="no-project-overlay"');
    expect(htmlSource).toContain('id="no-project-open-btn"');
    expect(htmlSource).toContain('aria-label="No project open"');
  });

  it('renderer wires both Open project buttons to the bridge and reflects current-project state', () => {
    expect(rendererSource).toContain('bridge.openProject(');
    expect(rendererSource).toContain('bridge.onCurrentProject(');
    expect(rendererSource).toContain("getElementById('open-project-btn')");
    expect(rendererSource).toContain("getElementById('no-project-open-btn')");
    // The overlay reveals when there is no project (payload == null) and hides once one is open.
    expect(rendererSource).toContain("getElementById('no-project-overlay')");
    expect(rendererSource).toContain('overlay.hidden = payload != null');
  });

  it('register/open failures surface as a visible toast (Principle 9)', () => {
    expect(rendererSource).toContain('bridge.onAppError(');
  });

  it('bridge + IPC expose the openProject + current-project + app-error channels end-to-end', () => {
    expect(preloadSource).toContain('openProject(');
    expect(preloadSource).toContain("'project:open'");
    expect(preloadSource).toContain("'project:current'");
    expect(preloadSource).toContain("'app:error'");
    expect(mainSource).toContain("ipcMain.handle('project:open'");
    expect(mainSource).toContain('controller.pickAndOpenProject(');
  });

  it('main replaces the CO_PROJECT_ID-required throw with the no-project on-ramp', () => {
    // The old hard requirement is gone: a missing env now shows the empty state instead of throwing.
    expect(mainSource).not.toContain('CO_PROJECT_ID environment variable is required');
    expect(mainSource).toContain('controller.showNoProject(');
  });

  it('the directory picker requests an OS directory selection (openDirectory)', () => {
    expect(mainSource).toContain('showOpenDialog');
    expect(mainSource).toContain("'openDirectory'");
  });
});
