/**
 * Cross-platform post-tsc step: copy static renderer assets (HTML, CSS, fonts)
 * from src/renderer/ to dist/renderer/ so Electron's loadFile() resolves them.
 *
 * Uses only Node built-ins — no shell commands — so it works on Linux, macOS,
 * and Windows (electron-builder targets all three).
 */
import { cpSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, '../src/renderer');
const dstDir = join(here, '../dist/renderer');

const STATIC_EXTS = new Set(['.html', '.css', '.woff', '.woff2', '.ttf', '.otf', '.svg']);

mkdirSync(dstDir, { recursive: true });

for (const name of readdirSync(srcDir)) {
  const srcPath = join(srcDir, name);
  if (statSync(srcPath).isFile() && STATIC_EXTS.has(extname(name))) {
    cpSync(srcPath, join(dstDir, name));
  }
}

// Bundle the predesigned on-ramp demo spec (repo-root docs/) into dist/renderer/demo-spec.md so the
// main process can read it at runtime for "Start from demo spec" (session:startFromDemoSpec). This
// script lives at apps/desktop/scripts, so the repo root is three levels up. Node built-ins only.
cpSync(join(here, '../../../docs/demo-spec-co-improves-its-docs.md'), join(dstDir, 'demo-spec.md'));

// Vendor xterm UMD build + CSS (renderer uses window.Terminal global; no bundler).
mkdirSync(join(dstDir, 'vendor'), { recursive: true });
cpSync(require.resolve('@xterm/xterm/lib/xterm.js'), join(dstDir, 'vendor', 'xterm.js'));
cpSync(require.resolve('@xterm/xterm/css/xterm.css'), join(dstDir, 'vendor', 'xterm.css'));
// Vendor the fit addon UMD (exposes window.FitAddon) the same way — the strict CSP (`script-src 'self'`)
// forbids remote scripts, so the renderer loads it locally via <script src="./vendor/addon-fit.js">.
// The fit addon drives PTY.resize(cols, rows) for the width-agreement that fixes the warped pane (#40).
cpSync(
  require.resolve('@xterm/addon-fit/lib/addon-fit.js'),
  join(dstDir, 'vendor', 'addon-fit.js'),
);

// Bundle the IBM Plex Mono latin woff2 weights the live terminal uses — a fixed, preloaded monospace
// (not a mismeasured system fallback) is what lets xterm measure a stable cell grid (the anti-warp
// requirement, #40). The strict CSP (font-src falls back to default-src 'self') only permits
// self-hosted fonts, so we copy the woff2 into vendor/fonts and @font-face them locally in index.html.
const fontsDir = join(dstDir, 'vendor', 'fonts');
mkdirSync(fontsDir, { recursive: true });
const monoDir = dirname(require.resolve('@fontsource/ibm-plex-mono/package.json'));
for (const weight of ['400', '600']) {
  const file = `ibm-plex-mono-latin-${weight}-normal.woff2`;
  cpSync(join(monoDir, 'files', file), join(fontsDir, file));
}
