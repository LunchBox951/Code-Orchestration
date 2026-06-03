import type { DatabaseSync } from 'node:sqlite';
import { decode } from '../replay/decode.js';
import { applyEvent, type Projector } from '../replay/projector.js';
import { openProjectStore } from '../store/sqlite-store.js';
import {
  makeBaselineCapturedEvent,
  makeFinishRecordedEvent,
  makeWorktreeCreatedEvent,
  worktreeSchemas,
  worktreeUpcasters,
  type Baseline,
  type BaselineCaptured,
  type FinishRecord,
  type FinishRecorded,
  type WorktreeCreated,
  type WorktreeRecord,
} from './events.js';
import {
  WorktreeProjector,
  ensureWorktreeTables,
  selectAllWorktrees,
  selectBaseline,
  selectFinish,
  selectWorktree,
} from './worktree-projector.js';

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
  /** The baseline for `branch`, or undefined. */
  getBaseline(branch: string): Baseline | undefined;
  /**
   * Record a finish (append `finish.recorded` + fold); returns the read-back record. The commit sha
   * + the finish's test run that L5 compares against the baseline. A re-finish UPSERTs (last wins).
   */
  recordFinish(f: FinishRecorded): FinishRecord;
  /** The recorded finish for `branch`, or undefined (no finish yet). */
  getFinish(branch: string): FinishRecord | undefined;
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

    getFinish(branch: string): FinishRecord | undefined {
      return store.transaction((tx) => selectFinish(tx.raw as DatabaseSync, branch));
    },

    close(): void {
      store.close();
    },
  };
}
