import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMailStore, type MailStore } from '../../mail/mail-store.js';
import { openReviewStore, type ReviewStore } from '../../review/review-store.js';
import { openRosterStore, type RosterStore } from '../../roles/roster-store.js';
import { openWorktreeStore, type WorktreeStore } from '../../worktrees/worktree-store.js';
import { openPlanStore, type PlanStore } from '../../plans/plans-store.js';
import { openProjectStore } from '../../store/sqlite-store.js';
import type { Criterion } from '../../specs/criteria-schema.js';
import { buildCoreRegistry } from '../core-registry.js';
import { checkToolCompleteness } from '../completeness.js';
import { toolsForRole } from '../scoping.js';
import { invokeTool } from '../invoke.js';
import type { ToolContext } from '../context.js';

// L6b E3/D5 — co_phase_status: coordinator+lead read-only phase-readiness report. Asserts the role
// gate (coordinator AND lead allowed, others rejected), that it records NOTHING (head unchanged),
// and the correct rollup from seeded stores — exercising the two invariants through the real stores.

const PID = 'p-phase-status';
const TASK = 'task-1';
const OWNER_BRANCH = 'co/phase-a-integration'; // the Lead/owner's integration branch (merge target)
const ACTOR = 'lead-1';

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let mailStores: MailStore[] = [];
let reviewStores: ReviewStore[] = [];
let rosterStores: RosterStore[] = [];
let worktreeStores: WorktreeStore[] = [];
let planStores: PlanStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  mailStores = [];
  reviewStores = [];
  rosterStores = [];
  worktreeStores = [];
  planStores = [];
  const dir = mkdtempSync(join(tmpdir(), 'co-phase-status-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const m of mailStores) m.close();
  for (const r of reviewStores) r.close();
  for (const r of rosterStores) r.close();
  for (const w of worktreeStores) w.close();
  for (const p of planStores) p.close();
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
  mailStores = [];
  reviewStores = [];
  rosterStores = [];
  worktreeStores = [];
  planStores = [];
});

interface Stores {
  mail: MailStore;
  reviews: ReviewStore;
  roster: RosterStore;
  worktrees: WorktreeStore;
  plans: PlanStore;
}

function openStores(id: string = PID): Stores {
  const mail = openMailStore(id);
  mailStores.push(mail);
  const reviews = openReviewStore(id);
  reviewStores.push(reviews);
  const roster = openRosterStore(id);
  rosterStores.push(roster);
  const worktrees = openWorktreeStore(id);
  worktreeStores.push(worktrees);
  const plans = openPlanStore(id);
  planStores.push(plans);
  return { mail, reviews, roster, worktrees, plans };
}

function makeCtx(
  agentId: string,
  stores: Stores,
  overrides: Partial<ToolContext> = {},
): ToolContext {
  return {
    agent: agentId,
    projectId: PID,
    cwd: '/fake/cwd',
    mail: stores.mail,
    registry: { resolve: () => PID } as never,
    reviews: stores.reviews,
    roster: stores.roster,
    worktrees: stores.worktrees,
    plans: stores.plans,
    ...overrides,
  };
}

const crit: Criterion[] = [{ text: 'it works', verify: 'pnpm test' }];

/** Seed a worktree record assigning `branch` to `agent`. */
function seedWorktree(stores: Stores, agent: string, branch: string, parent: string): void {
  stores.worktrees.recordWorktree({
    branch,
    baseRef: OWNER_BRANCH,
    baseSha: 'b'.repeat(40),
    path: `/fake/worktrees/${branch}`,
    parent,
    agent,
  });
}

/** Record a PASS verdict marking `branch` merged into `target`. */
function seedPass(stores: Stores, target: string, branch: string, reviewId: string): void {
  stores.reviews.recordVerdict({
    reviewId,
    target,
    branch,
    reviewer: 'reviewer-1',
    verdict: 'PASS',
    blockers: [],
    suggestions: [],
  });
}

/**
 * Seed a single-phase plan `pA` owned by `lead-1`, with the roster tree
 * coord-1 → lead-1 → {impl-1, impl-2, rev-1}, and a worktree for the owner + each worker.
 */
function seedTree(stores: Stores): void {
  stores.roster.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
  stores.roster.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-1' });
  stores.roster.recordAgent({ agentId: 'impl-1', role: 'implementer', parent: 'lead-1' });
  stores.roster.recordAgent({ agentId: 'impl-2', role: 'implementer', parent: 'lead-1' });
  stores.roster.recordAgent({ agentId: 'rev-1', role: 'reviewer', parent: 'lead-1' });

  seedWorktree(stores, 'lead-1', OWNER_BRANCH, 'coord-1');
  seedWorktree(stores, 'impl-1', 'co/w1', 'lead-1');
  seedWorktree(stores, 'impl-2', 'co/w2', 'lead-1');
  seedWorktree(stores, 'rev-1', 'co/rev', 'lead-1');

  stores.plans.recordDraft({
    taskId: TASK,
    goal: 'ship phase A',
    taskCriteria: crit,
    phases: [{ phaseId: 'pA', name: 'Phase A', owner: 'lead-1', deps: [], criteria: crit }],
    actor: ACTOR,
  });
}

const registry = buildCoreRegistry();

type PhaseStatusOut = {
  task_id: string;
  ready: boolean;
  phases: Array<{
    phase_id: string;
    status: string;
    ready: boolean;
    reasons_not_ready: string[];
  }>;
};

describe('co_phase_status — role gate (coordinator AND lead; others rejected)', () => {
  it('a coordinator may call it', async () => {
    const stores = openStores();
    seedTree(stores);
    const out = (await invokeTool(registry, makeCtx('coord-1', stores), 'co_phase_status', {
      task_id: TASK,
    })) as PhaseStatusOut;
    expect(out.task_id).toBe(TASK);
    expect(out.phases).toHaveLength(1);
  });

  it('a lead may call it', async () => {
    const stores = openStores();
    seedTree(stores);
    const out = (await invokeTool(registry, makeCtx('lead-1', stores), 'co_phase_status', {
      task_id: TASK,
    })) as PhaseStatusOut;
    expect(out.task_id).toBe(TASK);
  });

  it('an implementer is rejected', async () => {
    const stores = openStores();
    seedTree(stores);
    await expect(
      invokeTool(registry, makeCtx('impl-1', stores), 'co_phase_status', { task_id: TASK }),
    ).rejects.toThrow(/requires coordinator or lead/i);
  });

  it('a reviewer is rejected', async () => {
    const stores = openStores();
    seedTree(stores);
    await expect(
      invokeTool(registry, makeCtx('rev-1', stores), 'co_phase_status', { task_id: TASK }),
    ).rejects.toThrow(/requires coordinator or lead/i);
  });

  it('a caller absent from the roster is rejected', async () => {
    const stores = openStores();
    seedTree(stores);
    await expect(
      invokeTool(registry, makeCtx('ghost', stores), 'co_phase_status', { task_id: TASK }),
    ).rejects.toThrow(/not registered in the roster/i);
  });
});

describe('co_phase_status — read-only (records NOTHING)', () => {
  it('does not advance the event log head', async () => {
    const stores = openStores();
    seedTree(stores);
    seedPass(stores, OWNER_BRANCH, 'co/w1', 'rev-w1');
    seedPass(stores, OWNER_BRANCH, 'co/w2', 'rev-w2');
    stores.plans.recordPhaseVerified(TASK, 'pA', 'b'.repeat(40), true, ACTOR);

    const probe = openProjectStore(PID);
    try {
      const before = probe.head();
      await invokeTool(registry, makeCtx('coord-1', stores), 'co_phase_status', { task_id: TASK });
      await invokeTool(registry, makeCtx('lead-1', stores), 'co_phase_status', { task_id: TASK });
      expect(probe.head()).toBe(before);
    } finally {
      probe.close();
    }
  });
});

describe('co_phase_status — correct rollup from seeded stores', () => {
  it('READY: both impl workers merged (reviewer excluded) + phase verified', async () => {
    const stores = openStores();
    seedTree(stores);
    seedPass(stores, OWNER_BRANCH, 'co/w1', 'rev-w1');
    seedPass(stores, OWNER_BRANCH, 'co/w2', 'rev-w2');
    // rev-1 stays unmerged — it must be excluded from completion accounting.
    stores.plans.recordPhaseVerified(TASK, 'pA', 'b'.repeat(40), true, ACTOR);
    // The lifecycle status is independent of the verified outcome; advance it as a Lead would, and
    // assert it passes through to the output (the readiness flag is driven by verifiedPass, not status).
    stores.plans.changePhaseStatus(TASK, 'pA', 'verified', ACTOR);

    const out = (await invokeTool(registry, makeCtx('coord-1', stores), 'co_phase_status', {
      task_id: TASK,
    })) as PhaseStatusOut;

    expect(out.ready).toBe(true);
    expect(out.phases[0]).toMatchObject({
      phase_id: 'pA',
      status: 'verified',
      ready: true,
      reasons_not_ready: [],
    });
  });

  it('NOT READY: an impl worker is unmerged → its reason is named, reviewer NOT named', async () => {
    const stores = openStores();
    seedTree(stores);
    seedPass(stores, OWNER_BRANCH, 'co/w1', 'rev-w1'); // impl-1 merged; impl-2 NOT merged
    stores.plans.recordPhaseVerified(TASK, 'pA', 'b'.repeat(40), true, ACTOR);

    const out = (await invokeTool(registry, makeCtx('lead-1', stores), 'co_phase_status', {
      task_id: TASK,
    })) as PhaseStatusOut;

    expect(out.ready).toBe(false);
    expect(out.phases[0]!.reasons_not_ready).toEqual(['worker impl-2 branch not merged']);
    expect(out.phases[0]!.reasons_not_ready.join(' ')).not.toContain('rev-1');
  });

  it('NOT READY: workers merged but no green phase.verified', async () => {
    const stores = openStores();
    seedTree(stores);
    seedPass(stores, OWNER_BRANCH, 'co/w1', 'rev-w1');
    seedPass(stores, OWNER_BRANCH, 'co/w2', 'rev-w2');
    // No recordPhaseVerified → verifiedPass absent.

    const out = (await invokeTool(registry, makeCtx('coord-1', stores), 'co_phase_status', {
      task_id: TASK,
    })) as PhaseStatusOut;

    expect(out.ready).toBe(false);
    expect(out.phases[0]!.reasons_not_ready).toEqual([
      'phase not verified (no green phase.verified)',
    ]);
  });

  it('throws when no plan is recorded for the task', async () => {
    const stores = openStores();
    stores.roster.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
    await expect(
      invokeTool(registry, makeCtx('coord-1', stores), 'co_phase_status', { task_id: 'absent' }),
    ).rejects.toThrow(/no plan recorded/i);
  });
});

describe('co_phase_status — store-presence loud-fails (Principle 9)', () => {
  it('throws when ctx.plans is absent', async () => {
    const stores = openStores();
    seedTree(stores);
    await expect(
      invokeTool(registry, makeCtx('coord-1', stores, { plans: undefined }), 'co_phase_status', {
        task_id: TASK,
      }),
    ).rejects.toThrow(/ctx\.plans absent/i);
  });

  it('throws when ctx.reviews is absent', async () => {
    const stores = openStores();
    seedTree(stores);
    await expect(
      invokeTool(registry, makeCtx('coord-1', stores, { reviews: undefined }), 'co_phase_status', {
        task_id: TASK,
      }),
    ).rejects.toThrow(/ctx\.reviews absent/i);
  });

  it('throws when ctx.roster is absent', async () => {
    const stores = openStores();
    seedTree(stores);
    await expect(
      invokeTool(registry, makeCtx('coord-1', stores, { roster: undefined }), 'co_phase_status', {
        task_id: TASK,
      }),
    ).rejects.toThrow(/ctx\.roster absent/i);
  });

  it('throws when ctx.worktrees is absent', async () => {
    const stores = openStores();
    seedTree(stores);
    await expect(
      invokeTool(
        registry,
        makeCtx('coord-1', stores, { worktrees: undefined }),
        'co_phase_status',
        {
          task_id: TASK,
        },
      ),
    ).rejects.toThrow(/ctx\.worktrees absent/i);
  });
});

describe('co_phase_status — completeness gate + scoping', () => {
  it('is registered, complete, and scoped to coordinator + lead', () => {
    expect(buildCoreRegistry().has('co_phase_status')).toBe(true);
    expect(checkToolCompleteness(buildCoreRegistry())).toEqual([]);
    expect(toolsForRole('coordinator').map((t) => t.name)).toContain('co_phase_status');
    expect(toolsForRole('lead').map((t) => t.name)).toContain('co_phase_status');
    expect(toolsForRole('implementer').map((t) => t.name)).not.toContain('co_phase_status');
    expect(toolsForRole('reviewer').map((t) => t.name)).not.toContain('co_phase_status');
    expect(toolsForRole('researcher').map((t) => t.name)).not.toContain('co_phase_status');
  });
});
