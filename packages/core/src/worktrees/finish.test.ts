import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMailStore, type MailStore } from '../mail/mail-store.js';
import { MAIL_WORKER_DONE, mailKind } from '../mail/events.js';
import { openWorktreeStore, type WorktreeStore } from './worktree-store.js';
import { finishWorktree, type WorktreeGitFacts } from './finish.js';
import { renderCommitMessage, type CommitIntent } from './messages.js';
import { FinishReviewGateStub } from './review-trigger.js';

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
    store.recordWorktree({
      branch: 'co/feature',
      baseRef: 'main',
      baseSha: 'b'.repeat(40),
      path: '/data/worktrees/co/feature',
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
        repoCwd: '/wt/co/feature',
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
    store.recordWorktree({
      branch: 'co/x',
      baseRef: 'main',
      baseSha: 'b'.repeat(40),
      path: '/d/x',
      parent: 'lead-7',
    });
    finishWorktree(
      store,
      mail,
      { agent: 'impl-1', repoCwd: '/wt', intent, tests: [{ name: 't', passed: true }] },
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
});

describe('FinishReviewGateStub — the L5 review-trigger + merge plug-point (never a silent no-op)', () => {
  it('triggerReview + merge fail loud with the documented L5 plug-point contract', () => {
    const gate = new FinishReviewGateStub();
    expect(() => gate.triggerReview()).toThrow(/L5 plug-point/);
    expect(() => gate.triggerReview()).toThrow(/not implemented at L3/);
    expect(() => gate.merge()).toThrow(/L5 plug-point/);
    expect(() => gate.merge()).toThrow(/not implemented at L3/);
  });
});
