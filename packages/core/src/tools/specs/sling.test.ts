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
import { openResearchStore, type ResearchStore } from '../../research/research-store.js';
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
import { openConfigStore } from '../../config/config-store.js';
import {
  DISPATCH_DEFAULT_WORK_SIZE_KEY,
  DISPATCH_DEFAULT_REASONING_BUDGET_KEY,
} from '../../dispatch/dispatch-config.js';

// AC-L3-1, headless through invokeTool (no MCP server, no Conductor): co_sling slings from the
// auto-detected base, records the sandbox + a readable baseline, requires an explicit parent and a
// co/ branch, and loud-fails when the mount did not inject the worktree store.

const ORIGINAL_ENV = process.env;
let tmpDirs: string[] = [];
let mails: MailStore[] = [];
let worktreeStores: WorktreeStore[] = [];
let dispatchStores: DispatchStore[] = [];
let rosterStores: RosterStore[] = [];
let researchStores: ResearchStore[] = [];
let regs: ProjectRegistry[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  tmpDirs = [];
  mails = [];
  worktreeStores = [];
  dispatchStores = [];
  rosterStores = [];
  researchStores = [];
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
  for (const r of researchStores) r.close();
  for (const r of regs) r.close();
  process.env = ORIGINAL_ENV;
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
  mails = [];
  worktreeStores = [];
  dispatchStores = [];
  rosterStores = [];
  researchStores = [];
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

  it('rejects an already-registered child agent before dispatch, worktree, or kickoff side effects', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    ctx.roster!.recordAgent({
      agentId: 'impl-existing',
      role: 'implementer',
      parent: 'lead-7',
    });

    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_sling', {
        parent: 'lead-7',
        agent: 'impl-existing',
        branch: 'co/duplicate-child',
      }),
    ).rejects.toThrow(/already registered in the roster/i);

    expect(ctx.dispatch!.readPlacements('lead-7')).toHaveLength(0);
    expect(ctx.worktrees?.getWorktree('co/duplicate-child')).toBeUndefined();
    expect(ctx.mail.outstanding('impl-existing')).toHaveLength(0);
    expect(() => git(repo, 'rev-parse', '--verify', 'co/duplicate-child')).toThrow();
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
  it('AC-SET-5: falls back to dispatch.defaultWorkSize/ReasoningBudget when unspecified', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    const config = openConfigStore();
    try {
      config.setProjectOverride(ctx.projectId, DISPATCH_DEFAULT_WORK_SIZE_KEY, 'technical');
      config.setProjectOverride(ctx.projectId, DISPATCH_DEFAULT_REASONING_BUDGET_KEY, 'deep');
    } finally {
      config.close();
    }
    const reg = buildCoreRegistry();

    // No work_size / reasoning_budget on the call — the configured defaults must apply.
    await invokeTool(reg, ctx, 'co_sling', {
      parent: 'lead-7',
      agent: 'impl-default',
      branch: 'co/uses-default-routing',
    });

    const placements = ctx.dispatch?.readPlacements('lead-7') ?? [];
    expect(placements).toHaveLength(1);
    expect(placements[0]?.workSize).toBe('technical');
    expect(placements[0]?.reasoningBudget).toBe('deep');
  });

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
      agent: 'researcher-1',
      branch: 'co/canonical-role',
      role: ' Researcher ',
      work_size: 'average',
      reasoning_budget: 'standard',
    });

    const placements = ctx.dispatch!.readPlacements('lead-7');
    expect(placements).toHaveLength(1);
    expect(placements[0]!.role).toBe('researcher');
    expect(ctx.worktrees!.getWorktree('co/canonical-role')).toMatchObject({
      role: 'researcher',
    });
  });

  it('#94: role schema tells agents reviewer dispatch is gate-internal, not ad-hoc co_sling', () => {
    const roleDescription =
      (
        slingTool.inputSchema as unknown as {
          readonly shape: { readonly role: { readonly description?: string } };
        }
      ).shape.role.description ?? '';

    expect(roleDescription).toMatch(/implementer/i);
    expect(roleDescription).toMatch(/researcher/i);
    expect(roleDescription).toMatch(/reviewer.*gate-internal/i);
    expect(roleDescription).toMatch(/co_merge/);
  });

  // #157: the role describe must tell the dispatcher that web/GitHub work needs researcher:external,
  // and that a bare researcher has NO outbound network — guards the guidance against silent regression.
  it('#157: role schema guidance names researcher:external and "no outbound network"', () => {
    const roleDescription =
      (
        slingTool.inputSchema as unknown as {
          readonly shape: { readonly role: { readonly description?: string } };
        }
      ).shape.role.description ?? '';

    expect(roleDescription).toMatch(/researcher:external/);
    expect(roleDescription).toMatch(/no outbound network/i);
  });

  // #94: an ad-hoc reviewer dispatch establishes a worktree + placement with NO review.requested
  // event / review_id / `${role}@${reviewId}` seat, so co_review_finalize can never record a verdict
  // and co_merge stalls at review_pending. Reviewer dispatch is gate-internal (co_merge only); a
  // co_sling role=reviewer must be REJECTED before any worktree/placement/review.requested side effect.
  it('#94: rejects an ad-hoc role=reviewer co_sling and records NO worktree/placement', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    const reg = buildCoreRegistry();

    await expect(
      invokeTool(reg, ctx, 'co_sling', {
        parent: 'lead-7',
        agent: 'reviewer-1',
        branch: 'co/adhoc-reviewer',
        role: 'reviewer',
      }),
    ).rejects.toThrow(/reviewer dispatch is gate-internal.*co_merge/su);

    // No side effects: no worktree, no recorded placement.
    expect(ctx.worktrees!.getWorktree('co/adhoc-reviewer')).toBeUndefined();
    expect(ctx.dispatch!.readPlacements('lead-7')).toHaveLength(0);
  });

  it('#94: rejects an ad-hoc reviewer sub-role (reviewer:pr) co_sling too', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    const reg = buildCoreRegistry();

    await expect(
      invokeTool(reg, ctx, 'co_sling', {
        parent: 'lead-7',
        agent: 'reviewer-pr-1',
        branch: 'co/adhoc-reviewer-pr',
        role: ' Reviewer:PR ',
      }),
    ).rejects.toThrow(/reviewer dispatch is gate-internal/su);
    expect(ctx.worktrees!.getWorktree('co/adhoc-reviewer-pr')).toBeUndefined();
    expect(ctx.dispatch!.readPlacements('lead-7')).toHaveLength(0);
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

  // #157: a bare researcher is offline by design — placed output must flag web_research_enabled=false
  // and carry an advisory naming researcher:external, so a wrong dispatch is caught after the fact.
  it('#157: a bare researcher is placed with web_research_enabled=false + a researcher:external advisory', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    const reg = buildCoreRegistry();

    const out = (await invokeTool(reg, ctx, 'co_sling', {
      parent: 'lead-7',
      agent: 'researcher-bare',
      branch: 'co/bare-researcher',
      role: 'researcher',
    })) as Record<string, unknown>;

    expect(out['status']).toBe('placed');
    expect(out['web_research_enabled']).toBe(false);
    expect(out['web_research_advisory']).toMatch(/researcher:external/);
    expect(out['web_research_advisory']).toMatch(/no outbound network/i);
  });

  // #157: researcher:external is the sole web-search holder — web_research_enabled=true, no advisory.
  it('#157: researcher:external is placed with web_research_enabled=true and no advisory', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    const reg = buildCoreRegistry();

    const out = (await invokeTool(reg, ctx, 'co_sling', {
      parent: 'lead-7',
      agent: 'researcher-ext',
      branch: 'co/external-researcher',
      role: 'researcher:external',
    })) as Record<string, unknown>;

    expect(out['status']).toBe('placed');
    expect(out['web_research_enabled']).toBe(true);
    expect(out['web_research_advisory']).toBeUndefined();
  });

  // #157: a non-researcher (code worker) is offline too, but carries NO advisory (the advisory only
  // fires for researchers, who are the ones a dispatcher would wrongly put on a web task).
  it('#157: an implementer is placed with web_research_enabled=false and no advisory', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    const reg = buildCoreRegistry();

    const out = (await invokeTool(reg, ctx, 'co_sling', {
      parent: 'lead-7',
      agent: 'impl-offline',
      branch: 'co/impl-offline',
      role: 'implementer',
    })) as Record<string, unknown>;

    expect(out['status']).toBe('placed');
    expect(out['web_research_enabled']).toBe(false);
    expect(out['web_research_advisory']).toBeUndefined();
  });

  // #157: a non-web researcher sub-role (codebase) is offline → flag false + advisory.
  it('#157: researcher:codebase is placed with web_research_enabled=false + advisory', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    const reg = buildCoreRegistry();

    const out = (await invokeTool(reg, ctx, 'co_sling', {
      parent: 'lead-7',
      agent: 'researcher-cb',
      branch: 'co/codebase-researcher',
      role: 'researcher:codebase',
    })) as Record<string, unknown>;

    expect(out['status']).toBe('placed');
    expect(out['web_research_enabled']).toBe(false);
    expect(out['web_research_advisory']).toMatch(/researcher:external/);
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
    // Provider-maxed WAITING also carries a one-line next-step (re-issue co_sling once capacity recovers).
    expect(typeof w['next_step']).toBe('string');
    expect(w['next_step'] as string).toMatch(/re-issue this co_sling/i);
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
          next_step: 'retry later',
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
          next_step: 'retry later',
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
          next_step: 'retry later',
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
          next_step: 'retry later',
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

  // #157: the web-research diagnostic is an additive PLACED-only fact — it validates on a placed
  // output and is mutually exclusive with WAITING (mirrors the placement/worktree exclusivity).
  it('#157: accepts web_research_enabled on a placed output and rejects it on a waiting output', () => {
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

    // Placed WITH the additive diagnostic (and advisory) validates.
    expect(() =>
      slingTool.outputSchema.parse({
        ...placed,
        web_research_enabled: false,
        web_research_advisory: 'use researcher:external',
      }),
    ).not.toThrow();
    // Placed without it still validates (additive/optional — never required).
    expect(() => slingTool.outputSchema.parse(placed)).not.toThrow();

    // A waiting output carrying the placed-only diagnostic is rejected.
    expect(() =>
      slingTool.outputSchema.parse({
        status: 'waiting',
        web_research_enabled: true,
        waiting: {
          message: 'delayed',
          next_step: 'retry later',
          reason: 'usage source unavailable',
          maxed_providers: ['claude'],
          unavailable_providers: [],
        },
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
    })) as { status: string; waiting?: { reason: string; message: string; next_step: string } };

    expect(out.status).toBe('waiting');
    expect(out.waiting?.reason).toMatch(/max active children reached \(2\/2\)/);
    // A WAITING payload carries a one-line next-step telling the agent how to make progress.
    expect(out.waiting?.next_step).toMatch(/free a slot.*re-issue this co_sling/i);
    // No sandbox is created for the queued dispatch.
    expect(ctx.worktrees?.getWorktree('co/over-cap')).toBeUndefined();
    expect(() => git(repo, 'rev-parse', '--verify', 'co/over-cap')).toThrow();
    // The cap gate fires before placement, so no placement decision is recorded for the queued sling.
    expect(ctx.dispatch?.readPlacements('lead-7')).toHaveLength(0);
  });

  // #131 — a durably STOPPED child no longer occupies a slot. With the operator-control seam injected
  // and one of two children stopped, the third sling is PLACED (the slot was freed). Mirrors the
  // "queues at cap of 2" test above but flips the outcome via the agentControl seam.
  it('#131: a stopped child frees a slot so a 3rd sling is PLACED (agentControl injected)', async () => {
    const repo = makeMainRepo();
    const base = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    // Two children under lead-7 → existence cap of 2; one is durably STOPPED via the seam.
    base.roster!.recordAgent({ agentId: 'impl-a', role: 'implementer', parent: 'lead-7' });
    base.roster!.recordAgent({ agentId: 'impl-b', role: 'implementer', parent: 'lead-7' });
    const stopped = new Set(['impl-b']);
    const ctx: ToolContext = {
      ...base,
      agentControl: {
        isStopped: (agentId: string): boolean => stopped.has(agentId),
        listStopped: (): readonly string[] => [...stopped],
      },
    };

    const out = (await invokeTool(buildCoreRegistry(), ctx, 'co_sling', {
      parent: 'lead-7',
      agent: 'impl-c',
      branch: 'co/stopped-freed-slot',
    })) as { status: string };

    expect(out.status).toBe('placed');
    expect(ctx.worktrees?.getWorktree('co/stopped-freed-slot')).toBeDefined();
    expect(ctx.dispatch?.readPlacements('lead-7')).toHaveLength(1);
  });

  it('rechecks the child cap after async usage refresh before creating a sandbox', async () => {
    const repo = makeMainRepo();
    const base = makeContextWithDispatch('lead-7', repo, []);
    base.roster!.recordAgent({ agentId: 'impl-a', role: 'implementer', parent: 'lead-7' });
    base.roster!.recordAgent({ agentId: 'impl-stopped', role: 'implementer', parent: 'lead-7' });
    const stopped = new Set(['impl-stopped']);
    const ctx: ToolContext = {
      ...base,
      agentControl: {
        isStopped: (agentId: string): boolean => stopped.has(agentId),
        listStopped: (): readonly string[] => [...stopped],
      },
      usageSourceFactory: () => ({
        read: async () => {
          stopped.clear();
          return healthySnapshot;
        },
      }),
    };

    const out = (await invokeTool(buildCoreRegistry(), ctx, 'co_sling', {
      parent: 'lead-7',
      agent: 'impl-c',
      branch: 'co/late-cap-recheck',
    })) as { status: string; waiting?: { reason: string } };

    expect(out.status).toBe('waiting');
    expect(out.waiting?.reason).toMatch(/max active children reached \(2\/2\)/);
    expect(ctx.worktrees?.getWorktree('co/late-cap-recheck')).toBeUndefined();
    expect(ctx.mail.outstanding('impl-c')).toHaveLength(0);
    expect(ctx.dispatch?.readPlacements('lead-7')).toHaveLength(0);
    expect(() => git(repo, 'rev-parse', '--verify', 'co/late-cap-recheck')).toThrow();
  });

  // #131 — WITHOUT the agentControl seam injected, behaviour is UNCHANGED: a stopped child cannot be
  // detected, so two children still occupy the cap and the 3rd sling QUEUES → WAITING (conservative).
  it('#131: without agentControl injected, the same two children still queue → WAITING', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    expect(ctx.agentControl).toBeUndefined();
    ctx.roster!.recordAgent({ agentId: 'impl-a', role: 'implementer', parent: 'lead-7' });
    ctx.roster!.recordAgent({ agentId: 'impl-b', role: 'implementer', parent: 'lead-7' });

    const out = (await invokeTool(buildCoreRegistry(), ctx, 'co_sling', {
      parent: 'lead-7',
      agent: 'impl-c',
      branch: 'co/no-control-store-still-queues',
    })) as { status: string };

    expect(out.status).toBe('waiting');
    expect(ctx.worktrees?.getWorktree('co/no-control-store-still-queues')).toBeUndefined();
  });

  // #166 — a worker child that recorded co_finish (a finish exists for its branch) is in a
  // lifecycle-terminal state and no longer occupies a slot, even though its branch never merged and
  // it was never operator-stopped. With one of two children finished, the 3rd sling is PLACED.
  it('#166: a finished child (co_finish recorded) frees a slot so a 3rd sling is PLACED', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    ctx.roster!.recordAgent({ agentId: 'impl-a', role: 'implementer', parent: 'lead-7' });
    ctx.roster!.recordAgent({ agentId: 'impl-b', role: 'implementer', parent: 'lead-7' });
    // impl-b owns a worktree branch and recorded a finish for it (worker done, branch not merged).
    ctx.worktrees!.recordWorktree({
      branch: 'co/impl-b',
      baseRef: 'main',
      baseSha: 'deadbeef',
      path: join(repo, 'wt-b'),
      parent: 'lead-7',
      agent: 'impl-b',
      role: 'implementer',
    });
    ctx.worktrees!.recordFinish({
      branch: 'co/impl-b',
      baseSha: 'deadbeef',
      commitSha: 'cafef00d',
      tests: [],
      agent: 'impl-b',
    });

    const out = (await invokeTool(buildCoreRegistry(), ctx, 'co_sling', {
      parent: 'lead-7',
      agent: 'impl-c',
      branch: 'co/finished-freed-slot',
    })) as { status: string };

    expect(out.status).toBe('placed');
    expect(ctx.worktrees?.getWorktree('co/finished-freed-slot')).toBeDefined();
    expect(ctx.dispatch?.readPlacements('lead-7')).toHaveLength(1);
  });

  // #166 negative companion — a worker child whose branch has NO finish recorded is still active, so
  // two such children keep the parent at the cap and the 3rd sling QUEUES → WAITING (regression guard).
  it('#166: a NOT-finished child still occupies a slot — at cap, the 3rd sling WAITS', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    ctx.roster!.recordAgent({ agentId: 'impl-a', role: 'implementer', parent: 'lead-7' });
    ctx.roster!.recordAgent({ agentId: 'impl-b', role: 'implementer', parent: 'lead-7' });
    // impl-b owns a worktree branch but recorded NO finish — still active.
    ctx.worktrees!.recordWorktree({
      branch: 'co/impl-b',
      baseRef: 'main',
      baseSha: 'deadbeef',
      path: join(repo, 'wt-b'),
      parent: 'lead-7',
      agent: 'impl-b',
      role: 'implementer',
    });

    const out = (await invokeTool(buildCoreRegistry(), ctx, 'co_sling', {
      parent: 'lead-7',
      agent: 'impl-c',
      branch: 'co/not-finished-still-waits',
    })) as { status: string; waiting?: { reason: string } };

    expect(out.status).toBe('waiting');
    expect(out.waiting?.reason).toMatch(/max active children reached \(2\/2\)/);
    expect(ctx.worktrees?.getWorktree('co/not-finished-still-waits')).toBeUndefined();
  });

  // #158 — a read-only researcher child that recorded research.finalized is lifecycle-terminal and no
  // longer occupies a slot, even though it has no branch (so it can never merge) and was never stopped.
  // With one of two children a finalized researcher, the 3rd sling is PLACED (the slot was freed).
  it('#158: a finalized researcher frees a slot so a 3rd sling is PLACED', async () => {
    const repo = makeMainRepo();
    const base = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    base.roster!.recordAgent({ agentId: 'impl-a', role: 'implementer', parent: 'lead-7' });
    base.roster!.recordAgent({ agentId: 'res-1', role: 'researcher', parent: 'lead-7' });
    const research = openResearchStore(base.projectId);
    researchStores.push(research);
    // res-1 finalized a locator map → terminal; it no longer holds a slot.
    research.recordFinalize({
      researchId: 'r-1',
      question: 'where is the gate?',
      requestedBy: 'lead-7',
      researcher: 'res-1',
      kind: 'map',
      map: {
        question: 'where is the gate?',
        entries: [
          { path: 'packages/core/src/review/merge.ts', why: 'the gate', symbols: ['Gate'] },
        ],
        readOrder: ['packages/core/src/review/merge.ts'],
      },
    });
    const ctx: ToolContext = { ...base, research };

    const out = (await invokeTool(buildCoreRegistry(), ctx, 'co_sling', {
      parent: 'lead-7',
      agent: 'impl-c',
      branch: 'co/finalized-freed-slot',
    })) as { status: string };

    expect(out.status).toBe('placed');
    expect(ctx.worktrees?.getWorktree('co/finalized-freed-slot')).toBeDefined();
    expect(ctx.dispatch?.readPlacements('lead-7')).toHaveLength(1);
  });

  // #158 negative companion — a researcher child that did NOT finalize is still active, so two children
  // keep the parent at the cap and the 3rd sling QUEUES → WAITING (regression guard).
  it('#158: a NOT-finalized researcher still occupies a slot — at cap, the 3rd sling WAITS', async () => {
    const repo = makeMainRepo();
    const base = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    base.roster!.recordAgent({ agentId: 'impl-a', role: 'implementer', parent: 'lead-7' });
    base.roster!.recordAgent({ agentId: 'res-1', role: 'researcher', parent: 'lead-7' });
    const research = openResearchStore(base.projectId);
    researchStores.push(research);
    // No recordFinalize for res-1 — it is still active.
    const ctx: ToolContext = { ...base, research };

    const out = (await invokeTool(buildCoreRegistry(), ctx, 'co_sling', {
      parent: 'lead-7',
      agent: 'impl-c',
      branch: 'co/not-finalized-still-waits',
    })) as { status: string; waiting?: { reason: string } };

    expect(out.status).toBe('waiting');
    expect(out.waiting?.reason).toMatch(/max active children reached \(2\/2\)/);
    expect(ctx.worktrees?.getWorktree('co/not-finalized-still-waits')).toBeUndefined();
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

  // #94: reviewer dispatch is rejected outright (gate-internal), so the AC-L6b-8 cap-exemption is no
  // longer reachable via co_sling — a reviewer dispatched at-cap is REJECTED, never queued or placed.
  it('#94: a reviewer co_sling at-cap is rejected (not queued, not placed)', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    // Two active (non-reviewer) children → parent is at the default cap of 2.
    ctx.roster!.recordAgent({ agentId: 'impl-a', role: 'implementer', parent: 'lead-7' });
    ctx.roster!.recordAgent({ agentId: 'impl-b', role: 'implementer', parent: 'lead-7' });

    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_sling', {
        parent: 'lead-7',
        agent: 'rev-1',
        branch: 'co/reviewer-rejected-at-cap',
        role: 'reviewer',
      }),
    ).rejects.toThrow(/reviewer dispatch is gate-internal/su);

    expect(ctx.worktrees?.getWorktree('co/reviewer-rejected-at-cap')).toBeUndefined();
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

    expect(out.status).toBe('placed');
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.agent).toBe('impl-sling-t'); // key-value guard (review-spy blind-spot)
    expect(spawned[0]!.projectId).toBe(ctx.projectId);
  });

  it('placed: fails loud when the live spawn gate rejects', async () => {
    const repo = makeMainRepo();
    const failingGate: ReviewerSpawnGate = {
      spawn: async (): Promise<void> => {
        throw new Error('spawn failed');
      },
    };
    const ctx = {
      ...makeContextWithDispatch('lead-7', repo, healthySnapshot),
      reviewerSpawnGate: failingGate,
    };

    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_sling', {
        parent: 'lead-7',
        agent: 'impl-sling-fail',
        branch: 'co/sling-fail',
      }),
    ).rejects.toThrow(/spawn failed/i);

    expect(ctx.dispatch?.readPlacements('lead-7')).toHaveLength(0);
    expect(ctx.worktrees?.getWorktree('co/sling-fail')?.removed).toBe(true);
    expect(ctx.mail.outstanding('impl-sling-fail')).toHaveLength(0);
    expect(() => git(repo, 'rev-parse', '--verify', 'co/sling-fail')).toThrow();

    const retryCtx = {
      ...ctx,
      reviewerSpawnGate: undefined,
    };
    const retried = (await invokeTool(buildCoreRegistry(), retryCtx, 'co_sling', {
      parent: 'lead-7',
      agent: 'impl-sling-fail',
      branch: 'co/sling-fail',
    })) as { status: string };

    expect(retried.status).toBe('placed');
    expect(ctx.worktrees?.getWorktree('co/sling-fail')?.removed).toBe(false);
    expect(ctx.mail.outstanding('impl-sling-fail')).toHaveLength(1);
  });

  it('placed: cleans up worktree + kickoff when placement recording fails', async () => {
    const repo = makeMainRepo();
    const base = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    const ctx: ToolContext = {
      ...base,
      dispatch: {
        ...base.dispatch,
        recordPlacement: () => {
          throw new Error('placement failed');
        },
      } as DispatchStore,
    };

    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_sling', {
        parent: 'lead-7',
        agent: 'impl-placement-fail',
        branch: 'co/placement-fail',
      }),
    ).rejects.toThrow(/placement failed/i);

    expect(base.worktrees?.getWorktree('co/placement-fail')?.removed).toBe(true);
    expect(base.mail.outstanding('impl-placement-fail')).toHaveLength(0);
    expect(() => git(repo, 'rev-parse', '--verify', 'co/placement-fail')).toThrow();
  });

  it('placed: releases a spawned pane when placement recording fails after live spawn', async () => {
    const repo = makeMainRepo();
    const base = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    const spawned: string[] = [];
    const released: string[] = [];
    const ctx: ToolContext = {
      ...base,
      dispatch: {
        ...base.dispatch,
        recordPlacement: () => {
          throw new Error('placement failed');
        },
      } as DispatchStore,
      reviewerSpawnGate: {
        spawn: async (_projectId, record) => {
          spawned.push(record.agent);
        },
        release: async (_projectId, agent) => {
          released.push(agent);
        },
      },
    };

    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_sling', {
        parent: 'lead-7',
        agent: 'impl-placement-live-fail',
        branch: 'co/placement-live-fail',
      }),
    ).rejects.toThrow(/placement failed/i);

    expect(spawned).toEqual(['impl-placement-live-fail']);
    expect(released).toEqual(['impl-placement-live-fail']);
    expect(base.worktrees?.getWorktree('co/placement-live-fail')?.removed).toBe(true);
    expect(base.mail.outstanding('impl-placement-live-fail')).toHaveLength(0);
    expect(() => git(repo, 'rev-parse', '--verify', 'co/placement-live-fail')).toThrow();
  });

  it('placed: surfaces release failures when placement rollback cannot fully clean up', async () => {
    const repo = makeMainRepo();
    const base = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    const ctx: ToolContext = {
      ...base,
      dispatch: {
        ...base.dispatch,
        recordPlacement: () => {
          throw new Error('placement failed');
        },
      } as DispatchStore,
      reviewerSpawnGate: {
        spawn: async () => {},
        release: async () => {
          throw new Error('release failed');
        },
      },
    };

    try {
      await invokeTool(buildCoreRegistry(), ctx, 'co_sling', {
        parent: 'lead-7',
        agent: 'impl-placement-release-fail',
        branch: 'co/placement-release-fail',
      });
      throw new Error('expected co_sling to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect(error).toHaveProperty('message', expect.stringContaining('placement failed'));
      expect(error).toHaveProperty('message', expect.stringContaining('release failed'));
      expect((error as AggregateError).errors).toHaveLength(2);
    }

    expect(base.worktrees?.getWorktree('co/placement-release-fail')?.removed).toBe(true);
    expect(base.mail.outstanding('impl-placement-release-fail')).toHaveLength(0);
    expect(() => git(repo, 'rev-parse', '--verify', 'co/placement-release-fail')).toThrow();
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

// ── P2 (AC-S14-2) kickoff: seed an actionable clarify_request on PLACED so the daemon drives the ──
// child's first turn. WAITING slings seed nothing (no sandbox — no mail). The kickoff body uses the
// caller-supplied `kickoff` field, or a directive fallback when omitted.
describe('co_sling — P2 (AC-S14-2) kickoff: seeds actionable clarify_request on PLACED', () => {
  it('placed: seeds a clarify_request kickoff addressed to child from parent (directive fallback body)', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    const reg = buildCoreRegistry();

    const out = (await invokeTool(reg, ctx, 'co_sling', {
      parent: 'lead-7',
      agent: 'impl-1',
      branch: 'co/p2-kickoff-default',
    })) as { status: string };

    expect(out.status).toBe('placed');

    // The child has exactly one outstanding actionable item — the kickoff.
    const outstanding = ctx.mail.outstanding('impl-1');
    expect(outstanding).toHaveLength(1);
    const kickoff = outstanding[0]!;
    expect(kickoff.type).toBe('clarify_request');
    expect(kickoff.recipient).toBe('impl-1');
    expect(kickoff.sender).toBe('lead-7');
    // The directive fallback must be non-empty actionable work, not a content-free nudge.
    expect(kickoff.body.length).toBeGreaterThan(0);
    expect(kickoff.body).toMatch(/task|assign|co_finish|worker_done/i);
    // Kind must be actionable (the daemon's selection reads `outstanding`, which is ACTIONABLE-only).
    expect(kickoff.kind).toBe('actionable');
  });

  it('placed with kickoff input: uses the provided text as the kickoff body', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    const reg = buildCoreRegistry();

    const out = (await invokeTool(reg, ctx, 'co_sling', {
      parent: 'lead-7',
      agent: 'impl-1',
      branch: 'co/p2-kickoff-custom',
      kickoff: 'Implement the parser module per the spec in your session context.',
    })) as { status: string };

    expect(out.status).toBe('placed');

    const outstanding = ctx.mail.outstanding('impl-1');
    expect(outstanding).toHaveLength(1);
    expect(outstanding[0]!.body).toBe(
      'Implement the parser module per the spec in your session context.',
    );
    expect(outstanding[0]!.type).toBe('clarify_request');
    expect(outstanding[0]!.sender).toBe('lead-7');
    expect(outstanding[0]!.recipient).toBe('impl-1');
  });

  it('placed: fails loud and cleans up when kickoff mail cannot be written', async () => {
    const repo = makeMainRepo();
    const base = makeContextWithDispatch('lead-7', repo, healthySnapshot);
    const spawned: string[] = [];
    const ctx: ToolContext = {
      ...base,
      mail: {
        ...base.mail,
        send: () => {
          throw new Error('kickoff failed');
        },
      },
      reviewerSpawnGate: {
        spawn: async (_projectId, record) => {
          spawned.push(record.agent);
        },
      },
    };

    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_sling', {
        parent: 'lead-7',
        agent: 'impl-kickoff-fail',
        branch: 'co/p2-kickoff-fail',
      }),
    ).rejects.toThrow(/kickoff failed/i);

    expect(spawned).toEqual([]);
    expect(base.dispatch?.readPlacements('lead-7')).toHaveLength(0);
    expect(base.worktrees?.getWorktree('co/p2-kickoff-fail')?.removed).toBe(true);
    expect(base.mail.outstanding('impl-kickoff-fail')).toHaveLength(0);
    expect(() => git(repo, 'rev-parse', '--verify', 'co/p2-kickoff-fail')).toThrow();

    const retried = (await invokeTool(buildCoreRegistry(), base, 'co_sling', {
      parent: 'lead-7',
      agent: 'impl-kickoff-fail',
      branch: 'co/p2-kickoff-fail',
    })) as { status: string };

    expect(retried.status).toBe('placed');
    expect(base.worktrees?.getWorktree('co/p2-kickoff-fail')?.removed).toBe(false);
    expect(base.mail.outstanding('impl-kickoff-fail')).toHaveLength(1);
  });

  it('waiting: does NOT seed a kickoff (no sandbox created, no mail delivered to child)', async () => {
    const repo = makeMainRepo();
    const ctx = makeContextWithDispatch('lead-7', repo, maxedSnapshot);
    const reg = buildCoreRegistry();

    const out = (await invokeTool(reg, ctx, 'co_sling', {
      parent: 'lead-7',
      agent: 'impl-1',
      branch: 'co/p2-kickoff-waiting',
    })) as { status: string };

    expect(out.status).toBe('waiting');
    // WAITING: no sandbox, no kickoff seeded (spec §3, P9 — no sandbox means no actionable work).
    expect(ctx.mail.outstanding('impl-1')).toHaveLength(0);
    expect(ctx.mail.inbox('impl-1')).toHaveLength(0);
  });
});
