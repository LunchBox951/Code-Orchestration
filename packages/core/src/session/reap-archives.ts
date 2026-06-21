/**
 * Archive reaper: purges expired unmerged coordinator branches.
 *
 * For each archive record with `expiresAt < nowMs`:
 *   1. `git branch -D` the branch (collect errors, never silent skip — Principle 9)
 *   2. Remove the record from the archive
 *
 * Aggregate errors into an AggregateError; return the purged branch names.
 * `nowMs` is injected (no wall-clock in core). Open the store once; close in finally.
 * Defaults: `gitExec` → `defaultGitExec`, `openArchive` → `openArchiveStore` (no seam undefined).
 */
import type { ArchiveStore } from '../archive/archive-store.js';
import { openArchiveStore } from '../archive/archive-store.js';
import type { GitExec } from '../worktrees/sling.js';
import { defaultGitExec } from '../worktrees/sling.js';

export interface ReapArchivesDeps {
  /** Injected archive store opener; defaults to openArchiveStore. */
  readonly openArchive?: (projectId: string) => ArchiveStore;
  /** The repository working directory (where branches live). */
  readonly repoCwd: string;
  /** Injected git executor; defaults to defaultGitExec. */
  readonly gitExec?: GitExec;
}

/**
 * Purge all archive records whose `expiresAt < nowMs`.
 *
 * For each expired record:
 *   - Calls `gitExec(repoCwd, ['branch', '-D', rec.branch])` (catch → collect errors)
 *   - Calls `archive.removeRecord(rec.id)` (remove from archive)
 *
 * Collects all branch-deletion errors and re-throws as AggregateError if any occurred.
 * Returns the list of purged branch names (successful deletions).
 *
 * Closes the archive store in a finally block, regardless of errors.
 *
 * @param projectId The project id (used to open the archive store).
 * @param nowMs The current timestamp (injected — replay-deterministic).
 * @param deps Injection seams: openArchive, repoCwd, gitExec (with sensible defaults).
 * @returns The list of purged branch names.
 * @throws AggregateError if any branch deletions failed (never swallows errors — Principle 9).
 */
export function reapExpiredArchives(
  projectId: string,
  nowMs: number,
  deps: ReapArchivesDeps,
): readonly string[] {
  const { openArchive = openArchiveStore, gitExec = defaultGitExec, repoCwd } = deps;

  const archive = openArchive(projectId);
  const purgedBranches: string[] = [];
  const errors: Error[] = [];

  try {
    const expired = archive.listExpired(nowMs);

    for (const rec of expired) {
      // Try to delete the branch; collect errors if it fails.
      try {
        gitExec(repoCwd, ['branch', '-D', rec.branch]);
        purgedBranches.push(rec.branch);
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }

      // Remove the record from the archive (regardless of branch deletion outcome).
      archive.removeRecord(rec.id);
    }
  } finally {
    archive.close();
  }

  // Principle 9: aggregate errors, never silent skip.
  if (errors.length > 0) {
    throw new AggregateError(errors, 'archive reaper: branch deletion failures');
  }

  return purgedBranches;
}
