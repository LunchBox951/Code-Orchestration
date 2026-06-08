import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMailStore, type MailStore } from '../../mail/mail-store.js';
import { openRegistry, type ProjectRegistry } from '../../registry/registry.js';
import { openWorktreeStore, type WorktreeStore } from '../../worktrees/worktree-store.js';
import { openDispatchStore, type DispatchStore } from '../../dispatch/dispatch-store.js';
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

// AC-L3-1, headless through invokeTool (no MCP server, no Conductor): co_sling slings from the
// auto-detected base, records the sandbox + a readable baseline, requires an explicit parent and a
// co/ branch, and loud-fails when the mount did not inject the worktree store.

const ORIGINAL_ENV = process.env;
let tmpDirs: string[] = [];
let mails: MailStore[] = [];
let worktreeStores: WorktreeStore[] = [];
let dispatchStores: DispatchStore[] = [];
let regs: ProjectRegistry[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  tmpDirs = [];
  mails = [];
  worktreeStores = [];
  dispatchStores = [];
  regs = [];
  const data = mkdtempSync(join(tmpdir(), 'co-sling-tool-data-'));
  tmpDirs.push(data);
  process.env.CO_DATA_DIR = data;
});

afterEach(() => {
  for (const m of mails) m.close();
  for (const w of worktreeStores) w.close();
  for (const d of dispatchStores) d.close();
  for (const r of regs) r.close();
  process.env = ORIGINAL_ENV;
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
  mails = [];
  worktreeStores = [];
  dispatchStores = [];
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
    { cwd, encoding: 'utf8' },
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
  opts: { withWorktrees?: boolean } = {},
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
  return { agent, projectId, cwd: repo, mail, registry, worktrees };
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
    expect(ctx.worktrees?.getWorktree('co/feature')?.parent).toBe('lead-7');
    expect(ctx.worktrees?.getBaseline('co/feature')).toBeDefined();
    expect(ctx.dispatch?.readPlacements('lead-7')).toHaveLength(1);
  });

  it('rejects a branch that does not start with co/ (input schema)', async () => {
    const repo = makeMainRepo();
    const ctx = makeContext('lead-7', repo);
    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_sling', { parent: 'lead-7', branch: 'feature' }),
    ).rejects.toThrow(/input failed schema validation/i);
  });

  it('requires an explicit parent — there is NO @operator default (input schema)', async () => {
    const repo = makeMainRepo();
    const ctx = makeContext('lead-7', repo);
    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_sling', { branch: 'co/x' }),
    ).rejects.toThrow(/input failed schema validation/i);
  });

  it('loud-fails when the mount did not inject a worktree store (Principle 9)', async () => {
    const repo = makeMainRepo();
    const ctx = makeContext('lead-7', repo, { withWorktrees: false });
    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_sling', { parent: 'lead-7', branch: 'co/x' }),
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
  for (const snapshot of Array.isArray(snapshots) ? snapshots : [snapshots]) {
    dispatch.recordSnapshot(snapshot);
  }
  return { agent, projectId, cwd: repo, mail, registry, worktrees, dispatch };
}

describe('co_sling — with routing inputs (Phase 5 dispatch integration)', () => {
  it('placed: records placement.decided and returns placement in output; creates sandbox', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    const reg = buildCoreRegistry();

    const out = (await invokeTool(reg, ctx, 'co_sling', {
      parent: 'lead-7',
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

  it('waiting: records placement.decided(waiting) and returns loud message; does NOT create sandbox', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, maxedSnapshot);
    const reg = buildCoreRegistry();

    const out = (await invokeTool(reg, ctx, 'co_sling', {
      parent: 'lead-7',
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
