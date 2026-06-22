import { existsSync } from 'node:fs';
import { defaultGitExec, type GitExec } from './sling.js';
import { defaultGitReader, type GitReader } from './detect-base.js';

/**
 * True iff every commit of `branch` is reachable from `baseRef` (i.e. fully merged).
 * Exit-code based: `defaultGitReader` returns `''` (empty string) on exit 0 (merged)
 * and `null` on exit 1 (not merged).
 *
 * Any non-zero `merge-base --is-ancestor` exit — including a broken-git / bad-ref exit 128 — is
 * collapsed to `null` by the reader and therefore treated as "not merged". That is a deliberately
 * SAFE default: an ambiguous result archives/preserves the branch rather than hard-deleting it.
 */
export function isBranchMerged(
  repoCwd: string,
  branch: string,
  baseRef: string,
  gitReader: GitReader = defaultGitReader,
): boolean {
  return gitReader(repoCwd, ['merge-base', '--is-ancestor', branch, baseRef]) != null;
}

/** True iff the local branch ref exists. */
export function localBranchExists(
  repoCwd: string,
  branch: string,
  gitReader: GitReader = defaultGitReader,
): boolean {
  return gitReader(repoCwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) != null;
}

/**
 * True iff the sandbox worktree has uncommitted changes (`git status --porcelain` non-empty).
 */
export function isWorktreeDirty(
  sandboxPath: string,
  gitReader: GitReader = defaultGitReader,
): boolean {
  const out = gitReader(sandboxPath, ['status', '--porcelain']);
  if (out == null) {
    throw new Error(`unable to read git status for worktree '${sandboxPath}'`);
  }
  return out.trim().length > 0;
}

function isAbsentDirError(cause: unknown): boolean {
  return (
    cause != null &&
    typeof cause === 'object' &&
    'code' in cause &&
    (cause as { code?: unknown }).code === 'ENOENT'
  );
}

/**
 * Dirty probe for teardown paths. It treats an absent sandbox as clean so idempotent teardown can
 * continue through {@link import('./worktree-store.js').WorktreeStore.removeWorktree}; present-tree
 * status failures still propagate so unknown state is not silently downgraded.
 */
export function probeWorktreeDirty(
  sandboxPath: string,
  gitReader: GitReader = defaultGitReader,
  pathExists: (path: string) => boolean = existsSync,
): boolean {
  if (!pathExists(sandboxPath)) return false;
  try {
    return isWorktreeDirty(sandboxPath, gitReader);
  } catch (cause) {
    // A sandbox that raced away after the pre-check makes git fail; the production reader collapses
    // that to a plain "unable to read git status" Error (no ENOENT code), so re-check existence
    // rather than matching cause.code. A still-present tree means a genuine status failure → re-throw.
    if (!pathExists(sandboxPath) || isAbsentDirError(cause)) return false;
    throw cause;
  }
}

/**
 * Commit all uncommitted work in the sandbox to its branch (DCO sign-off).
 * Returns the new head sha.
 */
export function snapshotDirtyWorktree(
  sandboxPath: string,
  message: string,
  gitExec: GitExec = defaultGitExec,
  gitReader: GitReader = defaultGitReader,
): string {
  gitExec(sandboxPath, ['add', '-A']);
  gitExec(sandboxPath, ['commit', '-s', '-m', message]);
  return (gitReader(sandboxPath, ['rev-parse', 'HEAD']) ?? '').trim();
}
