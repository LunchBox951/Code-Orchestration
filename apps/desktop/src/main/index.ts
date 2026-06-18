import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import type { ApprovalReply, OperatorMailRef, ProjectId, ReplyDraft } from '@co/core';
import { openRegistry } from '@co/core';
import { createAppShell } from './app-shell.js';
import { createDaemonSupervisor } from './daemon-supervisor.js';
import { createProjectController } from './open-project.js';
import { resolveSourceState } from './source-ipc.js';
import { readBundledDemoSpec, startFromDemoSpec } from './demo-spec.js';
import { desktopErrorMessage } from './desktop-errors.js';
import {
  requireComposerField,
  requireFiniteSeq,
  requireAgentId,
  requireInputData,
  requireMailTab,
  requireMailType,
  requireNavView,
  requireNonEmptyString,
  requirePositiveDim,
  requireReviewVerdict,
  requireSteer,
} from './ipc-guards.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow: BrowserWindow | null = null;

function sendToRenderer(channel: string, data: unknown): void {
  mainWindow?.webContents?.send(channel, data);
}

/**
 * Show the OS directory picker so the operator can pick a repo/dir to open. Resolves to the chosen
 * ABSOLUTE path, or `null` when the operator cancels. This is the production default for the picker seam.
 */
async function showDirectoryDialog(): Promise<string | null> {
  const options = {
    title: 'Open project',
    buttonLabel: 'Open',
    properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
  };
  const result =
    mainWindow != null
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0] ?? null;
}

/**
 * P-ON2 — the app's project lifecycle lives in the {@link createProjectController}. It owns the
 * Conductor daemon + app shell per project: tears the old pair down (daemon first, then shell — no leaked
 * `co-mcp serve`), builds a fresh pair for the chosen project, and surfaces the daemon status +
 * current-project to the renderer. Here we wire the PRODUCTION seams (electron dialog, the @co/core
 * registry, the real supervisor + shell factories); the controller itself is electron-free + headless-tested.
 */
const controller = createProjectController({
  createSupervisor: (opts) => createDaemonSupervisor(opts),
  createShell: (projectId) =>
    createAppShell({
      projectId,
      onNavState: (state) => sendToRenderer('nav:state', state),
      onConnectionState: (state) => sendToRenderer('connection:state', state),
      onConnectionError: (message) => sendToRenderer('connection:error', message),
      onDashboardState: (state) => sendToRenderer('dashboard:state', state),
      onMailState: (state) => sendToRenderer('mail:state', state),
      onMailError: (message) => sendToRenderer('mail:error', message),
      onLimitsCostState: (state) => sendToRenderer('limitsCost:state', state),
      onAgentsConsoleState: (state) => sendToRenderer('agentsConsole:state', state),
      onReviewState: (state) => sendToRenderer('review:state', state),
      onReviewError: (message) => sendToRenderer('review:error', message),
    }),
  openRegistry,
  pickDirectory: showDirectoryDialog,
  onDaemonStatus: (payload) => sendToRenderer('daemon:status', payload),
  onCurrentProject: (state) => sendToRenderer('project:current', state),
  onError: (message) => sendToRenderer('app:error', message),
});

function handleStartupFailure(error: unknown): void {
  console.error('Failed to start CO desktop:', error);

  if (mainWindow != null) {
    mainWindow.destroy();
    mainWindow = null;
  }

  // Tear any live project down (daemon before shell) so we never leak a `co-mcp serve` child, then quit.
  void controller.shutdown().finally(() => {
    app.quit();
  });
}

function openWindow(): void {
  createWindow().catch(handleStartupFailure);
}

/**
 * Bring the project up after the window is loaded. With `CO_PROJECT_ID` set we open that project as before;
 * WITHOUT it the app no longer throws — it comes up in the "no project open" empty state and lets the
 * operator pick a directory (the real on-ramp). An env-open failure degrades to the empty state + a visible
 * error rather than a dead window (Principle 9).
 */
async function bootProject(): Promise<void> {
  const envProjectId = process.env['CO_PROJECT_ID'];
  if (envProjectId == null || envProjectId.length === 0) {
    controller.showNoProject();
    return;
  }
  try {
    await controller.openProject(envProjectId as ProjectId);
  } catch (error: unknown) {
    console.error('Failed to open the project from CO_PROJECT_ID:', error);
    controller.showNoProject(
      `Could not open the project from CO_PROJECT_ID: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1a1c26',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, '../preload/preload.cjs'),
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  // Re-push the latest daemon status + current project once the renderer has loaded + subscribed, so the
  // header reflects any state emitted before the renderer was ready to receive the push (startup race).
  mainWindow.webContents.on('did-finish-load', () => {
    const status = controller.latestDaemonStatus;
    if (status != null) sendToRenderer('daemon:status', status);
    if (controller.currentProject != null) {
      sendToRenderer('project:current', controller.currentProject);
    }
  });

  await mainWindow.loadFile(join(__dirname, '../renderer/index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open the env project (or the no-project on-ramp) only after the renderer is loaded, so the controller's
  // daemon-status + current-project pushes land on a subscribed renderer.
  await bootProject();
}

function requireString(value: unknown, label: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`Invalid ${label}: expected a string.`);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value != null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error(`Invalid ${label}: expected an object.`);
}

function requireMailTarget(value: unknown): OperatorMailRef {
  const target = asRecord(value, 'mail target');
  return {
    seq: requireFiniteSeq(target['seq'], 'mail target seq'),
    recipient: requireNonEmptyString(target['recipient'], 'mail target recipient'),
  };
}

function requireReplyDraft(value: unknown): ReplyDraft {
  const draft = asRecord(value, 'reply draft');
  return {
    type: requireMailType(draft['type']),
    subject: requireString(draft['subject'], 'reply subject'),
    body: requireString(draft['body'], 'reply body'),
    ...(typeof draft['from'] === 'string' ? { from: draft['from'] } : {}),
    ...(typeof draft['idempotencyKey'] === 'string'
      ? { idempotencyKey: draft['idempotencyKey'] }
      : {}),
    ...(draft['decision'] === 'approve' || draft['decision'] === 'decline'
      ? { decision: draft['decision'] }
      : {}),
    ...(draft['reviewVerdict'] === 'PASS' || draft['reviewVerdict'] === 'ISSUES'
      ? { reviewVerdict: draft['reviewVerdict'] }
      : {}),
    ...(typeof draft['reviewContextFingerprint'] === 'string'
      ? { reviewContextFingerprint: draft['reviewContextFingerprint'] }
      : {}),
  };
}

function requireApprovalReply(value: unknown): ApprovalReply {
  const reply = asRecord(value, 'approval reply');
  const decision = reply['decision'];
  if (decision !== 'approve' && decision !== 'decline') {
    throw new Error(`Invalid approval decision: ${String(decision)}`);
  }
  return {
    decision,
    subject: requireString(reply['subject'], 'approval subject'),
    body: requireString(reply['body'], 'approval body'),
  };
}

ipcMain.handle('nav:navigate', (_event, view: unknown) => {
  controller.shell?.nav.navigate(requireNavView(view));
});

ipcMain.handle('connection:refresh', async () => {
  await controller.shell?.connection.refresh();
  return controller.shell?.connection.state ?? null;
});

ipcMain.handle('dashboard:refresh', async () => {
  await controller.shell?.connection.refresh();
  return controller.shell?.dashboard.state ?? null;
});

// ── Mail IPC channels ───────────────────────────────────────────────────────

ipcMain.handle('mail:selectBus', (_event, busId: unknown) => {
  controller.shell?.mail.selectBus(requireNonEmptyString(busId, 'mail bus'));
  return controller.shell?.mail.state ?? null;
});

ipcMain.handle('mail:selectTab', (_event, tab: unknown) => {
  controller.shell?.mail.selectTab(requireMailTab(tab));
  return controller.shell?.mail.state ?? null;
});

ipcMain.handle('mail:select', (_event, seq: unknown) => {
  controller.shell?.mail.selectMail(requireFiniteSeq(seq, 'mail seq'));
  return controller.shell?.mail.state ?? null;
});

ipcMain.handle(
  'mail:openComposer',
  (_event, targetSeq: unknown, targetRecipient: unknown, replyType: unknown, subject: unknown) => {
    controller.shell?.mail.openComposer(
      requireFiniteSeq(targetSeq, 'mail target seq'),
      requireNonEmptyString(targetRecipient, 'mail target recipient'),
      requireMailType(replyType),
      requireString(subject, 'mail reply subject'),
    );
    return controller.shell?.mail.state ?? null;
  },
);

ipcMain.handle('mail:updateComposer', (_event, field: unknown, value: unknown) => {
  controller.shell?.mail.updateComposerField(
    requireComposerField(field),
    requireString(value, 'composer value'),
  );
  return controller.shell?.mail.state ?? null;
});

ipcMain.handle('mail:closeComposer', () => {
  controller.shell?.mail.closeComposer();
  return controller.shell?.mail.state ?? null;
});

ipcMain.handle('mail:submitReply', async () => {
  try {
    await controller.shell?.mail.submitReply();
  } catch {
    // createAppShell already emitted a user-visible mail:error; return current draft state.
  }
  return controller.shell?.mail.state ?? null;
});

ipcMain.handle('mail:reply', async (_event, target: unknown, draft: unknown) => {
  const shell = controller.shell;
  if (shell == null) return { ok: false, error: 'shell not ready' };
  try {
    await shell.client.reply(requireMailTarget(target), requireReplyDraft(draft));
    shell.refreshMail();
    return { ok: true };
  } catch (e: unknown) {
    const msg = desktopErrorMessage(e, 'send mail');
    sendToRenderer('mail:error', msg);
    return { ok: false, error: msg };
  }
});

ipcMain.handle('mail:approve', async (_event, approvalSeq: unknown, reply: unknown) => {
  const shell = controller.shell;
  if (shell == null) return { ok: false, error: 'shell not ready' };
  try {
    await shell.client.approve(
      requireFiniteSeq(approvalSeq, 'approval seq'),
      requireApprovalReply(reply),
    );
    shell.refreshMail();
    await shell.connection.refresh();
    return { ok: true };
  } catch (e: unknown) {
    const msg = desktopErrorMessage(e, 'approve or decline');
    sendToRenderer('mail:error', msg);
    return { ok: false, error: msg };
  }
});

ipcMain.handle('mail:quickApprove', async (_event, approvalSeq: unknown) => {
  try {
    await controller.shell?.mail.approve(requireFiniteSeq(approvalSeq, 'approval seq'));
  } catch {
    // createAppShell already emitted a user-visible mail:error.
  }
  return controller.shell?.mail.state ?? null;
});

ipcMain.handle('mail:quickDecline', async (_event, approvalSeq: unknown) => {
  try {
    await controller.shell?.mail.decline(requireFiniteSeq(approvalSeq, 'approval seq'));
  } catch {
    // createAppShell already emitted a user-visible mail:error.
  }
  return controller.shell?.mail.state ?? null;
});

ipcMain.handle('mail:approveWithComposer', async (_event, approvalSeq: unknown) => {
  try {
    await controller.shell?.mail.approveWithComposer(requireFiniteSeq(approvalSeq, 'approval seq'));
  } catch {
    // createAppShell already emitted a user-visible mail:error; return current draft state.
  }
  return controller.shell?.mail.state ?? null;
});

ipcMain.handle('mail:declineWithComposer', async (_event, approvalSeq: unknown) => {
  try {
    await controller.shell?.mail.declineWithComposer(requireFiniteSeq(approvalSeq, 'approval seq'));
  } catch {
    // createAppShell already emitted a user-visible mail:error; return current draft state.
  }
  return controller.shell?.mail.state ?? null;
});

ipcMain.handle('mail:markRead', async (_event, recipient: unknown, seq: unknown) => {
  const shell = controller.shell;
  if (shell == null) return { ok: false, error: 'shell not ready' };
  try {
    await shell.client.markRead(
      requireNonEmptyString(recipient, 'mail recipient'),
      requireFiniteSeq(seq, 'mail seq'),
    );
    shell.refreshMail();
    return { ok: true };
  } catch (e: unknown) {
    const msg = desktopErrorMessage(e, 'mark mail read');
    sendToRenderer('mail:error', msg);
    return { ok: false, error: msg };
  }
});

ipcMain.handle('mail:refresh', () => {
  controller.shell?.refreshMail();
  return controller.shell?.mail.state ?? null;
});

// ── LimitsCost IPC channels ─────────────────────────────────────────────────

ipcMain.handle('limitsCost:refresh', () => {
  controller.shell?.refreshLimitsCost();
  return controller.shell?.limitsCost.state ?? null;
});

// ── Agents Console IPC channels ─────────────────────────────────────────────

ipcMain.handle('agents:select', (_event, agentId: unknown) => {
  const id = agentId == null ? null : requireAgentId(agentId);
  controller.shell?.selectAgent(id);
  return controller.shell?.agentsConsole.state ?? null;
});

ipcMain.handle('agents:refreshTranscript', () => {
  controller.shell?.refreshTranscript();
  return controller.shell?.agentsConsole.state ?? null;
});

ipcMain.handle('agents:steer', async (_event, agentId: unknown, steer: unknown) => {
  const shell = controller.shell;
  if (shell == null) return { ok: false, error: 'shell not ready' };
  try {
    await shell.client.steer(requireAgentId(agentId), requireSteer(steer));
    return { ok: true };
  } catch (e: unknown) {
    const msg = desktopErrorMessage(e, 'steer the agent');
    return { ok: false, error: msg };
  }
});

// "Message the coordinator" (or any agent): post a fresh actionable operator message that wakes an
// idle/WAITING recipient on the daemon's next tick. Unlike steer, this does NOT require a warm pane —
// it is the path that reaches a coordinator sitting between turns (the user's top blocker).
ipcMain.handle(
  'agents:message',
  async (_event, agentId: unknown, subject: unknown, body: unknown) => {
    const shell = controller.shell;
    if (shell == null) return { ok: false, error: 'shell not ready' };
    try {
      await shell.client.operatorMessage(
        requireAgentId(agentId),
        requireNonEmptyString(subject, 'message subject'),
        requireNonEmptyString(body, 'message body'),
      );
      return { ok: true };
    } catch (e: unknown) {
      const msg = desktopErrorMessage(e, 'send the message');
      return { ok: false, error: msg };
    }
  },
);

ipcMain.handle('agents:input', async (_event, agentId: unknown, data: unknown) => {
  const shell = controller.shell;
  if (shell == null) return { ok: false, error: 'shell not ready' };
  try {
    await shell.client.sendInput(requireAgentId(agentId), requireInputData(data, 'input data'));
    return { ok: true };
  } catch (e: unknown) {
    const msg = desktopErrorMessage(e, 'send keystroke input');
    return { ok: false, error: msg };
  }
});

ipcMain.handle('agents:resize', async (_event, agentId: unknown, cols: unknown, rows: unknown) => {
  const shell = controller.shell;
  if (shell == null) return { ok: false, error: 'shell not ready' };
  try {
    await shell.client.resize(
      requireAgentId(agentId),
      requirePositiveDim(cols, 'cols'),
      requirePositiveDim(rows, 'rows'),
    );
    return { ok: true };
  } catch (e: unknown) {
    const msg = desktopErrorMessage(e, 'resize agent PTY');
    return { ok: false, error: msg };
  }
});

ipcMain.handle('agent:stop', async (_event, agentId: unknown) => {
  const shell = controller.shell;
  if (shell == null) return { ok: false, error: 'shell not ready' };
  try {
    await shell.client.stop(requireAgentId(agentId));
    return { ok: true };
  } catch (e: unknown) {
    const msg = desktopErrorMessage(e, 'stop the agent');
    sendToRenderer('agentsConsole:error', msg);
    return { ok: false, error: msg };
  }
});

ipcMain.handle('agent:unstick', async (_event, agentId: unknown) => {
  const shell = controller.shell;
  if (shell == null) return { ok: false, error: 'shell not ready' };
  try {
    await shell.client.unstick(requireAgentId(agentId));
    return { ok: true };
  } catch (e: unknown) {
    const msg = desktopErrorMessage(e, 'unstick the agent');
    sendToRenderer('agentsConsole:error', msg);
    return { ok: false, error: msg };
  }
});

// ── Session IPC channels ─────────────────────────────────────────────────────

ipcMain.handle('session:start', async (_event, prompt: unknown, specBody: unknown) => {
  const shell = controller.shell;
  if (shell == null) return { ok: false, error: 'shell not ready' };
  try {
    const promptStr =
      typeof prompt === 'string' && prompt.trim().length > 0 ? prompt.trim() : undefined;
    const specStr =
      typeof specBody === 'string' && specBody.trim().length > 0 ? specBody.trim() : undefined;
    await shell.client.startSession({
      ...(promptStr != null ? { prompt: promptStr } : {}),
      ...(specStr != null ? { specBody: specStr } : {}),
    });
    return { ok: true };
  } catch (e: unknown) {
    const msg = desktopErrorMessage(e, 'start a session');
    return { ok: false, error: msg };
  }
});

// Launch a coordinator from the BUNDLED predesigned demo spec (AC-S15-6 — no terminal). Reads
// dist/renderer/demo-spec.md behind an injectable seam and starts a session via the same
// `startSession({ specBody })` path as the free-form form. Every failure is a visible result.
ipcMain.handle('session:startFromDemoSpec', () =>
  startFromDemoSpec({
    client: controller.shell?.client ?? null,
    readDemoSpec: () => readBundledDemoSpec(__dirname),
  }),
);

// ── Source IPC channels ──────────────────────────────────────────────────────

// The read-only Source view's branch surface (AC-S15-7): a direct, offline-safe LOCAL read in main
// (no daemon, no operator-IPC verb) that consumes `@co/core`'s `listBranches`. `currentProject?.path`
// is the open repo's absolute path; `null` ⇒ the visible "no project open" state.
ipcMain.handle('source:refresh', () =>
  resolveSourceState({ currentProject: () => controller.currentProject }),
);

// ── Project + Daemon IPC channels ────────────────────────────────────────────

// The in-app "Open project" on-ramp: pick a directory → register it → (re)start the daemon + shell for it.
ipcMain.handle('project:open', async () => {
  await controller.pickAndOpenProject();
});

ipcMain.handle('daemon:retry', () => controller.retryDaemon());

// ── Review IPC channels ─────────────────────────────────────────────────────

ipcMain.handle('review:select', (_event, reviewId: unknown) => {
  return controller.shell?.reviewSelect(requireNonEmptyString(reviewId, 'reviewId')) ?? null;
});

ipcMain.handle('review:beginVerdict', (_event, verdict: unknown) => {
  return controller.shell?.reviewBeginVerdict(requireReviewVerdict(verdict)) ?? null;
});

ipcMain.handle('review:updateComposerBody', (_event, text: unknown) => {
  return controller.shell?.reviewUpdateComposerBody(requireString(text, 'composer body')) ?? null;
});

ipcMain.handle('review:cancelVerdict', () => {
  return controller.shell?.reviewCancelVerdict() ?? null;
});

ipcMain.handle('review:submitVerdict', async () => {
  return (await controller.shell?.reviewSubmitVerdict()) ?? null;
});

ipcMain.handle('review:refresh', () => {
  return controller.shell?.reviewRefresh() ?? null;
});

app.whenReady().then(openWindow).catch(handleStartupFailure);

app.on('window-all-closed', () => {
  // Stop the daemon then close the shell (inverse of the open order) so no `co-mcp serve` child leaks.
  void controller.shutdown().then(() => {
    if (process.platform !== 'darwin') app.quit();
  });
});

app.on('before-quit', () => {
  // Best-effort: SIGTERM the daemon synchronously so a quit that bypasses window-all-closed (e.g. macOS
  // Cmd-Q) still tears it down. stop() is idempotent, so the window-all-closed path may also run.
  controller.requestDaemonStop();
});

app.on('activate', () => {
  if (mainWindow === null) openWindow();
});
