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
cpSync(
  require.resolve('@xterm/addon-fit/lib/addon-fit.js'),
  join(dstDir, 'vendor', 'addon-fit.js'),
);
