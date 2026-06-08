import type { DatabaseSync } from 'node:sqlite';
import { decode } from '../replay/decode.js';
import { applyEvent, type Projector } from '../replay/projector.js';
import { openProjectStore } from '../store/sqlite-store.js';
import {
  makeReviewRequestedEvent,
  makeReviewStrikeEvent,
  makeReviewVerdictEvent,
  reviewSchemas,
  reviewUpcasters,
  type ReviewRequested,
  type ReviewRequestRecord,
  type ReviewStrike,
  type ReviewVerdictRecord,
  type ReviewVerdictRecorded,
} from './events.js';
import {
  ensureReviewTables,
  ReviewProjector,
  selectReviewRequest,
  selectStrikeCount,
  selectVerdict,
  selectVerdictsForTarget,
} from './review-projector.js';

/**
 * The headless L5 review store over a single project store (the L5 analogue of L3's
 * {@link import('../worktrees/worktree-store.js').WorktreeStore}). It records the orchestration facts
 * of a review — the structured verdict (and a minimal request) — entirely in program-data, never the
 * repo (Principle 12 — pristine-repo). A recording event-sources its read-model row in the same
 * transaction as the append (so the log and projection commit atomically), then reads it straight back;
 * reads are plain projections.
 *
 * Opening this alongside the mail / worktree / dispatch stores on the SAME per-project `store.db` is
 * safe: `node:sqlite` is synchronous/single-threaded so transactions never interleave in-process, and
 * this store owns a DIFFERENT scope (`review:`) and read-model table (`reviews`) than the others.
 *
 * The facade is shaped so phases B–F slot in additively: `recordStrike` / `recordSerialized` /
 * `recordOverride` become NEW methods folding the events whose schemas are already defined +
 * projected, with no change here. (They are deliberately NOT declared yet — adding a method that
 * threw would be the banned silent stub; the seam is "left room for", not pre-stubbed.)
 */
export interface ReviewStore {
  /**
   * Record a verdict (append `review.verdict` + fold); returns the read-back record. The builder runs
   * {@link import('./verdict.js').assertValidVerdict}, so an `{verdict:'ISSUES', blockers:[]}` throws.
   */
  recordVerdict(v: ReviewVerdictRecorded): ReviewVerdictRecord;
  /**
   * The latest verdict for `branch` on `target`, or undefined. UPSERT/last-wins (like `recordFinish`):
   * a re-review after an ISSUES→fix returns the LATEST verdict — which is the one `co_merge` gates on.
   */
  getVerdict(target: string, branch: string): ReviewVerdictRecord | undefined;
  /** Every recorded verdict on `target`, oldest-recorded first. */
  listVerdicts(target: string): readonly ReviewVerdictRecord[];
  /**
   * Record a review request (append `review.requested` + fold); returns the read-back record. Minimal
   * now — the request flow's real consumer is Phase E.
   */
  recordReviewRequested(r: ReviewRequested): ReviewRequestRecord;
  /** The latest review request for `branch` on `target`, or undefined. */
  getReviewRequest(target: string, branch: string): ReviewRequestRecord | undefined;
  /**
   * Record a strike against `branch` on `target` (append `review.strike` + fold). Called by
   * {@link import('./strikes.js').applyStrikePolicy} on each freshly-recorded ISSUES verdict; the
   * consecutive count is reset to 0 when a PASS verdict is recorded for the same (target, branch).
   */
  recordStrike(s: ReviewStrike): void;
  /** The current consecutive `review.strike` count for `branch` on `target` (0 if none). */
  getStrikeCount(target: string, branch: string): number;
  /** Close the underlying project store. */
  close(): void;
}

/**
 * Open the project review store: open the PROJECT store, wire the {@link ReviewProjector}, and return
 * the {@link ReviewStore} facade. The store is resolved by the MOUNT (a tool never opens its own store)
 * and injected onto {@link import('../tools/context.js').ToolContext}.`reviews`.
 */
export function openReviewStore(projectId: string): ReviewStore {
  const store = openProjectStore(projectId);
  const projectors: readonly Projector[] = [new ReviewProjector()];

  return {
    recordVerdict(v: ReviewVerdictRecorded): ReviewVerdictRecord {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureReviewTables(db);
        const [stored] = tx.append([makeReviewVerdictEvent(projectId, v)]);
        applyEvent(tx, decode(stored!, reviewUpcasters, reviewSchemas), projectors);
        const row = selectVerdict(db, v.target, v.branch);
        if (!row) {
          throw new Error(
            `openReviewStore.recordVerdict: row missing after projection ` +
              `(target='${v.target}', branch='${v.branch}')`,
          );
        }
        return row;
      });
    },

    getVerdict(target: string, branch: string): ReviewVerdictRecord | undefined {
      return store.transaction((tx) => selectVerdict(tx.raw as DatabaseSync, target, branch));
    },

    listVerdicts(target: string): readonly ReviewVerdictRecord[] {
      return store.transaction((tx) => selectVerdictsForTarget(tx.raw as DatabaseSync, target));
    },

    recordReviewRequested(r: ReviewRequested): ReviewRequestRecord {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureReviewTables(db);
        const [stored] = tx.append([makeReviewRequestedEvent(projectId, r)]);
        applyEvent(tx, decode(stored!, reviewUpcasters, reviewSchemas), projectors);
        const row = selectReviewRequest(db, r.target, r.branch);
        if (!row) {
          throw new Error(
            `openReviewStore.recordReviewRequested: row missing after projection ` +
              `(target='${r.target}', branch='${r.branch}')`,
          );
        }
        return row;
      });
    },

    getReviewRequest(target: string, branch: string): ReviewRequestRecord | undefined {
      return store.transaction((tx) => selectReviewRequest(tx.raw as DatabaseSync, target, branch));
    },

    recordStrike(s: ReviewStrike): void {
      store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        ensureReviewTables(db);
        const [stored] = tx.append([makeReviewStrikeEvent(projectId, s)]);
        applyEvent(tx, decode(stored!, reviewUpcasters, reviewSchemas), projectors);
      });
    },

    getStrikeCount(target: string, branch: string): number {
      return store.transaction((tx) => selectStrikeCount(tx.raw as DatabaseSync, target, branch));
    },

    close(): void {
      store.close();
    },
  };
}
