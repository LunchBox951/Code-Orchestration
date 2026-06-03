import { execFileSync } from 'node:child_process';

/** Read-only facts about the git worktree an agent is operating in (the `co_worktree_info` core). */
export interface WorktreeInfo {
  /** The current branch name (`rev-parse --abbrev-ref HEAD`), or `HEAD` if detached. */
  readonly branch: string;
  /** The full HEAD commit sha (`rev-parse HEAD`). */
  readonly headSha: string;
  /** True iff the working tree has uncommitted changes (tracked or untracked). */
  readonly dirty: boolean;
}

/**
 * Run a READ-ONLY git command in `cwd` and return its trimmed stdout. We pass
 * `--no-optional-locks` so even `status` never refreshes/writes `.git/index` — the probe
 * writes nothing into the repo (Principle 12 — pristine-repo holds). Fails loud (Principle 9)
 * with a clear message if git is unavailable or `cwd` is not a repo, rather than returning
 * fabricated values.
 */
function readonlyGit(cwd: string, args: readonly string[]): string {
  try {
    return execFileSync('git', ['--no-optional-locks', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `readWorktreeInfo: read-only \`git ${args.join(' ')}\` failed in '${cwd}' ` +
        `(not a git repository, or git is unavailable): ${detail}`,
      { cause },
    );
  }
}

/**
 * Read the branch / HEAD sha / dirty flag of the git worktree at `cwd` using only read-only
 * git. This is the core the `co_worktree_info` tool dispatches to; it never writes the repo.
 * `base` (a dispatch metadatum, not reliably git-derivable) is deliberately NOT returned — that
 * is L3+.
 */
export function readWorktreeInfo(cwd: string): WorktreeInfo {
  const branch = readonlyGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const headSha = readonlyGit(cwd, ['rev-parse', 'HEAD']);
  const dirty = readonlyGit(cwd, ['status', '--porcelain']).length > 0;
  return { branch, headSha, dirty };
}
