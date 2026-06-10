import { z } from 'zod';
import {
  checkPublishIdentities,
  checkSignedOffCommits,
  defaultCommitIdentityReader,
  resolvePersonaAllowlist,
  type CommitIdentityReader,
} from '../../permissions/identity-guard.js';
import { OPERATOR } from '../../mail/events.js';
import { roleParentResolver } from '../../mail/escalation.js';
import { CoReviewGate } from '../../review/merge.js';
import {
  defaultGitReader,
  detectCurrentBranchTarget,
  detectIntegrationTarget,
  resolveRefSha,
} from '../../worktrees/detect-base.js';
import { resolveRepoMode, type RepoMode } from '../../worktrees/repo-mode.js';
import type { WorktreeRecord } from '../../worktrees/events.js';
import type { ToolSpec } from '../registry.js';
import { assertToolCallerRole } from '../caller-auth.js';
import { resolveContributorIdentityBaseSha, tryResolveRemoteBranchSha } from '../publish-base.js';

// Every input field carries a .describe() (Principle 5). The push is GATED on a recorded pr_merge
// PASS for the reviewed branch (no un-gated push path — AC-L5-6). The caller never supplies identity,
// project, or repo — those come from the mount-assembled ToolContext.

const pushInput = z
  .object({
    branch: z
      .string()
      .min(1)
      .describe(
        'The reviewed source branch to push. Must have a recorded pr_merge PASS verdict. In owner mode the ' +
          'integration branch (into) is pushed to origin; in contributor mode this branch is pushed ' +
          'to the fork remote.',
      ),
    into: z
      .string()
      .min(1)
      .optional()
      .describe(
        'The integration target branch. In owner mode this branch (carrying the merge commit) is ' +
          'pushed to the remote. Defaults to the detected base of your worktree.',
      ),
    remote: z.string().optional().describe('Remote to push to. Defaults to origin.'),
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
type PushInput = z.infer<typeof pushInput>;

const pushOutput = z.object({
  pushed: z.boolean().describe('True once the branch was successfully pushed to the remote.'),
  remote: z.string().describe('The remote the push targeted.'),
  mode: z
    .enum(['owner', 'contributor', 'offline'])
    .describe('The repository-relationship mode the push ran in.'),
  baseline_failures: z
    .array(z.string())
    .optional()
    .describe(
      'Pre-existing baseline failures found by honest-verification, including fail-to-fail tests. ' +
        'Present on recorded PASS and audited override paths. The push proceeded but these ' +
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
      'True when a post-push escalation failed to persist; the push still succeeded and is reported.',
    ),
  overridden: z
    .boolean()
    .optional()
    .describe('True when @operator used the audited override path.'),
  override_reason: z
    .string()
    .optional()
    .describe('The audited operator override reason, present when overridden is true.'),
});
type PushOutput = z.infer<typeof pushOutput>;

function publishRefForMode(mode: RepoMode, branch: string, into: string): string {
  return mode === 'owner' ? into : branch;
}

function tryResolveDestinationSha(
  repoCwd: string,
  remote: string,
  ref: string,
): string | undefined {
  return tryResolveRemoteBranchSha(repoCwd, remote, ref);
}

function fallbackPublishBaseSha(
  repoCwd: string,
  mode: RepoMode,
  into: string,
  branch: string,
  worktree: WorktreeRecord,
): string {
  if (mode === 'contributor') {
    return resolveContributorIdentityBaseSha('co_push', repoCwd, into, branch);
  }
  return worktree.baseSha;
}

function assertOwnerBranchIntegrated(repoCwd: string, branch: string, into: string): void {
  const ok = defaultGitReader(repoCwd, ['merge-base', '--is-ancestor', branch, into]);
  if (ok == null) {
    throw new Error(
      `co_push: refused — reviewed branch '${branch}' is not integrated into '${into}'. ` +
        'Owner mode pushes the integration branch, so merge the reviewed branch first.',
    );
  }
}

function assertReviewedRefMatchesFinish(
  repoCwd: string,
  branch: string,
  refHead: string,
  finishCommitSha: string | undefined,
): void {
  if (finishCommitSha == null || refHead === finishCommitSha) return;
  throw new Error(
    `co_push: refused — reviewed commit for '${branch}' is stale. Recorded PASS covers ` +
      `${finishCommitSha}, but '${branch}' now resolves to ${refHead} in '${repoCwd}'. ` +
      'Re-run finish and review before publishing moved work.',
  );
}

function assertOwnerPushOnlyReviewedMerge(
  repoCwd: string,
  into: string,
  destinationHead: string | undefined,
  finishCommitSha: string | undefined,
  reviewedBaseSha: string | undefined,
): void {
  if (finishCommitSha == null) return;
  const parentLine = defaultGitReader(repoCwd, ['rev-list', '--parents', '-n', '1', into]);
  const parents = parentLine?.trim().split(/\s+/u).slice(1) ?? [];
  if (parents.length !== 2) {
    throw new Error(
      `co_push: refused — owner push for '${into}' must publish exactly the reviewed ` +
        `two-parent merge commit. The tip has ${parents.length} parent(s), so an octopus merge, ` +
        'extra unreviewed integration work, or a non-merge commit may be included.',
    );
  }
  const [firstParent, secondParent] = parents;
  const expectedFirstParent = destinationHead ?? reviewedBaseSha;
  if (firstParent !== expectedFirstParent) {
    throw new Error(
      `co_push: refused — owner push for '${into}' must publish the reviewed merge commit ` +
        `directly on top of ${destinationHead == null ? 'the recorded branch-off base' : 'remote'} ` +
        `${expectedFirstParent ?? '<unresolved>'}. The merge first parent is ` +
        `${firstParent ?? '<unresolved>'}, so unreviewed target-only commits may be included.`,
    );
  }
  if (secondParent !== finishCommitSha) {
    throw new Error(
      `co_push: refused — owner push for '${into}' must publish the reviewed merge commit. ` +
        `The tip of '${into}' is not a merge whose reviewed second parent is ${finishCommitSha}; ` +
        'extra unreviewed integration work may have been added after review.',
    );
  }
}

function assertPushIdentities(
  toolName: string,
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
    throw new Error(`${toolName}: blocked — ${reason}:\n${details}`);
  }
}

/**
 * `co_push` (AC-L5-6): the coordinator-or-lead verb that publishes reviewed work to the remote — GATED on
 * a recorded `pr_merge` PASS. It refuses unless `ctx.reviews.getVerdict(into, branch, 'pr_merge')`
 * is a recorded `PASS`, except for the explicit `@operator` audited override path which requires a
 * non-empty reason. Enacts per repo mode: owner pushes the integration branch to origin; contributor
 * pushes the feature branch to the fork; offline refuses loud (Principle 9).
 *
 * All git I/O is behind injected seams — `pnpm test` performs NO real network or push operations.
 * The handler loud-fails if the mount did not inject the review or worktree store (Principle 9).
 */
export const pushTool: ToolSpec<PushInput, PushOutput> = {
  name: 'co_push',
  title: 'Push reviewed work to the remote',
  description:
    'Push the reviewed branch to the remote — only if a pr_merge PASS verdict is recorded for it. ' +
    'Owner mode pushes the integration branch to origin; contributor mode pushes the feature ' +
    'branch to your fork. Offline mode refuses. co gates on a recorded pr_merge PASS; there is no ' +
    'un-gated agent push path. @operator may use an audited override with a non-empty reason.',
  inputSchema: pushInput,
  outputSchema: pushOutput,
  handler: (ctx, input): PushOutput => {
    if (!ctx.reviews) {
      throw new Error('co_push: the mount did not inject a review store (ctx.reviews absent).');
    }
    if (!ctx.worktrees) {
      throw new Error('co_push: the mount did not inject a worktree store (ctx.worktrees absent).');
    }
    if (!ctx.roster) {
      throw new Error('co_push: the mount did not inject a roster store (ctx.roster absent).');
    }
    const operatorOverride = input.operator_override === true;
    if (operatorOverride) {
      if (ctx.agent !== OPERATOR) {
        throw new Error(
          `co_push: operator_override is reserved for ${OPERATOR}; caller '${ctx.agent}' ` +
            'must use the recorded-PASS gate.',
        );
      }
      if (input.reason == null || input.reason.trim().length === 0) {
        throw new Error('co_push: operator_override requires a non-empty reason.');
      }
    } else {
      assertToolCallerRole('co_push', ctx.roster, ctx.agent, ['coordinator', 'lead']);
    }

    const mode = resolveRepoMode(ctx.projectId, ctx.cwd);
    const into =
      input.into ??
      (mode === 'owner' ? detectCurrentBranchTarget(ctx.cwd) : detectIntegrationTarget(ctx.cwd));
    const worktree = ctx.worktrees.getWorktree(input.branch);
    if (worktree == null) {
      throw new Error(
        `co_push: cannot publish branch '${input.branch}' — no worktree record exists for ` +
          'that branch.',
      );
    }
    if (worktree.removed && mode !== 'owner') {
      throw new Error(
        `co_push: cannot publish branch '${input.branch}' in ${mode} mode — no live worktree ` +
          'record exists for that branch.',
      );
    }
    if (!operatorOverride && worktree.parent !== ctx.agent) {
      throw new Error(
        `co_push: branch '${input.branch}' worktree parent is '${worktree.parent}', not ` +
          `'${ctx.agent}'. Only the spawning parent may publish the branch.`,
      );
    }
    const verdict = ctx.reviews.getVerdict(into, input.branch, 'pr_merge');
    if (mode === 'owner' && (operatorOverride || verdict?.verdict === 'PASS')) {
      assertOwnerBranchIntegrated(ctx.cwd, input.branch, into);
    }

    // Identity pre-check (AC-L6a-7): refuse unsigned commits always, and refuse off-persona
    // identities when a persona allowlist is configured. Owner mode publishes `into`; contributor
    // mode publishes `branch`.
    const allowlist = resolvePersonaAllowlist(ctx.projectId);
    const ref = publishRefForMode(mode, input.branch, into);
    const remote = input.remote ?? 'origin';
    const destinationHead = tryResolveDestinationSha(ctx.cwd, remote, ref);
    const fallbackBase =
      mode === 'contributor'
        ? resolveContributorIdentityBaseSha('co_push', ctx.cwd, into, input.branch, remote)
        : fallbackPublishBaseSha(ctx.cwd, mode, into, input.branch, worktree);
    const refHead = resolveRefSha(ctx.cwd, ref);
    if (mode === 'contributor') {
      assertReviewedRefMatchesFinish(
        ctx.cwd,
        input.branch,
        refHead,
        ctx.worktrees.getFinish(input.branch)?.commitSha,
      );
    }
    if (mode === 'owner' && (operatorOverride || verdict?.verdict === 'PASS')) {
      assertOwnerPushOnlyReviewedMerge(
        ctx.cwd,
        into,
        destinationHead,
        ctx.worktrees.getFinish(input.branch)?.commitSha,
        worktree.baseSha,
      );
    }
    const identityBase = mode === 'contributor' ? fallbackBase : (destinationHead ?? fallbackBase);
    const range = `${identityBase}..${refHead}`;
    assertPushIdentities(
      'co_push',
      ctx.cwd,
      range,
      allowlist,
      ctx.commitIdentityReader ?? defaultCommitIdentityReader,
    );

    // Production parent-resolver from the caller's roster parent (Phase D).
    // L7 SEAM NOTE (placement recording): `dispatch`/`config`/`nowMs` are intentionally NOT injected
    // here — `co_push` gates on an already-recorded verdict and calls gate.push(), never triggerReview.
    // triggerReview's placement recording is the L7 conductor seam (AC-L5-11 defers). Wiring dispatch
    // here would be dead code; L7 injects it when wiring the live reviewer dispatch.
    const gate = new CoReviewGate({
      reviews: ctx.reviews,
      worktrees: ctx.worktrees,
      mail: ctx.mail,
      agentId: ctx.agent,
      ...(operatorOverride ? {} : { parentResolver: roleParentResolver(ctx.roster) }),
      resolveMode: () => mode,
    });
    const result = gate.push({
      branch: input.branch,
      into,
      projectId: ctx.projectId,
      repoCwd: ctx.cwd,
      ...(input.remote != null ? { remote: input.remote } : {}),
      ...(operatorOverride ? { operatorOverride: true, reason: input.reason } : {}),
    });
    return {
      pushed: result.pushed,
      remote: result.remote,
      mode: result.mode,
      ...(result.baselineFailures != null
        ? { baseline_failures: [...result.baselineFailures] }
        : {}),
      ...(result.verificationFailures != null
        ? { verification_failures: [...result.verificationFailures] }
        : {}),
      ...(result.escalated != null ? { escalated: result.escalated } : {}),
      ...(result.escalationFailed != null ? { escalation_failed: result.escalationFailed } : {}),
      ...(result.overridden != null ? { overridden: result.overridden } : {}),
      ...(result.overrideReason != null ? { override_reason: result.overrideReason } : {}),
    };
  },
};
