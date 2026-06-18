import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listBranches } from './list-branches.js';
import type { BranchInfo } from './list-branches.js';

// AC-S15-7 — listBranches: local-only, offline-safe git branch data surface for the desktop
// Source view. Fake-reader tests prove parsing + sort + contract; an integration test proves
// the real --format string round-trips through a pinned-date real git repo.

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────

const SEP = '\x01';

/** Build a canned for-each-ref line the same way git would emit it. */
function cannedLine(
  isCurrent: boolean,
  name: string,
  upstream: string,
  sha: string,
  subject: string,
  committedAt: string,
  authorname: string,
): string {
  return [isCurrent ? '*' : ' ', name, upstream, sha, subject, committedAt, authorname].join(SEP);
}

function cannedReader(output: string | null): () => string | null {
  return () => output;
}

// ── (i) fake-reader contract tests ───────────────────────────────────────────────────────────────

const DATE_NEWEST = '2024-03-10T12:00:00+00:00';
const DATE_MIDDLE = '2024-03-09T11:00:00+00:00';
const DATE_OLDEST = '2024-03-01T08:00:00+00:00';

const CANNED_THREE_BRANCHES = [
  // main is HEAD, with upstream
  cannedLine(true, 'main', 'origin/main', 'abc1234', 'Fix the widget', DATE_NEWEST, 'Alice'),
  // feature — no upstream, newer than old-branch
  cannedLine(false, 'feature', '', 'def5678', 'Add feature', DATE_MIDDLE, 'Bob'),
  // old-branch — has upstream, oldest commit
  cannedLine(false, 'old-branch', 'origin/old', 'ghi9012', 'Old work', DATE_OLDEST, 'Carol'),
].join('\n');

describe('listBranches — canned reader (>=3 branches)', () => {
  it('marks only the HEAD branch as isCurrent', () => {
    const result: readonly BranchInfo[] = listBranches('/fake', {
      readGit: cannedReader(CANNED_THREE_BRANCHES),
    });
    const current = result.filter((b) => b.isCurrent);
    const notCurrent = result.filter((b) => !b.isCurrent);
    expect(current).toHaveLength(1);
    expect(current[0]!.name).toBe('main');
    expect(notCurrent.map((b) => b.name)).toEqual(
      expect.arrayContaining(['feature', 'old-branch']),
    );
  });

  it('upstream present when given, absent when not given', () => {
    const result = listBranches('/fake', { readGit: cannedReader(CANNED_THREE_BRANCHES) });
    const main = result.find((b) => b.name === 'main')!;
    const feature = result.find((b) => b.name === 'feature')!;
    const oldBranch = result.find((b) => b.name === 'old-branch')!;

    expect(main.upstream).toBe('origin/main');
    expect(feature.upstream).toBeUndefined();
    expect(oldBranch.upstream).toBe('origin/old');
  });

  it('lastCommit fields parsed correctly', () => {
    const result = listBranches('/fake', { readGit: cannedReader(CANNED_THREE_BRANCHES) });
    const main = result.find((b) => b.name === 'main')!;
    expect(main.lastCommit.sha).toBe('abc1234');
    expect(main.lastCommit.subject).toBe('Fix the widget');
    expect(main.lastCommit.committedAt).toBe(DATE_NEWEST);
    expect(main.lastCommit.author).toBe('Alice');
  });

  it('stable sort: current first, then committedAt desc, then name asc', () => {
    const result = listBranches('/fake', { readGit: cannedReader(CANNED_THREE_BRANCHES) });
    expect(result.map((b) => b.name)).toEqual(['main', 'feature', 'old-branch']);
  });

  it('sort: when dates equal, falls back to name ascending', () => {
    const sameDate = '2024-06-01T00:00:00+00:00';
    const raw = [
      cannedLine(false, 'zebra', '', 'aaa', 'msg', sameDate, 'A'),
      cannedLine(false, 'alpha', '', 'bbb', 'msg', sameDate, 'B'),
      cannedLine(true, 'current', 'origin/current', 'ccc', 'msg', sameDate, 'C'),
    ].join('\n');
    const result = listBranches('/fake', { readGit: cannedReader(raw) });
    expect(result.map((b) => b.name)).toEqual(['current', 'alpha', 'zebra']);
  });
});

// ── (ii) zero branches ────────────────────────────────────────────────────────────────────────────

describe('listBranches — zero branches', () => {
  it('returns [] when the repo has no branches (empty output)', () => {
    expect(listBranches('/fake', { readGit: cannedReader('') })).toEqual([]);
  });

  it('returns [] when the reader returns whitespace-only output', () => {
    expect(listBranches('/fake', { readGit: cannedReader('\n\n') })).toEqual([]);
  });
});

// ── (iii) fail-loud on non-repo / git unavailable ────────────────────────────────────────────────

describe('listBranches — fail-loud (Principle 9)', () => {
  it('throws a clear error when readGit returns null (not a repo or git absent)', () => {
    expect(() => listBranches('/not-a-repo', { readGit: cannedReader(null) })).toThrow(
      /co listBranches.*not a repository or git is unavailable/i,
    );
  });

  it('error message includes the cwd for diagnostics', () => {
    expect(() => listBranches('/some/path', { readGit: cannedReader(null) })).toThrow('/some/path');
  });

  it('throws instead of silently dropping a malformed for-each-ref row', () => {
    const raw = cannedLine(false, 'feature', '', 'abc1234', `bad${SEP}subject`, DATE_NEWEST, 'A');
    expect(() => listBranches('/fake', { readGit: cannedReader(raw) })).toThrow(
      /co listBranches: malformed git for-each-ref row/i,
    );
  });
});

// ── (iv) integration — real git repo with pinned dates ────────────────────────────────────────────

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

describe('listBranches — real git integration (pinned dates)', () => {
  it('parses the real for-each-ref --format string end-to-end', () => {
    const dir = mkdtempSync(join(tmpdir(), 'co-list-branches-'));
    tmpDirs.push(dir);

    execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });

    const date1 = '2024-01-10T10:00:00+00:00';
    writeFileSync(join(dir, 'a.txt'), 'alpha\n');
    git(dir, { GIT_AUTHOR_DATE: date1, GIT_COMMITTER_DATE: date1 }, 'add', '.');
    git(dir, { GIT_AUTHOR_DATE: date1, GIT_COMMITTER_DATE: date1 }, 'commit', '-m', 'first commit');

    git(dir, {}, 'checkout', '-q', '-b', 'feature');
    const date2 = '2024-01-15T12:00:00+00:00';
    writeFileSync(join(dir, 'b.txt'), 'beta\n');
    git(dir, { GIT_AUTHOR_DATE: date2, GIT_COMMITTER_DATE: date2 }, 'add', '.');
    git(
      dir,
      { GIT_AUTHOR_DATE: date2, GIT_COMMITTER_DATE: date2 },
      'commit',
      '-m',
      'second commit',
    );

    // HEAD is on feature
    const result = listBranches(dir);

    expect(result.length).toBe(2);

    // feature is current (HEAD), has the newer date → should be first
    expect(result[0]!.name).toBe('feature');
    expect(result[0]!.isCurrent).toBe(true);
    expect(result[0]!.lastCommit.subject).toBe('second commit');
    expect(result[0]!.lastCommit.committedAt).toMatch(/^2024-01-15/u);
    expect(result[0]!.lastCommit.sha).toMatch(/^[0-9a-f]{7,}$/u);
    expect(result[0]!.lastCommit.author).toBe('Test');

    // main is not current, has the older date → second
    expect(result[1]!.name).toBe('main');
    expect(result[1]!.isCurrent).toBe(false);
    expect(result[1]!.lastCommit.subject).toBe('first commit');
    expect(result[1]!.lastCommit.committedAt).toMatch(/^2024-01-10/u);
  });

  it('fails loud when a real commit subject contains the internal field separator', () => {
    const dir = mkdtempSync(join(tmpdir(), 'co-list-branches-malformed-'));
    tmpDirs.push(dir);

    execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
    const date1 = '2024-01-10T10:00:00+00:00';
    writeFileSync(join(dir, 'a.txt'), 'alpha\n');
    git(dir, { GIT_AUTHOR_DATE: date1, GIT_COMMITTER_DATE: date1 }, 'add', '.');
    git(
      dir,
      { GIT_AUTHOR_DATE: date1, GIT_COMMITTER_DATE: date1 },
      'commit',
      '-m',
      `bad${SEP}subject`,
    );

    expect(() => listBranches(dir)).toThrow(/co listBranches: malformed git for-each-ref row/i);
  });
});
