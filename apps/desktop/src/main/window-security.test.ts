import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(join(here, 'index.ts'), 'utf8');

describe('Electron BrowserWindow security hardening', () => {
  it('enables sandboxing alongside context isolation and disabled Node integration', () => {
    expect(mainSource).toContain('contextIsolation: true');
    expect(mainSource).toContain('nodeIntegration: false');
    expect(mainSource).toContain('sandbox: true');
  });

  it('denies unexpected navigations and new windows', () => {
    expect(mainSource).toContain('setWindowOpenHandler');
    expect(mainSource).toContain("action: 'deny'");
    expect(mainSource).toContain("'will-navigate'");
    expect(mainSource).toContain('preventDefault()');
  });
});
