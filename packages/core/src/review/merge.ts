import { z } from 'zod';
import { escalate, type ParentResolver } from '../mail/escalation.js';
import type { MailStore } from '../mail/mail-store.js';
import { openConfigStore, type ConfigStore } from '../config/config-store.js';
import {
  defaultProviderAccounts,
  type Placement,
  type ProviderAccount,
} from '../dispatch/balancer.js';
import { runDispatchPolicy } from '../dispatch/cli-render.js';
import type { DispatchStore } from '../dispatch/dispatch-store.js';
import type { PlacementDecided } from '../dispatch/events.js';
import type { DispatchResolution } from '../dispatch/throttle.js';
import type { ReasoningBudget, WorkSize } from '../dispatch/tier.js';
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
import type { ReviewScope } from './ladder.js';
import type { ReviewStore } from './review-store.js';
import { acquireMergeSlot, releaseMergeSlot } from './serialize.js';

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
   * Config store for resolver-kind resolution (AC-L5-5) + the reviewer-profiles scope→role map
   * (AC-L5-11). Injectable so `triggerReview` is headless-testable with a fake config. When absent, the
   * human-review path opens + closes its own config store (mirrors `resolveRepoMode`'s
   * `deps.config ?? openConfigStore()`).
   */
  readonly config?: ConfigStore;
  /**
   * The L4 dispatch store (AC-L5-11). When present, an AGENT review trigger RESOLVES + RECORDS a
   * reviewer placement (`placement.decided`) via {@link import('../dispatch/balancer.js').placeAgentFromStore}.
   * The live reviewer SPAWN stays the one L7 stub ({@link ReviewerSpawnGateStub}) — the gate records the
   * decision, never launches. Optional so existing headless gate tests (no dispatch) are unchanged.
   */
  readonly dispatch?: DispatchStore;
  /**
   * Injected, replay-safe clock (epoch ms) for the reviewer placement's reset-aware scoring (AC-L5-11)
   * — never the wall clock. Defaults to 0 (deterministic) when absent; the tool injects `Date.now()`.
   */
  readonly nowMs?: number;
  /**
   * The provider-account candidates the reviewer placement ranks over (default
   * {@link import('../dispatch/balancer.js').defaultProviderAccounts}). Injectable for headless tests.
   */
  readonly reviewerAccounts?: readonly ProviderAccount[];
  /**
   * The merge-time teardown trigger (AC-L5-7). When present, `merge` tears down the merged branch's
   * sandbox AFTER the verdict/merge is recorded + the slot released — never before (the prototype's
   * `review-finalize` exit-1-after-cwd-delete regression cure). Injected so the gate stays
   * headless-testable (no real dir deletion in `pnpm test`); the tool wires
   * {@link WorktreeStore.removeWorktree}. A teardown failure is surfaced but NEVER masks a recorded merge.
   */
  readonly teardown?: MergeTeardown;
}

/**
 * The merge-time sandbox-teardown seam (AC-L5-7). Fires AFTER a merge lands + the slot is released, so
 * a teardown failure (or a deleted cwd) can never masquerade as a merge failure (the `review-finalize`
 * regression cure). The tool injects an adapter over {@link WorktreeStore.removeWorktree}; tests inject
 * a recorder. Headless by construction — no real dir deletion reaches `pnpm test`.
 */
export interface MergeTeardown {
  /** Tear down the merged `branch`'s sandbox (git worktree remove + dir + a `worktree.removed` record). */
  teardown(branch: string): void;
}

/**
 * The L7 reviewer-SPAWN seam (AC-L5-11). The gate RESOLVES + RECORDS a reviewer placement
 * (`placement.decided`) over injected inputs (pure decision), but LAUNCHING the placed reviewer's live
 * turn is L7. This is a TYPED stub marking that seam — mirroring
 * {@link import('./human-review.js').HumanReviewGateStub} /
 * {@link import('../worktrees/cleanup-gate.js').CleanupGateStub}: it fails loud (Principle 9) rather
 * than being a silent no-op. Nothing in L5 calls it — it exists so the L7 plug-point is a real, typed
 * boundary, and so the gate decision logic stays pure over injected inputs (identical inputs ⇒
 * identical decisions).
 */
export interface ReviewerSpawnGate {
  /** Launch the placed reviewer's live turn. Returns `never`: the live spawn is L7. */
  spawn(role: string, placement: Placement): never;
}

/** The L7 STUB reviewer-spawn gate. `spawn` fails loud until L7 owns the live launch — never a no-op. */
export class ReviewerSpawnGateStub implements ReviewerSpawnGate {
  // L7 PLUG-POINT (live reviewer spawn). The production gate must take the recorded placement.decided
  // and START the reviewer agent's turn on the placed provider/model. Until then it fails loud (P9).
  spawn(): never {
    throw new Error(
      'ReviewerSpawnGate.spawn: launching a placed reviewer’s live turn is not implemented ' +
        '(deferred to L7): take the recorded placement.decided and start the reviewer agent on the ' +
        'placed provider/model. L5 resolves + records the decision; it never launches (AC-L5-11).',
    );
  }
}

/**
 * The config-cascade key for the scope→reviewer-role map (AC-L5-11). A project may override which
 * reviewer role each {@link ReviewScope} dispatches to (e.g. pin `pr_merge` to a stricter sub-role).
 * Read via `resolveEffective`; merged over {@link DEFAULT_REVIEWER_PROFILES} (project wins per scope).
 */
export const REVIEWER_PROFILES_CONFIG_KEY = 'reviewer_profiles' as const;

/**
 * Sensible defaults when `reviewer_profiles` is unset: the base `reviewer` role for worker/phase merges,
 * and the pinned `reviewer:pr` sub-role for the strictest `pr_merge` scope (`reviewer:pr` is Opus-pinned
 * in `dispatch/balancer.ts`; pin lookup falls back sub-role → base role).
 */
export const DEFAULT_REVIEWER_PROFILES: Record<ReviewScope, string> = {
  worker_merge: 'reviewer',
  phase_merge: 'reviewer',
  pr_merge: 'reviewer:pr',
};

/** A reviewer placement is technical work at the documented reasoning baseline (overridable by pins). */
const REVIEWER_WORK_SIZE: WorkSize = 'technical';
const REVIEWER_REASONING_BUDGET: ReasoningBudget = 'standard';

/**
 * Resolve the effective scope→reviewer-role map for a project (AC-L5-11): the
 * {@link REVIEWER_PROFILES_CONFIG_KEY} config value merged OVER {@link DEFAULT_REVIEWER_PROFILES}
 * (project overrides win per scope). A malformed value fails loud (Principle 9). `config` is injectable;
 * the default opens + closes a config store internally (mirrors `resolvePinTable`).
 */
export function resolveReviewerProfiles(
  projectId: string,
  config?: ConfigStore,
): Record<string, string> {
  const cfg = config ?? openConfigStore();
  const ownsConfig = config === undefined;
  try {
    const raw = cfg.resolveEffective(projectId)[REVIEWER_PROFILES_CONFIG_KEY];
    if (raw === undefined) return { ...DEFAULT_REVIEWER_PROFILES };
    let parsed: Record<string, string>;
    try {
      parsed = z.record(z.string().min(1), z.string().min(1)).parse(raw);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`co review: malformed '${REVIEWER_PROFILES_CONFIG_KEY}' config: ${detail}`, {
        cause,
      });
    }
    return { ...DEFAULT_REVIEWER_PROFILES, ...parsed };
  } finally {
    if (ownsConfig) cfg.close();
  }
}

/** The reviewer role a scope dispatches to: the resolved profile entry, else the base `reviewer` role. */
export function reviewerRoleForScope(scope: ReviewScope, profiles: Record<string, string>): string {
  return profiles[scope] ?? DEFAULT_REVIEWER_PROFILES[scope] ?? 'reviewer';
}

/** What {@link CoReviewGate.push} is handed: the reviewed `branch`, the integration `into`, and location. */
export interface ReviewPushRequest {
  readonly branch: string;
  readonly into: string;
  readonly projectId: string;
  readonly repoCwd: string;
  readonly remote?: string;
  /** Audited operator override (AC-L5-6): bypass the PASS gate. Requires a non-empty {@link reason}. */
  readonly operatorOverride?: boolean;
  /** The reason recorded into the `review.override` audit event when {@link operatorOverride} is set. */
  readonly reason?: string;
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
  /** True when the PASS gate was bypassed by an audited operator override (AC-L5-6). */
  readonly overridden?: boolean;
  /** The recorded override reason, present when {@link overridden}. */
  readonly overrideReason?: string;
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
  /** Audited operator override (AC-L5-6): bypass the PASS gate. Requires a non-empty {@link reason}. */
  readonly operatorOverride?: boolean;
  /** The reason recorded into the `review.override` audit event when {@link operatorOverride} is set. */
  readonly reason?: string;
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
  /** True when the PASS gate was bypassed by an audited operator override (AC-L5-6). */
  readonly overridden?: boolean;
  /** The recorded override reason, present when {@link overridden}. */
  readonly overrideReason?: string;
}

/**
 * The shared outcome of the publish gate — either the recorded-PASS + honest-verify gate or the
 * audited operator override (AC-L5-6). `reviewVerdict` is rendered verbatim into `[reviewed: …]`
 * (`'PASS'` or `'override — <reason>'`); the baseline-failure flag/escalation signal is never silent
 * (AC-L5-3); `overridden`/`overrideReason` are set only on the override path.
 */
interface GateOutcome {
  readonly mode: RepoMode;
  readonly reviewVerdict: string;
  readonly baselineFailures?: readonly string[];
  readonly escalated?: boolean;
  readonly overridden?: boolean;
  readonly overrideReason?: string;
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
  ): GateOutcome {
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
      reviewVerdict: 'PASS',
      ...(baselineFailures != null ? { baselineFailures } : {}),
      ...(escalated ? { escalated } : {}),
    };
  }

  /**
   * The audited operator-override path (AC-L5-6) — the explicit, recorded human escape hatch that
   * bypasses the recorded-PASS gate. A missing/blank reason is refused LOUD (Principle 9 — an
   * unexplained override is not an audited override). It records a `review.override` event so the
   * bypass is durably audited, then runs honest-verify FOR THE RECORD ONLY when baseline + finish
   * exist — surfacing + escalating any regression / baseline failure (never silent), but NEVER refusing
   * (the override is the explicit decision to proceed). Returns the mode + the
   * `[reviewed: override — <reason>]` marker + the override/baseline-failure signal.
   */
  private overrideGate(
    branch: string,
    into: string,
    projectId: string,
    repoCwd: string,
    reason: string | undefined,
    verb: string,
  ): GateOutcome {
    if (reason === undefined || reason.trim().length === 0) {
      throw new Error(
        `${verb}: refused — operator_override requires a non-empty reason (AC-L5-6, Principle 9 — ` +
          'an unexplained override is not an audited override).',
      );
    }
    const trimmed = reason.trim();
    const mode = (this.deps.resolveMode ?? resolveRepoMode)(projectId, repoCwd);
    const overriddenBy = this.deps.agentId ?? 'co.review-gate';

    // Record the audited override — the bypass is durably logged, never silent (Principle 9).
    this.deps.reviews.recordOverride({ target: into, branch, reason: trimmed, overriddenBy });

    // Honest-verify still runs FOR THE RECORD when its inputs exist (AC-L5-6): surface + escalate any
    // failure so an overridden merge over a regression / baseline failure is audited — but NEVER refuse.
    let baselineFailures: readonly string[] | undefined;
    let escalated = false;
    const baseline = this.deps.worktrees.getBaseline(branch);
    const finish = this.deps.worktrees.getFinish(branch);
    if (baseline && finish) {
      const outcome = honestVerify(baseline.tests, finish.tests);
      if (outcome.baselineFailures.length > 0) baselineFailures = outcome.baselineFailures;
      const failing = [...outcome.regressions, ...outcome.baselineFailures];
      if (failing.length > 0 && this.deps.mail && this.deps.parentResolver) {
        escalate(this.deps.mail, this.deps.parentResolver, {
          from: overriddenBy,
          subject: `operator override of '${branch}' into '${into}' over verification failure(s)`,
          body:
            `'${branch}' was published into '${into}' via an AUDITED operator override (reason: ` +
            `${trimmed}). honest-verification still found failing test(s): ${failing.join(', ')}. ` +
            'The override proceeded by explicit human decision; these failures are recorded for ' +
            'attention.',
        });
        escalated = true;
      }
    }

    return {
      mode,
      reviewVerdict: `override — ${trimmed}`,
      overridden: true,
      overrideReason: trimmed,
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
    const result: ReviewTriggerResult = {
      reviewId: rec.reviewId,
      target: rec.target,
      branch: rec.branch,
      requestedTs: rec.requestedTs,
    };

    // Resolve the reviewer kind when scope + projectId are provided (AC-L5-5).
    const scope = req.scope ?? 'worker_merge';
    const projectId = req.projectId;
    if (projectId != null) {
      const config = this.deps.config ?? openConfigStore();
      const ownsConfig = this.deps.config === undefined;
      try {
        const kind = resolveReviewerKind(config, projectId, scope);
        if (kind === 'human') {
          // Human path: send a sticky actionable review_request to @operator. The human path is
          // UNREACHABLE without a mail store — fail LOUD rather than silently dropping the request
          // (#135 nit / Principle 9). No reviewer placement (placement is agent-only — AC-L5-5/11).
          if (!this.deps.mail) {
            throw new Error(
              `co review: refused — a human review of '${req.branch}' into '${req.target}' was ` +
                'requested but no mail store is wired. The human path delivers an actionable ' +
                'review_request to @operator; without mail it cannot be requested (Principle 9 — ' +
                'no silent drop).',
            );
          }
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
          return result;
        }
        // Agent path: RESOLVE + RECORD the reviewer placement via the L4 balancer (AC-L5-11). The live
        // reviewer SPAWN is the one L7 stub (ReviewerSpawnGateStub) — we record the decision, never
        // launch. The decision is pure over injected inputs (config pins + dispatch usage + nowMs):
        // identical inputs ⇒ identical placement.decided.
        this.recordReviewerPlacement(req, scope, projectId, config);
      } finally {
        if (ownsConfig) config.close();
      }
    }

    // Default agent path: review.requested recorded above; no mail, no placement when no projectId.
    return result;
  }

  /**
   * Resolve + record the reviewer placement for an AGENT review (AC-L5-11). Reads the scope→role map
   * (`reviewer_profiles`), runs the L4 dispatch policy (which calls the pure `placeAgentFromStore`),
   * and records a `placement.decided` keyed on the reviewer seat. It NEVER launches — the live spawn
   * is the L7 stub. A no-op when no dispatch store is wired (existing headless gate tests are unchanged).
   */
  private recordReviewerPlacement(
    req: ReviewTriggerRequest,
    scope: ReviewScope,
    projectId: string,
    config: ConfigStore,
  ): void {
    if (!this.deps.dispatch) return;
    const role = reviewerRoleForScope(scope, resolveReviewerProfiles(projectId, config));
    const accounts = this.deps.reviewerAccounts ?? defaultProviderAccounts();
    const nowMs = this.deps.nowMs ?? 0;
    const seat = `${role}@${req.reviewId}`; // the reviewer seat this decision is for (L7 owns the real id).
    const resolution = runDispatchPolicy(
      this.deps.dispatch,
      projectId,
      role,
      REVIEWER_WORK_SIZE,
      REVIEWER_REASONING_BUDGET,
      accounts,
      nowMs,
      seat,
    );
    this.deps.dispatch.recordPlacement(seat, toReviewerPlacementDecided(role, resolution));
  }

  merge(req: ReviewMergeRequest): ReviewMergeResult {
    const repoModeGate = this.deps.repoModeGate ?? new CoRepoModeGate();

    // 1) Resolve the repo mode. Contributor publishing (fork→PR) is Phase C — refuse here, loud. The
    //    override bypasses the PASS gate, NOT the contributor limitation (it cannot conjure fork→PR).
    const resolveMode = this.deps.resolveMode ?? resolveRepoMode;
    const mode = resolveMode(req.projectId, req.repoCwd);
    if (mode === 'contributor') {
      throw new Error(
        `co_merge: contributor publishing is Phase C (co_push / co_pr_merge) — not available yet. ` +
          `Cannot merge '${req.branch}' into '${req.into}' in contributor mode.`,
      );
    }

    // 2–3) GATE — the audited operator override (AC-L5-6) OR the recorded-PASS + honest-verify gate.
    //    The non-override path runs inline (not gateOnPass) to keep the co_merge-specific error
    //    messages + the post-enact baseline-failure escalation.
    let gate: GateOutcome;
    let pendingEscalation: { readonly subject: string; readonly body: string } | undefined;
    if (req.operatorOverride) {
      gate = this.overrideGate(
        req.branch,
        req.into,
        req.projectId,
        req.repoCwd,
        req.reason,
        'co_merge',
      );
    } else {
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
      gate = {
        mode,
        reviewVerdict: 'PASS',
        ...(verifyOutcome.baselineFailures.length > 0
          ? { baselineFailures: verifyOutcome.baselineFailures }
          : {}),
      };
      if (classification.mustEscalate) {
        pendingEscalation = {
          subject: `baseline failure(s) in PASS for '${req.branch}'`,
          body:
            `The PASS for '${req.branch}' into '${req.into}' carries pre-existing baseline ` +
            `failure(s): ${verifyOutcome.baselineFailures.join(', ')}. The merge was allowed ` +
            'but these failures require attention — they pre-existed the branch-off baseline.',
        };
      }
    }

    // 4) Render the house-style merge message — `[reviewed: PASS]`, or `[reviewed: override — <reason>]`
    //    for the audited override (renderMergeMessage renders the verdict verbatim — Principle 3).
    const message = renderMergeMessage({
      branch: req.branch,
      summary: req.summary,
      reviewVerdict: gate.reviewVerdict,
      ...(req.body != null ? { body: req.body } : {}),
    });

    // 5) SERIALIZE: acquire the per-target merge slot (one active reviewer/merge per target — AC-L5-7).
    //    A second pending merge into the same target QUEUES (waits) loudly rather than racing.
    const slot = acquireMergeSlot(this.deps.reviews, req.into, req.branch);
    if (!slot.acquired) {
      throw new Error(
        `co_merge: refused — '${slot.active}' is the active reviewer/merge for '${req.into}'. ` +
          'Merges into a target serialize (AC-L5-7) — wait for it to land, then merge against the ' +
          'new (post-landing) base.',
      );
    }

    // 6) Enact the merge for owner/offline through the repo-mode gate (the only repo write). On an
    //    enact failure, RELEASE the slot so a fixed retry can re-acquire it (never deadlock the target).
    const enactDeps: EnactPublishDeps = {
      ...(this.deps.gitExec != null ? { gitExec: this.deps.gitExec } : {}),
      ...(this.deps.headReader != null ? { headReader: this.deps.headReader } : {}),
    };
    let result;
    try {
      result = repoModeGate.enactPublish(
        { branch: req.branch, into: req.into, message, repoCwd: req.repoCwd },
        mode,
        enactDeps,
      );
    } catch (cause) {
      releaseMergeSlot(this.deps.reviews, req.into, req.branch);
      throw cause;
    }

    // 7) ORDERING (the review-finalize regression cure — AC-L5-7): the merge result is RECORDED above
    //    and the slot is RELEASED FIRST; only THEN is the sandbox torn down. A teardown failure (or a
    //    deleted cwd) must never masquerade as a merge failure — callers branch on the recorded result,
    //    never a finalizer exit code.
    releaseMergeSlot(this.deps.reviews, req.into, req.branch);

    // Non-override baseline-failure escalation fires AFTER the merge lands (unchanged ordering).
    let escalated = gate.escalated ?? false;
    if (pendingEscalation && this.deps.mail && this.deps.parentResolver) {
      escalate(this.deps.mail, this.deps.parentResolver, {
        from: this.deps.agentId ?? 'co.review-gate',
        subject: pendingEscalation.subject,
        body: pendingEscalation.body,
      });
      escalated = true;
    }

    // 8) Fire the merge-time teardown LAST. A failure is surfaced (toreDown stays false) but never
    //    thrown — it cannot unwind the already-recorded merge (Principle 9 ordering).
    let toreDown = false;
    if (this.deps.teardown) {
      try {
        this.deps.teardown.teardown(req.branch);
        toreDown = true;
      } catch {
        toreDown = false;
      }
    }

    return {
      merged: result.merged,
      commitSha: result.commitSha,
      commitMessage: message,
      mode: result.mode,
      ...(gate.baselineFailures != null ? { baselineFailures: gate.baselineFailures } : {}),
      ...(escalated ? { escalated } : {}),
      ...(gate.overridden ? { overridden: true } : {}),
      ...(gate.overrideReason != null ? { overrideReason: gate.overrideReason } : {}),
      ...(this.deps.teardown ? { toreDown } : {}),
    };
  }

  /**
   * Gated push (AC-L5-6): gate on a recorded PASS + honest-verify (or the audited operator override),
   * escalate on baseline failures (never silent — AC-L5-3), then push the reviewed work to the remote.
   * Owner pushes the integration branch (`into`) to origin; contributor pushes the feature branch
   * (`branch`) to origin (the fork). Offline refuses loud (Principle 9).
   */
  push(req: ReviewPushRequest): ReviewPushResult {
    const repoModeGate = this.deps.repoModeGate ?? new CoRepoModeGate();
    const gateResult = req.operatorOverride
      ? this.overrideGate(req.branch, req.into, req.projectId, req.repoCwd, req.reason, 'co_push')
      : this.gateOnPass(req.branch, req.into, req.projectId, req.repoCwd);

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
      ...(gateResult.overridden ? { overridden: true } : {}),
      ...(gateResult.overrideReason != null ? { overrideReason: gateResult.overrideReason } : {}),
    };
  }

  /**
   * Gated PR creation (AC-L5-6): gate on a recorded PASS + honest-verify (or the audited operator
   * override), escalate on baseline failures (never silent — AC-L5-3), render the PR description from
   * the structured intent via {@link renderPrMessage} (provider-deterministic — Principle 3), then
   * create the PR. Offline refuses loud (Principle 9). Contributor probes host conventions.
   */
  prMerge(req: ReviewPrMergeRequest): ReviewPrMergeResult {
    const repoModeGate = this.deps.repoModeGate ?? new CoRepoModeGate();
    const gateResult = req.operatorOverride
      ? this.overrideGate(
          req.branch,
          req.into,
          req.projectId,
          req.repoCwd,
          req.reason,
          'co_pr_merge',
        )
      : this.gateOnPass(req.branch, req.into, req.projectId, req.repoCwd);

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
      ...(gateResult.overridden ? { overridden: true } : {}),
      ...(gateResult.overrideReason != null ? { overrideReason: gateResult.overrideReason } : {}),
    };
  }
}

/**
 * Map a resolved {@link DispatchResolution} into a {@link PlacementDecided} payload for a reviewer seat
 * (AC-L5-11). Mirrors the `co_sling` mapping: a `placed` decision carries the concrete provider/model/
 * effort/context; a `waiting` decision carries the maxed/unavailable diagnostics + ETA. The recorded
 * `placement.decided` is the audit of WHERE the reviewer would run — the live launch is the L7 stub.
 */
function toReviewerPlacementDecided(
  role: string,
  resolution: DispatchResolution,
): PlacementDecided {
  return resolution.kind === 'placed'
    ? {
        kind: 'placed',
        role,
        work_size: REVIEWER_WORK_SIZE,
        reasoning_budget: REVIEWER_REASONING_BUDGET,
        provider: resolution.placement.provider,
        account: resolution.placement.account,
        model: resolution.placement.model,
        effort: resolution.placement.effort,
        context: resolution.placement.context,
      }
    : {
        kind: 'waiting',
        role,
        work_size: REVIEWER_WORK_SIZE,
        reasoning_budget: REVIEWER_REASONING_BUDGET,
        ...(resolution.etaResetAt !== undefined ? { eta_reset_at: resolution.etaResetAt } : {}),
        reason: resolution.reason,
        maxed_providers: [...resolution.maxedProviders],
        maxed_accounts: [...resolution.maxedAccounts],
        unavailable_providers: [...resolution.unavailableProviders],
        unavailable_accounts: [...resolution.unavailableAccounts],
      };
}
