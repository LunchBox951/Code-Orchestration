import { z } from 'zod';
import { MAIL_CHAT, MAIL_WORKER_DONE } from '../../mail/events.js';
import { escalate, roleParentResolver } from '../../mail/escalation.js';
import type { MailStore } from '../../mail/mail-store.js';
import { applyStrikePolicy, resolveReviewRoundBudget } from '../../review/strikes.js';
import type { ToolSpec } from '../registry.js';
import { readWorktreeInfo } from '../worktree.js';

const kickbackInput = z
  .object({
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
  })
  .strict();
type KickbackInput = z.infer<typeof kickbackInput>;

const kickbackOutput = z.object({
  kicked_back: z
    .boolean()
    .describe(
      'True when the kickback mail was sent to the worker; false for escalation or idempotent no-op retries.',
    ),
  action: z
    .enum(['kickback', 'escalate', 'noop'])
    .describe(
      'kickback = mail sent to worker; escalate = budget reached, escalation fired upward; noop = this review already consumed its strike.',
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

function hasLegacyWorkerDone(
  mail: MailStore,
  parent: string,
  worker: string,
  branch: string,
): boolean {
  return mail
    .sentBy(worker)
    .some(
      (m) =>
        m.type === MAIL_WORKER_DONE &&
        m.recipient === parent &&
        !m.retracted &&
        m.subject === `worker_done: ${branch}`,
    );
}

/**
 * `co_kickback` (AC-L6a-5): the coordinator/lead verb for returning a branch to its worker after
 * a merge-review returned ISSUES. Tracked via the round-budget/strike counter (reuses
 * `applyStrikePolicy` from review/strikes.ts — no rebuilt strike loop). A coordinator kicking
 * back to its lead PASSES the parent-check (coordinator IS the lead's parent), which AC-L6a-5
 * covers as the coordinator/lead kickback authority path.
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
    if (!ctx.worktrees) {
      throw new Error('co_kickback: ctx.worktrees is absent — mount wiring error.');
    }

    const target = input.into ?? readWorktreeInfo(ctx.cwd).branch;

    const caller = ctx.roster.getAgent(ctx.agent);
    if (caller == null) {
      throw new Error(
        `co_kickback: caller '${ctx.agent}' is not registered in the roster — refusing ` +
          'owner-tier kickback.',
      );
    }
    if (caller.role !== 'coordinator' && caller.role !== 'lead') {
      throw new Error(
        `co_kickback: Only a coordinator or lead may kick back a branch (caller '${ctx.agent}' ` +
          `has role '${caller.role}').`,
      );
    }

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
    const worker = ctx.roster.getAgent(input.worker);
    if (worker == null) {
      throw new Error(`co_kickback: worker '${input.worker}' is not registered in the roster.`);
    }
    if (worker.role !== 'lead' && worker.role !== 'implementer') {
      throw new Error(
        `co_kickback: worker '${input.worker}' has role '${worker.role}' and cannot own code ` +
          'branches.',
      );
    }

    const worktree = ctx.worktrees.getWorktree(input.branch);
    if (worktree == null || worktree.removed) {
      throw new Error(
        `co_kickback: no worktree record for branch '${input.branch}' — refusing to route ` +
          'kickback mail or record a strike.',
      );
    }
    if (worktree.parent !== ctx.agent) {
      throw new Error(
        `co_kickback: branch '${input.branch}' worktree parent is '${worktree.parent}', not ` +
          `'${ctx.agent}'. Only the spawning parent may kick back its branch.`,
      );
    }

    const finish = ctx.worktrees.getFinish(input.branch);
    const finishedByWorker =
      finish?.agent === input.worker ||
      (finish != null &&
        finish.agent == null &&
        hasLegacyWorkerDone(ctx.mail, ctx.agent, input.worker, input.branch));
    if (!finishedByWorker) {
      throw new Error(
        `co_kickback: worker '${input.worker}' did not finish branch '${input.branch}' for ` +
          `'${ctx.agent}' — refusing to route kickback mail or record a strike.`,
      );
    }

    const latestVerdict = ctx.reviews.getVerdict(target, input.branch);
    if (latestVerdict == null || latestVerdict.verdict !== 'ISSUES') {
      throw new Error(
        `co_kickback: latest review verdict for '${input.branch}' into '${target}' must be ` +
          'ISSUES before a kickback can record a strike.',
      );
    }

    const blockers = latestVerdict.blockers;
    const verdictBlockers = blockers.map((b) => b.summary);
    const inputBlockers = input.blockers.map((b) => b.trim());
    const blockersMatch =
      inputBlockers.length === verdictBlockers.length &&
      inputBlockers.every((blocker, index) => blocker === verdictBlockers[index]);
    if (!blockersMatch) {
      throw new Error(
        `co_kickback: input blockers must match latest review verdict blockers for ` +
          `'${input.branch}' into '${target}'.`,
      );
    }

    let kickbackMailSeq: number | undefined;
    const budget = resolveReviewRoundBudget(ctx.projectId);
    const strikeKey = `${target}:${input.branch}:${latestVerdict.reviewId}`;

    const action = applyStrikePolicy(
      {
        reviews: ctx.reviews,
        mail: ctx.mail,
        resolver,
        agentId: ctx.agent,
        budget,
        beforeRecordStrike: (plan) => {
          if (plan.action === 'kickback') {
            const suggestions = [
              ...latestVerdict.suggestions.map((s) => s.summary),
              ...(input.suggestions ?? []),
            ];
            const blockerLines = blockers.map((b, i) => `  ${i + 1}. ${b.summary}`).join('\n');
            const suggestionLines =
              suggestions.length > 0
                ? '\n\nSuggestions (non-blocking):\n' +
                  suggestions.map((s, i) => `  ${i + 1}. ${s}`).join('\n')
                : '';

            const kickbackMail = ctx.mail!.send({
              type: MAIL_CHAT,
              to: input.worker,
              from: ctx.agent,
              subject: `kickback: ${input.branch}`,
              idempotencyKey: `kickback:${strikeKey}`,
              body:
                `Branch '${input.branch}' has been kicked back (strike ${plan.strikeCount}).\n\n` +
                `Blockers:\n${blockerLines}${suggestionLines}\n\n` +
                `Address all blockers and submit a fresh worker_done to close this round.`,
            });
            kickbackMailSeq = kickbackMail.seq;
            return;
          }

          if (plan.fireEscalation) {
            escalate(ctx.mail!, resolver, {
              from: ctx.agent,
              subject: `review strike budget reached for '${plan.branch}' into '${plan.target}' (${plan.strikeCount}/${budget})`,
              body:
                `The branch '${plan.branch}' has accumulated ${plan.strikeCount} consecutive ` +
                `ISSUES verdict(s) (budget: ${budget}) into ` +
                `'${plan.target}'. The review loop stops kicking back. Blockers: ${plan.reason}.`,
              idempotencyKey: `review-strike-escalation:${strikeKey}`,
            });
          }
        },
      },
      {
        reviewId: latestVerdict.reviewId,
        target,
        branch: input.branch,
        blockers,
      },
    );

    const strikeCount = ctx.reviews.getStrikeCount(target, input.branch);

    if (action === 'already_struck') {
      return {
        kicked_back: false,
        action: 'noop',
        strike_count: strikeCount,
        to: input.worker,
        target,
        branch: input.branch,
      };
    }

    if (action === 'kickback') {
      return {
        kicked_back: true,
        action: 'kickback',
        strike_count: strikeCount,
        to: input.worker,
        ...(kickbackMailSeq != null ? { mail_seq: kickbackMailSeq } : {}),
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
