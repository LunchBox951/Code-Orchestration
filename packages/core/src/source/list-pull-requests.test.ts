import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, env: Record<string, string>, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=Test',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8', env: { ...process.env, ...env } },
  ).trim();
}

describe('listPullRequests — real git integration (pinned dates)', () => {
  it('parses local and remote PR refs through the real for-each-ref format', () => {
    const dir = mkdtempSync(join(tmpdir(), 'co-list-pull-requests-'));
    tmpDirs.push(dir);

    execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });

    const date1 = '2024-01-10T10:00:00+00:00';
    writeFileSync(join(dir, 'a.txt'), 'alpha\n');
    git(dir, { GIT_AUTHOR_DATE: date1, GIT_COMMITTER_DATE: date1 }, 'add', '.');
    git(dir, { GIT_AUTHOR_DATE: date1, GIT_COMMITTER_DATE: date1 }, 'commit', '-m', 'first pr');
    const localSha = git(dir, {}, 'rev-parse', 'HEAD');
    git(dir, {}, 'update-ref', 'refs/pull/41/head', localSha);

    const date2 = '2024-01-15T12:00:00+00:00';
    writeFileSync(join(dir, 'b.txt'), 'beta\n');
    git(dir, { GIT_AUTHOR_DATE: date2, GIT_COMMITTER_DATE: date2 }, 'add', '.');
    git(dir, { GIT_AUTHOR_DATE: date2, GIT_COMMITTER_DATE: date2 }, 'commit', '-m', 'second pr');
    const remoteSha = git(dir, {}, 'rev-parse', 'HEAD');
    git(dir, {}, 'update-ref', 'refs/remotes/origin/pull/42/head', remoteSha);

    const result = listPullRequests(dir);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      number: 42,
      ref: 'refs/remotes/origin/pull/42/head',
      source: 'origin',
      lastCommit: {
        subject: 'second pr',
        author: 'Test',
      },
    });
    expect(result[0]?.lastCommit.committedAt).toMatch(/^2024-01-15/u);
    expect(result[0]?.lastCommit.sha).toMatch(/^[0-9a-f]{7,}$/u);
    expect(result[1]).toMatchObject({
      number: 41,
      ref: 'refs/pull/41/head',
      source: 'local',
      lastCommit: {
        subject: 'first pr',
        author: 'Test',
      },
    });
    expect(result[1]?.lastCommit.committedAt).toMatch(/^2024-01-10/u);
  });
});
