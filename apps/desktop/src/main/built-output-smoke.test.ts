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
    // renderer.ts is an ES module — it statically imports the review-render helpers — so tsc emits an
    // ESM `import` the browser loads (no bundler), and the sibling helper module is emitted alongside it.
    expect(renderer).toMatch(/^import .* from '\.\/review-render-helpers\.js';/m);
    expect(distFile('renderer', 'review-render-helpers.js')).toContain('reviewDetailNeedsRebuild');
  });

  it('vendors xterm assets referenced by the renderer HTML', () => {
    const html = distFile('renderer', 'index.html');
    const xtermJs = distFile('renderer', 'vendor', 'xterm.js');
    const xtermCss = distFile('renderer', 'vendor', 'xterm.css');

    expect(html).toContain('<link rel="stylesheet" href="./vendor/xterm.css" />');
    expect(html).toContain('<script src="./vendor/xterm.js"></script>');
    expect(xtermJs).toContain('Terminal');
    expect(xtermCss).toContain('.xterm');
  });

  it('bundles the predesigned demo spec into dist/renderer for session:startFromDemoSpec (P-ON3)', () => {
    // copy-renderer-assets.mjs copies repo-root docs/demo-spec-co-improves-its-docs.md → demo-spec.md
    // so the main process can read it at runtime (readBundledDemoSpec(__dirname) → ../renderer/demo-spec.md).
    const spec = distFile('renderer', 'demo-spec.md');
    expect(spec).toContain('# co improves its own docs');
  });

  it('emits sandbox-compatible preload JavaScript without static ESM syntax', () => {
    const preload = distFile('preload', 'preload.cjs');

    expect(preload).not.toMatch(/^\s*import\s/m);
    expect(preload).not.toMatch(/^\s*export\s/m);
    expect(() => new Function(preload)).not.toThrow();
  });
});
