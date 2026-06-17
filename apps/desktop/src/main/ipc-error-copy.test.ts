import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

describe('main IPC conductor-down copy', () => {
  it('maps daemon-required IPC failures through desktopErrorMessage', () => {
    const source = readFileSync(join(here, 'index.ts'), 'utf8');

    for (const action of [
      'mark mail read',
      'steer the agent',
      'stop the agent',
      'unstick the agent',
      'start a session',
    ]) {
      expect(source).toContain(`desktopErrorMessage(e, '${action}')`);
    }
    expect(source).not.toContain('const msg = e instanceof Error ? e.message : String(e);');
  });
});
