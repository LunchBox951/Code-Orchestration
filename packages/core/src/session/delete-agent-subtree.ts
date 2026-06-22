/**
 * `deleteAgentSubtree` — leaf-first cascade teardown of a coordinator's whole subtree.
 *
 * Algorithm (brief §A5):
 *   1. Build order: `[...descendantsLeafFirst(roster.listAgents(), rootId), rootAgent]` — leaf-first
 *      INCLUDING the root last.
 *   2. Per agent:
 *      a. Find its live worktree (`!w.removed && w.agent === agentId`).
 *      b. If merged: `removeWorktree` + `git branch -d`.
 *         If unmerged: (snapshot if dirty) + `removeWorktree --force` + archive — the branch ref is
 *         KEPT (no `git branch -D`) so the snapshot commit stays reachable until expiry; the reaper /
 *         `purgeArchive` delete it after the TTL. ORDER IS LOAD-BEARING: removeWorktree BEFORE any
 *         (merged-path) `git branch -d`.
 *      c. End the session if still active.
 *      d. Tombstone outstanding actionable mail addressed to the agent, plus non-review actionables
 *         sent by the agent to any surviving recipient.
 *      e. Release any active serialized review/merge slot held by the removed/archived branch.
 *      f. Remove from roster.
 *   3. Collect errors, attempt ALL of `order`, then `throw AggregateError` if any.
 *   4. Open each store once at top; close in `finally`.
 *
 * Correctness notes:
 *   - Mail cleanup is log-derived tombstoning (not row deletion), so stale obligations cannot wake a
 *     future reused id while historical mail remains auditable.
 *   - No router access; the mcp-side B3 job owns suppression before/after this primitive.
 *   - `nowMs` is injected (no wall-clock in core — replay-deterministic).
 */
import { descendantsLeafFirst } from '../roles/subtree.js';
import type { AgentRecord } from '../roles/events.js';
import {
  isBranchMerged,
  localBranchExists,
  isWorktreeDirty,
  snapshotDirtyWorktree,
} from '../worktrees/branch-state.js';
import { openRosterStore, type RosterStore } from '../roles/roster-store.js';
import { openWorktreeStore, type WorktreeStore } from '../worktrees/worktree-store.js';
import { openSessionStore, type SessionStore } from './session-store.js';
import { openArchiveStore, type ArchiveStore } from '../archive/archive-store.js';
import { openMailStore, type MailStore } from '../mail/mail-store.js';
import { MAIL_REVIEW_REQUEST, MAIL_REVIEW_RESPONSE, type DeliveredMail } from '../mail/events.js';
import { openReviewStore, type ReviewStore } from '../review/review-store.js';
import { defaultGitExec, type GitExec } from '../worktrees/sling.js';
import { isMissingBranchDeleteError } from '../worktrees/branch-delete.js';
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
  /** Factory for the mail store; defaults to `openMailStore`. */
  readonly openMail?: (projectId: string) => MailStore;
  /** Factory for the review store; defaults to `openReviewStore`. */
  readonly openReview?: (projectId: string) => ReviewStore;
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

export interface DeleteAgentSubtreePreflightDeps {
  /** Factory for the roster store; defaults to `openRosterStore`. */
  readonly openRoster?: (projectId: string) => RosterStore;
  /** Factory for the mail store; defaults to `openMailStore`. */
  readonly openMail?: (projectId: string) => MailStore;
}

export interface DeleteAgentSubtreeResult {
  /** Agent ids removed from the roster, leaf-first (includes the root last). */
  readonly removed: readonly string[];
  /** Unmerged branches that were archived (branch kept, expiry set). */
  readonly archivedBranches: readonly string[];
  /** Merged branches that were deleted (clean `branch -d`). */
  readonly deletedBranches: readonly string[];
}

function isReviewMail(mail: DeliveredMail): boolean {
  return mail.type === MAIL_REVIEW_REQUEST || mail.type === MAIL_REVIEW_RESPONSE;
}

function isNonRetractedActionable(mail: DeliveredMail): boolean {
  return mail.kind === 'actionable' && mail.retracted !== true;
}

function isUnresolvedActionable(mail: DeliveredMail): boolean {
  return isNonRetractedActionable(mail) && mail.resolved !== true;
}

function shouldRetractDuringDelete(mail: DeliveredMail): boolean {
  return isNonRetractedActionable(mail) && !isReviewMail(mail);
}

function teardownOrder(roster: RosterStore, rootId: string): readonly AgentRecord[] {
  const rootAgent = roster.getAgent(rootId);
  if (!rootAgent) {
    throw new Error(`deleteAgentSubtree: root agent '${rootId}' not found in roster`);
  }
  return [...descendantsLeafFirst(roster.listAgents(), rootId), rootAgent];
}

function reviewCleanupBlockers(mail: MailStore, agentId: string): Error[] {
  const blockers: Error[] = [];
  for (const item of mail.inbox(agentId)) {
    if (isUnresolvedActionable(item) && isReviewMail(item)) {
      blockers.push(
        new Error(
          `deleteAgentSubtree: cannot delete '${agentId}' while review mail ` +
            `'${item.type}' seq=${item.seq} is outstanding for that agent`,
        ),
      );
    }
  }
  for (const item of mail.sentBy(agentId)) {
    if (isUnresolvedActionable(item) && isReviewMail(item)) {
      blockers.push(
        new Error(
          `deleteAgentSubtree: cannot delete '${agentId}' while review mail ` +
            `'${item.type}' seq=${item.seq} from that agent is outstanding for '${item.recipient}'`,
        ),
      );
    }
  }
  return blockers;
}

function cleanupDeleteMail(mail: MailStore, agentId: string): number {
  let cleared = 0;
  if (mail.inbox(agentId).some(shouldRetractDuringDelete)) {
    cleared += mail.clearOutstanding(agentId);
  }

  const recipients = new Set<string>();
  for (const item of mail.sentBy(agentId)) {
    if (shouldRetractDuringDelete(item)) recipients.add(item.recipient);
  }
  for (const recipient of recipients) {
    cleared += mail.clearOutstandingFromSenderToRecipient(agentId, recipient);
  }
  return cleared;
}

function releaseDeletedBranchSlot(reviews: ReviewStore, target: string, branch: string): void {
  if (reviews.activeSerialized(target) !== branch) return;
  reviews.releaseSerialized({ target, branch });
}

function assertPreflight(order: readonly { agentId: string }[], mail: MailStore): void {
  const preflightErrors = order.flatMap((agent) => reviewCleanupBlockers(mail, agent.agentId));
  if (preflightErrors.length > 0) {
    throw new AggregateError(preflightErrors, 'deleteAgentSubtree: review mail blocks teardown');
  }
}

export function assertDeleteAgentSubtreePreflight(
  projectId: string,
  rootId: string,
  deps: DeleteAgentSubtreePreflightDeps = {},
): void {
  const { openRoster: openRosterFn = openRosterStore, openMail: openMailFn = openMailStore } = deps;
  // Open mail inside roster's try so a throwing mail-open still closes the roster handle.
  const roster = openRosterFn(projectId);
  try {
    const mail = openMailFn(projectId);
    try {
      assertPreflight(teardownOrder(roster, rootId), mail);
    } finally {
      mail.close();
    }
  } finally {
    roster.close();
  }
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
    openMail: openMailFn = openMailStore,
    openReview: openReviewFn = openReviewStore,
    repoCwd,
    nowMs,
    archiveTtlMs = ARCHIVE_TTL_MS,
  } = deps;
  const gitExec = deps.gitExec ?? defaultGitExec;
  const gitReader = deps.gitReader ?? defaultGitReader;

  // Open every store INSIDE the try and track opened handles, so a throw from any open (not just
  // the first) still closes the handles opened before it. Opening all six before the try would
  // leak up to five handles if a later open threw (Principle 9 — release resources on every path).
  const opened: Array<{ close(): void }> = [];
  const track = <T extends { close(): void }>(store: T): T => {
    opened.push(store);
    return store;
  };

  try {
    const roster = track(openRosterFn(projectId));
    const worktrees = track(openWorktreesFn(projectId));
    const sessions = track(openSessionsFn(projectId));
    const archive = track(openArchiveFn(projectId));
    const mail = track(openMailFn(projectId));
    const reviews = track(openReviewFn(projectId));

    // Step 1: build the teardown order — leaf-first, root last.
    const order = teardownOrder(roster, rootId);
    assertPreflight(order, mail);

    const errors: Error[] = [];
    const removed: string[] = [];
    const archivedBranches: string[] = [];
    const deletedBranches: string[] = [];

    // Step 2: tear down each agent individually; collect errors so we can attempt all.
    for (const agent of order) {
      const agentId = agent.agentId;
      let agentTeardownFailed = false;
      const recordAgentError = (e: unknown): void => {
        errors.push(e instanceof Error ? e : new Error(String(e)));
        agentTeardownFailed = true;
      };

      // 2a: Find the agent's live worktree.
      const wt = worktrees
        .listWorktrees()
        .find((w) => w.agent === agentId && (!w.removed || archive.getRecord(w.branch) == null));

      if (wt != null) {
        try {
          const branchExists = localBranchExists(repoCwd, wt.branch, gitReader);
          const alreadyDeletedMergedBranch = wt.removed && !branchExists;
          if (!branchExists && !wt.removed) {
            // #65: the live worktree's branch ref is already gone (out-of-band `git branch -D`,
            // a force-push, or a history rewrite). There is no recoverable work left to preserve
            // and no branch to delete, so force-remove the orphaned worktree and continue the
            // cascade instead of wedging the whole subtree delete. We deliberately do NOT archive:
            // the archive stores only metadata, so a "Restore" would have no branch ref to restore
            // to. The safety property still holds — we never delete a branch holding unmerged work
            // (there is no branch here), we only clean up the stranded worktree.
            try {
              worktrees.removeWorktree(wt.branch, { repoCwd, gitExec, force: true });
            } catch (e) {
              recordAgentError(e);
            }
          } else if (alreadyDeletedMergedBranch) {
            try {
              gitExec(repoCwd, ['branch', '-d', wt.branch]);
              deletedBranches.push(wt.branch);
            } catch (e) {
              // Retry after a merged branch was already deleted: only a proven missing-branch
              // error is idempotent. Other git failures mean the branch state is unknown.
              if (!isMissingBranchDeleteError(e, wt.branch)) recordAgentError(e);
            }
          } else if (!alreadyDeletedMergedBranch) {
            const merged = isBranchMerged(repoCwd, wt.branch, wt.baseRef, gitReader);

            if (!merged) {
              // Unmerged: snapshot if dirty, then force-remove the worktree, archive — but DO NOT delete
              // the branch. The branch ref `co/<id>` must SURVIVE: the archive record stores only metadata
              // (no ref), so a `git branch -D` here would make the snapshot commit unreachable (GC-eligible)
              // — unmerged work would be LOST and "Restore" would have no branch to restore to. The reaper
              // (`reapExpiredArchives`) / `purgeArchive` delete it after expiry.
              if (!wt.removed) {
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
                  recordAgentError(e);
                }
              }

              if (!agentTeardownFailed && !wt.removed) {
                try {
                  worktrees.removeWorktree(wt.branch, { repoCwd, gitExec, force: true });
                } catch (e) {
                  recordAgentError(e);
                }
              }

              if (!agentTeardownFailed) {
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
                  recordAgentError(e);
                }
              }
            } else {
              // Merged: clean remove worktree + safe branch delete.
              if (!wt.removed) {
                try {
                  worktrees.removeWorktree(wt.branch, { repoCwd, gitExec });
                } catch (e) {
                  recordAgentError(e);
                }
              }

              if (!agentTeardownFailed) {
                try {
                  gitExec(repoCwd, ['branch', '-d', wt.branch]);
                  // Result-honesty: only record the branch as deleted once `git branch -d` actually
                  // returned (mirrors how the unmerged path pushes `archivedBranches` inside its try).
                  deletedBranches.push(wt.branch);
                } catch (e) {
                  if (!isMissingBranchDeleteError(e, wt.branch)) recordAgentError(e);
                }
              }
            }
          }
        } catch (e) {
          recordAgentError(e);
        }
      }

      if (agentTeardownFailed) {
        continue;
      }

      // 2c: End the session if still active.
      try {
        const s = sessions.getSession(agentId);
        if (s) {
          sessions.endSession(agentId, s.pane);
        }
      } catch (e) {
        errors.push(e instanceof Error ? e : new Error(String(e)));
        continue;
      }

      // 2d: Tombstone stale actionables tied to this agent:
      // - addressed to it, so deleted ids cannot be woken by old mail;
      // - sent by it, so terminal obligations in surviving inboxes do not point at deleted ids.
      try {
        cleanupDeleteMail(mail, agentId);
      } catch (e) {
        errors.push(e instanceof Error ? e : new Error(String(e)));
        continue;
      }

      // 2e: Release PASS-held serialized review/merge slots for branches this delete just made
      // non-live. Resolved human review mail remains auditable; only the stale slot is toggled.
      // On the normal pass `wt` is the live row. On a RETRY where the worktree was already
      // removed+archived the 2a finder skips it, so `wt` is null — fall back to ALL of the agent's
      // worktree rows (removed included) so a slot held by ANY torn-down branch is released, not just
      // the first. Without this a stale slot is stranded behind a deleted branch and every later merge
      // into that target queues forever (MC-CD-1). `releaseDeletedBranchSlot` is idempotent (no-op
      // unless that branch currently holds the slot), so releasing across passes/rows is safe.
      try {
        const slotWts =
          wt != null ? [wt] : worktrees.listWorktrees().filter((w) => w.agent === agentId);
        for (const sw of slotWts) releaseDeletedBranchSlot(reviews, sw.baseRef, sw.branch);
      } catch (e) {
        errors.push(e instanceof Error ? e : new Error(String(e)));
        continue;
      }

      // 2f: Remove from roster (only safe after all children already removed, which leaf-first ensures).
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
    // Close in reverse open order; a failing close must not strand the sibling handles.
    for (const store of opened.reverse()) {
      try {
        store.close();
      } catch {
        // keep closing the rest.
      }
    }
  }
}
