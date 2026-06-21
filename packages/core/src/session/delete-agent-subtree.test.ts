/**
 * Unit tests for deleteAgentSubtree — the leaf-first cascade teardown primitive.
 *
 * All tests drive through injected in-memory fakes (no real git, no real stores):
 *   - `roster`, `worktrees`, `sessions`, `archive` are hand-rolled objects implementing only the
 *     methods called by the function under test.
 *   - `gitExec` and `gitReader` are spy functions that record calls and return controlled outputs.
 */
import { describe, it, expect } from 'vitest';
import type { AgentRecord } from '../roles/events.js';
import type { WorktreeRecord } from '../worktrees/events.js';
import type { RemoveWorktreeDeps } from '../worktrees/worktree-store.js';
import type { ArchiveRecord } from '../archive/events.js';
import type { SessionRecord } from './events.js';
import type { RosterStore } from '../roles/roster-store.js';
import type { WorktreeStore } from '../worktrees/worktree-store.js';
import type { SessionStore } from './session-store.js';
import type { ArchiveStore } from '../archive/archive-store.js';
import type { GitExec } from '../worktrees/sling.js';
import type { GitReader } from '../worktrees/detect-base.js';
import { deleteAgentSubtree, ARCHIVE_TTL_MS } from './delete-agent-subtree.js';

// ── in-memory fake stores ─────────────────────────────────────────────────────────────────────────

function makeFakeRoster(agents: AgentRecord[]): RosterStore & { removed: string[] } {
  const roster = [...agents];
  const removed: string[] = [];
  return {
    removed,
    recordAgent: () => {
      throw new Error('not implemented');
    },
    removeAgent(agentId: string): AgentRecord {
      const idx = roster.findIndex((a) => a.agentId === agentId);
      if (idx === -1) throw new Error(`removeAgent: ${agentId} not found`);
      const [rec] = roster.splice(idx, 1);
      removed.push(agentId);
      return rec!;
    },
    getAgent(agentId: string): AgentRecord | undefined {
      return roster.find((a) => a.agentId === agentId);
    },
    listAgents(): readonly AgentRecord[] {
      return [...roster];
    },
    close() {},
  };
}

function makeFakeWorktrees(
  worktrees: WorktreeRecord[],
): WorktreeStore & { removedBranches: string[] } {
  const wts = [...worktrees];
  const removedSet = new Set<string>();
  const removedBranches: string[] = [];
  return {
    removedBranches,
    recordWorktree: () => {
      throw new Error('not implemented');
    },
    getWorktree: () => undefined,
    listWorktrees(): readonly WorktreeRecord[] {
      return wts.map((w) => ({ ...w, removed: removedSet.has(w.branch) }));
    },
    recordBaseline: () => {
      throw new Error('not implemented');
    },
    recordWorktreeAndBaseline: () => {
      throw new Error('not implemented');
    },
    getBaseline: () => undefined,
    recordFinish: () => {
      throw new Error('not implemented');
    },
    recordFinishAndWorkerDone: () => {
      throw new Error('not implemented');
    },
    getFinish: () => undefined,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    removeWorktree(branch: string, _deps: RemoveWorktreeDeps): WorktreeRecord {
      const wt = wts.find((w) => w.branch === branch);
      if (!wt) throw new Error(`removeWorktree: branch '${branch}' not found`);
      removedSet.add(branch);
      removedBranches.push(branch);
      return { ...wt, removed: true };
    },
    detectOrphans: () => [],
    close() {},
  };
}

function makeFakeWorktreesThrowingOn(
  worktrees: WorktreeRecord[],
  throwingBranch: string,
): WorktreeStore & { removedBranches: string[] } {
  const base = makeFakeWorktrees(worktrees);
  return {
    ...base,
    removeWorktree(branch: string, deps: RemoveWorktreeDeps): WorktreeRecord {
      if (branch === throwingBranch) throw new Error(`removeWorktree failed for ${branch}`);
      return base.removeWorktree(branch, deps);
    },
  };
}

function makeFakeSessions(
  sessions: SessionRecord[],
): SessionStore & { listSessions(): readonly SessionRecord[] } {
  const active = [...sessions];
  return {
    recordSession: () => {
      throw new Error('not implemented');
    },
    endSession(agentId: string, pane: string): SessionRecord {
      const idx = active.findIndex((s) => s.agentId === agentId);
      if (idx === -1) throw new Error(`endSession: ${agentId} not found`);
      const [rec] = active.splice(idx, 1);
      if (rec!.pane !== pane)
        throw new Error(`endSession: pane mismatch for ${agentId}: ${pane} vs ${rec!.pane}`);
      return rec!;
    },
    getSession(agentId: string): SessionRecord | undefined {
      return active.find((s) => s.agentId === agentId);
    },
    getSessionByPane: () => undefined,
    listSessions(): readonly SessionRecord[] {
      return [...active];
    },
    close() {},
  };
}

function makeFakeArchive(): ArchiveStore & { records: ArchiveRecord[] } {
  const records: ArchiveRecord[] = [];
  return {
    records,
    appendRecord(rec: Parameters<ArchiveStore['appendRecord']>[0]): ArchiveRecord {
      const r: ArchiveRecord = { ...rec };
      records.push(r);
      return r;
    },
    removeRecord: () => undefined,
    getRecord(id: string): ArchiveRecord | undefined {
      return records.find((r) => r.id === id);
    },
    listRecords(): readonly ArchiveRecord[] {
      return [...records];
    },
    listExpired: () => [],
    close() {},
  };
}

// ── test data helpers ─────────────────────────────────────────────────────────────────────────────

function worktree(
  branch: string,
  agentId: string,
  baseRef = 'main',
  path?: string,
): WorktreeRecord {
  return {
    branch,
    baseRef,
    baseSha: 'a'.repeat(40),
    path: path ?? `/data/worktrees/${branch}`,
    parent: 'coord',
    agent: agentId,
    createdTs: Date.now(),
    removed: false,
  };
}

function session(agentId: string, pane: string): SessionRecord {
  return {
    agentId,
    pane,
    cwd: '/sandbox',
    provider: 'claude',
    resume: { provider: 'claude', sessionId: 'sid-1' },
    createdTs: Date.now(),
  };
}

// ── spy helpers ───────────────────────────────────────────────────────────────────────────────────

/** Records every git command invocation as [cwd, ...args]. */
function makeGitExecSpy(): { spy: GitExec; calls: [string, ...string[]][] } {
  const calls: [string, ...string[]][] = [];
  const spy: GitExec = (cwd, args) => {
    calls.push([cwd, ...args]);
  };
  return { spy, calls };
}

/**
 * A GitReader that controls:
 *   - merge-base check: returns '' (merged) or null (unmerged) per branch
 *   - status --porcelain: returns 'M file\n' (dirty) or '' (clean) per sandboxPath
 *   - rev-parse HEAD: returns a fake sha
 */
function makeGitReader(opts: {
  mergedBranches?: Set<string>;
  dirtyPaths?: Set<string>;
}): GitReader {
  const { mergedBranches = new Set(), dirtyPaths = new Set() } = opts;
  return (cwd: string, args: readonly string[]): string | null => {
    if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
      const branch = args[2]!;
      // return '' means merged (exit 0), null means not merged (exit 1)
      return mergedBranches.has(branch) ? '' : null;
    }
    if (args[0] === 'status' && args[1] === '--porcelain') {
      return dirtyPaths.has(cwd) ? 'M file.ts\n' : '';
    }
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return 'f'.repeat(40) + '\n';
    }
    return null;
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────────────────────────

describe('deleteAgentSubtree', () => {
  it('removes the subtree leaf-first including root, verifying removal order', () => {
    // coord-x → lead → impl (coord-x is root)
    const roster = makeFakeRoster([
      { agentId: 'coord-x', role: 'coordinator', parent: '@operator', registeredTs: 1 },
      { agentId: 'lead', role: 'lead', parent: 'coord-x', registeredTs: 2 },
      { agentId: 'impl', role: 'implementer', parent: 'lead', registeredTs: 3 },
    ]);
    const worktrees = makeFakeWorktrees([]);
    const sessions = makeFakeSessions([]);
    const archive = makeFakeArchive();
    const { spy: gitExec } = makeGitExecSpy();
    const gitReader = makeGitReader({});

    const result = deleteAgentSubtree('proj', 'coord-x', {
      openRoster: () => roster,
      openWorktrees: () => worktrees,
      openSessions: () => sessions,
      openArchive: () => archive,
      repoCwd: '/repo',
      nowMs: 10_000,
      gitExec,
      gitReader,
    });

    expect(result.removed).toEqual(['impl', 'lead', 'coord-x']);
    expect(roster.removed).toEqual(['impl', 'lead', 'coord-x']);
    expect(roster.listAgents()).toHaveLength(0);
  });

  it('deletes merged branches with branch -d (not -D)', () => {
    const roster = makeFakeRoster([
      { agentId: 'coord-x', role: 'coordinator', parent: '@operator', registeredTs: 1 },
      { agentId: 'lead', role: 'lead', parent: 'coord-x', registeredTs: 2 },
    ]);
    const wt = worktree('co/lead', 'lead');
    const worktreeStore = makeFakeWorktrees([wt]);
    const sessions = makeFakeSessions([]);
    const archive = makeFakeArchive();
    const { spy: gitExec, calls } = makeGitExecSpy();
    const gitReader = makeGitReader({ mergedBranches: new Set(['co/lead']) });

    const result = deleteAgentSubtree('proj', 'coord-x', {
      openRoster: () => roster,
      openWorktrees: () => worktreeStore,
      openSessions: () => sessions,
      openArchive: () => archive,
      repoCwd: '/repo',
      nowMs: 10_000,
      gitExec,
      gitReader,
    });

    expect(result.deletedBranches).toContain('co/lead');
    expect(result.archivedBranches).toHaveLength(0);
    // should use branch -d (not -D) for merged branch
    expect(calls.some((c) => c[1] === 'branch' && c[2] === '-d' && c[3] === 'co/lead')).toBe(true);
    expect(calls.some((c) => c[1] === 'branch' && c[2] === '-D')).toBe(false);
    // archive store should be empty
    expect(archive.records).toHaveLength(0);
  });

  it('archives unmerged branches with branch -D and correct expiresAt', () => {
    const roster = makeFakeRoster([
      { agentId: 'coord-x', role: 'coordinator', parent: '@operator', registeredTs: 1 },
      { agentId: 'lead', role: 'lead', parent: 'coord-x', registeredTs: 2 },
      { agentId: 'impl', role: 'implementer', parent: 'lead', registeredTs: 3, name: 'the impl' },
    ]);
    const wt = worktree('co/impl', 'impl');
    const worktreeStore = makeFakeWorktrees([wt]);
    const sessions = makeFakeSessions([]);
    const archive = makeFakeArchive();
    const { spy: gitExec, calls } = makeGitExecSpy();
    // co/impl is unmerged (not in mergedBranches), and the sandbox path is NOT dirty
    const gitReader = makeGitReader({ mergedBranches: new Set(), dirtyPaths: new Set() });
    const NOW = 10_000;

    const result = deleteAgentSubtree('proj', 'coord-x', {
      openRoster: () => roster,
      openWorktrees: () => worktreeStore,
      openSessions: () => sessions,
      openArchive: () => archive,
      repoCwd: '/repo',
      nowMs: NOW,
      gitExec,
      gitReader,
    });

    expect(result.archivedBranches).toContain('co/impl');
    expect(result.deletedBranches).toHaveLength(0);
    // should use branch -D for unmerged
    expect(calls.some((c) => c[1] === 'branch' && c[2] === '-D' && c[3] === 'co/impl')).toBe(true);
    expect(calls.some((c) => c[1] === 'branch' && c[2] === '-d')).toBe(false);
    // archive should have an entry for impl's branch
    expect(archive.records).toHaveLength(1);
    expect(archive.records[0]!.id).toBe('co/impl');
    expect(archive.records[0]!.expiresAt).toBe(NOW + ARCHIVE_TTL_MS);
    expect(archive.records[0]!.deletedAt).toBe(NOW);
    expect(archive.records[0]!.branch).toBe('co/impl');
    expect(archive.records[0]!.name).toBe('the impl');
  });

  it('snapshots dirty unmerged worktrees before archiving', () => {
    const roster = makeFakeRoster([
      { agentId: 'coord-x', role: 'coordinator', parent: '@operator', registeredTs: 1 },
      { agentId: 'lead', role: 'lead', parent: 'coord-x', registeredTs: 2 },
      { agentId: 'impl', role: 'implementer', parent: 'lead', registeredTs: 3, name: 'impl' },
    ]);
    const sandboxPath = '/data/worktrees/co/impl';
    const wt = worktree('co/impl', 'impl', 'main', sandboxPath);
    const worktreeStore = makeFakeWorktrees([wt]);
    const sessions = makeFakeSessions([]);
    const archive = makeFakeArchive();
    const { spy: gitExec, calls } = makeGitExecSpy();
    // dirty sandbox path + unmerged
    const gitReader = makeGitReader({
      mergedBranches: new Set(),
      dirtyPaths: new Set([sandboxPath]),
    });

    deleteAgentSubtree('proj', 'coord-x', {
      openRoster: () => roster,
      openWorktrees: () => worktreeStore,
      openSessions: () => sessions,
      openArchive: () => archive,
      repoCwd: '/repo',
      nowMs: 10_000,
      gitExec,
      gitReader,
    });

    // snapshot commit was called (add -A then commit -s)
    expect(calls.some((c) => c[0] === sandboxPath && c[1] === 'add' && c[2] === '-A')).toBe(true);
    expect(calls.some((c) => c[0] === sandboxPath && c[1] === 'commit')).toBe(true);
    // removeWorktree was called (tracked via fake store) + branch -D via gitExec
    expect(worktreeStore.removedBranches).toContain('co/impl');
    expect(calls.some((c) => c[1] === 'branch' && c[2] === '-D' && c[3] === 'co/impl')).toBe(true);
    // archive still recorded
    expect(archive.records).toHaveLength(1);
  });

  it('ends active sessions during teardown', () => {
    const roster = makeFakeRoster([
      { agentId: 'coord-x', role: 'coordinator', parent: '@operator', registeredTs: 1 },
      { agentId: 'impl', role: 'implementer', parent: 'coord-x', registeredTs: 2 },
    ]);
    const worktreeStore = makeFakeWorktrees([]);
    const sessStore = makeFakeSessions([
      session('coord-x', 'pane-coord'),
      session('impl', 'pane-impl'),
    ]);
    const archive = makeFakeArchive();
    const { spy: gitExec } = makeGitExecSpy();
    const gitReader = makeGitReader({});

    deleteAgentSubtree('proj', 'coord-x', {
      openRoster: () => roster,
      openWorktrees: () => worktreeStore,
      openSessions: () => sessStore,
      openArchive: () => archive,
      repoCwd: '/repo',
      nowMs: 10_000,
      gitExec,
      gitReader,
    });

    // all sessions ended
    expect(sessStore.listSessions()).toHaveLength(0);
  });

  it('skips session end if session already ended (no active session for that agent)', () => {
    const roster = makeFakeRoster([
      { agentId: 'coord-x', role: 'coordinator', parent: '@operator', registeredTs: 1 },
      { agentId: 'impl', role: 'implementer', parent: 'coord-x', registeredTs: 2 },
    ]);
    const worktreeStore = makeFakeWorktrees([]);
    // impl has no session (already ended or never started)
    const sessStore = makeFakeSessions([session('coord-x', 'pane-coord')]);
    const archive = makeFakeArchive();
    const { spy: gitExec } = makeGitExecSpy();
    const gitReader = makeGitReader({});

    // Should not throw when session for 'impl' is absent
    expect(() =>
      deleteAgentSubtree('proj', 'coord-x', {
        openRoster: () => roster,
        openWorktrees: () => worktreeStore,
        openSessions: () => sessStore,
        openArchive: () => archive,
        repoCwd: '/repo',
        nowMs: 10_000,
        gitExec,
        gitReader,
      }),
    ).not.toThrow();

    expect(sessStore.listSessions()).toHaveLength(0);
  });

  it('throws AggregateError on partial failure and still processes the rest', () => {
    // coord-x with two children: lead (removeWorktree throws) and impl
    function makeAgents() {
      return makeFakeRoster([
        { agentId: 'coord-x', role: 'coordinator', parent: '@operator', registeredTs: 1 },
        { agentId: 'lead', role: 'lead', parent: 'coord-x', registeredTs: 2 },
        { agentId: 'impl', role: 'implementer', parent: 'coord-x', registeredTs: 3 },
      ]);
    }
    function makeWts() {
      return makeFakeWorktreesThrowingOn(
        [worktree('co/lead', 'lead'), worktree('co/impl', 'impl')],
        'co/lead',
      );
    }

    const { spy: gitExec } = makeGitExecSpy();
    // both branches merged
    const gitReader = makeGitReader({ mergedBranches: new Set(['co/lead', 'co/impl']) });

    let caughtError: unknown;
    const roster = makeAgents();
    try {
      deleteAgentSubtree('proj', 'coord-x', {
        openRoster: () => roster,
        openWorktrees: () => makeWts(),
        openSessions: () => makeFakeSessions([]),
        openArchive: () => makeFakeArchive(),
        repoCwd: '/repo',
        nowMs: 10_000,
        gitExec,
        gitReader,
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(AggregateError);
    const ae = caughtError as AggregateError;
    expect(ae.message).toBe('deleteAgentSubtree: partial teardown failure');
    // exactly 1 error (co/lead's removeWorktree threw)
    expect(ae.errors).toHaveLength(1);
    expect((ae.errors[0] as Error).message).toContain('co/lead');

    // Despite the partial failure, impl and coord-x were still processed
    // roster.removed should contain lead, impl, and coord-x even though lead's worktree threw
    expect(roster.removed).toContain('impl');
    expect(roster.removed).toContain('coord-x');
    // lead was also removed from roster (the roster.removeAgent part still ran after worktree failure)
    expect(roster.removed).toContain('lead');
  });

  it('roster is empty after full teardown (no worktrees, no sessions)', () => {
    const roster = makeFakeRoster([
      { agentId: 'coord-x', role: 'coordinator', parent: '@operator', registeredTs: 1 },
      { agentId: 'lead', role: 'lead', parent: 'coord-x', registeredTs: 2 },
      { agentId: 'impl', role: 'implementer', parent: 'lead', registeredTs: 3 },
    ]);
    const worktreeStore = makeFakeWorktrees([]);
    const sessions = makeFakeSessions([]);
    const archive = makeFakeArchive();
    const { spy: gitExec } = makeGitExecSpy();
    const gitReader = makeGitReader({});

    deleteAgentSubtree('proj', 'coord-x', {
      openRoster: () => roster,
      openWorktrees: () => worktreeStore,
      openSessions: () => sessions,
      openArchive: () => archive,
      repoCwd: '/repo',
      nowMs: 10_000,
      gitExec,
      gitReader,
    });

    expect(roster.listAgents()).toHaveLength(0);
  });

  it('archiveTtlMs override is respected in expiresAt', () => {
    const roster = makeFakeRoster([
      { agentId: 'coord-x', role: 'coordinator', parent: '@operator', registeredTs: 1 },
      { agentId: 'impl', role: 'implementer', parent: 'coord-x', registeredTs: 2, name: 'impl' },
    ]);
    const wt = worktree('co/impl', 'impl');
    const worktreeStore = makeFakeWorktrees([wt]);
    const sessions = makeFakeSessions([]);
    const archive = makeFakeArchive();
    const { spy: gitExec } = makeGitExecSpy();
    const gitReader = makeGitReader({ mergedBranches: new Set(), dirtyPaths: new Set() });
    const CUSTOM_TTL = 7 * 24 * 60 * 60 * 1000; // 7 days
    const NOW = 20_000;

    deleteAgentSubtree('proj', 'coord-x', {
      openRoster: () => roster,
      openWorktrees: () => worktreeStore,
      openSessions: () => sessions,
      openArchive: () => archive,
      repoCwd: '/repo',
      nowMs: NOW,
      archiveTtlMs: CUSTOM_TTL,
      gitExec,
      gitReader,
    });

    expect(archive.records[0]!.expiresAt).toBe(NOW + CUSTOM_TTL);
  });
});
