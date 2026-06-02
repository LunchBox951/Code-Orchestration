import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openGlobalStore } from '../store/sqlite-store.js';
import type { Store } from '../store/types.js';
import { rebuildAll } from '../replay/projector.js';
import { decode } from '../replay/decode.js';
import { openConfigStore } from './config-store.js';
import { ConfigProjector, ensureConfigTable } from './config-projector.js';
import { configSchemas, configUpcasters } from './events.js';

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];

/** Make a fresh program-data dir, point CO_DATA_DIR at it, and track it for cleanup. */
function useDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-config-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
  return dir;
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  useDataDir();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
});

/** Deterministic JSON snapshot of the `config` read-model (ordered by scope, key). */
function snapshotConfig(store: Store): string {
  return store.transaction((tx) => {
    const db = tx.raw as DatabaseSync;
    ensureConfigTable(db);
    return JSON.stringify(
      db.prepare('SELECT scope, key, value FROM config ORDER BY scope, key').all(),
    );
  });
}

describe('ConfigStore — cascade precedence (AC-L0-4)', () => {
  it('a project override wins over the global value for the same key', () => {
    const cfg = openConfigStore();
    try {
      const pid = 'p-alpha';
      cfg.setGlobal('defaultProvider', 'claude');
      cfg.setProjectOverride(pid, 'defaultProvider', 'codex');
      expect(cfg.resolveEffective(pid).defaultProvider).toBe('codex'); // project wins
    } finally {
      cfg.close();
    }
  });

  it('falls through to the global value for keys without a project override', () => {
    const cfg = openConfigStore();
    try {
      cfg.setGlobal('defaultProvider', 'claude');
      cfg.setProjectOverride('p-alpha', 'roleRouting', { reviewer: 'codex' });

      // p-alpha sees the global base PLUS its own override.
      expect(cfg.resolveEffective('p-alpha')).toEqual({
        defaultProvider: 'claude',
        roleRouting: { reviewer: 'codex' },
      });
    } finally {
      cfg.close();
    }
  });

  it('isolates projects: one project never sees another project’s overrides', () => {
    const cfg = openConfigStore();
    try {
      cfg.setGlobal('defaultProvider', 'claude');
      cfg.setProjectOverride('p-alpha', 'defaultProvider', 'codex');

      // A project with no overrides gets exactly the global view.
      expect(cfg.resolveEffective('p-beta')).toEqual({ defaultProvider: 'claude' });
      // p-beta does NOT see p-alpha's override.
      expect(cfg.resolveEffective('p-beta').defaultProvider).toBe('claude');
    } finally {
      cfg.close();
    }
  });

  it('last write wins within a single layer', () => {
    const cfg = openConfigStore();
    try {
      cfg.setGlobal('k', 'v1');
      cfg.setGlobal('k', 'v2');
      cfg.setProjectOverride('p', 'k', 'p1');
      cfg.setProjectOverride('p', 'k', 'p2');
      expect(cfg.resolveEffective('p').k).toBe('p2');
      expect(cfg.resolveEffective('other').k).toBe('v2');
    } finally {
      cfg.close();
    }
  });

  it('returns a frozen (immutable) effective map', () => {
    const cfg = openConfigStore();
    try {
      cfg.setGlobal('defaultProvider', 'claude');
      const eff = cfg.resolveEffective('p-alpha');
      expect(Object.isFrozen(eff)).toBe(true);
    } finally {
      cfg.close();
    }
  });
});

describe('ConfigStore — value fidelity (AC-L0-4)', () => {
  it('round-trips object / array / number / boolean / null through set→resolve', () => {
    const cfg = openConfigStore();
    try {
      const pid = 'p-alpha';
      cfg.setGlobal('obj', { a: 1, b: [2, 3], c: { d: true } });
      cfg.setGlobal('arr', [1, 'two', false, null]);
      cfg.setGlobal('num', 42.5);
      cfg.setGlobal('bool', false);
      cfg.setGlobal('nul', null);
      // also via an override layer
      cfg.setProjectOverride(pid, 'overridden', { nested: ['x', { y: 9 }] });

      const eff = cfg.resolveEffective(pid);
      expect(eff.obj).toEqual({ a: 1, b: [2, 3], c: { d: true } });
      expect(eff.arr).toEqual([1, 'two', false, null]);
      expect(eff.num).toBe(42.5);
      expect(eff.bool).toBe(false);
      expect(eff.nul).toBeNull();
      expect(eff.overridden).toEqual({ nested: ['x', { y: 9 }] });
    } finally {
      cfg.close();
    }
  });
});

describe('ConfigStore — program-data only', () => {
  it('resolves with no repo present and persists headless across reopens', () => {
    // CO_DATA_DIR points at a tmp program-data dir (beforeEach); there is NO repo.
    const cfg1 = openConfigStore();
    cfg1.setGlobal('defaultProvider', 'claude');
    cfg1.setProjectOverride('p-alpha', 'defaultProvider', 'codex');
    cfg1.close(); // simulate process exit

    const cfg2 = openConfigStore(); // fresh instance on the same on-disk global store
    try {
      expect(cfg2.resolveEffective('p-alpha')).toEqual({ defaultProvider: 'codex' });
      expect(cfg2.resolveEffective('p-other')).toEqual({ defaultProvider: 'claude' });
    } finally {
      cfg2.close();
    }
  });
});

describe('ConfigStore — undefined rejection (Principle 9)', () => {
  it('setGlobal throws on undefined value', () => {
    const cfg = openConfigStore();
    try {
      expect(() => cfg.setGlobal('k', undefined)).toThrow();
    } finally {
      cfg.close();
    }
  });

  it('setProjectOverride throws on undefined value', () => {
    const cfg = openConfigStore();
    try {
      expect(() => cfg.setProjectOverride('p-alpha', 'k', undefined)).toThrow();
    } finally {
      cfg.close();
    }
  });

  it('normal values still round-trip after an undefined rejection', () => {
    const cfg = openConfigStore();
    try {
      expect(() => cfg.setGlobal('bad', undefined)).toThrow();
      cfg.setGlobal('good', 'ok');
      expect(cfg.resolveEffective('any').good).toBe('ok');
    } finally {
      cfg.close();
    }
  });
});

describe('ConfigStore — fully JSON-safe values (Principle 9)', () => {
  it('rejects nested {a: undefined}', () => {
    const cfg = openConfigStore();
    try {
      expect(() => cfg.setGlobal('k', { a: undefined })).toThrow();
    } finally {
      cfg.close();
    }
  });

  it('rejects NaN', () => {
    const cfg = openConfigStore();
    try {
      expect(() => cfg.setGlobal('k', NaN)).toThrow();
    } finally {
      cfg.close();
    }
  });

  it('rejects Infinity', () => {
    const cfg = openConfigStore();
    try {
      expect(() => cfg.setGlobal('k', Infinity)).toThrow();
    } finally {
      cfg.close();
    }
  });

  it('rejects a function value', () => {
    const cfg = openConfigStore();
    try {
      expect(() => cfg.setGlobal('k', () => 'x')).toThrow();
    } finally {
      cfg.close();
    }
  });

  it('rejects an array containing undefined', () => {
    const cfg = openConfigStore();
    try {
      expect(() => cfg.setGlobal('k', [1, undefined, 3])).toThrow();
    } finally {
      cfg.close();
    }
  });

  it('rejects a nested object containing a function', () => {
    const cfg = openConfigStore();
    try {
      expect(() => cfg.setGlobal('k', { a: { b: () => 'x' } })).toThrow();
    } finally {
      cfg.close();
    }
  });

  it('accepts a deeply nested valid value and it round-trips through set→resolve', () => {
    const cfg = openConfigStore();
    try {
      const val = { a: { b: [1, 'two', false, null] } };
      cfg.setGlobal('nested', val);
      expect(cfg.resolveEffective('p').nested).toEqual(val);
    } finally {
      cfg.close();
    }
  });
});

describe('ConfigStore — projection determinism', () => {
  it('AC-L0-2: rebuildAll reproduces the config read-model byte-for-byte', () => {
    const cfg = openConfigStore();
    cfg.setGlobal('defaultProvider', 'claude');
    cfg.setProjectOverride('p-alpha', 'defaultProvider', 'codex');
    cfg.setGlobal('roleRouting', { reviewer: 'codex' });
    cfg.setProjectOverride('p-beta', 'maxTokens', 1000);
    cfg.setGlobal('defaultProvider', 'claude-next'); // overwrite a global key
    cfg.close();

    const store = openGlobalStore();
    try {
      const live = snapshotConfig(store);
      rebuildAll(store, [new ConfigProjector()], (e) => decode(e, configUpcasters, configSchemas));
      const replayed = snapshotConfig(store);

      expect(replayed).toBe(live);
      expect(live).not.toBe('[]'); // not a vacuous pass
    } finally {
      store.close();
    }
  });

  it('freeze #6: the config read-model carries no wall-clock field; replay is deterministic', () => {
    const cfg = openConfigStore();
    cfg.setGlobal('defaultProvider', 'claude');
    cfg.setProjectOverride('p-alpha', 'defaultProvider', 'codex');
    cfg.close();

    const store = openGlobalStore();
    try {
      const before = snapshotConfig(store);
      rebuildAll(store, [new ConfigProjector()], (e) => decode(e, configUpcasters, configSchemas));
      const after = snapshotConfig(store);
      expect(after).toBe(before);

      // Rows are (scope, key, value) only — no ts / created_at derived from wall-clock,
      // which is WHY a replay at any later wall-clock time reproduces them exactly.
      const rows = JSON.parse(before) as Array<Record<string, unknown>>;
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(Object.keys(row).sort()).toEqual(['key', 'scope', 'value']);
      }
    } finally {
      store.close();
    }
  });
});
