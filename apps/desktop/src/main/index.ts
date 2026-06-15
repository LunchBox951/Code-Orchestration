import { app, BrowserWindow, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import type { ApprovalReply, OperatorMailRef, ReplyDraft } from '@co/core';
import { createAppShell } from './app-shell.js';
import {
  requireComposerField,
  requireFiniteSeq,
  requireMailTab,
  requireMailType,
  requireNavView,
  requireNonEmptyString,
} from './ipc-guards.js';

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
    onLimitsCostState: (state) => sendToRenderer('limitsCost:state', state),
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
  shell?.nav.navigate(requireNavView(view));
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

ipcMain.handle('mail:selectBus', (_event, busId: unknown) => {
  shell?.mail.selectBus(requireNonEmptyString(busId, 'mail bus'));
  return shell?.mail.state ?? null;
});

ipcMain.handle('mail:selectTab', (_event, tab: unknown) => {
  shell?.mail.selectTab(requireMailTab(tab));
  return shell?.mail.state ?? null;
});

ipcMain.handle('mail:select', (_event, seq: unknown) => {
  shell?.mail.selectMail(requireFiniteSeq(seq, 'mail seq'));
  return shell?.mail.state ?? null;
});

ipcMain.handle(
  'mail:openComposer',
  (_event, targetSeq: unknown, targetRecipient: unknown, replyType: unknown, subject: unknown) => {
    shell?.mail.openComposer(
      requireFiniteSeq(targetSeq, 'mail target seq'),
      requireNonEmptyString(targetRecipient, 'mail target recipient'),
      requireMailType(replyType),
      requireString(subject, 'mail reply subject'),
    );
    return shell?.mail.state ?? null;
  },
);

ipcMain.handle('mail:updateComposer', (_event, field: unknown, value: unknown) => {
  shell?.mail.updateComposerField(
    requireComposerField(field),
    requireString(value, 'composer value'),
  );
  return shell?.mail.state ?? null;
});

ipcMain.handle('mail:closeComposer', () => {
  shell?.mail.closeComposer();
  return shell?.mail.state ?? null;
});

ipcMain.handle('mail:submitReply', () => {
  shell?.mail.submitReply();
  return shell?.mail.state ?? null;
});

ipcMain.handle('mail:reply', async (_event, target: unknown, draft: unknown) => {
  if (shell == null) return { ok: false, error: 'shell not ready' };
  try {
    await shell.client.reply(requireMailTarget(target), requireReplyDraft(draft));
    shell.refreshMail();
    return { ok: true };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    sendToRenderer('mail:error', msg);
    return { ok: false, error: msg };
  }
});

ipcMain.handle('mail:approve', async (_event, approvalSeq: unknown, reply: unknown) => {
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
    const msg = e instanceof Error ? e.message : String(e);
    sendToRenderer('mail:error', msg);
    return { ok: false, error: msg };
  }
});

ipcMain.handle('mail:quickApprove', (_event, approvalSeq: unknown) => {
  shell?.mail.approve(requireFiniteSeq(approvalSeq, 'approval seq'));
  return shell?.mail.state ?? null;
});

ipcMain.handle('mail:quickDecline', (_event, approvalSeq: unknown) => {
  shell?.mail.decline(requireFiniteSeq(approvalSeq, 'approval seq'));
  return shell?.mail.state ?? null;
});

ipcMain.handle('mail:approveWithComposer', (_event, approvalSeq: unknown) => {
  shell?.mail.approveWithComposer(requireFiniteSeq(approvalSeq, 'approval seq'));
  return shell?.mail.state ?? null;
});

ipcMain.handle('mail:declineWithComposer', (_event, approvalSeq: unknown) => {
  shell?.mail.declineWithComposer(requireFiniteSeq(approvalSeq, 'approval seq'));
  return shell?.mail.state ?? null;
});

ipcMain.handle('mail:markRead', async (_event, recipient: unknown, seq: unknown) => {
  if (shell == null) return { ok: false, error: 'shell not ready' };
  try {
    await shell.client.markRead(
      requireNonEmptyString(recipient, 'mail recipient'),
      requireFiniteSeq(seq, 'mail seq'),
    );
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

// ── LimitsCost IPC channels ─────────────────────────────────────────────────

ipcMain.handle('limitsCost:refresh', () => {
  shell?.refreshLimitsCost();
  return shell?.limitsCost.state ?? null;
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
