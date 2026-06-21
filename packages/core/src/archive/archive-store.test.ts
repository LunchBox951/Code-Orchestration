import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openProjectStore } from '../store/sqlite-store.js';
import { applyEvent, rebuildAll } from '../replay/projector.js';
import { decode } from '../replay/decode.js';
import {
  makeArchiveAppendedEvent,
  makeArchiveRemovedEvent,
  archiveSchemas,
  archiveUpcasters,
} from './events.js';
import { ArchiveProjector } from './archive-projector.js';
import { openArchiveStore } from './archive-store.js';

// AC-A3 — event-sourced archive store: reaper boundary, round-trip, removeRecord, replay-equal.

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  const dir = mkdtempSync(join(tmpdir(), 'co-archive-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
});

function snapshot(db: DatabaseSync): string {
  const rows = db
    .prepare(
      'SELECT id, name, branch, base_ref, deleted_at, expires_at FROM archive ORDER BY deleted_at, id',
    )
    .all();
  return JSON.stringify(rows);
}

// ── Validation tests ──────────────────────────────────────────────────────────

describe('makeArchiveAppendedEvent — fail-loud validation', () => {
  it('rejects empty id', () => {
    expect(() =>
      makeArchiveAppendedEvent('p1', {
        id: '',
        name: 'n1',
        branch: 'co/x',
        baseRef: 'main',
        deletedAt: 1000,
        expiresAt: 2000,
      }),
    ).toThrow();
  });

  it('rejects empty name', () => {
    expect(() =>
      makeArchiveAppendedEvent('p1', {
        id: 'a1',
        name: '',
        branch: 'co/x',
        baseRef: 'main',
        deletedAt: 1000,
        expiresAt: 2000,
      }),
    ).toThrow();
  });

  it('rejects negative expiresAt', () => {
    expect(() =>
      makeArchiveAppendedEvent('p1', {
        id: 'a1',
        name: 'n1',
        branch: 'co/x',
        baseRef: 'main',
        deletedAt: 1000,
        expiresAt: -1,
      }),
    ).toThrow();
  });

  it('rejects negative deletedAt', () => {
    expect(() =>
      makeArchiveAppendedEvent('p1', {
        id: 'a1',
        name: 'n1',
        branch: 'co/x',
        baseRef: 'main',
        deletedAt: -1,
        expiresAt: 2000,
      }),
    ).toThrow();
  });

  it('builds a valid event', () => {
    const ev = makeArchiveAppendedEvent('p1', {
      id: 'a1',
      name: 'n1',
      branch: 'co/x',
      baseRef: 'main',
      deletedAt: 1000,
      expiresAt: 2000,
    });
    expect(ev.type).toBe('archive.appended');
    expect(ev.scope).toBe('archive:a1');
  });
});

describe('makeArchiveRemovedEvent — fail-loud validation', () => {
  it('rejects empty id', () => {
    expect(() => makeArchiveRemovedEvent('p1', { id: '' })).toThrow();
  });
});

// ── Core store tests ──────────────────────────────────────────────────────────

describe('ArchiveStore — reaper boundary + round-trip', () => {
  it('listExpired returns only records strictly before nowMs; removeRecord drops one', () => {
    const store = openArchiveStore('p-archive-reap');
    try {
      store.appendRecord({
        id: 'a1',
        name: 'n1',
        branch: 'co/x',
        baseRef: 'main',
        deletedAt: 1000,
        expiresAt: 2000,
      });
      store.appendRecord({
        id: 'a2',
        name: 'n2',
        branch: 'co/y',
        baseRef: 'main',
        deletedAt: 1000,
        expiresAt: 5000,
      });
      expect(store.listExpired(2001).map((r) => r.id)).toEqual(['a1']);
      expect(store.listExpired(2000)).toHaveLength(0); // strict '<' boundary
      const removed = store.removeRecord('a1');
      expect(removed?.id).toBe('a1');
      expect(store.getRecord('a1')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('appendRecord → getRecord round-trip', () => {
    const store = openArchiveStore('p-archive-roundtrip');
    try {
      const rec = store.appendRecord({
        id: 'b1',
        name: 'my-coord',
        branch: 'co/feature',
        baseRef: 'dev',
        deletedAt: 5000,
        expiresAt: 10000,
      });
      expect(rec.id).toBe('b1');
      expect(rec.name).toBe('my-coord');
      expect(rec.branch).toBe('co/feature');
      expect(rec.baseRef).toBe('dev');
      expect(rec.deletedAt).toBe(5000);
      expect(rec.expiresAt).toBe(10000);

      const fetched = store.getRecord('b1');
      expect(fetched).toEqual(rec);
      expect(store.getRecord('absent')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('listRecords returns all records in stable order', () => {
    const store = openArchiveStore('p-archive-list');
    try {
      store.appendRecord({
        id: 'z1',
        name: 'n1',
        branch: 'co/z',
        baseRef: 'main',
        deletedAt: 3000,
        expiresAt: 6000,
      });
      store.appendRecord({
        id: 'a1',
        name: 'n2',
        branch: 'co/a',
        baseRef: 'main',
        deletedAt: 1000,
        expiresAt: 4000,
      });
      store.appendRecord({
        id: 'm1',
        name: 'n3',
        branch: 'co/m',
        baseRef: 'main',
        deletedAt: 2000,
        expiresAt: 5000,
      });
      const list = store.listRecords();
      expect(list).toHaveLength(3);
      // Ordered by deleted_at, id
      expect(list[0]!.id).toBe('a1');
      expect(list[1]!.id).toBe('m1');
      expect(list[2]!.id).toBe('z1');
    } finally {
      store.close();
    }
  });

  it('removeRecord on missing id returns undefined', () => {
    const store = openArchiveStore('p-archive-remove-missing');
    try {
      const result = store.removeRecord('nonexistent');
      expect(result).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('persists across store re-open (same project id)', () => {
    const a = openArchiveStore('p-archive-persist');
    try {
      a.appendRecord({
        id: 'x1',
        name: 'nx',
        branch: 'co/x',
        baseRef: 'main',
        deletedAt: 100,
        expiresAt: 200,
      });
    } finally {
      a.close();
    }
    const b = openArchiveStore('p-archive-persist');
    try {
      expect(b.getRecord('x1')?.name).toBe('nx');
    } finally {
      b.close();
    }
  });
});

// ── AC replay-equality test ───────────────────────────────────────────────────

describe('AC-A3 — replay equality: live fold → rebuildAll → byte-equal', () => {
  it('live fold → snapshot → rebuildAll → snapshot is byte-equal (non-vacuous)', () => {
    const store = openProjectStore('p-archive-replay');
    const projectors = [new ArchiveProjector()];
    const projectId = 'p-archive-replay';

    const events = [
      makeArchiveAppendedEvent(projectId, {
        id: 'r1',
        name: 'coord-1',
        branch: 'co/r1',
        baseRef: 'main',
        deletedAt: 1000,
        expiresAt: 2000,
      }),
      makeArchiveAppendedEvent(projectId, {
        id: 'r2',
        name: 'coord-2',
        branch: 'co/r2',
        baseRef: 'dev',
        deletedAt: 2000,
        expiresAt: 4000,
      }),
      makeArchiveAppendedEvent(projectId, {
        id: 'r3',
        name: 'coord-3',
        branch: 'co/r3',
        baseRef: 'main',
        deletedAt: 3000,
        expiresAt: 6000,
      }),
      makeArchiveRemovedEvent(projectId, { id: 'r1' }),
    ];

    try {
      for (const e of events) {
        store.transaction((tx) => {
          const [s] = tx.append([e]);
          applyEvent(tx, decode(s!, archiveUpcasters, archiveSchemas), projectors);
        });
      }

      const live = store.transaction((tx) => snapshot(tx.raw as DatabaseSync));

      rebuildAll(store, projectors, (e) => decode(e, archiveUpcasters, archiveSchemas));
      const replayed = store.transaction((tx) => snapshot(tx.raw as DatabaseSync));

      expect(replayed).toBe(live);
      // Guard against vacuous pass — r1 was removed, r2 and r3 remain
      expect(live).toContain('"r2"');
      expect(live).toContain('"coord-2"');
      expect(live).toContain('"r3"');
      expect(live).not.toContain('"r1"');
      const parsed = JSON.parse(live) as unknown[];
      expect(parsed).toHaveLength(2);
    } finally {
      store.close();
    }
  });
});
