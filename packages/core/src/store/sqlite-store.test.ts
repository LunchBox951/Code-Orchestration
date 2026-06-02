import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openGlobalStore, openProjectStore } from './sqlite-store.js';
import type { NewEvent } from './types.js';

const ORIGINAL_ENV = process.env;
let dataDir: string;

function event(overrides: Partial<NewEvent> = {}): NewEvent {
  return { projectId: 'p', scope: 's', type: 't', v: 1, payload: {}, ...overrides };
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDir = mkdtempSync(join(tmpdir(), 'co-store-'));
  process.env.CO_DATA_DIR = dataDir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('SqliteStore.append', () => {
  it('assigns consecutive monotonic seq starting at 1 and a numeric ts; head() reflects it', () => {
    const store = openProjectStore('p1');
    try {
      expect(store.head()).toBe(0);
      const out = store.append([
        event({ payload: { a: 1 } }),
        event({ payload: { b: 2 } }),
        event({ payload: { c: 3 } }),
      ]);
      expect(out.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(typeof out[0]!.ts).toBe('number');
      expect(out[0]!.ts).toBeGreaterThan(0);
      expect(store.head()).toBe(3);
    } finally {
      store.close();
    }
  });

  it('round-trips an object payload through append and read (by value, not reference)', () => {
    const store = openProjectStore('p1');
    try {
      const payload = { nested: { arr: [1, 2, 3], s: 'x' }, n: 42, b: true, nil: null };
      const [appended] = store.append([event({ payload })]);
      expect(appended!.payload).toEqual(payload);
      // Returned payload is a JSON round-trip, not the caller's reference.
      expect(appended!.payload).not.toBe(payload);

      const [readBack] = store.readAll();
      expect(readBack!.payload).toEqual(payload);
    } finally {
      store.close();
    }
  });
});

describe('SqliteStore.readStream', () => {
  it('filters by scope, honors afterSeq and limit, and orders by seq', () => {
    const store = openProjectStore('p1');
    try {
      store.append([
        event({ scope: 'a', payload: { i: 1 } }), // seq 1
        event({ scope: 'b', payload: { i: 2 } }), // seq 2
        event({ scope: 'a', payload: { i: 3 } }), // seq 3
        event({ scope: 'a', payload: { i: 4 } }), // seq 4
      ]);

      expect(store.readStream('a').map((e) => e.seq)).toEqual([1, 3, 4]);
      expect(store.readStream('b').map((e) => e.seq)).toEqual([2]);
      expect(store.readStream('a', { afterSeq: 1 }).map((e) => e.seq)).toEqual([3, 4]);
      expect(store.readStream('a', { limit: 2 }).map((e) => e.seq)).toEqual([1, 3]);
      expect(store.readStream('a', { afterSeq: 1, limit: 1 }).map((e) => e.seq)).toEqual([3]);
    } finally {
      store.close();
    }
  });
});

describe('SqliteStore.transaction', () => {
  it('rolls back every append when the fn throws, leaving head() unchanged', () => {
    const store = openProjectStore('p1');
    try {
      expect(store.head()).toBe(0);
      expect(() =>
        store.transaction((tx) => {
          tx.append([event(), event()]);
          throw new Error('boom');
        }),
      ).toThrowError('boom');
      expect(store.head()).toBe(0);
      expect(store.readAll()).toHaveLength(0);

      // A subsequent successful append commits normally.
      const out = store.append([event()]);
      expect(out).toHaveLength(1);
      expect(store.head()).toBe(1);
    } finally {
      store.close();
    }
  });

  it('commits all appended events when the fn returns', () => {
    const store = openProjectStore('p1');
    try {
      const out = store.transaction((tx) => tx.append([event(), event()]));
      expect(out.map((e) => e.seq)).toEqual([1, 2]);
      expect(store.head()).toBe(2);
      expect(store.readAll()).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it('rejects nested transactions', () => {
    const store = openProjectStore('p1');
    try {
      expect(() =>
        store.transaction(() => {
          store.transaction(() => undefined);
        }),
      ).toThrowError(/nested transactions/);
    } finally {
      store.close();
    }
  });
});

describe('open helpers', () => {
  it('openProjectStore creates its db under CO_DATA_DIR at projects/<id>/store.db', () => {
    const store = openProjectStore('proj-1');
    try {
      store.append([event({ projectId: 'proj-1' })]);
    } finally {
      store.close();
    }
    expect(existsSync(join(dataDir, 'projects', 'proj-1', 'store.db'))).toBe(true);
  });

  it('openGlobalStore creates global.db under CO_DATA_DIR and stores the caller projectId', () => {
    const store = openGlobalStore();
    try {
      const [stored] = store.append([event({ projectId: '@global', scope: 'registry' })]);
      expect(stored!.projectId).toBe('@global');
    } finally {
      store.close();
    }
    expect(existsSync(join(dataDir, 'global.db'))).toBe(true);
  });
});

describe('reserved L1 envelope columns', () => {
  it('declares actor / causation_id / correlation_id / idempotency_key as NULL for L0 events', () => {
    const store = openProjectStore('p1');
    try {
      const [appended] = store.append([event()]);
      // These columns are reserved (Part B §3 D2) and intentionally absent from
      // the Part C.1 read API, so inspect the raw row via the tx handle.
      const row = store.transaction((tx) =>
        (tx.raw as DatabaseSync)
          .prepare(
            'SELECT actor, causation_id, correlation_id, idempotency_key FROM events WHERE seq = ?',
          )
          .get(appended!.seq),
      );
      expect(row).toEqual({
        actor: null,
        causation_id: null,
        correlation_id: null,
        idempotency_key: null,
      });
    } finally {
      store.close();
    }
  });
});

describe('determinism', () => {
  it('persists ts at append time and does not re-derive it on read', () => {
    const store = openProjectStore('p1');
    try {
      const [appended] = store.append([event()]);
      const [readBack] = store.readAll();
      expect(readBack!.ts).toBe(appended!.ts);
      expect(readBack!.seq).toBe(appended!.seq);
    } finally {
      store.close();
    }
  });
});
