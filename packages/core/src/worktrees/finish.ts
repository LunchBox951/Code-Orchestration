import type { MailStore } from '../mail/mail-store.js';
import { MAIL_WORKER_DONE } from '../mail/events.js';
import type { TestOutcome } from './events.js';
import { renderCommitMessage, type CommitIntent } from './messages.js';
import { defaultGitExec, type GitExec } from './sling.js';
import type { WorktreeStore } from './worktree-store.js';

/**
 * `co_finish`'s core (AC-L3-6): COMMIT the worktree with a house-style message rendered from the
 * agent's intent (DCO-signed), RECORD the finish (the commit + the finish's test run — the durable
 * input L5 compares against the captured baseline), and EMIT `worker_done` (informational) to the
 * parent the sling recorded. It does NOT dispatch a reviewer and does NOT merge — that gate is L5
 * (the {@link import('./review-trigger.js').FinishReviewGateStub} marks the seam; this layer stops
 * short of it). It does NOT compute the regression diff either (L5 compares; this layer records).
 *
 * The message is rendered by {@link renderCommitMessage} — a pure core function with NO provider /
 * voice parameter — so provider voice can never reach the commit (Principle 3). The git mutation
 * (stage + commit) goes through an injectable {@link GitExec} seam so the orchestration is unit-
 * testable headless; the real commit path is integration-tested against a temp worktree.
 */

/** The minimal read-only git facts the finish core needs: the current branch + post-commit HEAD. */
export interface WorktreeGitFacts {
  /** The worktree's current branch (`rev-parse --abbrev-ref HEAD`). */
  readonly branch: string;
  /** The full HEAD commit sha (`rev-parse HEAD`) — read back AFTER the commit. */
  readonly headSha: string;
}

/** Inputs to {@link finishWorktree}. */
export interface FinishParams {
  /** The finishing agent — the `worker_done` sender + the commit's effective author. */
  readonly agent: string;
  /** The worktree the agent is finishing in (its cwd). */
  readonly repoCwd: string;
  /** The structured commit intent — rendered into the house-style commit message. */
  readonly intent: CommitIntent;
  /** The finish's test run (structured, aligned with the baseline so L5 can compare). */
  readonly tests: readonly TestOutcome[];
  /** Optional free-form notes, surfaced in the `worker_done` body. */
  readonly notes?: string;
}

/**
 * Injectable seams for {@link finishWorktree}. `readInfo` is REQUIRED (injected by the `co_finish`
 * tool, which passes `readWorktreeInfo` — keeping this core free of a `tools/` import, so there is
 * no `tools` ↔ `worktrees` cycle). `gitExec` defaults to the production {@link defaultGitExec}.
 */
export interface FinishDeps {
  /** Read the worktree's branch + HEAD sha. Required; the tool injects `readWorktreeInfo`. */
  readonly readInfo: (cwd: string) => WorktreeGitFacts;
  /** Mutating git seam (stage + commit). Defaults to {@link defaultGitExec}. */
  readonly gitExec?: GitExec;
}

/** The structured facts {@link finishWorktree} returns (what `co_finish` reports back). */
export interface FinishResult {
  readonly branch: string;
  readonly commitSha: string;
  readonly commitMessage: string;
  readonly workerDoneSeq: number;
  readonly finishRecorded: boolean;
}

/** A one-line, deterministic test summary for the `worker_done` body (e.g. `3/4 passed (1 failing)`). */
function summarizeTests(tests: readonly TestOutcome[]): string {
  const total = tests.length;
  const passed = tests.filter((t) => t.passed).length;
  const failing = total - passed;
  const suffix = failing > 0 ? ` (${failing} failing)` : '';
  return `${passed}/${total} passed${suffix}`;
}

/**
 * Run the finish. Steps:
 *   1. Resolve the worktree's current branch; load its sling record (loud-fail if absent — finishing
 *      outside a slung sandbox) for the recorded `parent` (the `worker_done` recipient) + `baseSha`.
 *   2. Render the commit message from intent.
 *   3. Stage everything and commit with that message + DCO sign-off (`git commit -s`), then read back
 *      the commit sha.
 *   4. Record the finish (commit sha + tests) — the durable input L5 compares against the baseline.
 *   5. Emit `worker_done` (informational) to the recorded parent.
 * It does NOT dispatch a reviewer or merge (L5 — freeze #2).
 */
export function finishWorktree(
  store: WorktreeStore,
  mail: MailStore,
  params: FinishParams,
  deps: FinishDeps,
): FinishResult {
  const gitExec = deps.gitExec ?? defaultGitExec;
  const { readInfo } = deps;
  const { agent, repoCwd, intent, tests, notes } = params;

  // 1) Resolve the branch + load the sling record (the recorded parent + baseSha).
  const { branch } = readInfo(repoCwd);
  const record = store.getWorktree(branch);
  if (!record) {
    throw new Error(
      `co_finish: no worktree record for branch '${branch}' — finishing outside a slung sandbox ` +
        '(sling records the sandbox; co_finish reads the parent it recorded). Sling first.',
    );
  }

  // 2) Render the house-style commit message (provider-deterministic — no voice parameter).
  const commitMessage = renderCommitMessage(intent);

  // 3) Stage + commit the worktree's own content with the rendered message + DCO sign-off, then read
  //    back the commit sha. Committing the worktree's content is the worker's sandbox, not an
  //    orchestration write (Principle 12) — the finish RECORD + worker_done go to program-data / the bus.
  gitExec(repoCwd, ['add', '-A']);
  gitExec(repoCwd, ['commit', '-s', '-m', commitMessage]);
  const { headSha: commitSha } = readInfo(repoCwd);

  // 4) Record the finish (commit + tests) — the durable L5 input. Do NOT compute the regression diff.
  store.recordFinish({ branch, baseSha: record.baseSha, commitSha, tests: [...tests] });

  // 5) Emit worker_done (informational) to the recorded parent — bus-visible, non-sticky.
  const subject = `worker_done: ${branch}`;
  const body =
    `Finished ${branch} at ${commitSha}.\n` +
    `Commit: ${commitMessage.split('\n', 1)[0]}\n` +
    `Tests: ${summarizeTests(tests)}.` +
    (notes != null && notes.trim().length > 0 ? `\n\nNotes: ${notes.trim()}` : '');
  const delivered = mail.send({
    type: MAIL_WORKER_DONE,
    to: record.parent,
    from: agent,
    subject,
    body,
  });

  return {
    branch,
    commitSha,
    commitMessage,
    workerDoneSeq: delivered.seq,
    finishRecorded: true,
  };
}
