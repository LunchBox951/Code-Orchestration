import { fileURLToPath } from 'node:url';
import { defineConfig, defineProject } from 'vitest/config';

// Vitest resolves workspace packages through their package.json exports by default,
// which can point adapter tests at stale `dist/` output during direct package runs.
// Alias the bare specifier to core source so CLI/MCP tests always exercise the
// current checkout.
const coreSrc = fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url));
const mcpSrc = fileURLToPath(new URL('./packages/mcp/src/index.ts', import.meta.url));

export default defineConfig({
  test: {
    projects: [
      defineProject({
        test: {
          name: 'packages',
          include: ['packages/*/src/**/*.test.ts'],
        },
        resolve: {
          alias: [{ find: /^@co\/core$/, replacement: coreSrc }],
        },
      }),
      defineProject({
        test: {
          name: 'desktop',
          include: ['apps/desktop/src/**/*.test.ts'],
        },
        resolve: {
          alias: [
            { find: /^@co\/core$/, replacement: coreSrc },
            { find: /^@co\/mcp$/, replacement: mcpSrc },
          ],
        },
      }),
    ],
  },
});
