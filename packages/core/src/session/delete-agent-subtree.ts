/**
 * `deleteAgentSubtree` — leaf-first cascade teardown of a coordinator's whole subtree.
 *
 * Algorithm (brief §A5):
 *   1. Build order: `[...descendantsLeafFirst(roster.listAgents(), rootId), rootAgent]` — leaf-first
 *      INCLUDING the root last.
 *   2. Per agent:
 *      a. Find its live worktree (`!w.removed && w.agent === agentId`).
 *      b. If merged: `removeWorktree` + `git branch -d`.
 *         If unmerged: (snapshot if dirty) + `removeWorktree --force` + `git branch -D` + archive.
 *         ORDER IS LOAD-BEARING: removeWorktree BEFORE `git branch -D/-d`.
 *      c. End the session if still active.
 *      d. Remove from roster.
 *   3. Collect errors, attempt ALL of `order`, then `throw AggregateError` if any.
 *   4. Open each store once at top; close in `finally`.
 *
 * Correctness notes:
 *   - No mail cleanup (orphaned mail is inert once its recipient is gone — see brief §A5).
 *   - No router access (that is the mcp-side B3 job, which calls this primitive after unstop).
 *   - `nowMs` is injected (no wall-clock in core — replay-deterministic).
 */
import { descendantsLeafFirst } from '../roles/subtree.js';
import {
  isBranchMerged,
  isWorktreeDirty,
  snapshotDirtyWorktree,
} from '../worktrees/branch-state.js';
import { openRosterStore, type RosterStore } from '../roles/roster-store.js';
import { openWorktreeStore, type WorktreeStore } from '../worktrees/worktree-store.js';
import { openSessionStore, type SessionStore } from './session-store.js';
import { openArchiveStore, type ArchiveStore } from '../archive/archive-store.js';
import { defaultGitExec, type GitExec } from '../worktrees/sling.js';
import { defaultGitReader, type GitReader } from '../worktrees/detect-base.js';

/** Default archive TTL: 14 days. */
export const ARCHIVE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface DeleteAgentSubtreeDeps {
  /** Factory for the roster store; defaults to `openRosterStore`. */
  readonly openRoster?: (projectId: string) => RosterStore;
  /** Factory for the worktree store; defaults to `openWorktreeStore`. */
  readonly openWorktrees?: (projectId: string) => WorktreeStore;
  /** Factory for the session store; defaults to `openSessionStore`. */
  readonly openSessions?: (projectId: string) => SessionStore;
  /** Factory for the archive store; defaults to `openArchiveStore`. */
  readonly openArchive?: (projectId: string) => ArchiveStore;
  /** The main-repo working directory (where `git worktree remove` / `git branch` run). */
  readonly repoCwd: string;
  /** Injected clock — used for `deletedAt` and `expiresAt`. Never wall-clock in core. */
  readonly nowMs: number;
  /** Archive TTL in milliseconds. Defaults to {@link ARCHIVE_TTL_MS} (14 days). */
  readonly archiveTtlMs?: number;
  /** Mutating git seam (defaults to `defaultGitExec`). */
  readonly gitExec?: GitExec;
  /** Read-only git seam (defaults to `defaultGitReader`). */
  readonly gitReader?: GitReader;
}

export interface DeleteAgentSubtreeResult {
  /** Agent ids removed from the roster, leaf-first (includes the root last). */
  readonly removed: readonly string[];
  /** Unmerged branches that were archived (branch kept, expiry set). */
  readonly archivedBranches: readonly string[];
  /** Merged branches that were deleted (clean `branch -d`). */
  readonly deletedBranches: readonly string[];
}

/**
 * Tear down a coordinator's entire subtree in leaf-first order, archiving unmerged branches.
 *
 * @param projectId - The project id used to open stores.
 * @param rootId    - The root agent id whose subtree (including itself) is torn down.
 * @param deps      - Injectable seams (git exec/reader, store factories, clock, TTL).
 * @returns A summary of what was removed / archived / deleted.
 * @throws {AggregateError} with `message = 'deleteAgentSubtree: partial teardown failure'` if any
 *   per-agent side-effect threw.  All agents are attempted regardless of earlier failures.
 */
export function deleteAgentSubtree(
  projectId: string,
  rootId: string,
  deps: DeleteAgentSubtreeDeps,
): DeleteAgentSubtreeResult {
  const {
    openRoster: openRosterFn = openRosterStore,
    openWorktrees: openWorktreesFn = openWorktreeStore,
    openSessions: openSessionsFn = openSessionStore,
    openArchive: openArchiveFn = openArchiveStore,
    repoCwd,
    nowMs,
    archiveTtlMs = ARCHIVE_TTL_MS,
  } = deps;
  const gitExec = deps.gitExec ?? defaultGitExec;
  const gitReader = deps.gitReader ?? defaultGitReader;

  const roster = openRosterFn(projectId);
  const worktrees = openWorktreesFn(projectId);
  const sessions = openSessionsFn(projectId);
  const archive = openArchiveFn(projectId);

  try {
    // Step 1: build the teardown order — leaf-first, root last.
    const rootAgent = roster.getAgent(rootId);
    if (!rootAgent) {
      throw new Error(`deleteAgentSubtree: root agent '${rootId}' not found in roster`);
    }
    const descendants = descendantsLeafFirst(roster.listAgents(), rootId);
    const order = [...descendants, rootAgent];

    const errors: Error[] = [];
    const removed: string[] = [];
    const archivedBranches: string[] = [];
    const deletedBranches: string[] = [];

    // Step 2: tear down each agent individually; collect errors so we can attempt all.
    for (const agent of order) {
      const agentId = agent.agentId;

      // 2a: Find the agent's live worktree.
      const wt = worktrees.listWorktrees().find((w) => !w.removed && w.agent === agentId);

      if (wt != null) {
        try {
          const merged = isBranchMerged(repoCwd, wt.branch, wt.baseRef, gitReader);

          if (!merged) {
            // Unmerged: snapshot if dirty, then force-remove worktree, force-delete branch, archive.
            try {
              if (isWorktreeDirty(wt.path, gitReader)) {
                snapshotDirtyWorktree(
                  wt.path,
                  'co: archive snapshot before delete',
                  gitExec,
                  gitReader,
                );
              }
            } catch (e) {
              errors.push(e instanceof Error ? e : new Error(String(e)));
            }

            try {
              worktrees.removeWorktree(wt.branch, { repoCwd, gitExec, force: true });
            } catch (e) {
              errors.push(e instanceof Error ? e : new Error(String(e)));
            }

            try {
              gitExec(repoCwd, ['branch', '-D', wt.branch]);
            } catch (e) {
              errors.push(e instanceof Error ? e : new Error(String(e)));
            }

            try {
              archive.appendRecord({
                id: wt.branch,
                name: agent.name ?? agentId,
                branch: wt.branch,
                baseRef: wt.baseRef,
                deletedAt: nowMs,
                expiresAt: nowMs + archiveTtlMs,
              });
              archivedBranches.push(wt.branch);
            } catch (e) {
              errors.push(e instanceof Error ? e : new Error(String(e)));
            }
          } else {
            // Merged: clean remove worktree + safe branch delete.
            try {
              worktrees.removeWorktree(wt.branch, { repoCwd, gitExec });
            } catch (e) {
              errors.push(e instanceof Error ? e : new Error(String(e)));
            }

            try {
              gitExec(repoCwd, ['branch', '-d', wt.branch]);
            } catch (e) {
              errors.push(e instanceof Error ? e : new Error(String(e)));
            }

            deletedBranches.push(wt.branch);
          }
        } catch (e) {
          errors.push(e instanceof Error ? e : new Error(String(e)));
        }
      }

      // 2c: End the session if still active.
      try {
        const s = sessions.getSession(agentId);
        if (s) {
          sessions.endSession(agentId, s.pane);
        }
      } catch (e) {
        errors.push(e instanceof Error ? e : new Error(String(e)));
      }

      // 2d: Remove from roster (only safe after all children already removed, which leaf-first ensures).
      try {
        roster.removeAgent(agentId);
        removed.push(agentId);
      } catch (e) {
        errors.push(e instanceof Error ? e : new Error(String(e)));
      }
    }

    // Step 3: after attempting ALL agents, surface collected errors.
    if (errors.length > 0) {
      throw new AggregateError(errors, 'deleteAgentSubtree: partial teardown failure');
    }

    return { removed, archivedBranches, deletedBranches };
  } finally {
    roster.close();
    worktrees.close();
    sessions.close();
    archive.close();
  }
}
