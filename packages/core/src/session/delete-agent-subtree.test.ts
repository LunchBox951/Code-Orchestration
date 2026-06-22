/**
 * Unit tests for deleteAgentSubtree — the leaf-first cascade teardown primitive.
 *
 * All tests drive through injected in-memory fakes (no real git, no real stores):
 *   - `roster`, `worktrees`, `sessions`, `archive` are hand-rolled objects implementing only the
 *     methods called by the function under test.
 *   - `gitExec` and `gitReader` are spy functions that record calls and return controlled outputs.
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRecord } from '../roles/events.js';
import type { WorktreeRecord } from '../worktrees/events.js';
import type { RemoveWorktreeDeps } from '../worktrees/worktree-store.js';
import type { ArchiveRecord } from '../archive/events.js';
import type { SessionRecord } from './events.js';
import {
  EVENT_MAIL_RECIPIENT_CLEARED,
  EVENT_MAIL_RECIPIENT_SENDER_CLEARED,
  EVENT_MAIL_RETRACTED,
  MAIL_APPROVAL,
  MAIL_CLARIFY_REQUEST,
  MAIL_ESCALATION,
  MAIL_REVIEW_REQUEST,
  OPERATOR,
} from '../mail/events.js';
import { openProjectStore } from '../store/sqlite-store.js';
import type { RosterStore } from '../roles/roster-store.js';
import type { WorktreeStore } from '../worktrees/worktree-store.js';
import type { SessionStore } from './session-store.js';
import type { ArchiveStore } from '../archive/archive-store.js';
import { openMailStore, type MailStore } from '../mail/mail-store.js';
import { buildHumanReviewVerdict } from '../review/human-review.js';
import { openReviewStore } from '../review/review-store.js';
import type { GitExec } from '../worktrees/sling.js';
import type { GitReader } from '../worktrees/detect-base.js';
import { deleteAgentSubtree, ARCHIVE_TTL_MS } from './delete-agent-subtree.js';

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  const dir = mkdtempSync(join(tmpdir(), 'co-delete-subtree-'));
  dataDirs = [dir];
  process.env.CO_DATA_DIR = dir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
});

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
      const child = roster.find((a) => a.parent === agentId);
      if (child != null) {
        throw new Error(`removeAgent: ${agentId} still has child ${child.agentId}`);
      }
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
): WorktreeStore & { removedBranches: string[]; removeForce: string[] } {
  const wts = [...worktrees];
  const removedSet = new Set(wts.filter((w) => w.removed).map((w) => w.branch));
  const removedBranches: string[] = [];
  const removeForce: string[] = [];
  return {
    removedBranches,
    removeForce,
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
    removeWorktree(branch: string, deps: RemoveWorktreeDeps): WorktreeRecord {
      const wt = wts.find((w) => w.branch === branch);
      if (!wt) throw new Error(`removeWorktree: branch '${branch}' not found`);
      removedSet.add(branch);
      removedBranches.push(branch);
      if (deps.force === true) removeForce.push(branch);
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

/**
 * Wraps {@link makeFakeSessions} so the FIRST `endSession` call throws (a transient failure that
 * aborts teardown after the worktree was already removed + archived), then succeeds on retry.
 */
function makeFakeSessionsFailingFirstEnd(
  sessions: SessionRecord[],
): SessionStore & { listSessions(): readonly SessionRecord[] } {
  const base = makeFakeSessions(sessions);
  let failed = false;
  return {
    ...base,
    endSession(agentId: string, pane: string): SessionRecord {
      if (!failed) {
        failed = true;
        throw new Error(`endSession transient failure for ${agentId}`);
      }
      return base.endSession(agentId, pane);
    },
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

/**
 * Wraps {@link makeFakeArchive} so the FIRST `appendRecord` call throws (an archive write that fails
 * AFTER the worktree was force-removed), then succeeds on retry.
 */
function makeFakeArchiveFailingFirstAppend(): ArchiveStore & { records: ArchiveRecord[] } {
  const base = makeFakeArchive();
  let failed = false;
  return {
    ...base,
    appendRecord(rec: Parameters<ArchiveStore['appendRecord']>[0]): ArchiveRecord {
      if (!failed) {
        failed = true;
        throw new Error(`archive append transient failure for ${rec.id}`);
      }
      return base.appendRecord(rec);
    },
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

function cleanupMailEvents(projectId: string): Array<{
  readonly type: string;
  readonly actor?: string;
  readonly scope: string;
}> {
  const store = openProjectStore(projectId);
  try {
    return store.readAll().filter((event) => event.scope.startsWith('mail:'));
  } finally {
    store.close();
  }
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
  existingBranches?: Set<string>;
  mergedBranches?: Set<string>;
  dirtyPaths?: Set<string>;
  /** Per-worktree-path HEAD sha for the `rev-parse --verify --quiet HEAD` probe (#65 recovery).
   *  A path mapped to null models an unresolvable HEAD (nothing to recover). Default sha: 'a'*40. */
  worktreeHeads?: Map<string, string | null>;
}): GitReader {
  const {
    existingBranches,
    mergedBranches = new Set(),
    dirtyPaths = new Set(),
    worktreeHeads,
  } = opts;
  return (cwd: string, args: readonly string[]): string | null => {
    // #65: orphaned-worktree HEAD probe — resolve the live worktree's tip (or null if unresolvable).
    if (
      args[0] === 'rev-parse' &&
      args[1] === '--verify' &&
      args[2] === '--quiet' &&
      args[3] === 'HEAD'
    ) {
      if (worktreeHeads == null) return 'a'.repeat(40) + '\n';
      const head = worktreeHeads.has(cwd) ? worktreeHeads.get(cwd)! : 'a'.repeat(40);
      return head == null ? null : head + '\n';
    }
    if (
      args[0] === 'rev-parse' &&
      args[1] === '--verify' &&
      args[2] === '--quiet' &&
      args[3]?.startsWith('refs/heads/')
    ) {
      return existingBranches == null || existingBranches.has(args[3].slice('refs/heads/'.length))
        ? 'f'.repeat(40) + '\n'
        : null;
    }
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

  it('does NOT record a merged branch as deleted when its `git branch -d` throws (result-honesty)', () => {
    // Two merged siblings: co/lead's `branch -d` throws; co/impl's succeeds. The single AggregateError
    // surfaces co/lead's failure, and the surviving result (re-derived from the spy) proves co/lead is
    // NOT in deletedBranches while co/impl is — the push now lives INSIDE the successful `branch -d` try.
    const roster = makeFakeRoster([
      { agentId: 'coord-x', role: 'coordinator', parent: '@operator', registeredTs: 1 },
      { agentId: 'lead', role: 'lead', parent: 'coord-x', registeredTs: 2 },
      { agentId: 'impl', role: 'implementer', parent: 'coord-x', registeredTs: 3 },
    ]);
    const worktreeStore = makeFakeWorktrees([
      worktree('co/lead', 'lead'),
      worktree('co/impl', 'impl'),
    ]);
    const sessions = makeFakeSessions([]);
    const archive = makeFakeArchive();
    // gitExec throws specifically on `git branch -d co/lead` (the safe delete fails); co/impl succeeds.
    const branchDeleteOk: string[] = [];
    const gitExec: GitExec = (_cwd, args) => {
      if (args[0] === 'branch' && args[1] === '-d') {
        if (args[2] === 'co/lead') throw new Error('git branch -d failed for co/lead');
        branchDeleteOk.push(args[2]!);
      }
    };
    const gitReader = makeGitReader({ mergedBranches: new Set(['co/lead', 'co/impl']) });

    let caughtError: unknown;
    try {
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
    } catch (err) {
      caughtError = err;
    }

    // The AggregateError still fires (co/lead's branch -d failure is collected), and the parent
    // roster row cannot be removed while the failed child remains.
    expect(caughtError).toBeInstanceOf(AggregateError);
    const ae = caughtError as AggregateError;
    expect(ae.errors).toHaveLength(2);
    expect((ae.errors[0] as Error).message).toContain('co/lead');
    // co/lead's `branch -d` never returned, so it must NOT be reported as deleted; co/impl's did.
    expect(branchDeleteOk).toContain('co/impl');
    expect(branchDeleteOk).not.toContain('co/lead');
  });

  it('archives unmerged branches by removing the worktree (force) WITHOUT deleting the branch', () => {
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
    // The worktree was force-removed (the force flag is load-bearing for an unmerged branch)...
    expect(worktreeStore.removedBranches).toContain('co/impl');
    expect(worktreeStore.removeForce).toContain('co/impl');
    // ...but the branch ref must SURVIVE: NEITHER `git branch -D` NOR `-d` is issued for it at delete
    // time. The reaper / purgeArchive delete it after expiry (the archive record stores only metadata).
    expect(calls.some((c) => c[1] === 'branch' && c[2] === '-D' && c[3] === 'co/impl')).toBe(false);
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

    // snapshot commit was called (add -A then commit -s) — the dirty work is committed to the branch
    expect(calls.some((c) => c[0] === sandboxPath && c[1] === 'add' && c[2] === '-A')).toBe(true);
    expect(calls.some((c) => c[0] === sandboxPath && c[1] === 'commit')).toBe(true);
    // removeWorktree was force-called (tracked via fake store); the branch ref is NOT deleted so the
    // snapshot commit stays reachable until expiry.
    expect(worktreeStore.removedBranches).toContain('co/impl');
    expect(worktreeStore.removeForce).toContain('co/impl');
    expect(calls.some((c) => c[1] === 'branch' && c[2] === '-D' && c[3] === 'co/impl')).toBe(false);
    // archive still recorded
    expect(archive.records).toHaveLength(1);
  });

  it('does not force-remove or archive a dirty unmerged worktree when snapshot fails', () => {
    const roster = makeFakeRoster([
      { agentId: 'coord-x', role: 'coordinator', parent: '@operator', registeredTs: 1 },
      { agentId: 'impl', role: 'implementer', parent: 'coord-x', registeredTs: 2, name: 'impl' },
    ]);
    const sandboxPath = '/data/worktrees/co/impl';
    const worktreeStore = makeFakeWorktrees([worktree('co/impl', 'impl', 'main', sandboxPath)]);
    const sessions = makeFakeSessions([]);
    const archive = makeFakeArchive();
    const gitExec: GitExec = (cwd, args) => {
      if (cwd === sandboxPath && args[0] === 'commit') {
        throw new Error('commit failed');
      }
    };
    const gitReader = makeGitReader({
      mergedBranches: new Set(),
      dirtyPaths: new Set([sandboxPath]),
    });

    let caught: unknown;
    try {
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
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors.some((e) => String(e).includes('commit failed'))).toBe(
      true,
    );
    expect(worktreeStore.removedBranches).not.toContain('co/impl');
    expect(archive.records).toHaveLength(0);
    expect(roster.getAgent('impl')).toBeDefined();
    expect(roster.getAgent('coord-x')).toBeDefined();
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

  it('clears outstanding actionable mail for each removed agent before roster removal', () => {
    const roster = makeFakeRoster([
      { agentId: 'coord-x', role: 'coordinator', parent: '@operator', registeredTs: 1 },
      { agentId: 'impl', role: 'implementer', parent: 'coord-x', registeredTs: 2 },
    ]);
    const worktreeStore = makeFakeWorktrees([]);
    const sessions = makeFakeSessions([]);
    const archive = makeFakeArchive();
    const { spy: gitExec } = makeGitExecSpy();
    const gitReader = makeGitReader({});
    const mail = openMailStore('proj');
    let seq: number;
    try {
      seq = mail.send({
        type: MAIL_CLARIFY_REQUEST,
        to: 'impl',
        from: 'worker',
        subject: 'question',
        body: 'need input',
      }).seq;
      expect(mail.outstanding('impl')).toHaveLength(1);
    } finally {
      mail.close();
    }

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

    const check = openMailStore('proj');
    try {
      expect(check.outstanding('impl')).toEqual([]);
      expect(check.sentBy('worker').find((m) => m.seq === seq)?.retracted).toBe(true);
    } finally {
      check.close();
    }
    expect(cleanupMailEvents('proj')).toEqual([
      expect.objectContaining({ type: MAIL_CLARIFY_REQUEST, actor: 'worker', scope: 'mail:impl' }),
      expect.objectContaining({
        type: EVENT_MAIL_RECIPIENT_CLEARED,
        actor: OPERATOR,
        scope: 'mail:impl',
      }),
    ]);
    expect(cleanupMailEvents('proj').map((event) => event.type)).not.toContain(
      EVENT_MAIL_RETRACTED,
    );
    expect(roster.removed).toEqual(['impl', 'coord-x']);
  });

  it('does not reopen forwarded mail for deleted descendants during leaf-first subtree cleanup', () => {
    const roster = makeFakeRoster([
      { agentId: 'coord-x', role: 'coordinator', parent: '@operator', registeredTs: 1 },
      { agentId: 'lead', role: 'lead', parent: 'coord-x', registeredTs: 2 },
    ]);
    const worktreeStore = makeFakeWorktrees([]);
    const sessions = makeFakeSessions([]);
    const archive = makeFakeArchive();
    const { spy: gitExec } = makeGitExecSpy();
    const gitReader = makeGitReader({});
    const mail = openMailStore('proj');
    let heldSeq: number;
    let forwardedSeq: number;
    try {
      const held = mail.send({
        type: MAIL_ESCALATION,
        to: 'lead',
        from: 'worker',
        subject: 'blocked',
        body: 'need authority',
      });
      const forwarded = mail.forward(held, {
        type: MAIL_ESCALATION,
        to: 'coord-x',
        from: 'lead',
        subject: held.subject,
        body: held.body,
        correlationId: String(held.seq),
        causationId: String(held.seq),
      });
      heldSeq = held.seq;
      forwardedSeq = forwarded.seq;
      expect(mail.outstanding('lead')).toEqual([]);
      expect(mail.outstanding('coord-x').map((m) => m.seq)).toEqual([forwardedSeq]);
    } finally {
      mail.close();
    }

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

    const check = openMailStore('proj');
    try {
      expect(check.outstanding('lead')).toEqual([]);
      expect(check.outstanding('coord-x')).toEqual([]);
      expect(check.sentBy('worker').find((m) => m.seq === heldSeq)?.retracted).toBe(true);
      expect(check.sentBy('lead').find((m) => m.seq === forwardedSeq)?.retracted).toBe(true);
    } finally {
      check.close();
    }
    expect(roster.removed).toEqual(['lead', 'coord-x']);
  });

  it('clears operator-held actionable mail sent by deleted subtree agents only', () => {
    const roster = makeFakeRoster([
      { agentId: 'coord-x', role: 'coordinator', parent: '@operator', registeredTs: 1 },
      { agentId: 'impl', role: 'implementer', parent: 'coord-x', registeredTs: 2 },
    ]);
    const worktreeStore = makeFakeWorktrees([]);
    const sessions = makeFakeSessions([]);
    const archive = makeFakeArchive();
    const { spy: gitExec } = makeGitExecSpy();
    const gitReader = makeGitReader({});
    const mail = openMailStore('proj');
    let deletedSenderSeq: number;
    let unrelatedSeq: number;
    try {
      deletedSenderSeq = mail.send({
        type: MAIL_APPROVAL,
        to: OPERATOR,
        from: 'impl',
        subject: 'publish',
        body: 'approve deploy',
      }).seq;
      unrelatedSeq = mail.send({
        type: MAIL_APPROVAL,
        to: OPERATOR,
        from: 'other-agent',
        subject: 'publish other',
        body: 'approve other deploy',
      }).seq;
      expect(mail.outstanding(OPERATOR).map((m) => m.seq)).toEqual([
        deletedSenderSeq,
        unrelatedSeq,
      ]);
    } finally {
      mail.close();
    }

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

    const check = openMailStore('proj');
    try {
      expect(check.outstanding(OPERATOR).map((m) => m.seq)).toEqual([unrelatedSeq]);
      expect(check.sentBy('impl').find((m) => m.seq === deletedSenderSeq)?.retracted).toBe(true);
      expect(check.sentBy('other-agent').find((m) => m.seq === unrelatedSeq)?.retracted).toBe(
        false,
      );
    } finally {
      check.close();
    }
    const events = cleanupMailEvents('proj');
    expect(events).toEqual([
      expect.objectContaining({ type: MAIL_APPROVAL, actor: 'impl', scope: 'mail:@operator' }),
      expect.objectContaining({
        type: MAIL_APPROVAL,
        actor: 'other-agent',
        scope: 'mail:@operator',
      }),
      expect.objectContaining({
        type: EVENT_MAIL_RECIPIENT_SENDER_CLEARED,
        actor: OPERATOR,
        scope: 'mail:@operator',
      }),
    ]);
    expect(events.map((event) => event.type)).not.toContain(EVENT_MAIL_RETRACTED);
    expect(roster.removed).toEqual(['impl', 'coord-x']);
  });

  it('fails loud without clearing a pending human review request from a deleted agent', () => {
    const roster = makeFakeRoster([
      { agentId: 'coord-x', role: 'coordinator', parent: '@operator', registeredTs: 1 },
      { agentId: 'impl', role: 'implementer', parent: 'coord-x', registeredTs: 2 },
    ]);
    const worktreeStore = makeFakeWorktrees([]);
    const sessions = makeFakeSessions([]);
    const archive = makeFakeArchive();
    const { spy: gitExec } = makeGitExecSpy();
    const gitReader = makeGitReader({});
    const mail = openMailStore('proj');
    let reviewSeq: number;
    try {
      const reviewId = 'review-delete-1';
      const requested = mail.requestHumanReview(
        {
          type: MAIL_REVIEW_REQUEST,
          to: OPERATOR,
          from: 'impl',
          subject: 'Review co/impl',
          body: 'Please review this branch.',
          idempotencyKey: `review-request:${reviewId}`,
        },
        {
          reviewId,
          target: 'main',
          branch: 'co/impl',
          scope: 'worker_merge',
          reviewerKind: 'human',
          requestedBy: 'impl',
          specRefKind: 'no-locked-spec',
        },
      );
      reviewSeq = requested.mail.seq;
    } finally {
      mail.close();
    }

    let caught: unknown;
    try {
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
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect(
      (caught as AggregateError).errors.some((e) => String(e).includes('review_request')),
    ).toBe(true);
    const check = openMailStore('proj');
    try {
      expect(check.outstanding(OPERATOR).map((m) => m.seq)).toContain(reviewSeq);
      expect(check.sentBy('impl').find((m) => m.seq === reviewSeq)?.retracted).toBe(false);
    } finally {
      check.close();
    }
    expect(roster.getAgent('impl')).toBeDefined();
    expect(roster.getAgent('coord-x')).toBeDefined();
  });

  it('preflights review mail before removing worktrees, archiving branches, or ending sessions', () => {
    const roster = makeFakeRoster([
      { agentId: 'coord-x', role: 'coordinator', parent: '@operator', registeredTs: 1 },
      { agentId: 'impl', role: 'implementer', parent: 'coord-x', registeredTs: 2 },
    ]);
    const worktreeStore = makeFakeWorktrees([worktree('co/impl', 'impl')]);
    const sessions = makeFakeSessions([session('impl', 'pane-impl')]);
    const archive = makeFakeArchive();
    const { spy: gitExec, calls } = makeGitExecSpy();
    const gitReader = makeGitReader({ mergedBranches: new Set(), dirtyPaths: new Set() });
    const mail = openMailStore('proj');
    try {
      const reviewId = 'review-delete-preflight';
      mail.requestHumanReview(
        {
          type: MAIL_REVIEW_REQUEST,
          to: OPERATOR,
          from: 'impl',
          subject: 'Review co/impl',
          body: 'Please review this branch.',
          idempotencyKey: `review-request:${reviewId}`,
        },
        {
          reviewId,
          target: 'main',
          branch: 'co/impl',
          scope: 'worker_merge',
          reviewerKind: 'human',
          requestedBy: 'impl',
          specRefKind: 'no-locked-spec',
        },
      );
    } finally {
      mail.close();
    }

    let caught: unknown;
    try {
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
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect(
      (caught as AggregateError).errors.some((e) => String(e).includes('review_request')),
    ).toBe(true);
    expect(worktreeStore.removedBranches).toEqual([]);
    expect(archive.records).toEqual([]);
    expect(sessions.getSession('impl')).toBeDefined();
    expect(calls).toEqual([]);
    expect(roster.getAgent('impl')).toBeDefined();
    expect(roster.getAgent('coord-x')).toBeDefined();
  });

  it('deletes after resolved human review mail without retracting the review audit row', () => {
    const roster = makeFakeRoster([
      { agentId: 'coord-x', role: 'coordinator', parent: '@operator', registeredTs: 1 },
      { agentId: 'impl', role: 'implementer', parent: 'coord-x', registeredTs: 2 },
    ]);
    const worktreeStore = makeFakeWorktrees([worktree('co/impl', 'impl')]);
    const sessions = makeFakeSessions([session('impl', 'pane-impl')]);
    const archive = makeFakeArchive();
    const { spy: gitExec, calls } = makeGitExecSpy();
    const gitReader = makeGitReader({ mergedBranches: new Set(), dirtyPaths: new Set() });
    const mail = openMailStore('proj');
    const reviews = openReviewStore('proj');
    try {
      const reviewId = 'review-delete-resolved';
      const requested = mail.requestHumanReview(
        {
          type: MAIL_REVIEW_REQUEST,
          to: OPERATOR,
          from: 'impl',
          subject: 'Review co/impl',
          body: 'Please review this branch.',
          idempotencyKey: `review-request:${reviewId}`,
        },
        {
          reviewId,
          target: 'main',
          branch: 'co/impl',
          scope: 'worker_merge',
          reviewerKind: 'human',
          requestedBy: 'impl',
          specRefKind: 'no-locked-spec',
        },
      );
      mail.replyWithReviewVerdict(
        requested.mail,
        {
          type: 'review_response',
          subject: 're: review',
          body: 'passes',
          from: OPERATOR,
          reviewVerdict: 'PASS',
        },
        buildHumanReviewVerdict(reviews, {
          reviewId,
          target: 'main',
          branch: 'co/impl',
          verdict: 'PASS',
          body: 'passes',
        }),
      );
      expect(reviews.activeSerialized('main')).toBe('co/impl');
      expect(mail.outstanding(OPERATOR).map((m) => m.seq)).not.toContain(requested.mail.seq);
      mail.send({
        type: MAIL_CLARIFY_REQUEST,
        to: OPERATOR,
        from: 'impl',
        subject: 'non-review cleanup after review',
        body: 'this should not block delete',
      });
    } finally {
      reviews.close();
      mail.close();
    }

    let caught: unknown;
    try {
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
      expect(result.removed).toEqual(['impl', 'coord-x']);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeUndefined();
    expect(worktreeStore.removedBranches).toEqual(['co/impl']);
    expect(archive.records.map((r) => r.id)).toEqual(['co/impl']);
    expect(sessions.getSession('impl')).toBeUndefined();
    expect(calls).toEqual([]);
    expect(roster.getAgent('impl')).toBeUndefined();
    expect(roster.getAgent('coord-x')).toBeUndefined();
    const check = openMailStore('proj');
    try {
      const reviewRequest = check.sentBy('impl').find((m) => m.type === MAIL_REVIEW_REQUEST);
      const clarify = check
        .sentBy('impl')
        .find((m) => m.type === MAIL_CLARIFY_REQUEST && m.recipient === OPERATOR);
      expect(reviewRequest?.retracted).toBe(false);
      expect(reviewRequest?.resolved).toBe(true);
      expect(clarify?.retracted).toBe(true);
    } finally {
      check.close();
    }
    const checkReviews = openReviewStore('proj');
    try {
      expect(checkReviews.activeSerialized('main')).toBeUndefined();
      expect(checkReviews.getVerdict('main', 'co/impl')?.verdict).toBe('PASS');
    } finally {
      checkReviews.close();
    }
  });

  it('retracts actionable mail sent by a deleted non-root agent to a surviving recipient', () => {
    const roster = makeFakeRoster([
      { agentId: 'coord-x', role: 'coordinator', parent: '@operator', registeredTs: 1 },
      { agentId: 'lead', role: 'lead', parent: 'coord-x', registeredTs: 2 },
      { agentId: 'impl', role: 'implementer', parent: 'coord-x', registeredTs: 3 },
    ]);
    const worktreeStore = makeFakeWorktrees([]);
    const sessions = makeFakeSessions([]);
    const archive = makeFakeArchive();
    const { spy: gitExec } = makeGitExecSpy();
    const gitReader = makeGitReader({});
    const mail = openMailStore('proj');
    let seq = 0;
    try {
      const sent = mail.send({
        type: MAIL_CLARIFY_REQUEST,
        to: 'lead',
        from: 'impl',
        subject: 'follow-up',
        body: 'please check this',
      });
      seq = sent.seq;
      expect(mail.outstanding('lead').map((m) => m.seq)).toContain(seq);
    } finally {
      mail.close();
    }

    const result = deleteAgentSubtree('proj', 'impl', {
      openRoster: () => roster,
      openWorktrees: () => worktreeStore,
      openSessions: () => sessions,
      openArchive: () => archive,
      repoCwd: '/repo',
      nowMs: 10_000,
      gitExec,
      gitReader,
    });

    expect(result.removed).toEqual(['impl']);
    expect(roster.getAgent('impl')).toBeUndefined();
    expect(roster.getAgent('lead')).toBeDefined();
    const check = openMailStore('proj');
    try {
      expect(check.outstanding('lead').map((m) => m.seq)).not.toContain(seq);
      expect(check.sentBy('impl').find((m) => m.seq === seq)?.retracted).toBe(true);
    } finally {
      check.close();
    }
  });

  it('keeps the roster row when mail cleanup fails, so deletion can be retried', () => {
    const roster = makeFakeRoster([
      { agentId: 'coord-x', role: 'coordinator', parent: '@operator', registeredTs: 1 },
      { agentId: 'impl', role: 'implementer', parent: 'coord-x', registeredTs: 2 },
    ]);
    const worktreeStore = makeFakeWorktrees([]);
    const sessions = makeFakeSessions([]);
    const archive = makeFakeArchive();
    const { spy: gitExec } = makeGitExecSpy();
    const gitReader = makeGitReader({});
    const mail = {
      inbox: () => [
        {
          seq: 1,
          recipient: 'impl',
          sender: 'lead',
          type: MAIL_CLARIFY_REQUEST,
          subject: 'question',
          body: 'answer',
          ts: 1,
          kind: 'actionable',
          resolved: false,
          retracted: false,
        },
      ],
      outstanding: () => [],
      sentBy: () => [],
      clearOutstanding: () => {
        throw new Error('mail cleanup failed');
      },
      clearOutstandingFromSenderToRecipient: () => 0,
      close() {},
    } as unknown as MailStore;

    let caught: unknown;
    try {
      deleteAgentSubtree('proj', 'coord-x', {
        openRoster: () => roster,
        openWorktrees: () => worktreeStore,
        openSessions: () => sessions,
        openArchive: () => archive,
        openMail: () => mail,
        repoCwd: '/repo',
        nowMs: 10_000,
        gitExec,
        gitReader,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect(
      (caught as AggregateError).errors.some((e) => String(e).includes('mail cleanup failed')),
    ).toBe(true);
    expect(roster.getAgent('impl')).toBeDefined();
    expect(roster.getAgent('coord-x')).toBeDefined();
  });

  it('retries after a merged branch was already removed and deleted without archiving a missing branch', () => {
    const roster = makeFakeRoster([
      { agentId: 'coord-x', role: 'coordinator', parent: '@operator', registeredTs: 1 },
      { agentId: 'impl', role: 'implementer', parent: 'coord-x', registeredTs: 2 },
    ]);
    const removedWt = { ...worktree('co/impl', 'impl'), removed: true };
    const worktreeStore = makeFakeWorktrees([removedWt]);
    const sessions = makeFakeSessions([]);
    const archive = makeFakeArchive();
    const calls: [string, ...string[]][] = [];
    const gitExec: GitExec = (cwd, args) => {
      calls.push([cwd, ...args]);
      if (args[0] === 'branch' && args[1] === '-d' && args[2] === 'co/impl') {
        throw new Error("error: branch 'co/impl' not found");
      }
    };
    const gitReader = makeGitReader({
      existingBranches: new Set(['co/coord-x']),
      mergedBranches: new Set(['co/coord-x']),
    });

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

    expect(result.removed).toEqual(['impl', 'coord-x']);
    expect(result.archivedBranches).toEqual([]);
    expect(archive.records).toEqual([]);
    expect(calls.some((call) => call.join(' ').includes('branch -d co/impl'))).toBe(true);
  });

  it('releases a serialized merge slot held by an archived branch on a retry after the first pass failed post-archive (MC-CD-1)', () => {
    const roster = makeFakeRoster([
      { agentId: 'coord-x', role: 'coordinator', parent: '@operator', registeredTs: 1 },
      { agentId: 'impl', role: 'implementer', parent: 'coord-x', registeredTs: 2 },
    ]);
    const worktreeStore = makeFakeWorktrees([worktree('co/impl', 'impl')]);
    // endSession throws on the first pass (after the worktree is removed + archived), succeeds on retry.
    const sessions = makeFakeSessionsFailingFirstEnd([session('impl', 'pane-impl')]);
    const archive = makeFakeArchive();
    const { spy: gitExec } = makeGitExecSpy();
    // co/impl exists and is UNMERGED, so the unmerged path archives it (branch kept).
    const gitReader = makeGitReader({
      existingBranches: new Set(['co/impl']),
      mergedBranches: new Set(),
      dirtyPaths: new Set(),
    });

    // The branch holds the serialized merge slot for `main` (e.g. a prior PASS verdict).
    const seed = openReviewStore('proj');
    try {
      seed.acquireSerialized({ target: 'main', branch: 'co/impl' });
      expect(seed.activeSerialized('main')).toBe('co/impl');
    } finally {
      seed.close();
    }

    const opts = {
      openRoster: () => roster,
      openWorktrees: () => worktreeStore,
      openSessions: () => sessions,
      openArchive: () => archive,
      repoCwd: '/repo',
      nowMs: 10_000,
      gitExec,
      gitReader,
    };

    // First pass: worktree force-removed + archived, then endSession throws -> partial failure.
    let firstError: unknown;
    try {
      deleteAgentSubtree('proj', 'coord-x', opts);
    } catch (err) {
      firstError = err;
    }
    expect(firstError).toBeInstanceOf(AggregateError);
    expect(worktreeStore.removeForce).toEqual(['co/impl']);
    expect(archive.records.map((r) => r.id)).toEqual(['co/impl']);
    expect(roster.getAgent('impl')).toBeDefined();
    // The slot is still held after the aborted first pass.
    const mid = openReviewStore('proj');
    try {
      expect(mid.activeSerialized('main')).toBe('co/impl');
    } finally {
      mid.close();
    }

    // Retry: `wt` is now null (worktree removed + archived), but the stale slot must STILL be released
    // — without the fallback it would be stranded behind a branch that no longer holds a live worktree.
    const result = deleteAgentSubtree('proj', 'coord-x', opts);
    expect(result.removed).toEqual(['impl', 'coord-x']);
    expect(roster.getAgent('impl')).toBeUndefined();
    expect(roster.getAgent('coord-x')).toBeUndefined();

    const after = openReviewStore('proj');
    try {
      expect(after.activeSerialized('main')).toBeUndefined();
    } finally {
      after.close();
    }
  });

  it('self-heals on retry when the first pass force-removed the worktree but the archive write failed', () => {
    const roster = makeFakeRoster([
      { agentId: 'coord-x', role: 'coordinator', parent: '@operator', registeredTs: 1 },
      { agentId: 'impl', role: 'implementer', parent: 'coord-x', registeredTs: 2 },
    ]);
    const worktreeStore = makeFakeWorktrees([worktree('co/impl', 'impl')]);
    const sessions = makeFakeSessions([]);
    // appendRecord throws on the first pass (after the worktree is force-removed), succeeds on retry.
    const archive = makeFakeArchiveFailingFirstAppend();
    const { spy: gitExec } = makeGitExecSpy();
    const gitReader = makeGitReader({
      existingBranches: new Set(['co/impl']),
      mergedBranches: new Set(),
      dirtyPaths: new Set(),
    });

    const opts = {
      openRoster: () => roster,
      openWorktrees: () => worktreeStore,
      openSessions: () => sessions,
      openArchive: () => archive,
      repoCwd: '/repo',
      nowMs: 10_000,
      gitExec,
      gitReader,
    };

    // First pass: worktree force-removed, archive append throws -> partial failure, NO record written.
    let firstError: unknown;
    try {
      deleteAgentSubtree('proj', 'coord-x', opts);
    } catch (err) {
      firstError = err;
    }
    expect(firstError).toBeInstanceOf(AggregateError);
    expect(worktreeStore.removeForce).toEqual(['co/impl']);
    expect(archive.records).toEqual([]);
    expect(roster.getAgent('impl')).toBeDefined();

    // Retry: the finder re-selects the removed-but-unarchived worktree (archive.getRecord == null),
    // skips snapshot/remove (already removed), and re-appends the archive record without data loss.
    const result = deleteAgentSubtree('proj', 'coord-x', opts);
    expect(result.removed).toEqual(['impl', 'coord-x']);
    expect(result.archivedBranches).toEqual(['co/impl']);
    expect(archive.records.map((r) => r.id)).toEqual(['co/impl']);
    // The worktree is force-removed exactly once across both passes (no double-remove on retry).
    expect(worktreeStore.removeForce).toEqual(['co/impl']);
    expect(roster.getAgent('impl')).toBeUndefined();
    expect(roster.getAgent('coord-x')).toBeUndefined();
  });

  it('fails loud on retry when a removed worktree branch existence check cannot be trusted', () => {
    const roster = makeFakeRoster([
      { agentId: 'coord-x', role: 'coordinator', parent: '@operator', registeredTs: 1 },
      { agentId: 'impl', role: 'implementer', parent: 'coord-x', registeredTs: 2 },
    ]);
    const removedWt = { ...worktree('co/impl', 'impl'), removed: true };
    const worktreeStore = makeFakeWorktrees([removedWt]);
    const sessions = makeFakeSessions([session('impl', 'pane-impl')]);
    const archive = makeFakeArchive();
    const gitExec: GitExec = (_cwd, args) => {
      if (args[0] === 'branch' && args[1] === '-d' && args[2] === 'co/impl') {
        throw new Error('fatal: not a git repository');
      }
    };
    const gitReader = makeGitReader({
      existingBranches: new Set(['co/coord-x']),
      mergedBranches: new Set(['co/coord-x']),
    });

    let caught: unknown;
    try {
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
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect(
      (caught as AggregateError).errors.some((e) => String(e).includes('not a git repository')),
    ).toBe(true);
    expect(archive.records).toEqual([]);
    expect(sessions.getSession('impl')).toBeDefined();
    expect(roster.getAgent('impl')).toBeDefined();
    expect(roster.getAgent('coord-x')).toBeDefined();
  });

  it('removes the orphaned worktree and completes teardown when a live worktree branch ref is missing with nothing to recover (#65)', () => {
    const roster = makeFakeRoster([
      { agentId: 'coord-x', role: 'coordinator', parent: '@operator', registeredTs: 1 },
      { agentId: 'impl', role: 'implementer', parent: 'coord-x', registeredTs: 2 },
    ]);
    const worktreeStore = makeFakeWorktrees([worktree('co/impl', 'impl')]);
    const sessions = makeFakeSessions([session('impl', 'pane-impl')]);
    const archive = makeFakeArchive();
    const { spy: gitExec, calls } = makeGitExecSpy();
    // co/impl's branch ref is GONE (out-of-band branch -D / force-push) while its worktree is live.
    // Its HEAD resolves to the baseline sha (no work beyond base) → nothing recoverable.
    const gitReader = makeGitReader({
      existingBranches: new Set(['co/coord-x']),
      mergedBranches: new Set(['co/coord-x', 'a'.repeat(40)]),
      worktreeHeads: new Map([['/data/worktrees/co/impl', 'a'.repeat(40)]]),
    });

    // The whole subtree delete used to wedge here (#65). It must now succeed.
    expect(() =>
      deleteAgentSubtree('proj', 'coord-x', {
        openRoster: () => roster,
        openWorktrees: () => worktreeStore,
        openSessions: () => sessions,
        openArchive: () => archive,
        repoCwd: '/repo',
        nowMs: 10_000,
        gitExec,
        gitReader,
      }),
    ).not.toThrow();

    // The orphaned worktree is force-removed (its branch ref is already gone)...
    expect(worktreeStore.removedBranches).toContain('co/impl');
    expect(worktreeStore.removeForce).toContain('co/impl');
    // ...nothing was recoverable (HEAD already in base), so no recovery ref / archive was written.
    expect(archive.records).toEqual([]);
    expect(calls.some((call) => call[1] === 'update-ref')).toBe(false);
    // ...and no branch delete is attempted (there is no branch to delete).
    expect(calls.some((call) => call.join(' ').includes('branch -d co/impl'))).toBe(false);
    expect(calls.some((call) => call.join(' ').includes('branch -D co/impl'))).toBe(false);
    // The cascade completes: sessions ended + roster entries removed for the whole subtree.
    expect(sessions.getSession('impl')).toBeUndefined();
    expect(roster.getAgent('impl')).toBeUndefined();
    expect(roster.getAgent('coord-x')).toBeUndefined();
  });

  it('re-anchors committed unmerged work under a recovery ref when an orphaned worktree HEAD is ahead of base (#65 safety)', () => {
    const roster = makeFakeRoster([
      { agentId: 'coord-x', role: 'coordinator', parent: '@operator', registeredTs: 1 },
      { agentId: 'impl', role: 'implementer', parent: 'coord-x', registeredTs: 2, name: 'impl' },
    ]);
    const worktreeStore = makeFakeWorktrees([worktree('co/impl', 'impl')]);
    const sessions = makeFakeSessions([session('impl', 'pane-impl')]);
    const archive = makeFakeArchive();
    const { spy: gitExec, calls } = makeGitExecSpy();
    // Branch ref gone, but the worktree HEAD ('b'*40) carries commits NOT contained in base — the
    // exact force-push/history-rewrite case the old fix silently dropped to GC.
    const gitReader = makeGitReader({
      existingBranches: new Set(['co/coord-x']),
      mergedBranches: new Set(['co/coord-x']),
      worktreeHeads: new Map([['/data/worktrees/co/impl', 'b'.repeat(40)]]),
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

    // The branch ref is re-created at the tip (same reaper-purgeable lifecycle as the unmerged
    // path) so it survives GC...
    expect(
      calls.some(
        (c) => c[1] === 'update-ref' && c[2] === 'refs/heads/co/impl' && c[3] === 'b'.repeat(40),
      ),
    ).toBe(true);
    // ...and archived (keyed by branch) so it is discoverable/restorable AND the reaper can purge
    // it at TTL via `git branch -D` (which only touches refs/heads/*).
    expect(archive.records).toHaveLength(1);
    expect(archive.records[0]?.branch).toBe('co/impl');
    // ...then the orphaned worktree is force-removed, and teardown completes.
    expect(worktreeStore.removeForce).toContain('co/impl');
    expect(roster.getAgent('impl')).toBeUndefined();
    expect(roster.getAgent('coord-x')).toBeUndefined();
  });

  it('snapshots dirty work before removing an orphaned worktree with a missing branch ref (#65 safety)', () => {
    const roster = makeFakeRoster([
      { agentId: 'coord-x', role: 'coordinator', parent: '@operator', registeredTs: 1 },
      { agentId: 'impl', role: 'implementer', parent: 'coord-x', registeredTs: 2, name: 'impl' },
    ]);
    const sandboxPath = '/data/worktrees/co/impl';
    const worktreeStore = makeFakeWorktrees([worktree('co/impl', 'impl', 'main', sandboxPath)]);
    const sessions = makeFakeSessions([session('impl', 'pane-impl')]);
    const archive = makeFakeArchive();
    const { spy: gitExec, calls } = makeGitExecSpy();
    // Branch ref gone AND the worktree has uncommitted changes — both must be preserved, not erased.
    const gitReader = makeGitReader({
      existingBranches: new Set(['co/coord-x']),
      mergedBranches: new Set(['co/coord-x']),
      dirtyPaths: new Set([sandboxPath]),
      worktreeHeads: new Map([[sandboxPath, 'b'.repeat(40)]]),
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

    // Dirty work is snapshotted (add -A then commit -s) BEFORE the force-remove...
    expect(calls.some((c) => c[0] === sandboxPath && c[1] === 'add' && c[2] === '-A')).toBe(true);
    expect(calls.some((c) => c[0] === sandboxPath && c[1] === 'commit')).toBe(true);
    // ...and the resulting snapshot tip ('f'*40 from the post-commit rev-parse) is re-anchored
    // at refs/heads/<branch> (reaper-purgeable).
    expect(calls.some((c) => c[1] === 'update-ref' && c[2] === 'refs/heads/co/impl')).toBe(true);
    expect(archive.records).toHaveLength(1);
    expect(worktreeStore.removeForce).toContain('co/impl');
  });

  it('force-removes a truly unrecoverable orphaned worktree (unresolvable HEAD) without archiving (#65)', () => {
    const roster = makeFakeRoster([
      { agentId: 'coord-x', role: 'coordinator', parent: '@operator', registeredTs: 1 },
      { agentId: 'impl', role: 'implementer', parent: 'coord-x', registeredTs: 2 },
    ]);
    const worktreeStore = makeFakeWorktrees([worktree('co/impl', 'impl')]);
    const sessions = makeFakeSessions([session('impl', 'pane-impl')]);
    const archive = makeFakeArchive();
    const { spy: gitExec, calls } = makeGitExecSpy();
    // Branch ref gone AND the worktree HEAD does not resolve (broken/dangling) → nothing to recover.
    const gitReader = makeGitReader({
      existingBranches: new Set(['co/coord-x']),
      mergedBranches: new Set(['co/coord-x']),
      worktreeHeads: new Map([['/data/worktrees/co/impl', null]]),
    });

    expect(() =>
      deleteAgentSubtree('proj', 'coord-x', {
        openRoster: () => roster,
        openWorktrees: () => worktreeStore,
        openSessions: () => sessions,
        openArchive: () => archive,
        repoCwd: '/repo',
        nowMs: 10_000,
        gitExec,
        gitReader,
      }),
    ).not.toThrow();

    expect(worktreeStore.removeForce).toContain('co/impl');
    expect(archive.records).toEqual([]);
    expect(calls.some((call) => call[1] === 'update-ref')).toBe(false);
    expect(roster.getAgent('impl')).toBeUndefined();
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
    // co/lead's removeWorktree throws, and coord-x cannot be removed while lead remains.
    expect(ae.errors).toHaveLength(2);
    expect((ae.errors[0] as Error).message).toContain('co/lead');

    // Despite the partial failure, impl and coord-x were still processed
    expect(roster.removed).toContain('impl');
    // Failed teardown rows stay rostered so the operator can retry/recover and the fleet reflects reality.
    expect(roster.removed).not.toContain('lead');
    expect(roster.removed).not.toContain('coord-x');
    expect(roster.getAgent('lead')).toBeDefined();
    expect(roster.getAgent('coord-x')).toBeDefined();
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
