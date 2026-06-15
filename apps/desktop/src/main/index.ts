import { app, BrowserWindow, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import type { NavView } from '../shared/nav-vm.js';
import type { ApprovalReply, OperatorMailRef, ReplyDraft } from '@co/core';
import { createAppShell } from './app-shell.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let shell: ReturnType<typeof createAppShell> | null = null;
let mainWindow: BrowserWindow | null = null;

function sendToRenderer(channel: string, data: unknown): void {
  mainWindow?.webContents?.send(channel, data);
}

async function createWindow(): Promise<void> {
  const rawProjectId = process.env['CO_PROJECT_ID'];
  if (!rawProjectId) {
    throw new Error('CO_PROJECT_ID environment variable is required to identify the project');
  }
  const projectId = rawProjectId as Parameters<typeof createAppShell>[0]['projectId'];

  shell = createAppShell({
    projectId,
    onNavState: (state) => sendToRenderer('nav:state', state),
    onConnectionState: (state) => sendToRenderer('connection:state', state),
    onDashboardState: (state) => sendToRenderer('dashboard:state', state),
    onMailState: (state) => sendToRenderer('mail:state', state),
    onMailError: (message) => sendToRenderer('mail:error', message),
  });

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1a1c26',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, '../preload/preload.js'),
    },
  });

  await mainWindow.loadFile(join(__dirname, '../renderer/index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  await shell.start();
}

ipcMain.handle('nav:navigate', (_event, view: NavView) => {
  shell?.nav.navigate(view);
});

ipcMain.handle('connection:refresh', async () => {
  await shell?.connection.refresh();
  return shell?.connection.state ?? null;
});

ipcMain.handle('dashboard:refresh', async () => {
  await shell?.connection.refresh();
  return shell?.dashboard.state ?? null;
});

// ── Mail IPC channels ───────────────────────────────────────────────────────

ipcMain.handle('mail:selectBus', (_event, busId: string) => {
  shell?.mail.selectBus(busId);
  return shell?.mail.state ?? null;
});

ipcMain.handle('mail:selectTab', (_event, tab: 'inbox' | 'outbox') => {
  shell?.mail.selectTab(tab);
  return shell?.mail.state ?? null;
});

ipcMain.handle('mail:select', (_event, seq: number) => {
  shell?.mail.selectMail(seq);
  return shell?.mail.state ?? null;
});

ipcMain.handle(
  'mail:openComposer',
  (_event, targetSeq: number, targetRecipient: string, replyType: string, subject: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    shell?.mail.openComposer(targetSeq, targetRecipient, replyType as any, subject);
    return shell?.mail.state ?? null;
  },
);

ipcMain.handle(
  'mail:updateComposer',
  (_event, field: 'type' | 'subject' | 'body', value: string) => {
    shell?.mail.updateComposerField(field, value);
    return shell?.mail.state ?? null;
  },
);

ipcMain.handle('mail:closeComposer', () => {
  shell?.mail.closeComposer();
  return shell?.mail.state ?? null;
});

ipcMain.handle('mail:submitReply', () => {
  shell?.mail.submitReply();
  return shell?.mail.state ?? null;
});

ipcMain.handle('mail:reply', async (_event, target: OperatorMailRef, draft: ReplyDraft) => {
  if (shell == null) return { ok: false, error: 'shell not ready' };
  try {
    await shell.client.reply(target, draft);
    shell.refreshMail();
    return { ok: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    sendToRenderer('mail:error', msg);
    return { ok: false, error: msg };
  }
});

ipcMain.handle('mail:approve', async (_event, approvalSeq: number, reply: ApprovalReply) => {
  if (shell == null) return { ok: false, error: 'shell not ready' };
  try {
    await shell.client.approve(approvalSeq, reply);
    shell.refreshMail();
    await shell.connection.refresh();
    return { ok: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    sendToRenderer('mail:error', msg);
    return { ok: false, error: msg };
  }
});

ipcMain.handle('mail:quickApprove', (_event, approvalSeq: number) => {
  shell?.mail.approve(approvalSeq);
  return shell?.mail.state ?? null;
});

ipcMain.handle('mail:quickDecline', (_event, approvalSeq: number) => {
  shell?.mail.decline(approvalSeq);
  return shell?.mail.state ?? null;
});

ipcMain.handle('mail:markRead', async (_event, recipient: string, seq: number) => {
  if (shell == null) return { ok: false, error: 'shell not ready' };
  try {
    await shell.client.markRead(recipient, seq);
    shell.refreshMail();
    return { ok: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    sendToRenderer('mail:error', msg);
    return { ok: false, error: msg };
  }
});

ipcMain.handle('mail:refresh', () => {
  shell?.refreshMail();
  return shell?.mail.state ?? null;
});

app.whenReady().then(() => {
  void createWindow();
});

app.on('window-all-closed', () => {
  void shell?.close().then(() => {
    if (process.platform !== 'darwin') app.quit();
  });
});

app.on('activate', () => {
  if (mainWindow === null) void createWindow();
});
