import { execFileSync } from 'node:child_process';

/**
 * Read-only git seam used by base auto-detect: run `git <args>` in `cwd` and return trimmed stdout,
 * or `null` when git exits non-zero (the ref/branch does not exist). Returning `null` rather than
 * throwing is deliberate — it lets the detection chain FALL THROUGH a missing rung to the next one;
 * a genuinely broken git (or non-repo) still surfaces loudly at {@link resolveRefSha}, which is the
 * fail-loud read every successful detection ends in.
 *
 * It passes `--no-optional-locks` so even a status-touching command never writes `.git` (Principle
 * 12 — pristine-repo; same discipline as `tools/worktree.ts`). Injectable so the chain is tested
 * headless against recorded fixtures with no real git.
 */
export type GitReader = (cwd: string, args: readonly string[]) => string | null;

/** Intentional cap for raw git stdout; large review diffs degrade instead of hitting Node's hidden default. */
export const GIT_RAW_READER_MAX_BUFFER = 16 * 1024 * 1024;

/** Raw read-only git stdout, `null` on a non-zero exit. Use this for byte-sensitive reads like diffs. */
export const defaultGitRawReader: GitReader = (cwd, args) => {
  try {
    return execFileSync('git', ['--no-optional-locks', '--no-pager', ...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: GIT_RAW_READER_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    // Non-zero exit ⇒ the ref/branch is absent; the chain falls through to the next rung.
    return null;
  }
};

/** The production {@link GitReader}: read-only git, trimmed for ref/sha-oriented reads. */
export const defaultGitReader: GitReader = (cwd, args) => {
  const output = defaultGitRawReader(cwd, args);
  return output == null ? null : output.trim();
};

const REMOTE_REF_PREFIX = 'refs/remotes/';
const LOCAL_HEAD_PREFIX = 'refs/heads/';

function remoteDefaultToLocalBranch(ref: string): string | undefined {
  if (ref.startsWith(REMOTE_REF_PREFIX)) {
    const remoteAndBranch = ref.slice(REMOTE_REF_PREFIX.length);
    const slash = remoteAndBranch.indexOf('/');
    return slash === -1 ? undefined : remoteAndBranch.slice(slash + 1);
  }
  if (ref.startsWith(LOCAL_HEAD_PREFIX)) return ref.slice(LOCAL_HEAD_PREFIX.length);
  return undefined;
}

/**
 * Auto-detect the base ref a new sandbox should branch from — THE #1 frozen invariant (AC-L3-1).
 * The prototype's single most-repeated failure was defaulting the base to `master`; this is the
 * cure: a read-only, injectable detector with an explicit, named chain and NO hard-coded `master`
 * default anywhere.
 *
 *   1. `origin/HEAD` — the remote's default branch. If `refs/remotes/origin/HEAD` is a symbolic ref
 *      (e.g. → `refs/remotes/origin/main`), USE it (returns e.g. `origin/main`). This is why an
 *      `origin/HEAD → main` repo resolves `main`, never `master`, even if a local `master` exists.
 *   2. else local `main` exists → `main`.
 *   3. else local `master` exists → `master` (only reached when there is no remote default AND no
 *      `main` — never a blanket default).
 *   4. else (remote-less / fresh repo) → local `HEAD`.
 *
 * `gitReader` is injectable (default {@link defaultGitReader}) so the chain is tested headless.
 */
export function detectBaseRef(cwd: string, gitReader: GitReader = defaultGitReader): string {
  // 1) origin/HEAD — the remote's default branch (authoritative when a remote exists).
  const originHead = gitReader(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (originHead != null && originHead.startsWith(REMOTE_REF_PREFIX)) {
    return originHead.slice(REMOTE_REF_PREFIX.length); // 'refs/remotes/origin/main' → 'origin/main'
  }

  // 2) local main.
  if (gitReader(cwd, ['rev-parse', '--verify', '--quiet', 'refs/heads/main']) != null) {
    return 'main';
  }

  // 3) local master — reached ONLY when there is no remote default and no local main.
  if (gitReader(cwd, ['rev-parse', '--verify', '--quiet', 'refs/heads/master']) != null) {
    return 'master';
  }

  // 4) remote-less / fresh repo — branch from local HEAD.
  return 'HEAD';
}

/**
 * Auto-detect the local integration target used by publish tools (`co_merge`, `co_push`,
 * `co_pr_merge`). Unlike {@link detectBaseRef}, this must return a LOCAL branch/base name:
 * `origin/main` is a good branch-off point for a new sandbox, but it is not a safe integration target
 * for checkout, push, or a GitHub PR base.
 */
export function detectIntegrationTarget(
  cwd: string,
  gitReader: GitReader = defaultGitReader,
): string {
  const originHead = gitReader(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (originHead != null) {
    const branch = remoteDefaultToLocalBranch(originHead);
    if (branch != null) {
      if (gitReader(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]) != null) {
        return branch;
      }
      throw new Error(
        `co publish: origin/HEAD points at '${branch}', but no local '${branch}' branch exists. ` +
          'Pass `into` explicitly.',
      );
    }
  }

  if (gitReader(cwd, ['rev-parse', '--verify', '--quiet', 'refs/heads/main']) != null) {
    return 'main';
  }

  if (gitReader(cwd, ['rev-parse', '--verify', '--quiet', 'refs/heads/master']) != null) {
    return 'master';
  }

  return detectCurrentBranchTarget(cwd, gitReader);
}

/**
 * Detect the caller's current LOCAL branch for integration operations that land/push the branch the
 * caller is standing on. Detached HEAD is refused loud; returning literal `HEAD` would let publish
 * tools create detached merges or push pseudo-refs.
 */
export function detectCurrentBranchTarget(
  cwd: string,
  gitReader: GitReader = defaultGitReader,
): string {
  const branch = gitReader(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch != null && branch.trim().length > 0) return branch.trim();
  throw new Error(
    `co publish: cannot default the integration target in '${cwd}' because HEAD is detached. ` +
      'Pass `into` explicitly.',
  );
}

/**
 * Resolve `ref` to a full commit sha via read-only git. Fail loud (Principle 9) if it cannot be
 * resolved — a base ref that names no commit is a programming/environment error, not something to
 * paper over with a fabricated sha. This is the call that surfaces a genuinely broken git / non-repo
 * that {@link detectBaseRef} would otherwise have silently fallen through to `HEAD`.
 */
export function resolveRefSha(
  cwd: string,
  ref: string,
  gitReader: GitReader = defaultGitReader,
): string {
  const sha = gitReader(cwd, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (sha == null || sha.length === 0) {
    throw new Error(
      `co worktrees: cannot resolve base ref '${ref}' to a commit in '${cwd}' ` +
        '(no such ref, or git is unavailable / not a repository).',
    );
  }
  return sha;
}
