import { describe, expect, it } from 'vitest';
import type { BranchInfo, PullRequestInfo } from '@co/core';
import { resolveSourceState } from './source-ipc.js';

/**
 * P-ON4 acceptance coverage for the Source read surface. The current-project lookup and the branch
 * reader are both injected fakes — NO real Electron, NO real git — so all three named states are
 * exercised headlessly (HOST-LIVE GUARDRAIL).
 */

const FAKE_BRANCHES: readonly BranchInfo[] = [
  {
    name: 'co/s15-onramp',
    isCurrent: true,
    lastCommit: { sha: 'abc1234', subject: 'wire source' },
  },
  {
    name: 'main',
    isCurrent: false,
    upstream: 'origin/main',
    lastCommit: {
      sha: 'def5678',
      subject: 'release',
      committedAt: '2026-06-16T00:00:00Z',
      author: 'LunchBox951',
    },
  },
];

const FAKE_PULL_REQUESTS: readonly PullRequestInfo[] = [
  {
    number: 41,
    ref: 'refs/pull/41/head',
    source: 'local',
    lastCommit: { sha: 'abc1234', subject: 'Stage 15' },
  },
];

describe('resolveSourceState (P-ON4 Source read surface)', () => {
  it('returns the reader branches verbatim and passes the open repo path through', () => {
    const cwdCalls: string[] = [];
    const state = resolveSourceState({
      currentProject: () => ({ projectId: 'pid-source', path: '/repo/co' }),
      listBranches: (repoCwd) => {
        cwdCalls.push(repoCwd);
        return FAKE_BRANCHES;
      },
      listPullRequests: () => [],
    });
    expect(state).toEqual({ kind: 'source', branches: FAKE_BRANCHES, pullRequests: [] });
    // Assert the VALUE handed to the reader, not merely that it was called (review craft).
    expect(cwdCalls).toEqual(['/repo/co']);
  });

  it('returns branches + pull requests verbatim and passes the open repo path through', () => {
    const cwdCalls: string[] = [];
    const state = resolveSourceState({
      currentProject: () => ({ projectId: 'pid-source', path: '/repo/co' }),
      listBranches: (repoCwd) => {
        cwdCalls.push(`branches:${repoCwd}`);
        return FAKE_BRANCHES;
      },
      listPullRequests: (repoCwd) => {
        cwdCalls.push(`prs:${repoCwd}`);
        return FAKE_PULL_REQUESTS;
      },
    });
    expect(state).toEqual({
      kind: 'source',
      branches: FAKE_BRANCHES,
      pullRequests: FAKE_PULL_REQUESTS,
    });
    expect(cwdCalls).toEqual(['branches:/repo/co', 'prs:/repo/co']);
  });

  it('returns no-project when no project is open and never calls the readers', () => {
    let readerCalled = false;
    const state = resolveSourceState({
      currentProject: () => null,
      listBranches: () => {
        readerCalled = true;
        return [];
      },
      listPullRequests: () => {
        readerCalled = true;
        return [];
      },
    });
    expect(state).toEqual({ kind: 'no-project' });
    expect(readerCalled).toBe(false);
  });

  it('returns path-missing when a project is open but its repo path is unavailable', () => {
    let readerCalled = false;
    const state = resolveSourceState({
      currentProject: () => ({ projectId: 'pid-missing-path', path: null }),
      listBranches: () => {
        readerCalled = true;
        return [];
      },
    });
    expect(state).toEqual({
      kind: 'path-missing',
      projectId: 'pid-missing-path',
      message: 'Project pid-missing-path is open, but its repository path is unavailable.',
    });
    expect(readerCalled).toBe(false);
  });

  it('surfaces a thrown reader error as a visible error state (Principle 9)', () => {
    const state = resolveSourceState({
      currentProject: () => ({ projectId: 'pid-not-repo', path: '/not-a-repo' }),
      listBranches: () => {
        throw new Error('co listBranches: not a repository or git is unavailable.');
      },
    });
    expect(state).toEqual({
      kind: 'error',
      message: 'co listBranches: not a repository or git is unavailable.',
    });
  });

  it('returns an empty branch list (not an error) for a repo with zero branches', () => {
    const state = resolveSourceState({
      currentProject: () => ({ projectId: 'pid-empty', path: '/empty-repo' }),
      listBranches: () => [],
      listPullRequests: () => [],
    });
    expect(state).toEqual({ kind: 'source', branches: [], pullRequests: [] });
  });
});
