import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { openGlobalStore, openProjectStore } from '../store/sqlite-store.js';
import { dataRoot } from '../store/paths.js';
import type { NewEvent, StoredEvent, StoreTx } from '../store/types.js';
import { applyEvent, rebuildAll, type Projector } from '../replay/projector.js';
import { decode, type SchemaMap } from '../replay/decode.js';
import type { UpcasterRegistry } from '../replay/upcaster.js';
import { openRegistry } from '../registry/registry.js';
import { openConfigStore } from './config-store.js';
import { assertRepoPristine } from './pristine.js';

// ── A throwaway projector for the B (replay) leg of the harness ────────────────
class KvProjector implements Projector {
  readonly name = 'harness_kv';
  handles(type: string): boolean {
    return type === 'kv.set';
  }
  private ensure(db: DatabaseSync): void {
    db.exec('CREATE TABLE IF NOT EXISTS harness_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }
  reset(tx: StoreTx): void {
    const db = tx.raw as DatabaseSync;
    this.ensure(db);
    db.exec('DELETE FROM harness_kv');
  }
  apply(tx: StoreTx, event: StoredEvent): void {
    const db = tx.raw as DatabaseSync;
    this.ensure(db);
    const { key, value } = event.payload as { key: string; value: string };
    db.prepare(
      'INSERT INTO harness_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?',
    ).run(key, value, value);
  }
}
const kvSchemas: SchemaMap = new Map([
  ['kv.set', z.object({ key: z.string(), value: z.string() })],
]);
const kvUpcasters: UpcasterRegistry = new Map();

function ev(projectId: string, scope: string, type: string, payload: unknown): NewEvent {
  return { projectId, scope, type, v: 1, payload };
}

const ORIGINAL_ENV = process.env;
const tmpDirs: string[] = [];

function track(dir: string): string {
  tmpDirs.push(dir);
  return dir;
}

/**
 * A real git repo when `git` is available, else a hand-built `.git`-like tree
 * (spec-sanctioned: the guard only cares about byte-identity, not git validity).
 * Built BEFORE any op is wrapped, so its full `.git` is part of the baseline.
 */
function makeFixtureRepo(): string {
  const dir = track(mkdtempSync(join(tmpdir(), 'co-fixture-repo-')));
  try {
    const git = (...args: string[]): void => {
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=Test', ...args], {
        cwd: dir,
        stdio: 'ignore',
      });
    };
    git('init', '-q');
    writeFileSync(join(dir, 'file.txt'), 'fixture\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
  } catch {
    mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(dir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
    writeFileSync(join(dir, 'file.txt'), 'fixture\n');
  }
  return dir;
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.CO_DATA_DIR = track(mkdtempSync(join(tmpdir(), 'co-data-'))); // SEPARATE from any repo
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('AC-L0-5 — pristine-repo guard over every public L0 op', () => {
  it('no public L0 op writes into the target repo (working tree or .git)', () => {
    const repo = makeFixtureRepo();
    const projectors = [new KvProjector()];

    // ── A: Store — open/append/read/transaction on the global store ──────────
    assertRepoPristine(repo, () => {
      const g = openGlobalStore();
      try {
        g.append([ev('@global', 'probe', 'probe.ping', { n: 1 })]);
        g.transaction((tx) => tx.append([ev('@global', 'probe', 'probe.ping', { n: 2 })]));
        g.readAll();
        g.readStream('probe');
        g.head();
      } finally {
        g.close();
      }
    });

    // ── C: Registry — register the repo's PATH, relink, resolve, dataDirFor ───
    const pid = assertRepoPristine(repo, () => {
      const reg = openRegistry();
      try {
        const id = reg.register(repo); // keys on the path; never reads the repo
        reg.relink(id, `${repo}-moved`);
        reg.relink(id, repo); // move back
        expect(reg.resolve(repo)).toBe(id);
        reg.dataDirFor(id);
        return id;
      } finally {
        reg.close();
      }
    });

    // ── B: Replay — append + fold live, then rebuildAll on the per-project store
    assertRepoPristine(repo, () => {
      const store = openProjectStore(pid);
      try {
        store.transaction((tx) => {
          const [s] = tx.append([ev(pid, 'kv', 'kv.set', { key: 'a', value: '1' })]);
          applyEvent(tx, decode(s!, kvUpcasters, kvSchemas), projectors);
        });
        rebuildAll(store, projectors, (e) => decode(e, kvUpcasters, kvSchemas));
      } finally {
        store.close();
      }
    });

    // ── D: Config — global set, project override, resolve ────────────────────
    assertRepoPristine(repo, () => {
      const cfg = openConfigStore();
      try {
        cfg.setGlobal('defaultProvider', 'claude');
        cfg.setProjectOverride(pid, 'defaultProvider', 'codex');
        cfg.resolveEffective(pid);
      } finally {
        cfg.close();
      }
    });

    // Non-vacuous: the ops really ran and their writes landed in CO_DATA_DIR.
    const cfg = openConfigStore();
    try {
      expect(cfg.resolveEffective(pid).defaultProvider).toBe('codex');
    } finally {
      cfg.close();
    }
    expect(existsSync(join(dataRoot(), 'global.db'))).toBe(true);
    expect(existsSync(join(repo, '.co'))).toBe(false); // no orchestration state in the repo
  });
});
