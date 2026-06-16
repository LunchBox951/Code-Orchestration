import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, type Dirent } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { decode } from '../replay/decode.js';
import { applyEvent, type Projector } from '../replay/projector.js';
import {
  makeMailEvent,
  mailSchemas,
  mailUpcasters,
  type DeliveredMail,
  type MailEnvelope,
} from '../mail/events.js';
import { MailProjector, selectMailBySeq } from '../mail/mail-projector.js';
import { projectDataDir } from '../store/paths.js';
import { openProjectStore } from '../store/sqlite-store.js';
import {
  makeBaselineCapturedEvent,
  makeFinishRecordedEvent,
  makeWorktreeCreatedEvent,
  makeWorktreeRemovedEvent,
  worktreeSchemas,
  worktreeUpcasters,
  type Baseline,
  type BaselineCaptured,
  type FinishRecord,
  type FinishRecorded,
  type WorktreeCreated,
  type WorktreeRecord,
} from './events.js';
import { defaultGitExec, type GitExec } from './sling.js';
import {
  WorktreeProjector,
  ensureWorktreeTables,
  selectAllWorktrees,
  selectBaseline,
  selectFinish,
  selectWorktree,
} from './worktree-projector.js';

/**
 * A recorded-vs-reality MISMATCH surfaced by {@link WorktreeStore.detectOrphans} (L3-E). Surfacing
 * only — the operator cleanup VERBS that act on an orphan are L8 (a typed stub here). `kind`:
 *   - `dangling-record`   — a LIVE record whose sandbox dir / git worktree no longer exists.
 *   - `untracked-sandbox` — a real sandbox dir / git worktree with no live record (`branch` unknown).
 */
export interface Orphan {
  readonly branch?: string;
  readonly path: string;
  readonly kind: 'dangling-record' | 'untracked-sandbox';
}

/**
 * The reality source {@link WorktreeStore.detectOrphans} compares the recorded worktrees against:
 * the absolute paths of the sandbox dirs that ACTUALLY exist under the project's worktrees root,
 * right now. Injectable so orphan detection is testable headless against a recorded reality. It is
 * READ-ONLY — it lists, it never writes (Principle 12 — pristine holds).
 */
export type WorktreeRealityProbe = () => readonly string[];

/**
 * The default reality probe: walk the project's worktrees root and return every leaf that is a real
 * git worktree. A linked worktree holds a `.git` ENTRY (a gitdir pointer file), so a dir containing
 * one IS a sandbox leaf — we record it and stop descending. Read-only (readdir; writes nothing).
 */
export function defaultWorktreeRealityProbe(projectId: string): WorktreeRealityProbe {
  const root = resolve(join(projectDataDir(projectId), 'worktrees'));
  return () => {
    const sandboxes: string[] = [];
    const walk = (dir: string): void => {
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return; // the root (or a subtree) does not exist → nothing to surface here.
      }
      if (entries.some((e) => e.name === '.git')) {
        sandboxes.push(dir); // a `.git` entry marks this dir as a real worktree leaf.
        return;
      }
      for (const e of entries) {
        if (e.isDirectory()) walk(join(dir, e.name));
      }
    };
    walk(root);
    return sandboxes;
  };
}

/**
 * Filesystem seam for the teardown of a sandbox dir — does it exist, and remove it. Injectable so
 * {@link WorktreeStore.removeWorktree} is testable headless (no real dir). `removeDir` is idempotent:
 * removing an already-absent dir is a no-op, never an error (teardown is cleanup, not a write-check).
 */
export interface SandboxFs {
  exists(path: string): boolean;
  isSymlink(path: string): boolean;
  realpath(path: string): string;
  removeDir(path: string): void;
}

/** The production {@link SandboxFs}: real `node:fs`; `removeDir` is recursive + force (idempotent). */
export const defaultSandboxFs: SandboxFs = {
  exists: (path) => existsSync(path),
  isSymlink: (path) => {
    try {
      return lstatSync(path).isSymbolicLink();
    } catch {
      return false;
    }
  },
  realpath: (path) => realpathSync(path),
  removeDir: (path) => rmSync(path, { recursive: true, force: true }),
};

/** Prove a recorded sandbox path is bounded under this project's program-data worktrees root. */
function strictlyWithin(root: string, path: string): boolean {
  return path !== root && path.startsWith(root + '/');
}

function assertNoSymlinkedBoundary(
  root: string,
  sandbox: string,
  branch: string,
  fs: SandboxFs,
): void {
  if (fs.isSymlink(root)) {
    throw new Error(
      `openWorktreeStore.removeWorktree: worktrees root '${root}' for branch '${branch}' is a ` +
        'symlink. Refusing teardown.',
    );
  }

  let cursor = root;
  for (const segment of relative(root, sandbox).split('/')) {
    if (segment.length === 0) continue;
    cursor = join(cursor, segment);
    if (fs.isSymlink(cursor)) {
      throw new Error(
        `openWorktreeStore.removeWorktree: recorded path boundary '${cursor}' for branch ` +
          `'${branch}' is a symlink. Refusing teardown.`,
      );
    }
  }
}

function assertRecordedSandboxPathBounded(
  projectId: string,
  path: string,
  branch: string,
  fs: SandboxFs,
): string {
  const root = resolve(join(projectDataDir(projectId), 'worktrees'));
  const sandbox = resolve(path);
  if (path !== sandbox) {
    throw new Error(
      `openWorktreeStore.removeWorktree: recorded path '${path}' for branch '${branch}' is not ` +
        `the normalized absolute sandbox path '${sandbox}'. Refusing teardown.`,
    );
  }
  if (!strictlyWithin(root, sandbox)) {
    throw new Error(
      `openWorktreeStore.removeWorktree: recorded path '${path}' for branch '${branch}' is ` +
        `outside this project's worktrees root '${root}'. Refusing teardown.`,
    );
  }
  assertNoSymlinkedBoundary(root, sandbox, branch, fs);
  if (!fs.exists(sandbox)) return sandbox;
  const realRoot = fs.realpath(root);
  const realSandbox = fs.realpath(sandbox);
  if (!strictlyWithin(realRoot, realSandbox)) {
    throw new Error(
      `openWorktreeStore.removeWorktree: recorded path '${path}' for branch '${branch}' resolves ` +
        `outside this project's worktrees root '${realRoot}'. Refusing teardown.`,
    );
  }
  return sandbox;
}

/** Injectable seams for {@link WorktreeStore.removeWorktree}; the git/fs sides default to production. */
export interface RemoveWorktreeDeps {
  /**
   * The main repo the sandbox was cut from — where `git worktree remove` runs (git's worktree admin
   * lives in the MAIN repo's `.git`). Required for the real teardown; a headless test that injects
   * `gitExec` can pass any value (the fake ignores cwd).
   */
  readonly repoCwd: string;
  /** Mutating git seam (default {@link defaultGitExec}); reused for `git worktree remove`. */
  readonly gitExec?: GitExec;
  /** Sandbox-dir filesystem seam (default {@link defaultSandboxFs}); injectable for headless tests. */
  readonly fs?: SandboxFs;
  /** Force git worktree removal. Used only by rollback paths for partially-started sandboxes. */
  readonly force?: boolean;
}

/**
 * The headless L3 worktree store over a single project store (the L3 analogue of L1's
 * {@link import('../mail/mail-store.js').MailStore}). It records the orchestration facts of a slung
 * sandbox — the worktree record + the branch-off test baseline — entirely in program-data, never
 * the repo (Principle 12 — pristine-repo). A recording event-sources its read-model row in the same
 * transaction as the append (so the log and projection commit atomically), then reads it straight
 * back; reads are plain projections.
 *
 * Opening this alongside the mail store on the SAME per-project `store.db` is safe: `node:sqlite` is
 * synchronous/single-threaded so transactions never interleave in-process, and this store owns
 * DIFFERENT scopes (`worktree:`/`baseline:`) and read-model tables (`worktrees`/`baselines`) than
 * mail's `inbox`.
 *
 * The facade is intentionally shaped so phase E slots in additively: `removeWorktree` /
 * `detectOrphans` become new methods folding a `worktree.removed` event, with no change here.
 * L3-C added `recordFinish` / `getFinish` the same additive way (a new `finish.recorded` event).
 */
export interface WorktreeStore {
  /** Record a created sandbox (append `worktree.created` + fold); returns the read-back record. */
  recordWorktree(rec: WorktreeCreated): WorktreeRecord;
  /** The worktree record for `branch`, or undefined. */
  getWorktree(branch: string): WorktreeRecord | undefined;
  /** Every recorded worktree, in creation order. */
  listWorktrees(): readonly WorktreeRecord[];
  /** Record a branch-off baseline (append `baseline.captured` + fold); returns the read-back baseline. */
  recordBaseline(b: BaselineCaptured): Baseline;
  /**
   * Record a created sandbox and its branch-off baseline in one durable transaction. This prevents
   * replay from preserving a live worktree record whose required baseline never landed.
   */
  recordWorktreeAndBaseline(
    rec: WorktreeCreated,
    b: BaselineCaptured,
  ): { readonly worktree: WorktreeRecord; readonly baseline: Baseline };
  /** The baseline for `branch`, or undefined. */
  getBaseline(branch: string): Baseline | undefined;
  /**
   * Record a finish (append `finish.recorded` + fold); returns the read-back record. The commit sha
   * + the finish's test run that L5 compares against the baseline. A re-finish UPSERTs (last wins).
   */
  recordFinish(f: FinishRecorded): FinishRecord;
  /**
   * Record a finish and its paired worker_done mail in one durable transaction. This preserves the
   * event-log story: either the finish and parent notification both exist, or neither does.
   */
  recordFinishAndWorkerDone(
    f: FinishRecorded,
    workerDone: MailEnvelope,
  ): { readonly finish: FinishRecord; readonly workerDone: DeliveredMail };
  /** The recorded finish for `branch`, or undefined (no finish yet). */
  getFinish(branch: string): FinishRecord | undefined;
  /**
   * Tear down a sandbox (L3-E): remove the git worktree + its program-data dir, then append
   * `worktree.removed` (marking the record `removed`); returns the updated record. Idempotent on an
   * already-absent sandbox dir (cleanup, not an error); fails loud on a genuine git failure
   * (Principle 9). The dir deletion + git's own `.git/worktrees/…` admin write are teardown's job,
   * NOT an orchestration write — only the `worktree.removed` append is, and it lands in program-data.
   */
  removeWorktree(branch: string, deps: RemoveWorktreeDeps): WorktreeRecord;
  /**
   * Surface recorded-vs-reality mismatches (L3-E): compare the LIVE records (`removed = 0`) against
   * the sandbox dirs that actually exist (`probe`, default {@link defaultWorktreeRealityProbe}).
   * Read-only — it SURFACES only; acting on an orphan is L8. Returns the structured {@link Orphan}s.
   */
  detectOrphans(probe?: WorktreeRealityProbe): Orphan[];
  /** Close the underlying project store. */
  close(): void;
}

/**
 * Open the project worktree store: open the PROJECT store, wire the {@link WorktreeProjector}, and
 * return the {@link WorktreeStore} facade. The store is resolved by the MOUNT (a tool never opens
 * its own store) and injected onto {@link import('../tools/context.js').ToolContext}.`worktrees`.
 */
export function openWorktreeStore(projectId: string): WorktreeStore {
  const store = openProjectStore(projectId);
  const projectors: readonly Projector[] = [new WorktreeProjector()];

  return {
    recordWorktree(rec: WorktreeCreated): WorktreeRecord {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureWorktreeTables(db);
        const [stored] = tx.append([makeWorktreeCreatedEvent(projectId, rec)]);
        applyEvent(tx, decode(stored!, worktreeUpcasters, worktreeSchemas), projectors);
        const row = selectWorktree(db, rec.branch);
        if (!row) {
          throw new Error(
            `openWorktreeStore.recordWorktree: row missing after projection (branch='${rec.branch}')`,
          );
        }
        return row;
      });
    },

    getWorktree(branch: string): WorktreeRecord | undefined {
      return store.transaction((tx) => selectWorktree(tx.raw as DatabaseSync, branch));
    },

    listWorktrees(): readonly WorktreeRecord[] {
      return store.transaction((tx) => selectAllWorktrees(tx.raw as DatabaseSync));
    },

    recordBaseline(b: BaselineCaptured): Baseline {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureWorktreeTables(db);
        const [stored] = tx.append([makeBaselineCapturedEvent(projectId, b)]);
        applyEvent(tx, decode(stored!, worktreeUpcasters, worktreeSchemas), projectors);
        const row = selectBaseline(db, b.branch);
        if (!row) {
          throw new Error(
            `openWorktreeStore.recordBaseline: row missing after projection (branch='${b.branch}')`,
          );
        }
        return row;
      });
    },

    recordWorktreeAndBaseline(
      rec: WorktreeCreated,
      b: BaselineCaptured,
    ): { readonly worktree: WorktreeRecord; readonly baseline: Baseline } {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureWorktreeTables(db);
        const stored = tx.append([
          makeWorktreeCreatedEvent(projectId, rec),
          makeBaselineCapturedEvent(projectId, b),
        ]);
        for (const event of stored) {
          applyEvent(tx, decode(event, worktreeUpcasters, worktreeSchemas), projectors);
        }
        const worktree = selectWorktree(db, rec.branch);
        const baseline = selectBaseline(db, b.branch);
        if (!worktree || !baseline) {
          throw new Error(
            `openWorktreeStore.recordWorktreeAndBaseline: row missing after projection ` +
              `(branch='${rec.branch}')`,
          );
        }
        return { worktree, baseline };
      });
    },

    getBaseline(branch: string): Baseline | undefined {
      return store.transaction((tx) => selectBaseline(tx.raw as DatabaseSync, branch));
    },

    recordFinish(f: FinishRecorded): FinishRecord {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureWorktreeTables(db);
        const [stored] = tx.append([makeFinishRecordedEvent(projectId, f)]);
        applyEvent(tx, decode(stored!, worktreeUpcasters, worktreeSchemas), projectors);
        const row = selectFinish(db, f.branch);
        if (!row) {
          throw new Error(
            `openWorktreeStore.recordFinish: row missing after projection (branch='${f.branch}')`,
          );
        }
        return row;
      });
    },

    recordFinishAndWorkerDone(
      f: FinishRecorded,
      workerDone: MailEnvelope,
    ): { readonly finish: FinishRecord; readonly workerDone: DeliveredMail } {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureWorktreeTables(db);
        const allProjectors: readonly Projector[] = [new WorktreeProjector(), new MailProjector()];
        const stored = tx.append([
          makeFinishRecordedEvent(projectId, f),
          makeMailEvent(projectId, workerDone),
        ]);
        for (const event of stored) {
          const decoded = worktreeSchemas.has(event.type)
            ? decode(event, worktreeUpcasters, worktreeSchemas)
            : decode(event, mailUpcasters, mailSchemas);
          applyEvent(tx, decoded, allProjectors);
        }
        const finish = selectFinish(db, f.branch);
        const workerDoneRow = selectMailBySeq(db, stored[1]!.seq);
        if (!finish || !workerDoneRow) {
          throw new Error(
            `openWorktreeStore.recordFinishAndWorkerDone: row missing after projection ` +
              `(branch='${f.branch}')`,
          );
        }
        return { finish, workerDone: workerDoneRow };
      });
    },

    getFinish(branch: string): FinishRecord | undefined {
      return store.transaction((tx) => selectFinish(tx.raw as DatabaseSync, branch));
    },

    removeWorktree(branch: string, deps: RemoveWorktreeDeps): WorktreeRecord {
      const gitExec = deps.gitExec ?? defaultGitExec;
      const fs = deps.fs ?? defaultSandboxFs;

      // 1) Locate the recorded sandbox — tearing down an unrecorded branch is a programming error
      //    (Principle 9), not a silent no-op.
      const record = store.transaction((tx) => selectWorktree(tx.raw as DatabaseSync, branch));
      if (!record) {
        throw new Error(
          `openWorktreeStore.removeWorktree: no worktree recorded for branch '${branch}'.`,
        );
      }
      const sandboxPath = assertRecordedSandboxPathBounded(projectId, record.path, branch, fs);

      // 2) Tear down the git worktree + sandbox dir. Tolerate an already-absent dir idempotently
      //    (cleanup, not an error); fail loud on a genuine git failure. git's `.git/worktrees/…`
      //    admin write + the dir deletion are teardown's job — NOT an orchestration write, so they
      //    are deliberately NOT wrapped over the repo (Principle 12 holds via the record path below).
      if (fs.exists(sandboxPath)) {
        gitExec(deps.repoCwd, [
          'worktree',
          'remove',
          ...(deps.force === true ? ['--force'] : []),
          sandboxPath,
        ]);
      } else {
        gitExec(deps.repoCwd, ['worktree', 'prune']);
      }
      fs.removeDir(sandboxPath); // ensure the program-data sandbox dir is gone (no-op if absent).

      // 3) Record the teardown: append `worktree.removed` + fold (marks the record `removed`). This
      //    is the only orchestration write, and it lands ONLY in program-data (Principle 12).
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureWorktreeTables(db);
        const [stored] = tx.append([makeWorktreeRemovedEvent(projectId, { branch })]);
        applyEvent(tx, decode(stored!, worktreeUpcasters, worktreeSchemas), projectors);
        const row = selectWorktree(db, branch);
        if (!row) {
          throw new Error(
            `openWorktreeStore.removeWorktree: row missing after projection (branch='${branch}')`,
          );
        }
        return row;
      });
    },

    detectOrphans(probe: WorktreeRealityProbe = defaultWorktreeRealityProbe(projectId)): Orphan[] {
      // LIVE records (removed = 0) are the recorded reality; a removed record is intentionally gone.
      const live = store
        .transaction((tx) => selectAllWorktrees(tx.raw as DatabaseSync))
        .filter((w) => !w.removed);
      // The sandbox dirs that actually exist, normalized so the comparison is path-shape agnostic.
      const realityPaths = [...new Set(probe().map((p) => resolve(p)))].sort();
      const realitySet = new Set(realityPaths);
      const recordedPaths = new Set(live.map((w) => resolve(w.path)));

      const orphans: Orphan[] = [];
      // dangling-record: a live record whose sandbox no longer exists (in record/creation order).
      for (const w of live) {
        if (!realitySet.has(resolve(w.path))) {
          orphans.push({ branch: w.branch, path: w.path, kind: 'dangling-record' });
        }
      }
      // untracked-sandbox: a real sandbox with no live record (in sorted path order, deterministic).
      for (const p of realityPaths) {
        if (!recordedPaths.has(p)) {
          orphans.push({ path: p, kind: 'untracked-sandbox' });
        }
      }
      return orphans;
    },

    close(): void {
      store.close();
    },
  };
}
