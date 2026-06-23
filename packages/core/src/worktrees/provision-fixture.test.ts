import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertRepoPristine } from '../config/pristine.js';
import { openConfigStore, type ConfigStore } from '../config/config-store.js';
import { WORKTREE_PROVISION_CONFIG_KEY } from './provision.js';
import { slingWorktree } from './sling.js';
import { openWorktreeStore, type WorktreeStore } from './worktree-store.js';

// AC-L3-2 (end-to-end, on a NON-TRIVIAL fixture): a real git repo with a dependency dir, an `.env`,
// and its OWN test that imports the dep and reads `.env`. Sling + provision must make the sandbox
// IMMEDIATELY RUNNABLE — dep pointer-linked, `.env` copied, the fixture's own test actually passing
// in the provisioned worktree — and an isolated-copy override must yield a private deps dir.

const ORIGINAL_ENV = process.env;
let tmpDirs: string[] = [];
let stores: WorktreeStore[] = [];
let configs: ConfigStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  tmpDirs = [];
  stores = [];
  configs = [];
  const data = mkdtempSync(join(tmpdir(), 'co-prov-fix-data-'));
  tmpDirs.push(data);
  process.env.CO_DATA_DIR = data;
});

afterEach(() => {
  for (const s of stores) s.close();
  for (const c of configs) c.close();
  process.env = ORIGINAL_ENV;
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
  stores = [];
  configs = [];
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=Test',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  ).trim();
}

/**
 * A non-trivial fixture: tracked app sources (`package.json`, `app-test.mjs`, `.gitignore`) PLUS the
 * gitignored working essentials a runnable env needs — a `node_modules/leftpad` dependency and an
 * `.env`. Only the tracked files are committed; the essentials remain ignored working files (so a
 * bare checkout cannot run the test until provisioning places them).
 */
function makeFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-prov-fix-repo-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });

  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture-app', type: 'module' }));
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.env\n');
  // The fixture's OWN test: imports the dep (bare specifier → node_modules) and reads `.env`.
  writeFileSync(
    join(dir, 'app-test.mjs'),
    [
      'import { readFileSync } from "node:fs";',
      'import { fileURLToPath } from "node:url";',
      'import { dirname, join } from "node:path";',
      'import { greet } from "leftpad";',
      'const here = dirname(fileURLToPath(import.meta.url));',
      'const who = readFileSync(join(here, ".env"), "utf8").match(/^WHO=(.*)$/m)?.[1];',
      'const out = greet(who);',
      'if (out !== "hello world") { console.error("FAIL: " + out); process.exit(1); }',
      'console.log("OK");',
      '',
    ].join('\n'),
  );
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'init fixture app');

  // The gitignored essentials (NOT committed): a dependency + local env.
  mkdirSync(join(dir, 'node_modules', 'leftpad'), { recursive: true });
  writeFileSync(
    join(dir, 'node_modules', 'leftpad', 'package.json'),
    JSON.stringify({ name: 'leftpad', version: '1.0.0', type: 'module', main: 'index.js' }),
  );
  writeFileSync(
    join(dir, 'node_modules', 'leftpad', 'index.js'),
    'export function greet(who) { return "hello " + who; }\n',
  );
  writeFileSync(join(dir, '.env'), 'WHO=world\n');
  return dir;
}

function openStore(projectId: string): WorktreeStore {
  const s = openWorktreeStore(projectId);
  stores.push(s);
  return s;
}

function openCfg(): ConfigStore {
  const c = openConfigStore();
  configs.push(c);
  return c;
}

/** Run the fixture's own test inside `worktreePath`; returns trimmed stdout (throws on non-zero). */
function runFixtureTest(worktreePath: string): string {
  return execFileSync('node', ['app-test.mjs'], { cwd: worktreePath, encoding: 'utf8' }).trim();
}

describe('sling + provision (default manifest) — the worktree is immediately runnable', () => {
  it('symlinks the dep dir, copies .env, and the fixture test PASSES in the provisioned sandbox', () => {
    const repo = makeFixtureRepo();
    const store = openStore('p-fixture');

    const result = slingWorktree(store, {
      parent: 'lead-7',
      branch: 'co/fixture-x',
      repoCwd: repo,
      projectId: 'p-fixture',
    });

    const wt = result.worktreePath;

    // The dep dir is a POINTER (symlink) to the source — large/stable/read-mostly.
    const nm = join(wt, 'node_modules');
    expect(lstatSync(nm).isSymbolicLink()).toBe(true);

    // `.env` is a real FILE COPY (not a link), with the source's contents.
    const env = join(wt, '.env');
    expect(lstatSync(env).isSymbolicLink()).toBe(false);
    expect(lstatSync(env).isFile()).toBe(true);
    expect(readFileSync(env, 'utf8')).toBe('WHO=world\n');

    // The proof the sandbox "just works": its own test runs and passes (deps + env present).
    expect(runFixtureTest(wt)).toBe('OK');
  });
});

describe('sling + provision (isolated-copy override) — a private deps dir', () => {
  it('an isolated-copy override yields a real, private node_modules — mutating it spares the source', () => {
    const repo = makeFixtureRepo();
    const projectId = 'p-fixture-iso';
    // Per-project override via the config cascade: mark the dep dir isolated-copy.
    openCfg().setProjectOverride(projectId, WORKTREE_PROVISION_CONFIG_KEY, {
      node_modules: 'isolated-copy',
    });
    const store = openStore(projectId);

    const result = slingWorktree(store, {
      parent: 'lead-7',
      branch: 'co/fixture-iso',
      repoCwd: repo,
      projectId,
    });

    const wt = result.worktreePath;
    const nm = join(wt, 'node_modules');

    // A real private copy — NOT a symlink to the source.
    expect(lstatSync(nm).isSymbolicLink()).toBe(false);
    expect(lstatSync(nm).isDirectory()).toBe(true);

    // It is still runnable from the private copy.
    expect(runFixtureTest(wt)).toBe('OK');

    // Mutating the private deps dir does NOT corrupt the shared source (parallel-agent safety).
    writeFileSync(join(nm, 'leftpad', 'INSTALLED'), 'new package\n');
    expect(existsSync(join(repo, 'node_modules', 'leftpad', 'INSTALLED'))).toBe(false);
  });
});

// #129 (end-to-end, on a pnpm-WORKSPACE fixture): a real git repo laid out like the `co` monorepo —
// a `pnpm-workspace.yaml`, a root `node_modules/.pnpm` store, and a workspace package whose
// `node_modules` is a symlink farm with a RELATIVE dep link into the root store plus a `@scope/*`
// self-link to a sibling package source. Sling + provision must make the SANDBOX runnable: the
// package's bare dep resolves, writing under the worktree's node_modules never touches the source
// repo (EROFS class fixed), and the relative/self-links resolve INTO the sandbox, not the source.

/**
 * A pnpm-workspace fixture repo. Tracked: `pnpm-workspace.yaml`, two package `package.json`s, and a
 * test in pkg-a that imports the bare dep `widget` (→ pkg-a's node_modules) and the sibling `@scope/pkg-b`.
 * Gitignored essentials (NOT committed): the root `.pnpm` store, the root + per-package node_modules
 * symlink farms.
 */
function makeWorkspaceFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-prov-ws-repo-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });

  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  for (const p of ['pkg-a', 'pkg-b']) {
    mkdirSync(join(dir, 'packages', p), { recursive: true });
    writeFileSync(
      join(dir, 'packages', p, 'package.json'),
      JSON.stringify({ name: `@scope/${p}`, type: 'module', main: 'index.js' }),
    );
  }
  // pkg-b's runnable module (the workspace self-link target).
  writeFileSync(
    join(dir, 'packages', 'pkg-b', 'index.js'),
    'export const sibling = "from-pkg-b";\n',
  );
  // pkg-a's OWN test: import the bare dep (→ node_modules/widget) AND the sibling via @scope self-link.
  writeFileSync(
    join(dir, 'packages', 'pkg-a', 'app-test.mjs'),
    [
      'import { widget } from "widget";',
      'import { sibling } from "@scope/pkg-b";',
      'if (widget() !== "ok" || sibling !== "from-pkg-b") { console.error("FAIL"); process.exit(1); }',
      'console.log("OK");',
      '',
    ].join('\n'),
  );
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'init workspace fixture');

  // --- Gitignored essentials: the shared .pnpm store + the symlink farms. ---
  // The real dep content of `widget` lives in the content-addressed store.
  const widgetStore = join(dir, 'node_modules', '.pnpm', 'widget@1.0.0', 'node_modules', 'widget');
  mkdirSync(widgetStore, { recursive: true });
  writeFileSync(
    join(widgetStore, 'package.json'),
    JSON.stringify({ name: 'widget', version: '1.0.0', type: 'module', main: 'index.js' }),
  );
  writeFileSync(join(widgetStore, 'index.js'), 'export function widget() { return "ok"; }\n');
  // Root node_modules: a top-level dep symlink into the store.
  symlinkSync('.pnpm/widget@1.0.0/node_modules/widget', join(dir, 'node_modules', 'widget'));
  // pkg-a node_modules: a RELATIVE dep link into the root store + a @scope self-link to pkg-b's source.
  mkdirSync(join(dir, 'packages', 'pkg-a', 'node_modules', '@scope'), { recursive: true });
  symlinkSync(
    '../../../node_modules/.pnpm/widget@1.0.0/node_modules/widget',
    join(dir, 'packages', 'pkg-a', 'node_modules', 'widget'),
  );
  // From `packages/pkg-a/node_modules/@scope/`, `../../../pkg-b` resolves to `packages/pkg-b` —
  // mirroring how real pnpm writes `@co/core -> ../../../core` in this workspace.
  symlinkSync('../../../pkg-b', join(dir, 'packages', 'pkg-a', 'node_modules', '@scope', 'pkg-b'));
  return dir;
}

describe('sling + provision (pnpm WORKSPACE) — slung workers can run verify (#129)', () => {
  it('provisions per-package node_modules, keeps the source pristine, and pkg-a test PASSES in the sandbox', () => {
    const repo = makeWorkspaceFixtureRepo();
    const store = openStore('p-ws-fixture');

    // (2) PROVISIONING reads the source only (no write-through). Wrap the source's `packages/` and
    //     `node_modules/` subtrees (the provisioning read targets) in assertRepoPristine across the
    //     sling — scoped to those rather than the whole repo because `git worktree add` legitimately
    //     writes git's own `.git/worktrees/…` bookkeeping into the source (git admin, not a
    //     provisioning write). The per-package `packages/pkg-a/node_modules` is the #129 EROFS case.
    const result = assertRepoPristine(join(repo, 'packages'), () =>
      assertRepoPristine(join(repo, 'node_modules'), () =>
        slingWorktree(store, {
          parent: 'lead-7',
          branch: 'co/ws-x',
          repoCwd: repo,
          projectId: 'p-ws-fixture',
        }),
      ),
    );
    const wt = result.worktreePath;

    // (1) The worktree HAS packages/pkg-a/node_modules as a real writable dir (not a single root symlink).
    const pkgNm = join(wt, 'packages', 'pkg-a', 'node_modules');
    expect(existsSync(pkgNm)).toBe(true);
    expect(lstatSync(pkgNm).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(wt, 'node_modules')).isSymbolicLink()).toBe(false);
    // The heavy `.pnpm` store is shared by symlink.
    expect(lstatSync(join(wt, 'node_modules', '.pnpm')).isSymbolicLink()).toBe(true);

    // (3) The package's RELATIVE dep link resolves THROUGH the sandbox's own `.pnpm` (shared store),
    //     and the @scope self-link resolves into the sandbox's OWN package source — NOT the source repo.
    const depLink = join(pkgNm, 'widget');
    expect(readFileSync(join(depLink, 'index.js'), 'utf8')).toContain('return "ok"');
    expect(realpathSync(depLink)).toBe(
      realpathSync(join(wt, 'node_modules', '.pnpm', 'widget@1.0.0', 'node_modules', 'widget')),
    );
    const self = join(pkgNm, '@scope', 'pkg-b');
    expect(realpathSync(self)).toBe(realpathSync(join(wt, 'packages', 'pkg-b')));
    expect(realpathSync(self).startsWith(realpathSync(wt))).toBe(true); // sandbox source, not the repo

    // The proof: pkg-a's own test (bare dep + sibling self-link) runs and passes in the sandbox.
    const out = execFileSync('node', ['app-test.mjs'], {
      cwd: join(wt, 'packages', 'pkg-a'),
      encoding: 'utf8',
    }).trim();
    expect(out).toBe('OK');

    // (2 cont.) Writing under the worktree's node_modules does NOT appear in the source repo.
    writeFileSync(join(pkgNm, '.vite-temp'), 'scratch\n');
    expect(existsSync(join(repo, 'packages', 'pkg-a', 'node_modules', '.vite-temp'))).toBe(false);
  });
});
