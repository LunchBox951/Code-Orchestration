import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMailStore, type MailStore } from '../mail/mail-store.js';
import { MAIL_WORKER_DONE, mailKind } from '../mail/events.js';
import { openWorktreeStore, type WorktreeStore } from './worktree-store.js';
import { finishWorktree, type WorktreeGitFacts } from './finish.js';
import { renderCommitMessage, type CommitIntent } from './messages.js';
import { worktreePathFor } from './sling.js';

// AC-L3-6 — the co_finish CORE, headless (no real git): finishWorktree commits via the injectable
// GitExec seam, records the finish (commit + tests — the L5 input), and emits worker_done
// (informational) to the recorded parent. Loud-fails when finishing outside a slung sandbox.

const ORIGINAL_ENV = process.env;
let tmpDirs: string[] = [];
let stores: WorktreeStore[] = [];
let mails: MailStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  tmpDirs = [];
  stores = [];
  mails = [];
  const data = mkdtempSync(join(tmpdir(), 'co-finish-core-'));
  tmpDirs.push(data);
  process.env.CO_DATA_DIR = data;
});

afterEach(() => {
  for (const s of stores) s.close();
  for (const m of mails) m.close();
  process.env = ORIGINAL_ENV;
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs = [];
  stores = [];
  mails = [];
});

function openStores(projectId: string): { store: WorktreeStore; mail: MailStore } {
  const store = openWorktreeStore(projectId);
  stores.push(store);
  const mail = openMailStore(projectId);
  mails.push(mail);
  return { store, mail };
}

/** A recording GitExec that does nothing (no real git) but captures the calls. */
function recordingGitExec(): {
  calls: { cwd: string; args: readonly string[] }[];
  exec: (cwd: string, args: readonly string[]) => void;
} {
  const calls: { cwd: string; args: readonly string[] }[] = [];
  return { calls, exec: (cwd, args) => calls.push({ cwd, args }) };
}

const intent: CommitIntent = {
  type: 'feat',
  scope: 'core',
  summary: 'add the thing',
  body: 'It does the thing the spec asked for.',
};

describe('finishWorktree — commit + record finish + emit worker_done', () => {
  it('commits (signed) with the rendered message, records the finish, and pings the parent', () => {
    const { store, mail } = openStores('p-finish-ok');
    const repoCwd = '/wt/co/feature';
    store.recordWorktree({
      branch: 'co/feature',
      baseRef: 'main',
      baseSha: 'b'.repeat(40),
      path: repoCwd,
      parent: 'lead-7',
    });
    const git = recordingGitExec();
    const readInfo = (): WorktreeGitFacts => ({
      branch: 'co/feature',
      headSha: 'c'.repeat(40),
    });

    const result = finishWorktree(
      store,
      mail,
      {
        agent: 'impl-1',
        repoCwd,
        intent,
        tests: [
          { name: 'suite/a', passed: true },
          { name: 'suite/b', passed: false },
        ],
        notes: 'left b failing on purpose',
      },
      { readInfo, gitExec: git.exec },
    );

    // It staged everything, then committed with sign-off and the rendered message.
    expect(git.calls[0]?.args).toEqual(['add', '-A']);
    expect(git.calls[1]?.args).toEqual(['commit', '-s', '-m', renderCommitMessage(intent)]);

    // Structured result.
    expect(result.branch).toBe('co/feature');
    expect(result.commitSha).toBe('c'.repeat(40));
    expect(result.commitMessage).toBe(renderCommitMessage(intent));
    expect(result.finishRecorded).toBe(true);
    expect(typeof result.workerDoneSeq).toBe('number');

    // The finish record stored for L5 (commit + tests, aligned with the baseline shape).
    const finish = store.getFinish('co/feature');
    expect(finish).toBeDefined();
    expect(finish?.commitSha).toBe('c'.repeat(40));
    expect(finish?.baseSha).toBe('b'.repeat(40));
    expect(finish?.agent).toBe('impl-1');
    expect(finish?.tests).toEqual([
      { name: 'suite/a', passed: true },
      { name: 'suite/b', passed: false },
    ]);
    expect(finish?.recordedTs).toBeGreaterThan(0);

    // worker_done landed in the recorded parent's inbox, informational, from the finishing agent.
    const inbox = mail.inbox('lead-7');
    expect(inbox).toHaveLength(1);
    const wd = inbox[0]!;
    expect(wd.type).toBe(MAIL_WORKER_DONE);
    expect(wd.seq).toBe(result.workerDoneSeq);
    expect(wd.sender).toBe('impl-1');
    expect(wd.body).toContain('c'.repeat(40)); // the commit sha
    expect(wd.body).toContain('1/2 passed (1 failing)'); // the honest test summary
    expect(wd.body).toContain('left b failing on purpose'); // the notes
  });

  it('worker_done is informational (non-sticky) — it raises no outstanding action on the parent', () => {
    const { store, mail } = openStores('p-finish-informational');
    const repoCwd = '/wt';
    store.recordWorktree({
      branch: 'co/x',
      baseRef: 'main',
      baseSha: 'b'.repeat(40),
      path: repoCwd,
      parent: 'lead-7',
    });
    finishWorktree(
      store,
      mail,
      { agent: 'impl-1', repoCwd, intent, tests: [{ name: 't', passed: true }] },
      { readInfo: () => ({ branch: 'co/x', headSha: 'a'.repeat(40) }), gitExec: () => {} },
    );
    // Informational, so it does NOT count as an outstanding action (freeze #3).
    expect(mailKind(MAIL_WORKER_DONE)).toBe('informational');
    expect(mail.outstandingCount('lead-7')).toBe(0);
  });

  it('loud-fails when finishing a branch with no worktree record (outside a slung sandbox)', () => {
    const { store, mail } = openStores('p-finish-orphan');
    expect(() =>
      finishWorktree(
        store,
        mail,
        { agent: 'impl-1', repoCwd: '/wt', intent, tests: [] },
        { readInfo: () => ({ branch: 'co/unslung', headSha: 'a'.repeat(40) }), gitExec: () => {} },
      ),
    ).toThrow(/outside a slung sandbox/i);
  });

  it('does NOT commit when there is no worktree record (the loud-fail happens before any git write)', () => {
    const { store, mail } = openStores('p-finish-nocommit');
    const git = recordingGitExec();
    expect(() =>
      finishWorktree(
        store,
        mail,
        { agent: 'impl-1', repoCwd: '/wt', intent, tests: [] },
        { readInfo: () => ({ branch: 'co/unslung', headSha: 'a'.repeat(40) }), gitExec: git.exec },
      ),
    ).toThrow();
    expect(git.calls).toHaveLength(0); // never touched git
  });

  it('does NOT commit when the worktree record was removed', () => {
    const { store, mail } = openStores('p-finish-removed');
    store.recordWorktree({
      branch: 'co/removed',
      baseRef: 'main',
      baseSha: 'b'.repeat(40),
      path: worktreePathFor('p-finish-removed', 'co/removed'),
      parent: 'lead-7',
    });
    store.removeWorktree('co/removed', {
      repoCwd: '/main/repo',
      gitExec: () => {},
      fs: {
        exists: () => false,
        isSymlink: () => false,
        realpath: (path) => path,
        removeDir: () => {},
      },
    });
    const git = recordingGitExec();

    expect(() =>
      finishWorktree(
        store,
        mail,
        { agent: 'impl-1', repoCwd: '/wt', intent, tests: [] },
        { readInfo: () => ({ branch: 'co/removed', headSha: 'a'.repeat(40) }), gitExec: git.exec },
      ),
    ).toThrow(/removed/i);
    expect(git.calls).toHaveLength(0);
    expect(store.getFinish('co/removed')).toBeUndefined();
  });

  it('does NOT commit when cwd does not match the recorded sandbox path for the branch', () => {
    const { store, mail } = openStores('p-finish-wrong-cwd');
    store.recordWorktree({
      branch: 'co/feature',
      baseRef: 'main',
      baseSha: 'b'.repeat(40),
      path: '/recorded/sandbox',
      parent: 'lead-7',
    });
    const git = recordingGitExec();

    expect(() =>
      finishWorktree(
        store,
        mail,
        { agent: 'impl-1', repoCwd: '/other/sandbox', intent, tests: [] },
        { readInfo: () => ({ branch: 'co/feature', headSha: 'a'.repeat(40) }), gitExec: git.exec },
      ),
    ).toThrow(/does not match the recorded sandbox path/i);

    expect(git.calls).toHaveLength(0);
    expect(store.getFinish('co/feature')).toBeUndefined();
    expect(mail.inbox('lead-7')).toEqual([]);
  });

  it('does not leave a finish record if the finishing agent is invalid', () => {
    const { store, mail } = openStores('p-finish-atomic');
    const repoCwd = '/wt';
    store.recordWorktree({
      branch: 'co/atomic',
      baseRef: 'main',
      baseSha: 'b'.repeat(40),
      path: repoCwd,
      parent: 'lead-7',
    });
    const git = recordingGitExec();

    expect(() =>
      finishWorktree(
        store,
        mail,
        { agent: '', repoCwd, intent, tests: [] },
        { readInfo: () => ({ branch: 'co/atomic', headSha: 'a'.repeat(40) }), gitExec: git.exec },
      ),
    ).toThrow(/agent/i);

    expect(store.getFinish('co/atomic')).toBeUndefined();
    expect(mail.inbox('lead-7')).toEqual([]);
    expect(git.calls).toHaveLength(0);
  });
});

// The L5 review-trigger + merge gate (FinishReviewGate) is now REAL — its implementation (CoReviewGate)
// and the gated-merge behaviour are exercised in review/merge.test.ts, not here. co_finish still stops
// short of it (it never dispatches a reviewer or merges), as the tests above assert.
