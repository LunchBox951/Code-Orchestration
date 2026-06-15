import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, '../..');

function distFile(...parts: string[]): string {
  return readFileSync(join(desktopRoot, 'dist', ...parts), 'utf8');
}

describe('desktop built-output script modes', () => {
  it('loads renderer.js as a module script because tsc emits ESM', () => {
    const html = distFile('renderer', 'index.html');
    const renderer = distFile('renderer', 'renderer.js');

    expect(html).toContain('<script type="module" src="./renderer.js"></script>');
    expect(renderer).toContain('export {};');
  });

  it('emits sandbox-compatible preload JavaScript without static ESM syntax', () => {
    const preload = distFile('preload', 'preload.cjs');

    expect(preload).not.toMatch(/^\s*import\s/m);
    expect(preload).not.toMatch(/^\s*export\s/m);
    expect(() => new Function(preload)).not.toThrow();
  });
});
