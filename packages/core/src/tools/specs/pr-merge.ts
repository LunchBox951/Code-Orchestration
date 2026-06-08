import { z } from 'zod';
import {
  checkPublishIdentities,
  defaultCommitIdentityReader,
  resolvePersonaAllowlist,
} from '../../permissions/identity-guard.js';
import { CoReviewGate } from '../../review/merge.js';
import { detectBaseRef, resolveRefSha } from '../../worktrees/detect-base.js';
import type { PrIntent } from '../../worktrees/messages.js';
import type { ToolSpec } from '../registry.js';

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

const prMergeInput = z.object({
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
      'Pre-existing baseline failures the PASS carried — present when honest-verification found ' +
        'fail→fail tests. The PR was created but these failures require attention (AC-L5-3).',
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
type PrMergeOutput = z.infer<typeof prMergeOutput>;

/**
 * `co_pr_merge` (AC-L5-6): the lead-facing verb that opens a pull request — GATED on a recorded
 * PASS. It refuses unless `ctx.reviews.getVerdict(into, branch)` is a recorded `PASS` at the
 * pr_merge scope (the strictest bar — there is NO un-gated PR path). Renders the four-section
 * house-style PR description from the structured intent via `renderPrMessage` (provider-
 * deterministic — Principle 3). Enacts per repo mode: contributor and owner create a PR via
 * `gh pr create`; offline refuses loud (Principle 9). Contributor additionally probes host
 * conventions (minimal Phase C probe — the rich parse is deferred to L9).
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
    'offline refuses. There is no un-gated PR path.',
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

    // Identity pre-check (AC-L6a-7): refuse if any commit carries an off-persona identity.
    // Only enforce when a persona allowlist is configured (non-breaking when unconfigured).
    const allowlist = resolvePersonaAllowlist(ctx.projectId);
    if (allowlist.length > 0) {
      const baseSha = ctx.worktrees.getWorktree(input.branch)?.baseSha;
      if (baseSha !== undefined) {
        const branchHead = resolveRefSha(ctx.cwd, input.branch);
        const range = `${baseSha}..${branchHead}`;
        const reader = ctx.commitIdentityReader ?? defaultCommitIdentityReader;
        const commits = reader.read(ctx.cwd, range);
        const violations = checkPublishIdentities(commits, allowlist);
        if (violations.length > 0) {
          const details = violations
            .map((v) => `  ${v.sha.slice(0, 12)} [${v.field}] ${v.identity}`)
            .join('\n');
          throw new Error(
            `co_pr_merge: blocked — commits contain identities outside the persona allowlist:\n${details}`,
          );
        }
      }
    }

    const into = input.into ?? detectBaseRef(ctx.cwd);
    // Production parent-resolver from the worktree-recorded spawning parent (Phase D).
    const parentAgent = ctx.worktrees.getWorktree(input.branch)?.parent;
    // L7 SEAM NOTE (placement recording): `dispatch`/`config`/`nowMs` are intentionally NOT injected
    // here — `co_pr_merge` gates on an already-recorded verdict and calls gate.prMerge(), never
    // triggerReview. triggerReview's placement recording is the L7 conductor seam (AC-L5-11 defers).
    // Wiring dispatch here would be dead code; L7 injects it when wiring the live reviewer dispatch.
    const gate = new CoReviewGate({
      reviews: ctx.reviews,
      worktrees: ctx.worktrees,
      mail: ctx.mail,
      agentId: ctx.agent,
      ...(parentAgent != null ? { parentResolver: { parentOf: () => parentAgent } } : {}),
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
      ...(input.operator_override != null ? { operatorOverride: input.operator_override } : {}),
      ...(input.reason != null ? { reason: input.reason } : {}),
    });
    return {
      pr_url: result.prUrl,
      pr_description: result.prDescription,
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
