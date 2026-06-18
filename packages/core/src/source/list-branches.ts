import { defaultGitReader, type GitReader } from '../worktrees/detect-base.js';

export interface BranchInfo {
  readonly name: string;
  readonly isCurrent: boolean;
  readonly upstream?: string;
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
  '%(HEAD)',
  '%(refname:short)',
  '%(upstream:short)',
  '%(objectname:short)',
  '%(contents:subject)',
  '%(committerdate:iso-strict)',
  '%(authorname)',
].join(FIELD_SEP);

function parseRaw(raw: string): BranchInfo[] {
  const branches: BranchInfo[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const parts = line.split(FIELD_SEP);
    if (parts.length !== 7) {
      throw new Error(
        `co listBranches: malformed git for-each-ref row (${parts.length} fields, expected 7) — ` +
          'commit subject may contain the internal field separator.',
      );
    }
    const headMarker = parts[0]!;
    const name = parts[1]!;
    const upstream = parts[2]!;
    const sha = parts[3]!;
    const subject = parts[4]!;
    const committedAt = parts[5]!;
    const authorname = parts[6]!;
    branches.push({
      name,
      isCurrent: headMarker === '*',
      ...(upstream ? { upstream } : {}),
      lastCommit: {
        sha,
        subject,
        ...(committedAt ? { committedAt } : {}),
        ...(authorname ? { author: authorname } : {}),
      },
    });
  }
  return branches;
}

// Stable sort: current branch first, then committedAt desc, then name asc.
// ISO-8601 strings compare correctly as plain strings for chronological order.
function sortBranches(branches: BranchInfo[]): readonly BranchInfo[] {
  return [...branches].sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    const dateA = a.lastCommit.committedAt ?? '';
    const dateB = b.lastCommit.committedAt ?? '';
    if (dateA !== dateB) return dateA > dateB ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Read local branch list from a git repository — LOCAL refs/heads only (no network, no remotes,
 * offline-safe). Fail-loud (Principle 9) on a real git failure; return [] for a repo with no
 * branches. The `readGit` seam defaults to the project-wide {@link defaultGitReader} so production
 * uses the same fail-safe, pristine-repo reader used by `detectBaseRef` and related tools.
 *
 * Sort: current branch first, then committedAt descending, then name ascending.
 */
export function listBranches(
  repoCwd: string,
  deps?: { readGit?: GitReader },
): readonly BranchInfo[] {
  const readGit = deps?.readGit ?? defaultGitReader;
  const raw = readGit(repoCwd, ['for-each-ref', `--format=${FOR_EACH_REF_FORMAT}`, 'refs/heads']);
  if (raw === null) {
    throw new Error(
      `co listBranches: git failed in '${repoCwd}' — not a repository or git is unavailable.`,
    );
  }
  if (!raw.trim()) return [];
  return sortBranches(parseRaw(raw));
}
