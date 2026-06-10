import { defaultGitReader, resolveRefSha } from '../worktrees/detect-base.js';

function remoteBranchRef(remote: string, ref: string): string {
  const branch = ref.startsWith('refs/heads/')
    ? ref.slice('refs/heads/'.length)
    : ref.replace(/^refs\/heads\//u, '');
  const withoutRemotePrefix = branch.startsWith(`${remote}/`)
    ? branch.slice(remote.length + 1)
    : branch;
  return `${remote}/${withoutRemotePrefix}`;
}

export function tryResolveRemoteBranchSha(
  repoCwd: string,
  remote: string,
  ref: string,
): string | undefined {
  try {
    return resolveRefSha(repoCwd, remoteBranchRef(remote, ref));
  } catch {
    return undefined;
  }
}

function tryResolveLocalSha(repoCwd: string, ref: string): string | undefined {
  try {
    return resolveRefSha(repoCwd, ref);
  } catch {
    return undefined;
  }
}

function isAncestor(repoCwd: string, ancestor: string, descendant: string): boolean {
  return defaultGitReader(repoCwd, ['merge-base', '--is-ancestor', ancestor, descendant]) != null;
}

export function resolveContributorIdentityBaseSha(
  toolName: string,
  repoCwd: string,
  into: string,
  branch: string,
  forkRemote = 'origin',
): string {
  const upstreamBase = tryResolveRemoteBranchSha(repoCwd, 'upstream', into);
  if (upstreamBase != null) return upstreamBase;

  const forkBase = tryResolveRemoteBranchSha(repoCwd, forkRemote, into);
  const localBase = tryResolveLocalSha(repoCwd, into);
  if (forkBase != null && localBase != null && forkBase !== localBase) {
    if (isAncestor(repoCwd, localBase, forkBase)) {
      throw new Error(
        `${toolName}: cannot inspect commit identities against the upstream PR base — ` +
          `'${forkRemote}/${into}' is ahead of local '${into}', but no 'upstream/${into}' ref ` +
          'is available. Fetch/configure the upstream base before publishing contributor work.',
      );
    }
    if (!isAncestor(repoCwd, forkBase, localBase)) {
      throw new Error(
        `${toolName}: cannot inspect commit identities against the upstream PR base — ` +
          `'${forkRemote}/${into}' and local '${into}' have diverged, but no 'upstream/${into}' ` +
          'ref is available. Fetch/configure the upstream base before publishing contributor work.',
      );
    }
  }
  if (forkBase != null) return forkBase;

  const mergeBase = defaultGitReader(repoCwd, ['merge-base', into, branch]);
  if (mergeBase != null && mergeBase.length > 0) return mergeBase;
  throw new Error(
    `${toolName}: cannot inspect commit identities — cannot resolve PR merge-base / ` +
      `contributor PR base for '${branch}' into '${into}'.`,
  );
}
