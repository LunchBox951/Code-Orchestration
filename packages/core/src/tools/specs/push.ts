import { z } from 'zod';
import { CoReviewGate } from '../../review/merge.js';
import { detectBaseRef } from '../../worktrees/detect-base.js';
import type { ToolSpec } from '../registry.js';

// Every input field carries a .describe() (Principle 5). The push is GATED on a recorded pr_merge
// PASS for the reviewed branch (no un-gated push path — AC-L5-6). The caller never supplies identity,
// project, or repo — those come from the mount-assembled ToolContext.

const pushInput = z.object({
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
    .describe(
      'Audited operator escape hatch (AC-L5-6): bypass the recorded-PASS gate. REQUIRES a non-empty ' +
        'reason — it records a review.override event. An override without a reason is refused.',
    ),
  reason: z
    .string()
    .optional()
    .describe(
      'The reason for the operator override — REQUIRED (non-empty) when operator_override is set; ' +
        'recorded in the audit event.',
    ),
});
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
      'Pre-existing baseline failures the PASS carried — present when honest-verification found ' +
        'fail→fail tests. The push proceeded but these failures require attention (AC-L5-3).',
    ),
  escalated: z
    .boolean()
    .optional()
    .describe('True when a baseline-failure escalation was emitted to the parent agent.'),
  overridden: z
    .boolean()
    .optional()
    .describe('True when the PASS gate was bypassed by an audited operator override (AC-L5-6).'),
  override_reason: z
    .string()
    .optional()
    .describe('The recorded override reason, present when overridden.'),
});
type PushOutput = z.infer<typeof pushOutput>;

/**
 * `co_push` (AC-L5-6): the lead-facing verb that publishes reviewed work to the remote — GATED on
 * a recorded `pr_merge` PASS. It refuses unless `ctx.reviews.getVerdict(into, branch, 'pr_merge')`
 * is a recorded `PASS` (there is NO un-gated push path). Enacts per repo mode: owner pushes the
 * integration branch to origin; contributor pushes the feature branch to the fork; offline refuses
 * loud (Principle 9).
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
    'un-gated push path.',
  inputSchema: pushInput,
  outputSchema: pushOutput,
  handler: (ctx, input): PushOutput => {
    if (!ctx.reviews) {
      throw new Error('co_push: the mount did not inject a review store (ctx.reviews absent).');
    }
    if (!ctx.worktrees) {
      throw new Error('co_push: the mount did not inject a worktree store (ctx.worktrees absent).');
    }
    const into = input.into ?? detectBaseRef(ctx.cwd);
    // Production parent-resolver from the worktree-recorded spawning parent (Phase D).
    const parentAgent = ctx.worktrees.getWorktree(input.branch)?.parent;
    // L7 SEAM NOTE (placement recording): `dispatch`/`config`/`nowMs` are intentionally NOT injected
    // here — `co_push` gates on an already-recorded verdict and calls gate.push(), never triggerReview.
    // triggerReview's placement recording is the L7 conductor seam (AC-L5-11 defers). Wiring dispatch
    // here would be dead code; L7 injects it when wiring the live reviewer dispatch.
    const gate = new CoReviewGate({
      reviews: ctx.reviews,
      worktrees: ctx.worktrees,
      mail: ctx.mail,
      agentId: ctx.agent,
      ...(parentAgent != null ? { parentResolver: { parentOf: () => parentAgent } } : {}),
    });
    const result = gate.push({
      branch: input.branch,
      into,
      projectId: ctx.projectId,
      repoCwd: ctx.cwd,
      ...(input.remote != null ? { remote: input.remote } : {}),
      ...(input.operator_override != null ? { operatorOverride: input.operator_override } : {}),
      ...(input.reason != null ? { reason: input.reason } : {}),
    });
    return {
      pushed: result.pushed,
      remote: result.remote,
      mode: result.mode,
      ...(result.baselineFailures != null
        ? { baseline_failures: [...result.baselineFailures] }
        : {}),
      ...(result.escalated != null ? { escalated: result.escalated } : {}),
      ...(result.overridden != null ? { overridden: result.overridden } : {}),
      ...(result.overrideReason != null ? { override_reason: result.overrideReason } : {}),
    };
  },
};
