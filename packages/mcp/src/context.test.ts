import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chdir, cwd } from 'node:process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCoreRegistry,
  openRegistry,
  openWorktreeStore,
  slingWorktree,
  toolsForRole,
  type Role,
} from '@co/core';
import {
  CO_AGENT_ENV,
  CO_PROJECT_ID_ENV,
  CO_ROLE_ENV,
  defaultContextFactory,
  toolsFromEnv,
} from './context.js';

/** Mirror the CO_DATA_DIR idiom in mail.test.ts: save/restore process.env. */
const ORIGINAL_ENV = process.env;
const ORIGINAL_CWD = cwd();
let tmpDirs: string[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  tmpDirs = [];
});

afterEach(() => {
  chdir(ORIGINAL_CWD);
  process.env = ORIGINAL_ENV;
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function useDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-mcp-context-data-'));
  tmpDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
  return dir;
}

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

function makeMainRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-mcp-context-repo-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

describe('toolsFromEnv — role-scoped tool-list from launch environment', () => {
  it('returns undefined when CO_ROLE is absent', () => {
    delete process.env[CO_ROLE_ENV];
    const result = toolsFromEnv();
    expect(result).toBeUndefined();
  });

  it('fails loud when CO_ROLE is set but empty or whitespace-only', () => {
    process.env[CO_ROLE_ENV] = '';
    expect(() => toolsFromEnv()).toThrow(/CO_ROLE.*empty/i);

    process.env[CO_ROLE_ENV] = '   ';
    expect(() => toolsFromEnv()).toThrow(/CO_ROLE.*empty/i);
  });

  it('fails loud when CO_ROLE is unrecognized (no typo fallback to full registry)', () => {
    process.env[CO_ROLE_ENV] = 'wizard';
    expect(() => toolsFromEnv()).toThrow(/unknown CO_ROLE/i);
  });

  it('scopes a sub-role string to its base role until L6 narrows it further', () => {
    process.env[CO_ROLE_ENV] = ' implementer:test ';
    const result = toolsFromEnv();
    const expected = toolsForRole('implementer');

    expect(result).toBeDefined();
    expect(result!.map((t) => t.name).sort()).toEqual(expected.map((t) => t.name).sort());
  });

  it('returns exactly toolsForRole(role) when CO_ROLE names a valid base role', () => {
    const validRoles: Role[] = ['coordinator', 'lead', 'implementer', 'reviewer', 'researcher'];

    for (const role of validRoles) {
      process.env[CO_ROLE_ENV] = role;
      const result = toolsFromEnv();
      const expected = toolsForRole(role);

      expect(result).toBeDefined();
      expect(result).toEqual(expected);
      // Verify it's a subset and the tool names match (e.g., reviewer excludes co_mail_retract).
      const resultNames = result!.map((t) => t.name).sort();
      const expectedNames = expected.map((t) => t.name).sort();
      expect(resultNames).toEqual(expectedNames);
    }
  });

  it('handles case-insensitive and whitespace-trimmed CO_ROLE', () => {
    process.env[CO_ROLE_ENV] = '  IMPLEMENTER  ';
    const result = toolsFromEnv();
    const expected = toolsForRole('implementer');

    expect(result).toBeDefined();
    expect(result).toEqual(expected);
    expect(result!.map((t) => t.name).sort()).toEqual(expected.map((t) => t.name).sort());
  });

  it('reviewer toolset is scoped (excludes co_mail_retract)', () => {
    process.env[CO_ROLE_ENV] = 'reviewer';
    const result = toolsFromEnv();

    expect(result).toBeDefined();
    const toolNames = result!.map((t) => t.name);
    expect(toolNames).not.toContain('co_mail_retract');
    // Also check that the full registry has more tools.
    const fullRegistry = buildCoreRegistry();
    const allTools = fullRegistry.list();
    expect(allTools.length).toBeGreaterThan(result!.length);
  });
});

describe('defaultContextFactory — production context resolution', () => {
  it('rejects CO_PROJECT_ID when cwd is neither registered nor a live recorded worktree', () => {
    useDataDir();
    const repo = makeMainRepo();
    const registry = openRegistry();
    const projectId = registry.register(repo);
    registry.close();

    const stranger = mkdtempSync(join(tmpdir(), 'co-mcp-context-stranger-'));
    tmpDirs.push(stranger);
    process.env[CO_AGENT_ENV] = 'impl-1';
    process.env[CO_PROJECT_ID_ENV] = projectId;
    chdir(stranger);

    expect(() => defaultContextFactory()).toThrow(/does not record cwd .* live slung worktree/i);
  });

  it('rejects CO_PROJECT_ID that disagrees with the registered cwd project', () => {
    useDataDir();
    const repoA = makeMainRepo();
    const repoB = makeMainRepo();
    const registry = openRegistry();
    const projectA = registry.register(repoA);
    const projectB = registry.register(repoB);
    registry.close();

    process.env[CO_AGENT_ENV] = 'impl-1';
    process.env[CO_PROJECT_ID_ENV] = projectB;
    chdir(repoA);

    expect(projectA).not.toBe(projectB);
    expect(() => defaultContextFactory()).toThrow(/does not match registered cwd project/i);
  });

  it('rejects CO_PROJECT_ID when cwd is a removed recorded worktree', () => {
    useDataDir();
    const repo = makeMainRepo();
    const registry = openRegistry();
    const projectId = registry.register(repo);
    registry.close();

    const worktrees = openWorktreeStore(projectId);
    const slung = slingWorktree(
      worktrees,
      { parent: 'lead-7', branch: 'co/mcp-removed', repoCwd: repo, projectId },
      { probe: () => [] },
    );
    worktrees.removeWorktree('co/mcp-removed', {
      repoCwd: repo,
      gitExec: () => {},
      fs: {
        exists: () => true,
        isSymlink: () => false,
        realpath: (path) => path,
        removeDir: () => {},
      },
    });
    worktrees.close();

    process.env[CO_AGENT_ENV] = 'impl-1';
    process.env[CO_PROJECT_ID_ENV] = projectId;
    chdir(slung.worktreePath);

    expect(() => defaultContextFactory()).toThrow(/does not record cwd .* live slung worktree/i);
  });

  it('can mount from inside a real slung worktree when the mount supplies CO_PROJECT_ID', () => {
    useDataDir();
    const repo = makeMainRepo();
    const registry = openRegistry();
    const projectId = registry.register(repo);
    registry.close();

    const worktrees = openWorktreeStore(projectId);
    const slung = slingWorktree(
      worktrees,
      { parent: 'lead-7', branch: 'co/mcp-sandbox', repoCwd: repo, projectId },
      { probe: () => [] },
    );
    worktrees.close();

    process.env[CO_AGENT_ENV] = 'impl-1';
    process.env[CO_PROJECT_ID_ENV] = projectId;
    chdir(slung.worktreePath);

    const makeCtx = defaultContextFactory();
    const ctx = makeCtx();
    try {
      expect(ctx.agent).toBe('impl-1');
      expect(ctx.projectId).toBe(projectId);
      expect(ctx.cwd).toBe(slung.worktreePath);
      expect(ctx.worktrees?.getWorktree('co/mcp-sandbox')?.path).toBe(slung.worktreePath);
      expect(ctx.dispatch).toBeDefined();
      expect(typeof ctx.usageSourceFactory).toBe('function');
    } finally {
      ctx.mail.close();
      ctx.worktrees?.close();
      ctx.dispatch?.close();
      ctx.registry.close();
    }
  });
});
