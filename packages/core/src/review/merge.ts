import { z } from 'zod';
import { escalate, type ParentResolver } from '../mail/escalation.js';
import { MAIL_CLARIFY_REQUEST, OPERATOR, turnKickoffCorrelationId } from '../mail/events.js';
import type { MailStore } from '../mail/mail-store.js';
import { openConfigStore, type ConfigStore } from '../config/config-store.js';
import { defaultProviderAccounts, type ProviderAccount } from '../dispatch/balancer.js';
import { runDispatchPolicy } from '../dispatch/cli-render.js';
import type { DispatchStore } from '../dispatch/dispatch-store.js';
import type { PlacementDecided, PlacementRecord } from '../dispatch/events.js';
import type { DispatchResolution } from '../dispatch/throttle.js';
import type { ReasoningBudget, WorkSize } from '../dispatch/tier.js';
import { scrubOutwardText } from '../issues/scrub.js';
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
import type { FinishRecord } from '../worktrees/events.js';
import type { GitExec } from '../worktrees/sling.js';
import type { WorktreeStore } from '../worktrees/worktree-store.js';
import type { SpecStore } from '../specs/specs-store.js';
import { findSubRole, parseSubRoleId } from '../roles/sub-roles.js';
import { classifyPass, honestVerify } from './honest-verify.js';
import { resolveReviewerKind, reviewRequestEnvelope } from './human-review.js';
import type { ReviewRequestRecord, ReviewRequested, ReviewVerdictRecord } from './events.js';
import type { ReviewScope } from './ladder.js';
import type { ReviewStore } from './review-store.js';
import { acquireMergeSlot, releaseMergeSlot, type MergeSlotResult } from './serialize.js';
import {
  resolveReviewSpecRef,
  resolveReviewSpecRefFromStore,
  type ReviewSpecRef,
} from './spec-ref.js';

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
  /** Optional spec store used to prove human reviews reference a displayable locked spec. */
  readonly specs?: Pick<SpecStore, 'getSpec'>;
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
   * The agent id of the entity triggering the merge — used as the escalation `from` address and to
   * authorize audited operator overrides. Injected by the tool (`ctx.agent`); optional only for
   * non-override headless tests.
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
  /**
   * The placement-SPAWN gate (P2, AC-S9-2). When present and an agent review trigger records a PLACED
   * reviewer placement, `triggerReview` fires this gate while staying sync; `co_sling` also reuses the
   * same typed seam for slung-child placement launches. Async tool callers can then
   * {@link CoReviewGate.drainSpawns} to surface launch failure before returning pending. Absent for all
   * headless core tests (the default {@link ReviewerSpawnGateStub} is the loud-fail stand-in; `dispatch`
   * must also be wired to reach this).
   */
  readonly reviewerSpawnGate?: ReviewerSpawnGate;
  /**
   * Called when {@link ReviewerSpawnGate.spawn} rejects. When absent a **loud default** surfaces the
   * rejection to stderr (Principle 9 — no silent discard). Async tool callers can additionally await
   * {@link CoReviewGate.drainSpawns} to reject the user-facing command.
   */
  readonly onSpawnError?: (agentId: string, err: unknown) => void;
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
 * The L7 placement-SPAWN seam (AC-L5-11). The review gate RESOLVES + RECORDS a reviewer placement
 * (`placement.decided`) over injected inputs (pure decision), while `co_sling` records a slung-child
 * placement; LAUNCHING either placed agent's live turn is L7. This is a TYPED boundary — mirroring
 * {@link import('./human-review.js').HumanReviewGateStub} /
 * {@link import('../worktrees/cleanup-gate.js').CleanupGateStub}: the stub fails loud (Principle 9)
 * rather than being a silent no-op. The real engine-backed gate lives in `packages/mcp` (P2,
 * AC-S9-2): it takes the recorded PlacementRecord and calls engine.ensureHosted.
 */
export interface ReviewerSpawnGate {
  /**
   * Launch the placed reviewer's live turn. Takes the project id and the stored PlacementRecord for
   * the reviewer seat. The real gate (P2) resolves the worktree → builds identity + spec →
   * engine.ensureHosted. The stub (default for headless paths) fails loud.
   */
  spawn(projectId: string, placement: PlacementRecord): Promise<void>;
  /**
   * Best-effort rollback for a spawn that succeeded before a later durable write failed. Optional so
   * legacy/test gates remain source-compatible; real engine-backed gates should release the pane and
   * end its session.
   */
  release?(projectId: string, agent: string): Promise<void>;
}

/**
 * The STUB placement-spawn gate. `spawn` fails loud until the real P2 gate is wired — never a no-op.
 * Used as the default for headless core paths (no engine dependency). The params are optional so
 * existing headless tests that call spawn() without args continue to compile and assert the throw.
 */
export class ReviewerSpawnGateStub implements ReviewerSpawnGate {
  // P2 PLUG-POINT (live placement spawn). The production gate takes the recorded PlacementRecord
  // and calls engine.ensureHosted. Until wired it fails loud (Principle 9).
  spawn(): never {
    throw new Error(
      "ReviewerSpawnGate.spawn: launching a placed reviewer's live turn is not implemented " +
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

function reviewTriggerResultFromRecord(rec: {
  readonly reviewId: string;
  readonly target: string;
  readonly branch: string;
  readonly requestedTs: number;
}): ReviewTriggerResult {
  return {
    reviewId: rec.reviewId,
    target: rec.target,
    branch: rec.branch,
    requestedTs: rec.requestedTs,
  };
}

function reviewerKickoffBody(
  req: Pick<ReviewTriggerRequest, 'reviewId' | 'target' | 'branch'>,
  scope: ReviewScope,
): string {
  return (
    `Review '${req.reviewId}' is assigned to you. Inspect branch '${req.branch}' for target ` +
    `'${req.target}' under scope '${scope}', then record your verdict with co_review_finalize ` +
    `using review_id '${req.reviewId}', target '${req.target}', branch '${req.branch}', and ` +
    `scope '${scope}'. PASS requires a verification marker; ISSUES requires at least one named ` +
    'blocker. A mailed PASS is not a recorded verdict.'
  );
}

function specRefEquals(
  actual: ReviewSpecRef,
  expected: { readonly kind: ReviewSpecRef['kind']; readonly ref?: string },
): boolean {
  if (actual.kind !== expected.kind) return false;
  return actual.kind !== 'criteria' || actual.ref === expected.ref;
}

function assertHumanReviewHasCriteria(
  reviewerKind: 'agent' | 'human',
  specRef: ReviewSpecRef,
  branch: string,
  target: string,
): void {
  if (reviewerKind !== 'human' || specRef.kind === 'criteria') return;
  throw new Error(
    `co review: refused — human review of '${branch}' into '${target}' requires locked ` +
      'acceptance criteria. Pass spec_ref as `spec:<taskId>#locked` so the Review view can ' +
      'display evidence before PASS or ISSUES.',
  );
}

function reviewerSeat(role: string, reviewId: string): string {
  return `${role}@${reviewId}`;
}

function isReviewerPlacementForReview(agent: string, role: string, reviewId: string): boolean {
  return (
    agent === reviewerSeat(role, reviewId) && (role === 'reviewer' || role.startsWith('reviewer:'))
  );
}

function placementMatchesReview(
  placement: PlacementRecord,
  req: Pick<ReviewTriggerRequest, 'reviewId' | 'target' | 'branch'>,
  scope: ReviewScope,
): boolean {
  return (
    (placement.reviewId == null || placement.reviewId === req.reviewId) &&
    (placement.reviewTarget == null || placement.reviewTarget === req.target) &&
    (placement.reviewBranch == null || placement.reviewBranch === req.branch) &&
    (placement.reviewScope == null || placement.reviewScope === scope)
  );
}

function assertValidReviewerProfileRole(scope: string, role: string): void {
  const trimmed = role.trim();
  if (trimmed !== role || trimmed.length === 0) {
    throw new Error(
      `co review: malformed '${REVIEWER_PROFILES_CONFIG_KEY}' config: scope '${scope}' ` +
        `must map to a non-empty reviewer role without surrounding whitespace.`,
    );
  }
  const parsed = parseSubRoleId(trimmed);
  if (parsed.baseRole !== 'reviewer') {
    throw new Error(
      `co review: malformed '${REVIEWER_PROFILES_CONFIG_KEY}' config: scope '${scope}' ` +
        `maps to '${role}', but reviewer profiles must use the 'reviewer' role.`,
    );
  }
  if (parsed.name != null && findSubRole('reviewer', parsed.name) == null) {
    throw new Error(
      `co review: malformed '${REVIEWER_PROFILES_CONFIG_KEY}' config: unknown reviewer ` +
        `sub-role '${role}' for scope '${scope}'.`,
    );
  }
}

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
    for (const scope of Object.keys(parsed)) {
      if (!(scope in DEFAULT_REVIEWER_PROFILES)) {
        throw new Error(
          `co review: malformed '${REVIEWER_PROFILES_CONFIG_KEY}' config: unknown ` +
            `reviewer_profiles scope '${scope}'. Expected one of: ${Object.keys(
              DEFAULT_REVIEWER_PROFILES,
            ).join(', ')}.`,
        );
      }
    }
    const profiles = { ...DEFAULT_REVIEWER_PROFILES, ...parsed };
    for (const [scope, role] of Object.entries(profiles)) {
      assertValidReviewerProfileRole(scope, role);
    }
    return profiles;
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
  /** Present when honest-verification found pre-existing baseline failures (flag — never silent). */
  readonly baselineFailures?: readonly string[];
  /** Present on operator overrides when honest-verification found any failure, including regressions. */
  readonly verificationFailures?: readonly string[];
  /** True when a baseline-failure escalation mail was emitted (requires mail + parentResolver seam). */
  readonly escalated?: boolean;
  /** True when a post-enactment escalation mail failed to persist; the push still succeeded. */
  readonly escalationFailed?: boolean;
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
  /** Present when honest-verification found pre-existing baseline failures (flag — never silent). */
  readonly baselineFailures?: readonly string[];
  /** Present on operator overrides when honest-verification found any failure, including regressions. */
  readonly verificationFailures?: readonly string[];
  /** True when a baseline-failure escalation mail was emitted (requires mail + parentResolver seam). */
  readonly escalated?: boolean;
  /** True when a post-enactment escalation mail failed to persist; the PR was still created. */
  readonly escalationFailed?: boolean;
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
  readonly verificationFailures?: readonly string[];
  readonly escalated?: boolean;
  readonly overridden?: boolean;
  readonly overrideReason?: string;
  readonly overrideBy?: string;
  readonly pendingEscalation?: {
    readonly from: string;
    readonly subject: string;
    readonly body: string;
    readonly idempotencyKey?: string;
  };
}

function assertFinishNotNewerThanVerdict(
  toolName: string,
  branch: string,
  into: string,
  finish: FinishRecord,
  verdict: ReviewVerdictRecord,
): void {
  if (finish.recordedSeq != null && verdict.recordedSeq != null) {
    if (finish.recordedSeq < verdict.recordedSeq) return;
  } else if (finish.recordedTs < verdict.recordedTs) {
    // Strict `<` to match the seq path: a finish sharing the verdict's exact millisecond is
    // concurrent-or-newer and must be refused, not waved through, on the legacy ts fallback.
    return;
  }
  throw new Error(
    `${toolName}: refused — branch '${branch}' was finished after review '${verdict.reviewId}' ` +
      `for '${into}'. Re-run review on the latest finish before publishing.`,
  );
}

/**
 * The production L5 review gate (AC-L5-1, AC-L5-3) — the real {@link FinishReviewGate} `co_merge`
 * consumes. It is the single place the merge is GATED: no un-gated merge path exists.
 *
 *   - `merge` refuses unless a `PASS` verdict is RECORDED for the branch on the target (absent or
 *     `ISSUES` ⇒ refuse, loud — Principle 9), honest-verifies the finish against the baseline
 *     (regression ⇒ refuse; PASS-without-marker ⇒ refuse; baseline-failure ⇒ flag + escalate,
 *     never silent-pass — AC-L5-3), renders the house-style merge message via {@link renderMergeMessage}
 *     (`[reviewed: PASS]`), and enacts owner/offline through the repo-mode gate. Contributor-mode
 *     local merges are refused here; contributors publish through the gated push/PR path.
 *   - `triggerReview` records a `review.requested` (the request flow's real consumer is Phase E).
 *
 * It writes only program-data + the target repo's own git (the merge commit) — never any orchestration
 * file into the tree (Principle 12).
 */
export class CoReviewGate implements FinishReviewGate {
  private readonly deps: ReviewGateDeps;
  private readonly pendingSpawns: Promise<void>[] = [];

  constructor(deps: ReviewGateDeps) {
    this.deps = deps;
  }

  /** Await live reviewer spawns fired by the trigger path. Sync callers may ignore this. */
  async drainSpawns(): Promise<void> {
    await Promise.all(this.pendingSpawns);
  }

  /**
   * Shared PASS gate + honest-verify + baseline-failure escalation used by push and prMerge. Throws
   * on any gate failure (no verdict, not PASS, regression, missing baseline/finish, PASS-without-
   * marker). On a clean or baseline-only PASS, returns the mode + escalation signal so the caller
   * can surface them in its result (AC-L5-3 — baseline failures are never silent).
   *
   * `requiredScope` is used by remote publish / PR gates to require a verdict recorded under the
   * strictest `pr_merge` bar; local worker/phase merges can keep using the latest unscoped verdict.
   */
  private gateOnPass(
    branch: string,
    into: string,
    projectId: string,
    repoCwd: string,
    requiredScope?: ReviewScope,
  ): GateOutcome {
    const resolveMode = this.deps.resolveMode ?? resolveRepoMode;
    const mode = resolveMode(projectId, repoCwd);

    const verdict = this.deps.reviews.getVerdict(into, branch, requiredScope);
    if (!verdict) {
      throw new Error(
        `co: refused — no review verdict is recorded for '${branch}' into '${into}'. ` +
          `${requiredScope != null ? `A recorded ${requiredScope} ` : 'A recorded '}PASS is ` +
          'required (AC-L5-1); run co_review_finalize first.',
      );
    }
    if (verdict.verdict !== 'PASS') {
      throw new Error(
        `co: refused — the recorded${requiredScope != null ? ` ${requiredScope}` : ''} verdict ` +
          `for '${branch}' into '${into}' is ` +
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
    assertFinishNotNewerThanVerdict('co', branch, into, finish, verdict);
    const verifyOutcome = honestVerify(baseline.tests, finish.tests);
    const classification = classifyPass(verifyOutcome, verdict.verification);
    if (!classification.allow) {
      throw new Error(
        `co: refused — honest-verification rejected the PASS for '${branch}' into ` +
          `'${into}': ${classification.reason}`,
      );
    }

    // Baseline failures: flag + prepare the post-enactment escalation (never silent — AC-L5-3).
    const baselineFailures =
      verifyOutcome.baselineFailures.length > 0
        ? (verifyOutcome.baselineFailures as readonly string[])
        : undefined;
    let pendingEscalation: GateOutcome['pendingEscalation'];
    if (classification.mustEscalate && this.deps.mail && this.deps.parentResolver) {
      const from = this.deps.agentId ?? 'co.review-gate';
      pendingEscalation = {
        from,
        subject: `baseline failure(s) in PASS for '${branch}'`,
        idempotencyKey: `baseline-escalation:${into}:${branch}:${verdict.reviewId}`,
        body:
          `The PASS for '${branch}' into '${into}' carries pre-existing baseline ` +
          `failure(s): ${verifyOutcome.baselineFailures.join(', ')}. The publish was allowed ` +
          'but these failures require attention — they pre-existed the branch-off baseline.',
      };
    }

    return {
      mode,
      reviewVerdict: 'PASS',
      ...(baselineFailures != null ? { baselineFailures } : {}),
      ...(pendingEscalation != null ? { pendingEscalation } : {}),
    };
  }

  /**
   * The audited operator-override path (AC-L5-6) — the explicit, recorded human escape hatch that
   * bypasses the recorded-PASS gate. A missing/blank reason is refused LOUD (Principle 9 — an
   * unexplained override is not an audited override). It prepares the override marker and audit facts;
   * callers record the `review.override` event after serialization succeeds and BEFORE any repo/host
   * side effect, so an override action cannot land without a durable audit. It still runs
   * honest-verify FOR THE RECORD ONLY when baseline + finish exist — preparing an escalation for any
   * regression / baseline failure (never silent), but NEVER refusing (the override is the explicit
   * decision to proceed).
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
    if (this.deps.agentId !== OPERATOR) {
      throw new Error(
        `${verb}: refused — operator_override is reserved for ${OPERATOR}; caller ` +
          `'${this.deps.agentId ?? '<unknown>'}' must use the recorded-PASS gate.`,
      );
    }
    const trimmed = reason.trim();
    const mode = (this.deps.resolveMode ?? resolveRepoMode)(projectId, repoCwd);
    const overriddenBy = this.deps.agentId;

    // Honest-verify still runs FOR THE RECORD when its inputs exist (AC-L5-6): surface + escalate any
    // failure so an overridden merge over a regression / baseline failure is audited — but NEVER refuse.
    let baselineFailures: readonly string[] | undefined;
    let verificationFailures: readonly string[] | undefined;
    let pendingEscalation: GateOutcome['pendingEscalation'];
    const baseline = this.deps.worktrees.getBaseline(branch);
    const finish = this.deps.worktrees.getFinish(branch);
    if (baseline && finish) {
      const outcome = honestVerify(baseline.tests, finish.tests);
      if (outcome.baselineFailures.length > 0) baselineFailures = outcome.baselineFailures;
      const failing = [...outcome.regressions, ...outcome.baselineFailures];
      if (failing.length > 0) verificationFailures = failing;
      if (failing.length > 0 && this.deps.mail && this.deps.parentResolver) {
        pendingEscalation = {
          from: overriddenBy,
          subject: `operator override of '${branch}' into '${into}' over verification failure(s)`,
          idempotencyKey: `override-escalation:${into}:${branch}:${overriddenBy}:${trimmed}`,
          body:
            `'${branch}' was published into '${into}' via an AUDITED operator override (reason: ` +
            `${trimmed}). honest-verification still found failing test(s): ${failing.join(', ')}. ` +
            'The override proceeded by explicit human decision; these failures are recorded for ' +
            'attention.',
        };
      }
    }

    return {
      mode,
      reviewVerdict: `override — ${trimmed}`,
      overridden: true,
      overrideReason: trimmed,
      overrideBy: overriddenBy,
      ...(baselineFailures != null ? { baselineFailures } : {}),
      ...(verificationFailures != null ? { verificationFailures } : {}),
      ...(pendingEscalation != null ? { pendingEscalation } : {}),
    };
  }

  private recordSuccessfulOverride(branch: string, into: string, gate: GateOutcome): void {
    if (!gate.overridden || gate.overrideReason == null || gate.overrideBy == null) return;
    this.deps.reviews.recordOverride({
      target: into,
      branch,
      reason: gate.overrideReason,
      overriddenBy: gate.overrideBy,
      ...(gate.verificationFailures != null
        ? { verificationFailures: [...gate.verificationFailures] }
        : {}),
    });
  }

  private acquirePublishSlot(target: string, branch: string, verb: string): MergeSlotResult {
    const slot = acquireMergeSlot(this.deps.reviews, target, branch);
    if (!slot.acquired) {
      throw new Error(
        `${verb}: refused — '${slot.active}' is the active reviewer/merge for '${target}'. ` +
          'Reviews and publishes into a target serialize (AC-L5-7) — wait for it to resolve, ' +
          'then re-review against the new target base.',
      );
    }
    return slot;
  }

  private releaseOwnSlot(target: string, branch: string): void {
    if (this.deps.reviews.activeSerialized(target) === branch) {
      releaseMergeSlot(this.deps.reviews, target, branch);
    }
  }

  private firePendingEscalation(gate: GateOutcome): {
    readonly escalated: boolean;
    readonly failed: boolean;
  } {
    if (gate.pendingEscalation == null || !this.deps.mail || !this.deps.parentResolver) {
      return { escalated: false, failed: false };
    }
    try {
      escalate(this.deps.mail, this.deps.parentResolver, gate.pendingEscalation);
      return { escalated: true, failed: false };
    } catch {
      return { escalated: false, failed: true };
    }
  }

  private preflightPendingEscalation(gate: GateOutcome): void {
    if (gate.pendingEscalation == null || this.deps.parentResolver == null) return;
    this.deps.parentResolver.parentOf(gate.pendingEscalation.from);
  }

  triggerReview(req: ReviewTriggerRequest): ReviewTriggerResult {
    const scope = req.scope ?? 'worker_merge';
    // Resolve the spec reference (AC-L5-8): criteria ref when provided, else explicit no-spec marker.
    const rawSpecRef = resolveReviewSpecRef(req.specRef);
    const requestSpecRef = (reviewerKind: 'agent' | 'human'): ReviewSpecRef =>
      reviewerKind !== 'human'
        ? rawSpecRef
        : this.deps.specs != null
          ? resolveReviewSpecRefFromStore(this.deps.specs, req.specRef)
          : { kind: 'no-locked-spec' };
    const projectId = req.projectId;
    const resolveKind = (): 'agent' | 'human' => {
      if (projectId == null) return 'agent';
      const config = this.deps.config ?? openConfigStore();
      const ownsConfig = this.deps.config === undefined;
      try {
        return resolveReviewerKind(config, projectId, scope);
      } finally {
        if (ownsConfig) config.close();
      }
    };
    const existing = this.deps.reviews.getReviewRequest(req.target, req.branch);
    if (existing != null && existing.reviewId === req.reviewId) {
      if (existing.scope !== scope) {
        throw new Error(
          `co review: duplicate reviewId '${req.reviewId}' for '${req.branch}' into ` +
            `'${req.target}' conflicts on scope: stored '${existing.scope}', requested '${scope}'.`,
        );
      }
      if (existing.requestedBy !== req.requestedBy) {
        throw new Error(
          `co review: duplicate reviewId '${req.reviewId}' for '${req.branch}' into ` +
            `'${req.target}' conflicts on requestedBy: stored '${existing.requestedBy}', ` +
            `requested '${req.requestedBy}'.`,
        );
      }
      const existingReviewerKind = existing.reviewerKind;
      const specRef = requestSpecRef(existingReviewerKind);
      if (
        !specRefEquals(existing.specRef, {
          kind: specRef.kind,
          ...(specRef.kind === 'criteria' ? { ref: specRef.ref } : {}),
        })
      ) {
        const stored =
          existing.specRef.kind === 'criteria'
            ? `criteria:${existing.specRef.ref}`
            : existing.specRef.kind;
        const incoming = specRef.kind === 'criteria' ? `criteria:${specRef.ref}` : specRef.kind;
        throw new Error(
          `co review: duplicate reviewId '${req.reviewId}' for '${req.branch}' into ` +
            `'${req.target}' conflicts on specRef: stored '${stored}', requested '${incoming}'.`,
        );
      }
      assertHumanReviewHasCriteria(existingReviewerKind, existing.specRef, req.branch, req.target);
      const existingVerdict = this.deps.reviews.getVerdict(req.target, req.branch, existing.scope);
      if (existingVerdict?.reviewId === existing.reviewId) {
        return reviewTriggerResultFromRecord(existing);
      }
      if (projectId != null && existingReviewerKind === 'human') {
        if (!this.deps.mail) {
          throw new Error(
            `co review: refused — a human review of '${req.branch}' into '${req.target}' was ` +
              'requested but no mail store is wired. The human path delivers an actionable ' +
              'review_request to @operator; without mail it cannot be requested (Principle 9 — ' +
              'no silent drop).',
          );
        }
        const requested: ReviewRequested = {
          reviewId: req.reviewId,
          target: req.target,
          branch: req.branch,
          scope,
          reviewerKind: existingReviewerKind,
          requestedBy: req.requestedBy,
          specRefKind: specRef.kind,
          specRefRef: specRef.kind === 'criteria' ? specRef.ref : undefined,
        };
        const envelope = reviewRequestEnvelope({
          from: req.requestedBy,
          subject: `review requested: '${req.branch}' into '${req.target}'`,
          body:
            `A human review has been requested for '${req.branch}' into '${req.target}' ` +
            `(scope: ${scope}, reviewId: ${req.reviewId}). Open the Reviews view to inspect ` +
            `the diff and locked acceptance criteria, then submit PASS or ISSUES to re-enter ` +
            `the gate.`,
          idempotencyKey: `review-request:${req.reviewId}`,
        });
        const rec = this.deps.mail.requestHumanReview(envelope, requested).request;
        return reviewTriggerResultFromRecord(rec);
      }
      if (projectId != null && existingReviewerKind === 'agent') {
        const active = this.deps.reviews.activeSerialized(req.target);
        if (active !== req.branch) {
          throw new Error(
            `co review: refused — existing review request '${existing.reviewId}' for ` +
              `'${req.branch}' into '${req.target}' is stale; active reviewer/merge is ` +
              `'${active ?? '<none>'}'.`,
          );
        }
        const config = this.deps.config ?? openConfigStore();
        const ownsConfig = this.deps.config === undefined;
        try {
          this.recordReviewerPlacement(req, scope, projectId, config);
        } finally {
          if (ownsConfig) config.close();
        }
      }
      return reviewTriggerResultFromRecord(existing);
    }
    if (existing != null) {
      const existingVerdict = this.deps.reviews.getVerdict(req.target, req.branch, existing.scope);
      if (existingVerdict?.reviewId !== existing.reviewId) {
        throw new Error(
          `co review: refused — '${req.branch}' into '${req.target}' already has pending ` +
            `active review request '${existing.reviewId}'. Resolve it before requesting ` +
            `new reviewId '${req.reviewId}'.`,
        );
      }
    }
    // Resolve the reviewer kind before mutating the request row. The human path cannot be requested
    // without mail; failing that precondition must not clear a prior verdict or leave a phantom request.
    const reviewerKind = resolveKind();
    const specRef = requestSpecRef(reviewerKind);
    assertHumanReviewHasCriteria(reviewerKind, specRef, req.branch, req.target);
    const requested: ReviewRequested = {
      reviewId: req.reviewId,
      target: req.target,
      branch: req.branch,
      scope,
      reviewerKind,
      requestedBy: req.requestedBy,
      specRefKind: specRef.kind,
      specRefRef: specRef.kind === 'criteria' ? specRef.ref : undefined,
    };
    if (reviewerKind === 'human' && !this.deps.mail) {
      throw new Error(
        `co review: refused — a human review of '${req.branch}' into '${req.target}' was ` +
          'requested but no mail store is wired. The human path delivers an actionable ' +
          'review_request to @operator; without mail it cannot be requested (Principle 9 — ' +
          'no silent drop).',
      );
    }
    this.deps.reviews.assertReviewIdAvailable(req.reviewId, req.target, req.branch);

    if (projectId != null && reviewerKind === 'human') {
      const envelope = reviewRequestEnvelope({
        from: req.requestedBy,
        subject: `review requested: '${req.branch}' into '${req.target}'`,
        body:
          `A human review has been requested for '${req.branch}' into '${req.target}' ` +
          `(scope: ${scope}, reviewId: ${req.reviewId}). Open the Reviews view to inspect ` +
          `the diff and locked acceptance criteria, then submit PASS or ISSUES to re-enter ` +
          `the gate.`,
        idempotencyKey: `review-request:${req.reviewId}`,
      });
      const rec = this.deps.mail!.requestHumanReview(envelope, requested).request;
      return reviewTriggerResultFromRecord(rec);
    }

    const slot = acquireMergeSlot(this.deps.reviews, req.target, req.branch);
    const acquiredByThisCall = slot.fresh === true;
    if (!slot.acquired) {
      throw new Error(
        `co review: refused — '${slot.active}' is the active reviewer/merge for '${req.target}'. ` +
          'Reviews into a target serialize (AC-L5-7) — wait for it to resolve, then re-review ' +
          'against the new target base.',
      );
    }

    try {
      if (projectId != null && reviewerKind === 'agent') {
        const config = this.deps.config ?? openConfigStore();
        const ownsConfig = this.deps.config === undefined;
        try {
          const recorded = this.recordReviewerPlacement(req, scope, projectId, config, requested);
          if (recorded?.request != null) return reviewTriggerResultFromRecord(recorded.request);
        } finally {
          if (ownsConfig) config.close();
        }
      }

      // Record the review request in the store after all preconditions that can fail before request
      // creation have passed. For human reviews this intentionally happens after mail delivery; for
      // agent reviews it happens after reviewer placement. Either failure cannot clear an existing
      // verdict with a phantom review.requested row.
      const rec = this.deps.reviews.recordReviewRequested(requested);
      const result = reviewTriggerResultFromRecord(rec);

      // Default agent path: review.requested recorded above; no mail, no placement when no projectId.
      return result;
    } catch (cause) {
      if (acquiredByThisCall && this.deps.reviews.activeSerialized(req.target) === req.branch) {
        releaseMergeSlot(this.deps.reviews, req.target, req.branch);
      }
      throw cause;
    }
  }

  /**
   * Resolve + record the reviewer placement for an AGENT review (AC-L5-11). Reads the scope→role map
   * (`reviewer_profiles`), runs the L4 dispatch policy (which calls the pure `placeAgentFromStore`),
   * and records a `placement.decided` keyed on the reviewer seat. When a live spawn gate is wired, a
   * placed reviewer record is also launched (or re-launched from an existing compatible placement after
   * a prior transient launch failure). A no-op when no dispatch store is wired.
   */
  private recordReviewerPlacement(
    req: ReviewTriggerRequest,
    scope: ReviewScope,
    projectId: string,
    config: ConfigStore,
    request?: ReviewRequested,
  ): { readonly request?: ReviewRequestRecord } | undefined {
    if (!this.deps.dispatch) return undefined;
    const existingReviewerPlacements = this.deps.dispatch
      .readPlacements()
      .filter((placement) =>
        isReviewerPlacementForReview(placement.agent, placement.role, req.reviewId),
      );
    const compatibleReviewerPlacements = existingReviewerPlacements.filter((placement) =>
      placementMatchesReview(placement, req, scope),
    );
    const compatiblePlaced = compatibleReviewerPlacements
      .filter((placement) => placement.kind === 'placed')
      .at(-1);
    if (compatiblePlaced != null) {
      if (this.deps.reviewerSpawnGate != null) {
        this.seedReviewerKickoff(compatiblePlaced.agent, req, scope);
        this.fireSpawn(compatiblePlaced.agent, projectId, compatiblePlaced);
      }
      return undefined;
    }
    const existingWaitingPlacement = compatibleReviewerPlacements
      .filter((placement) => placement.kind === 'waiting')
      .at(-1);
    const role =
      existingWaitingPlacement?.role ??
      reviewerRoleForScope(scope, resolveReviewerProfiles(projectId, config));
    const seat = reviewerSeat(role, req.reviewId);
    const seatPlacements = this.deps.dispatch
      .readPlacements(seat)
      .filter((placement) => placementMatchesReview(placement, req, scope));
    const seatPlaced = seatPlacements.filter((placement) => placement.kind === 'placed').at(-1);
    if (seatPlaced != null) {
      if (this.deps.reviewerSpawnGate != null) {
        this.seedReviewerKickoff(seatPlaced.agent, req, scope);
        this.fireSpawn(seatPlaced.agent, projectId, seatPlaced);
      }
      return undefined;
    }
    const accounts = this.deps.reviewerAccounts ?? defaultProviderAccounts();
    const nowMs = this.deps.nowMs ?? 0;
    // The reviewer seat this decision is for (L7 owns the live launch under this deterministic id).
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
    const placement = {
      ...toReviewerPlacementDecided(role, resolution),
      review_id: req.reviewId,
      review_target: req.target,
      review_branch: req.branch,
      review_scope: scope,
    };
    if (
      placement.kind === 'waiting' &&
      compatibleReviewerPlacements.some((existing) => existing.kind === 'waiting')
    ) {
      return undefined;
    }
    if (request != null) {
      const result = this.deps.dispatch.recordPlacementWithReviewRequest(seat, placement, request);
      if (placement.kind === 'placed' && this.deps.reviewerSpawnGate != null) {
        this.seedReviewerKickoff(result.placement.agent, req, scope);
        this.fireSpawn(result.placement.agent, projectId, result.placement);
      }
      return { request: result.request };
    }
    const record = this.deps.dispatch.recordPlacement(seat, placement);
    if (placement.kind === 'placed' && this.deps.reviewerSpawnGate != null) {
      this.seedReviewerKickoff(record.agent, req, scope);
      this.fireSpawn(record.agent, projectId, record);
    }
    return undefined;
  }

  private seedReviewerKickoff(
    agentId: string,
    req: ReviewTriggerRequest,
    scope: ReviewScope,
  ): void {
    if (this.deps.mail == null) return;
    this.deps.mail.send({
      type: MAIL_CLARIFY_REQUEST,
      to: agentId,
      from: req.requestedBy,
      subject: `Review requested: '${req.branch}' into '${req.target}'`,
      body: reviewerKickoffBody(req, scope),
      correlationId: turnKickoffCorrelationId(agentId),
      idempotencyKey: `reviewer-kickoff:${req.reviewId}`,
    });
  }

  private fireSpawn(agentId: string, projectId: string, record: PlacementRecord): void {
    const spawn = this.deps.reviewerSpawnGate!.spawn(projectId, record).catch((err: unknown) => {
      if (this.deps.onSpawnError != null) {
        this.deps.onSpawnError(agentId, err);
      } else {
        // Loud by default (Principle 9): a spawn failure is never silently discarded.
        // Hosts SHOULD inject onSpawnError for structured observability in production.
        console.error(
          `co: reviewer spawn for '${agentId}' failed (no onSpawnError injected):`,
          err,
        );
      }
      throw err;
    });
    this.pendingSpawns.push(spawn);
    void spawn.catch(() => {});
  }

  merge(req: ReviewMergeRequest): ReviewMergeResult {
    const repoModeGate = this.deps.repoModeGate ?? new CoRepoModeGate();

    // 1) Resolve the repo mode. Contributor publishing is fork→PR, so local co_merge refuses loud;
    //    the override bypasses the PASS gate, NOT the mode boundary.
    const resolveMode = this.deps.resolveMode ?? resolveRepoMode;
    const mode = resolveMode(req.projectId, req.repoCwd);
    if (mode === 'contributor') {
      throw new Error(
        `co_merge: contributor mode publishes via the gated co_push / co_pr_merge path. ` +
          `Cannot locally merge '${req.branch}' into '${req.into}' in contributor mode.`,
      );
    }

    // 2–3) GATE — the audited operator override (AC-L5-6) OR the recorded-PASS + honest-verify gate.
    //    The non-override path runs inline (not gateOnPass) to keep the co_merge-specific error
    //    messages + the post-enact baseline-failure escalation.
    let gate: GateOutcome;
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
      assertFinishNotNewerThanVerdict('co_merge', req.branch, req.into, finish, verdict);
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
      if (classification.mustEscalate && this.deps.mail && this.deps.parentResolver) {
        gate = {
          ...gate,
          pendingEscalation: {
            from: this.deps.agentId ?? 'co.review-gate',
            subject: `baseline failure(s) in PASS for '${req.branch}'`,
            idempotencyKey: `baseline-escalation:${req.into}:${req.branch}:${verdict.reviewId}`,
            body:
              `The PASS for '${req.branch}' into '${req.into}' carries pre-existing baseline ` +
              `failure(s): ${verifyOutcome.baselineFailures.join(', ')}. The merge was allowed ` +
              'but these failures require attention — they pre-existed the branch-off baseline.',
          },
        };
      }
    }

    this.preflightPendingEscalation(gate);

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
      this.recordSuccessfulOverride(req.branch, req.into, gate);
      result = repoModeGate.enactPublish(
        { branch: req.branch, into: req.into, message, repoCwd: req.repoCwd },
        mode,
        enactDeps,
      );
    } catch (cause) {
      if (slot.fresh) releaseMergeSlot(this.deps.reviews, req.into, req.branch);
      throw cause;
    }

    // 7) ORDERING (the review-finalize regression cure — AC-L5-7): the merge result is RECORDED above
    //    and the slot is RELEASED FIRST; only THEN is the sandbox torn down. A teardown failure (or a
    //    deleted cwd) must never masquerade as a merge failure — callers branch on the recorded result,
    //    never a finalizer exit code.
    releaseMergeSlot(this.deps.reviews, req.into, req.branch);

    const escalation = this.firePendingEscalation(gate);

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
      ...(gate.verificationFailures != null
        ? { verificationFailures: gate.verificationFailures }
        : {}),
      ...(escalation.escalated ? { escalated: true } : {}),
      ...(escalation.failed ? { escalationFailed: true } : {}),
      ...(gate.overridden ? { overridden: true } : {}),
      ...(gate.overrideReason != null ? { overrideReason: gate.overrideReason } : {}),
      ...(this.deps.teardown ? { toreDown } : {}),
    };
  }

  /**
   * Gated push (AC-L5-6): gate on a recorded PASS + honest-verify (or the audited operator override),
   * escalate on baseline failures (never silent — AC-L5-3), then push the reviewed work to the remote.
   * Owner pushes the integration branch (`into`) to origin and releases the target slot. Contributor
   * pushes the feature branch (`branch`) to origin (the fork) but keeps the target slot held until the
   * paired `co_pr_merge` creates the PR, so the reviewed PASS cannot go stale between the two steps.
   * Offline refuses loud (Principle 9).
   */
  push(req: ReviewPushRequest): ReviewPushResult {
    const repoModeGate = this.deps.repoModeGate ?? new CoRepoModeGate();
    const gateResult = req.operatorOverride
      ? this.overrideGate(req.branch, req.into, req.projectId, req.repoCwd, req.reason, 'co_push')
      : this.gateOnPass(req.branch, req.into, req.projectId, req.repoCwd, 'pr_merge');
    this.preflightPendingEscalation(gateResult);
    const slot = this.acquirePublishSlot(req.into, req.branch, 'co_push');

    const enactDeps: EnactPushDeps = {
      ...(this.deps.gitExec != null ? { gitExec: this.deps.gitExec } : {}),
    };
    let result;
    try {
      this.recordSuccessfulOverride(req.branch, req.into, gateResult);
      result = repoModeGate.enactPush(
        { branch: req.branch, into: req.into, repoCwd: req.repoCwd, remote: req.remote },
        gateResult.mode,
        enactDeps,
      );
    } catch (cause) {
      if (slot.fresh) this.releaseOwnSlot(req.into, req.branch);
      throw cause;
    }
    if (result.mode !== 'contributor') {
      this.releaseOwnSlot(req.into, req.branch);
    }
    const escalation = this.firePendingEscalation(gateResult);
    return {
      pushed: result.pushed,
      remote: result.remote,
      mode: result.mode,
      ...(gateResult.baselineFailures != null
        ? { baselineFailures: gateResult.baselineFailures }
        : {}),
      ...(gateResult.verificationFailures != null
        ? { verificationFailures: gateResult.verificationFailures }
        : {}),
      ...(gateResult.escalated || escalation.escalated ? { escalated: true } : {}),
      ...(escalation.failed ? { escalationFailed: true } : {}),
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
      : this.gateOnPass(req.branch, req.into, req.projectId, req.repoCwd, 'pr_merge');
    this.preflightPendingEscalation(gateResult);
    const slot = this.acquirePublishSlot(req.into, req.branch, 'co_pr_merge');

    // Render the house-style PR description from the structured intent (Principle 3 — co owns the
    // contract; provider voice cannot reach the artifact by construction), then scrub it so the
    // returned operator-approval preview is redacted to match what enactPrMerge posts (#7 §5 #2).
    const prDescription = scrubOutwardText(renderPrMessage(req.intent));

    let result;
    try {
      this.recordSuccessfulOverride(req.branch, req.into, gateResult);
      result = repoModeGate.enactPrMerge(
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
    } catch (cause) {
      if (slot.fresh) this.releaseOwnSlot(req.into, req.branch);
      throw cause;
    }
    this.releaseOwnSlot(req.into, req.branch);
    const escalation = this.firePendingEscalation(gateResult);
    return {
      prUrl: result.prUrl,
      prDescription,
      mode: result.mode,
      ...(gateResult.baselineFailures != null
        ? { baselineFailures: gateResult.baselineFailures }
        : {}),
      ...(gateResult.verificationFailures != null
        ? { verificationFailures: gateResult.verificationFailures }
        : {}),
      ...(gateResult.escalated || escalation.escalated ? { escalated: true } : {}),
      ...(escalation.failed ? { escalationFailed: true } : {}),
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
