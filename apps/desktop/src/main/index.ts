import { app, BrowserWindow, ipcMain } from 'electron';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import type { NavView } from '../shared/nav-vm.js';
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
