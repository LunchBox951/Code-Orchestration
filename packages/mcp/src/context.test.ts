import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chdir, cwd } from 'node:process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCoreRegistry,
  invokeTool,
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
      expect(ctx.reviews).toBeDefined();
      expect(typeof ctx.usageSourceFactory).toBe('function');
    } finally {
      ctx.mail.close();
      ctx.worktrees?.close();
      ctx.dispatch?.close();
      ctx.reviews?.close();
      ctx.registry.close();
    }
  });
});

/**
 * These tests close the "listed-but-unwired" test gap: they INVOKE the gated verbs through
 * `defaultContextFactory` (not just name-list them). On the UNFIXED tree (reviews unwired),
 * every gated verb throws "review store absent". On the FIXED tree, the tools reach the domain
 * gate — proving the review store is properly injected.
 *
 * AC-L5-1 / AC-L5-6 / AC-L5-10: gated verbs must be callable (not throw "review store absent")
 * when the mount supplies the review store through `defaultContextFactory`.
 */
describe('defaultContextFactory — gated verbs reach domain gate (review store wired)', () => {
  function setupSlungProject(): {
    projectId: string;
    repo: string;
    worktreePath: string;
  } {
    useDataDir();
    const repo = makeMainRepo();
    const reg = openRegistry();
    const projectId = reg.register(repo);
    reg.close();
    const worktrees = openWorktreeStore(projectId);
    const slung = slingWorktree(
      worktrees,
      { parent: 'lead-gate', branch: 'co/gate-test', repoCwd: repo, projectId },
      { probe: () => [] },
    );
    worktrees.close();
    process.env[CO_AGENT_ENV] = 'reviewer-1';
    process.env[CO_PROJECT_ID_ENV] = projectId;
    chdir(slung.worktreePath);
    return { projectId, repo, worktreePath: slung.worktreePath };
  }

  it('co_review_finalize records a PASS verdict through the real mount (reviews injected, not absent)', async () => {
    setupSlungProject();
    const registry = buildCoreRegistry();
    const makeCtx = defaultContextFactory();
    const ctx = makeCtx();
    try {
      // On the UNFIXED tree this throws "co_review_finalize: the mount did not inject a review
      // store (ctx.reviews absent)". On the FIXED tree it records and returns the verdict.
      const result = await invokeTool(registry, ctx, 'co_review_finalize', {
        target: 'main',
        branch: 'co/gate-test',
        review_id: 'rev-wiring-1',
        verdict: 'PASS',
        blockers: [],
        suggestions: [],
        verification: {
          commands_run: ['pnpm test'],
          suite_result: 'pass',
          baseline_compared: true,
        },
      });
      const r = result as Record<string, unknown>;
      expect(r.verdict).toBe('PASS');
      expect(r.recorded).toBe(true);
      expect(r.review_id).toBe('rev-wiring-1');
    } finally {
      ctx.mail.close();
      ctx.worktrees?.close();
      ctx.dispatch?.close();
      ctx.reviews?.close();
      ctx.registry.close();
    }
  });

  it('co_merge reaches the domain gate (throws no-verdict, not review-store-absent)', async () => {
    setupSlungProject();
    const registry = buildCoreRegistry();
    const makeCtx = defaultContextFactory();
    const ctx = makeCtx();
    try {
      // On the UNFIXED tree: throws "review store absent".
      // On the FIXED tree: throws the domain gate error "no review verdict is recorded".
      await expect(
        invokeTool(registry, ctx, 'co_merge', {
          branch: 'co/gate-test',
          intent: { summary: 'test merge' },
        }),
      ).rejects.toThrow(/no review verdict is recorded/i);
    } finally {
      ctx.mail.close();
      ctx.worktrees?.close();
      ctx.dispatch?.close();
      ctx.reviews?.close();
      ctx.registry.close();
    }
  });

  it('co_push reaches the domain gate (throws no-verdict, not review-store-absent)', async () => {
    setupSlungProject();
    const registry = buildCoreRegistry();
    const makeCtx = defaultContextFactory();
    const ctx = makeCtx();
    try {
      // On the UNFIXED tree: throws "review store absent".
      // On the FIXED tree: throws the domain gate error "no review verdict is recorded".
      await expect(
        invokeTool(registry, ctx, 'co_push', {
          branch: 'co/gate-test',
        }),
      ).rejects.toThrow(/no review verdict is recorded/i);
    } finally {
      ctx.mail.close();
      ctx.worktrees?.close();
      ctx.dispatch?.close();
      ctx.reviews?.close();
      ctx.registry.close();
    }
  });

  it('co_pr_merge reaches the domain gate (throws no-verdict, not review-store-absent)', async () => {
    setupSlungProject();
    const registry = buildCoreRegistry();
    const makeCtx = defaultContextFactory();
    const ctx = makeCtx();
    try {
      // On the UNFIXED tree: throws "review store absent".
      // On the FIXED tree: throws the domain gate error "no review verdict is recorded".
      await expect(
        invokeTool(registry, ctx, 'co_pr_merge', {
          branch: 'co/gate-test',
          title: 'test pr',
          intent: {
            why: 'testing',
            what_changed: 'wiring fix',
            verification: 'pnpm test',
            conventions: 'follows monorepo patterns',
          },
        }),
      ).rejects.toThrow(/no review verdict is recorded/i);
    } finally {
      ctx.mail.close();
      ctx.worktrees?.close();
      ctx.dispatch?.close();
      ctx.reviews?.close();
      ctx.registry.close();
    }
  });
});
