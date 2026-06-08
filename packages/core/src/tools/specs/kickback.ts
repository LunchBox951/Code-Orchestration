import { z } from 'zod';
import { MAIL_CHAT } from '../../mail/events.js';
import { roleParentResolver } from '../../mail/escalation.js';
import { applyStrikePolicy, REVIEW_ROUND_BUDGET_DEFAULT } from '../../review/strikes.js';
import type { ToolSpec } from '../registry.js';
import { readWorktreeInfo } from '../worktree.js';

const kickbackInput = z.object({
  branch: z
    .string()
    .min(1)
    .describe(
      'The reviewed branch whose merge-review returned ISSUES — the branch being kicked back.',
    ),
  worker: z
    .string()
    .min(1)
    .describe(
      'The agent who owns/produced the branch — the kickback recipient (i.e. the child you dispatched).',
    ),
  blockers: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      'Why the branch is kicked back — at least one single-line blocker summary (no blank entries).',
    ),
  suggestions: z
    .array(z.string().min(1))
    .optional()
    .describe('Optional non-blocking improvement suggestions for the worker.'),
  into: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The target branch the failed review was against. Defaults to your current branch (the integration branch).',
    ),
});
type KickbackInput = z.infer<typeof kickbackInput>;

const kickbackOutput = z.object({
  kicked_back: z
    .boolean()
    .describe(
      'True when the kickback mail was sent to the worker; false when the budget was reached and the loop escalated instead.',
    ),
  action: z
    .enum(['kickback', 'escalate'])
    .describe(
      'kickback = mail sent to worker; escalate = budget reached, escalation fired upward.',
    ),
  strike_count: z
    .number()
    .int()
    .describe(
      'Consecutive ISSUES strike count for (target, branch) after recording this kick-back.',
    ),
  to: z
    .string()
    .describe(
      'The kickback recipient (worker id). Present even when action=escalate (the worker whose branch triggered the budget).',
    ),
  mail_seq: z
    .number()
    .int()
    .optional()
    .describe(
      'Sequence number of the kickback mail sent to the worker. Present only when action=kickback.',
    ),
  target: z.string().describe('The integration branch the reviewed branch was being merged into.'),
  branch: z.string().describe('The reviewed branch that was kicked back.'),
});
type KickbackOutput = z.infer<typeof kickbackOutput>;

/**
 * `co_kickback` (AC-L6a-5): the coordinator/lead verb for returning a branch to its worker after
 * a merge-review returned ISSUES. Tracked via the round-budget/strike counter (reuses
 * `applyStrikePolicy` from review/strikes.ts — no rebuilt strike loop). A coordinator kicking
 * back to its lead PASSES the parent-check (coordinator IS the lead's parent), fixing the gap in
 * `.co/issues/2026-06-08-coordinator-cannot-kickback-failed-merge-review.md`.
 *
 * The tool NEVER opens its own stores (Principle 9 — the mount assembles the context).
 * Scoped to: coordinator, lead.
 */
export const kickbackTool: ToolSpec<KickbackInput, KickbackOutput> = {
  name: 'co_kickback',
  title: 'Kick a branch back to its worker',
  description:
    'Return a branch to its worker after a merge-review returned ISSUES. Tracked via the review ' +
    'round-budget/strike counter. Below budget: sends a kickback mail to the worker listing blockers ' +
    'and suggestions. At budget: fires one escalation to your parent instead (the round-budget escalation valve). ' +
    'Only a coordinator or lead who is the direct parent of `worker` may call this.',
  inputSchema: kickbackInput,
  outputSchema: kickbackOutput,
  handler: (ctx, input): KickbackOutput => {
    if (!ctx.reviews) {
      throw new Error('co_kickback: the mount did not inject a review store (ctx.reviews absent).');
    }
    if (!ctx.roster) {
      throw new Error('co_kickback: the mount did not inject a roster store (ctx.roster absent).');
    }
    if (!ctx.mail) {
      throw new Error('co_kickback: ctx.mail is absent — mount wiring error.');
    }

    const target = input.into ?? readWorktreeInfo(ctx.cwd).branch;

    // Authorization via the production role-based resolver: the caller must be the recorded parent
    // of `worker`. This is what makes the resolver a real production consumer and prevents
    // cross-tree kickbacks. A coordinator kicking back to its lead PASSES (coordinator IS parent).
    const resolver = roleParentResolver(ctx.roster);
    const workerParent = resolver.parentOf(input.worker);
    if (workerParent !== ctx.agent) {
      throw new Error(
        `co_kickback: '${ctx.agent}' is not the recorded parent of worker '${input.worker}' ` +
          `(recorded parent: '${workerParent}'). Only the direct parent may kick back a branch.`,
      );
    }

    const blockers = input.blockers.map((summary) => ({ summary }));

    const action = applyStrikePolicy(
      {
        reviews: ctx.reviews,
        mail: ctx.mail,
        resolver,
        agentId: ctx.agent,
        budget: REVIEW_ROUND_BUDGET_DEFAULT,
      },
      {
        reviewId: `kickback:${target}:${input.branch}`,
        target,
        branch: input.branch,
        blockers,
      },
    );

    const strikeCount = ctx.reviews.getStrikeCount(target, input.branch);

    if (action === 'kickback') {
      const suggestions = input.suggestions ?? [];
      const blockerLines = blockers.map((b, i) => `  ${i + 1}. ${b.summary}`).join('\n');
      const suggestionLines =
        suggestions.length > 0
          ? '\n\nSuggestions (non-blocking):\n' +
            suggestions.map((s, i) => `  ${i + 1}. ${s}`).join('\n')
          : '';

      const kickbackMail = ctx.mail.send({
        type: MAIL_CHAT,
        to: input.worker,
        from: ctx.agent,
        subject: `kickback: ${input.branch}`,
        body:
          `Branch '${input.branch}' has been kicked back (strike ${strikeCount}).\n\n` +
          `Blockers:\n${blockerLines}${suggestionLines}\n\n` +
          `Address all blockers and submit a fresh worker_done to close this round.`,
      });

      return {
        kicked_back: true,
        action: 'kickback',
        strike_count: strikeCount,
        to: input.worker,
        mail_seq: kickbackMail.seq,
        target,
        branch: input.branch,
      };
    }

    // action === 'escalate': applyStrikePolicy already fired the escalation upward.
    return {
      kicked_back: false,
      action: 'escalate',
      strike_count: strikeCount,
      to: input.worker,
      target,
      branch: input.branch,
    };
  },
};
