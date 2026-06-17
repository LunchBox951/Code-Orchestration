import { describe, expect, it } from 'vitest';
import type { BranchInfo } from '@co/core';
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

describe('resolveSourceState (P-ON4 Source read surface)', () => {
  it('returns the reader branches verbatim and passes the open repo path through', () => {
    const cwdCalls: string[] = [];
    const state = resolveSourceState({
      currentProjectPath: () => '/repo/co',
      listBranches: (repoCwd) => {
        cwdCalls.push(repoCwd);
        return FAKE_BRANCHES;
      },
    });
    expect(state).toEqual({ kind: 'branches', branches: FAKE_BRANCHES });
    // Assert the VALUE handed to the reader, not merely that it was called (review craft).
    expect(cwdCalls).toEqual(['/repo/co']);
  });

  it('returns no-project when no project is open and never calls the reader', () => {
    let readerCalled = false;
    const state = resolveSourceState({
      currentProjectPath: () => null,
      listBranches: () => {
        readerCalled = true;
        return [];
      },
    });
    expect(state).toEqual({ kind: 'no-project' });
    expect(readerCalled).toBe(false);
  });

  it('surfaces a thrown reader error as a visible error state (Principle 9)', () => {
    const state = resolveSourceState({
      currentProjectPath: () => '/not-a-repo',
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
      currentProjectPath: () => '/empty-repo',
      listBranches: () => [],
    });
    expect(state).toEqual({ kind: 'branches', branches: [] });
  });
});
