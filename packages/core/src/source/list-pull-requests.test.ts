import { describe, it, expect } from 'vitest';
import { listPullRequests } from './list-pull-requests.js';
import type { PullRequestInfo } from './list-pull-requests.js';

const SEP = '\x01';

function cannedLine(
  refname: string,
  sha: string,
  subject: string,
  committedAt: string,
  authorname: string,
): string {
  return [refname, sha, subject, committedAt, authorname].join(SEP);
}

function cannedReader(output: string | null): () => string | null {
  return () => output;
}

describe('listPullRequests — local git PR refs', () => {
  it('parses local GitHub-style pull refs without network or gh', () => {
    const raw = [
      cannedLine('refs/pull/41/head', 'abc1234', 'Stage 15', '2026-06-17T12:00:00+00:00', 'A'),
      cannedLine(
        'refs/remotes/origin/pull/42/head',
        'def5678',
        'Follow-up',
        '2026-06-18T12:00:00+00:00',
        'B',
      ),
    ].join('\n');

    const result: readonly PullRequestInfo[] = listPullRequests('/fake', {
      readGit: cannedReader(raw),
    });

    expect(result).toEqual([
      {
        number: 42,
        ref: 'refs/remotes/origin/pull/42/head',
        source: 'origin',
        lastCommit: {
          sha: 'def5678',
          subject: 'Follow-up',
          committedAt: '2026-06-18T12:00:00+00:00',
          author: 'B',
        },
      },
      {
        number: 41,
        ref: 'refs/pull/41/head',
        source: 'local',
        lastCommit: {
          sha: 'abc1234',
          subject: 'Stage 15',
          committedAt: '2026-06-17T12:00:00+00:00',
          author: 'A',
        },
      },
    ]);
  });

  it('returns [] when no local PR refs have been fetched', () => {
    expect(listPullRequests('/fake', { readGit: cannedReader('') })).toEqual([]);
  });

  it('throws a clear error when git fails', () => {
    expect(() => listPullRequests('/not-a-repo', { readGit: cannedReader(null) })).toThrow(
      /co listPullRequests.*not a repository or git is unavailable/i,
    );
  });
});
