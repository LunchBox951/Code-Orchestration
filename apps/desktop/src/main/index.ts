import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import type { ArchiveEntry, ProjectId } from '@co/core';
import { openArchiveStore, openRegistry } from '@co/core';
import { createAppShell } from './app-shell.js';
import { createDaemonSupervisor, resolveSpawnGithubEnv } from './daemon-supervisor.js';
import { createGithubCredentialStore } from './github-credentials.js';
import { createProjectController } from './open-project.js';
import { resolveSourceState } from './source-ipc.js';
import { readBundledDemoSpec, startFromDemoSpec } from './demo-spec.js';
import { desktopErrorMessage } from './desktop-errors.js';
import {
  deleteAgentAndRefresh,
  rewakeAgentAndRefresh,
  startSessionAndRefresh,
  stopAgentAndRefresh,
} from './lifecycle-actions.js';
import {
  requireComposerField,
  requireFiniteSeq,
  requireAgentId,
  requireGithubToken,
  requireInputData,
  requireMailTab,
  requireMailType,
  requireNavView,
  requireNonEmptyString,
  requirePositiveDim,
  requireReviewVerdict,
  requireSettingsLayer,
  requireSteer,
} from './ipc-guards.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let mainWindow: BrowserWindow | null = null;

function sendToRenderer(channel: string, data: unknown): void {
  mainWindow?.webContents?.send(channel, data);
}

/**
 * #95 / #71 — the operator-facing GitHub credential store, encrypted at rest via Electron `safeStorage`
 * under `app.getPath('userData')`. Lazily constructed (Electron's `app` paths/safeStorage are only valid
 * after `app` is ready) and memoized. The plaintext token never leaves this module except into the
 * spawn env the daemon supervisor builds — never to a log, the renderer, or the repo.
 */
let githubCredentialStore: ReturnType<typeof createGithubCredentialStore> | null = null;
function credentialStore(): ReturnType<typeof createGithubCredentialStore> {
  githubCredentialStore ??= createGithubCredentialStore({
    safeStorage,
    userDataPath: app.getPath('userData'),
  });
  return githubCredentialStore;
}

/**
 * Resolve the GitHub provisioning env for each `co-mcp serve` spawn (#95/#71): a connected token (or, with
 * none, a `gh auth token` auto-prime) becomes `CO_GH_TOKEN` so the daemon authenticates every pane app-wide.
 * Reading the store can throw if the keyring vanished mid-session; degrade VISIBLY to no additions rather
 * than stranding the daemon unspawned (the supervisor also guards this seam).
 */
function resolveDaemonGithubEnv(): Readonly<Record<string, string>> {
  let storedToken: string | null = null;
  try {
    storedToken = credentialStore().readToken();
  } catch (e) {
    console.error('Failed to read the stored GitHub credential (continuing without it):', e);
  }
  return resolveSpawnGithubEnv({ storedToken, baseEnv: process.env });
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
  createSupervisor: (opts) =>
    createDaemonSupervisor({ ...opts, resolveExtraEnv: resolveDaemonGithubEnv }),
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
      onSettingsState: (state) => sendToRenderer('settings:state', state),
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

function listArchiveFromStore(projectId: ProjectId): readonly ArchiveEntry[] {
  const archive = openArchiveStore(projectId);
  try {
    return archive.listRecords().map((record) => ({
      id: record.id,
      name: record.name,
      branch: record.branch,
      baseRef: record.baseRef,
      deletedAt: record.deletedAt,
      expiresAt: record.expiresAt,
    }));
  } finally {
    archive.close();
  }
}

ipcMain.handle('nav:navigate', (_event, view: unknown) => {
  controller.shell?.nav.navigate(requireNavView(view));
});

// The renderer's header pill reads the open project's identity via this static channel. With the on-ramp
// the open project is owned by the controller (no longer a single env var), so it resolves from the
// controller's current-project state; live changes additionally arrive over the `project:current` push.
ipcMain.handle('project:info', () => {
  const current = controller.currentProject;
  return current != null ? { id: current.projectId } : null;
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

// Forward a raw keystroke/paste chunk the operator typed into the in-app terminal to the hosted
// pty's stdin (the interactive pane — answers prompts, steers by typing; GitHub #40).
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

// Drive PTY.resize(cols, rows) from the fitted xterm grid so the hosted pty's grid matches the
// rendered grid — the width-agreement that keeps cursor-addressed redraws from warping (#40).
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
    await stopAgentAndRefresh(shell, requireAgentId(agentId));
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

ipcMain.handle('agent:delete', async (_event, agentId: unknown) => {
  const shell = controller.shell;
  if (shell == null) return { ok: false, error: 'shell not ready' };
  try {
    await deleteAgentAndRefresh(shell, requireAgentId(agentId));
    return { ok: true };
  } catch (e: unknown) {
    const msg = desktopErrorMessage(e, 'delete the coordinator');
    sendToRenderer('agentsConsole:error', msg);
    return { ok: false, error: msg };
  }
});

ipcMain.handle('agent:rewake', async (_event, agentId: unknown, message: unknown) => {
  const shell = controller.shell;
  if (shell == null) return { ok: false, error: 'shell not ready' };
  const messageStr =
    typeof message === 'string' && message.trim().length > 0 ? message.trim() : null;
  if (messageStr == null) return { ok: false, error: 'Re-wake message must not be empty.' };
  try {
    await rewakeAgentAndRefresh(shell, requireAgentId(agentId), messageStr);
    return { ok: true };
  } catch (e: unknown) {
    const msg = desktopErrorMessage(e, 're-wake the agent');
    sendToRenderer('agentsConsole:error', msg);
    return { ok: false, error: msg };
  }
});

// ── Session IPC channels ─────────────────────────────────────────────────────

ipcMain.handle(
  'session:start',
  async (_event, prompt: unknown, specBody: unknown, name: unknown) => {
    const shell = controller.shell;
    if (shell == null) return { ok: false, error: 'shell not ready' };
    try {
      const promptStr =
        typeof prompt === 'string' && prompt.trim().length > 0 ? prompt.trim() : undefined;
      const specStr =
        typeof specBody === 'string' && specBody.trim().length > 0 ? specBody.trim() : undefined;
      const nameStr = typeof name === 'string' && name.trim().length > 0 ? name.trim() : null;
      if (nameStr == null) return { ok: false, error: 'Coordinator name is required.' };
      await startSessionAndRefresh(shell, {
        name: nameStr,
        ...(promptStr != null ? { prompt: promptStr } : {}),
        ...(specStr != null ? { specBody: specStr } : {}),
      });
      return { ok: true };
    } catch (e: unknown) {
      const msg = desktopErrorMessage(e, 'start a session');
      return { ok: false, error: msg };
    }
  },
);

// Launch a coordinator from the BUNDLED predesigned demo spec (AC-S15-6 — no terminal). Reads
// dist/renderer/demo-spec.md behind an injectable seam and starts a session via the same
// `startSession({ specBody })` path as the free-form form. Every failure is a visible result.
ipcMain.handle('session:startFromDemoSpec', async (_event, name: unknown) => {
  const shell = controller.shell;
  const result = await startFromDemoSpec({
    client: shell?.client ?? null,
    name: typeof name === 'string' && name.trim().length > 0 ? name.trim() : null,
    readDemoSpec: () => readBundledDemoSpec(__dirname),
  });
  if (result.ok && shell != null) await shell.connection.refresh();
  return result;
});

// ── Archive IPC channels ─────────────────────────────────────────────────────

// READ — use the live shell when available, otherwise fall back to static archive records (never throw).
ipcMain.handle('archive:list', async () => {
  const shell = controller.shell;
  const projectId = controller.currentProject?.projectId;
  if (shell == null) return projectId != null ? listArchiveFromStore(projectId) : [];
  try {
    return await shell.client.listArchive();
  } catch {
    return projectId != null ? listArchiveFromStore(projectId) : [];
  }
});

ipcMain.handle('archive:restore', async (_event, id: unknown) => {
  const shell = controller.shell;
  if (shell == null) return { ok: false, error: 'shell not ready' };
  const idStr = requireNonEmptyString(id, 'archive id');
  try {
    await shell.client.restoreArchive(idStr);
    return { ok: true };
  } catch (e: unknown) {
    const msg = desktopErrorMessage(e, 'restore the archived branch');
    return { ok: false, error: msg };
  }
});

ipcMain.handle('archive:purge', async (_event, id: unknown) => {
  const shell = controller.shell;
  if (shell == null) return { ok: false, error: 'shell not ready' };
  const idStr = requireNonEmptyString(id, 'archive id');
  try {
    await shell.client.purgeArchive(idStr);
    return { ok: true };
  } catch (e: unknown) {
    const msg = desktopErrorMessage(e, 'purge the archived branch');
    return { ok: false, error: msg };
  }
});

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

// ── GitHub Connect IPC channels (#95/#71) ─────────────────────────────────────
//
// Connect-GitHub for the GUI launch path: store an operator-pasted token encrypted, then re-provision
// the daemon so the new CO_GH_TOKEN takes effect across every pane app-wide. The token NEVER appears in
// any IPC payload, log, or error message — `github:status` reports only presence + source.

/** The current GitHub-auth state for the renderer badge — presence + source ONLY, never the token. */
function githubStatus(): { connected: boolean; source: 'connected' | 'env' | 'gh' | null } {
  let stored = false;
  try {
    stored = credentialStore().hasToken();
  } catch (e) {
    console.error('Failed to read the GitHub credential status:', e);
  }
  if (stored) return { connected: true, source: 'connected' };
  // No stored token — report whether the daemon would still authenticate via env or `gh auth login`,
  // so the operator sees "connected (via gh)" rather than a misleading "not connected".
  const env = resolveSpawnGithubEnv({ storedToken: null, baseEnv: process.env });
  if (env['CO_GH_TOKEN'] != null) {
    return {
      connected: true,
      source:
        process.env['CO_GH_TOKEN'] != null ||
        process.env['GH_TOKEN'] != null ||
        process.env['GITHUB_TOKEN'] != null
          ? 'env'
          : 'gh',
    };
  }
  return { connected: false, source: null };
}

ipcMain.handle('github:status', () => githubStatus());

ipcMain.handle('github:connect', async (_event, token: unknown) => {
  let validated: string;
  try {
    validated = requireGithubToken(token);
  } catch (e) {
    // The guard message never echoes the token value.
    return { ok: false, error: e instanceof Error ? e.message : 'Invalid GitHub token.' };
  }
  try {
    credentialStore().storeToken(validated);
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Could not store the GitHub token.',
    };
  }
  // Re-provision the daemon through the serialized open tail so the new CO_GH_TOKEN takes effect and the
  // restart cannot race a concurrent project switch. A failure here leaves the token stored (the next
  // start picks it up) but is surfaced so the operator can retry.
  try {
    await controller.reopenCurrentProject();
  } catch (e) {
    return {
      ok: true,
      warning: `GitHub connected, but the Conductor could not restart automatically: ${
        e instanceof Error ? e.message : String(e)
      }. Use Retry from the header.`,
    };
  }
  sendToRenderer('github:status', githubStatus());
  return { ok: true };
});

ipcMain.handle('github:disconnect', async () => {
  try {
    credentialStore().clearToken();
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Could not clear the GitHub token.',
    };
  }
  try {
    await controller.reopenCurrentProject();
  } catch (e) {
    return {
      ok: true,
      warning: `GitHub disconnected, but the Conductor could not restart automatically: ${
        e instanceof Error ? e.message : String(e)
      }. Use Retry from the header.`,
    };
  }
  sendToRenderer('github:status', githubStatus());
  return { ok: true };
});

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

ipcMain.handle('settings:getState', () => {
  return controller.shell?.getSettingsState() ?? null;
});

ipcMain.handle('settings:set', (_event, payload: unknown) => {
  const { layer, key, value } = payload as { layer?: unknown; key?: unknown; value?: unknown };
  const shell = controller.shell;
  if (shell == null) return { ok: false, error: 'No project open.' };
  return shell.setSetting(
    requireSettingsLayer(layer),
    requireNonEmptyString(key, 'setting key'),
    value,
  );
});

ipcMain.handle('settings:clear', (_event, payload: unknown) => {
  const { layer, key } = payload as { layer?: unknown; key?: unknown };
  const shell = controller.shell;
  if (shell == null) return { ok: false, error: 'No project open.' };
  return shell.clearSetting(requireSettingsLayer(layer), requireNonEmptyString(key, 'setting key'));
});

ipcMain.handle('settings:setLayer', (_event, layer: unknown) => {
  controller.shell?.setSettingsLayer(requireSettingsLayer(layer));
  return controller.shell?.getSettingsState() ?? null;
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
