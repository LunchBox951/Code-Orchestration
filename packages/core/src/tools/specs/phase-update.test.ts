import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMailStore, type MailStore } from '../../mail/mail-store.js';
import { openRegistry, type ProjectRegistry } from '../../registry/registry.js';
import { openRosterStore, type RosterStore } from '../../roles/roster-store.js';
import { ROLE_PROFILES } from '../../roles/profile.js';
import { openPlanStore, type PlanStore } from '../../plans/plans-store.js';
import type { PhaseNode } from '../../plans/events.js';
import { buildCoreRegistry } from '../core-registry.js';
import { checkToolCompleteness } from '../completeness.js';
import { invokeTool } from '../invoke.js';
import type { ToolContext } from '../context.js';

// Stage 15 P-D — co_phase_update: coordinator records phase.status.changed and/or phase.verified for
// an EXPLICIT (task_id, phase_id). Requires at least one of status/verified; pre-validates plan+phase;
// coordinator-only; loud-fails on absent stores.

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
  const dir = mkdtempSync(join(tmpdir(), 'co-phase-update-'));
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
];

function seedPlan(ctx: ToolContext, taskId: string): void {
  ctx.plans!.recordDraft({
    taskId,
    goal: 'G',
    taskCriteria: [{ text: 't', verify: 'pnpm test' }],
    phases: PHASES,
    actor: 'coord-1',
  });
}

function coordCtx(id: string): ToolContext {
  const ctx = makeCtx(id, 'coord-1');
  ctx.roster!.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
  return ctx;
}

const registry = buildCoreRegistry();

describe('co_phase_update — records a status change for an explicit phase', () => {
  it('advances the phase status (planned → building)', async () => {
    const ctx = coordCtx('pu-status');
    seedPlan(ctx, 'task-pu-1');
    expect(ctx.plans!.getPlan('task-pu-1')?.phases[0]?.status).toBe('planned');

    const result = (await invokeTool(registry, ctx, 'co_phase_update', {
      task_id: 'task-pu-1',
      phase_id: 'phase1',
      status: 'building',
    })) as Record<string, unknown>;
    const phases = result['phases'] as Array<{ phase_id: string; status: string }>;
    expect(phases[0]?.status).toBe('building');
    expect(ctx.plans!.getPlan('task-pu-1')?.phases[0]?.status).toBe('building');
  });
});

describe('co_phase_update — records a phase.verified outcome', () => {
  it('records verifiedPass + baselineSha for the explicit phase', async () => {
    const ctx = coordCtx('pu-verified');
    seedPlan(ctx, 'task-pu-2');

    await invokeTool(registry, ctx, 'co_phase_update', {
      task_id: 'task-pu-2',
      phase_id: 'phase1',
      verified: { baseline_sha: 'abc123', pass: true },
    });
    const stored = ctx.plans!.getPlan('task-pu-2')?.phases[0];
    expect(stored?.verifiedPass).toBe(true);
    expect(stored?.baselineSha).toBe('abc123');
  });

  it('records status AND verified together in one call', async () => {
    const ctx = coordCtx('pu-both');
    seedPlan(ctx, 'task-pu-3');

    await invokeTool(registry, ctx, 'co_phase_update', {
      task_id: 'task-pu-3',
      phase_id: 'phase1',
      status: 'verified',
      verified: { baseline_sha: 'deadbeef', pass: true },
    });
    const stored = ctx.plans!.getPlan('task-pu-3')?.phases[0];
    expect(stored?.status).toBe('verified');
    expect(stored?.verifiedPass).toBe(true);
    expect(stored?.baselineSha).toBe('deadbeef');
  });
});

describe('co_phase_update — input + existence guards', () => {
  it('refuses when neither status nor verified is supplied', async () => {
    const ctx = coordCtx('pu-empty');
    seedPlan(ctx, 'task-pu-4');
    await expect(
      invokeTool(registry, ctx, 'co_phase_update', { task_id: 'task-pu-4', phase_id: 'phase1' }),
    ).rejects.toThrow(/at least one of .*status.*verified/i);
  });

  it('refuses an unknown plan', async () => {
    const ctx = coordCtx('pu-no-plan');
    await expect(
      invokeTool(registry, ctx, 'co_phase_update', {
        task_id: 'ghost',
        phase_id: 'phase1',
        status: 'building',
      }),
    ).rejects.toThrow(/no plan recorded/i);
  });

  it('refuses an unknown phase id in a known plan', async () => {
    const ctx = coordCtx('pu-no-phase');
    seedPlan(ctx, 'task-pu-5');
    await expect(
      invokeTool(registry, ctx, 'co_phase_update', {
        task_id: 'task-pu-5',
        phase_id: 'ghost-phase',
        status: 'building',
      }),
    ).rejects.toThrow(/no phase 'ghost-phase'/i);
  });
});

describe('co_phase_update — caller must be a coordinator', () => {
  it('rejects a non-coordinator (lead) caller', async () => {
    const ctx = makeCtx('pu-noncoord', 'lead-1');
    ctx.roster!.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
    ctx.roster!.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-1' });
    seedPlan(ctx, 'task-pu-6');
    await expect(
      invokeTool(registry, ctx, 'co_phase_update', {
        task_id: 'task-pu-6',
        phase_id: 'phase1',
        status: 'building',
      }),
    ).rejects.toThrow(/co_phase_update.*requires coordinator/i);
  });
});

describe('co_phase_update — absent stores → loud-fail (Principle 9)', () => {
  it('missing ctx.plans → throws', async () => {
    const ctx = { ...makeCtx('pu-noplans', 'coord-1'), plans: undefined };
    await expect(
      invokeTool(registry, ctx as ToolContext, 'co_phase_update', {
        task_id: 'x',
        phase_id: 'phase1',
        status: 'building',
      }),
    ).rejects.toThrow(/ctx\.plans absent/i);
  });

  it('missing ctx.roster → throws', async () => {
    const ctx = { ...makeCtx('pu-noroster', 'coord-1'), roster: undefined };
    await expect(
      invokeTool(registry, ctx as ToolContext, 'co_phase_update', {
        task_id: 'x',
        phase_id: 'phase1',
        status: 'building',
      }),
    ).rejects.toThrow(/ctx\.roster absent/i);
  });
});

describe('co_phase_update — completeness + scoping', () => {
  it('is registered, gate stays green, and it is coordinator-only', () => {
    const reg = buildCoreRegistry();
    expect(checkToolCompleteness(reg)).toEqual([]);
    expect(reg.get('co_phase_update')).not.toBeUndefined();
    expect(ROLE_PROFILES['coordinator']?.toolset).toContain('co_phase_update');
    for (const role of ['lead', 'implementer', 'reviewer', 'researcher'] as const) {
      expect(ROLE_PROFILES[role]?.toolset).not.toContain('co_phase_update');
    }
  });
});
