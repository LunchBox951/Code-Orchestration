import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMailStore, type MailStore } from '../../mail/mail-store.js';
import { openRegistry, type ProjectRegistry } from '../../registry/registry.js';
import { openRosterStore, type RosterStore } from '../../roles/roster-store.js';
import { ROLE_PROFILES } from '../../roles/profile.js';
import { openPlanStore, type PlanStore } from '../../plans/plans-store.js';
import type { PhaseNode, PhaseStatus } from '../../plans/events.js';
import { buildCoreRegistry } from '../core-registry.js';
import { checkToolCompleteness } from '../completeness.js';
import { invokeTool } from '../invoke.js';
import type { ToolContext } from '../context.js';

// Stage 15 P-D — co_task_complete: coordinator records the terminal task.completed once EVERY phase
// has merged with green verification; refuses premature completion (a phase not 'merged' or not
// verified), an unknown plan, and a non-coordinator caller; loud-fails when ctx.plans / ctx.roster are
// absent.

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
  const dir = mkdtempSync(join(tmpdir(), 'co-task-complete-'));
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
});

function makeCtx(id: string, agent: string, overrides: Partial<ToolContext> = {}): ToolContext {
  const mail = openMailStore(id);
  mailStores.push(mail);
  const plans = openPlanStore(id);
  planStores.push(plans);
  const roster = openRosterStore(id);
  rosterStores.push(roster);
  const registry = openRegistry();
  registries.push(registry);
  return { agent, projectId: id, cwd: '/tmp', mail, registry, plans, roster, ...overrides };
}

const PHASES: PhaseNode[] = [
  { phaseId: 'phase1', name: 'Phase 1', deps: [], criteria: [{ text: 't1', verify: 'pnpm test' }] },
  {
    phaseId: 'phase2',
    name: 'Phase 2',
    deps: ['phase1'],
    criteria: [{ text: 't2', verify: 'pnpm test' }],
  },
];

/** Seed a 2-phase plan, then drive each named phase to `merged` (the completion precondition). */
function seedPlan(ctx: ToolContext, taskId: string, mergedPhases: readonly string[]): void {
  ctx.plans!.recordDraft({
    taskId,
    goal: 'G',
    taskCriteria: [{ text: 't', verify: 'pnpm test' }],
    phases: PHASES,
    actor: 'coord-1',
  });
  for (const phaseId of mergedPhases) {
    ctx.plans!.changePhaseStatus(taskId, phaseId, 'merged' as PhaseStatus, 'coord-1');
  }
}

const registry = buildCoreRegistry();

describe('co_task_complete — records task.completed when every phase has merged', () => {
  it('records the terminal close and surfaces completedTs in the durable record', async () => {
    const ctx = makeCtx('tc-all-merged', 'coord-1');
    ctx.roster!.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
    seedPlan(ctx, 'task-tc-1', ['phase1', 'phase2']);
    ctx.plans!.recordPhaseVerified('task-tc-1', 'phase1', 'base-a', true, 'coord-1');
    ctx.plans!.recordPhaseVerified('task-tc-1', 'phase2', 'base-b', true, 'coord-1');

    expect(ctx.plans!.getPlan('task-tc-1')?.completedTs).toBeUndefined();

    const result = (await invokeTool(registry, ctx, 'co_task_complete', {
      task_id: 'task-tc-1',
    })) as Record<string, unknown>;
    expect(result['task_id']).toBe('task-tc-1');

    const stored = ctx.plans!.getPlan('task-tc-1');
    expect(stored?.completedTs).toBeGreaterThan(0);
  });
});

describe('co_task_complete — premature-completion guard (deterministic safety)', () => {
  it('refuses while a phase is not merged, naming the offending phase + its status', async () => {
    const ctx = makeCtx('tc-not-merged', 'coord-1');
    ctx.roster!.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
    seedPlan(ctx, 'task-tc-2', ['phase1']); // phase2 left 'planned'

    await expect(
      invokeTool(registry, ctx, 'co_task_complete', { task_id: 'task-tc-2' }),
    ).rejects.toThrow(/not 'merged'.*phase2.*planned/i);
    expect(ctx.plans!.getPlan('task-tc-2')?.completedTs).toBeUndefined();
  });

  it('refuses when no plan is recorded for the task', async () => {
    const ctx = makeCtx('tc-no-plan', 'coord-1');
    ctx.roster!.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });

    await expect(
      invokeTool(registry, ctx, 'co_task_complete', { task_id: 'ghost' }),
    ).rejects.toThrow(/no plan recorded/i);
  });

  it('refuses a merged phase that has no green verification record', async () => {
    const ctx = makeCtx('tc-merged-unverified', 'coord-1');
    ctx.roster!.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
    seedPlan(ctx, 'task-tc-2b', ['phase1', 'phase2']);

    await expect(
      invokeTool(registry, ctx, 'co_task_complete', { task_id: 'task-tc-2b' }),
    ).rejects.toThrow(/not verified.*phase1.*phase2/i);
    expect(ctx.plans!.getPlan('task-tc-2b')?.completedTs).toBeUndefined();
  });

  it('refuses a merged phase whose latest verification failed', async () => {
    const ctx = makeCtx('tc-merged-failed-verification', 'coord-1');
    ctx.roster!.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
    seedPlan(ctx, 'task-tc-2c', ['phase1', 'phase2']);
    ctx.plans!.recordPhaseVerified('task-tc-2c', 'phase1', 'base-a', true, 'coord-1');
    ctx.plans!.recordPhaseVerified('task-tc-2c', 'phase2', 'base-b', false, 'coord-1');

    await expect(
      invokeTool(registry, ctx, 'co_task_complete', { task_id: 'task-tc-2c' }),
    ).rejects.toThrow(/not verified.*phase2/i);
    expect(ctx.plans!.getPlan('task-tc-2c')?.completedTs).toBeUndefined();
  });
});

describe('co_task_complete — caller must be a coordinator', () => {
  it('rejects a non-coordinator (lead) caller', async () => {
    const ctx = makeCtx('tc-noncoord', 'lead-1');
    ctx.roster!.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
    ctx.roster!.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-1' });
    seedPlan(ctx, 'task-tc-3', ['phase1', 'phase2']);

    await expect(
      invokeTool(registry, ctx, 'co_task_complete', { task_id: 'task-tc-3' }),
    ).rejects.toThrow(/co_task_complete.*requires coordinator/i);
    expect(ctx.plans!.getPlan('task-tc-3')?.completedTs).toBeUndefined();
  });
});

describe('co_task_complete — absent stores → loud-fail (Principle 9)', () => {
  it('missing ctx.plans → throws', async () => {
    const ctx = { ...makeCtx('tc-noplans', 'coord-1'), plans: undefined };
    await expect(
      invokeTool(registry, ctx as ToolContext, 'co_task_complete', { task_id: 'x' }),
    ).rejects.toThrow(/ctx\.plans absent/i);
  });

  it('missing ctx.roster → throws', async () => {
    const ctx = { ...makeCtx('tc-noroster', 'coord-1'), roster: undefined };
    await expect(
      invokeTool(registry, ctx as ToolContext, 'co_task_complete', { task_id: 'x' }),
    ).rejects.toThrow(/ctx\.roster absent/i);
  });
});

describe('co_task_complete — completeness + scoping', () => {
  it('is registered, gate stays green, and it is coordinator-only', () => {
    const reg = buildCoreRegistry();
    expect(checkToolCompleteness(reg)).toEqual([]);
    expect(reg.get('co_task_complete')).not.toBeUndefined();
    expect(ROLE_PROFILES['coordinator']?.toolset).toContain('co_task_complete');
    for (const role of ['lead', 'implementer', 'reviewer', 'researcher'] as const) {
      expect(ROLE_PROFILES[role]?.toolset).not.toContain('co_task_complete');
    }
  });
});
