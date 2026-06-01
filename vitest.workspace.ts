import { fileURLToPath } from 'node:url';
import { defineWorkspace } from 'vitest/config';

// Tests run against TypeScript *source*, not built output: the canonical pipeline
// runs `pnpm test` before `pnpm build`, so no `dist/` exists yet. Vite would
// otherwise resolve the `@co/core` workspace import via its package.json
// `exports` → `./dist/index.js` (absent pre-build) and fail. Aliasing the bare
// specifier to core's source keeps `test`, `test:watch`, and direct `vitest`
// invocations all green without a build step.
const coreSrc = fileURLToPath(new URL('./packages/core/src/index.ts', import.meta.url));

export default defineWorkspace([
  {
    test: {
      name: 'packages',
      include: ['packages/*/src/**/*.test.ts'],
    },
    resolve: {
      alias: [{ find: /^@co\/core$/, replacement: coreSrc }],
    },
  },
]);
