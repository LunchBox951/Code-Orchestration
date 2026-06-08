import { z } from 'zod';
import { CoReviewGate } from '../../review/merge.js';
import { detectBaseRef } from '../../worktrees/detect-base.js';
import type { ToolSpec } from '../registry.js';

// Every input field carries a .describe() (Principle 5). The push is GATED on a recorded PASS for
// the reviewed branch (no un-gated push path — AC-L5-6). The caller never supplies identity, project,
// or repo — those come from the mount-assembled ToolContext.

const pushInput = z.object({
  branch: z
    .string()
    .min(1)
    .describe(
      'The reviewed source branch to push. Must have a recorded PASS verdict. In owner mode the ' +
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
});
type PushInput = z.infer<typeof pushInput>;

const pushOutput = z.object({
  pushed: z.boolean().describe('True once the branch was successfully pushed to the remote.'),
  remote: z.string().describe('The remote the push targeted.'),
  mode: z
    .enum(['owner', 'contributor', 'offline'])
    .describe('The repository-relationship mode the push ran in.'),
});
type PushOutput = z.infer<typeof pushOutput>;

/**
 * `co_push` (AC-L5-6): the lead-facing verb that publishes reviewed work to the remote — GATED on
 * a recorded PASS. It refuses unless `ctx.reviews.getVerdict(into, branch)` is a recorded `PASS`
 * (there is NO un-gated push path). Enacts per repo mode: owner pushes the integration branch to
 * origin; contributor pushes the feature branch to the fork; offline refuses loud (Principle 9).
 *
 * All git I/O is behind injected seams — `pnpm test` performs NO real network or push operations.
 * The handler loud-fails if the mount did not inject the review or worktree store (Principle 9).
 */
export const pushTool: ToolSpec<PushInput, PushOutput> = {
  name: 'co_push',
  title: 'Push reviewed work to the remote',
  description:
    'Push the reviewed branch to the remote — only if a PASS verdict is recorded for it. ' +
    'Owner mode pushes the integration branch to origin; contributor mode pushes the feature ' +
    'branch to your fork. Offline mode refuses. co gates on a recorded PASS; there is no ' +
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
    const gate = new CoReviewGate({
      reviews: ctx.reviews,
      worktrees: ctx.worktrees,
      mail: ctx.mail,
      agentId: ctx.agent,
    });
    const result = gate.push({
      branch: input.branch,
      into,
      projectId: ctx.projectId,
      repoCwd: ctx.cwd,
      ...(input.remote != null ? { remote: input.remote } : {}),
    });
    return { pushed: result.pushed, remote: result.remote, mode: result.mode };
  },
};
