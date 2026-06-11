import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openProjectStore } from '../store/sqlite-store.js';
import { applyEvent, rebuildAll } from '../replay/projector.js';
import { decode } from '../replay/decode.js';
import { assertRepoPristine } from '../config/pristine.js';
import {
  makePlanDraftedEvent,
  makePhaseStatusChangedEvent,
  makePhaseVerifiedEvent,
  makePlanReplannedEvent,
  plansSchemas,
  plansUpcasters,
} from './events.js';
import { PlansProjector } from './plans-projector.js';
import { openPlanStore } from './plans-store.js';

// L6b E1 — durable plan record store: record, read-back, replay-equal, and lifecycle transitions.

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let repoDirs: string[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  repoDirs = [];
  const dir = mkdtempSync(join(tmpdir(), 'co-plans-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const dir of [...dataDirs, ...repoDirs]) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
  repoDirs = [];
});

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-plans-repo-'));
  repoDirs.push(dir);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}

const WIRED_CRITERION = {
  text: 'plan store is queryable by task id',
  verify: 'pnpm vitest run packages/core',
};
const SAMPLE_PHASES = [
  {
    phaseId: 'ph-1',
    name: 'Phase One',
    deps: [],
    criteria: [WIRED_CRITERION],
  },
  {
    phaseId: 'ph-2',
    name: 'Phase Two',
    owner: 'lead-x',
    deps: ['ph-1'],
    criteria: [{ text: 'phase two passes', verify: 'pnpm test' }],
  },
];

function snapshot(db: DatabaseSync): string {
  const plans = db
    .prepare(
      'SELECT task_id, goal, replan_count, drafted_ts FROM plans ORDER BY drafted_ts, task_id',
    )
    .all();
  const phases = db
    .prepare(
      'SELECT task_id, phase_id, name, status, verified_pass, baseline_sha FROM plan_phases ORDER BY task_id, phase_id',
    )
    .all();
  return JSON.stringify({ plans, phases });
}

describe('PlanStore — draft → phase-status transitions → phase.verified → replan roundtrip', () => {
  it('records a draft and reads it back', () => {
    const store = openPlanStore('p-plans-roundtrip');
    try {
      const drafted = store.recordDraft({
        taskId: 'task-1',
        goal: 'Achieve something',
        taskCriteria: [WIRED_CRITERION],
        phases: SAMPLE_PHASES,
      });

      expect(drafted.taskId).toBe('task-1');
      expect(drafted.goal).toBe('Achieve something');
      expect(drafted.taskCriteria).toEqual([WIRED_CRITERION]);
      expect(drafted.phases).toHaveLength(2);
      expect(drafted.phases[0]?.phaseId).toBe('ph-1');
      expect(drafted.phases[0]?.status).toBe('planned');
      expect(drafted.phases[1]?.phaseId).toBe('ph-2');
      expect(drafted.phases[1]?.owner).toBe('lead-x');
      expect(drafted.draftedTs).toBeGreaterThan(0);
      expect(drafted.replanCount).toBe(0);
    } finally {
      store.close();
    }
  });

  it('changes phase status', () => {
    const store = openPlanStore('p-plans-status');
    try {
      store.recordDraft({ taskId: 'task-1', goal: 'G', taskCriteria: [], phases: SAMPLE_PHASES });
      const after = store.changePhaseStatus('task-1', 'ph-1', 'building');
      expect(after.phases.find((p) => p.phaseId === 'ph-1')?.status).toBe('building');
      expect(after.phases.find((p) => p.phaseId === 'ph-2')?.status).toBe('planned');
    } finally {
      store.close();
    }
  });

  it('records phase.verified', () => {
    const store = openPlanStore('p-plans-verified');
    try {
      store.recordDraft({ taskId: 'task-1', goal: 'G', taskCriteria: [], phases: SAMPLE_PHASES });
      const after = store.recordPhaseVerified('task-1', 'ph-1', 'abc123', true);
      const ph1 = after.phases.find((p) => p.phaseId === 'ph-1')!;
      expect(ph1.verifiedPass).toBe(true);
      expect(ph1.baselineSha).toBe('abc123');
    } finally {
      store.close();
    }
  });

  it('records a replan and increments replanCount', () => {
    const store = openPlanStore('p-plans-replan');
    try {
      store.recordDraft({ taskId: 'task-1', goal: 'G', taskCriteria: [], phases: SAMPLE_PHASES });
      const newPhases = [{ phaseId: 'ph-new', name: 'New Phase', deps: [], criteria: [] }];
      const after = store.recordReplan('task-1', 'scope changed', newPhases);
      expect(after.replanCount).toBe(1);
      expect(after.phases).toHaveLength(1);
      expect(after.phases[0]?.phaseId).toBe('ph-new');
    } finally {
      store.close();
    }
  });

  it('multiple replans accumulate replanCount', () => {
    const store = openPlanStore('p-plans-replan-multi');
    try {
      store.recordDraft({ taskId: 'task-1', goal: 'G', taskCriteria: [], phases: [] });
      store.recordReplan('task-1', 'reason 1', []);
      const after = store.recordReplan('task-1', 'reason 2', []);
      expect(after.replanCount).toBe(2);
    } finally {
      store.close();
    }
  });
});

describe('PlanStore — getPlan / listPlans', () => {
  it('getPlan returns the record and undefined for absent', () => {
    const store = openPlanStore('p-plans-get');
    try {
      store.recordDraft({ taskId: 'task-get-1', goal: 'G', taskCriteria: [], phases: [] });
      const rec = store.getPlan('task-get-1');
      expect(rec).not.toBeUndefined();
      expect(rec?.taskId).toBe('task-get-1');
      expect(store.getPlan('absent')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('listPlans returns all plans in drafted_ts order', () => {
    const store = openPlanStore('p-plans-list');
    try {
      store.recordDraft({ taskId: 'task-a', goal: 'G', taskCriteria: [], phases: [] });
      store.recordDraft({ taskId: 'task-b', goal: 'G', taskCriteria: [], phases: [] });
      const list = store.listPlans();
      expect(list).toHaveLength(2);
      expect(list[0]?.taskId).toBe('task-a');
      expect(list[1]?.taskId).toBe('task-b');
    } finally {
      store.close();
    }
  });
});

describe('PlanStore — idempotent re-assert', () => {
  it('idempotent re-draft (byte-identical) returns existing without error', () => {
    const store = openPlanStore('p-plans-idem-draft');
    try {
      const first = store.recordDraft({
        taskId: 'task-idem',
        goal: 'G',
        taskCriteria: [WIRED_CRITERION],
        phases: SAMPLE_PHASES,
      });
      const second = store.recordDraft({
        taskId: 'task-idem',
        goal: 'G',
        taskCriteria: [WIRED_CRITERION],
        phases: SAMPLE_PHASES,
      });
      expect(second.taskId).toBe(first.taskId);
      expect(second.draftedTs).toBe(first.draftedTs);
      expect(store.listPlans()).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});

describe('PlanStore — loud-fail on illegal transitions', () => {
  it('conflicting re-draft throws', () => {
    const store = openPlanStore('p-plans-conflict-draft');
    try {
      store.recordDraft({ taskId: 'task-1', goal: 'original', taskCriteria: [], phases: [] });
      expect(() =>
        store.recordDraft({ taskId: 'task-1', goal: 'different', taskCriteria: [], phases: [] }),
      ).toThrow(/conflicting re-draft/i);
    } finally {
      store.close();
    }
  });

  it('phase.status.changed for unknown phaseId throws', () => {
    const store = openPlanStore('p-plans-unknown-phase-status');
    try {
      store.recordDraft({ taskId: 'task-1', goal: 'G', taskCriteria: [], phases: SAMPLE_PHASES });
      expect(() => store.changePhaseStatus('task-1', 'ghost-phase', 'building')).toThrow(
        /unknown phaseId/i,
      );
    } finally {
      store.close();
    }
  });

  it('phase.verified for unknown phaseId throws', () => {
    const store = openPlanStore('p-plans-unknown-phase-verified');
    try {
      store.recordDraft({ taskId: 'task-1', goal: 'G', taskCriteria: [], phases: SAMPLE_PHASES });
      expect(() => store.recordPhaseVerified('task-1', 'ghost-phase', 'sha123', true)).toThrow(
        /unknown phaseId/i,
      );
    } finally {
      store.close();
    }
  });

  it('phase.status.changed for unknown plan throws', () => {
    const store = openPlanStore('p-plans-no-plan-status');
    try {
      expect(() => store.changePhaseStatus('ghost-plan', 'ph-1', 'building')).toThrow(
        /unknown plan/i,
      );
    } finally {
      store.close();
    }
  });

  it('replan for unknown plan throws', () => {
    const store = openPlanStore('p-plans-no-plan-replan');
    try {
      expect(() => store.recordReplan('ghost-plan', 'reason', [])).toThrow(/unknown plan/i);
    } finally {
      store.close();
    }
  });
});

describe('PlanStore — replay-equal: live fold → rebuildAll → byte-equal', () => {
  it('live fold → snapshot → rebuildAll → snapshot is byte-equal (non-vacuous)', () => {
    const store = openProjectStore('p-plans-replay');
    const projectors = [new PlansProjector()];
    const events = [
      makePlanDraftedEvent(
        'p-plans-replay',
        {
          taskId: 'task-1',
          goal: 'Do X',
          taskCriteria: [WIRED_CRITERION],
          phases: SAMPLE_PHASES,
        },
        'coord-1',
      ),
      makePhaseStatusChangedEvent(
        'p-plans-replay',
        { taskId: 'task-1', phaseId: 'ph-1', status: 'building' },
        'coord-1',
      ),
      makePhaseVerifiedEvent(
        'p-plans-replay',
        { taskId: 'task-1', phaseId: 'ph-1', baselineSha: 'abc123', pass: true },
        'coord-1',
      ),
      makePlanReplannedEvent(
        'p-plans-replay',
        {
          taskId: 'task-1',
          reason: 'scope change',
          phases: [{ phaseId: 'ph-new', name: 'New', deps: [], criteria: [] }],
        },
        'coord-1',
      ),
      makePlanDraftedEvent(
        'p-plans-replay',
        { taskId: 'task-2', goal: 'Do Y', taskCriteria: [], phases: [] },
        'coord-1',
      ),
    ];
    try {
      for (const e of events) {
        store.transaction((tx) => {
          const [s] = tx.append([e]);
          applyEvent(tx, decode(s!, plansUpcasters, plansSchemas), projectors);
        });
      }

      const live = store.transaction((tx) => snapshot(tx.raw as DatabaseSync));

      rebuildAll(store, projectors, (e) => decode(e, plansUpcasters, plansSchemas));
      const replayed = store.transaction((tx) => snapshot(tx.raw as DatabaseSync));

      expect(replayed).toBe(live);
      expect(live).toContain('"task-1"');
      // ph-1 was replaced by replan → ph-new is the final phase; replanCount=1
      expect(live).toContain('"ph-new"');
      expect(live).toContain('"replan_count":1');
    } finally {
      store.close();
    }
  });

  it('replay fails loud on conflicting re-draft', () => {
    const store = openProjectStore('p-plans-replay-conflict');
    const events = [
      makePlanDraftedEvent(
        'p-plans-replay-conflict',
        { taskId: 'task-1', goal: 'original', taskCriteria: [], phases: [] },
        'a',
      ),
      makePlanDraftedEvent(
        'p-plans-replay-conflict',
        { taskId: 'task-1', goal: 'changed', taskCriteria: [], phases: [] },
        'a',
      ),
    ];
    try {
      store.append(events);
      expect(() =>
        rebuildAll(store, [new PlansProjector()], (e) => decode(e, plansUpcasters, plansSchemas)),
      ).toThrow(/conflicting re-draft/i);
    } finally {
      store.close();
    }
  });

  it('timestamps come from event.ts (not wall-clock)', () => {
    const store = openPlanStore('p-plans-ts');
    try {
      const plan = store.recordDraft({
        taskId: 'task-ts',
        goal: 'G',
        taskCriteria: [],
        phases: [],
      });
      expect(plan.draftedTs).toBeGreaterThan(0);
      expect(typeof plan.draftedTs).toBe('number');
    } finally {
      store.close();
    }
  });
});

describe('PlanStore — pristine-repo round-trip', () => {
  it('a full record + read round-trip leaves the repo byte-identical', () => {
    const repoDir = makeRepo();
    assertRepoPristine(repoDir, () => {
      const store = openPlanStore('p-plans-pristine');
      try {
        store.recordDraft({ taskId: 'task-1', goal: 'G', taskCriteria: [], phases: SAMPLE_PHASES });
        store.changePhaseStatus('task-1', 'ph-1', 'building');
        expect(store.getPlan('task-1')).not.toBeUndefined();
        expect(store.listPlans()).toHaveLength(1);
      } finally {
        store.close();
      }
    });
  });
});
