import { escalate, type ParentResolver } from '../mail/escalation.js';
import type { MailStore } from '../mail/mail-store.js';
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
import type { WorktreeStore } from '../worktrees/worktree-store.js';
import { classifyPass, honestVerify } from './honest-verify.js';
import type { ReviewStore } from './review-store.js';

/**
 * Injectable seams for {@link CoReviewGate}. `reviews` + `worktrees` are REQUIRED (the gate uses
 * `ctx.worktrees` to honest-verify the finish run against the branch-off baseline — AC-L5-3 /
 * Principle 7); the rest default to production so the gate is headless-testable with a fake git + a
 * recorded verdict, mirroring the L3 cores.
 */
export interface ReviewGateDeps {
  /** The L5 review store — the merge reads `getVerdict(target, branch)` and the trigger records a request. */
  readonly reviews: ReviewStore;
  /**
   * The L3 worktree store — the gate uses ctx.worktrees to honest-verify the finish run against
   * the branch-off baseline (AC-L5-3 / Principle 7). A recorded PASS without a finish + baseline
   * is refused loud (Principle 9 — never paper over a missing input).
   */
  readonly worktrees: WorktreeStore;
  /** The repo-mode enactment gate (default {@link CoRepoModeGate}); does the actual git merge. */
  readonly repoModeGate?: RepoModeGate;
  /** Resolve the effective repo mode (default {@link resolveRepoMode}); injectable for headless tests. */
  readonly resolveMode?: (projectId: string, repoCwd: string) => RepoMode;
  /** Mutating git seam passed through to the enactment (default {@link import('../worktrees/sling.js').defaultGitExec}). */
  readonly gitExec?: GitExec;
  /** Post-merge HEAD reader passed through to the enactment (default `git rev-parse HEAD`). */
  readonly headReader?: (repoCwd: string) => string;
  /**
   * The mail store for escalating baseline-failure PASSes (injected by the tool; optional for headless
   * tests that do not need escalation). Required alongside {@link parentResolver} for escalation.
   */
  readonly mail?: MailStore;
  /**
   * The parent-resolver seam (AC-L1-6) for escalating baseline-failure PASSes — maps the gate's caller
   * one step up the spawn hierarchy. The production, role-based resolver is Phase D; this seam lets Phase
   * B prove the escalation path headlessly with an injectable double.
   */
  readonly parentResolver?: ParentResolver;
  /**
   * The agent id of the entity triggering the merge — used as the escalation `from` address. Injected
   * by the tool (`ctx.agent`); optional in headless tests (defaults to 'co.review-gate').
   */
  readonly agentId?: string;
}

/**
 * The production L5 review gate (AC-L5-1, AC-L5-3) — the real {@link FinishReviewGate} `co_merge`
 * consumes. It is the single place the merge is GATED: no un-gated merge path exists.
 *
 *   - `merge` refuses unless a `PASS` verdict is RECORDED for the branch on the target (absent or
 *     `ISSUES` ⇒ refuse, loud — Principle 9), honest-verifies the finish against the baseline
 *     (regression ⇒ refuse; PASS-without-marker ⇒ refuse; baseline-failure ⇒ flag + escalate,
 *     never silent-pass — AC-L5-3), renders the house-style merge message via {@link renderMergeMessage}
 *     (`[reviewed: PASS]`), and enacts owner/offline through the repo-mode gate. Contributor publishing
 *     (fork→PR) is refused here as Phase C.
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

    // 3) Honest-verify the finish run against the branch-off baseline (AC-L5-3, Principle 7). A PASS
    //    that hides a regression is refused; a PASS over only pre-existing failures is allowed but
    //    must be flagged + escalated (never silent). Missing baseline/finish = loud fail (Principle 9).
    const baseline = this.deps.worktrees.getBaseline(req.branch);
    const finish = this.deps.worktrees.getFinish(req.branch);
    if (!baseline || !finish) {
      throw new Error(
        `co_merge: refused — a PASS verdict exists for '${req.branch}' but the ` +
          `${!baseline ? 'baseline' : 'finish'} record is missing. Both are required for ` +
          'honest-verification (AC-L5-3, Principle 9 — never paper over a missing input).',
      );
    }
    const verifyOutcome = honestVerify(baseline.tests, finish.tests);
    const classification = classifyPass(verifyOutcome, verdict.verification);
    if (!classification.allow) {
      throw new Error(
        `co_merge: refused — honest-verification rejected the PASS for '${req.branch}' into ` +
          `'${req.into}': ${classification.reason}`,
      );
    }

    // 4) Render the house-style merge message (provider-deterministic — no voice parameter). The
    //    override path ([reviewed: override — <reason>]) is Phase F; this phase always references PASS.
    const message = renderMergeMessage({
      branch: req.branch,
      summary: req.summary,
      reviewVerdict: 'PASS',
      ...(req.body != null ? { body: req.body } : {}),
    });

    // 5) Enact the merge for owner/offline through the repo-mode gate (the only repo write).
    const enactDeps: EnactPublishDeps = {
      ...(this.deps.gitExec != null ? { gitExec: this.deps.gitExec } : {}),
      ...(this.deps.headReader != null ? { headReader: this.deps.headReader } : {}),
    };
    const result = repoModeGate.enactPublish(
      { branch: req.branch, into: req.into, message, repoCwd: req.repoCwd },
      mode,
      enactDeps,
    );

    // 6) If pre-existing baseline failures were present on the PASS, flag + escalate (never silent —
    //    AC-L5-3). The escalation is the durable flag; the merge is allowed to proceed. The production
    //    parent-resolver is Phase D; this seam lets Phase B exercise the escalation path headlessly.
    const baselineFailures =
      verifyOutcome.baselineFailures.length > 0 ? verifyOutcome.baselineFailures : undefined;
    let escalated = false;
    if (classification.mustEscalate && this.deps.mail && this.deps.parentResolver) {
      const from = this.deps.agentId ?? 'co.review-gate';
      escalate(this.deps.mail, this.deps.parentResolver, {
        from,
        subject: `baseline failure(s) in PASS for '${req.branch}'`,
        body:
          `The PASS for '${req.branch}' into '${req.into}' carries pre-existing baseline ` +
          `failure(s): ${verifyOutcome.baselineFailures.join(', ')}. The merge was allowed ` +
          'but these failures require attention — they pre-existed the branch-off baseline.',
      });
      escalated = true;
    }

    return {
      merged: result.merged,
      commitSha: result.commitSha,
      commitMessage: message,
      mode: result.mode,
      ...(baselineFailures != null ? { baselineFailures } : {}),
      ...(escalated ? { escalated } : {}),
    };
  }
}
