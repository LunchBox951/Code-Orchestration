import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, '../..');

function distFile(...parts: string[]): string {
  return readFileSync(join(desktopRoot, 'dist', ...parts), 'utf8');
}

function distExists(...parts: string[]): boolean {
  return existsSync(join(desktopRoot, 'dist', ...parts));
}

describe('desktop built-output script modes', () => {
  it('loads renderer.js as a module script because tsc emits ESM', () => {
    const html = distFile('renderer', 'index.html');
    const renderer = distFile('renderer', 'renderer.js');

    expect(html).toContain('<script type="module" src="./renderer.js"></script>');
    // renderer.ts is loaded as an ES module (no bundler): tsc emits browser-loadable JS that wires
    // the cockpit to the coShell bridge. Assert the emitted file is the real renderer, not a stub.
    expect(renderer).toContain('coShell');
    expect(renderer).toContain('addEventListener');
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

  it('vendors the xterm fit addon (window.FitAddon) loaded BEFORE the module renderer', () => {
    const html = distFile('renderer', 'index.html');
    const addonFit = distFile('renderer', 'vendor', 'addon-fit.js');

    // The fit addon must load as a self-script BEFORE renderer.js so window.FitAddon exists when the
    // live terminal is constructed (the width-agreement that fixes the warped, read-only pane, #40).
    const fitIdx = html.indexOf('./vendor/addon-fit.js');
    const rendererIdx = html.indexOf('./renderer.js');
    expect(fitIdx).toBeGreaterThan(-1);
    expect(rendererIdx).toBeGreaterThan(-1);
    expect(fitIdx).toBeLessThan(rendererIdx);
    expect(addonFit).toContain('FitAddon');
  });

  it('bundles the IBM Plex Mono woff2 the live terminal @font-faces for a stable cell grid', () => {
    const html = distFile('renderer', 'index.html');
    expect(distExists('renderer', 'vendor', 'fonts', 'ibm-plex-mono-latin-400-normal.woff2')).toBe(
      true,
    );
    expect(html).toContain('./vendor/fonts/ibm-plex-mono-latin-400-normal.woff2');
    expect(html).toContain("font-family: 'IBM Plex Mono'");
  });

  it('emits sandbox-compatible preload JavaScript without static ESM syntax', () => {
    const preload = distFile('preload', 'preload.cjs');

    expect(preload).not.toMatch(/^\s*import\s/m);
    expect(preload).not.toMatch(/^\s*export\s/m);
    expect(() => new Function(preload)).not.toThrow();
  });
});
