import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      'node_modules/**',
      '.co/**',
      '.claude/**',
      '.codex/**',
      'docs/**',
      '.goals/**',
      '.research/**',
      'apps/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // AC-L2-1 — keep packages/cli and packages/mcp THIN adapters (Principle 4 — one-agent-surface):
  // they may import ONLY the @co/core public barrel (plus, for mcp, the MCP SDK and node builtins).
  // Reaching into deep core internals or opening the store directly IS orchestration logic, so it
  // is forbidden here; that is the mechanical guard that all orchestration logic stays in core.
  {
    files: ['packages/cli/src/**/*.ts', 'packages/mcp/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@co/core/*', '@co/core/**'],
              message:
                'Adapters import ONLY the @co/core public barrel — no deep/internal imports (AC-L2-1).',
            },
            {
              group: ['**/packages/core/src/**', '**/packages/core/dist/**'],
              message:
                'Adapters must not reach into core source/dist — import the @co/core barrel (AC-L2-1).',
            },
          ],
          paths: [
            {
              name: 'node:sqlite',
              message:
                'Adapters must not open the store directly — that is core logic (AC-L2-1 layering).',
            },
          ],
        },
      ],
    },
  },
);
