/**
 * Unit tests for reapExpiredArchives — the archive reaper that purges expired unmerged branches.
 *
 * Tests drive through injected in-memory fakes:
 *   - `archive` is a hand-rolled object implementing the ArchiveStore interface.
 *   - `gitExec` is a spy function that records calls and returns controlled outputs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArchiveRecord } from '../archive/events.js';
import type { ArchiveStore } from '../archive/archive-store.js';
import type { GitExec } from '../worktrees/sling.js';
import { reapExpiredArchives } from './reap-archives.js';
import { openArchiveStore } from '../archive/archive-store.js';

// ── test harness ─────────────────────────────────────────────────────────────────────────────────

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
});

// ── in-memory fake archive store ──────────────────────────────────────────────────────────────────

function makeFakeArchive(records: ArchiveRecord[]): ArchiveStore & { stored: ArchiveRecord[] } {
  const stored = [...records];
  return {
    stored,
    appendRecord: () => {
      throw new Error('not implemented');
    },
    removeRecord(id: string): ArchiveRecord | undefined {
      const idx = stored.findIndex((r) => r.id === id);
      if (idx === -1) return undefined;
      const [rec] = stored.splice(idx, 1);
      return rec;
    },
    getRecord: () => undefined,
    listRecords(): readonly ArchiveRecord[] {
      return [...stored];
    },
    listExpired(nowMs: number): readonly ArchiveRecord[] {
      return stored.filter((r) => r.expiresAt < nowMs);
    },
    close() {},
  };
}

// ── spy helpers ───────────────────────────────────────────────────────────────────────────────────

/** Records every git command invocation. */
function makeGitExecSpy(): {
  spy: GitExec;
  calls: Array<{ cwd: string; args: readonly string[] }>;
} {
  const calls: Array<{ cwd: string; args: readonly string[] }> = [];
  const spy: GitExec = (cwd, args) => {
    calls.push({ cwd, args: [...args] });
  };
  return { spy, calls };
}

// ── tests ─────────────────────────────────────────────────────────────────────────────────────────

describe('reapExpiredArchives', () => {
  it('purges only expired records and calls branch -D once per expired record', () => {
    const now = 10_000;
    const archive = makeFakeArchive([
      {
        id: 'exp1',
        name: 'expired-coord',
        branch: 'co/expired-1',
        baseRef: 'main',
        deletedAt: 5000,
        expiresAt: 9000, // expires before nowMs
      },
      {
        id: 'notexp1',
        name: 'not-expired-coord',
        branch: 'co/not-expired-1',
        baseRef: 'main',
        deletedAt: 6000,
        expiresAt: 15000, // expires after nowMs
      },
    ]);
    const { spy: gitExec, calls } = makeGitExecSpy();

    const result = reapExpiredArchives('proj', now, {
      openArchive: () => archive,
      repoCwd: '/repo',
      gitExec,
    });

    // Only the expired record should be in the result
    expect(result).toEqual(['co/expired-1']);

    // Verify the git command was called correctly
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      cwd: '/repo',
      args: ['branch', '-D', 'co/expired-1'],
    });

    // Verify the expired record was removed from the archive
    expect(archive.stored).toHaveLength(1);
    expect(archive.stored[0]?.id).toBe('notexp1');
  });

  it('aggregates errors from failed branch deletions and keeps failed records for retry', () => {
    const now = 10_000;
    const archive = makeFakeArchive([
      {
        id: 'exp1',
        name: 'coord1',
        branch: 'co/exp1',
        baseRef: 'main',
        deletedAt: 5000,
        expiresAt: 9000,
      },
      {
        id: 'exp2',
        name: 'coord2',
        branch: 'co/exp2',
        baseRef: 'main',
        deletedAt: 5500,
        expiresAt: 8500,
      },
    ]);

    let callCount = 0;
    const gitExec: GitExec = (cwd, args) => {
      callCount++;
      if (args[2] === 'co/exp1') {
        throw new Error('git branch -D failed for co/exp1');
      }
      // co/exp2 succeeds
    };

    let caught: unknown;
    try {
      reapExpiredArchives('proj', now, {
        openArchive: () => archive,
        repoCwd: '/repo',
        gitExec,
      });
    } catch (err) {
      caught = err;
    }

    // The single failure (co/exp1) is surfaced as a one-element AggregateError naming the failing branch.
    expect(caught).toBeInstanceOf(AggregateError);
    const ae = caught as AggregateError;
    expect(ae.errors).toHaveLength(1);
    expect((ae.errors[0] as Error).message).toContain('co/exp1');

    // Even though exp1 failed, both branch deletion attempts should have been made
    expect(callCount).toBe(2);

    // Only the successfully purged record is removed. The failed one stays archived so a later reaper
    // or operator Purge can retry rather than losing the handle to a still-existing branch.
    const remaining = archive.stored;
    expect(remaining.map((r) => r.id)).toEqual(['exp1']);
  });

  it('removes expired archive records when the branch was already deleted by an earlier attempt', () => {
    const now = 10_000;
    const archive = makeFakeArchive([
      {
        id: 'exp1',
        name: 'coord1',
        branch: 'co/exp1',
        baseRef: 'main',
        deletedAt: 5000,
        expiresAt: 9000,
      },
    ]);
    const gitExec: GitExec = () => {
      throw new Error("error: branch 'co/exp1' not found");
    };

    const result = reapExpiredArchives('proj', now, {
      openArchive: () => archive,
      repoCwd: '/repo',
      gitExec,
    });

    expect(result).toEqual(['co/exp1']);
    expect(archive.stored).toEqual([]);
  });

  it('returns empty array when no records are expired', () => {
    const now = 10_000;
    const archive = makeFakeArchive([
      {
        id: 'a1',
        name: 'coord1',
        branch: 'co/a1',
        baseRef: 'main',
        deletedAt: 5000,
        expiresAt: 15000, // expires after nowMs
      },
    ]);
    const { spy: gitExec, calls } = makeGitExecSpy();

    const result = reapExpiredArchives('proj', now, {
      openArchive: () => archive,
      repoCwd: '/repo',
      gitExec,
    });

    expect(result).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(archive.stored).toHaveLength(1);
  });

  it('closes the archive store in finally block even on error', () => {
    const now = 10_000;
    let closed = false;
    const archive: ArchiveStore = {
      appendRecord: () => {
        throw new Error('not implemented');
      },
      removeRecord: () => undefined,
      getRecord: () => undefined,
      listRecords: () => [],
      listExpired: () => [
        {
          id: 'exp1',
          name: 'coord1',
          branch: 'co/exp1',
          baseRef: 'main',
          deletedAt: 5000,
          expiresAt: 9000,
        },
      ],
      close() {
        closed = true;
      },
    };

    const gitExec: GitExec = () => {
      throw new Error('git failed');
    };

    expect(() =>
      reapExpiredArchives('proj', now, {
        openArchive: () => archive,
        repoCwd: '/repo',
        gitExec,
      }),
    ).toThrow();

    expect(closed).toBe(true);
  });

  it('uses defaultGitExec and defaultOpenArchive when not provided', () => {
    // End-to-end test: use real openArchiveStore and defaultGitExec seams.
    // Set up a fresh isolated CO_DATA_DIR.
    const dir = mkdtempSync(join(tmpdir(), 'co-reaper-defaults-'));
    dataDirs.push(dir);
    process.env.CO_DATA_DIR = dir;

    // Create a test project with one non-expired archive record using the real store.
    const projectId = 'test-proj-defaults';
    const archive = openArchiveStore(projectId);
    try {
      // Seed one non-expired record.
      archive.appendRecord({
        id: 'arch-1',
        name: 'test-coord',
        branch: 'co/test-branch',
        baseRef: 'main',
        deletedAt: 5000,
        expiresAt: 100_000, // far in the future relative to nowMs
      });
    } finally {
      archive.close();
    }

    // Call reapExpiredArchives with only repoCwd (no openArchive or gitExec injection).
    // This forces the function to use defaultGitExec and openArchiveStore.
    // Since nowMs = 50_000 and expiresAt = 100_000, the record is NOT expired,
    // so the reaper should never call git or remove anything.
    const nowMs = 50_000;
    const result = reapExpiredArchives(projectId, nowMs, {
      repoCwd: '/fake/repo',
      // no openArchive, no gitExec — forces use of defaults
    });

    // Assert no branches were purged (record not expired).
    expect(result).toEqual([]);

    // Verify the record still exists in the archive (was not removed).
    const archive2 = openArchiveStore(projectId);
    try {
      const allRecords = archive2.listRecords();
      expect(allRecords).toHaveLength(1);
      expect(allRecords[0]?.branch).toBe('co/test-branch');
    } finally {
      archive2.close();
    }
  });

  it('processes multiple expired records in stable order', () => {
    const now = 20_000;
    const archive = makeFakeArchive([
      {
        id: 'z1',
        name: 'coord-z',
        branch: 'co/z',
        baseRef: 'main',
        deletedAt: 3000,
        expiresAt: 15000,
      },
      {
        id: 'a1',
        name: 'coord-a',
        branch: 'co/a',
        baseRef: 'main',
        deletedAt: 1000,
        expiresAt: 18000,
      },
      {
        id: 'm1',
        name: 'coord-m',
        branch: 'co/m',
        baseRef: 'main',
        deletedAt: 2000,
        expiresAt: 19000,
      },
    ]);
    const { spy: gitExec, calls } = makeGitExecSpy();

    const result = reapExpiredArchives('proj', now, {
      openArchive: () => archive,
      repoCwd: '/repo',
      gitExec,
    });

    // All three are expired (expiresAt < 20000)
    expect([...result].sort()).toEqual(['co/a', 'co/m', 'co/z']);

    // All three branch deletions should be called
    expect(calls).toHaveLength(3);

    // All should be removed from archive
    expect(archive.stored).toHaveLength(0);
  });
});
