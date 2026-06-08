import { escalate, type ParentResolver } from '../mail/escalation.js';
import type { MailStore } from '../mail/mail-store.js';
import { openConfigStore, type ConfigStore } from '../config/config-store.js';
import { renderMergeMessage, renderPrMessage, type PrIntent } from '../worktrees/messages.js';
import {
  CoRepoModeGate,
  resolveRepoMode,
  type EnactPublishDeps,
  type EnactPushDeps,
  type GhExec,
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
import { resolveReviewerKind, reviewRequestEnvelope } from './human-review.js';
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
  /**
   * The `gh` seam for PR creation — passed through to `CoRepoModeGate.enactPrMerge`. Injectable so
   * `prMerge` is headless-testable with a fake that records calls + returns a fixture URL, with NO
   * real network activity in `pnpm test` (AC-L5-6). Defaults to production `defaultGhExec`.
   */
  readonly ghExec?: GhExec;
  /**
   * Config store for resolver-kind resolution (AC-L5-5). Injectable so `triggerReview` is
   * headless-testable with a fake config. When absent, the human-review path opens + closes its own
   * config store (mirrors `resolveRepoMode`'s `deps.config ?? openConfigStore()`).
   */
  readonly config?: ConfigStore;
}

/** What {@link CoReviewGate.push} is handed: the reviewed `branch`, the integration `into`, and location. */
export interface ReviewPushRequest {
  readonly branch: string;
  readonly into: string;
  readonly projectId: string;
  readonly repoCwd: string;
  readonly remote?: string;
}

/** The structured result of a gated push. */
export interface ReviewPushResult {
  readonly pushed: boolean;
  readonly remote: string;
  readonly mode: RepoMode;
  /** Present when the PASS carried pre-existing baseline failures (flag — never silent, AC-L5-3). */
  readonly baselineFailures?: readonly string[];
  /** True when a baseline-failure escalation mail was emitted (requires mail + parentResolver seam). */
  readonly escalated?: boolean;
}

/** What {@link CoReviewGate.prMerge} is handed: the reviewed `branch`, `into`, the structured PR intent, and title. */
export interface ReviewPrMergeRequest {
  readonly branch: string;
  readonly into: string;
  readonly title: string;
  /** The structured PR intent — `co` renders the four-section description from this, never the provider (Principle 3). */
  readonly intent: PrIntent;
  readonly projectId: string;
  readonly repoCwd: string;
}

/** The structured result of a gated PR creation. */
export interface ReviewPrMergeResult {
  readonly prUrl: string;
  readonly prDescription: string;
  readonly mode: RepoMode;
  /** Present when the PASS carried pre-existing baseline failures (flag — never silent, AC-L5-3). */
  readonly baselineFailures?: readonly string[];
  /** True when a baseline-failure escalation mail was emitted (requires mail + parentResolver seam). */
  readonly escalated?: boolean;
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

  /**
   * Shared PASS gate + honest-verify + baseline-failure escalation used by push and prMerge. Throws
   * on any gate failure (no verdict, not PASS, regression, missing baseline/finish, PASS-without-
   * marker). On a clean or baseline-only PASS, returns the mode + escalation signal so the caller
   * can surface them in its result (AC-L5-3 — baseline failures are never silent).
   *
   * Note: ReviewScope.pr_merge should be threaded to reviewer dispatch (so reviewers apply the
   * strictest bar for co_push/co_pr_merge calls). That threading is a Phase D/E concern — Phase D
   * wires the production parent-resolver; Phase E wires the reviewer dispatch with scope context.
   */
  private gateOnPass(
    branch: string,
    into: string,
    projectId: string,
    repoCwd: string,
  ): { mode: RepoMode; baselineFailures?: readonly string[]; escalated?: boolean } {
    const resolveMode = this.deps.resolveMode ?? resolveRepoMode;
    const mode = resolveMode(projectId, repoCwd);

    const verdict = this.deps.reviews.getVerdict(into, branch);
    if (!verdict) {
      throw new Error(
        `co: refused — no review verdict is recorded for '${branch}' into '${into}'. ` +
          'A recorded PASS is required (AC-L5-1); run co_review_finalize first.',
      );
    }
    if (verdict.verdict !== 'PASS') {
      throw new Error(
        `co: refused — the recorded verdict for '${branch}' into '${into}' is ` +
          `${verdict.verdict} (${verdict.blockers.length} blocker(s)), not PASS. Address the ` +
          'blockers and record a new PASS (AC-L5-1).',
      );
    }

    const baseline = this.deps.worktrees.getBaseline(branch);
    const finish = this.deps.worktrees.getFinish(branch);
    if (!baseline || !finish) {
      throw new Error(
        `co: refused — a PASS verdict exists for '${branch}' but the ` +
          `${!baseline ? 'baseline' : 'finish'} record is missing. Both are required for ` +
          'honest-verification (AC-L5-3, Principle 9).',
      );
    }
    const verifyOutcome = honestVerify(baseline.tests, finish.tests);
    const classification = classifyPass(verifyOutcome, verdict.verification);
    if (!classification.allow) {
      throw new Error(
        `co: refused — honest-verification rejected the PASS for '${branch}' into ` +
          `'${into}': ${classification.reason}`,
      );
    }

    // Baseline failures: flag + escalate (never silent — AC-L5-3). Mirrors merge() step 6.
    const baselineFailures =
      verifyOutcome.baselineFailures.length > 0
        ? (verifyOutcome.baselineFailures as readonly string[])
        : undefined;
    let escalated = false;
    if (classification.mustEscalate && this.deps.mail && this.deps.parentResolver) {
      const from = this.deps.agentId ?? 'co.review-gate';
      escalate(this.deps.mail, this.deps.parentResolver, {
        from,
        subject: `baseline failure(s) in PASS for '${branch}'`,
        body:
          `The PASS for '${branch}' into '${into}' carries pre-existing baseline ` +
          `failure(s): ${verifyOutcome.baselineFailures.join(', ')}. The publish was allowed ` +
          'but these failures require attention — they pre-existed the branch-off baseline.',
      });
      escalated = true;
    }

    return {
      mode,
      ...(baselineFailures != null ? { baselineFailures } : {}),
      ...(escalated ? { escalated } : {}),
    };
  }

  triggerReview(req: ReviewTriggerRequest): ReviewTriggerResult {
    // Record the review request in the store (both paths do this).
    const rec = this.deps.reviews.recordReviewRequested({
      reviewId: req.reviewId,
      target: req.target,
      branch: req.branch,
      requestedBy: req.requestedBy,
    });

    // Resolve the reviewer kind when scope + projectId are provided (AC-L5-5).
    const scope = req.scope ?? 'worker_merge';
    const projectId = req.projectId;
    if (projectId != null) {
      const config = this.deps.config ?? openConfigStore();
      const ownsConfig = this.deps.config === undefined;
      try {
        const kind = resolveReviewerKind(config, projectId, scope);
        if (kind === 'human') {
          // Human path: send a sticky actionable review_request to @operator. No reviewer placement
          // (placement is agent-only — Phase F; for a human scope there is none, ever — AC-L5-5).
          if (this.deps.mail) {
            const envelope = reviewRequestEnvelope({
              from: req.requestedBy,
              subject: `review requested: '${req.branch}' into '${req.target}'`,
              body:
                `A human review has been requested for '${req.branch}' into '${req.target}' ` +
                `(scope: ${scope}, reviewId: ${req.reviewId}). Reply with a review_response ` +
                `(reviewVerdict: PASS or ISSUES) to re-enter the gate.`,
              idempotencyKey: `review-request:${req.reviewId}`,
            });
            this.deps.mail.send(envelope);
          }
          return {
            reviewId: rec.reviewId,
            target: rec.target,
            branch: rec.branch,
            requestedTs: rec.requestedTs,
          };
        }
        // Agent path: record review.requested (done above); reviewer placement is Phase F.
      } finally {
        if (ownsConfig) config.close();
      }
    }

    // Default: agent path — review.requested recorded above; no mail sent (reviewer placement is Phase F).
    return {
      reviewId: rec.reviewId,
      target: rec.target,
      branch: rec.branch,
      requestedTs: rec.requestedTs,
    };
  }

  merge(req: ReviewMergeRequest): ReviewMergeResult {
    const repoModeGate = this.deps.repoModeGate ?? new CoRepoModeGate();

    // 1) Resolve the repo mode. Contributor publishing (fork→PR) is Phase C — refuse here, loud.
    //    gateOnPass resolves the mode; we check contributor AFTER gating to give a clear pointer.
    const resolveMode = this.deps.resolveMode ?? resolveRepoMode;
    const mode = resolveMode(req.projectId, req.repoCwd);
    if (mode === 'contributor') {
      throw new Error(
        `co_merge: contributor publishing is Phase C (co_push / co_pr_merge) — not available yet. ` +
          `Cannot merge '${req.branch}' into '${req.into}' in contributor mode.`,
      );
    }

    // 2–3) GATE on a recorded PASS + honest-verify.
    //    We run the gate directly here rather than through gateOnPass to preserve the existing
    //    co_merge error messages and the baseline-failure escalation path.
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

  /**
   * Gated push (AC-L5-6): gate on a recorded PASS + honest-verify + escalate on baseline failures
   * (never silent — AC-L5-3), then push the reviewed work to the remote. Owner pushes the
   * integration branch (`into`) to origin; contributor pushes the feature branch (`branch`) to
   * origin (the fork). Offline refuses loud (Principle 9).
   */
  push(req: ReviewPushRequest): ReviewPushResult {
    const repoModeGate = this.deps.repoModeGate ?? new CoRepoModeGate();
    const gateResult = this.gateOnPass(req.branch, req.into, req.projectId, req.repoCwd);

    const enactDeps: EnactPushDeps = {
      ...(this.deps.gitExec != null ? { gitExec: this.deps.gitExec } : {}),
    };
    const result = repoModeGate.enactPush(
      { branch: req.branch, into: req.into, repoCwd: req.repoCwd, remote: req.remote },
      gateResult.mode,
      enactDeps,
    );
    return {
      pushed: result.pushed,
      remote: result.remote,
      mode: result.mode,
      ...(gateResult.baselineFailures != null
        ? { baselineFailures: gateResult.baselineFailures }
        : {}),
      ...(gateResult.escalated ? { escalated: gateResult.escalated } : {}),
    };
  }

  /**
   * Gated PR creation (AC-L5-6): gate on a recorded PASS + honest-verify + escalate on baseline
   * failures (never silent — AC-L5-3), render the PR description from the structured intent via
   * {@link renderPrMessage} (provider-deterministic — Principle 3), then create the PR. Offline
   * refuses loud (Principle 9). Contributor probes host conventions (minimal Phase C probe).
   */
  prMerge(req: ReviewPrMergeRequest): ReviewPrMergeResult {
    const repoModeGate = this.deps.repoModeGate ?? new CoRepoModeGate();
    const gateResult = this.gateOnPass(req.branch, req.into, req.projectId, req.repoCwd);

    // Render the house-style PR description from the structured intent (Principle 3 — co owns the
    // contract; provider voice cannot reach the artifact by construction).
    const prDescription = renderPrMessage(req.intent);

    const result = repoModeGate.enactPrMerge(
      {
        branch: req.branch,
        into: req.into,
        title: req.title,
        description: prDescription,
        repoCwd: req.repoCwd,
      },
      gateResult.mode,
      { ghExec: this.deps.ghExec },
    );
    return {
      prUrl: result.prUrl,
      prDescription,
      mode: result.mode,
      ...(gateResult.baselineFailures != null
        ? { baselineFailures: gateResult.baselineFailures }
        : {}),
      ...(gateResult.escalated ? { escalated: gateResult.escalated } : {}),
    };
  }
}
