# Project Scaffolding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Code Orchestration (`co`) repository as an open-source-ready, GitHub-native TypeScript monorepo whose governance mirrors `co`'s own role/phase/review-gate model, while temporarily hosting the Claude-Orchestrator prototype that builds it.

**Architecture:** pnpm-workspaces monorepo — `packages/core` (the single source of truth) consumed by thin adapters `packages/cli` and `packages/mcp`, plus a stubbed `apps/desktop`. The design corpus migrates from `.goals/`/`.research/` into `docs/`. Full governance (LICENSE/CONTRIBUTING/CoC/SECURITY/GOVERNANCE), a `.github/` mirror (issue types = work units, labels = roles/lifecycle, branch protection = the review gate), DCO sign-off, Conventional Commits, and a two-track `main`/`nightly` release structure (policy parked).

**Tech Stack:** TypeScript 5.7 (ESM, NodeNext, strict, project references), pnpm 9, Vitest, ESLint 9 flat config + typescript-eslint, Prettier, GitHub Actions.

**Source spec:** `docs/superpowers/specs/2026-06-01-project-scaffolding-design.md`

---

## Conventions for every commit in this plan

- **Conventional Commits** message format (`feat:`, `chore:`, `docs:`, `ci:`, `build:`).
- **DCO sign-off** on every commit: `git commit -s`.
- The prototype's publishing-gate blocks `git push`/`gh pr merge`, **not** local `commit`/`checkout` — so the per-task commits below are safe. Pushing and PR-merging happen later through the gated verbs (Phase 6 / operator).
- All packages are `private: true` for now; public npm names are parked with the release policy.

---

## File-structure map (what gets created and why)

| Path | Responsibility |
|---|---|
| `package.json` (root) | Private workspace root: shared devDeps + scripts (`build`/`test`/`lint`/`typecheck`/`format`). |
| `pnpm-workspace.yaml` | Declares `packages/*` + `apps/*` as workspaces. |
| `tsconfig.base.json` | Shared strict/ESM/NodeNext compiler options. |
| `tsconfig.json` (root) | Solution file: project references to every package. |
| `eslint.config.js`, `.prettierrc`, `.editorconfig`, `.nvmrc` | Lint/format/editor/runtime baseline. |
| `vitest.workspace.ts` | Test discovery across `packages/*`. |
| `.gitignore` | Standard Node ignores + the temporary PROTOTYPE FOOTPRINT block. |
| `packages/core/` | Domain core. Seeded with `assertNever` (exhaustiveness primitive co's discriminated unions need) + package-identity export. Proves install/build/test/lint/typecheck. |
| `packages/cli/`, `packages/mcp/` | Thin adapters. Each imports `@co/core` — proving cross-package wiring. |
| `apps/desktop/` | Stub README only (shell parked). |
| `docs/` | Migrated design corpus + governance docs + migration checklist + the living `v1-acceptance-criteria.md` (global acceptance contract, read by every Coordinator). |
| `LICENSE`, `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `GOVERNANCE.md` | Community-health set. |
| `.github/` | Issue/PR templates, CODEOWNERS, labels, dependabot, workflows — the live mirror. |
| `AGENTS.md`, `CLAUDE.md` | Native memory; gain the prototype-footprint section + real command sections. |

---

# Phase 0 — Workspace skeleton & toolchain bootstrap

Goal: a green `pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build`. Everything else verifies against this.

### Task 0.1: Root workspace files

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `.nvmrc`, `.editorconfig`, `.prettierrc`, `tsconfig.base.json`, `tsconfig.json`, `eslint.config.js`, `vitest.workspace.ts`

- [ ] **Step 1: Create `package.json` (root)**

```json
{
  "name": "code-orchestration",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@9.15.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -b --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  },
  "devDependencies": {
    "@eslint/js": "^9.17.0",
    "@types/node": "^22.10.0",
    "eslint": "^9.17.0",
    "prettier": "^3.4.2",
    "typescript": "^5.7.2",
    "typescript-eslint": "^8.18.0",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - "packages/*"
  - "apps/*"
```

- [ ] **Step 3: Create `.nvmrc`**

```
22
```

- [ ] **Step 4: Create `.editorconfig`**

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
```

- [ ] **Step 5: Create `.prettierrc`**

```json
{
  "singleQuote": true,
  "semi": true,
  "trailingComma": "all",
  "printWidth": 100
}
```

- [ ] **Step 6: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "composite": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

- [ ] **Step 7: Create `tsconfig.json` (root solution file)**

```json
{
  "files": [],
  "references": [
    { "path": "packages/core" },
    { "path": "packages/cli" },
    { "path": "packages/mcp" }
  ]
}
```

- [ ] **Step 8: Create `eslint.config.js`**

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', 'node_modules/**', '.co/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
```

- [ ] **Step 9: Create `vitest.workspace.ts`**

```ts
export default ['packages/*'];
```

- [ ] **Step 10: Commit**

```bash
git add package.json pnpm-workspace.yaml .nvmrc .editorconfig .prettierrc tsconfig.base.json tsconfig.json eslint.config.js vitest.workspace.ts
git commit -s -m "chore: scaffold pnpm workspace root and toolchain"
```

### Task 0.2: `packages/core` with a TDD smoke primitive

**Files:**
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`, `packages/core/src/assert-never.ts`, `packages/core/src/assert-never.test.ts`

- [ ] **Step 1: Create `packages/core/package.json`**

```json
{
  "name": "@co/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc -b" }
}
```

- [ ] **Step 2: Create `packages/core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Write the failing test** — `packages/core/src/assert-never.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { assertNever } from './assert-never.js';

describe('assertNever', () => {
  it('throws with the unexpected value in the message', () => {
    // @ts-expect-error — deliberately passing a non-never value at runtime
    expect(() => assertNever('surprise')).toThrowError(/unexpected value: "surprise"/);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm vitest run packages/core/src/assert-never.test.ts`
Expected: FAIL — cannot resolve `./assert-never.js` (module not found).

- [ ] **Step 5: Write minimal implementation** — `packages/core/src/assert-never.ts`

```ts
/**
 * Exhaustiveness guard for discriminated unions (mail types, agent states, …).
 * Calling it is a type error unless every variant has been handled; at runtime
 * it throws, so an unhandled variant fails loudly (Principle 9 — no-silent-failures).
 */
export function assertNever(value: never): never {
  throw new Error(`assertNever: unexpected value: ${JSON.stringify(value)}`);
}
```

- [ ] **Step 6: Create the barrel** — `packages/core/src/index.ts`

```ts
export { assertNever } from './assert-never.js';

/** Workspace-internal package identity; proves cross-package imports resolve. */
export const CORE_PACKAGE = '@co/core' as const;
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm vitest run packages/core/src/assert-never.test.ts`
Expected: PASS (1 test).

- [ ] **Step 8: Commit**

```bash
git add packages/core
git commit -s -m "feat(core): add assertNever exhaustiveness primitive + package skeleton"
```

### Task 0.3: `packages/cli` thin adapter (proves cross-package import)

**Files:**
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/src/index.ts`, `packages/cli/src/run.ts`, `packages/cli/src/run.test.ts`

- [ ] **Step 1: Create `packages/cli/package.json`**

```json
{
  "name": "@co/cli",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "co": "./dist/index.js" },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "dependencies": { "@co/core": "workspace:*" },
  "scripts": { "build": "tsc -b" }
}
```

- [ ] **Step 2: Create `packages/cli/tsconfig.json`** (references core)

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*"],
  "references": [{ "path": "../core" }]
}
```

- [ ] **Step 3: Write the failing test** — `packages/cli/src/run.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { run } from './run.js';

describe('cli run()', () => {
  it('reports which core package it is wired to', () => {
    expect(run()).toBe('co cli → @co/core');
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm vitest run packages/cli/src/run.test.ts`
Expected: FAIL — cannot resolve `./run.js`.

- [ ] **Step 5: Write minimal implementation** — `packages/cli/src/run.ts`

```ts
import { CORE_PACKAGE } from '@co/core';

export function run(): string {
  return `co cli → ${CORE_PACKAGE}`;
}
```

- [ ] **Step 6: Create the entrypoint** — `packages/cli/src/index.ts`

```ts
#!/usr/bin/env node
import { run } from './run.js';

console.log(run());
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm vitest run packages/cli/src/run.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/cli
git commit -s -m "feat(cli): thin CLI adapter wired to @co/core"
```

### Task 0.4: `packages/mcp` thin adapter

**Files:**
- Create: `packages/mcp/package.json`, `packages/mcp/tsconfig.json`, `packages/mcp/src/index.ts`, `packages/mcp/src/server.ts`, `packages/mcp/src/server.test.ts`

- [ ] **Step 1: Create `packages/mcp/package.json`**

```json
{
  "name": "@co/mcp",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "dependencies": { "@co/core": "workspace:*" },
  "scripts": { "build": "tsc -b" }
}
```

- [ ] **Step 2: Create `packages/mcp/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src/**/*"],
  "references": [{ "path": "../core" }]
}
```

- [ ] **Step 3: Write the failing test** — `packages/mcp/src/server.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { describeServer } from './server.js';

describe('mcp describeServer()', () => {
  it('names the agent surface and the core it serves', () => {
    expect(describeServer()).toEqual({ surface: 'mcp', core: '@co/core' });
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm vitest run packages/mcp/src/server.test.ts`
Expected: FAIL — cannot resolve `./server.js`.

- [ ] **Step 5: Write minimal implementation** — `packages/mcp/src/server.ts`

```ts
import { CORE_PACKAGE } from '@co/core';

export function describeServer(): { surface: 'mcp'; core: string } {
  return { surface: 'mcp', core: CORE_PACKAGE };
}
```

- [ ] **Step 6: Create the barrel** — `packages/mcp/src/index.ts`

```ts
export { describeServer } from './server.js';
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm vitest run packages/mcp/src/server.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/mcp
git commit -s -m "feat(mcp): thin MCP server adapter wired to @co/core"
```

### Task 0.5: `apps/desktop` stub

**Files:**
- Create: `apps/desktop/README.md`

- [ ] **Step 1: Create `apps/desktop/README.md`**

```markdown
# `co` desktop app — placeholder

The operator-facing desktop shell is **parked** pending the runtime-substrate research
and the Electron-vs-Tauri decision (Principle 16 — decisions-deferred).

Nothing is built here yet. See:

- `docs/research/runtime-substrate.md` — the keystone parked decision.
- `docs/research/language-and-stack.md` — why TypeScript, and the open shell sub-question.

This directory exists so the monorepo's `apps/*` boundary is established up front; it
carries no build, no dependencies, and no shell commitment.
```

- [ ] **Step 2: Commit**

```bash
git add apps/desktop
git commit -s -m "chore: add parked apps/desktop stub"
```

### Task 0.6: Install, verify the full toolchain green

- [ ] **Step 1: Install dependencies**

Run: `pnpm install`
Expected: resolves and links `@co/core` into `@co/cli` and `@co/mcp` via `workspace:*`. If a pinned devDep version is unavailable, let pnpm pick the nearest satisfying version (caret ranges) and proceed.

- [ ] **Step 2: Lint**

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: clean (project references build in order core → cli/mcp).

- [ ] **Step 4: Test**

Run: `pnpm test`
Expected: 3 test files pass (core, cli, mcp).

- [ ] **Step 5: Build**

Run: `pnpm build`
Expected: `dist/` emitted in core, cli, mcp.

- [ ] **Step 6: Commit the lockfile**

```bash
git add pnpm-lock.yaml
git commit -s -m "chore: add pnpm lockfile"
```

---

# Phase 1 — Prototype coexistence

Goal: keep the dirty tenant working while making its removal surgical, and fill in the native-memory files now that the toolchain exists.

### Task 1.1: Root `.gitignore` with the prototype-footprint block

**Files:**
- Create: `.gitignore`

- [ ] **Step 1: Create `.gitignore`**

```gitignore
# Dependencies / build output
node_modules/
dist/
*.tsbuildinfo

# Test / coverage
coverage/

# OS / editor
.DS_Store
*.log

# ============================================================
# PROTOTYPE FOOTPRINT (temporary) — Claude-Orchestrator drives this build.
# Remove this block at migration. See docs/migration.md.
# NOTE: .co/ is intentionally NOT ignored here. Its own .co/.gitignore tracks
# specs/plans/issues (which worktree agents read from COMMITTED history — a git
# worktree only sees committed files) and ignores config.yaml/state.db/worktrees/
# logs/transcripts. A root-level `.co/` ignore would break those re-include
# negations and make worktree agents lose their specs.
# ============================================================
.claude/
.codex/
# ============================================================
```

- [ ] **Step 2: Verify the footprint is handled correctly**

Run: `git status --porcelain | grep -E '^\?\?' | sort`
Expected: `.claude/` and `.codex/` do **not** appear (ignored); `.co/` and `AGENTS.md`/`CLAUDE.md` may appear as tracked/untracked but `.co/config.yaml`, `.co/state.db`, `.co/worktrees/` do **not** (ignored by `.co/.gitignore`).

Run: `git check-ignore -v .co/specs/.keep 2>/dev/null; echo "exit=$?"`
Expected: `exit=1` (specs are NOT ignored — i.e. they will be tracked).

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -s -m "chore: gitignore baseline + temporary prototype-footprint block"
```

### Task 1.2: Fill in `AGENTS.md` and `CLAUDE.md`

**Files:**
- Modify: `AGENTS.md`, `CLAUDE.md` (currently identical `TODO` stubs)

- [ ] **Step 1: Replace the body of BOTH files with the same content** (keep them in sync; CLAUDE.md wins on conflict)

````markdown
# Project notes for CO agents

This file is read by every CO agent at the start of its turn. CLAUDE.md and AGENTS.md
are kept in sync; if both exist, CLAUDE.md wins.

## Test command

```
pnpm test
```

(Single package: `pnpm vitest run packages/<name>`.)

## Build / lint / type-check commands

```
pnpm lint
pnpm typecheck
pnpm build
```

Run all four (`test` included) before considering a diff done.

## Conventions & architecture

- TypeScript monorepo, **pnpm workspaces**. `packages/core` is the single source of truth;
  `packages/cli` and `packages/mcp` are thin adapters that `import` it — never duplicate core
  logic in an adapter. `apps/desktop` is a parked stub.
- ESM only (`"type": "module"`, NodeNext). Import local files with the `.js` extension.
- Strict TypeScript. Use `assertNever` from `@co/core` for exhaustive discriminated-union
  switches rather than a silent default branch.
- **Conventional Commits**, and **sign off every commit** (`git commit -s`, DCO).
- Design rationale lives in `docs/` (start at `docs/README.md`); the 16 invariants are in
  `docs/principles.md` and are cited inline as `Principle N — handle`.

## Global v1 acceptance criteria

The project-wide definition of "v1 done" is [`docs/v1-acceptance-criteria.md`](docs/v1-acceptance-criteria.md)
— **read it before locking any spec.** v1 = `co` self-hosts and the prototype is retired. Every
spec's acceptance criteria must ladder up to a criterion there (cite its ID, e.g. `SH-2`). It is a
living document; advance and mark criteria as work lands.

## Things agents should not do

- Do not bypass the review gate: no raw `git push` / `gh pr merge`. Use the gated path.
- Do not put orchestration state in the repo (Principle 12 — pristine-repo). The only
  sanctioned repo files are these memory files.
- Do not duplicate core logic into `cli`/`mcp`.

## Prototype footprint (temporary)

This repo is built by the Claude-Orchestrator **prototype**, which writes `.co/`, `.claude/`,
`.codex/` into the tree — a temporary tenant that violates Principle 12, **not part of the
product**. `.co/specs|plans|issues` are tracked only because worktree agents read *committed*
specs; everything else is ignored. The whole footprint is removed in the migration commit once
`co` can self-host. Don't build on, document, or treat `.co/` as product code. See
`docs/migration.md`.
````

- [ ] **Step 2: Verify both files are identical**

Run: `diff AGENTS.md CLAUDE.md && echo IDENTICAL`
Expected: `IDENTICAL`.

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md CLAUDE.md
git commit -s -m "docs: fill in native-memory files + prototype-footprint notice"
```

### Task 1.3: Migration teardown checklist

**Files:**
- Create: `docs/migration.md`

- [ ] **Step 1: Create `docs/migration.md`**

```markdown
# Migration: removing the prototype footprint

The Claude-Orchestrator **prototype** built this repository and left a temporary footprint:
`.co/`, `.claude/`, `.codex/` (see the design spec §3 and the native-memory files). Tracked
parts: `.co/.gitignore`, `.co/specs/`, `.co/plans/`, `.co/issues/`. Everything else is ignored.

When `co` can self-host (reads specs/state from its own program-data, no `.co/` dependency),
perform the teardown as **one gated PR** `nightly` → `main`, tracked by the `migration` issue:

1. Confirm `co` no longer depends on `.co/` for any spec/plan/state.
2. Remove tracked + on-disk footprint:
   ```bash
   git rm -r --quiet .co
   rm -rf .claude .codex
   ```
3. Delete the `PROTOTYPE FOOTPRINT` block from `.gitignore`.
4. Remove the "Prototype footprint (temporary)" section from `AGENTS.md` and `CLAUDE.md`.
5. (Optional) squash/rewrite history if a truly pristine record is wanted — deferred, not required.
6. Archive `docs/v1-acceptance-criteria.md` — retiring the prototype *is* the v1 bar (`SH-3`), so
   reaching this checklist means §A of that doc is met. Keep it as the historical v1 record (or seed
   a v2 acceptance doc).
7. Open the PR, let it pass the gate, promote to `main`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/migration.md
git commit -s -m "docs: add prototype-footprint migration checklist"
```

### Task 1.4: The living v1 acceptance-criteria doc

**Files:**
- Create: `docs/v1-acceptance-criteria.md`

> This is the global, project-scope acceptance contract every Coordinator reads (wired via the
> native-memory reference added in Task 1.2). It is anchored to **v1 = `co` self-hosts; prototype
> retired**, organized around the 16 principles with status markers, and meant to be iterated
> throughout development. The full seed content is authored in
> `docs/superpowers/specs/2026-06-01-project-scaffolding-design.md`'s sibling artifact and already
> exists in the working tree; this task commits it as part of the scaffold.

- [ ] **Step 1:** Ensure `docs/v1-acceptance-criteria.md` exists with the seed content (the
  self-hosting exit criteria `SH-1..5`; the per-principle criterion groups A–H; non-goals; the
  parked v1-critical-path dependencies; the lifecycle/archival note). If absent, recreate it from
  the design artifact.

- [ ] **Step 2: Verify the awareness wiring** — the native-memory files point to it

Run: `grep -l 'v1-acceptance-criteria' AGENTS.md CLAUDE.md`
Expected: both files listed (the reference from Task 1.2 is present).

- [ ] **Step 3: Verify every status marker is from the legend**

Run: `grep -oE '[☐◐☑⏸⊘]' docs/v1-acceptance-criteria.md | sort -u`
Expected: only characters drawn from `☐ ◐ ☑ ⏸ ⊘`.

- [ ] **Step 4: Commit**

```bash
git add docs/v1-acceptance-criteria.md
git commit -s -m "docs: add living v1 acceptance-criteria contract (co self-hosts)"
```

---

# Phase 2 — Docs migration

Goal: move the Initial-Commit design corpus into `docs/`, dropping the prototype halves and preserving principle handles. This is a mechanical transform with precise rules — not authoring.

**Transform rules (apply to every migrated file):**
1. Delete the `## Claude Orchestrator` section entirely (prototype history).
2. Promote the `## Code Orchestration` section's body to the document root (remove the now-redundant `## Code Orchestration` heading; keep its subsections).
3. Rewrite inline cross-references to sibling docs using the mapping table below (e.g. `WORKTREES` → `architecture/worktrees.md`).
4. Leave principle citations (`Principle N — handle`) untouched; they resolve to `docs/principles.md`.
5. Rename to lower-kebab-case at the destination path.

**Mapping table:**

| Source | Destination |
|---|---|
| `PRINCIPLES.md` | `docs/principles.md` |
| `.goals/DESIGN-PRINCIPLES.md` (Code Orchestration section = authoritative prose) | merge into `docs/principles.md` under an "## Authoritative prose" section |
| `.goals/VISION.md` | `docs/vision.md` |
| `.goals/CORE-CONCEPTS.md` | `docs/concepts.md` |
| `.goals/MAIL-BUS.md` | `docs/architecture/mail-bus.md` |
| `.goals/DISPATCH.md` | `docs/architecture/dispatch.md` |
| `.goals/PROVIDERS.md` | `docs/architecture/providers.md` |
| `.goals/WORKTREES.md` | `docs/architecture/worktrees.md` |
| `.goals/REVIEW-GATES.md` | `docs/architecture/review-gates.md` |
| `.goals/PHASES-and-PLANS.md` | `docs/architecture/phases-and-plans.md` |
| `.goals/SPECS-and-ISSUES.md` | `docs/architecture/specs-and-issues.md` |
| `.goals/STATE-and-RECOVERY.md` | `docs/architecture/state-and-recovery.md` |
| `.goals/EVENT-ROUTER.md` | `docs/architecture/event-router.md` |
| `.goals/PERMISSIONS.md` | `docs/architecture/permissions.md` |
| `.goals/PROMPTS-and-MEMORY.md` | `docs/architecture/prompts-and-memory.md` |
| `.goals/AGENT-ROLES.md` | `docs/architecture/agent-roles.md` |
| `.goals/TUI.md` | `docs/architecture/tui.md` |
| `.goals/BUDDY.md` | `docs/architecture/buddy.md` |
| `.goals/COST-and-USAGE.md` | `docs/architecture/cost-and-usage.md` |
| `.goals/HEALTH-and-DIAGNOSTICS.md` | `docs/architecture/health-and-diagnostics.md` |
| `.goals/INIT-and-CONFIG.md` | `docs/architecture/init-and-config.md` |
| `.goals/MCP-TOOLS.md` | `docs/architecture/mcp-tools.md` |
| `.goals/CLI-REFERENCE.md` | `docs/architecture/cli-reference.md` |
| `.goals/RESEARCH.md` | `docs/architecture/research.md` |
| `.research/runtime-substrate.md` | `docs/research/runtime-substrate.md` |
| `.research/language-and-stack.md` | `docs/research/language-and-stack.md` |
| `PORTING-CO.md` | rewritten as `docs/README.md` (see Task 2.3) |

### Task 2.1: Migrate principles + top-level docs

**Files:**
- Create: `docs/principles.md`, `docs/vision.md`, `docs/concepts.md`
- Read: `PRINCIPLES.md`, `.goals/DESIGN-PRINCIPLES.md`, `.goals/VISION.md`, `.goals/CORE-CONCEPTS.md`

- [ ] **Step 1:** Create `docs/principles.md` from `PRINCIPLES.md`: keep the 16-row index table and all handles verbatim. Update the two footer links (`.goals/DESIGN-PRINCIPLES.md` → this file's authoritative-prose section; `PORTING-CO.md` → `docs/README.md`). Append an `## Authoritative prose` section containing the `## Code Orchestration` 16-principle prose from `.goals/DESIGN-PRINCIPLES.md` (drop that file's prototype 10-principle list).

- [ ] **Step 2:** Create `docs/vision.md` from `.goals/VISION.md` applying the transform rules (drop the prototype section; promote the Code Orchestration body).

- [ ] **Step 3:** Create `docs/concepts.md` from `.goals/CORE-CONCEPTS.md` applying the transform rules.

- [ ] **Step 4: Verify no stale links remain**

Run: `grep -rnE '\.goals/|\.research/|PORTING-CO|DESIGN-PRINCIPLES\.md' docs/principles.md docs/vision.md docs/concepts.md`
Expected: no output (all internal links rewritten).

- [ ] **Step 5: Commit**

```bash
git add docs/principles.md docs/vision.md docs/concepts.md
git commit -s -m "docs: migrate principles, vision, concepts into docs/"
```

### Task 2.2: Migrate the architecture corpus + research

**Files:**
- Create: `docs/architecture/*.md` (21 files per the mapping table), `docs/research/runtime-substrate.md`, `docs/research/language-and-stack.md`

- [ ] **Step 1:** For each `.goals/*.md` source in the mapping table, create the `docs/architecture/<kebab>.md` destination applying the five transform rules. Process them one at a time; keep diffs reviewable.

- [ ] **Step 2:** Copy `.research/runtime-substrate.md` and `.research/language-and-stack.md` to `docs/research/`, rewriting their `../PRINCIPLES.md` and `../.goals/...` links to `../principles.md` and `../architecture/...`, and `../PORTING-CO.md` to `../README.md`.

- [ ] **Step 3: Verify no stale links remain anywhere in docs/**

Run: `grep -rnE '\.goals/|\.research/|PORTING-CO|DESIGN-PRINCIPLES\.md|CORE-CONCEPTS\.md' docs/ || echo "CLEAN"`
Expected: `CLEAN`.

- [ ] **Step 4: Verify every principle handle still resolves**

Run: `grep -rhoE 'Principle [0-9]+ — [a-z-]+' docs/ | sort -u | wc -l`
Expected: 16 distinct handles (matches `docs/principles.md`).

- [ ] **Step 5: Commit**

```bash
git add docs/architecture docs/research
git commit -s -m "docs: migrate architecture corpus and research notes into docs/"
```

### Task 2.3: `docs/README.md` reading-order index

**Files:**
- Create: `docs/README.md`

- [ ] **Step 1: Create `docs/README.md`** (replaces `PORTING-CO.md`, reframed for a fresh contributor)

```markdown
# Code Orchestration — design docs

Start here. These docs are the "why" behind `co`; the code is the "how".

## Reading order

1. [Vision](vision.md) — what `co` is and the two interaction surfaces.
2. [Core concepts](concepts.md) — the mental model (Conductor, Agent, Role, Mail, …).
3. [Principles](principles.md) — the 16 invariants. Cited everywhere as `Principle N — handle`;
   grep a handle to jump here.
4. Architecture — one topic per file under [`architecture/`](architecture/):
   mail bus, dispatch, providers, worktrees, review gates, phases & plans, specs & issues,
   state & recovery, event router, permissions, prompts & memory, agent roles, TUI, buddy,
   cost & usage, health & diagnostics, init & config, MCP tools, CLI reference, research.
5. [Research](research/) — open, evidence-pending decisions (runtime substrate, stack).
6. [Governance](governance/) — how this repo's GitHub structure mirrors `co`'s own model.

## Status

`co` is in active development (pre-alpha). The substrate-independent design is settled; the
runtime substrate and desktop shell are parked for evidence (Principle 16). See
[migration.md](migration.md) for the temporary prototype-footprint teardown.
```

- [ ] **Step 2: Commit**

```bash
git add docs/README.md
git commit -s -m "docs: add docs/ reading-order index (replaces PORTING-CO.md)"
```

### Task 2.4: Remove the migrated Initial-Commit markdown

**Files:**
- Delete: `PORTING-CO.md`, `PRINCIPLES.md`, `.goals/` (all), `.research/` (all)

> The spec mandates the v1 strip of Initial-Commit markdown now that it lives in `docs/`.

- [ ] **Step 1: Remove the now-migrated sources**

```bash
git rm PORTING-CO.md PRINCIPLES.md
git rm -r .goals .research
```

- [ ] **Step 2: Verify nothing references the removed paths** (outside docs already checked)

Run: `grep -rnE '\.goals/|\.research/|PORTING-CO|^PRINCIPLES\.md' --include='*.md' . | grep -v '^./docs/migration.md' | grep -v '^./\.co/' || echo "CLEAN"`
Expected: `CLEAN` (the only allowed mentions are historical notes; investigate anything else).

- [ ] **Step 3: Re-verify the toolchain is unaffected**

Run: `pnpm typecheck && pnpm test`
Expected: still green (docs changes don't touch code).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -s -m "docs: remove Initial-Commit markdown now migrated into docs/"
```

---

# Phase 3 — Governance & community files

Goal: the "Full from day one" community-health set.

### Task 3.1: LICENSE (MIT)

**Files:**
- Create: `LICENSE`

- [ ] **Step 1: Create `LICENSE`** — standard MIT text:

```
MIT License

Copyright (c) 2026 LunchBox951

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

> Confirm the copyright holder name with the operator before finalizing if unsure.

- [ ] **Step 2: Commit**

```bash
git add LICENSE
git commit -s -m "chore: add MIT license"
```

### Task 3.2: README.md (public front door)

**Files:**
- Create: `README.md`

- [ ] **Step 1: Create `README.md`**

```markdown
# Code Orchestration (`co`)

> Autonomous multi-agent software engineering that stays auditable, gated, recoverable — and steerable.

**Status: in active development (pre-alpha). Not yet installable.**

`co` runs a team of AI coding agents (Claude by default, Codex optionally) as **live, interactive
terminal sessions** you can watch and steer, while the agents coordinate among themselves through a
**typed mail bus**. Every change passes a **strict review gate** before it can merge, push, or
publish, and all state is durably recorded so the system can be inspected, replayed, and recovered.

## Two interaction surfaces

- **Agent ↔ you — the live terminal.** Each agent is a real interactive `claude`/`codex` session in
  its own pane; drop in and redirect it mid-work.
- **Agent ↔ agent — the typed mail bus.** Structured, persisted envelopes; the disciplined spine of
  multi-agent work. You're a first-class participant — escalations filter up to your inbox.

## Repository

This is a TypeScript monorepo (pnpm workspaces):

- `packages/core` — the domain core (single source of truth).
- `packages/cli` — the `co` command-line adapter.
- `packages/mcp` — the agent-facing MCP server (the sole agent surface).
- `apps/desktop` — the operator desktop app (shell choice parked).

## Docs

Design rationale lives in [`docs/`](docs/README.md). The 16 invariants are in
[`docs/principles.md`](docs/principles.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). This project is built using its own model — work flows as
specs → phases → tasks through a review gate, mirrored in GitHub Issues, the Project board, and
branch protection. By [Code of Conduct](CODE_OF_CONDUCT.md). Licensed [MIT](LICENSE).
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -s -m "docs: add public README"
```

### Task 3.3: CONTRIBUTING.md (the established rules)

**Files:**
- Create: `CONTRIBUTING.md`

- [ ] **Step 1: Create `CONTRIBUTING.md`**

```markdown
# Contributing to Code Orchestration

Thanks for your interest. `co` is built using its own discipline, so contribution mirrors how `co`
orchestrates work. Read [`docs/README.md`](docs/README.md) and [`docs/principles.md`](docs/principles.md) first.

## Development setup

- Node ≥ 22 (see `.nvmrc`), pnpm 9 (`corepack enable`).
- `pnpm install`, then `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.

## How work is structured (the model)

Issues map to `co`'s work units:

- **spec** — top-level intent, locked before work starts.
- **phase** — an independently-mergeable slice of a spec.
- **task** — an implementer-sized unit inside a phase.
- **bug** — a defect report. **research** — an open, evidence-pending decision.

The [Project board](docs/governance/project-board.md) tracks items across the lifecycle
(Backlog → Spec-locked → In phase → In review → Blocked → Done). Labels mark **role**, **type**,
**status**, and **area** ([taxonomy](docs/governance/labels.md)).

## Branch & PR flow

- Branch from `nightly`; open PRs **against `nightly`** (the integration line). `main` is the
  stable release branch, updated only by gated promotion from `nightly`.
- Keep PRs focused on one task/phase. Link the issue the PR closes; fill the acceptance-criteria
  checklist in the PR template.
- A PR merges only after the review gate returns **PASS** and required checks are green. The blocker
  bar tightens toward production: nits ride as suggestions into `nightly`, become blockers at `main`.

## Commits

- **[Conventional Commits](https://www.conventionalcommits.org/)** (`feat:`, `fix:`, `docs:`, …).
- **Sign off every commit (DCO):** `git commit -s`. By signing off you certify the
  [Developer Certificate of Origin](https://developercertificate.org/). PRs without sign-off fail
  the DCO check.

## Code conventions

- ESM, strict TypeScript, NodeNext imports (`.js` extension on local imports).
- `packages/core` is the single source of truth; `cli`/`mcp` are thin adapters that import it — do
  not duplicate core logic.
- Use `assertNever` from `@co/core` for exhaustive union handling (no silent default branches).

## Note: the prototype footprint

The repo currently hosts a temporary `.co/`/`.claude/`/`.codex/` footprint from the prototype that
builds it. It is **not** part of the product and will be removed at migration
([docs/migration.md](docs/migration.md)). Do not build on it.
```

- [ ] **Step 2: Commit**

```bash
git add CONTRIBUTING.md
git commit -s -m "docs: add CONTRIBUTING with the spec/phase/task + DCO rules"
```

### Task 3.4: CODE_OF_CONDUCT.md

**Files:**
- Create: `CODE_OF_CONDUCT.md`

- [ ] **Step 1:** Create `CODE_OF_CONDUCT.md` containing the **Contributor Covenant v2.1** verbatim (canonical source: https://www.contributor-covenant.org/version/2/1/code_of_conduct/code_of_conduct.md). Substitute the enforcement contact line with: `95397613+LunchBox951@users.noreply.github.com`. Do not alter the covenant text otherwise.

- [ ] **Step 2: Verify the contact placeholder was replaced**

Run: `grep -c '\[INSERT CONTACT METHOD\]' CODE_OF_CONDUCT.md`
Expected: `0`.

- [ ] **Step 3: Commit**

```bash
git add CODE_OF_CONDUCT.md
git commit -s -m "docs: add Contributor Covenant 2.1 code of conduct"
```

### Task 3.5: SECURITY.md

**Files:**
- Create: `SECURITY.md`

- [ ] **Step 1: Create `SECURITY.md`**

```markdown
# Security Policy

`co` runs AI agents that **execute code** and hold **subscription/credential access**, so security
reports are taken seriously.

## Reporting a vulnerability

**Do not open a public issue for security problems.** Instead, use GitHub's private
[Report a vulnerability](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
flow on this repository, or email **95397613+LunchBox951@users.noreply.github.com**.

Please include reproduction steps, affected version/commit, and impact. We aim to acknowledge within
**72 hours** and to provide a remediation timeline after triage.

## Supported versions

While pre-alpha, only the latest `main` is supported. A formal support matrix arrives with the first
tagged release.
```

- [ ] **Step 2: Commit**

```bash
git add SECURITY.md
git commit -s -m "docs: add security policy"
```

### Task 3.6: GOVERNANCE.md

**Files:**
- Create: `GOVERNANCE.md`

- [ ] **Step 1: Create `GOVERNANCE.md`**

```markdown
# Governance

## Model

`co` is currently **BDFL-led** (LunchBox951) while the project is young. Decisions are made in
the open via Issues and Discussions; the maintainer has final say and is responsible for keeping the
project coherent with its [principles](docs/principles.md).

## How decisions are weighed

Every proposal is judged against the **16 design principles**. A change that violates an invariant
(e.g. a path to `main` that skips the review gate, or orchestration state leaking into a target repo)
needs an explicit, recorded rationale and a principle amendment — not a silent exception.

## Roles

This repo's human roles deliberately mirror `co`'s agent roles — **Coordinator, Lead, Implementer,
Reviewer, Researcher** — so that working on `co` is itself an instance of `co`'s model. As the
project grows, trusted contributors may be granted Lead/Reviewer responsibilities over areas
(reflected in `CODEOWNERS`).

## Becoming a maintainer

Sustained, high-quality contribution (code and review) is the path. The maintainer will invite
contributors who have demonstrated good judgment against the principles. The roster and the move
beyond BDFL (to a maintainer council) will be revisited as activity warrants.
```

- [ ] **Step 2: Commit**

```bash
git add GOVERNANCE.md
git commit -s -m "docs: add governance model tied to co's role model"
```

---

# Phase 4 — The GitHub mirror (`.github/` + governance docs)

Goal: the in-repo half of the tight mirror (templates, labels, ownership) plus the docs that
describe the GitHub-side config applied in Phase 6.

### Task 4.1: Issue templates

**Files:**
- Create: `.github/ISSUE_TEMPLATE/{spec,phase,task,bug,research}.yml`, `.github/ISSUE_TEMPLATE/config.yml`

- [ ] **Step 1: Create `.github/ISSUE_TEMPLATE/spec.yml`**

```yaml
name: Spec
description: Top-level intent to be shaped into a locked spec.
title: "[spec] "
labels: ["type:spec", "status:spec-locked", "role:coordinator"]
body:
  - type: textarea
    id: intent
    attributes:
      label: Intent
      description: What outcome is wanted, and why. Not how.
    validations: { required: true }
  - type: textarea
    id: acceptance
    attributes:
      label: Acceptance criteria
      description: The concrete, checkable standard for "done" (Principle 10).
    validations: { required: true }
  - type: textarea
    id: constraints
    attributes:
      label: Constraints / non-goals
    validations: { required: false }
```

- [ ] **Step 2: Create `.github/ISSUE_TEMPLATE/phase.yml`**

```yaml
name: Phase
description: An independently-mergeable slice of a spec, owned by one Lead.
title: "[phase] "
labels: ["type:phase", "role:lead"]
body:
  - type: input
    id: spec
    attributes: { label: Parent spec, description: "Link the spec issue this phase belongs to." }
    validations: { required: true }
  - type: textarea
    id: scope
    attributes: { label: Scope, description: "What this phase delivers; where it merges." }
    validations: { required: true }
  - type: textarea
    id: acceptance
    attributes: { label: Acceptance criteria }
    validations: { required: true }
```

- [ ] **Step 3: Create `.github/ISSUE_TEMPLATE/task.yml`**

```yaml
name: Task
description: An implementer-sized unit of work inside a phase.
title: "[task] "
labels: ["type:task", "role:implementer"]
body:
  - type: input
    id: phase
    attributes: { label: Parent phase }
    validations: { required: true }
  - type: textarea
    id: change
    attributes: { label: The change, description: "Files/behavior to add or modify." }
    validations: { required: true }
  - type: textarea
    id: verify
    attributes: { label: How to verify, description: "Test/command proving it works." }
    validations: { required: true }
```

- [ ] **Step 4: Create `.github/ISSUE_TEMPLATE/bug.yml`**

```yaml
name: Bug
description: Something is broken.
title: "[bug] "
labels: ["type:bug"]
body:
  - type: textarea
    id: what
    attributes: { label: What happened }
    validations: { required: true }
  - type: textarea
    id: repro
    attributes: { label: Reproduction steps }
    validations: { required: true }
  - type: textarea
    id: expected
    attributes: { label: Expected vs actual }
    validations: { required: true }
  - type: input
    id: version
    attributes: { label: Version / commit }
    validations: { required: false }
```

- [ ] **Step 5: Create `.github/ISSUE_TEMPLATE/research.yml`**

```yaml
name: Research / open decision
description: An evidence-pending decision (Principle 16 — decisions-deferred).
title: "[research] "
labels: ["type:research", "role:researcher"]
body:
  - type: textarea
    id: question
    attributes: { label: The question }
    validations: { required: true }
  - type: textarea
    id: options
    attributes: { label: Options under consideration }
    validations: { required: false }
  - type: textarea
    id: evidence
    attributes: { label: What evidence would decide it }
    validations: { required: true }
```

- [ ] **Step 6: Create `.github/ISSUE_TEMPLATE/config.yml`**

```yaml
blank_issues_enabled: false
contact_links:
  - name: Questions & ideas
    url: https://github.com/OWNER/REPO/discussions
    about: Use Discussions for questions, ideas, and RFCs.
  - name: Report a security vulnerability
    url: https://github.com/OWNER/REPO/security/advisories/new
    about: Please report vulnerabilities privately, not as issues.
```

> Replace `OWNER/REPO` with the real slug once the GitHub repo exists (Phase 6).

- [ ] **Step 7: Verify YAML validity**

Run: `for f in .github/ISSUE_TEMPLATE/*.yml; do node -e "import('node:fs').then(fs=>require('util'))" 2>/dev/null; python3 -c "import sys,yaml; yaml.safe_load(open('$f'))" && echo "$f ok"; done`
Expected: each file prints `ok`. (If `pyyaml` is unavailable, use any YAML linter; the templates must parse.)

- [ ] **Step 8: Commit**

```bash
git add .github/ISSUE_TEMPLATE
git commit -s -m "ci: add issue templates mirroring co work units (spec/phase/task/bug/research)"
```

### Task 4.2: PR template + CODEOWNERS

**Files:**
- Create: `.github/PULL_REQUEST_TEMPLATE.md`, `.github/CODEOWNERS`

- [ ] **Step 1: Create `.github/PULL_REQUEST_TEMPLATE.md`**

```markdown
## What & why

<!-- One paragraph. Link the issue this closes. -->
Closes #

## Acceptance criteria (Principle 10)

<!-- Copy the spec/phase acceptance criteria; check each as met. -->
- [ ] …

## Review

- [ ] Tests added/updated and `pnpm test` passes
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm build` green
- [ ] Commits are Conventional and **signed off** (`git commit -s`, DCO)
- [ ] No core logic duplicated into an adapter; no orchestration state added to the repo

> Reviewer verdict is **PASS** or **ISSUES**. The blocker bar tightens toward `main`.
> If this PR touches the prototype-footprint teardown, see `docs/migration.md`.
```

- [ ] **Step 2: Create `.github/CODEOWNERS`**

```
# Ownership maps to roles; the operator owns everything until areas are delegated.
# Replace @OWNER with the GitHub handle once the repo exists (Phase 6).
*                       @OWNER

/packages/core/         @OWNER
/packages/cli/          @OWNER
/packages/mcp/          @OWNER
/apps/desktop/          @OWNER
/docs/                  @OWNER
/.github/               @OWNER
```

- [ ] **Step 3: Commit**

```bash
git add .github/PULL_REQUEST_TEMPLATE.md .github/CODEOWNERS
git commit -s -m "ci: add PR template (acceptance + DCO) and CODEOWNERS"
```

### Task 4.3: labels.yml taxonomy

**Files:**
- Create: `.github/labels.yml`

- [ ] **Step 1: Create `.github/labels.yml`**

```yaml
# Synced to GitHub by .github/workflows/label-sync.yml (EndBug/label-sync format).
# type
- name: "type:spec"        ; color: "5319e7" ; description: "Top-level intent / locked spec"
- name: "type:phase"       ; color: "8a63d2" ; description: "Independently-mergeable slice"
- name: "type:task"        ; color: "b39ddb" ; description: "Implementer-sized unit"
- name: "type:bug"         ; color: "d73a4a" ; description: "Something is broken"
- name: "type:research"    ; color: "0e8a16" ; description: "Open, evidence-pending decision"
# role
- name: "role:coordinator" ; color: "1d76db" ; description: "Coordinator"
- name: "role:lead"        ; color: "1d76db" ; description: "Lead"
- name: "role:implementer" ; color: "1d76db" ; description: "Implementer"
- name: "role:reviewer"    ; color: "1d76db" ; description: "Reviewer"
- name: "role:researcher"  ; color: "1d76db" ; description: "Researcher"
# status / lifecycle
- name: "status:spec-locked" ; color: "fbca04" ; description: "Spec locked, ready to plan"
- name: "status:in-phase"    ; color: "fbca04" ; description: "Work in progress in a phase"
- name: "status:in-review"   ; color: "fbca04" ; description: "At the review gate"
- name: "status:blocked"     ; color: "e11d21" ; description: "Blocked / escalated"
- name: "status:done"        ; color: "0e8a16" ; description: "Merged / complete"
# area
- name: "area:core"        ; color: "c5def5" ; description: "packages/core"
- name: "area:cli"         ; color: "c5def5" ; description: "packages/cli"
- name: "area:mcp"         ; color: "c5def5" ; description: "packages/mcp"
- name: "area:desktop"     ; color: "c5def5" ; description: "apps/desktop"
- name: "area:docs"        ; color: "c5def5" ; description: "docs/"
- name: "area:meta"        ; color: "c5def5" ; description: "repo tooling / governance"
# meta
- name: "good first issue" ; color: "7057ff" ; description: "Good for newcomers"
- name: "help wanted"      ; color: "008672" ; description: "Extra attention is welcome"
- name: "migration"        ; color: "fef2c0" ; description: "Prototype-footprint teardown"
```

> The exact YAML shape depends on the chosen label-sync action; adjust to its schema in Task 5.2.

- [ ] **Step 2: Commit**

```bash
git add .github/labels.yml
git commit -s -m "ci: add role/type/status/area label taxonomy"
```

### Task 4.4: governance docs (board, labels, roles, parked release policy)

**Files:**
- Create: `docs/governance/{project-board.md,labels.md,roles.md,release-policy.md}`

- [ ] **Step 1: Create `docs/governance/project-board.md`**

```markdown
# Project board

The GitHub Project (v2) for this repo has a single-select **Status** field whose options are `co`'s
lifecycle. Issues (spec/phase/task) move across it exactly as agents move through states:

`Backlog → Spec-locked → In phase → In review → Blocked → Done`

- **Backlog** — filed, not yet locked.
- **Spec-locked** — intent agreed; ready to decompose into phases/tasks.
- **In phase** — actively implemented.
- **In review** — at the review gate (PASS/ISSUES).
- **Blocked** — escalated; needs a decision (filter-up).
- **Done** — merged.

Release channel (`nightly`/`stable`) is a **label**, not a column. The board is configured in
GitHub (Phase 6); this doc is the source of truth for its shape.
```

- [ ] **Step 2: Create `docs/governance/labels.md`** documenting the four label families (type/role/status/area) + meta, pointing at `.github/labels.yml` as the synced source.

- [ ] **Step 3: Create `docs/governance/roles.md`** mapping the human GitHub roles to `co`'s agent roles (Coordinator/Lead/Implementer/Reviewer/Researcher) and to `CODEOWNERS` areas; reference `docs/architecture/agent-roles.md`.

- [ ] **Step 4: Create `docs/governance/release-policy.md` (parked stub)**

```markdown
# Release policy — PARKED

> Status: open (Principle 16 — decisions-deferred). Structure exists; policy does not.

Decided so far: a **two-track** model — `main` (stable, tagged) and `nightly` (integration,
auto-prerelease), with gated promotion `nightly` → `main`.

Still open (decide before wiring `release.yml`):

- Branch name: `nightly` vs `dev`/`develop`.
- Which branch is the GitHub default (affects PR-base ergonomics).
- Promotion cadence and who cuts releases.
- Versioning / prerelease scheme (semver tags; `-nightly.N` vs date-stamped).
- Publish tooling: **Changesets** (monorepo-native, explicit changelogs) vs **semantic-release**
  (fully automated, native `main`/`next` channels, weaker on monorepos).

Until resolved, `release.yml` is a documented placeholder and no packages are published
(all `private: true`).
```

- [ ] **Step 5: Commit**

```bash
git add docs/governance
git commit -s -m "docs: add governance docs (board, labels, roles, parked release policy)"
```

---

# Phase 5 — CI & automation

Goal: the required status checks that branch protection depends on, plus label sync and a parked release placeholder.

### Task 5.1: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main, nightly]
  pull_request:
    branches: [main, nightly]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test
      - run: pnpm build
```

- [ ] **Step 2: Validate the workflow** (if `actionlint` is available)

Run: `actionlint .github/workflows/ci.yml || echo "actionlint not installed — verify YAML parses"`
Expected: no errors (or a note that actionlint isn't installed; ensure the YAML at least parses).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -s -m "ci: add lint/typecheck/test/build workflow for main and nightly"
```

### Task 5.2: Label sync + Dependabot

**Files:**
- Create: `.github/workflows/label-sync.yml`, `.github/dependabot.yml`

- [ ] **Step 1: Create `.github/workflows/label-sync.yml`**

```yaml
name: Label sync

on:
  push:
    branches: [main]
    paths: [".github/labels.yml"]
  workflow_dispatch:

permissions:
  issues: write

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: EndBug/label-sync@v2
        with:
          config-file: .github/labels.yml
          delete-other-labels: false
```

> If `EndBug/label-sync` expects a different `labels.yml` schema than Task 4.3, adjust the file to
> its documented format (it uses `- name/color/description` keys; drop the `;` separators if the
> action requires standard YAML mappings).

- [ ] **Step 2: Create `.github/dependabot.yml`**

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    schedule: { interval: weekly }
    open-pull-requests-limit: 5
    commit-message: { prefix: "chore" }
  - package-ecosystem: github-actions
    directory: "/"
    schedule: { interval: weekly }
    commit-message: { prefix: "ci" }
```

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/label-sync.yml .github/dependabot.yml
git commit -s -m "ci: add label-sync workflow and dependabot config"
```

### Task 5.3: Release placeholder

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Create `.github/workflows/release.yml`** (intentionally manual-only until policy lands)

```yaml
# PLACEHOLDER — wired once docs/governance/release-policy.md is resolved.
# Two-track intent: push to main → stable release; push to nightly → prerelease.
# No publish step yet (packages are private). Runs only on manual dispatch.
name: Release (placeholder)

on:
  workflow_dispatch:

jobs:
  noop:
    runs-on: ubuntu-latest
    steps:
      - run: echo "Release automation is parked. See docs/governance/release-policy.md."
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/release.yml
git commit -s -m "ci: add parked release workflow placeholder"
```

### Task 5.4: Final whole-repo verification

- [ ] **Step 1: Full green run**

Run: `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm build`
Expected: all green.

- [ ] **Step 2: Confirm prototype footprint still intact for the prototype**

Run: `test -f .co/config.yaml && test -d .co/specs && echo "prototype intact"`
Expected: `prototype intact` (the build hasn't disturbed the tenant).

- [ ] **Step 3: Confirm the only tracked `.co` paths are specs/plans/issues/gitignore**

Run: `git ls-files .co | sed 's#/.*##' | sort -u`
Expected: only `.co` entries under `specs`, `plans`, `issues`, plus `.co/.gitignore` — never `config.yaml`, `state.db`, `worktrees`.

---

# Phase 6 — GitHub bootstrap (operator / remote)

Goal: turn the local scaffold into the live GitHub-native mirror. **These steps need a remote and
repo-admin rights, and they hit the prototype's publishing gate — so they are operator-run (or via
the gated `co` verbs), not part of an agent's normal flow.** Listed for completeness.

- [ ] **Step 1:** Create the GitHub repository (public), then add it as `origin`.
- [ ] **Step 2:** Replace placeholder slugs: `OWNER/REPO` in `.github/ISSUE_TEMPLATE/config.yml` and `@OWNER` in `.github/CODEOWNERS` with the real values; commit (`chore: set GitHub slug/owner`).
- [ ] **Step 3:** Push `main`, then create and push `nightly` from `main`.
- [ ] **Step 4:** Enable **Discussions** and create a **Project (v2)** board with the Status options from `docs/governance/project-board.md`.
- [ ] **Step 5:** Run the **Label sync** workflow (`workflow_dispatch`) to apply `labels.yml`.
- [ ] **Step 6:** Apply **branch protection** to `main` and `nightly` per the spec §5 table (PR required, ≥1 approving review, required checks = the CI `build` job, no force-push/deletion, DCO check; `main` also requires conversation resolution and no self-approve). Capture the settings (or a ruleset JSON) under `docs/governance/` for reproducibility.
- [ ] **Step 7:** Add the **DCO** check (the DCO GitHub App or a `dco` action) as a required check on both branches.
- [ ] **Step 8:** File the **`migration`** tracking issue from `docs/migration.md` and add it to the board.

---

## Self-review

**Spec coverage:**
- §2 layout → Phase 0 (packages/apps), Phase 2 (docs/). ✓
- §3 prototype coexistence → Phase 1 (.gitignore block, AGENTS/CLAUDE section, migration.md). ✓
- §4 governance files → Phase 3. ✓
- §5 live mirror (labels/board/branch protection) → Phase 4 (in-repo) + Phase 6 (applied). ✓
- §6 branching/release/CI → Phase 5 (CI, label-sync, parked release) + `release-policy.md` parked stub. ✓
- §7 docs migration mapping → Phase 2 (full mapping table + transform rules). ✓
- §8 migration checklist → Task 1.3. ✓
- §1 locked decisions (MIT, DCO, Conventional Commits, monorepo, tight mirror, Contributor Covenant) → threaded through Phases 0/3/4/5. ✓
- §9 out-of-scope (desktop shell, release policy, co features) → respected (desktop stub, release placeholder). ✓

**Placeholder scan:** The only deferred markers are the *intentional* parked items (`release.yml` placeholder, `release-policy.md`, `OWNER/REPO`/`@OWNER` slugs resolved in Phase 6) — each explicitly flagged, none are vague "TODO: implement". ✓

**Type/name consistency:** `@co/core` exports `assertNever` + `CORE_PACKAGE`, both consumed by name in cli (`run`) and mcp (`describeServer`); package names `@co/core|cli|mcp` consistent across package.json, tsconfig references, and imports; scripts (`build`/`typecheck`/`test`/`lint`) consistent between root `package.json`, `AGENTS.md`/`CLAUDE.md`, CI, and PR template. ✓

---

## Notes for the executor

- This scaffold is likely executed by the **Claude-Orchestrator prototype** in worktrees. Commit
  steps are safe (commits aren't gated); pushing/PR-merge (Phase 6) goes through the gated path.
- If a pinned devDependency version doesn't exist, let pnpm resolve the nearest caret-satisfying
  version and update the lockfile — don't block on exact numbers.
- Keep each task's commit focused; the phase boundaries are natural review checkpoints.
