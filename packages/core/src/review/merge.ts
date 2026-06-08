import { renderMergeMessage } from '../worktrees/messages.js';
import {
  CoRepoModeGate,
  resolveRepoMode,
  type EnactPublishDeps,
  type RepoMode,
  type RepoModeGate,
} from '../worktrees/repo-mode.js';
import type {
  FinishReviewGate,
  ReviewMergeRequest,
  ReviewMergeResult,
  ReviewTriggerRequest,
  ReviewTriggerResult,
} from '../worktrees/review-trigger.js';
import type { GitExec } from '../worktrees/sling.js';
import type { ReviewStore } from './review-store.js';

/**
 * Injectable seams for {@link CoReviewGate}. `reviews` is REQUIRED (the verdict store the merge gates
 * on); the rest default to production so the gate is headless-testable with a fake git + a recorded
 * verdict, mirroring the L3 cores.
 */
export interface ReviewGateDeps {
  /** The L5 review store — the merge reads `getVerdict(target, branch)` and the trigger records a request. */
  readonly reviews: ReviewStore;
  /** The repo-mode enactment gate (default {@link CoRepoModeGate}); does the actual git merge. */
  readonly repoModeGate?: RepoModeGate;
  /** Resolve the effective repo mode (default {@link resolveRepoMode}); injectable for headless tests. */
  readonly resolveMode?: (projectId: string, repoCwd: string) => RepoMode;
  /** Mutating git seam passed through to the enactment (default {@link import('../worktrees/sling.js').defaultGitExec}). */
  readonly gitExec?: GitExec;
  /** Post-merge HEAD reader passed through to the enactment (default `git rev-parse HEAD`). */
  readonly headReader?: (repoCwd: string) => string;
}

/**
 * The production L5 review gate (AC-L5-1) — the real {@link FinishReviewGate} `co_merge` consumes. It is
 * the single place the merge is GATED: no un-gated merge path exists.
 *
 *   - `merge` refuses unless a `PASS` verdict is RECORDED for the branch on the target (absent or
 *     `ISSUES` ⇒ refuse, loud — Principle 9), renders the house-style merge message via
 *     {@link renderMergeMessage} (`[reviewed: PASS]`), and enacts owner/offline through the repo-mode
 *     gate. Contributor publishing (fork→PR) is refused here as Phase C.
 *   - `triggerReview` records a `review.requested` (the request flow's real consumer is Phase E).
 *
 * It writes only program-data + the target repo's own git (the merge commit) — never any orchestration
 * file into the tree (Principle 12).
 */
export class CoReviewGate implements FinishReviewGate {
  private readonly deps: ReviewGateDeps;

  constructor(deps: ReviewGateDeps) {
    this.deps = deps;
  }

  triggerReview(req: ReviewTriggerRequest): ReviewTriggerResult {
    const rec = this.deps.reviews.recordReviewRequested({
      reviewId: req.reviewId,
      target: req.target,
      branch: req.branch,
      requestedBy: req.requestedBy,
    });
    return {
      reviewId: rec.reviewId,
      target: rec.target,
      branch: rec.branch,
      requestedTs: rec.requestedTs,
    };
  }

  merge(req: ReviewMergeRequest): ReviewMergeResult {
    const resolveMode = this.deps.resolveMode ?? resolveRepoMode;
    const repoModeGate = this.deps.repoModeGate ?? new CoRepoModeGate();

    // 1) Resolve the repo mode. Contributor publishing (fork→PR) is Phase C — refuse here, loud, with a
    //    clear pointer (Principle 9 — never a silent no-op).
    const mode = resolveMode(req.projectId, req.repoCwd);
    if (mode === 'contributor') {
      throw new Error(
        `co_merge: contributor publishing is Phase C (co_push / co_pr_merge) — not available yet. ` +
          `Cannot merge '${req.branch}' into '${req.into}' in contributor mode.`,
      );
    }

    // 2) GATE on a recorded PASS (AC-L5-1). No PASS recorded for this branch on this target ⇒ refuse.
    const verdict = this.deps.reviews.getVerdict(req.into, req.branch);
    if (!verdict) {
      throw new Error(
        `co_merge: refused — no review verdict is recorded for '${req.branch}' into '${req.into}'. ` +
          'A merge requires a recorded PASS (AC-L5-1); run co_review_finalize first.',
      );
    }
    if (verdict.verdict !== 'PASS') {
      throw new Error(
        `co_merge: refused — the recorded verdict for '${req.branch}' into '${req.into}' is ` +
          `${verdict.verdict} (${verdict.blockers.length} blocker(s)), not PASS. Address the ` +
          'blockers and record a new PASS before merging (AC-L5-1).',
      );
    }

    // 3) Render the house-style merge message (provider-deterministic — no voice parameter). The
    //    override path ([reviewed: override — <reason>]) is Phase F; this phase always references PASS.
    const message = renderMergeMessage({
      branch: req.branch,
      summary: req.summary,
      reviewVerdict: 'PASS',
      ...(req.body != null ? { body: req.body } : {}),
    });

    // 4) Enact the merge for owner/offline through the repo-mode gate (the only repo write).
    const enactDeps: EnactPublishDeps = {
      ...(this.deps.gitExec != null ? { gitExec: this.deps.gitExec } : {}),
      ...(this.deps.headReader != null ? { headReader: this.deps.headReader } : {}),
    };
    const result = repoModeGate.enactPublish(
      { branch: req.branch, into: req.into, message, repoCwd: req.repoCwd },
      mode,
      enactDeps,
    );

    return {
      merged: result.merged,
      commitSha: result.commitSha,
      commitMessage: message,
      mode: result.mode,
    };
  }
}
