import { defaultGitReader, type GitReader } from '../worktrees/detect-base.js';

export interface PullRequestInfo {
  readonly number: number;
  readonly ref: string;
  readonly source: string;
  readonly lastCommit: {
    readonly sha: string;
    readonly subject: string;
    readonly committedAt?: string;
    readonly author?: string;
  };
}

// Field separator: SOH (\x01). Ref names cannot contain it; malformed subject rows fail loud below.
const FIELD_SEP = '\x01';

const FOR_EACH_REF_FORMAT = [
  '%(refname)',
  '%(objectname:short)',
  '%(contents:subject)',
  '%(committerdate:iso-strict)',
  '%(authorname)',
].join(FIELD_SEP);

function parsePullRef(ref: string): { readonly number: number; readonly source: string } | null {
  const local = /^refs\/pull\/(\d+)\/head$/u.exec(ref);
  if (local != null) return { number: Number(local[1]), source: 'local' };
  const remote = /^refs\/remotes\/([^/]+)\/pull\/(\d+)\/head$/u.exec(ref);
  if (remote != null) return { number: Number(remote[2]), source: remote[1]! };
  return null;
}

function parseRaw(raw: string): PullRequestInfo[] {
  const pullRequests: PullRequestInfo[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const parts = line.split(FIELD_SEP);
    const ref = parts[0]!;
    const parsed = parsePullRef(ref);
    // `for-each-ref refs/remotes` also enumerates ordinary remote-tracking branches; skip any row
    // that is NOT a PR ref before enforcing the field-count invariant, so an unrelated branch whose
    // commit subject happens to contain the internal separator cannot abort the whole listing. The
    // refname is always the first field (refnames never contain the separator), so this is safe.
    if (parsed == null) continue;
    if (parts.length !== 5) {
      throw new Error(
        `co listPullRequests: malformed git for-each-ref row (${parts.length} fields, expected 5) — ` +
          'commit subject may contain the internal field separator.',
      );
    }
    const sha = parts[1]!;
    const subject = parts[2]!;
    const committedAt = parts[3]!;
    const authorname = parts[4]!;
    pullRequests.push({
      number: parsed.number,
      ref,
      source: parsed.source,
      lastCommit: {
        sha,
        subject,
        ...(committedAt ? { committedAt } : {}),
        ...(authorname ? { author: authorname } : {}),
      },
    });
  }
  return pullRequests;
}

function dateSortKey(value: string | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function sortPullRequests(pullRequests: PullRequestInfo[]): readonly PullRequestInfo[] {
  return [...pullRequests].sort((a, b) => {
    const dateA = dateSortKey(a.lastCommit.committedAt);
    const dateB = dateSortKey(b.lastCommit.committedAt);
    if (dateA !== dateB) return dateA > dateB ? -1 : 1;
    if (a.number !== b.number) return b.number - a.number;
    // Codepoint comparison (not localeCompare) so the tiebreaker is host/locale-independent.
    return a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0;
  });
}

/**
 * Read locally-fetched pull-request refs from a git repository — no `gh`, no network. This reports
 * refs such as `refs/pull/41/head` and `refs/remotes/origin/pull/41/head` when they exist locally,
 * otherwise returns [].
 */
export function listPullRequests(
  repoCwd: string,
  deps?: { readGit?: GitReader },
): readonly PullRequestInfo[] {
  const readGit = deps?.readGit ?? defaultGitReader;
  const raw = readGit(repoCwd, [
    'for-each-ref',
    `--format=${FOR_EACH_REF_FORMAT}`,
    'refs/pull',
    'refs/remotes',
  ]);
  if (raw === null) {
    throw new Error(
      `co listPullRequests: git failed in '${repoCwd}' — not a repository or git is unavailable.`,
    );
  }
  if (!raw.trim()) return [];
  return sortPullRequests(parseRaw(raw));
}
