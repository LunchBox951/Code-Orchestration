import { z } from 'zod';
import { slingWorktree } from '../../worktrees/sling.js';
import type { ToolSpec } from '../registry.js';
import { candidatesFromStore, placeAgent, resolvePinTable } from '../../dispatch/balancer.js';
import type { ProviderAccount } from '../../dispatch/balancer.js';
import { resolveDispatch } from '../../dispatch/throttle.js';
import { providerSchema } from '../../dispatch/events.js';
import type { PlacementDecided } from '../../dispatch/events.js';
import { workSizeSchema, reasoningBudgetSchema } from '../../dispatch/tier.js';
import type { WorkSize, ReasoningBudget } from '../../dispatch/tier.js';

const providerAccountSchema = z.object({
  provider: providerSchema.describe('The provider name (claude or codex).'),
  account: z.string().min(1).describe('The provider account identifier (e.g. "default").'),
});

const DEFAULT_ACCOUNTS: readonly ProviderAccount[] = [{ provider: 'claude', account: 'default' }];

// Every input field carries a .describe() (Principle 5 — the schemas are the single syntax source).
// The caller never supplies its own identity; `parent` is the SPAWNER this sandbox is for, a
// required, explicit input — there is NO `@operator` default and none is baked (the child's-parent
// resolver rule is L6, not built here).
const slingInput = z.object({
  parent: z
    .string()
    .min(1)
    .describe(
      "The spawning agent this sandbox is created for, recorded as the worktree's parent. " +
        'Required — there is no default.',
    ),
  branch: z
    .string()
    .regex(/^co\//u, 'branch must start with "co/"')
    .describe('The new branch to create; must start with "co/" (e.g. co/feature-x).'),
  base: z
    .string()
    .optional()
    .describe(
      'Optional base ref to branch from. Omit to auto-detect the base ' +
        '(origin/HEAD → main → master → local HEAD).',
    ),
  // ── Phase 5 optional routing fields ───────────────────────────────────────────
  role: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The role of the agent being dispatched (e.g. "implementer", "reviewer"). ' +
        'When supplied alongside work_size + reasoning_budget, the dispatch policy is resolved ' +
        'and recorded before creating the sandbox.',
    ),
  work_size: workSizeSchema
    .optional()
    .describe(workSizeSchema.description ?? 'Coarse task complexity band for tier selection.'),
  reasoning_budget: reasoningBudgetSchema
    .optional()
    .describe(
      reasoningBudgetSchema.description ?? 'Reasoning depth preference for effort selection.',
    ),
  accounts: z
    .array(providerAccountSchema)
    .optional()
    .describe(
      'Provider accounts to consider for placement. Defaults to ' +
        '[{provider:"claude",account:"default"}] when absent.',
    ),
});
type SlingInput = z.infer<typeof slingInput>;

const slingOutput = z.object({
  branch: z
    .string()
    .optional()
    .describe('The branch that was created (absent when WAITING — no sandbox).'),
  base_ref: z
    .string()
    .optional()
    .describe('The base ref the sandbox was cut from (absent when WAITING).'),
  base_sha: z
    .string()
    .optional()
    .describe('The full commit sha the base ref resolved to at branch-off (absent when WAITING).'),
  worktree_path: z
    .string()
    .optional()
    .describe('Absolute path of the created sandbox (absent when WAITING).'),
  baseline_captured: z
    .boolean()
    .optional()
    .describe('True once a test baseline has been recorded at branch-off (absent when WAITING).'),
  // ── Phase 5 routing output fields (both optional — present only when routing inputs supplied) ──
  placement: z
    .object({
      provider: z.string().describe('The provider the seat was placed on.'),
      model: z.string().describe('The model selected for this placement.'),
      effort: z.string().describe('The effort level (low/medium/high/xhigh/max).'),
      context: z.string().describe('The context-window preference (standard/extended).'),
    })
    .optional()
    .describe('Present when routing inputs were supplied and the dispatch was placed.'),
  waiting: z
    .object({
      message: z
        .string()
        .describe('Loud agent-facing pacing message (spec §3 — never silent, P9).'),
      eta_reset_at: z
        .string()
        .optional()
        .describe('ISO-8601 when the soonest binding window refreshes (absent if unknown).'),
      reason: z.string().describe('Human-readable reason all providers are at capacity.'),
      maxed_providers: z
        .array(z.string())
        .describe('Providers at capacity that caused this WAITING.'),
    })
    .optional()
    .describe('Present when routing inputs were supplied and all providers are at capacity.'),
});
type SlingOutput = z.infer<typeof slingOutput>;

/**
 * `co_sling` (AC-L3-1, AC-L4-8): create + RECORD an isolated worktree+branch sandbox from an
 * auto-detected base ref, and capture the branch-off test baseline. The base is auto-detected
 * (origin/HEAD → main → master → local HEAD) unless overridden — NEVER a hard-coded `master`.
 * The sandbox lives under program-data, never in the repo (Principle 12).
 *
 * When optional routing inputs (role/work_size/reasoning_budget) are supplied, the dispatch policy
 * is resolved over `ctx.dispatch` and recorded as `placement.decided` BEFORE creating the sandbox.
 * A WAITING result (all providers at capacity) returns a loud message and does NOT create a sandbox
 * (spec §3, P9 — the agent sees usage only as a pacing delay; never a dashboard). Without routing
 * inputs the behavior is identical to the L3 contract.
 *
 * The handler loud-fails if the mount did not inject a worktree store (Principle 9 — a tool never
 * opens its own store; the mount resolves and injects it).
 */
export const slingTool: ToolSpec<SlingInput, SlingOutput> = {
  name: 'co_sling',
  title: 'Sling a worktree',
  description:
    'Create an isolated worktree + branch sandbox from an auto-detected base ref (origin/HEAD → ' +
    'main → master → local HEAD, unless you override it), record it, and capture a test baseline ' +
    'at branch-off. When routing inputs (role/work_size/reasoning_budget) are supplied, the dispatch ' +
    'policy is resolved and recorded; a WAITING result means all providers are at capacity and no ' +
    'sandbox is created. The sandbox lives in program-data, never in the repo.',
  inputSchema: slingInput,
  outputSchema: slingOutput,
  handler: (ctx, input): SlingOutput => {
    if (!ctx.worktrees) {
      throw new Error(
        'co_sling: the mount did not inject a worktree store (ctx.worktrees absent).',
      );
    }

    const hasRoutingInputs =
      input.role !== undefined ||
      input.work_size !== undefined ||
      input.reasoning_budget !== undefined;

    if (!hasRoutingInputs) {
      // ── L3 path: no routing inputs → behave exactly as before (AC-L3-1 stays green) ──
      const result = slingWorktree(ctx.worktrees, {
        parent: input.parent,
        branch: input.branch,
        ...(input.base != null ? { base: input.base } : {}),
        repoCwd: ctx.cwd,
        projectId: ctx.projectId,
      });
      return {
        branch: result.branch,
        base_ref: result.baseRef,
        base_sha: result.baseSha,
        worktree_path: result.worktreePath,
        baseline_captured: result.baselineCaptured,
      };
    }

    // ── Phase 5 path: routing inputs present — resolve + record placement ──────
    if (!ctx.dispatch) {
      throw new Error(
        'co_sling: routing inputs were supplied but the mount did not inject a dispatch store ' +
          '(ctx.dispatch absent). The mount must open openDispatchStore(projectId) and inject it ' +
          'onto ctx.dispatch (Principle 9 — a tool never opens its own store).',
      );
    }

    const role = input.role ?? 'implementer';
    const workSize: WorkSize = (input.work_size ?? 'average') as WorkSize;
    const reasoningBudget: ReasoningBudget = (input.reasoning_budget ??
      'standard') as ReasoningBudget;
    const accounts: readonly ProviderAccount[] = input.accounts ?? DEFAULT_ACCOUNTS;

    // Inject nowMs at handler level (the thin impure shell); pass into pure policy (AC10, P16).
    const nowMs = Date.now();

    const pins = resolvePinTable(ctx.projectId);
    const candidates = candidatesFromStore(ctx.dispatch, accounts);
    const decision = placeAgent({ role, workSize, reasoningBudget, pins, candidates, nowMs });
    const resolution = resolveDispatch(decision, candidates, { nowMs });

    // Record the decision (the WRITER — completes the reader-with-writer loop, P14).
    const placedPayload: PlacementDecided =
      resolution.kind === 'placed'
        ? {
            kind: 'placed',
            role,
            work_size: workSize,
            reasoning_budget: reasoningBudget,
            provider: resolution.placement.provider,
            model: resolution.placement.model,
            effort: resolution.placement.effort,
            context: resolution.placement.context,
          }
        : {
            kind: 'waiting',
            role,
            work_size: workSize,
            reasoning_budget: reasoningBudget,
            ...(resolution.etaResetAt !== undefined ? { eta_reset_at: resolution.etaResetAt } : {}),
            reason: resolution.reason,
            maxed_providers: [...resolution.maxedProviders],
          };
    ctx.dispatch.recordPlacement(ctx.agent, placedPayload);

    if (resolution.kind === 'waiting') {
      // WAITING: loud message, no sandbox created (spec §3, P9 — never silent).
      return {
        waiting: {
          message: resolution.message,
          ...(resolution.etaResetAt !== undefined ? { eta_reset_at: resolution.etaResetAt } : {}),
          reason: resolution.reason,
          maxed_providers: [...resolution.maxedProviders],
        },
      };
    }

    // PLACED: create the sandbox and return placement + worktree facts.
    const result = slingWorktree(ctx.worktrees, {
      parent: input.parent,
      branch: input.branch,
      ...(input.base != null ? { base: input.base } : {}),
      repoCwd: ctx.cwd,
      projectId: ctx.projectId,
    });

    return {
      branch: result.branch,
      base_ref: result.baseRef,
      base_sha: result.baseSha,
      worktree_path: result.worktreePath,
      baseline_captured: result.baselineCaptured,
      placement: {
        provider: resolution.placement.provider,
        model: resolution.placement.model,
        effort: resolution.placement.effort,
        context: resolution.placement.context,
      },
    };
  },
};
