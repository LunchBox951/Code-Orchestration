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
  mergeProvisioningManifest,
  provisionWorktree,
  resolveProvisioningManifest,
  type ProvisioningManifest,
} from './provision.js';

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
