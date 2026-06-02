import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openGlobalStore } from '../store/sqlite-store.js';
import { projectDataDir } from '../store/paths.js';
import type { Store } from '../store/types.js';
import { rebuildAll } from '../replay/projector.js';
import { decode } from '../replay/decode.js';
import { openRegistry } from './registry.js';
import { ProjectsProjector, ensureProjectsTable } from './projects-projector.js';
import {
  EVENT_PROJECT_REGISTERED,
  EVENT_PROJECT_RELINKED,
  registrySchemas,
  registryUpcasters,
} from './events.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];

/** Make a fresh program-data dir, point CO_DATA_DIR at it, and track it for cleanup. */
function useDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-registry-'));
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

/** Deterministic JSON snapshot of the `projects` read-model (ordered by id). */
function snapshotProjects(store: Store): string {
  return store.transaction((tx) => {
    const db = tx.raw as DatabaseSync;
    ensureProjectsTable(db);
    return JSON.stringify(
      db
        .prepare('SELECT project_id, current_path, created_ts FROM projects ORDER BY project_id')
        .all(),
    );
  });
}

function readCreatedTs(store: Store, projectId: string): number {
  return store.transaction((tx) => {
    const db = tx.raw as DatabaseSync;
    ensureProjectsTable(db);
    const row = db.prepare('SELECT created_ts FROM projects WHERE project_id = ?').get(projectId);
    if (!row) throw new Error(`no projects row for ${projectId}`);
    return Number(row.created_ts);
  });
}

describe('ProjectRegistry — register (AC-L0-1)', () => {
  it('mints a stable opaque UUID mapped to its program-data dir', () => {
    const reg = openRegistry();
    try {
      const id = reg.register('/repos/alpha');
      expect(id).toMatch(UUID_RE);
      expect(reg.dataDirFor(id)).toBe(projectDataDir(id));
      expect(reg.resolve('/repos/alpha')).toBe(id);
    } finally {
      reg.close();
    }
  });

  it('is idempotent: re-registering the same path returns the same id with ONE event', () => {
    const reg = openRegistry();
    let id: string;
    try {
      id = reg.register('/repos/alpha');
      expect(reg.register('/repos/alpha')).toBe(id);
    } finally {
      reg.close();
    }
    const store = openGlobalStore();
    try {
      const registered = store
        .readStream('registry')
        .filter((e) => e.type === EVENT_PROJECT_REGISTERED);
      expect(registered).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('mints the id — it is NOT derived from the path (same path, two stores → different ids)', () => {
    const dir1 = useDataDir();
    const reg1 = openRegistry();
    const id1 = reg1.register('/repos/alpha');
    reg1.close();

    const dir2 = useDataDir();
    expect(dir2).not.toBe(dir1);
    const reg2 = openRegistry();
    const id2 = reg2.register('/repos/alpha');
    reg2.close();

    expect(id1).toMatch(UUID_RE);
    expect(id2).toMatch(UUID_RE);
    expect(id1).not.toBe(id2); // a path-hash would collide; a minted UUID does not
  });

  it('normalizes equivalent path spellings to the same id', () => {
    const reg = openRegistry();
    try {
      const id = reg.register('/repos/alpha');
      expect(reg.register('/repos/./alpha')).toBe(id);
      expect(reg.register('/repos/beta/../alpha')).toBe(id);
      expect(reg.resolve('/repos/alpha/')).toBe(id);
    } finally {
      reg.close();
    }
  });

  it('rejects a non-absolute path (fail loud)', () => {
    const reg = openRegistry();
    try {
      expect(() => reg.register('relative/path')).toThrow(/absolute/);
    } finally {
      reg.close();
    }
  });
});

describe('ProjectRegistry — relink (AC-L0-1 + AC-L0-3)', () => {
  it('keeps the id stable across a path change', () => {
    const reg = openRegistry();
    try {
      const id = reg.register('/repos/alpha');
      reg.relink(id, '/repos/beta');
      expect(reg.resolve('/repos/beta')).toBe(id);
      expect(reg.resolve('/repos/alpha')).toBeUndefined();
      expect(reg.dataDirFor(id)).toBe(projectDataDir(id)); // id value unchanged
    } finally {
      reg.close();
    }
  });

  it('works headless on a reopened store, preserving full history without touching the per-project store', () => {
    const reg1 = openRegistry();
    const id = reg1.register('/repos/alpha');
    reg1.close(); // simulate process exit

    const reg2 = openRegistry(); // fresh instance on the same on-disk store
    reg2.relink(id, '/repos/alpha-moved');
    expect(reg2.resolve('/repos/alpha-moved')).toBe(id);
    expect(reg2.resolve('/repos/alpha')).toBeUndefined();
    reg2.close();

    // freeze #5: the per-project store was never created/touched by relink.
    expect(existsSync(projectDataDir(id))).toBe(false);

    // full history intact: both events survive for this id.
    const store = openGlobalStore();
    try {
      const types = store
        .readStream('registry')
        .filter((e) => (e.payload as { projectId?: string }).projectId === id)
        .map((e) => e.type);
      expect(types).toContain(EVENT_PROJECT_REGISTERED);
      expect(types).toContain(EVENT_PROJECT_RELINKED);
    } finally {
      store.close();
    }
  });

  it('treats relink to the current (normalized) path as a no-op — no new event', () => {
    const reg = openRegistry();
    let id: string;
    try {
      id = reg.register('/repos/alpha');
      reg.relink(id, '/repos/alpha');
      reg.relink(id, '/repos/./alpha');
    } finally {
      reg.close();
    }
    const store = openGlobalStore();
    try {
      const relinked = store
        .readStream('registry')
        .filter((e) => e.type === EVENT_PROJECT_RELINKED);
      expect(relinked).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('fails loud: relinking an unknown id throws', () => {
    const reg = openRegistry();
    try {
      expect(() => reg.relink('00000000-0000-0000-0000-000000000000', '/repos/beta')).toThrow(
        /unknown project id/,
      );
    } finally {
      reg.close();
    }
  });

  it('fails loud: relinking onto a path owned by another project throws and changes nothing', () => {
    const reg = openRegistry();
    try {
      const idA = reg.register('/repos/alpha');
      const idB = reg.register('/repos/beta');
      expect(() => reg.relink(idA, '/repos/beta')).toThrow(/already registered/);
      expect(reg.resolve('/repos/alpha')).toBe(idA);
      expect(reg.resolve('/repos/beta')).toBe(idB);
    } finally {
      reg.close();
    }
  });
});

describe('ProjectRegistry — projection determinism', () => {
  it('AC-L0-2: rebuildAll reproduces the projects read-model byte-for-byte', () => {
    const reg = openRegistry();
    const id0 = reg.register('/repos/alpha');
    const id1 = reg.register('/repos/beta');
    reg.relink(id0, '/repos/alpha-moved');
    reg.register('/repos/gamma');
    reg.relink(id1, '/repos/beta-moved');
    reg.close();

    const store = openGlobalStore();
    try {
      const live = snapshotProjects(store);
      rebuildAll(store, [new ProjectsProjector()], (e) =>
        decode(e, registryUpcasters, registrySchemas),
      );
      const replayed = snapshotProjects(store);

      expect(replayed).toBe(live);
      expect(live).not.toBe('[]'); // not a vacuous pass

      const rows = JSON.parse(live) as Array<{ current_path: string }>;
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => r.current_path).sort()).toEqual(
        ['/repos/alpha-moved', '/repos/beta-moved', '/repos/gamma'].sort(),
      );
    } finally {
      store.close();
    }
  });

  it('freeze #6: created_ts equals the registered event persisted ts, before AND after rebuild', () => {
    const reg = openRegistry();
    const id = reg.register('/repos/alpha');
    reg.close();

    const store = openGlobalStore();
    try {
      const registered = store
        .readStream('registry')
        .find(
          (e) =>
            e.type === EVENT_PROJECT_REGISTERED &&
            (e.payload as { projectId: string }).projectId === id,
        );
      expect(registered).toBeDefined();
      const persistedTs = registered!.ts;

      expect(readCreatedTs(store, id)).toBe(persistedTs);

      rebuildAll(store, [new ProjectsProjector()], (e) =>
        decode(e, registryUpcasters, registrySchemas),
      );
      expect(readCreatedTs(store, id)).toBe(persistedTs); // re-derived from the log, never wall-clock
    } finally {
      store.close();
    }
  });
});
