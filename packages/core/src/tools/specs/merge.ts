import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { OPERATOR } from '../../mail/events.js';
import { roleParentResolver } from '../../mail/escalation.js';
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
import {
  defaultGitReader,
  detectCurrentBranchTarget,
  resolveRefSha,
} from '../../worktrees/detect-base.js';
import { resolveRepoMode } from '../../worktrees/repo-mode.js';
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
});
type MergeOutput = z.infer<typeof mergeOutput>;

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
        const existingReq = ctx.reviews.getReviewRequest(into, input.branch);
        const reviewId =
          existingReq != null && verdict == null ? existingReq.reviewId : `rev-${randomUUID()}`;
        triggerGate.triggerReview({
          reviewId,
          target: into,
          branch: input.branch,
          requestedBy: ctx.agent,
          scope: 'worker_merge',
          projectId: ctx.projectId,
          ...(input.spec_ref != null ? { specRef: input.spec_ref } : {}),
        });
        await triggerGate.drainSpawns();
        return {
          merged: false,
          // The merge hasn't happened yet — the review is pending — so there is no commit to report.
          commit_sha: '',
          commit_message: '',
          mode: resolveRepoMode(ctx.projectId, repoCwd),
          review_pending: true,
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
      teardown: {
        teardown: (branch) => void worktrees.removeWorktree(branch, { repoCwd }),
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
