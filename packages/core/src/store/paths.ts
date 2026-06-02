import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Program-data root. Precedence (freeze #3, LOCKED order):
 *  1. CO_DATA_DIR           (override; ALL platforms; tests point this at a tmpdir)
 *  2. $XDG_DATA_HOME/co  or  ~/.local/share/co        (Linux / default)
 *  3. ~/Library/Application Support/co                (macOS, process.platform === 'darwin')
 *  4. %LOCALAPPDATA%\co  or  %APPDATA%\co  or  ~/AppData/Local/co   (Windows, 'win32')
 *
 * Pure path computation — does NOT create directories (the Store mkdirs on open).
 */
export function dataRoot(): string {
  const override = process.env.CO_DATA_DIR;
  if (override) {
    return override;
  }

  switch (process.platform) {
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'co');
    case 'win32': {
      const localAppData = process.env.LOCALAPPDATA;
      if (localAppData) {
        return join(localAppData, 'co');
      }
      const appData = process.env.APPDATA;
      if (appData) {
        return join(appData, 'co');
      }
      return join(homedir(), 'AppData', 'Local', 'co');
    }
    default: {
      // Linux / anything else (the default branch).
      const xdgDataHome = process.env.XDG_DATA_HOME;
      if (xdgDataHome) {
        return join(xdgDataHome, 'co');
      }
      return join(homedir(), '.local', 'share', 'co');
    }
  }
}

/** `${dataRoot()}/projects/${projectId}` */
export function projectDataDir(projectId: string): string {
  return join(dataRoot(), 'projects', projectId);
}
