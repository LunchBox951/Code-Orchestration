import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chdir, cwd } from 'node:process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCoreRegistry,
  invokeTool,
  openDispatchStore,
  openRegistry,
  openReviewStore,
  openRosterStore,
  openWorktreeStore,
  slingWorktree,
  toolsForRole,
  MAIL_WORKER_DONE,
  OPERATOR,
  type Role,
} from '@co/core';
import {
  CO_AGENT_ENV,
  CO_PARENT_ENV,
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
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'Test');
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

describe('toolsFromEnv — role-scoped tool-list from launch environment', () => {
  it('returns undefined when CO_ROLE is absent', () => {
    delete process.env[CO_ROLE_ENV];
    delete process.env[CO_PARENT_ENV];
    const result = toolsFromEnv();
    expect(result).toBeUndefined();
  });

  it('fails loud when CO_PARENT is set but CO_ROLE is absent', () => {
    delete process.env[CO_ROLE_ENV];
    process.env[CO_PARENT_ENV] = 'coord-1';
    expect(() => toolsFromEnv()).toThrow(/CO_PARENT.*CO_ROLE/i);
  });

  it('fails loud when a scoped project mount lacks CO_ROLE', () => {
    delete process.env[CO_ROLE_ENV];
    delete process.env[CO_PARENT_ENV];
    process.env[CO_PROJECT_ID_ENV] = 'p-scoped';
    expect(() => toolsFromEnv()).toThrow(/CO_PROJECT_ID.*CO_ROLE/i);
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

  it('validates a sub-role string and scopes the offered toolset to its base role', () => {
    process.env[CO_ROLE_ENV] = ' implementer:test ';
    const result = toolsFromEnv();
    const expected = toolsForRole('implementer');

    expect(result).toBeDefined();
    expect(result!.map((t) => t.name).sort()).toEqual(expected.map((t) => t.name).sort());
  });

  it('fails loud when CO_ROLE names an unknown or owner-tier sub-role', () => {
    process.env[CO_ROLE_ENV] = 'implementer:bogus';
    expect(() => toolsFromEnv()).toThrow(/unknown CO_ROLE sub-role/i);

    process.env[CO_ROLE_ENV] = 'lead:bogus';
    expect(() => toolsFromEnv()).toThrow(/unknown CO_ROLE sub-role/i);
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
  it('fails loud when a scoped mount omits CO_PARENT', () => {
    useDataDir();
    const repo = makeMainRepo();
    const registry = openRegistry();
    registry.register(repo);
    registry.close();

    process.env[CO_AGENT_ENV] = 'lead-1';
    process.env[CO_ROLE_ENV] = 'lead';
    chdir(repo);

    expect(() => defaultContextFactory()).toThrow(/CO_PARENT.*must supply/i);
  });

  it('fails loud when CO_PARENT is set without CO_ROLE', () => {
    useDataDir();
    const repo = makeMainRepo();
    const registry = openRegistry();
    registry.register(repo);
    registry.close();

    process.env[CO_AGENT_ENV] = 'lead-1';
    process.env[CO_PARENT_ENV] = 'coord-1';
    chdir(repo);

    expect(() => defaultContextFactory()).toThrow(/CO_PARENT.*CO_ROLE/i);
  });

  it('fails loud when a registered project mount omits CO_ROLE', () => {
    useDataDir();
    const repo = makeMainRepo();
    const registry = openRegistry();
    registry.register(repo);
    registry.close();

    process.env[CO_AGENT_ENV] = 'lead-1';
    chdir(repo);

    expect(() => defaultContextFactory()).toThrow(
      /registered project.*CO_ROLE|CO_ROLE.*registered/i,
    );
  });

  it('trims CO_AGENT before context and roster registration', () => {
    useDataDir();
    const repo = makeMainRepo();
    const registry = openRegistry();
    registry.register(repo);
    registry.close();

    process.env[CO_AGENT_ENV] = '  coord-1  ';
    process.env[CO_ROLE_ENV] = 'coordinator';
    process.env[CO_PARENT_ENV] = '@operator';
    chdir(repo);

    const ctx = defaultContextFactory()();
    try {
      expect(ctx.agent).toBe('coord-1');
      expect(ctx.roster?.getAgent('coord-1')?.role).toBe('coordinator');
      expect(ctx.roster?.getAgent('  coord-1  ')).toBeUndefined();
    } finally {
      ctx.mail.close();
      ctx.worktrees?.close();
      ctx.dispatch?.close();
      ctx.reviews?.close();
      ctx.roster?.close();
      ctx.registry.close();
    }
  });

  it('rejects whitespace-only CO_AGENT', () => {
    useDataDir();
    const repo = makeMainRepo();
    const registry = openRegistry();
    registry.register(repo);
    registry.close();

    process.env[CO_AGENT_ENV] = '   ';
    chdir(repo);

    expect(() => defaultContextFactory()).toThrow(/CO_AGENT.*not set/i);
  });

  it('registers scoped mounts in the roster from CO_AGENT, CO_ROLE, and CO_PARENT', () => {
    useDataDir();
    const repo = makeMainRepo();
    const registry = openRegistry();
    registry.register(repo);
    registry.close();
    chdir(repo);

    process.env[CO_AGENT_ENV] = 'coord-1';
    process.env[CO_ROLE_ENV] = 'coordinator';
    process.env[CO_PARENT_ENV] = '@operator';
    const coordCtx = defaultContextFactory()();
    try {
      expect(coordCtx.roster?.getAgent('coord-1')?.role).toBe('coordinator');
    } finally {
      coordCtx.mail.close();
      coordCtx.worktrees?.close();
      coordCtx.dispatch?.close();
      coordCtx.reviews?.close();
      coordCtx.roster?.close();
      coordCtx.registry.close();
    }

    process.env[CO_AGENT_ENV] = 'lead-1';
    process.env[CO_ROLE_ENV] = 'lead';
    process.env[CO_PARENT_ENV] = 'coord-1';
    const leadCtx = defaultContextFactory()();
    try {
      expect(leadCtx.roster?.getAgent('lead-1')?.parent).toBe('coord-1');
    } finally {
      leadCtx.mail.close();
      leadCtx.worktrees?.close();
      leadCtx.dispatch?.close();
      leadCtx.reviews?.close();
      leadCtx.roster?.close();
      leadCtx.registry.close();
    }
  });

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

  it('rejected scoped CO_PROJECT_ID mounts leave no roster registration behind', () => {
    useDataDir();
    const repo = makeMainRepo();
    const registry = openRegistry();
    const projectId = registry.register(repo);
    registry.close();

    const stranger = mkdtempSync(join(tmpdir(), 'co-mcp-context-stranger-'));
    tmpDirs.push(stranger);
    process.env[CO_AGENT_ENV] = 'coord-bad';
    process.env[CO_ROLE_ENV] = 'coordinator';
    process.env[CO_PARENT_ENV] = '@operator';
    process.env[CO_PROJECT_ID_ENV] = projectId;
    chdir(stranger);

    expect(() => defaultContextFactory()).toThrow(/does not record cwd .* live slung worktree/i);

    const roster = openRosterStore(projectId);
    try {
      expect(roster.getAgent('coord-bad')).toBeUndefined();
    } finally {
      roster.close();
    }
  });

  it('rejects a scoped sandbox mount whose CO_PARENT disagrees with the recorded worktree parent', () => {
    useDataDir();
    const repo = makeMainRepo();
    const registry = openRegistry();
    const projectId = registry.register(repo);
    registry.close();

    const worktrees = openWorktreeStore(projectId);
    const slung = slingWorktree(
      worktrees,
      {
        parent: 'lead-7',
        agent: 'impl-1',
        branch: 'co/mcp-parent-check',
        repoCwd: repo,
        projectId,
      },
      { probe: () => [] },
    );
    worktrees.close();

    process.env[CO_AGENT_ENV] = 'impl-1';
    process.env[CO_ROLE_ENV] = 'implementer';
    process.env[CO_PARENT_ENV] = 'lead-wrong';
    process.env[CO_PROJECT_ID_ENV] = projectId;
    chdir(slung.worktreePath);

    expect(() => defaultContextFactory()).toThrow(/CO_PARENT.*recorded worktree parent/i);

    const roster = openRosterStore(projectId);
    try {
      expect(roster.getAgent('impl-1')).toBeUndefined();
    } finally {
      roster.close();
    }
  });

  it('rejects a scoped sandbox mount whose CO_ROLE disagrees with the recorded worktree role', () => {
    useDataDir();
    const repo = makeMainRepo();
    const registry = openRegistry();
    const projectId = registry.register(repo);
    registry.close();

    const worktrees = openWorktreeStore(projectId);
    const slung = slingWorktree(
      worktrees,
      {
        parent: 'lead-7',
        branch: 'co/mcp-role-check',
        repoCwd: repo,
        projectId,
        agent: 'impl-1',
        role: 'reviewer',
        subRole: 'pr',
      } as Parameters<typeof slingWorktree>[1] & {
        readonly role: 'reviewer';
        readonly subRole: 'pr';
      },
      { probe: () => [] },
    );
    worktrees.close();

    process.env[CO_AGENT_ENV] = 'impl-1';
    process.env[CO_ROLE_ENV] = 'implementer';
    process.env[CO_PARENT_ENV] = 'lead-7';
    process.env[CO_PROJECT_ID_ENV] = projectId;
    chdir(slung.worktreePath);

    expect(() => defaultContextFactory()).toThrow(/CO_ROLE.*recorded worktree role/i);

    const roster = openRosterStore(projectId);
    try {
      expect(roster.getAgent('impl-1')).toBeUndefined();
    } finally {
      roster.close();
    }
  });

  it('rejects a scoped sandbox mount whose worktree lacks recorded agent metadata', () => {
    useDataDir();
    const repo = makeMainRepo();
    const registry = openRegistry();
    const projectId = registry.register(repo);
    registry.close();

    const worktrees = openWorktreeStore(projectId);
    const slung = slingWorktree(
      worktrees,
      {
        parent: 'lead-7',
        branch: 'co/mcp-missing-agent',
        repoCwd: repo,
        projectId,
        role: 'implementer',
      } as Parameters<typeof slingWorktree>[1] & { readonly role: 'implementer' },
      { probe: () => [] },
    );
    worktrees.close();

    process.env[CO_AGENT_ENV] = 'impl-1';
    process.env[CO_ROLE_ENV] = 'implementer';
    process.env[CO_PARENT_ENV] = 'lead-7';
    process.env[CO_PROJECT_ID_ENV] = projectId;
    chdir(slung.worktreePath);

    expect(() => defaultContextFactory()).toThrow(/recorded worktree agent/i);

    const roster = openRosterStore(projectId);
    try {
      expect(roster.getAgent('impl-1')).toBeUndefined();
    } finally {
      roster.close();
    }
  });

  it('rejects a scoped sandbox mount whose CO_AGENT differs from the recorded worktree agent', () => {
    useDataDir();
    const repo = makeMainRepo();
    const registry = openRegistry();
    const projectId = registry.register(repo);
    registry.close();

    const worktrees = openWorktreeStore(projectId);
    const slung = slingWorktree(
      worktrees,
      {
        parent: 'lead-7',
        agent: 'impl-owner',
        branch: 'co/mcp-agent-check',
        repoCwd: repo,
        projectId,
        role: 'implementer',
      } as Parameters<typeof slingWorktree>[1] & { readonly role: 'implementer' },
      { probe: () => [] },
    );
    worktrees.close();

    process.env[CO_AGENT_ENV] = 'impl-sibling';
    process.env[CO_ROLE_ENV] = 'implementer';
    process.env[CO_PARENT_ENV] = 'lead-7';
    process.env[CO_PROJECT_ID_ENV] = projectId;
    chdir(slung.worktreePath);

    expect(() => defaultContextFactory()).toThrow(/CO_AGENT.*recorded worktree agent/i);

    const roster = openRosterStore(projectId);
    try {
      expect(roster.getAgent('impl-sibling')).toBeUndefined();
    } finally {
      roster.close();
    }
  });

  it('rejects a scoped sandbox mount whose worktree lacks recorded role metadata', () => {
    useDataDir();
    const repo = makeMainRepo();
    const registry = openRegistry();
    const projectId = registry.register(repo);
    registry.close();

    const worktrees = openWorktreeStore(projectId);
    const slung = slingWorktree(
      worktrees,
      {
        parent: 'lead-7',
        agent: 'impl-1',
        branch: 'co/mcp-missing-role',
        repoCwd: repo,
        projectId,
      },
      { probe: () => [] },
    );
    worktrees.close();
    const seededRoster = openRosterStore(projectId);
    seededRoster.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
    seededRoster.recordAgent({ agentId: 'lead-7', role: 'lead', parent: 'coord-1' });
    seededRoster.close();

    process.env[CO_AGENT_ENV] = 'impl-1';
    process.env[CO_ROLE_ENV] = 'implementer';
    process.env[CO_PARENT_ENV] = 'lead-7';
    process.env[CO_PROJECT_ID_ENV] = projectId;
    chdir(slung.worktreePath);

    expect(() => defaultContextFactory()).toThrow(/recorded worktree role/i);

    const roster = openRosterStore(projectId);
    try {
      expect(roster.getAgent('impl-1')).toBeUndefined();
    } finally {
      roster.close();
    }
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
      {
        parent: 'lead-7',
        agent: 'impl-1',
        branch: 'co/mcp-sandbox',
        repoCwd: repo,
        projectId,
        role: 'implementer',
      } as Parameters<typeof slingWorktree>[1] & { readonly role: 'implementer' },
      { probe: () => [] },
    );
    worktrees.close();
    const roster = openRosterStore(projectId);
    roster.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
    roster.recordAgent({ agentId: 'lead-7', role: 'lead', parent: 'coord-1' });
    roster.close();

    process.env[CO_AGENT_ENV] = 'impl-1';
    process.env[CO_PROJECT_ID_ENV] = projectId;
    process.env[CO_ROLE_ENV] = 'implementer';
    process.env[CO_PARENT_ENV] = 'lead-7';
    chdir(slung.worktreePath);

    const makeCtx = defaultContextFactory();
    const ctx = makeCtx();
    try {
      expect(ctx.agent).toBe('impl-1');
      expect(ctx.projectId).toBe(projectId);
      expect(ctx.cwd).toBe(slung.worktreePath);
      expect(ctx.worktrees?.getWorktree('co/mcp-sandbox')?.path).toBe(slung.worktreePath);
      expect(ctx.roster?.getAgent('impl-1')?.parent).toBe('lead-7');
      expect(ctx.dispatch).toBeDefined();
      expect(ctx.reviews).toBeDefined();
      expect(ctx.roster).toBeDefined();
      expect(typeof ctx.usageSourceFactory).toBe('function');
    } finally {
      ctx.mail.close();
      ctx.worktrees?.close();
      ctx.dispatch?.close();
      ctx.reviews?.close();
      ctx.roster?.close();
      ctx.registry.close();
    }
  });

  it('rejects a slung CO_PROJECT_ID mount without role and parent scope', () => {
    useDataDir();
    const repo = makeMainRepo();
    const registry = openRegistry();
    const projectId = registry.register(repo);
    registry.close();

    const worktrees = openWorktreeStore(projectId);
    const slung = slingWorktree(
      worktrees,
      { parent: 'lead-7', agent: 'impl-1', branch: 'co/mcp-unscoped', repoCwd: repo, projectId },
      { probe: () => [] },
    );
    worktrees.close();

    process.env[CO_AGENT_ENV] = 'impl-1';
    process.env[CO_PROJECT_ID_ENV] = projectId;
    chdir(slung.worktreePath);

    expect(() => defaultContextFactory()).toThrow(/CO_PROJECT_ID.*CO_ROLE/i);
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
  function setupSlungProject(
    agent = 'reviewer-1',
    parent = 'lead-gate',
  ): {
    projectId: string;
    repo: string;
    worktreePath: string;
  } {
    useDataDir();
    const repo = makeMainRepo();
    const reg = openRegistry();
    const projectId = reg.register(repo);
    reg.close();
    const roster = openRosterStore(projectId);
    roster.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
    if (parent !== 'coord-1') {
      roster.recordAgent({ agentId: parent, role: 'lead', parent: 'coord-1' });
    }
    const role = agent === parent ? 'lead' : agent.startsWith('impl-') ? 'implementer' : 'reviewer';
    if (agent !== parent && agent !== 'coord-1') {
      roster.recordAgent({ agentId: agent, role, parent });
    }
    roster.close();
    const worktrees = openWorktreeStore(projectId);
    const slung = slingWorktree(
      worktrees,
      { parent, agent, branch: 'co/gate-test', repoCwd: repo, projectId, role } as Parameters<
        typeof slingWorktree
      >[1] & { readonly role: 'lead' | 'implementer' | 'reviewer' },
      { probe: () => [] },
    );
    worktrees.close();
    process.env[CO_AGENT_ENV] = agent;
    process.env[CO_PROJECT_ID_ENV] = projectId;
    if (agent === parent) {
      process.env[CO_ROLE_ENV] = 'lead';
      process.env[CO_PARENT_ENV] = 'coord-1';
    } else {
      process.env[CO_ROLE_ENV] = role;
      process.env[CO_PARENT_ENV] = parent;
    }
    chdir(slung.worktreePath);
    return { projectId, repo, worktreePath: slung.worktreePath };
  }

  it('co_review_finalize records a PASS verdict through the real mount (reviews injected, not absent)', async () => {
    const { projectId } = setupSlungProject('reviewer@rev-wiring-1');
    const seededReviews = openReviewStore(projectId);
    seededReviews.recordReviewRequested({
      reviewId: 'rev-wiring-1',
      target: 'main',
      branch: 'co/gate-test',
      scope: 'worker_merge',
      requestedBy: 'lead-gate',
      specRefKind: 'no-locked-spec',
    });
    seededReviews.close();
    const seededDispatch = openDispatchStore(projectId);
    seededDispatch.recordPlacement('reviewer@rev-wiring-1', {
      kind: 'placed',
      role: 'reviewer',
      work_size: 'technical',
      reasoning_budget: 'standard',
      provider: 'codex',
      account: 'codex:max',
      model: 'gpt-5-codex',
      effort: 'high',
      context: 'extended',
    });
    seededDispatch.close();
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
      ctx.roster?.close();
      ctx.registry.close();
    }
  });

  it('co_merge reaches the domain gate (throws no-verdict, not review-store-absent)', async () => {
    const { repo } = setupSlungProject('lead-gate');
    chdir(repo);
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
      ctx.roster?.close();
      ctx.registry.close();
    }
  });

  it('co_push reaches the domain gate (throws no-verdict, not review-store-absent)', async () => {
    const { repo } = setupSlungProject('lead-gate');
    chdir(repo);
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
      ctx.roster?.close();
      ctx.registry.close();
    }
  });

  it('co_pr_merge reaches the domain gate (throws no-verdict, not review-store-absent)', async () => {
    const { repo } = setupSlungProject('lead-gate');
    chdir(repo);
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
      ctx.roster?.close();
      ctx.registry.close();
    }
  });

  it('@operator mounts a registered project without CO_ROLE and reaches override-capable tools', async () => {
    useDataDir();
    const repo = makeMainRepo();
    const registryStore = openRegistry();
    const projectId = registryStore.register(repo);
    registryStore.close();

    process.env[CO_AGENT_ENV] = OPERATOR;
    chdir(repo);

    const offered = toolsFromEnv();
    expect(offered?.map((tool) => tool.name).sort()).toEqual(
      ['co_merge', 'co_pr_merge', 'co_push', 'co_spec_lock'].sort(),
    );

    const registry = buildCoreRegistry();
    const ctx = defaultContextFactory()();
    try {
      expect(ctx.agent).toBe(OPERATOR);
      expect(ctx.projectId).toBe(projectId);
      expect(ctx.roster?.getAgent(OPERATOR)).toBeUndefined();

      await expect(
        invokeTool(registry, ctx, 'co_merge', {
          branch: 'co/operator-missing-worktree',
          intent: { summary: 'operator override smoke' },
          operator_override: true,
          reason: 'operator smoke',
        }),
      ).rejects.toThrow(/no live worktree record|worktree record/i);

      await expect(
        invokeTool(registry, ctx, 'co_push', {
          branch: 'co/operator-missing-worktree',
          operator_override: true,
          reason: 'operator smoke',
        }),
      ).rejects.toThrow(/no worktree record/i);

      await expect(
        invokeTool(registry, ctx, 'co_pr_merge', {
          branch: 'co/operator-missing-worktree',
          title: 'operator smoke',
          intent: {
            why: 'operator override smoke',
            what_changed: 'none',
            verification: 'not run',
            conventions: 'not applicable',
          },
          operator_override: true,
          reason: 'operator smoke',
        }),
      ).rejects.toThrow(/no live worktree record/i);
    } finally {
      ctx.mail.close();
      ctx.worktrees?.close();
      ctx.dispatch?.close();
      ctx.reviews?.close();
      ctx.roster?.close();
      ctx.registry.close();
    }
  });

  it('co_kickback sends mail through the real mount (roster injected, not absent)', async () => {
    const { repo } = setupSlungProject('impl-1', 'lead-1');
    chdir(repo);
    const mountAndClose = (agent: string, role: string, parent: string): void => {
      process.env[CO_AGENT_ENV] = agent;
      process.env[CO_ROLE_ENV] = role;
      process.env[CO_PARENT_ENV] = parent;
      const mounted = defaultContextFactory()();
      mounted.mail.close();
      mounted.worktrees?.close();
      mounted.dispatch?.close();
      mounted.reviews?.close();
      mounted.roster?.close();
      mounted.registry.close();
    };
    mountAndClose('coord-1', 'coordinator', '@operator');
    mountAndClose('lead-1', 'lead', 'coord-1');
    mountAndClose('impl-1', 'implementer', 'lead-1');

    process.env[CO_AGENT_ENV] = 'lead-1';
    process.env[CO_ROLE_ENV] = 'lead';
    process.env[CO_PARENT_ENV] = 'coord-1';
    const registry = buildCoreRegistry();
    const makeCtx = defaultContextFactory();
    const ctx = makeCtx();
    try {
      ctx.mail.send({
        type: MAIL_WORKER_DONE,
        to: 'lead-1',
        from: 'impl-1',
        subject: 'worker_done: co/gate-test',
        body: 'done',
      });
      ctx.worktrees!.recordFinish({
        branch: 'co/gate-test',
        baseSha: 'a'.repeat(40),
        commitSha: 'b'.repeat(40),
        tests: [],
        agent: 'impl-1',
      });
      ctx.reviews!.recordVerdict({
        reviewId: 'rev-kickback-wiring',
        target: 'main',
        branch: 'co/gate-test',
        reviewer: 'reviewer-1',
        verdict: 'ISSUES',
        blockers: [{ summary: 'review found a blocker' }],
        suggestions: [],
      });

      const result = (await invokeTool(registry, ctx, 'co_kickback', {
        branch: 'co/gate-test',
        worker: 'impl-1',
        blockers: ['review found a blocker'],
        into: 'main',
      })) as Record<string, unknown>;

      expect(result.action).toBe('kickback');
      expect(result.kicked_back).toBe(true);
      expect(ctx.mail.inbox('impl-1').some((m) => m.subject === 'kickback: co/gate-test')).toBe(
        true,
      );
    } finally {
      ctx.mail.close();
      ctx.worktrees?.close();
      ctx.dispatch?.close();
      ctx.reviews?.close();
      ctx.roster?.close();
      ctx.registry.close();
    }
  });
});
