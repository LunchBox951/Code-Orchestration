import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMailStore, type MailStore } from '../../mail/mail-store.js';
import { openRegistry, type ProjectRegistry } from '../../registry/registry.js';
import { openWorktreeStore, type WorktreeStore } from '../../worktrees/worktree-store.js';
import { openDispatchStore, type DispatchStore } from '../../dispatch/dispatch-store.js';
import { openRosterStore, type RosterStore } from '../../roles/roster-store.js';
import { accountForProvider } from '../../dispatch/provider-source.js';
import {
  FakeUsageSource,
  UsageUnavailableError,
  type UsageSnapshot,
} from '../../dispatch/usage-source.js';
import { buildCoreRegistry } from '../core-registry.js';
import { invokeTool } from '../invoke.js';
import type { ToolContext } from '../context.js';
import { slingTool } from './sling.js';
import type { ReviewerSpawnGate } from '../../review/merge.js';

// AC-L3-1, headless through invokeTool (no MCP server, no Conductor): co_sling slings from the
// auto-detected base, records the sandbox + a readable baseline, requires an explicit parent and a
// co/ branch, and loud-fails when the mount did not inject the worktree store.

const ORIGINAL_ENV = process.env;
let tmpDirs: string[] = [];
let mails: MailStore[] = [];
let worktreeStores: WorktreeStore[] = [];
let dispatchStores: DispatchStore[] = [];
let rosterStores: RosterStore[] = [];
let regs: ProjectRegistry[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  tmpDirs = [];
  mails = [];
  worktreeStores = [];
  dispatchStores = [];
  rosterStores = [];
  regs = [];
  const data = mkdtempSync(join(tmpdir(), 'co-sling-tool-data-'));
  tmpDirs.push(data);
  process.env.CO_DATA_DIR = data;
});

afterEach(() => {
  for (const m of mails) m.close();
  for (const w of worktreeStores) w.close();
  for (const d of dispatchStores) d.close();
  for (const r of rosterStores) r.close();
  for (const r of regs) r.close();
  process.env = ORIGINAL_ENV;
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
  mails = [];
  worktreeStores = [];
  dispatchStores = [];
  rosterStores = [];
  regs = [];
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
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim();
}

function makeMainRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-sling-tool-repo-'));
  tmpDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'init');
  return dir;
}

/** A real headless ToolContext over `repo`, with the worktree store injected (unless omitted). */
function makeContext(
  agent: string,
  repo: string,
  opts: {
    withWorktrees?: boolean;
    registerCaller?: boolean;
    role?: 'coordinator' | 'lead' | 'implementer';
  } = {},
): ToolContext {
  const registry = openRegistry();
  regs.push(registry);
  const projectId = registry.register(repo);
  const mail = openMailStore(projectId);
  mails.push(mail);
  if (opts.withWorktrees === false) {
    return { agent, projectId, cwd: repo, mail, registry };
  }
  const worktrees = openWorktreeStore(projectId);
  worktreeStores.push(worktrees);
  const roster = openRosterStore(projectId);
  rosterStores.push(roster);
  if (opts.registerCaller !== false) {
    if (opts.role !== 'coordinator' && agent !== 'coord-1') {
      roster.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
    }
    roster.recordAgent({
      agentId: agent,
      role: opts.role ?? 'lead',
      parent: opts.role === 'coordinator' ? '@operator' : 'coord-1',
    });
  }
  return { agent, projectId, cwd: repo, mail, registry, worktrees, roster };
}

describe('co_sling — via invokeTool', () => {
  it('slings from auto-detected main, returns worktree facts, and records placement with default routing', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, {
      provider: 'claude',
      account: accountForProvider('claude'),
      available: true,
      source: 'fake',
      sampled_at: new Date().toISOString(),
      windows: [
        {
          kind: 'five_hour',
          used_pct: 20,
          reset_at: new Date(Date.now() + 5 * 3600_000).toISOString(),
        },
      ],
    });
    const reg = buildCoreRegistry();
    const headSha = git(repo, 'rev-parse', 'HEAD');

    const out = (await invokeTool(reg, ctx, 'co_sling', {
      parent: 'lead-7',
      agent: 'impl-1',
      branch: 'co/feature',
    })) as {
      status: 'placed';
      branch: string;
      base_ref: string;
      base_sha: string;
      worktree_path: string;
      baseline_captured: boolean;
      placement: { provider: string };
    };

    expect(out.status).toBe('placed');
    expect(out.branch).toBe('co/feature');
    expect(out.base_ref).toBe('main'); // auto-detected — NOT master
    expect(out.base_sha).toBe(headSha);
    expect(out.baseline_captured).toBe(true);
    expect(out.worktree_path).toContain(ctx.projectId);
    expect(out.worktree_path).toContain('co/feature');
    expect(out.placement.provider).toBe('claude');

    // Recorded per project + branch, with the explicit parent (no @operator default).
    expect(ctx.worktrees?.getWorktree('co/feature')).toMatchObject({
      parent: 'lead-7',
      agent: 'impl-1',
      role: 'implementer',
    });
    expect(ctx.worktrees?.getBaseline('co/feature')).toBeDefined();
    expect(ctx.dispatch?.readPlacements('lead-7')).toHaveLength(1);
  });

  it('rejects a branch that does not start with co/ (input schema)', async () => {
    const repo = makeMainRepo();
    const ctx = makeContext('lead-7', repo);
    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_sling', {
        parent: 'lead-7',
        agent: 'impl-1',
        branch: 'feature',
      }),
    ).rejects.toThrow(/input failed schema validation/i);
  });

  it('requires an explicit parent — there is NO @operator default (input schema)', async () => {
    const repo = makeMainRepo();
    const ctx = makeContext('lead-7', repo);
    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_sling', { branch: 'co/x' }),
    ).rejects.toThrow(/input failed schema validation/i);
  });

  it('requires an assigned child agent before creating a mountable sandbox', async () => {
    const repo = makeMainRepo();
    const ctx = makeContext('lead-7', repo);
    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_sling', { parent: 'lead-7', branch: 'co/x' }),
    ).rejects.toThrow(/input failed schema validation/i);
  });

  it('rejects a parent that does not match the mounted caller before creating a worktree', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_sling', {
        parent: 'other-lead',
        agent: 'impl-1',
        branch: 'co/wrong-parent',
      }),
    ).rejects.toThrow(/parent.*mounted caller/i);

    expect(ctx.worktrees?.getWorktree('co/wrong-parent')).toBeUndefined();
    expect(ctx.worktrees?.getBaseline('co/wrong-parent')).toBeUndefined();
    expect(() => git(repo, 'rev-parse', '--verify', 'co/wrong-parent')).toThrow();
  });

  it('rejects an unregistered caller before creating a worktree', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, healthySnapshot, {
      registerCaller: false,
    });
    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_sling', {
        parent: 'lead-7',
        agent: 'impl-1',
        branch: 'co/unregistered-caller',
      }),
    ).rejects.toThrow(/not registered in the roster/i);

    expect(ctx.worktrees?.getWorktree('co/unregistered-caller')).toBeUndefined();
    expect(ctx.worktrees?.getBaseline('co/unregistered-caller')).toBeUndefined();
    expect(() => git(repo, 'rev-parse', '--verify', 'co/unregistered-caller')).toThrow();
  });

  it('rejects unknown and illegal child roles before dispatch or worktree creation', async () => {
    const repo = makeMainRepo();
    const unknownCtx = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    await expect(
      invokeTool(buildCoreRegistry(), unknownCtx, 'co_sling', {
        parent: 'lead-7',
        agent: 'impl-1',
        branch: 'co/unknown-role',
        role: 'wizard',
      }),
    ).rejects.toThrow(/unknown role/i);
    expect(unknownCtx.dispatch?.readPlacements('lead-7')).toHaveLength(0);
    expect(unknownCtx.worktrees?.getWorktree('co/unknown-role')).toBeUndefined();

    const illegalCtx = makeContextWithDispatch('lead-8', repo, healthySnapshot);
    await expect(
      invokeTool(buildCoreRegistry(), illegalCtx, 'co_sling', {
        parent: 'lead-8',
        agent: 'lead-child-1',
        branch: 'co/lead-child',
        role: 'lead',
      }),
    ).rejects.toThrow(/lead never spawns a lead/i);
    expect(illegalCtx.dispatch?.readPlacements('lead-8')).toHaveLength(0);
    expect(illegalCtx.worktrees?.getWorktree('co/lead-child')).toBeUndefined();
  });

  it('loud-fails when the mount did not inject a worktree store (Principle 9)', async () => {
    const repo = makeMainRepo();
    const ctx = makeContext('lead-7', repo, { withWorktrees: false });
    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_sling', {
        parent: 'lead-7',
        agent: 'impl-1',
        branch: 'co/x',
      }),
    ).rejects.toThrow(/did not inject a worktree store/i);
  });
});

// ── Phase 5 routing tests ───────────────────────────────────────────────────────────────────────

const healthySnapshot: UsageSnapshot = {
  provider: 'claude',
  account: accountForProvider('claude'),
  available: true,
  source: 'fake',
  sampled_at: new Date().toISOString(),
  windows: [
    {
      kind: 'five_hour',
      used_pct: 20,
      reset_at: new Date(Date.now() + 5 * 3600_000).toISOString(),
    },
  ],
};

const maxedSnapshot: UsageSnapshot = {
  provider: 'claude',
  account: accountForProvider('claude'),
  available: true,
  source: 'fake',
  sampled_at: new Date().toISOString(),
  windows: [
    {
      kind: 'five_hour',
      used_pct: 99,
      reset_at: new Date(Date.now() + 5 * 3600_000).toISOString(),
    },
  ],
};

function makeContextWithDispatch(
  agent: string,
  repo: string,
  snapshots: UsageSnapshot | readonly UsageSnapshot[],
  opts: { registerCaller?: boolean; role?: 'coordinator' | 'lead' | 'implementer' } = {},
): ToolContext {
  const registry = openRegistry();
  regs.push(registry);
  const projectId = registry.register(repo);
  const mail = openMailStore(projectId);
  mails.push(mail);
  const worktrees = openWorktreeStore(projectId);
  worktreeStores.push(worktrees);
  const dispatch = openDispatchStore(projectId);
  dispatchStores.push(dispatch);
  const roster = openRosterStore(projectId);
  rosterStores.push(roster);
  if (opts.registerCaller !== false) {
    if (opts.role !== 'coordinator' && agent !== 'coord-1') {
      roster.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
    }
    roster.recordAgent({
      agentId: agent,
      role: opts.role ?? 'lead',
      parent: opts.role === 'coordinator' ? '@operator' : 'coord-1',
    });
  }
  for (const snapshot of Array.isArray(snapshots) ? snapshots : [snapshots]) {
    dispatch.recordSnapshot(snapshot);
  }
  return { agent, projectId, cwd: repo, mail, registry, worktrees, dispatch, roster };
}

describe('co_sling — with routing inputs (Phase 5 dispatch integration)', () => {
  it('placed: records placement.decided and returns placement in output; creates sandbox', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    const reg = buildCoreRegistry();

    const out = (await invokeTool(reg, ctx, 'co_sling', {
      parent: 'lead-7',
      agent: 'impl-1',
      branch: 'co/routed-placed',
      role: 'implementer',
      work_size: 'average',
      reasoning_budget: 'standard',
    })) as Record<string, unknown>;

    // Worktree was created
    expect(out['status']).toBe('placed');
    expect(out['branch']).toBe('co/routed-placed');
    expect(out['worktree_path']).toBeTruthy();

    // Placement returned in output
    expect(out['placement']).toBeDefined();
    const pl = out['placement'] as Record<string, unknown>;
    expect(pl['provider']).toBe('claude');
    expect(pl['account']).toBeUndefined();
    expect(typeof pl['model']).toBe('string');
    expect(typeof pl['effort']).toBe('string');

    // placement.decided recorded in the dispatch store
    const placements = ctx.dispatch!.readPlacements('lead-7');
    expect(placements).toHaveLength(1);
    expect(placements[0]!.kind).toBe('placed');
    expect(placements[0]!.role).toBe('implementer');

    // No WAITING in output
    expect(out['waiting']).toBeUndefined();
  });

  it('canonicalizes child role strings before dispatch placement recording', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    const reg = buildCoreRegistry();

    await invokeTool(reg, ctx, 'co_sling', {
      parent: 'lead-7',
      agent: 'reviewer-1',
      branch: 'co/canonical-role',
      role: ' Reviewer:PR ',
      work_size: 'average',
      reasoning_budget: 'standard',
    });

    const placements = ctx.dispatch!.readPlacements('lead-7');
    expect(placements).toHaveLength(1);
    expect(placements[0]!.role).toBe('reviewer:pr');
    expect(ctx.worktrees!.getWorktree('co/canonical-role')).toMatchObject({
      role: 'reviewer',
      subRole: 'pr',
    });
  });

  it('lets an implementer sling a researcher child, matching spawn rules and role profile', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('impl-1', repo, healthySnapshot, { role: 'implementer' });
    const reg = buildCoreRegistry();

    const out = (await invokeTool(reg, ctx, 'co_sling', {
      parent: 'impl-1',
      agent: 'researcher-1',
      branch: 'co/research-child',
      role: 'researcher',
    })) as Record<string, unknown>;

    expect(out['status']).toBe('placed');
    expect(ctx.dispatch!.readPlacements('impl-1')[0]?.role).toBe('researcher');
  });

  it('waiting: records placement.decided(waiting) and returns loud message; does NOT create sandbox', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, maxedSnapshot);
    const reg = buildCoreRegistry();

    const out = (await invokeTool(reg, ctx, 'co_sling', {
      parent: 'lead-7',
      agent: 'impl-1',
      branch: 'co/routed-waiting',
      role: 'implementer',
      work_size: 'average',
      reasoning_budget: 'standard',
    })) as Record<string, unknown>;

    // WAITING result
    expect(out['status']).toBe('waiting');
    expect(out['waiting']).toBeDefined();
    const w = out['waiting'] as Record<string, unknown>;
    expect(typeof w['message']).toBe('string');
    expect((w['message'] as string).length).toBeGreaterThan(0);
    expect(w['maxed_accounts']).toBeUndefined();

    // No sandbox created (branch/worktree_path absent)
    expect(out['branch']).toBeUndefined();
    expect(out['worktree_path']).toBeUndefined();
    expect(ctx.worktrees?.getWorktree('co/routed-waiting')).toBeUndefined();

    // placement.decided(waiting) recorded
    const placements = ctx.dispatch!.readPlacements('lead-7');
    expect(placements).toHaveLength(1);
    expect(placements[0]!.kind).toBe('waiting');
    expect(placements[0]!.maxedAccounts).toEqual([accountForProvider('claude')]);
  });

  it('routing inputs absent: uses default provider accounts and records placement', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    const reg = buildCoreRegistry();
    const headSha = git(repo, 'rev-parse', 'HEAD');

    const out = (await invokeTool(reg, ctx, 'co_sling', {
      parent: 'lead-7',
      agent: 'impl-1',
      branch: 'co/no-routing',
    })) as Record<string, unknown>;

    expect(out['status']).toBe('placed');
    expect(out['branch']).toBe('co/no-routing');
    expect(out['base_sha']).toBe(headSha);
    expect(out['placement']).toBeDefined();
    expect(out['waiting']).toBeUndefined();
    const placements = ctx.dispatch!.readPlacements('lead-7');
    expect(placements).toHaveLength(1);
    expect(placements[0]!.kind).toBe('placed');
  });

  it('rejects caller-supplied accounts; provider accounts are host policy, not agent-facing input', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, healthySnapshot);

    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_sling', {
        parent: 'lead-7',
        agent: 'impl-1',
        branch: 'co/accounts-only',
        accounts: [{ provider: 'codex', account: accountForProvider('codex') }],
      }),
    ).rejects.toThrow(/input failed schema validation/i);

    expect(ctx.dispatch!.readPlacements('lead-7')).toHaveLength(0);
  });

  it('placed output omits non-blocking usage-source diagnostics from the agent-facing response', async () => {
    const repo = makeMainRepo();
    const ctx = {
      ...makeContextWithDispatch('lead-7', repo, healthySnapshot),
      usageSourceFactory: () =>
        new FakeUsageSource({
          errors: {
            codex: new UsageUnavailableError('codex', 'codex logs missing', {
              account: accountForProvider('codex'),
            }),
          },
        }),
    };

    const out = (await invokeTool(buildCoreRegistry(), ctx, 'co_sling', {
      parent: 'lead-7',
      agent: 'impl-1',
      branch: 'co/diagnostic-placed',
    })) as Record<string, unknown>;

    expect(out['status']).toBe('placed');
    expect(out['diagnostics']).toBeUndefined();
  });

  it('waiting output carries sanitized usage-source diagnostics without account labels', async () => {
    const repo = makeMainRepo();
    const ctx = {
      ...makeContextWithDispatch('lead-7', repo, []),
      usageSourceFactory: () =>
        new FakeUsageSource({
          errors: {
            claude: new UsageUnavailableError(
              'claude',
              'statusLine missing at /home/operator/.config/claude/status.json',
              {
                account: accountForProvider('claude'),
              },
            ),
            codex: new UsageUnavailableError(
              'codex',
              'codex logs missing /home/operator/.codex/logs_2.sqlite Bearer sk-secret-123',
              {
                account: accountForProvider('codex'),
              },
            ),
          },
        }),
    };

    const out = (await invokeTool(buildCoreRegistry(), ctx, 'co_sling', {
      parent: 'lead-7',
      agent: 'impl-1',
      branch: 'co/diagnostic-waiting',
    })) as Record<string, unknown>;

    expect(out['status']).toBe('waiting');
    const waiting = out['waiting'] as Record<string, unknown>;
    expect(waiting['message']).toMatch(/usage source unavailable/i);
    expect(waiting['message']).not.toContain(accountForProvider('claude'));
    expect(waiting['message']).not.toContain(accountForProvider('codex'));
    expect(waiting['message']).not.toMatch(/\/home\/operator|sk-secret|Bearer/i);
    expect(waiting['reason']).not.toContain(accountForProvider('claude'));
    expect(waiting['reason']).not.toContain(accountForProvider('codex'));
    expect(waiting['reason']).not.toMatch(/\/home\/operator|sk-secret|Bearer/i);
    expect(waiting['maxed_providers']).toEqual([]);
    expect(waiting['unavailable_providers']).toEqual(['claude', 'codex']);
    expect(waiting['unavailable_accounts']).toBeUndefined();
    const diagnostics = out['diagnostics'] as Array<Record<string, unknown>>;
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'claude',
          code: 'usage_source_unavailable',
        }),
      ]),
    );
    for (const diagnostic of diagnostics) {
      expect(diagnostic['account']).toBeUndefined();
      expect(diagnostic['reason']).not.toContain(accountForProvider('claude'));
      expect(diagnostic['reason']).not.toContain(accountForProvider('codex'));
      expect(diagnostic['reason']).not.toMatch(/\/home\/operator|sk-secret|Bearer/i);
    }
    const placement = ctx.dispatch!.readPlacements('lead-7')[0];
    expect(placement?.kind).toBe('waiting');
    expect(placement?.maxedProviders).toEqual([]);
    expect(placement?.unavailableProviders).toEqual(['claude', 'codex']);
    expect(placement?.unavailableAccounts).toEqual([
      accountForProvider('claude'),
      accountForProvider('codex'),
    ]);
  });

  it('does not record a placed decision when worktree creation fails', async () => {
    const repo = makeMainRepo();
    git(repo, 'branch', 'co/existing');
    const ctx = makeContextWithDispatch('lead-7', repo, healthySnapshot);

    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_sling', {
        parent: 'lead-7',
        agent: 'impl-1',
        branch: 'co/existing',
      }),
    ).rejects.toThrow(/git worktree add/i);

    expect(ctx.dispatch!.readPlacements('lead-7')).toHaveLength(0);
  });

  it('routing inputs present but ctx.dispatch absent: loud-fail (Principle 9)', async () => {
    const repo = makeMainRepo();
    const ctx = makeContext('lead-7', repo);
    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_sling', {
        parent: 'lead-7',
        agent: 'impl-1',
        branch: 'co/needs-dispatch',
        role: 'implementer',
        work_size: 'average',
        reasoning_budget: 'standard',
      }),
    ).rejects.toThrow(/dispatch/i);
  });
});

describe('co_sling — output schema shape', () => {
  it('rejects empty and mixed outputs', () => {
    expect(() => slingTool.outputSchema.parse({})).toThrow();
    expect(() =>
      slingTool.outputSchema.parse({
        status: 'waiting',
        branch: 'co/mixed',
        waiting: {
          message: 'delayed',
          reason: 'all providers maxed',
          maxed_providers: ['claude'],
        },
      }),
    ).toThrow();
  });

  it('rejects invalid provider, effort, context, and waiting provider values', () => {
    const placed = {
      status: 'placed',
      branch: 'co/x',
      base_ref: 'main',
      base_sha: 'abc123',
      worktree_path: '/tmp/worktree',
      baseline_captured: true,
      placement: {
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        effort: 'high',
        context: 'standard',
      },
    };

    expect(() =>
      slingTool.outputSchema.parse({
        ...placed,
        placement: { ...placed.placement, provider: 'gemini' },
      }),
    ).toThrow();
    expect(() =>
      slingTool.outputSchema.parse({
        ...placed,
        placement: { ...placed.placement, effort: 'reckless' },
      }),
    ).toThrow();
    expect(() =>
      slingTool.outputSchema.parse({
        ...placed,
        placement: { ...placed.placement, context: 'infinite' },
      }),
    ).toThrow();
    expect(() =>
      slingTool.outputSchema.parse({
        status: 'waiting',
        waiting: {
          message: 'delayed',
          reason: 'usage source unavailable',
          maxed_providers: ['gemini'],
          unavailable_providers: [],
        },
      }),
    ).toThrow();
    expect(() =>
      slingTool.outputSchema.parse({
        status: 'waiting',
        waiting: {
          message: 'delayed',
          reason: 'usage source unavailable',
          maxed_providers: ['claude'],
          unavailable_providers: [],
        },
        diagnostics: [
          {
            provider: 'claude',
            account: accountForProvider('claude'),
            code: 'usage_source_unavailable',
            reason: 'statusLine missing',
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      slingTool.outputSchema.parse({
        ...placed,
        unexpected: true,
      }),
    ).toThrow();
    expect(() =>
      slingTool.outputSchema.parse({
        ...placed,
        placement: { ...placed.placement, account: accountForProvider('claude') },
      }),
    ).toThrow();
    expect(() =>
      slingTool.outputSchema.parse({
        status: 'waiting',
        waiting: {
          message: 'delayed',
          reason: 'usage source unavailable',
          maxed_providers: ['claude'],
          maxed_accounts: [accountForProvider('claude')],
          unavailable_providers: [],
        },
      }),
    ).toThrow();
    expect(() =>
      slingTool.outputSchema.parse({
        status: 'waiting',
        waiting: {
          message: 'delayed',
          reason: 'usage source unavailable',
          maxed_providers: ['claude'],
          unavailable_providers: [],
          unavailable_accounts: [accountForProvider('claude')],
        },
      }),
    ).toThrow();
    expect(() =>
      slingTool.outputSchema.parse({
        ...placed,
        diagnostics: [
          {
            provider: 'claude',
            code: 'usage_source_unavailable',
            reason: 'statusLine missing',
          },
        ],
      }),
    ).toThrow();
  });
});

describe('co_sling — L6b E4 child-cap (queue-as-WAITING for excess dispatches)', () => {
  it('queues to WAITING when the parent is already at its active-children cap (default 2)', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    // Two active (non-reviewer, unmerged) children already under lead-7 → at the default cap of 2.
    ctx.roster!.recordAgent({ agentId: 'impl-a', role: 'implementer', parent: 'lead-7' });
    ctx.roster!.recordAgent({ agentId: 'impl-b', role: 'implementer', parent: 'lead-7' });

    const out = (await invokeTool(buildCoreRegistry(), ctx, 'co_sling', {
      parent: 'lead-7',
      agent: 'impl-c',
      branch: 'co/over-cap',
    })) as { status: string; waiting?: { reason: string; message: string } };

    expect(out.status).toBe('waiting');
    expect(out.waiting?.reason).toMatch(/max active children reached \(2\/2\)/);
    // No sandbox is created for the queued dispatch.
    expect(ctx.worktrees?.getWorktree('co/over-cap')).toBeUndefined();
    expect(() => git(repo, 'rev-parse', '--verify', 'co/over-cap')).toThrow();
    // The cap gate fires before placement, so no placement decision is recorded for the queued sling.
    expect(ctx.dispatch?.readPlacements('lead-7')).toHaveLength(0);
  });

  it('reviewer children do NOT occupy a slot — a parent with only reviewer children still places', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    ctx.roster!.recordAgent({ agentId: 'rev-a', role: 'reviewer', parent: 'lead-7' });
    ctx.roster!.recordAgent({ agentId: 'rev-b', role: 'reviewer', parent: 'lead-7' });
    ctx.roster!.recordAgent({ agentId: 'rev-c', role: 'reviewer', parent: 'lead-7' });

    const out = (await invokeTool(buildCoreRegistry(), ctx, 'co_sling', {
      parent: 'lead-7',
      agent: 'impl-1',
      branch: 'co/reviewers-dont-count',
    })) as { status: string };

    expect(out.status).toBe('placed');
    expect(ctx.worktrees?.getWorktree('co/reviewers-dont-count')).toBeDefined();
  });

  // AC-L6b-8 reviewer-exemption regression: a reviewer dispatched while at-cap must NOT queue.
  it('a reviewer dispatched while at-cap is NOT queued (AC-L6b-8 exemption)', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    // Two active (non-reviewer) children → parent is at the default cap of 2.
    ctx.roster!.recordAgent({ agentId: 'impl-a', role: 'implementer', parent: 'lead-7' });
    ctx.roster!.recordAgent({ agentId: 'impl-b', role: 'implementer', parent: 'lead-7' });

    const out = (await invokeTool(buildCoreRegistry(), ctx, 'co_sling', {
      parent: 'lead-7',
      agent: 'rev-1',
      branch: 'co/reviewer-exempt-at-cap',
      role: 'reviewer',
    })) as { status: string };

    expect(out.status).toBe('placed');
    expect(ctx.worktrees?.getWorktree('co/reviewer-exempt-at-cap')).toBeDefined();
  });

  it('a non-reviewer dispatched while at-cap still queues → WAITING (AC-L6b-8 non-reviewer side)', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    ctx.roster!.recordAgent({ agentId: 'impl-a', role: 'implementer', parent: 'lead-7' });
    ctx.roster!.recordAgent({ agentId: 'impl-b', role: 'implementer', parent: 'lead-7' });

    const out = (await invokeTool(buildCoreRegistry(), ctx, 'co_sling', {
      parent: 'lead-7',
      agent: 'impl-c',
      branch: 'co/non-reviewer-at-cap',
    })) as { status: string };

    expect(out.status).toBe('waiting');
    expect(ctx.worktrees?.getWorktree('co/non-reviewer-at-cap')).toBeUndefined();
  });
});

// P2 / AC-S10-2 — spawn gate integration: co_sling fires the gate for placed children

describe('co_sling — spawn gate integration (P2 / AC-S10-2)', () => {
  it('placed: fires reviewerSpawnGate with the slung child agent id (spy-key-value discipline)', async () => {
    const repo = makeMainRepo();
    const spawned: Array<{ projectId: string; agent: string }> = [];
    const spyGate: ReviewerSpawnGate = {
      spawn: async (pId, record): Promise<void> => {
        spawned.push({ projectId: pId, agent: record.agent });
      },
    };
    const ctx = {
      ...makeContextWithDispatch('lead-7', repo, healthySnapshot),
      reviewerSpawnGate: spyGate,
    };

    const out = (await invokeTool(buildCoreRegistry(), ctx, 'co_sling', {
      parent: 'lead-7',
      agent: 'impl-sling-t',
      branch: 'co/sling-t',
    })) as { status: string };

    // Fire-and-forget: allow the spawn microtask to resolve before asserting
    await Promise.resolve();

    expect(out.status).toBe('placed');
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.agent).toBe('impl-sling-t'); // key-value guard (review-spy blind-spot)
    expect(spawned[0]!.projectId).toBe(ctx.projectId);
  });

  it('headless path (no reviewerSpawnGate): co_sling placed is byte-identical to before — gate never fires', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    // No reviewerSpawnGate on ctx — headless path must be unchanged.

    const out = (await invokeTool(buildCoreRegistry(), ctx, 'co_sling', {
      parent: 'lead-7',
      agent: 'impl-headless-t',
      branch: 'co/headless-t',
    })) as { status: string };

    expect(out.status).toBe('placed');
    expect(ctx.worktrees?.getWorktree('co/headless-t')).toBeDefined();
  });
});
