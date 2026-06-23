import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { OPERATOR } from '../../mail/events.js';
import { roleParentResolver } from '../../mail/escalation.js';
import type { PlacementRecord } from '../../dispatch/events.js';
import {
  checkMergeCommitIdentity,
  checkPublishIdentities,
  checkSignedOffCommits,
  defaultCommitIdentityReader,
  defaultGitConfigIdentityReader,
  resolvePersonaAllowlist,
  type CommitIdentityReader,
  type GitConfigIdentityReader,
} from '../../permissions/identity-guard.js';
import { CoReviewGate } from '../../review/merge.js';
import { reviewScopeValueSchema } from '../../review/events.js';
import type { ReviewScope } from '../../review/ladder.js';
import {
  defaultGitReader,
  detectCurrentBranchTarget,
  resolveRefSha,
} from '../../worktrees/detect-base.js';
import { probeWorktreeDirty, snapshotDirtyWorktree } from '../../worktrees/branch-state.js';
import { defaultGitExec, type GitExec } from '../../worktrees/sling.js';
import { resolveRepoMode } from '../../worktrees/repo-mode.js';
import { ARCHIVE_TTL_MS } from '../../archive/events.js';
import type { ToolSpec } from '../registry.js';
import { assertToolCallerRole } from '../caller-auth.js';

// Every input field carries a .describe() (Principle 5). The merge INTENT is structured (not a prose
// blob) so `co` — not the provider — renders the house-style merge message from it (AC-L3-3 /
// Principle 3). The caller never supplies its own identity, project, or repo — those come from the
// mount-assembled ToolContext.

const mergeIntentInput = z
  .object({
    summary: z
      .string()
      .min(1)
      .refine((s) => !/[\r\n]/u.test(s), 'summary must be a single line')
      .describe('Imperative one-line summary of what the merged branch delivered.'),
    body: z
      .string()
      .optional()
      .describe('Optional body prose describing the merged work; the stat line is appended to it.'),
  })
  .describe('The structured merge intent co renders into the house-style merge commit message.');

const mergeInput = z
  .object({
    branch: z.string().min(1).describe('The reviewed source branch to merge.'),
    into: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The target branch to merge into. Defaults to the detected base of your worktree (e.g. your ' +
          'integration branch).',
      ),
    intent: mergeIntentInput,
    spec_ref: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Optional locked-spec reference for the review request, e.g. `spec:<taskId>#locked`. ' +
          'When supplied, the in-app Review view can render that spec’s acceptance criteria.',
      ),
    operator_override: z
      .boolean()
      .optional()
      .describe('Operator-only audited override of the PASS gate. Requires `reason`.'),
    reason: z
      .string()
      .optional()
      .describe('Operator-only non-empty reason recorded with `operator_override`.'),
  })
  .strict();
type MergeInput = z.infer<typeof mergeInput>;

const mergeOutput = z.object({
  merged: z.boolean().describe('True once the reviewed branch was merged into the target.'),
  commit_sha: z.string().describe('The full sha of the merge commit.'),
  commit_message: z.string().describe('The house-style merge message co rendered from the intent.'),
  mode: z
    .enum(['owner', 'contributor', 'offline'])
    .describe('The repository-relationship mode the merge ran in.'),
  baseline_failures: z
    .array(z.string())
    .optional()
    .describe(
      'Pre-existing baseline failures found by honest-verification, including fail-to-fail tests. ' +
        'Present on recorded PASS and audited override paths. The merge proceeded but these ' +
        'failures require attention (AC-L5-3).',
    ),
  verification_failures: z
    .array(z.string())
    .optional()
    .describe(
      'Verification failures surfaced on an audited operator override, including regressions and ' +
        'baseline failures. The override proceeded by explicit operator decision.',
    ),
  escalated: z
    .boolean()
    .optional()
    .describe('True when a baseline-failure escalation was emitted to the parent agent.'),
  escalation_failed: z
    .boolean()
    .optional()
    .describe(
      'True when a post-merge escalation failed to persist; the merge still succeeded and is reported.',
    ),
  tore_down: z
    .boolean()
    .optional()
    .describe(
      'True once the merged branch’s sandbox was torn down after the merge was recorded; false when ' +
        'the teardown trigger failed (the merge still succeeded — teardown never masks it, AC-L5-7).',
    ),
  overridden: z
    .boolean()
    .optional()
    .describe('True when @operator used the audited override path.'),
  override_reason: z
    .string()
    .optional()
    .describe('The audited operator override reason, present when overridden is true.'),
  review_pending: z
    .boolean()
    .optional()
    .describe(
      'True when a live reviewer was just triggered (P2 / AC-S10-2) and the merge is pending its ' +
        'review. Re-call co_merge once the reviewer records a PASS verdict.',
    ),
  review_id: z
    .string()
    .optional()
    .describe(
      'Present on a review_pending result (#94): the review_id of the triggered/open review. The ' +
        'reviewer MUST pass this exact id to co_review_finalize to record the missing PASS verdict.',
    ),
  review_target: z
    .string()
    .optional()
    .describe(
      'Present on a review_pending result (#94): the merge target (into) whose recorded PASS verdict ' +
        'is missing. Names exactly which (target, branch) verdict co_merge is waiting on.',
    ),
  review_branch: z
    .string()
    .optional()
    .describe(
      'Present on a review_pending result (#94): the reviewed branch whose recorded PASS verdict is ' +
        'missing.',
    ),
  review_scope: reviewScopeValueSchema
    .optional()
    .describe(
      'Present on a review_pending result (#94): the review scope the verdict will be judged under.',
    ),
  reviewer_kind: z
    .enum(['agent', 'human'])
    .optional()
    .describe(
      'Present on a review_pending result (#94): whether the pending review is routed to an agent ' +
        'reviewer or to the operator Review view.',
    ),
  reviewer_placement: z
    .enum(['placed', 'waiting'])
    .optional()
    .describe(
      'Present on an agent review_pending result (#94): whether the reviewer seat was placed or is ' +
        'waiting for dispatch capacity.',
    ),
  next_step: z
    .string()
    .optional()
    .describe(
      'Present on a review_pending result (#94): a one-line directive. Agent reviews name ' +
        'co_review_finalize with this review_id (PASS requires a verification marker); human ' +
        'reviews name the operator Review view. Re-call co_merge after the PASS is recorded.',
    ),
});
type MergeOutput = z.infer<typeof mergeOutput>;

function reviewPendingNextStep(params: {
  readonly reviewerKind: 'agent' | 'human';
  readonly branch: string;
  readonly into: string;
  readonly reviewId: string;
  readonly scope: ReviewScope;
  readonly reviewerPlacement?: 'placed' | 'waiting';
}): string {
  if (params.reviewerKind === 'human') {
    return (
      `No recorded PASS verdict exists for '${params.branch}' into '${params.into}'. A human ` +
      `review is pending in the operator Review view for review_id '${params.reviewId}' (target ` +
      `'${params.into}', branch '${params.branch}', scope '${params.scope}'). Re-call co_merge ` +
      'after the operator records PASS. A mailed PASS is not a recorded verdict.'
    );
  }
  if (params.reviewerPlacement !== 'placed') {
    return (
      `No recorded PASS verdict exists for '${params.branch}' into '${params.into}'. ` +
      `Reviewer dispatch is waiting for review_id '${params.reviewId}' (target '${params.into}', ` +
      `branch '${params.branch}', scope '${params.scope}'); no reviewer has been launched yet. ` +
      'Re-call co_merge after capacity recovers and the reviewer records PASS. A mailed PASS is ' +
      'not a recorded verdict.'
    );
  }
  return (
    `No recorded PASS verdict exists for '${params.branch}' into '${params.into}'. The reviewer ` +
    `must call co_review_finalize with review_id '${params.reviewId}' (target '${params.into}', ` +
    `branch '${params.branch}', scope '${params.scope}'; a PASS requires a verification marker). ` +
    'Re-call co_merge after the PASS is recorded. A mailed PASS is not a recorded verdict.'
  );
}

function latestReviewerPlacementKind(
  placements: readonly PlacementRecord[],
  params: {
    readonly reviewId: string;
    readonly target: string;
    readonly branch: string;
    readonly scope: ReviewScope;
  },
): 'placed' | 'waiting' | undefined {
  return placements
    .filter(
      (placement) =>
        placement.reviewId === params.reviewId &&
        placement.reviewTarget === params.target &&
        placement.reviewBranch === params.branch &&
        placement.reviewScope === params.scope,
    )
    .at(-1)?.kind;
}

// #170: an outstanding review is RESUMABLE when an actual reviewer seat keyed `reviewer*@${reviewId}`
// is present in dispatch (kind 'placed' OR 'waiting'). The reviewer was pinned at spawn as
// `reviewer@rev-OLD` and will finalize against that id; minting a fresh rev-NEW here would orphan its
// seat (the ReviewProjector upsert NULLs the verdict for the (target,branch) row and re-keys it to
// rev-NEW, so the reviewer's finalize against rev-OLD throws). Gate reuse on a present placement so we
// never resume a review that was never actually launched.
function hasResumableReviewerPlacement(
  placements: readonly PlacementRecord[],
  reviewId: string,
): boolean {
  return placements.some(
    (placement) =>
      placement.agent === `${placement.role}@${reviewId}` &&
      (placement.role === 'reviewer' || placement.role.startsWith('reviewer:')) &&
      (placement.kind === 'placed' || placement.kind === 'waiting'),
  );
}

function assertMergeIdentities(
  repoCwd: string,
  range: string,
  allowlist: readonly string[],
  reader: CommitIdentityReader,
): void {
  const commits = reader.read(repoCwd, range);
  const violations =
    allowlist.length > 0
      ? checkPublishIdentities(commits, allowlist)
      : checkSignedOffCommits(commits);
  if (violations.length > 0) {
    const details = violations
      .map((v) => `  ${v.sha.slice(0, 12)} [${v.field}] ${v.identity}`)
      .join('\n');
    const reason =
      allowlist.length > 0
        ? 'commits contain identities outside the persona allowlist'
        : 'commits violate the DCO Signed-off-by requirement';
    throw new Error(`co_merge: blocked — ${reason}:\n${details}`);
  }
}

function assertMergeCommitIdentity(
  repoCwd: string,
  allowlist: readonly string[],
  reader: GitConfigIdentityReader,
): void {
  const identity = reader.read(repoCwd);
  const violations = checkMergeCommitIdentity(identity, allowlist);
  if (violations.length > 0) {
    const details = violations.map((v) => `  ${v.sha} [${v.field}] ${v.identity}`).join('\n');
    const reason =
      allowlist.length > 0
        ? 'merge commit identity is outside the persona allowlist'
        : 'merge commit identity violates the DCO Signed-off-by requirement';
    throw new Error(`co_merge: blocked — ${reason}:\n${details}`);
  }
}

function assertReviewedRefMatchesFinish(
  repoCwd: string,
  branch: string,
  branchHead: string,
  finishCommitSha: string | undefined,
): void {
  if (finishCommitSha == null || branchHead === finishCommitSha) return;
  throw new Error(
    `co_merge: refused — reviewed commit for '${branch}' is stale. Recorded PASS covers ` +
      `${finishCommitSha}, but '${branch}' now resolves to ${branchHead} in '${repoCwd}'. ` +
      'Re-run finish and review before publishing moved work.',
  );
}

function resolveMergeBaseSha(repoCwd: string, into: string, branch: string): string {
  const sha = defaultGitReader(repoCwd, ['merge-base', into, branch]);
  if (sha == null || sha.length === 0) {
    throw new Error(
      `co_merge: cannot inspect commit identities — cannot resolve merge-base for ` +
        `'${branch}' into '${into}'.`,
    );
  }
  return sha;
}

function archiveBranchForMergeTeardown(branch: string, snapshotSha: string): string {
  const safeBranch =
    branch
      .replace(/[^A-Za-z0-9._-]+/gu, '-')
      .replace(/-+/gu, '-')
      .replace(/^-|-$/gu, '') || 'branch';
  return `co/archive-${safeBranch}-${snapshotSha.slice(0, 12)}`;
}

function snapshotMergeTeardownResidue(
  repoCwd: string,
  sandboxPath: string,
  branch: string,
  reviewedHead: string,
  gitExec: GitExec = defaultGitExec,
): { readonly snapshotSha: string; readonly archiveBranch: string } {
  const snapshotSha = snapshotDirtyWorktree(
    sandboxPath,
    'co: merge-time teardown snapshot before remove',
    gitExec,
  );
  if (snapshotSha.length === 0) {
    throw new Error(
      `co_merge: dirty teardown snapshot for '${branch}' did not return a commit sha.`,
    );
  }
  // Reset the REVIEWED branch back to its PASSed head before returning (the snapshot must not move the
  // source branch). The archive ref is created by the caller AFTER it appends the archive record, so a
  // failure between snapshot and record never leaves a record-less ref that the reaper cannot purge.
  const archiveBranch = archiveBranchForMergeTeardown(branch, snapshotSha);
  gitExec(repoCwd, ['update-ref', `refs/heads/${branch}`, reviewedHead]);
  return { snapshotSha, archiveBranch };
}

/**
 * `co_merge` (AC-L5-1): the coordinator-or-lead verb that integrates a reviewed branch — GATED on a recorded
 * PASS. It refuses unless `ctx.reviews.getVerdict(target, branch)` is a recorded `PASS` (absent or
 * `ISSUES` ⇒ refuse, loud), except for the explicit `@operator` audited override path which requires
 * a non-empty reason. It renders the house-style merge message (`[reviewed: PASS]` or
 * `[reviewed: override — <reason>]`) and enacts the merge for `owner` + `offline` modes (a local
 * `--no-ff` merge). `contributor` local merge is refused; contributors publish through the gated
 * co_push / co_pr_merge path.
 *
 * The handler loud-fails if the mount did not inject the review or worktree store (Principle 9 — a tool
 * never opens its own store). It delegates to {@link CoReviewGate} — the single gated merge core — so
 * the gate logic is shared + headless-testable. Writes only program-data + the target repo's own git
 * (the merge commit) — never an orchestration file into the tree (Principle 12).
 */
export const mergeTool: ToolSpec<MergeInput, MergeOutput> = {
  name: 'co_merge',
  title: 'Merge a reviewed branch',
  description:
    'Integrate a reviewed branch into your target branch — only if a PASS verdict is recorded for it. ' +
    'co renders the house-style merge message from your intent and merges in owner/offline mode. It ' +
    'refuses without a recorded PASS; contributor mode publishes through the gated co_push / ' +
    'co_pr_merge path. @operator may use an audited override with a non-empty reason.',
  inputSchema: mergeInput,
  outputSchema: mergeOutput,
  handler: async (ctx, input): Promise<MergeOutput> => {
    if (!ctx.reviews) {
      throw new Error('co_merge: the mount did not inject a review store (ctx.reviews absent).');
    }
    if (!ctx.worktrees) {
      throw new Error(
        'co_merge: the mount did not inject a worktree store (ctx.worktrees absent).',
      );
    }
    if (!ctx.roster) {
      throw new Error('co_merge: the mount did not inject a roster store (ctx.roster absent).');
    }
    const operatorOverride = input.operator_override === true;
    if (operatorOverride) {
      if (ctx.agent !== OPERATOR) {
        throw new Error(
          `co_merge: operator_override is reserved for ${OPERATOR}; caller '${ctx.agent}' ` +
            'must use the recorded-PASS gate.',
        );
      }
      if (input.reason == null || input.reason.trim().length === 0) {
        throw new Error('co_merge: operator_override requires a non-empty reason.');
      }
    } else {
      assertToolCallerRole('co_merge', ctx.roster, ctx.agent, ['coordinator', 'lead']);
    }
    // Capture the (now-present) worktree store + repo cwd for the teardown closure; the guards above
    // narrow them, but a nested closure does not inherit that narrowing.
    const worktrees = ctx.worktrees;
    const repoCwd = ctx.cwd;
    // Default the target to the detected base of the lead's worktree (its integration branch), the
    // same auto-detection co_sling uses — never a hard-coded master (AC-L3-1).
    const into = input.into ?? detectCurrentBranchTarget(repoCwd);
    const worktree = worktrees.getWorktree(input.branch);
    if (worktree == null || worktree.removed) {
      throw new Error(
        `co_merge: cannot merge branch '${input.branch}' — no live worktree record exists for ` +
          'that branch.',
      );
    }
    if (!operatorOverride && worktree.parent !== ctx.agent) {
      throw new Error(
        `co_merge: branch '${input.branch}' worktree parent is '${worktree.parent}', not ` +
          `'${ctx.agent}'. Only the spawning parent may merge the branch.`,
      );
    }

    if (resolveRepoMode(ctx.projectId, repoCwd) === 'contributor') {
      throw new Error(
        `co_merge: contributor mode publishes via the gated co_push / co_pr_merge path. ` +
          `Cannot locally merge '${input.branch}' into '${into}' in contributor mode.`,
      );
    }

    // P2 / AC-S10-2 — live daemon trigger path: when the engine-backed spawn gate is wired and
    // no PASS verdict is recorded yet, trigger the review (fire the spawn) and return pending.
    // The identity pre-check below is skipped on this path (we are not merging; the reviewer will
    // verify the branch before any merge lands). The headless path (no reviewerSpawnGate) and the
    // re-call after a recorded PASS both fall through to the merge path below — byte-identical.
    // Guard: the spawn gate must not fire on the operator-override path — the operator bypasses
    // the gate entirely; firing spawn here would start an unwanted review for an already-decided merge.
    if (ctx.reviewerSpawnGate != null && !operatorOverride) {
      const verdict = ctx.reviews.getVerdict(into, input.branch);
      if (verdict?.verdict !== 'PASS') {
        const triggerGate = new CoReviewGate({
          reviews: ctx.reviews,
          worktrees,
          ...(ctx.specs != null ? { specs: ctx.specs } : {}),
          mail: ctx.mail,
          agentId: ctx.agent,
          parentResolver: roleParentResolver(ctx.roster),
          ...(ctx.dispatch != null ? { dispatch: ctx.dispatch, nowMs: Date.now() } : {}),
          reviewerSpawnGate: ctx.reviewerSpawnGate,
        });
        // #170: RESUME an outstanding (target,branch) review by its existing review_id whenever a
        // reviewer seat keyed `reviewer*@${existingReq.reviewId}` is actually present in dispatch
        // (placed OR waiting) and the prior verdict is not PASS. Only mint a fresh review_id when
        // there is genuinely no resumable outstanding review (no existing request, or the prior
        // review closed/PASS). The `verdict?.verdict !== 'PASS'` guard above already prevents reuse
        // after a merge; this gates reuse on an ACTUAL present placement so a stale request row whose
        // reviewer never launched does not pin a dead review_id.
        const existingReq = ctx.reviews.getReviewRequest(into, input.branch);
        // We are already inside the `verdict?.verdict !== 'PASS'` guard above, so the prior verdict
        // (if any) is ISSUES or absent — never PASS — and an outstanding review is genuinely resumable.
        const canResumeExisting =
          existingReq != null &&
          ctx.dispatch != null &&
          hasResumableReviewerPlacement(ctx.dispatch.readPlacements(), existingReq.reviewId);
        const reviewId = canResumeExisting ? existingReq.reviewId : `rev-${randomUUID()}`;
        const scope: ReviewScope = 'worker_merge';
        const trigger = triggerGate.triggerReview({
          reviewId,
          target: into,
          branch: input.branch,
          requestedBy: ctx.agent,
          scope,
          projectId: ctx.projectId,
          ...(input.spec_ref != null ? { specRef: input.spec_ref } : {}),
        });
        await triggerGate.drainSpawns();
        // #94: NAME exactly which (target, branch) verdict is missing, the review_id the reviewer
        // must finalize against, and the scope — plus a one-line directive. Without these the
        // coordinator/reviewer has no way to learn which review_id to record, so the merge stalls.
        // Use the review_id the gate actually recorded (an existing open request keeps its id).
        const recordedReviewId = trigger.reviewId;
        const recordedReq = ctx.reviews.getReviewRequest(into, input.branch);
        const reviewerKind = recordedReq?.reviewerKind ?? 'agent';
        const reviewerPlacement =
          reviewerKind === 'agent' && ctx.dispatch != null
            ? latestReviewerPlacementKind(ctx.dispatch.readPlacements(), {
                reviewId: recordedReviewId,
                target: into,
                branch: input.branch,
                scope,
              })
            : undefined;
        return {
          merged: false,
          // The merge hasn't happened yet — the review is pending — so there is no commit to report.
          commit_sha: '',
          commit_message: '',
          mode: resolveRepoMode(ctx.projectId, repoCwd),
          review_pending: true,
          review_id: recordedReviewId,
          review_target: into,
          review_branch: input.branch,
          review_scope: scope,
          reviewer_kind: reviewerKind,
          ...(reviewerPlacement != null ? { reviewer_placement: reviewerPlacement } : {}),
          next_step: reviewPendingNextStep({
            reviewerKind,
            branch: input.branch,
            into,
            reviewId: recordedReviewId,
            scope,
            ...(reviewerPlacement != null ? { reviewerPlacement } : {}),
          }),
        };
      }
    }

    // Identity pre-check (AC-L6a-7): local merges publish the reviewed branch into `into`, so they
    // must enforce the same DCO/persona floor as co_push/co_pr_merge before any git side effect.
    const allowlist = resolvePersonaAllowlist(ctx.projectId);
    const branchHead = resolveRefSha(repoCwd, input.branch);
    assertReviewedRefMatchesFinish(
      repoCwd,
      input.branch,
      branchHead,
      ctx.worktrees.getFinish(input.branch)?.commitSha,
    );
    const mergeBase = resolveMergeBaseSha(repoCwd, into, input.branch);
    assertMergeIdentities(
      repoCwd,
      `${mergeBase}..${branchHead}`,
      allowlist,
      ctx.commitIdentityReader ?? defaultCommitIdentityReader,
    );
    assertMergeCommitIdentity(
      repoCwd,
      allowlist,
      ctx.gitConfigIdentityReader ?? defaultGitConfigIdentityReader,
    );

    // Build the production parent-resolver from the caller's roster parent
    // (AC-L5-4 / Phase D): baseline-failure escalations go one level above the caller.
    const gate = new CoReviewGate({
      reviews: ctx.reviews,
      worktrees,
      mail: ctx.mail,
      agentId: ctx.agent,
      ...(operatorOverride ? {} : { parentResolver: roleParentResolver(ctx.roster) }),
      // Merge-time teardown trigger (AC-L5-7): the merge gate tears the merged branch's sandbox down
      // AFTER the merge is recorded + the slot released — never before (the review-finalize cure).
      // #76: the just-merged sandbox can still hold uncommitted/untracked working files (handoff docs).
      // A plain `git worktree remove` (no --force) is REFUSED by git on a dirty tree.
      // Preserve that residue without moving the REVIEWED source branch: snapshot in the sandbox, reset
      // the reviewed branch back to its PASSed head, record the archive (record FIRST so a failure never
      // leaks a record-less ref), create a separate archive branch pointing at the snapshot, then
      // force-remove the dirty sandbox. Owner `co_push` still validates the original branch against the
      // merge commit, while the residue remains restoreable.
      // The dirty PROBE is defensive: if the sandbox dir is already gone, fall through to the plain
      // remove, which tolerates an absent dir idempotently.
      teardown: {
        teardown: (branch): void => {
          const wt = worktrees.getWorktree(branch);
          if (wt != null && !wt.removed && probeWorktreeDirty(wt.path)) {
            if (ctx.archive == null) {
              throw new Error(
                'co_merge: the mount did not inject an archive store (ctx.archive absent).',
              );
            }
            const { snapshotSha, archiveBranch } = snapshotMergeTeardownResidue(
              repoCwd,
              wt.path,
              branch,
              branchHead,
            );
            // Append the archive RECORD before creating the archive ref: the reaper purges by record
            // (it tolerates a missing branch), so a record-without-ref self-heals while a ref-without-
            // record would leak forever — pin the ordering record-first (Principle 9 — no invisible refs).
            const nowMs = ctx.nowMs ?? Date.now();
            ctx.archive.appendRecord({
              id: archiveBranch,
              name: `${branch} teardown residue`,
              branch: archiveBranch,
              baseRef: into,
              deletedAt: nowMs,
              expiresAt: nowMs + ARCHIVE_TTL_MS,
            });
            defaultGitExec(repoCwd, ['update-ref', `refs/heads/${archiveBranch}`, snapshotSha]);
            worktrees.removeWorktree(branch, { repoCwd, force: true });
            return;
          }
          worktrees.removeWorktree(branch, { repoCwd });
        },
      },
    });
    const result = gate.merge({
      branch: input.branch,
      into,
      summary: input.intent.summary,
      projectId: ctx.projectId,
      repoCwd,
      ...(input.intent.body != null ? { body: input.intent.body } : {}),
      ...(operatorOverride ? { operatorOverride: true, reason: input.reason } : {}),
    });
    return {
      merged: result.merged,
      commit_sha: result.commitSha,
      commit_message: result.commitMessage,
      mode: result.mode,
      ...(result.baselineFailures != null
        ? { baseline_failures: [...result.baselineFailures] }
        : {}),
      ...(result.verificationFailures != null
        ? { verification_failures: [...result.verificationFailures] }
        : {}),
      ...(result.escalated != null ? { escalated: result.escalated } : {}),
      ...(result.escalationFailed != null ? { escalation_failed: result.escalationFailed } : {}),
      ...(result.toreDown != null ? { tore_down: result.toreDown } : {}),
      ...(result.overridden != null ? { overridden: result.overridden } : {}),
      ...(result.overrideReason != null ? { override_reason: result.overrideReason } : {}),
    };
  },
};
