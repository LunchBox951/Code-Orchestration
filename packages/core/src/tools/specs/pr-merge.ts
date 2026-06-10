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
import { detectIntegrationTarget, resolveRefSha } from '../../worktrees/detect-base.js';
import type { PrIntent } from '../../worktrees/messages.js';
import type { ToolSpec } from '../registry.js';
import { assertToolCallerRole } from '../caller-auth.js';
import { resolveContributorIdentityBaseSha } from '../publish-base.js';

// Every input field carries a .describe() (Principle 5). The PR description is RENDERED by co from
// a structured intent — the provider never authors the artifact (Principle 3). Gated on a recorded
// PASS at pr_merge scope (the strictest bar — AC-L5-6).

const prIntentInput = z
  .object({
    why: z.string().min(1).describe('Why — the rationale and stakes; the pitch leads with this.'),
    what_changed: z
      .string()
      .min(1)
      .describe('What changed — the substance of the diff, at a reviewable altitude.'),
    verification: z
      .string()
      .min(1)
      .describe('Verification — what was run and what it proved (the honest-verification story).'),
    conventions: z
      .string()
      .min(1)
      .describe("Conventions — how the change conforms to the host repo's conventions."),
  })
  .describe(
    'The structured PR intent co renders into the four-section sales pitch. co owns the contract ' +
      '(Principle 3) — never supply provider-generated prose directly.',
  );

const prMergeInput = z
  .object({
    branch: z
      .string()
      .min(1)
      .describe(
        'The reviewed source branch to open a pull request for. Must have a recorded pr_merge PASS.',
      ),
    into: z
      .string()
      .min(1)
      .optional()
      .describe('The base branch the PR targets. Defaults to the detected base of your worktree.'),
    title: z
      .string()
      .min(1)
      .refine((s) => !/[\r\n]/u.test(s), 'title must be a single line')
      .describe('The pull request title (one line).'),
    intent: prIntentInput,
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
type PrMergeInput = z.infer<typeof prMergeInput>;

const prMergeOutput = z.object({
  pr_url: z.string().describe('The URL of the opened pull request.'),
  pr_description: z
    .string()
    .describe(
      'The house-style PR description co rendered from the intent (four-section sales pitch).',
    ),
  mode: z
    .enum(['owner', 'contributor', 'offline'])
    .describe('The repository-relationship mode the PR creation ran in.'),
  baseline_failures: z
    .array(z.string())
    .optional()
    .describe(
      'Pre-existing baseline failures found by honest-verification, including fail-to-fail tests. ' +
        'Present on recorded PASS and audited override paths. The PR was created but these ' +
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
      'True when a post-PR escalation failed to persist; the PR was still created and is reported.',
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
type PrMergeOutput = z.infer<typeof prMergeOutput>;

function assertPrMergeIdentities(
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
    throw new Error(`co_pr_merge: blocked — ${reason}:\n${details}`);
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
    `co_pr_merge: refused — reviewed commit for '${branch}' is stale. Recorded PASS covers ` +
      `${finishCommitSha}, but '${branch}' now resolves to ${branchHead} in '${repoCwd}'. ` +
      'Re-run finish and review before publishing moved work.',
  );
}

function resolvePrMergeBaseSha(repoCwd: string, into: string, branch: string): string {
  return resolveContributorIdentityBaseSha('co_pr_merge', repoCwd, into, branch);
}

/**
 * `co_pr_merge` (AC-L5-6): the coordinator-or-lead verb that opens a pull request — GATED on a recorded
 * PASS. It refuses unless `ctx.reviews.getVerdict(into, branch)` is a recorded `PASS` at the
 * pr_merge scope (the strictest bar), except for the explicit `@operator` audited override path which
 * requires a non-empty reason. Renders the four-section house-style PR description from the structured
 * intent via `renderPrMessage` (provider-deterministic — Principle 3). Enacts per repo mode:
 * contributor and owner create a PR via `gh pr create`; offline refuses loud (Principle 9).
 * Contributor additionally probes host conventions (minimal Phase C probe — the rich parse is
 * deferred to L9).
 *
 * All `gh`/git I/O is behind injected seams — `pnpm test` performs NO real network operations.
 * The handler loud-fails if the mount did not inject the review or worktree store (Principle 9).
 */
export const prMergeTool: ToolSpec<PrMergeInput, PrMergeOutput> = {
  name: 'co_pr_merge',
  title: 'Open a pull request for reviewed work',
  description:
    'Open a pull request for the reviewed branch — only if a pr_merge PASS verdict is recorded for it. ' +
    'co renders the house-style PR description from your structured intent (four sections: Why / ' +
    'What changed / Verification / Conventions). Contributor and owner modes create the PR via gh; ' +
    'offline refuses. @operator may use an audited override with a non-empty reason.',
  inputSchema: prMergeInput,
  outputSchema: prMergeOutput,
  handler: (ctx, input): PrMergeOutput => {
    if (!ctx.reviews) {
      throw new Error('co_pr_merge: the mount did not inject a review store (ctx.reviews absent).');
    }
    if (!ctx.worktrees) {
      throw new Error(
        'co_pr_merge: the mount did not inject a worktree store (ctx.worktrees absent).',
      );
    }
    if (!ctx.roster) {
      throw new Error('co_pr_merge: the mount did not inject a roster store (ctx.roster absent).');
    }
    const operatorOverride = input.operator_override === true;
    if (operatorOverride) {
      if (ctx.agent !== OPERATOR) {
        throw new Error(
          `co_pr_merge: operator_override is reserved for ${OPERATOR}; caller '${ctx.agent}' ` +
            'must use the recorded-PASS gate.',
        );
      }
      if (input.reason == null || input.reason.trim().length === 0) {
        throw new Error('co_pr_merge: operator_override requires a non-empty reason.');
      }
    } else {
      assertToolCallerRole('co_pr_merge', ctx.roster, ctx.agent, ['coordinator', 'lead']);
    }

    const into = input.into ?? detectIntegrationTarget(ctx.cwd);

    const worktree = ctx.worktrees.getWorktree(input.branch);
    if (worktree == null || worktree.removed) {
      throw new Error(
        `co_pr_merge: cannot open PR for branch '${input.branch}' — no live worktree record ` +
          'exists for that branch.',
      );
    }
    if (!operatorOverride && worktree.parent !== ctx.agent) {
      throw new Error(
        `co_pr_merge: branch '${input.branch}' worktree parent is '${worktree.parent}', not ` +
          `'${ctx.agent}'. Only the spawning parent may open a PR for the branch.`,
      );
    }

    // Identity pre-check (AC-L6a-7): refuse unsigned commits always, and refuse off-persona
    // identities when a persona allowlist is configured.
    const allowlist = resolvePersonaAllowlist(ctx.projectId);
    const branchHead = resolveRefSha(ctx.cwd, input.branch);
    assertReviewedRefMatchesFinish(
      ctx.cwd,
      input.branch,
      branchHead,
      ctx.worktrees.getFinish(input.branch)?.commitSha,
    );
    const mergeBase = resolvePrMergeBaseSha(ctx.cwd, into, input.branch);
    const range = `${mergeBase}..${branchHead}`;
    assertPrMergeIdentities(
      ctx.cwd,
      range,
      allowlist,
      ctx.commitIdentityReader ?? defaultCommitIdentityReader,
    );

    // Production parent-resolver from the caller's roster parent (Phase D).
    // L7 SEAM NOTE (placement recording): `dispatch`/`config`/`nowMs` are intentionally NOT injected
    // here — `co_pr_merge` gates on an already-recorded verdict and calls gate.prMerge(), never
    // triggerReview. triggerReview's placement recording is the L7 conductor seam (AC-L5-11 defers).
    // Wiring dispatch here would be dead code; L7 injects it when wiring the live reviewer dispatch.
    const gate = new CoReviewGate({
      reviews: ctx.reviews,
      worktrees: ctx.worktrees,
      mail: ctx.mail,
      agentId: ctx.agent,
      ...(operatorOverride ? {} : { parentResolver: roleParentResolver(ctx.roster) }),
      ...(ctx.ghExec != null ? { ghExec: ctx.ghExec } : {}),
    });
    // Map tool's snake_case field to PrIntent's camelCase (the tool schema is the wire API;
    // the internal type is the core contract).
    const intent: PrIntent = {
      why: input.intent.why,
      whatChanged: input.intent.what_changed,
      verification: input.intent.verification,
      conventions: input.intent.conventions,
    };
    const result = gate.prMerge({
      branch: input.branch,
      into,
      title: input.title,
      intent,
      projectId: ctx.projectId,
      repoCwd: ctx.cwd,
      ...(operatorOverride ? { operatorOverride: true, reason: input.reason } : {}),
    });
    return {
      pr_url: result.prUrl,
      pr_description: result.prDescription,
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
