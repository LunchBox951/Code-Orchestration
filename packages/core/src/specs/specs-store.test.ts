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
  makeSpecDraftedEvent,
  makeSpecLockedEvent,
  specsSchemas,
  specsUpcasters,
} from './events.js';
import { SpecsProjector } from './specs-projector.js';
import { openSpecStore } from './specs-store.js';

// L6b F1 — durable spec record store: record, read-back, replay-equal, and lifecycle transitions.

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let repoDirs: string[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  repoDirs = [];
  const dir = mkdtempSync(join(tmpdir(), 'co-specs-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'co-specs-repo-'));
  repoDirs.push(dir);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}

const SAMPLE_CRITERIA = [
  { text: 'spec record is queryable by task id', verify: 'pnpm vitest run packages/core' },
  { text: 'idempotent re-draft succeeds' },
];

function snapshot(db: DatabaseSync): string {
  const rows = db
    .prepare(
      'SELECT task_id, state, locked_by, drafted_ts, locked_ts, archived_ts FROM specs ORDER BY drafted_ts, task_id',
    )
    .all();
  return JSON.stringify(rows);
}

describe('SpecStore — draft → lock → archive roundtrip', () => {
  it('records a draft, lock, and archive in sequence', () => {
    const store = openSpecStore('p-specs-roundtrip');
    try {
      const drafted = store.recordDraft({
        taskId: 'task-1',
        title: 'My Spec',
        goal: 'Achieve something',
        criteria: SAMPLE_CRITERIA,
        body: 'Full body text.',
        actor: 'coord-1',
      });

      expect(drafted.taskId).toBe('task-1');
      expect(drafted.title).toBe('My Spec');
      expect(drafted.goal).toBe('Achieve something');
      expect(drafted.criteria).toEqual(SAMPLE_CRITERIA);
      expect(drafted.body).toBe('Full body text.');
      expect(drafted.state).toBe('draft');
      expect(drafted.draftedTs).toBeGreaterThan(0);
      expect(drafted.lockedTs).toBeUndefined();
      expect(drafted.archivedTs).toBeUndefined();

      const locked = store.recordLock('task-1', 'coord-1');
      expect(locked.state).toBe('locked');
      expect(locked.lockedBy).toBe('coord-1');
      expect(locked.lockedTs).toBeGreaterThan(0);
      expect(locked.archivedTs).toBeUndefined();

      const archived = store.recordArchive('task-1');
      expect(archived.state).toBe('archived');
      expect(archived.archivedTs).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it('getSpec returns the record and undefined for absent', () => {
    const store = openSpecStore('p-specs-get');
    try {
      store.recordDraft({
        taskId: 'task-get-1',
        title: 'T',
        goal: 'G',
        criteria: [],
        body: '',
        actor: 'a',
      });
      const rec = store.getSpec('task-get-1');
      expect(rec).not.toBeUndefined();
      expect(rec?.taskId).toBe('task-get-1');
      expect(store.getSpec('absent')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('listSpecs returns all specs in drafted_ts order', () => {
    const store = openSpecStore('p-specs-list');
    try {
      store.recordDraft({
        taskId: 'task-a',
        title: 'A',
        goal: 'G',
        criteria: [],
        body: '',
        actor: 'x',
      });
      store.recordDraft({
        taskId: 'task-b',
        title: 'B',
        goal: 'G',
        criteria: [],
        body: '',
        actor: 'x',
      });
      const list = store.listSpecs();
      expect(list).toHaveLength(2);
      expect(list[0]?.taskId).toBe('task-a');
      expect(list[1]?.taskId).toBe('task-b');
    } finally {
      store.close();
    }
  });
});

describe('SpecStore — idempotent re-assert', () => {
  it('idempotent re-draft (byte-identical) returns existing without error', () => {
    const store = openSpecStore('p-specs-idem-draft');
    try {
      const first = store.recordDraft({
        taskId: 'task-idem',
        title: 'T',
        goal: 'G',
        criteria: SAMPLE_CRITERIA,
        body: 'B',
        actor: 'a',
      });
      const second = store.recordDraft({
        taskId: 'task-idem',
        title: 'T',
        goal: 'G',
        criteria: SAMPLE_CRITERIA,
        body: 'B',
        actor: 'a',
      });
      expect(second.taskId).toBe(first.taskId);
      expect(second.draftedTs).toBe(first.draftedTs);
      expect(store.listSpecs()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('idempotent re-lock (same lockedBy) returns existing without error', () => {
    const store = openSpecStore('p-specs-idem-lock');
    try {
      store.recordDraft({
        taskId: 'task-1',
        title: 'T',
        goal: 'G',
        criteria: [],
        body: '',
        actor: 'a',
      });
      const first = store.recordLock('task-1', 'coord-1');
      const second = store.recordLock('task-1', 'coord-1');
      expect(second.lockedBy).toBe('coord-1');
      expect(second.lockedTs).toBe(first.lockedTs);
    } finally {
      store.close();
    }
  });

  it('idempotent re-archive returns existing without error', () => {
    const store = openSpecStore('p-specs-idem-archive');
    try {
      store.recordDraft({
        taskId: 'task-1',
        title: 'T',
        goal: 'G',
        criteria: [],
        body: '',
        actor: 'a',
      });
      const first = store.recordArchive('task-1');
      const second = store.recordArchive('task-1');
      expect(second.state).toBe('archived');
      expect(second.archivedTs).toBe(first.archivedTs);
    } finally {
      store.close();
    }
  });
});

describe('SpecStore — loud-fail on illegal transitions', () => {
  it('conflicting re-draft throws', () => {
    const store = openSpecStore('p-specs-conflict-draft');
    try {
      store.recordDraft({
        taskId: 'task-1',
        title: 'T',
        goal: 'G',
        criteria: [],
        body: 'original',
        actor: 'a',
      });
      expect(() =>
        store.recordDraft({
          taskId: 'task-1',
          title: 'T',
          goal: 'G',
          criteria: [],
          body: 'different',
          actor: 'a',
        }),
      ).toThrow(/conflicting re-draft/i);
    } finally {
      store.close();
    }
  });

  it('locking a non-existent spec throws', () => {
    const store = openSpecStore('p-specs-lock-absent');
    try {
      expect(() => store.recordLock('ghost', 'coord-1')).toThrow(/no draft exists/i);
    } finally {
      store.close();
    }
  });

  it('locking an archived spec throws', () => {
    const store = openSpecStore('p-specs-lock-archived');
    try {
      store.recordDraft({
        taskId: 'task-1',
        title: 'T',
        goal: 'G',
        criteria: [],
        body: '',
        actor: 'a',
      });
      store.recordArchive('task-1');
      expect(() => store.recordLock('task-1', 'coord-1')).toThrow(/already archived/i);
    } finally {
      store.close();
    }
  });

  it('re-locking by a different lockedBy throws', () => {
    const store = openSpecStore('p-specs-lock-conflict');
    try {
      store.recordDraft({
        taskId: 'task-1',
        title: 'T',
        goal: 'G',
        criteria: [],
        body: '',
        actor: 'a',
      });
      store.recordLock('task-1', 'coord-1');
      expect(() => store.recordLock('task-1', 'coord-2')).toThrow(/already locked/i);
    } finally {
      store.close();
    }
  });

  it('archiving a non-existent spec throws', () => {
    const store = openSpecStore('p-specs-archive-absent');
    try {
      expect(() => store.recordArchive('ghost')).toThrow(/no draft exists/i);
    } finally {
      store.close();
    }
  });

  it('can archive a draft spec directly (draft → archived)', () => {
    const store = openSpecStore('p-specs-archive-draft');
    try {
      store.recordDraft({
        taskId: 'task-1',
        title: 'T',
        goal: 'G',
        criteria: [],
        body: '',
        actor: 'a',
      });
      const archived = store.recordArchive('task-1');
      expect(archived.state).toBe('archived');
    } finally {
      store.close();
    }
  });
});

describe('SpecStore — replay-equal: live fold → rebuildAll → byte-equal', () => {
  it('live fold → snapshot → rebuildAll → snapshot is byte-equal (non-vacuous)', () => {
    const store = openProjectStore('p-specs-replay');
    const projectors = [new SpecsProjector()];
    const events = [
      makeSpecDraftedEvent(
        'p-specs-replay',
        {
          taskId: 'task-1',
          title: 'My Spec',
          goal: 'Do X',
          criteria: SAMPLE_CRITERIA,
          body: 'body',
        },
        'coord-1',
      ),
      makeSpecLockedEvent('p-specs-replay', { taskId: 'task-1', lockedBy: 'coord-1' }),
      makeSpecDraftedEvent(
        'p-specs-replay',
        { taskId: 'task-2', title: 'Spec 2', goal: 'Do Y', criteria: [], body: '' },
        'coord-1',
      ),
    ];
    try {
      for (const e of events) {
        store.transaction((tx) => {
          const [s] = tx.append([e]);
          applyEvent(tx, decode(s!, specsUpcasters, specsSchemas), projectors);
        });
      }

      const live = store.transaction((tx) => snapshot(tx.raw as DatabaseSync));

      rebuildAll(store, projectors, (e) => decode(e, specsUpcasters, specsSchemas));
      const replayed = store.transaction((tx) => snapshot(tx.raw as DatabaseSync));

      expect(replayed).toBe(live);
      expect(live).toContain('"task-1"');
      expect(live).toContain('"locked"');
      expect(live).toContain('"coord-1"');
    } finally {
      store.close();
    }
  });

  it('replay fails loud on conflicting re-draft', () => {
    const store = openProjectStore('p-specs-replay-conflict');
    const events = [
      makeSpecDraftedEvent(
        'p-specs-replay-conflict',
        { taskId: 'task-1', title: 'T', goal: 'G', criteria: [], body: 'original' },
        'a',
      ),
      makeSpecDraftedEvent(
        'p-specs-replay-conflict',
        { taskId: 'task-1', title: 'T', goal: 'G', criteria: [], body: 'changed' },
        'a',
      ),
    ];
    try {
      store.append(events);
      expect(() =>
        rebuildAll(store, [new SpecsProjector()], (e) => decode(e, specsUpcasters, specsSchemas)),
      ).toThrow(/conflicting re-draft/i);
    } finally {
      store.close();
    }
  });

  it('timestamps come from event.ts (not wall-clock)', () => {
    const store = openSpecStore('p-specs-ts');
    try {
      const spec = store.recordDraft({
        taskId: 'task-ts',
        title: 'T',
        goal: 'G',
        criteria: [],
        body: '',
        actor: 'a',
      });
      expect(spec.draftedTs).toBeGreaterThan(0);
      expect(typeof spec.draftedTs).toBe('number');
    } finally {
      store.close();
    }
  });
});

describe('SpecStore — pristine-repo round-trip', () => {
  it('a full record + read round-trip leaves the repo byte-identical', () => {
    const repoDir = makeRepo();
    assertRepoPristine(repoDir, () => {
      const store = openSpecStore('p-specs-pristine');
      try {
        store.recordDraft({
          taskId: 'task-1',
          title: 'T',
          goal: 'G',
          criteria: [],
          body: '',
          actor: 'a',
        });
        store.recordLock('task-1', 'a');
        expect(store.getSpec('task-1')).not.toBeUndefined();
        expect(store.listSpecs()).toHaveLength(1);
      } finally {
        store.close();
      }
    });
  });
});
