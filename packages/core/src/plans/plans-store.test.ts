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
  EVENT_PHASE_STATUS_CHANGED,
  EVENT_PHASE_VERIFIED,
  EVENT_PLAN_DRAFTED,
  EVENT_PLAN_REPLANNED,
  EVENT_TASK_COMPLETED,
  makePlanDraftedEvent,
  makePhaseStatusChangedEvent,
  makePhaseVerifiedEvent,
  makePlanReplannedEvent,
  makeTaskCompletedEvent,
  planScope,
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
const ACTOR = 'coord-1';

function snapshot(db: DatabaseSync): string {
  const plans = db
    .prepare(
      'SELECT task_id, goal, replan_count, drafted_ts, completed_ts FROM plans ORDER BY drafted_ts, task_id',
    )
    .all();
  const phases = db
    .prepare(
      'SELECT task_id, phase_id, ordinal, name, status, verified_pass, baseline_sha FROM plan_phases ORDER BY task_id, ordinal',
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
        actor: ACTOR,
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

  it('preserves declared phase order instead of sorting lexicographically', () => {
    const store = openPlanStore('p-plans-phase-order');
    const phases = [
      { phaseId: 'ph-2', name: 'Second', deps: [], criteria: [WIRED_CRITERION] },
      { phaseId: 'ph-10', name: 'Tenth', deps: ['ph-2'], criteria: [WIRED_CRITERION] },
      { phaseId: 'ph-1', name: 'First', deps: [], criteria: [WIRED_CRITERION] },
    ];
    try {
      const drafted = store.recordDraft({
        taskId: 'task-order',
        goal: 'G',
        taskCriteria: [WIRED_CRITERION],
        phases,
        actor: ACTOR,
      });

      expect(drafted.phases.map((p) => p.phaseId)).toEqual(['ph-2', 'ph-10', 'ph-1']);
      expect(store.getPlan('task-order')?.phases.map((p) => p.phaseId)).toEqual([
        'ph-2',
        'ph-10',
        'ph-1',
      ]);
    } finally {
      store.close();
    }
  });

  it('changes phase status', () => {
    const store = openPlanStore('p-plans-status');
    try {
      store.recordDraft({
        taskId: 'task-1',
        goal: 'G',
        taskCriteria: [WIRED_CRITERION],
        phases: SAMPLE_PHASES,
        actor: ACTOR,
      });
      const after = store.changePhaseStatus('task-1', 'ph-1', 'building', ACTOR);
      expect(after.phases.find((p) => p.phaseId === 'ph-1')?.status).toBe('building');
      expect(after.phases.find((p) => p.phaseId === 'ph-2')?.status).toBe('planned');
    } finally {
      store.close();
    }
  });

  it('records phase.verified', () => {
    const store = openPlanStore('p-plans-verified');
    try {
      store.recordDraft({
        taskId: 'task-1',
        goal: 'G',
        taskCriteria: [WIRED_CRITERION],
        phases: SAMPLE_PHASES,
        actor: ACTOR,
      });
      const after = store.recordPhaseVerified('task-1', 'ph-1', 'abc123', true, ACTOR);
      const ph1 = after.phases.find((p) => p.phaseId === 'ph-1')!;
      expect(ph1.verifiedPass).toBe(true);
      expect(ph1.baselineSha).toBe('abc123');
    } finally {
      store.close();
    }
  });

  it('records task.completed and sets completedTs from event.ts', () => {
    const projectId = 'p-plans-completed';
    const store = openPlanStore(projectId);
    try {
      const drafted = store.recordDraft({
        taskId: 'task-1',
        goal: 'G',
        taskCriteria: [WIRED_CRITERION],
        phases: SAMPLE_PHASES,
        actor: ACTOR,
      });
      expect(drafted.completedTs).toBeUndefined();
      store.changePhaseStatus('task-1', 'ph-1', 'merged', ACTOR);
      store.changePhaseStatus('task-1', 'ph-2', 'merged', ACTOR);
      store.recordPhaseVerified('task-1', 'ph-1', 'base-a', true, ACTOR);
      store.recordPhaseVerified('task-1', 'ph-2', 'base-b', true, ACTOR);
      const after = store.recordTaskCompleted('task-1', 'coord-done');
      expect(after.completedTs).toBeGreaterThan(0);
      // The fold sets completed_ts WITHOUT mutating phase status or replan count.
      expect(after.replanCount).toBe(0);
      expect(after.phases).toHaveLength(2);

      // The terminal close is appended to the audit trail as task.completed by the recording actor.
      const audit = openProjectStore(projectId);
      try {
        const events = audit.readStream(planScope('task-1'));
        expect(events.at(-1)?.type).toBe(EVENT_TASK_COMPLETED);
        expect(events.at(-1)?.actor).toBe('coord-done');
      } finally {
        audit.close();
      }
    } finally {
      store.close();
    }
  });

  it('recordTaskCompleted is idempotent after the terminal event is recorded', () => {
    const projectId = 'p-plans-completed-idempotent';
    const store = openPlanStore(projectId);
    try {
      store.recordDraft({
        taskId: 'task-1',
        goal: 'G',
        taskCriteria: [WIRED_CRITERION],
        phases: SAMPLE_PHASES,
        actor: ACTOR,
      });
      store.changePhaseStatus('task-1', 'ph-1', 'merged', ACTOR);
      store.changePhaseStatus('task-1', 'ph-2', 'merged', ACTOR);
      store.recordPhaseVerified('task-1', 'ph-1', 'base-a', true, ACTOR);
      store.recordPhaseVerified('task-1', 'ph-2', 'base-b', true, ACTOR);
      const first = store.recordTaskCompleted('task-1', 'coord-done');
      const second = store.recordTaskCompleted('task-1', 'coord-retry');
      expect(second.completedTs).toBe(first.completedTs);

      const audit = openProjectStore(projectId);
      try {
        const completedEvents = audit
          .readStream(planScope('task-1'))
          .filter((event) => event.type === EVENT_TASK_COMPLETED);
        expect(completedEvents).toHaveLength(1);
        expect(completedEvents[0]?.actor).toBe('coord-done');
      } finally {
        audit.close();
      }
    } finally {
      store.close();
    }
  });

  it('refuses even same-content re-draft after task.completed', () => {
    const store = openPlanStore('p-plans-completed-redraft');
    try {
      const draft = {
        taskId: 'task-1',
        goal: 'G',
        taskCriteria: [WIRED_CRITERION],
        phases: SAMPLE_PHASES,
        actor: ACTOR,
      };
      store.recordDraft(draft);
      store.changePhaseStatus('task-1', 'ph-1', 'merged', ACTOR);
      store.changePhaseStatus('task-1', 'ph-2', 'merged', ACTOR);
      store.recordPhaseVerified('task-1', 'ph-1', 'base-a', true, ACTOR);
      store.recordPhaseVerified('task-1', 'ph-2', 'base-b', true, ACTOR);
      store.recordTaskCompleted('task-1', 'coord-done');

      expect(() => store.recordDraft(draft)).toThrow(/already completed.*terminal/i);
    } finally {
      store.close();
    }
  });

  it('refuses phase mutations and replans after task.completed', () => {
    const projectId = 'p-plans-completed-terminal';
    const store = openPlanStore(projectId);
    try {
      store.recordDraft({
        taskId: 'task-1',
        goal: 'G',
        taskCriteria: [WIRED_CRITERION],
        phases: SAMPLE_PHASES,
        actor: ACTOR,
      });
      store.changePhaseStatus('task-1', 'ph-1', 'merged', ACTOR);
      store.changePhaseStatus('task-1', 'ph-2', 'merged', ACTOR);
      store.recordPhaseVerified('task-1', 'ph-1', 'base-a', true, ACTOR);
      store.recordPhaseVerified('task-1', 'ph-2', 'base-b', true, ACTOR);
      const completed = store.recordTaskCompleted('task-1', 'coord-done');

      expect(() => store.changePhaseStatus('task-1', 'ph-1', 'building', ACTOR)).toThrow(
        /already completed.*terminal/i,
      );
      expect(() => store.recordPhaseVerified('task-1', 'ph-1', 'abc123', true, ACTOR)).toThrow(
        /already completed.*terminal/i,
      );
      expect(() =>
        store.recordReplan(
          'task-1',
          'late scope change',
          [{ phaseId: 'ph-new', name: 'New', deps: [], criteria: [WIRED_CRITERION] }],
          ACTOR,
        ),
      ).toThrow(/already completed.*terminal/i);

      expect(store.getPlan('task-1')).toEqual(completed);
      const audit = openProjectStore(projectId);
      try {
        expect(audit.readStream(planScope('task-1')).map((event) => event.type)).toEqual([
          EVENT_PLAN_DRAFTED,
          EVENT_PHASE_STATUS_CHANGED,
          EVENT_PHASE_STATUS_CHANGED,
          EVENT_PHASE_VERIFIED,
          EVENT_PHASE_VERIFIED,
          EVENT_TASK_COMPLETED,
        ]);
      } finally {
        audit.close();
      }
    } finally {
      store.close();
    }
  });

  it('refuses task.completed until every phase is merged and verified green', () => {
    const store = openPlanStore('p-plans-completed-preconditions');
    try {
      store.recordDraft({
        taskId: 'task-1',
        goal: 'G',
        taskCriteria: [WIRED_CRITERION],
        phases: SAMPLE_PHASES,
        actor: ACTOR,
      });
      expect(() => store.recordTaskCompleted('task-1', 'coord-done')).toThrow(
        /not 'merged'.*ph-1.*ph-2/i,
      );
      store.changePhaseStatus('task-1', 'ph-1', 'merged', ACTOR);
      store.changePhaseStatus('task-1', 'ph-2', 'merged', ACTOR);
      expect(() => store.recordTaskCompleted('task-1', 'coord-done')).toThrow(
        /not verified green.*ph-1.*ph-2/i,
      );
      store.recordPhaseVerified('task-1', 'ph-1', 'base-a', true, ACTOR);
      store.recordPhaseVerified('task-1', 'ph-2', 'base-b', false, ACTOR);
      expect(() => store.recordTaskCompleted('task-1', 'coord-done')).toThrow(
        /not verified green.*ph-2/i,
      );
    } finally {
      store.close();
    }
  });

  it('task.completed for an unknown plan fails loud (Principle 9)', () => {
    const store = openPlanStore('p-plans-completed-unknown');
    try {
      expect(() => store.recordTaskCompleted('ghost-task', ACTOR)).toThrow(/unknown plan/i);
    } finally {
      store.close();
    }
  });

  it('records a replan and increments replanCount', () => {
    const store = openPlanStore('p-plans-replan');
    try {
      store.recordDraft({
        taskId: 'task-1',
        goal: 'G',
        taskCriteria: [WIRED_CRITERION],
        phases: SAMPLE_PHASES,
        actor: ACTOR,
      });
      const newPhases = [
        { phaseId: 'ph-new', name: 'New Phase', deps: [], criteria: [WIRED_CRITERION] },
      ];
      const after = store.recordReplan('task-1', 'scope changed', newPhases, ACTOR);
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
      store.recordDraft({
        taskId: 'task-1',
        goal: 'G',
        taskCriteria: [WIRED_CRITERION],
        phases: SAMPLE_PHASES,
        actor: ACTOR,
      });
      store.recordReplan('task-1', 'reason 1', SAMPLE_PHASES, ACTOR);
      const after = store.recordReplan('task-1', 'reason 2', SAMPLE_PHASES, ACTOR);
      expect(after.replanCount).toBe(2);
    } finally {
      store.close();
    }
  });

  it('records the caller actor and replan reason in the event audit trail', () => {
    const projectId = 'p-plans-actor-audit';
    const store = openPlanStore(projectId);
    try {
      store.recordDraft({
        taskId: 'task-1',
        goal: 'G',
        taskCriteria: [WIRED_CRITERION],
        phases: SAMPLE_PHASES,
        actor: 'coord-1',
      });
      store.changePhaseStatus('task-1', 'ph-1', 'building', 'lead-1');
      store.recordPhaseVerified('task-1', 'ph-1', 'abc123', true, 'tester-1');
      store.recordReplan('task-1', 'scope changed after review', SAMPLE_PHASES, 'lead-1');

      const audit = openProjectStore(projectId);
      try {
        const events = audit.readStream(planScope('task-1'));
        expect(events.map((e) => [e.type, e.actor])).toEqual([
          [EVENT_PLAN_DRAFTED, 'coord-1'],
          [EVENT_PHASE_STATUS_CHANGED, 'lead-1'],
          [EVENT_PHASE_VERIFIED, 'tester-1'],
          [EVENT_PLAN_REPLANNED, 'lead-1'],
        ]);
        expect(events.at(-1)?.payload).toMatchObject({ reason: 'scope changed after review' });
      } finally {
        audit.close();
      }
    } finally {
      store.close();
    }
  });
});

describe('PlanStore — getPlan / listPlans', () => {
  it('getPlan returns the record and undefined for absent', () => {
    const store = openPlanStore('p-plans-get');
    try {
      store.recordDraft({
        taskId: 'task-get-1',
        goal: 'G',
        taskCriteria: [WIRED_CRITERION],
        phases: SAMPLE_PHASES,
        actor: ACTOR,
      });
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
      store.recordDraft({
        taskId: 'task-a',
        goal: 'G',
        taskCriteria: [WIRED_CRITERION],
        phases: SAMPLE_PHASES,
        actor: ACTOR,
      });
      store.recordDraft({
        taskId: 'task-b',
        goal: 'G',
        taskCriteria: [WIRED_CRITERION],
        phases: SAMPLE_PHASES,
        actor: ACTOR,
      });
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
        actor: ACTOR,
      });
      const second = store.recordDraft({
        taskId: 'task-idem',
        goal: 'G',
        taskCriteria: [WIRED_CRITERION],
        phases: SAMPLE_PHASES,
        actor: ACTOR,
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
      store.recordDraft({
        taskId: 'task-1',
        goal: 'original',
        taskCriteria: [WIRED_CRITERION],
        phases: SAMPLE_PHASES,
        actor: ACTOR,
      });
      expect(() =>
        store.recordDraft({
          taskId: 'task-1',
          goal: 'different',
          taskCriteria: [WIRED_CRITERION],
          phases: SAMPLE_PHASES,
          actor: ACTOR,
        }),
      ).toThrow(/conflicting re-draft/i);
    } finally {
      store.close();
    }
  });

  it('phase.status.changed for unknown phaseId throws', () => {
    const store = openPlanStore('p-plans-unknown-phase-status');
    try {
      store.recordDraft({
        taskId: 'task-1',
        goal: 'G',
        taskCriteria: [WIRED_CRITERION],
        phases: SAMPLE_PHASES,
        actor: ACTOR,
      });
      expect(() => store.changePhaseStatus('task-1', 'ghost-phase', 'building', ACTOR)).toThrow(
        /unknown phaseId/i,
      );
    } finally {
      store.close();
    }
  });

  it('phase.verified for unknown phaseId throws', () => {
    const store = openPlanStore('p-plans-unknown-phase-verified');
    try {
      store.recordDraft({
        taskId: 'task-1',
        goal: 'G',
        taskCriteria: [WIRED_CRITERION],
        phases: SAMPLE_PHASES,
        actor: ACTOR,
      });
      expect(() =>
        store.recordPhaseVerified('task-1', 'ghost-phase', 'sha123', true, ACTOR),
      ).toThrow(/unknown phaseId/i);
    } finally {
      store.close();
    }
  });

  it('phase.status.changed for unknown plan throws', () => {
    const store = openPlanStore('p-plans-no-plan-status');
    try {
      expect(() => store.changePhaseStatus('ghost-plan', 'ph-1', 'building', ACTOR)).toThrow(
        /unknown plan/i,
      );
    } finally {
      store.close();
    }
  });

  it('replan for unknown plan throws', () => {
    const store = openPlanStore('p-plans-no-plan-replan');
    try {
      expect(() => store.recordReplan('ghost-plan', 'reason', SAMPLE_PHASES, ACTOR)).toThrow(
        /unknown plan/i,
      );
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
      makeTaskCompletedEvent('p-plans-replay', { taskId: 'task-2' }, 'coord-1'),
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
      // task-2 was completed → its completed_ts survives the replay (non-vacuous; from event.ts).
      expect(live).toMatch(/"completed_ts":\d+/);
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

  it('replay fails loud when an event mutates a completed task', () => {
    const projectId = 'p-plans-replay-completed-terminal';
    const store = openProjectStore(projectId);
    const events = [
      makePlanDraftedEvent(
        projectId,
        { taskId: 'task-1', goal: 'original', taskCriteria: [], phases: SAMPLE_PHASES },
        'coord-1',
      ),
      makePhaseStatusChangedEvent(
        projectId,
        { taskId: 'task-1', phaseId: 'ph-1', status: 'merged' },
        'coord-1',
      ),
      makePhaseStatusChangedEvent(
        projectId,
        { taskId: 'task-1', phaseId: 'ph-2', status: 'merged' },
        'coord-1',
      ),
      makePhaseVerifiedEvent(
        projectId,
        { taskId: 'task-1', phaseId: 'ph-1', baselineSha: 'base-a', pass: true },
        'coord-1',
      ),
      makePhaseVerifiedEvent(
        projectId,
        { taskId: 'task-1', phaseId: 'ph-2', baselineSha: 'base-b', pass: true },
        'coord-1',
      ),
      makeTaskCompletedEvent(projectId, { taskId: 'task-1' }, 'coord-1'),
      makePhaseStatusChangedEvent(
        projectId,
        { taskId: 'task-1', phaseId: 'ph-1', status: 'building' },
        'coord-1',
      ),
    ];
    try {
      store.append(events);
      expect(() =>
        rebuildAll(store, [new PlansProjector()], (e) => decode(e, plansUpcasters, plansSchemas)),
      ).toThrow(/after task\.completed.*terminal/i);
    } finally {
      store.close();
    }
  });

  it('replay fails loud when a same-content plan.drafted arrives after task.completed', () => {
    const projectId = 'p-plans-replay-completed-redraft';
    const store = openProjectStore(projectId);
    const draftPayload = {
      taskId: 'task-1',
      goal: 'original',
      taskCriteria: [],
      phases: SAMPLE_PHASES,
    };
    const drafted = makePlanDraftedEvent(projectId, draftPayload, 'coord-1');
    const events = [
      drafted,
      makePhaseStatusChangedEvent(
        projectId,
        { taskId: 'task-1', phaseId: 'ph-1', status: 'merged' },
        'coord-1',
      ),
      makePhaseStatusChangedEvent(
        projectId,
        { taskId: 'task-1', phaseId: 'ph-2', status: 'merged' },
        'coord-1',
      ),
      makePhaseVerifiedEvent(
        projectId,
        { taskId: 'task-1', phaseId: 'ph-1', baselineSha: 'base-a', pass: true },
        'coord-1',
      ),
      makePhaseVerifiedEvent(
        projectId,
        { taskId: 'task-1', phaseId: 'ph-2', baselineSha: 'base-b', pass: true },
        'coord-1',
      ),
      makeTaskCompletedEvent(projectId, { taskId: 'task-1' }, 'coord-1'),
      makePlanDraftedEvent(projectId, draftPayload, 'coord-1'),
    ];
    try {
      store.append(events);
      expect(() =>
        rebuildAll(store, [new PlansProjector()], (e) => decode(e, plansUpcasters, plansSchemas)),
      ).toThrow(/after task\.completed.*terminal/i);
    } finally {
      store.close();
    }
  });

  it('replay fails loud when task.completed arrives before all phases merged + verified', () => {
    const projectId = 'p-plans-replay-completed-premature';
    const store = openProjectStore(projectId);
    const events = [
      makePlanDraftedEvent(
        projectId,
        { taskId: 'task-1', goal: 'original', taskCriteria: [], phases: SAMPLE_PHASES },
        'coord-1',
      ),
      makeTaskCompletedEvent(projectId, { taskId: 'task-1' }, 'coord-1'),
    ];
    try {
      store.append(events);
      expect(() =>
        rebuildAll(store, [new PlansProjector()], (e) => decode(e, plansUpcasters, plansSchemas)),
      ).toThrow(/not 'merged'.*ph-1.*ph-2/i);
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
        taskCriteria: [WIRED_CRITERION],
        phases: SAMPLE_PHASES,
        actor: ACTOR,
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
        store.recordDraft({
          taskId: 'task-1',
          goal: 'G',
          taskCriteria: [WIRED_CRITERION],
          phases: SAMPLE_PHASES,
          actor: ACTOR,
        });
        store.changePhaseStatus('task-1', 'ph-1', 'building', ACTOR);
        expect(store.getPlan('task-1')).not.toBeUndefined();
        expect(store.listPlans()).toHaveLength(1);
      } finally {
        store.close();
      }
    });
  });
});
