import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertRepoPristine } from '../config/pristine.js';
import { openConfigStore, type ConfigStore } from '../config/config-store.js';
import {
  DEFAULT_PROVISION_MANIFEST,
  WORKTREE_PROVISION_CONFIG_KEY,
  WorkspaceDepsNotProvisionedError,
  detectWorkspacePackages,
  expandWorkspaceManifest,
  mergeProvisioningManifest,
  parseWorkspacePackageGlobs,
  provisionWorktree,
  resolveProvisioningManifest,
  type ProvisioningManifest,
} from './provision.js';
import { symlinkSync } from 'node:fs';

// AC-L3-2 (provisioning applier + manifest): the gitignored working essentials are placed into a
// sandbox by the RIGHT mechanism (symlink large/stable deps · copy small/mutable env · isolated-copy
// a dep dir an agent will mutate), from a manifest = smart defaults ⊕ per-project config overrides.
// The SOURCE repo stays pristine (Principle 12); absent sources are skipped, broken placement throws
// (Principle 9). Exercised against real temp dirs (the applier needs no git — it is pure filesystem).

const ORIGINAL_ENV = process.env;
let tmpDirs: string[] = [];
let configs: ConfigStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  tmpDirs = [];
  configs = [];
  const data = mkdtempSync(join(tmpdir(), 'co-prov-data-'));
  tmpDirs.push(data);
  process.env.CO_DATA_DIR = data;
});

afterEach(() => {
  for (const c of configs) c.close();
  process.env = ORIGINAL_ENV;
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
  configs = [];
});

/** A source "repo" dir carrying the gitignored essentials: a dep dir + an `.env`. */
function makeSourceRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-prov-repo-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'export const greet = () => "hi";\n');
  writeFileSync(join(dir, '.env'), 'WHO=world\n');
  writeFileSync(join(dir, 'README.md'), 'tracked\n'); // a plain tracked file
  return dir;
}

/** An empty destination "sandbox" dir (stands in for the slung worktree). */
function makeSandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-prov-wt-'));
  tmpDirs.push(dir);
  return dir;
}

function openCfg(): ConfigStore {
  const c = openConfigStore();
  configs.push(c);
  return c;
}

describe('provisionWorktree — places essentials by the right mechanism', () => {
  it('symlink: a dependency dir becomes a POINTER to the source (no duplication)', () => {
    const repo = makeSourceRepo();
    const wt = makeSandbox();

    const res = provisionWorktree({
      repoCwd: repo,
      worktreePath: wt,
      manifest: [{ path: 'node_modules', mechanism: 'symlink' }],
    });

    const dest = join(wt, 'node_modules');
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(readlinkSync(dest)).toBe(resolve(repo, 'node_modules'));
    expect(realpathSync(dest)).toBe(realpathSync(join(repo, 'node_modules')));
    // It resolves THROUGH the pointer — the dep is readable from the sandbox.
    expect(readFileSync(join(dest, 'dep', 'index.js'), 'utf8')).toContain('greet');
    expect(res.provisioned).toEqual([{ path: 'node_modules', mechanism: 'symlink' }]);
    expect(res.skipped).toEqual([]);
  });

  it('copy: a small/mutable item (.env) becomes a real, INDEPENDENT file copy (not a link)', () => {
    const repo = makeSourceRepo();
    const wt = makeSandbox();

    provisionWorktree({
      repoCwd: repo,
      worktreePath: wt,
      manifest: [{ path: '.env', mechanism: 'copy' }],
    });

    const dest = join(wt, '.env');
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(lstatSync(dest).isFile()).toBe(true);
    expect(readFileSync(dest, 'utf8')).toBe(readFileSync(join(repo, '.env'), 'utf8'));

    // Mutating the copy does not touch the source — it is per-agent.
    writeFileSync(dest, 'WHO=mutated\n');
    expect(readFileSync(join(repo, '.env'), 'utf8')).toBe('WHO=world\n');
  });

  it('isolated-copy: a dep dir becomes a PRIVATE copy — mutating it never touches the source', () => {
    const repo = makeSourceRepo();
    const wt = makeSandbox();

    provisionWorktree({
      repoCwd: repo,
      worktreePath: wt,
      manifest: [{ path: 'node_modules', mechanism: 'isolated-copy' }],
    });

    const dest = join(wt, 'node_modules');
    expect(lstatSync(dest).isSymbolicLink()).toBe(false); // a real dir, NOT a pointer
    expect(lstatSync(dest).isDirectory()).toBe(true);
    expect(readFileSync(join(dest, 'dep', 'index.js'), 'utf8')).toContain('greet');

    // The agent installs/mutates a package in its private copy → the source is untouched.
    writeFileSync(join(dest, 'dep', 'INSTALLED'), 'new\n');
    expect(existsSync(join(repo, 'node_modules', 'dep', 'INSTALLED'))).toBe(false);
  });

  it('skips an entry whose source is absent (a repo may have no .venv) — no throw, no dest', () => {
    const repo = makeSourceRepo();
    const wt = makeSandbox();

    const res = provisionWorktree({
      repoCwd: repo,
      worktreePath: wt,
      manifest: [
        { path: '.venv', mechanism: 'symlink' }, // absent in the source
        { path: '.env', mechanism: 'copy' }, // present
      ],
    });

    expect(res.skipped).toEqual(['.venv']);
    expect(res.provisioned).toEqual([{ path: '.env', mechanism: 'copy' }]);
    expect(existsSync(join(wt, '.venv'))).toBe(false);
    expect(existsSync(join(wt, '.env'))).toBe(true);
  });

  it('fails loud on a genuinely broken placement (dest already exists) — Principle 9', () => {
    const repo = makeSourceRepo();
    const wt = makeSandbox();
    mkdirSync(join(wt, 'node_modules')); // collide: the symlink cannot be created

    expect(() =>
      provisionWorktree({
        repoCwd: repo,
        worktreePath: wt,
        manifest: [{ path: 'node_modules', mechanism: 'symlink' }],
      }),
    ).toThrow(/failed to provision 'node_modules' \(symlink\)/);
  });

  it('refuses a manifest entry that escapes the repo or is absolute (Principle 12)', () => {
    const repo = makeSourceRepo();
    const wt = makeSandbox();
    expect(() =>
      provisionWorktree({
        repoCwd: repo,
        worktreePath: wt,
        manifest: [{ path: '../escape', mechanism: 'copy' }],
      }),
    ).toThrow(/escapes/i);
    expect(() =>
      provisionWorktree({
        repoCwd: repo,
        worktreePath: wt,
        manifest: [{ path: '/etc/passwd', mechanism: 'copy' }],
      }),
    ).toThrow(/absolute|escapes/i);
  });
});

describe('provisionWorktree — the SOURCE repo stays pristine (Principle 12)', () => {
  it('assertRepoPristine holds around provisioning (green path) — only the sandbox is written', () => {
    const repo = makeSourceRepo();
    const wt = makeSandbox();

    // Wrapping the SOURCE (not the worktree) must NOT throw — provisioning only reads it.
    expect(() =>
      assertRepoPristine(repo, () =>
        provisionWorktree({
          repoCwd: repo,
          worktreePath: wt,
          manifest: [
            { path: 'node_modules', mechanism: 'symlink' },
            { path: '.env', mechanism: 'copy' },
          ],
        }),
      ),
    ).not.toThrow();

    // Non-vacuous: the sandbox really gained the essentials.
    expect(lstatSync(join(wt, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(wt, '.env'))).toBe(true);
  });

  it('the source stays pristine even on the THROWING path (the provision error propagates)', () => {
    const repo = makeSourceRepo();
    const wt = makeSandbox();
    mkdirSync(join(wt, 'node_modules')); // force a placement failure mid-provision

    // assertRepoPristine re-checks the repo even when fn throws; a clean repo propagates fn's own
    // error. Matching the PROVISION error (not a "was modified" pristine violation) proves the
    // source was untouched on the throwing path.
    expect(() =>
      assertRepoPristine(repo, () =>
        provisionWorktree({
          repoCwd: repo,
          worktreePath: wt,
          manifest: [{ path: 'node_modules', mechanism: 'symlink' }],
        }),
      ),
    ).toThrow(/failed to provision/);
    expect(readFileSync(join(repo, '.env'), 'utf8')).toBe('WHO=world\n'); // source intact
  });
});

describe('manifest defaults + per-project overrides', () => {
  it('the default manifest symlinks dep dirs and copies env files (not a blanket .gitignore copy)', () => {
    const byPath = new Map(DEFAULT_PROVISION_MANIFEST.map((e) => [e.path, e.mechanism]));
    expect(byPath.get('node_modules')).toBe('symlink');
    expect(byPath.get('.venv')).toBe('symlink');
    expect(byPath.get('.env')).toBe('copy');
  });

  it('mergeProvisioningManifest: undefined override yields the base unchanged', () => {
    expect(mergeProvisioningManifest(DEFAULT_PROVISION_MANIFEST, undefined)).toBe(
      DEFAULT_PROVISION_MANIFEST,
    );
  });

  it('mergeProvisioningManifest: an override changes a mechanism in place (dep → isolated-copy)', () => {
    const merged = mergeProvisioningManifest(DEFAULT_PROVISION_MANIFEST, {
      node_modules: 'isolated-copy',
    });
    expect(merged[0]).toEqual({ path: 'node_modules', mechanism: 'isolated-copy' }); // position kept
    expect(merged).toHaveLength(DEFAULT_PROVISION_MANIFEST.length);
  });

  it('mergeProvisioningManifest: an override adds a new entry and removes one with "none"', () => {
    const merged = mergeProvisioningManifest(DEFAULT_PROVISION_MANIFEST, {
      'config/local.json': 'copy',
      '.env.local': 'none',
    });
    expect(merged.find((e) => e.path === 'config/local.json')?.mechanism).toBe('copy');
    expect(merged.find((e) => e.path === '.env.local')).toBeUndefined();
  });

  it('mergeProvisioningManifest: a malformed override fails loud (Principle 9)', () => {
    expect(() =>
      mergeProvisioningManifest(DEFAULT_PROVISION_MANIFEST, { node_modules: 'teleport' }),
    ).toThrow(/malformed 'worktree.provision'/);
    expect(() => mergeProvisioningManifest(DEFAULT_PROVISION_MANIFEST, 'nope')).toThrow(
      /malformed 'worktree.provision'/,
    );
  });

  it('resolveProvisioningManifest: defaults when no project override is set', () => {
    const resolved = resolveProvisioningManifest('p-no-override');
    expect(resolved).toEqual([...DEFAULT_PROVISION_MANIFEST]);
  });

  it('resolveProvisioningManifest: a per-project override merges over the defaults (config cascade)', () => {
    const projectId = 'p-with-override';
    const cfg = openCfg();
    cfg.setProjectOverride(projectId, WORKTREE_PROVISION_CONFIG_KEY, {
      node_modules: 'isolated-copy',
      '.env.local': 'none',
    });

    const resolved: ProvisioningManifest = resolveProvisioningManifest(projectId);
    expect(resolved.find((e) => e.path === 'node_modules')?.mechanism).toBe('isolated-copy');
    expect(resolved.find((e) => e.path === '.env.local')).toBeUndefined();
    // An untouched default entry is still present.
    expect(resolved.find((e) => e.path === '.env')?.mechanism).toBe('copy');
  });
});

// ---- #129: workspace-aware expansion ----------------------------------------------------------

/** A pnpm-WORKSPACE source repo: `pnpm-workspace.yaml` + workspace package dirs with `package.json`. */
function makeWorkspaceSource(globs: string[], pkgs: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-prov-ws-'));
  tmpDirs.push(dir);
  writeFileSync(
    join(dir, 'pnpm-workspace.yaml'),
    `packages:\n${globs.map((g) => `  - "${g}"`).join('\n')}\n`,
  );
  for (const pkg of pkgs) {
    mkdirSync(join(dir, pkg), { recursive: true });
    writeFileSync(
      join(dir, pkg, 'package.json'),
      JSON.stringify({ name: pkg.replace(/\//g, '-') }),
    );
  }
  return dir;
}

describe('parseWorkspacePackageGlobs — minimal pnpm-workspace.yaml parsing', () => {
  it('reads the packages: list and ignores comments / other top-level keys', () => {
    const yaml = [
      'packages:',
      '  - "packages/*"',
      "  - 'apps/*'   # a comment",
      '  - tools/cli',
      'overrides:',
      '  - "ignored/*"',
    ].join('\n');
    expect(parseWorkspacePackageGlobs(yaml)).toEqual(['packages/*', 'apps/*', 'tools/cli']);
  });
});

describe('detectWorkspacePackages — only when pnpm-workspace.yaml is present', () => {
  it('returns null for a single-package repo (no pnpm-workspace.yaml)', () => {
    const repo = makeSourceRepo();
    expect(detectWorkspacePackages(repo)).toBeNull();
  });

  it('expands trailing-* globs to package dirs that have a package.json', () => {
    const repo = makeWorkspaceSource(
      ['packages/*', 'apps/*'],
      ['packages/core', 'packages/cli', 'apps/desktop'],
    );
    // A non-package dir under the glob (no package.json) is ignored.
    mkdirSync(join(repo, 'packages', 'not-a-pkg'), { recursive: true });
    expect(detectWorkspacePackages(repo)?.sort()).toEqual([
      'apps/desktop',
      'packages/cli',
      'packages/core',
    ]);
  });
});

describe('expandWorkspaceManifest — node_modules symlink → per-leaf hybrid ONLY in a workspace', () => {
  it('single-package repo: manifest unchanged (no pnpm-workspace.yaml)', () => {
    const repo = makeSourceRepo();
    const expanded = expandWorkspaceManifest(DEFAULT_PROVISION_MANIFEST, repo);
    expect(expanded).toEqual([...DEFAULT_PROVISION_MANIFEST]);
  });

  it('workspace repo: node_modules expands to root + every package leaf as workspace-node-modules', () => {
    const repo = makeWorkspaceSource(['packages/*'], ['packages/core', 'packages/cli']);
    const expanded = expandWorkspaceManifest(DEFAULT_PROVISION_MANIFEST, repo);
    const wsm = expanded.filter((e) => e.mechanism === 'workspace-node-modules').map((e) => e.path);
    expect(wsm[0]).toBe('node_modules'); // root leaf is always first
    expect(wsm.slice(1).sort()).toEqual([
      'packages/cli/node_modules',
      'packages/core/node_modules',
    ]);
    // The single root `node_modules` symlink entry is gone (replaced by the hybrid leaves).
    expect(
      expanded.find((e) => e.path === 'node_modules' && e.mechanism === 'symlink'),
    ).toBeUndefined();
    // Non-node_modules entries (env files) are untouched.
    expect(expanded.find((e) => e.path === '.env')?.mechanism).toBe('copy');
  });

  it('workspace repo: an operator override away from symlink (isolated-copy) suppresses expansion', () => {
    const repo = makeWorkspaceSource(['packages/*'], ['packages/core']);
    const overridden = mergeProvisioningManifest(DEFAULT_PROVISION_MANIFEST, {
      node_modules: 'isolated-copy',
    });
    const expanded = expandWorkspaceManifest(overridden, repo);
    expect(expanded.find((e) => e.path === 'node_modules')?.mechanism).toBe('isolated-copy');
    expect(expanded.some((e) => e.mechanism === 'workspace-node-modules')).toBe(false);
  });
});

describe('provisionWorktree — pnpm-workspace hybrid leaves + structured deps error (#129)', () => {
  /**
   * A realistic pnpm-workspace source: a root `.pnpm` store, root `node_modules` with a dep symlink
   * into it, and a package leaf whose dep link is RELATIVE into the root store plus a `@scope/*`
   * self-link to the sibling package source.
   */
  function makeWorkspaceWithStore(): string {
    const dir = mkdtempSync(join(tmpdir(), 'co-prov-wsstore-'));
    tmpDirs.push(dir);
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');
    // The real dep content lives in the shared .pnpm store.
    mkdirSync(join(dir, 'node_modules', '.pnpm', 'zod@1.0.0', 'node_modules', 'zod'), {
      recursive: true,
    });
    writeFileSync(
      join(dir, 'node_modules', '.pnpm', 'zod@1.0.0', 'node_modules', 'zod', 'index.js'),
      'export const z = 1;\n',
    );
    // Root node_modules: a top-level symlink into the store + a metadata file.
    symlinkSync('.pnpm/zod@1.0.0/node_modules/zod', join(dir, 'node_modules', 'zod'));
    writeFileSync(join(dir, 'node_modules', '.modules.yaml'), 'hoistPattern:\n');
    // Two workspace packages.
    for (const p of ['pkg-a', 'pkg-b']) {
      mkdirSync(join(dir, 'packages', p), { recursive: true });
      writeFileSync(
        join(dir, 'packages', p, 'package.json'),
        JSON.stringify({ name: `@scope/${p}` }),
      );
    }
    // pkg-a's node_modules: a RELATIVE dep link into the root store + a self-link to pkg-b's source.
    mkdirSync(join(dir, 'packages', 'pkg-a', 'node_modules', '@scope'), { recursive: true });
    symlinkSync(
      '../../../node_modules/.pnpm/zod@1.0.0/node_modules/zod',
      join(dir, 'packages', 'pkg-a', 'node_modules', 'zod'),
    );
    symlinkSync(
      '../../../pkg-b',
      join(dir, 'packages', 'pkg-a', 'node_modules', '@scope', 'pkg-b'),
    );
    return dir;
  }

  it('mirrors each leaf writable, shares .pnpm read-only, and keeps relative/self-links resolving in-sandbox', () => {
    const repo = makeWorkspaceWithStore();
    const wt = makeSandbox();
    // The sandbox is a worktree: it has the package SOURCES checked out (so the @scope self-link target exists).
    mkdirSync(join(wt, 'packages', 'pkg-b'), { recursive: true });
    writeFileSync(join(wt, 'packages', 'pkg-b', 'package.json'), '{}');

    const res = provisionWorktree({
      repoCwd: repo,
      worktreePath: wt,
      manifest: DEFAULT_PROVISION_MANIFEST,
    });

    // (1) Every leaf is a REAL writable dir (not a single root symlink).
    for (const leaf of ['node_modules', 'packages/pkg-a/node_modules']) {
      expect(lstatSync(join(wt, leaf)).isSymbolicLink()).toBe(false);
      expect(lstatSync(join(wt, leaf)).isDirectory()).toBe(true);
    }
    // The heavy `.pnpm` store IS shared by symlink (read-only), not copied.
    expect(lstatSync(join(wt, 'node_modules', '.pnpm')).isSymbolicLink()).toBe(true);
    // (2) The dep resolves THROUGH the mirror at the root.
    expect(readFileSync(join(wt, 'node_modules', 'zod', 'index.js'), 'utf8')).toContain('z = 1');
    // (3) The package's RELATIVE dep link is recreated verbatim and resolves THROUGH the sandbox's
    //     own `node_modules/.pnpm` (the shared store) — the dep is readable from the package leaf, and
    //     the resolution traverses the sandbox, never a single root symlink into the source tree.
    const pkgZod = join(wt, 'packages', 'pkg-a', 'node_modules', 'zod');
    expect(lstatSync(pkgZod).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(pkgZod, 'index.js'), 'utf8')).toContain('z = 1');
    // It resolves to the SAME content as the sandbox-root `.pnpm` store entry (shared read-only store).
    expect(realpathSync(pkgZod)).toBe(
      realpathSync(join(wt, 'node_modules', '.pnpm', 'zod@1.0.0', 'node_modules', 'zod')),
    );
    // (4) The `@scope/*` self-link resolves into the sandbox's OWN package source (not the source repo).
    const selfLink = join(wt, 'packages', 'pkg-a', 'node_modules', '@scope', 'pkg-b');
    expect(realpathSync(selfLink)).toBe(realpathSync(join(wt, 'packages', 'pkg-b')));

    const placed = res.provisioned
      .filter((e) => e.mechanism === 'workspace-node-modules')
      .map((e) => e.path);
    expect(placed).toContain('node_modules');
    expect(placed).toContain('packages/pkg-a/node_modules');
    // pkg-b has no node_modules in the source → skipped (an un-built package is legitimate).
    expect(res.skipped).toContain('packages/pkg-b/node_modules');
  });

  it('writing under a provisioned leaf does NOT touch the source repo (EROFS class fixed)', () => {
    const repo = makeWorkspaceWithStore();
    const wt = makeSandbox();
    mkdirSync(join(wt, 'packages', 'pkg-b'), { recursive: true });

    assertRepoPristine(repo, () =>
      provisionWorktree({ repoCwd: repo, worktreePath: wt, manifest: DEFAULT_PROVISION_MANIFEST }),
    );

    // Tooling scratch (vite's `.vite-temp`) writes into the leaf — must stay in-sandbox.
    writeFileSync(join(wt, 'packages', 'pkg-a', 'node_modules', '.vite-temp'), 'scratch\n');
    expect(existsSync(join(repo, 'packages', 'pkg-a', 'node_modules', '.vite-temp'))).toBe(false);
    // The source repo's node_modules is byte-identical (proven by assertRepoPristine above).
    expect(readFileSync(join(repo, 'node_modules', '.modules.yaml'), 'utf8')).toBe(
      'hoistPattern:\n',
    );
  });

  it('throws the structured WorkspaceDepsNotProvisionedError (not raw EROFS) when a dep cannot resolve', () => {
    const repo = makeWorkspaceWithStore();
    const wt = makeSandbox();
    mkdirSync(join(wt, 'packages', 'pkg-b'), { recursive: true });
    // Break resolvability: remove the store content the pkg-a dep link points at, so the mirrored
    // relative link dangles → deps not provisioned.
    rmSync(join(repo, 'node_modules', '.pnpm'), { recursive: true, force: true });

    let thrown: unknown;
    try {
      provisionWorktree({ repoCwd: repo, worktreePath: wt, manifest: DEFAULT_PROVISION_MANIFEST });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(WorkspaceDepsNotProvisionedError);
    expect((thrown as WorkspaceDepsNotProvisionedError).message).toMatch(/deps not provisioned/);
    expect((thrown as WorkspaceDepsNotProvisionedError).message).not.toMatch(/EROFS/);
  });
});
