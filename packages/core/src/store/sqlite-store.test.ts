import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openGlobalStore, openProjectStore } from './sqlite-store.js';
import type { NewEvent, StoredEvent, StoreTx } from './types.js';
import { applyEvent, rebuildAll, type Projector } from '../replay/projector.js';
import { assertRepoPristine } from '../config/pristine.js';

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

  it('surfaces the original error, not a masking rollback error, when the tx is already closed', () => {
    // SQLite auto-rolls-back the active transaction on some failure classes (SQLITE_FULL / IOERR);
    // the wrapper's explicit ROLLBACK then throws "cannot rollback - no transaction is active". We
    // simulate that closed-tx state by committing out from under the wrapper, then throwing. The
    // original cause must propagate, never be masked by the rollback (Principle 9).
    const store = openProjectStore('p1');
    try {
      let caught: unknown;
      try {
        store.transaction((tx) => {
          (tx.raw as DatabaseSync).exec('COMMIT');
          throw new Error('original-cause');
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe('original-cause');
      expect((caught as Error).message).not.toMatch(/no transaction is active/i);

      // The store is not bricked: the inTransaction guard was reset, so a normal append still commits.
      expect(store.append([event()])).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});

describe('SqliteStore connection PRAGMAs', () => {
  it('configures a non-zero busy_timeout so a contended cross-process writer waits, not hard-fails', () => {
    const store = openProjectStore('p1');
    try {
      const row = store.transaction((tx) =>
        (tx.raw as DatabaseSync).prepare('PRAGMA busy_timeout').get(),
      );
      expect(Number((row as { timeout: number }).timeout)).toBe(5000);
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
      // These columns are reserved for L1+ mail metadata. L0 events leave them NULL.
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

describe('migrate — future schema version', () => {
  it('throws when opening a db with user_version > SCHEMA_VERSION', () => {
    const dbPath = join(dataDir, 'projects', 'p-future', 'store.db');
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA user_version = 9999');
    db.close();

    expect(() => openProjectStore('p-future')).toThrow(
      /database is from a newer co.*refusing to open/i,
    );
  });

  it('opens normally when user_version === SCHEMA_VERSION (already migrated)', () => {
    const store = openProjectStore('p-current');
    try {
      store.append([event()]);
      expect(store.head()).toBe(1);
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

describe('store widening — reserved field round-trips', () => {
  it('round-trips all four reserved fields through append and readAll/readStream', () => {
    const store = openProjectStore('p1');
    try {
      const [appended] = store.append([
        event({
          actor: 'agent-abc',
          causationId: 'evt-001',
          correlationId: 'thread-xyz',
          idempotencyKey: 'idem-123',
        }),
      ]);
      expect(appended).toMatchObject({
        actor: 'agent-abc',
        causationId: 'evt-001',
        correlationId: 'thread-xyz',
        idempotencyKey: 'idem-123',
      });

      const [viaReadAll] = store.readAll();
      expect(viaReadAll).toMatchObject({
        actor: 'agent-abc',
        causationId: 'evt-001',
        correlationId: 'thread-xyz',
        idempotencyKey: 'idem-123',
      });
      // append return is byte-identical to a later read
      expect(appended).toEqual(viaReadAll);

      const [viaReadStream] = store.readStream(event().scope);
      expect(viaReadStream).toEqual(viaReadAll);
    } finally {
      store.close();
    }
  });

  it('omits all four keys when none of the reserved fields are supplied', () => {
    const store = openProjectStore('p1');
    try {
      const [appended] = store.append([event()]);
      expect(appended).not.toHaveProperty('actor');
      expect(appended).not.toHaveProperty('causationId');
      expect(appended).not.toHaveProperty('correlationId');
      expect(appended).not.toHaveProperty('idempotencyKey');

      const [readBack] = store.readAll();
      expect(readBack).not.toHaveProperty('actor');
      expect(readBack).not.toHaveProperty('causationId');
      expect(readBack).not.toHaveProperty('correlationId');
      expect(readBack).not.toHaveProperty('idempotencyKey');
      expect(appended).toEqual(readBack);
    } finally {
      store.close();
    }
  });

  it('surfaces only the supplied field when only idempotencyKey is set (partial)', () => {
    const store = openProjectStore('p1');
    try {
      const [appended] = store.append([event({ idempotencyKey: 'idem-only' })]);
      expect(appended).not.toHaveProperty('actor');
      expect(appended).not.toHaveProperty('causationId');
      expect(appended).not.toHaveProperty('correlationId');
      expect(appended).toMatchObject({ idempotencyKey: 'idem-only' });

      const [readBack] = store.readAll();
      expect(readBack).not.toHaveProperty('actor');
      expect(readBack).not.toHaveProperty('causationId');
      expect(readBack).not.toHaveProperty('correlationId');
      expect(readBack).toMatchObject({ idempotencyKey: 'idem-only' });
      expect(appended).toEqual(readBack);
    } finally {
      store.close();
    }
  });
});

describe('store widening — AC-L0-2 replay preserved', () => {
  /** Minimal projector that records (seq, actor) for every folded event. */
  class ActorLogProjector implements Projector {
    readonly name = 'actor_log';
    handles(): boolean {
      return true;
    }
    private ensure(db: DatabaseSync): void {
      db.exec('CREATE TABLE IF NOT EXISTS actor_log (seq INTEGER PRIMARY KEY, actor TEXT)');
    }
    reset(tx: StoreTx): void {
      const db = tx.raw as DatabaseSync;
      this.ensure(db);
      db.exec('DELETE FROM actor_log');
    }
    apply(tx: StoreTx, ev: StoredEvent): void {
      const db = tx.raw as DatabaseSync;
      this.ensure(db);
      db.prepare('INSERT INTO actor_log (seq, actor) VALUES (?, ?)').run(ev.seq, ev.actor ?? null);
    }
    snapshot(db: DatabaseSync): string {
      this.ensure(db);
      return JSON.stringify(db.prepare('SELECT seq, actor FROM actor_log ORDER BY seq').all());
    }
  }

  it('live → snapshot → rebuildAll → snapshot is byte-identical with reserved fields in the log', () => {
    const store = openProjectStore('p1');
    const proj = new ActorLogProjector();
    try {
      for (const e of [
        event({ actor: 'agent-1', correlationId: 'thread-1' }),
        event(),
        event({ actor: 'agent-2', idempotencyKey: 'k-2' }),
      ]) {
        store.transaction((tx) => {
          const [s] = tx.append([e]);
          applyEvent(tx, s!, [proj]);
        });
      }
      const live = store.transaction((tx) => proj.snapshot(tx.raw as DatabaseSync));

      rebuildAll(store, [proj]);

      const replayed = store.transaction((tx) => proj.snapshot(tx.raw as DatabaseSync));
      expect(replayed).toBe(live);
      // guard against a vacuous pass
      expect(live).toContain('"actor":"agent-1"');
      expect(live).toContain('"actor":null');
    } finally {
      store.close();
    }
  });
});

describe('store widening — AC-L0-5 pristine', () => {
  /** Minimal fixture repo (hand-built .git tree; no git binary required). */
  function makeFixtureRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'co-fixture-'));
    try {
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'init', '-q'], {
        cwd: dir,
        stdio: 'ignore',
      });
      writeFileSync(join(dir, 'file.txt'), 'fixture\n');
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'add', '.'], {
        cwd: dir,
        stdio: 'ignore',
      });
      execFileSync(
        'git',
        ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'init'],
        { cwd: dir, stdio: 'ignore' },
      );
    } catch {
      mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
      writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
      writeFileSync(join(dir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
      writeFileSync(join(dir, 'file.txt'), 'fixture\n');
    }
    return dir;
  }

  it('widened append with all four reserved fields does not write into the repo tree', () => {
    const repoDir = makeFixtureRepo();
    try {
      assertRepoPristine(repoDir, () => {
        const store = openProjectStore('pristine-p');
        try {
          store.append([
            event({
              actor: 'a',
              causationId: 'c',
              correlationId: 'r',
              idempotencyKey: 'k',
            }),
          ]);
        } finally {
          store.close();
        }
      });
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
