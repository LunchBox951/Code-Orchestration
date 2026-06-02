import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { openProjectStore } from '../store/sqlite-store.js';
import type { NewEvent, Store, StoredEvent, StoreTx } from '../store/types.js';
import { applyEvent, rebuildAll, type Projector } from './projector.js';
import { decode, type SchemaMap } from './decode.js';
import type { UpcasterRegistry } from './upcaster.js';

// ── Decode config shared by the live path AND replay (the live==replay identity) ──
const upcasters: UpcasterRegistry = new Map();
const schemas: SchemaMap = new Map<string, z.ZodType>([
  ['counter.inc', z.object({ by: z.number() })],
  ['kv.set', z.object({ key: z.string(), value: z.string() })],
]);

// ── Synthetic projectors (C/D's real events don't exist yet) ──────────────────
/** A projector that exposes a deterministic read-model snapshot for assertions. */
type SnapshotProjector = Projector & { snapshot(db: DatabaseSync): unknown };

/** count per scope. */
class CounterProjector implements SnapshotProjector {
  readonly name = 'counter';
  handles(type: string): boolean {
    return type === 'counter.inc';
  }
  private ensure(db: DatabaseSync): void {
    db.exec('CREATE TABLE IF NOT EXISTS counter (scope TEXT PRIMARY KEY, count INTEGER NOT NULL)');
  }
  reset(tx: StoreTx): void {
    const db = tx.raw as DatabaseSync;
    this.ensure(db);
    db.exec('DELETE FROM counter');
  }
  apply(tx: StoreTx, event: StoredEvent): void {
    const db = tx.raw as DatabaseSync;
    this.ensure(db);
    const { by } = event.payload as { by: number };
    db.prepare(
      'INSERT INTO counter (scope, count) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET count = count + ?',
    ).run(event.scope, by, by);
  }
  snapshot(db: DatabaseSync): unknown {
    this.ensure(db);
    return db.prepare('SELECT scope, count FROM counter ORDER BY scope').all();
  }
}

/** last value per key. */
class KvProjector implements SnapshotProjector {
  readonly name = 'kv';
  handles(type: string): boolean {
    return type === 'kv.set';
  }
  private ensure(db: DatabaseSync): void {
    db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }
  reset(tx: StoreTx): void {
    const db = tx.raw as DatabaseSync;
    this.ensure(db);
    db.exec('DELETE FROM kv');
  }
  apply(tx: StoreTx, event: StoredEvent): void {
    const db = tx.raw as DatabaseSync;
    this.ensure(db);
    const { key, value } = event.payload as { key: string; value: string };
    db.prepare(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?',
    ).run(key, value, value);
  }
  snapshot(db: DatabaseSync): unknown {
    this.ensure(db);
    return db.prepare('SELECT key, value FROM kv ORDER BY key').all();
  }
}

/** Records the PERSISTED ts of every event it folds (freeze #6 probe). */
class TsProjector implements SnapshotProjector {
  readonly name = 'ts_log';
  handles(type: string): boolean {
    return type === 'counter.inc' || type === 'kv.set';
  }
  private ensure(db: DatabaseSync): void {
    db.exec('CREATE TABLE IF NOT EXISTS ts_log (seq INTEGER PRIMARY KEY, ts INTEGER NOT NULL)');
  }
  reset(tx: StoreTx): void {
    const db = tx.raw as DatabaseSync;
    this.ensure(db);
    db.exec('DELETE FROM ts_log');
  }
  apply(tx: StoreTx, event: StoredEvent): void {
    const db = tx.raw as DatabaseSync;
    this.ensure(db);
    db.prepare('INSERT OR REPLACE INTO ts_log (seq, ts) VALUES (?, ?)').run(event.seq, event.ts);
  }
  snapshot(db: DatabaseSync): unknown {
    this.ensure(db);
    return db.prepare('SELECT seq, ts FROM ts_log ORDER BY seq').all();
  }
}

function ev(type: string, scope: string, payload: unknown): NewEvent {
  return { projectId: 'p1', scope, type, v: 1, payload };
}

/** Live path: append + decode + fold, all in ONE transaction (the documented mutation flow). */
function mutate(store: Store, projectors: readonly Projector[], newEvent: NewEvent): void {
  store.transaction((tx) => {
    const [s] = tx.append([newEvent]);
    applyEvent(tx, decode(s!, upcasters, schemas), projectors);
  });
}

/** Deterministic snapshot of all projection read-models, as one JSON string. */
function snapshot(store: Store, projectors: readonly SnapshotProjector[]): string {
  return store.transaction((tx) => {
    const db = tx.raw as DatabaseSync;
    const obj: Record<string, unknown> = {};
    for (const p of projectors) obj[p.name] = p.snapshot(db);
    return JSON.stringify(obj);
  });
}

const ORIGINAL_ENV = process.env;
let dataDir: string;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDir = mkdtempSync(join(tmpdir(), 'co-replay-'));
  process.env.CO_DATA_DIR = dataDir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('applyEvent', () => {
  it('routes an event only to projectors whose handles() returns true, in array order', () => {
    const seen: Record<string, string[]> = { a: [], b: [] };
    const pa: Projector = {
      name: 'a',
      handles: (t) => t === 'a',
      reset: () => {},
      apply: (_tx, e) => void seen.a!.push(e.type),
    };
    const pb: Projector = {
      name: 'b',
      handles: (t) => t === 'b',
      reset: () => {},
      apply: (_tx, e) => void seen.b!.push(e.type),
    };
    const fakeTx: StoreTx = { append: () => [], raw: null };
    const se = (type: string): StoredEvent => ({
      seq: 1,
      ts: 1,
      projectId: 'p',
      scope: 's',
      type,
      v: 1,
      payload: {},
    });
    for (const t of ['a', 'b', 'a', 'c']) applyEvent(fakeTx, se(t), [pa, pb]);
    expect(seen.a).toEqual(['a', 'a']);
    expect(seen.b).toEqual(['b']);
  });
});

describe('rebuildAll (AC-L0-2)', () => {
  it('produces a read-model byte-identical to the live-built one', () => {
    const store = openProjectStore('p1');
    try {
      const projectors = [new CounterProjector(), new KvProjector(), new TsProjector()];
      const sequence: NewEvent[] = [
        ev('counter.inc', 'c:a', { by: 1 }),
        ev('kv.set', 'k', { key: 'x', value: '1' }),
        ev('counter.inc', 'c:b', { by: 5 }),
        ev('counter.inc', 'c:a', { by: 2 }),
        ev('kv.set', 'k', { key: 'y', value: '2' }),
        ev('kv.set', 'k', { key: 'x', value: '3' }), // overwrite x
      ];
      for (const e of sequence) mutate(store, projectors, e);
      const live = snapshot(store, projectors);

      rebuildAll(store, projectors, (e) => decode(e, upcasters, schemas));
      const replayed = snapshot(store, projectors);

      expect(replayed).toBe(live);
      // guard against a vacuous pass (two empty snapshots are also "equal")
      expect(live).toContain('"scope":"c:a","count":3');
      expect(live).toContain('"key":"x","value":"3"');
    } finally {
      store.close();
    }
  });

  it('resets to empty then re-folds: rebuilding twice is idempotent', () => {
    const store = openProjectStore('p1');
    try {
      const projectors = [new CounterProjector(), new KvProjector(), new TsProjector()];
      for (const e of [
        ev('counter.inc', 'c:a', { by: 3 }),
        ev('kv.set', 'k', { key: 'x', value: 'v' }),
      ]) {
        mutate(store, projectors, e);
      }
      const live = snapshot(store, projectors);

      rebuildAll(store, projectors, (e) => decode(e, upcasters, schemas));
      const once = snapshot(store, projectors);
      rebuildAll(store, projectors, (e) => decode(e, upcasters, schemas));
      const twice = snapshot(store, projectors);

      expect(once).toBe(live);
      expect(twice).toBe(live);
    } finally {
      store.close();
    }
  });

  it('defaults the decode hook to identity when omitted', () => {
    const store = openProjectStore('p1');
    try {
      // No schema needed: identity decode means the projector folds the raw payload.
      const projectors = [new CounterProjector()];
      store.transaction((tx) => {
        const [s] = tx.append([ev('counter.inc', 'c:a', { by: 4 })]);
        applyEvent(tx, s!, projectors); // live fold with the raw stored event
      });
      const live = snapshot(store, projectors);
      rebuildAll(store, projectors); // <- decode omitted
      expect(snapshot(store, projectors)).toBe(live);
    } finally {
      store.close();
    }
  });
});

describe('determinism (freeze #6)', () => {
  it('replay reproduces the persisted ts exactly, never wall-clock', () => {
    const store = openProjectStore('p1');
    try {
      const ts = new TsProjector();
      const projectors = [new CounterProjector(), ts];
      for (const e of [ev('counter.inc', 'c:a', { by: 1 }), ev('counter.inc', 'c:b', { by: 2 })]) {
        mutate(store, projectors, e);
      }
      const persisted = store.readAll().map((e) => ({ seq: e.seq, ts: e.ts }));
      const liveTs = store.transaction((tx) => ts.snapshot(tx.raw as DatabaseSync));
      expect(liveTs).toEqual(persisted);

      rebuildAll(store, projectors, (e) => decode(e, upcasters, schemas));
      const replayedTs = store.transaction((tx) => ts.snapshot(tx.raw as DatabaseSync));
      // Identical to the persisted ts ⇒ replay read ts from the log, not Date.now().
      expect(replayedTs).toEqual(persisted);
    } finally {
      store.close();
    }
  });
});
