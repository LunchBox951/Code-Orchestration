import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMailStore, type MailStore } from '../../mail/mail-store.js';
import { openRegistry, type ProjectRegistry } from '../../registry/registry.js';
import { openRosterStore, type RosterStore } from '../../roles/roster-store.js';
import { ROLE_PROFILES } from '../../roles/profile.js';
import { openPlanStore, type PlanStore } from '../../plans/plans-store.js';
import { buildCoreRegistry } from '../core-registry.js';
import { checkToolCompleteness } from '../completeness.js';
import { invokeTool } from '../invoke.js';
import type { ToolContext } from '../context.js';

// L6b E1 — co_plan_ingest: coordinator ingests a wired plan (green-on-real); non-coordinators
// rejected; fuzzy criterion (no verify) rejected (red-on-fuzzy, E2 validator gate);
// dangling-dep rejected; ctx.plans/ctx.roster guards.

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let mailStores: MailStore[] = [];
let planStores: PlanStore[] = [];
let rosterStores: RosterStore[] = [];
let registries: ProjectRegistry[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  mailStores = [];
  planStores = [];
  rosterStores = [];
  registries = [];
  const dir = mkdtempSync(join(tmpdir(), 'co-plan-ingest-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const m of mailStores) m.close();
  for (const p of planStores) p.close();
  for (const r of rosterStores) r.close();
  for (const r of registries) r.close();
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
  mailStores = [];
  planStores = [];
  rosterStores = [];
  registries = [];
});

function openStores(id: string): {
  mail: MailStore;
  plans: PlanStore;
  roster: RosterStore;
  registry: ProjectRegistry;
} {
  const mail = openMailStore(id);
  mailStores.push(mail);
  const plans = openPlanStore(id);
  planStores.push(plans);
  const roster = openRosterStore(id);
  rosterStores.push(roster);
  const registry = openRegistry();
  registries.push(registry);
  return { mail, plans, roster, registry };
}

function makeCtx(id: string, agent: string, overrides: Partial<ToolContext> = {}): ToolContext {
  const { mail, plans, roster, registry } = openStores(id);
  return {
    agent,
    projectId: id,
    cwd: '/tmp',
    mail,
    registry,
    plans,
    roster,
    ...overrides,
  };
}

/** A concrete, fully-wired plan that should pass the validator gate. */
const WIRED_INGEST_INPUT = {
  task_id: 'task-ingest-1',
  goal: 'Implement the auth module',
  task_criteria: [
    { text: 'expired tokens rejected with 401', verify: 'pnpm vitest run packages/core' },
    { text: 'refresh flow completes under 200ms', verify: 'pnpm vitest run packages/core' },
  ],
  phases: [
    {
      phase_id: 'ph-1',
      name: 'Core implementation',
      deps: [],
      criteria: [{ text: 'all unit tests pass', verify: 'pnpm vitest run packages/core' }],
    },
    {
      phase_id: 'ph-2',
      name: 'Integration',
      owner: 'lead-x',
      deps: ['ph-1'],
      criteria: [{ text: 'integration tests pass', verify: 'pnpm test' }],
    },
  ],
};

const registry = buildCoreRegistry();

describe('co_plan_ingest — coordinator ingests a concrete+wired plan (green-on-real)', () => {
  it('records the plan and returns the PlanRecord', async () => {
    const ctx = makeCtx('p-ingest-coord', 'coord-1');
    ctx.roster!.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });

    const result = (await invokeTool(
      registry,
      ctx,
      'co_plan_ingest',
      WIRED_INGEST_INPUT,
    )) as Record<string, unknown>;

    expect(result['task_id']).toBe('task-ingest-1');
    expect(result['goal']).toBe('Implement the auth module');
    expect(result['drafted_ts']).toBeGreaterThan(0);
    expect(result['replan_count']).toBe(0);

    const taskCriteria = result['task_criteria'] as Array<{ text: string; verify?: string }>;
    expect(taskCriteria).toHaveLength(2);
    expect(taskCriteria[0]?.verify).toBe('pnpm vitest run packages/core');

    const phases = result['phases'] as Array<{
      phase_id: string;
      name: string;
      deps: string[];
      criteria: Array<{ text: string; verify?: string }>;
      status: string;
    }>;
    expect(phases).toHaveLength(2);
    expect(phases[0]?.phase_id).toBe('ph-1');
    expect(phases[0]?.status).toBe('planned');
    expect(phases[1]?.phase_id).toBe('ph-2');
    expect(phases[1]?.deps).toEqual(['ph-1']);

    // The durable record is queryable.
    const stored = ctx.plans!.getPlan('task-ingest-1');
    expect(stored?.taskId).toBe('task-ingest-1');
    expect(stored?.phases).toHaveLength(2);
  });
});

describe('co_plan_ingest — caller must be a coordinator', () => {
  it('rejects a non-coordinator (implementer) with a named violation', async () => {
    const ctx = makeCtx('p-ingest-noncoord', 'impl-1');
    ctx.roster!.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
    ctx.roster!.recordAgent({ agentId: 'impl-1', role: 'implementer', parent: 'coord-1' });

    await expect(invokeTool(registry, ctx, 'co_plan_ingest', WIRED_INGEST_INPUT)).rejects.toThrow(
      /co_plan_ingest.*requires coordinator/i,
    );
    expect(ctx.plans!.getPlan('task-ingest-1')).toBeUndefined();
  });

  it('rejects an unregistered caller', async () => {
    const ctx = makeCtx('p-ingest-ghost', 'ghost-1');

    await expect(invokeTool(registry, ctx, 'co_plan_ingest', WIRED_INGEST_INPUT)).rejects.toThrow(
      /co_plan_ingest.*not registered/i,
    );
    expect(ctx.plans!.getPlan('task-ingest-1')).toBeUndefined();
  });
});

describe('co_plan_ingest — red-on-fuzzy: fuzzy criterion causes rejection (E2 validator gate)', () => {
  it('rejects a plan when task_criteria has a criterion missing its verify command', async () => {
    const ctx = makeCtx('p-ingest-fuzzy-task', 'coord-1');
    ctx.roster!.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });

    const fuzzyInput = {
      ...WIRED_INGEST_INPUT,
      task_id: 'task-fuzzy-task',
      task_criteria: [
        { text: 'expired tokens rejected', verify: 'pnpm test' }, // wired
        { text: 'the feature works' }, // fuzzy — missing verify
      ],
    };

    await expect(invokeTool(registry, ctx, 'co_plan_ingest', fuzzyInput)).rejects.toThrow(
      /criterion violation/i,
    );

    // The plan must NOT have been persisted.
    expect(ctx.plans!.getPlan('task-fuzzy-task')).toBeUndefined();
  });

  it('rejects a plan when a phase criterion is missing its verify command', async () => {
    const ctx = makeCtx('p-ingest-fuzzy-phase', 'coord-1');
    ctx.roster!.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });

    const fuzzyInput = {
      ...WIRED_INGEST_INPUT,
      task_id: 'task-fuzzy-phase',
      phases: [
        {
          phase_id: 'ph-1',
          name: 'Core',
          deps: [],
          criteria: [
            { text: 'tests pass' }, // fuzzy — no verify
          ],
        },
      ],
    };

    await expect(invokeTool(registry, ctx, 'co_plan_ingest', fuzzyInput)).rejects.toThrow(
      /criterion violation/i,
    );

    expect(ctx.plans!.getPlan('task-fuzzy-phase')).toBeUndefined();
  });

  it('rejection message names the violating phase and criterion (named violation)', async () => {
    const ctx = makeCtx('p-ingest-fuzzy-named', 'coord-1');
    ctx.roster!.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });

    const fuzzyInput = {
      task_id: 'task-fuzzy-named',
      goal: 'G',
      task_criteria: [],
      phases: [
        {
          phase_id: 'ph-fuzzy',
          name: 'Fuzzy phase',
          deps: [],
          criteria: [{ text: 'it works' }], // fuzzy
        },
      ],
    };

    let errorMessage = '';
    try {
      await invokeTool(registry, ctx, 'co_plan_ingest', fuzzyInput);
    } catch (e) {
      errorMessage = (e as Error).message;
    }

    expect(errorMessage).toContain('task-fuzzy-named');
    expect(errorMessage).toContain('ph-fuzzy');
    expect(errorMessage).toMatch(/no wired verification command/i);
  });
});

describe('co_plan_ingest — structural DAG checks', () => {
  it('rejects a plan with a dangling dep (dep references unknown phase_id)', async () => {
    const ctx = makeCtx('p-ingest-dangling', 'coord-1');
    ctx.roster!.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });

    const danglingInput = {
      task_id: 'task-dangling',
      goal: 'G',
      task_criteria: [],
      phases: [
        {
          phase_id: 'ph-1',
          name: 'Phase 1',
          deps: ['ph-ghost'], // dangling — ph-ghost not declared
          criteria: [{ text: 'passes', verify: 'pnpm test' }],
        },
      ],
    };

    await expect(invokeTool(registry, ctx, 'co_plan_ingest', danglingInput)).rejects.toThrow(
      /dangling dep/i,
    );
    expect(ctx.plans!.getPlan('task-dangling')).toBeUndefined();
  });

  it('rejects a plan with duplicate phase_ids', async () => {
    const ctx = makeCtx('p-ingest-dup-phase', 'coord-1');
    ctx.roster!.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });

    const dupInput = {
      task_id: 'task-dup-phase',
      goal: 'G',
      task_criteria: [],
      phases: [
        { phase_id: 'ph-1', name: 'Phase 1', deps: [], criteria: [{ text: 't', verify: 'v' }] },
        {
          phase_id: 'ph-1',
          name: 'Phase 1 again',
          deps: [],
          criteria: [{ text: 't', verify: 'v' }],
        },
      ],
    };

    await expect(invokeTool(registry, ctx, 'co_plan_ingest', dupInput)).rejects.toThrow(
      /duplicate phase_id/i,
    );
    expect(ctx.plans!.getPlan('task-dup-phase')).toBeUndefined();
  });

  it('rejects a plan with a cycle in the phase DAG', async () => {
    const ctx = makeCtx('p-ingest-cycle', 'coord-1');
    ctx.roster!.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });

    const cycleInput = {
      task_id: 'task-cycle',
      goal: 'G',
      task_criteria: [],
      phases: [
        { phase_id: 'ph-a', name: 'A', deps: ['ph-b'], criteria: [{ text: 't', verify: 'v' }] },
        { phase_id: 'ph-b', name: 'B', deps: ['ph-a'], criteria: [{ text: 't', verify: 'v' }] },
      ],
    };

    await expect(invokeTool(registry, ctx, 'co_plan_ingest', cycleInput)).rejects.toThrow(/cycle/i);
    expect(ctx.plans!.getPlan('task-cycle')).toBeUndefined();
  });
});

describe('co_plan_ingest — absent stores → loud-fail (Principle 9)', () => {
  it('missing ctx.plans → throws', async () => {
    const ctx = { ...makeCtx('p-ingest-noplans', 'coord-1'), plans: undefined };
    await expect(
      invokeTool(registry, ctx as ToolContext, 'co_plan_ingest', WIRED_INGEST_INPUT),
    ).rejects.toThrow(/ctx\.plans absent/i);
  });

  it('missing ctx.roster → throws', async () => {
    const ctx = { ...makeCtx('p-ingest-noroster', 'coord-1'), roster: undefined };
    await expect(
      invokeTool(registry, ctx as ToolContext, 'co_plan_ingest', WIRED_INGEST_INPUT),
    ).rejects.toThrow(/ctx\.roster absent/i);
  });
});

describe('co_plan_ingest — completeness gate', () => {
  it('co_plan_ingest is registered and the gate stays green', () => {
    const reg = buildCoreRegistry();
    expect(checkToolCompleteness(reg)).toEqual([]);
    expect(reg.get('co_plan_ingest')).not.toBeUndefined();
  });

  it('co_plan_ingest is in the coordinator toolset only', () => {
    const reg = buildCoreRegistry();
    expect(reg.get('co_plan_ingest')).not.toBeUndefined();
    expect(ROLE_PROFILES['coordinator']?.toolset).toContain('co_plan_ingest');
    expect(ROLE_PROFILES['lead']?.toolset).not.toContain('co_plan_ingest');
    expect(ROLE_PROFILES['implementer']?.toolset).not.toContain('co_plan_ingest');
    expect(ROLE_PROFILES['reviewer']?.toolset).not.toContain('co_plan_ingest');
    expect(ROLE_PROFILES['researcher']?.toolset).not.toContain('co_plan_ingest');
  });
});
