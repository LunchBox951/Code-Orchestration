import { z } from 'zod';
import { defaultGitExec, slingWorktree } from '../../worktrees/sling.js';
import type { ToolSpec } from '../registry.js';
import { MAIL_CLARIFY_REQUEST, type DeliveredMail } from '../../mail/events.js';
import type { MailStore } from '../../mail/mail-store.js';
import { defaultProviderAccounts } from '../../dispatch/balancer.js';
import { refreshUsageForAccounts, runDispatchPolicy } from '../../dispatch/cli-render.js';
import { providerSchema } from '../../dispatch/events.js';
import type { PlacementDecided, PlacementRecord } from '../../dispatch/events.js';
import {
  contextWindowSchema,
  effortSchema,
  workSizeSchema,
  reasoningBudgetSchema,
} from '../../dispatch/tier.js';
import type { WorkSize, ReasoningBudget } from '../../dispatch/tier.js';
import type { DispatchDiagnostic, DispatchResolution } from '../../dispatch/throttle.js';
import type { Provider } from '../../dispatch/usage-source.js';
import { checkSpawnPlan } from '../../roles/spawn-rules.js';
import { findSubRole, parseSubRoleId } from '../../roles/sub-roles.js';
import { BASE_ROLES, type Role } from '../scoping.js';
import { assertToolCallerRole } from '../caller-auth.js';
import { readWorktreeInfo } from '../worktree.js';
import {
  childCapDisposition,
  resolveMaxActiveChildren,
  type CapChild,
} from '../../plans/child-cap.js';
import { branchMerged, resolveAgentBranch } from '../../plans/worker-branch.js';
import type { WorktreeStore } from '../../worktrees/worktree-store.js';

// Every input field carries a .describe() (Principle 5 — the schemas are the single syntax source).
// The caller never supplies its own identity; `parent` is the SPAWNER this sandbox is for, a
// required, explicit input — there is NO `@operator` default and none is baked (the child's-parent
// resolver rule is L6, not built here).
const slingInput = z
  .object({
    parent: z
      .string()
      .min(1)
      .describe(
        "The spawning agent this sandbox is created for, recorded as the worktree's parent. " +
          'Required — there is no default.',
      ),
    agent: z
      .string()
      .min(1)
      .describe(
        'The child agent id assigned to this sandbox. L7 supplies it before mounting the sandbox; ' +
          'scoped MCP mounts must match it.',
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
          'Dispatch is always resolved before sandbox creation; placed decisions are recorded after successful sandbox creation. This overrides ' +
          'the default role.',
      ),
    work_size: workSizeSchema
      .optional()
      .describe(workSizeSchema.description ?? 'Coarse task complexity band for tier selection.'),
    reasoning_budget: reasoningBudgetSchema
      .optional()
      .describe(
        reasoningBudgetSchema.description ?? 'Reasoning depth preference for effort selection.',
      ),
    // ── P2 (AC-S14-2) kickoff field ───────────────────────────────────────────────────────────
    kickoff: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Optional first-task brief for the child. Carried in the body of the actionable ' +
          "'clarify_request' that co_sling seeds so the daemon's run-cycle can select the child " +
          'on the next tick (selection reads `outstanding`, which is ACTIONABLE-only). When omitted, ' +
          "a directive fallback is used ('Begin your assigned task...'). Additive — existing " +
          'callers without this field are unaffected.',
      ),
  })
  .strict();
type SlingInput = z.infer<typeof slingInput>;

const dispatchDiagnosticSchema = z
  .object({
    provider: providerSchema.describe('Provider that produced the diagnostic.'),
    code: z.string().min(1).describe('Stable diagnostic code, e.g. usage_source_unavailable.'),
    reason: z.string().min(1).describe('Human-readable diagnostic detail.'),
  })
  .strict();

const slingOutput = z
  .object({
    status: z
      .enum(['placed', 'waiting'])
      .describe('Dispatch outcome: placed created a sandbox; waiting did not create one.'),
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
      .describe(
        'The full commit sha the base ref resolved to at branch-off (absent when WAITING).',
      ),
    worktree_path: z
      .string()
      .optional()
      .describe('Absolute path of the created sandbox (absent when WAITING).'),
    baseline_captured: z
      .boolean()
      .optional()
      .describe('True once a test baseline has been recorded at branch-off (absent when WAITING).'),
    // ── Dispatch output fields ──────────────────────────────────────────────────
    placement: z
      .object({
        provider: providerSchema.describe('The provider the seat was placed on.'),
        model: z.string().describe('The model selected for this placement.'),
        effort: effortSchema.describe('The effort level (low/medium/high/xhigh/max).'),
        context: contextWindowSchema.describe('The context-window preference (standard/extended).'),
      })
      .strict()
      .optional()
      .describe('Present when the default dispatch policy placed the sandbox.'),
    waiting: z
      .object({
        message: z
          .string()
          .describe('Loud agent-facing pacing message (spec §3 — never silent, P9).'),
        eta_reset_at: z
          .string()
          .optional()
          .describe('ISO-8601 when the soonest binding window refreshes (absent if unknown).'),
        reason: z.string().describe('Human-readable reason providers are maxed or unavailable.'),
        maxed_providers: z
          .array(providerSchema)
          .describe('Providers blocked because their binding usage window is at capacity.'),
        unavailable_providers: z
          .array(providerSchema)
          .describe('Providers blocked because usage/account health is unavailable or unknown.'),
      })
      .strict()
      .optional()
      .describe('Present when dispatch is waiting because providers are maxed or unavailable.'),
    diagnostics: z
      .array(dispatchDiagnosticSchema)
      .optional()
      .describe(
        'WAITING-only provider usage diagnostics surfaced per Principle 9 fail-loud behavior.',
      ),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasWorktree =
      value.branch !== undefined ||
      value.base_ref !== undefined ||
      value.base_sha !== undefined ||
      value.worktree_path !== undefined ||
      value.baseline_captured !== undefined;
    if (value.status === 'placed') {
      for (const field of [
        'branch',
        'base_ref',
        'base_sha',
        'worktree_path',
        'baseline_captured',
        'placement',
      ] as const) {
        if (value[field] === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [field],
            message: `placed co_sling output requires ${field}`,
          });
        }
      }
      if (value.waiting !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['waiting'],
          message: 'placed co_sling output must not include waiting',
        });
      }
      if (value.diagnostics !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['diagnostics'],
          message: 'placed co_sling output must not include diagnostics',
        });
      }
      return;
    }
    if (value.waiting === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['waiting'],
        message: 'waiting co_sling output requires waiting',
      });
    }
    if (value.placement !== undefined || hasWorktree) {
      ctx.addIssue({
        code: 'custom',
        message: 'waiting co_sling output must not include placement or worktree facts',
      });
    }
  });
type SlingOutput = z.infer<typeof slingOutput>;

function parseKnownSpawnRole(tool: string, roleId: string): Role {
  const parsed = parseSubRoleId(roleId.trim().toLowerCase());
  if (!(BASE_ROLES as readonly string[]).includes(parsed.baseRole)) {
    throw new Error(`${tool}: unknown role '${roleId}'.`);
  }
  const role = parsed.baseRole as Role;
  if (parsed.name != null && findSubRole(role, parsed.name) == null) {
    throw new Error(`${tool}: unknown role '${roleId}'.`);
  }
  return role;
}

/**
 * `co_sling` (AC-L3-1; dispatch placement AC-L4-1/AC-L4-3): create + RECORD an isolated
 * worktree+branch sandbox from an auto-detected base ref, and capture the branch-off test baseline. The
 * base is auto-detected (origin/HEAD → main → master → local HEAD) unless overridden — NEVER a
 * hard-coded `master`. The sandbox lives under program-data, never in the repo (Principle 12).
 *
 * The dispatch policy is resolved over `ctx.dispatch` and recorded as `placement.decided`.
 * A WAITING result (providers maxed or unavailable) returns a loud message and does NOT create a sandbox
 * (spec §3, P9 — the agent sees usage only as a pacing delay; never a dashboard).
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
    'at branch-off. The default dispatch policy is resolved before sandbox creation and recorded after success; ' +
    'a WAITING result means provider capacity or usage-source health blocks placement and no sandbox ' +
    'is created. The sandbox lives in program-data, never in the repo.',
  inputSchema: slingInput,
  outputSchema: slingOutput,
  handler: async (ctx, input): Promise<SlingOutput> => {
    if (!ctx.worktrees) {
      throw new Error(
        'co_sling: the mount did not inject a worktree store (ctx.worktrees absent).',
      );
    }

    if (!ctx.dispatch) {
      throw new Error(
        'co_sling: the mount did not inject a dispatch store ' +
          '(ctx.dispatch absent). The mount must open openDispatchStore(projectId) and inject it ' +
          'onto ctx.dispatch (Principle 9 — a tool never opens its own store).',
      );
    }
    if (input.parent !== ctx.agent) {
      throw new Error(
        `co_sling: parent '${input.parent}' does not match mounted caller '${ctx.agent}'. ` +
          'The mount supplies caller identity; a tool input may not assign lifecycle authority to ' +
          'another agent.',
      );
    }
    if (!ctx.roster) {
      throw new Error('co_sling: the mount did not inject a roster store (ctx.roster absent).');
    }
    assertToolCallerRole('co_sling', ctx.roster, ctx.agent, ['coordinator', 'lead', 'implementer']);

    const role = input.role?.trim().toLowerCase() ?? 'implementer';
    const parsedRole = parseSubRoleId(role);
    const caller = ctx.roster.getAgent(ctx.agent)!;
    const childRole = parseKnownSpawnRole('co_sling', role);
    const violation = checkSpawnPlan(caller.role, childRole);
    if (violation != null) {
      throw new Error(`co_sling: illegal spawn plan — ${violation.reason}.`);
    }

    // ── L6b E4 child-cap: queue-as-WAITING when the parent is at its active-children cap ──
    // Active children are this parent's NON-REVIEWER children whose branch is NOT yet merged
    // (reviewers never occupy a slot; a merged child has freed its slot). The merged check uses the
    // same `(parent integration branch, child branch)` PASS-verdict convention as co_phase_status.
    // An absent review store conservatively counts every non-reviewer child as still-active. This
    // gate fires BEFORE dispatch placement, so an over-cap dispatch records no placement decision —
    // there is no placement to decide, just a queued WAITING (Principle 9 — never a silent overrun).
    const worktrees = ctx.worktrees;
    const reviews = ctx.reviews;
    const children: CapChild[] = ctx.roster
      .listAgents()
      .filter((a) => a.parent === ctx.agent)
      .map((a) => ({
        childId: a.agentId,
        role: a.role,
        branch: resolveAgentBranch(worktrees, a.agentId),
      }));
    // Reviewers are exempt from the cap (AC-L6b-8): they never occupy a slot, so a reviewer
    // dispatched while at-cap must not be queued → WAITING.
    if (childRole !== 'reviewer' && children.some((c) => c.role !== 'reviewer')) {
      const cap = resolveMaxActiveChildren(ctx.projectId);
      const target = reviews != null ? readWorktreeInfo(ctx.cwd).branch : undefined;
      const disposition = childCapDisposition(
        children,
        (child) => branchMerged(reviews, target, child.branch),
        cap,
      );
      if (disposition.queued) {
        return {
          status: 'waiting',
          waiting: {
            message:
              `dispatch queued: parent '${ctx.agent}' already has ${disposition.activeCount} active ` +
              `child(ren) at the cap of ${cap}. Wait for a child branch to merge before slinging another.`,
            reason: `max active children reached (${disposition.activeCount}/${cap})`,
            maxed_providers: [],
            unavailable_providers: [],
          },
        };
      }
    }

    const workSize: WorkSize = (input.work_size ?? 'average') as WorkSize;
    const reasoningBudget: ReasoningBudget = (input.reasoning_budget ??
      'standard') as ReasoningBudget;
    const accounts = defaultProviderAccounts();

    // Inject nowMs at handler level (the thin impure shell); pass into pure policy (AC10, P16).
    const nowMs = Date.now();

    let diagnostics: readonly DispatchDiagnostic[] = [];
    if (ctx.usageSourceFactory !== undefined) {
      diagnostics = await refreshUsageForAccounts({
        store: ctx.dispatch,
        accounts,
        usageSourceFactory: ctx.usageSourceFactory,
        nowMs,
      });
    }

    const resolution = withDiagnostics(
      runDispatchPolicy(
        ctx.dispatch,
        ctx.projectId,
        role,
        workSize,
        reasoningBudget,
        accounts,
        nowMs,
        ctx.agent,
      ),
      diagnostics,
    );

    const placedPayload: PlacementDecided =
      resolution.kind === 'placed'
        ? {
            kind: 'placed',
            role,
            work_size: workSize,
            reasoning_budget: reasoningBudget,
            provider: resolution.placement.provider,
            account: resolution.placement.account,
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
            maxed_accounts: [...resolution.maxedAccounts],
            unavailable_providers: [...resolution.unavailableProviders],
            unavailable_accounts: [...resolution.unavailableAccounts],
          };
    if (resolution.kind === 'waiting') {
      // WAITING records immediately because there is intentionally no sandbox creation side effect.
      ctx.dispatch.recordPlacement(ctx.agent, placedPayload);
      // WAITING: loud message, no sandbox created (spec §3, P9 — never silent).
      return {
        status: 'waiting',
        waiting: {
          message: agentWaitingMessage(resolution),
          ...(resolution.etaResetAt !== undefined ? { eta_reset_at: resolution.etaResetAt } : {}),
          reason: agentWaitingReason(resolution),
          maxed_providers: [...resolution.maxedProviders],
          unavailable_providers: [...resolution.unavailableProviders],
        },
        ...(resolution.diagnostics !== undefined
          ? { diagnostics: resolution.diagnostics.map(sanitizeDiagnostic) }
          : {}),
      };
    }

    // PLACED: create the sandbox and return placement + worktree facts.
    const result = slingWorktree(ctx.worktrees, {
      parent: input.parent,
      agent: input.agent,
      role: childRole,
      ...(parsedRole.name != null ? { subRole: parsedRole.name } : {}),
      branch: input.branch,
      ...(input.base != null ? { base: input.base } : {}),
      repoCwd: ctx.cwd,
      projectId: ctx.projectId,
    });

    // AC-S14-2 (P2 kickoff): seed an actionable clarify_request to the child so the daemon's
    // run-cycle can select it on the next tick (selection reads `outstanding`, ACTIONABLE-only).
    // Seed BEFORE live spawn/placement so a mail failure cannot leave a placed or hosted child with no
    // first actionable item.
    let kickoff: DeliveredMail;
    try {
      kickoff = ctx.mail.send({
        type: MAIL_CLARIFY_REQUEST,
        to: input.agent,
        from: ctx.agent,
        subject: 'Kickoff',
        body:
          input.kickoff ??
          'Begin your assigned task; your full assignment is in your session context. Report completion via `co_finish`/`worker_done`.',
      });
    } catch (cause) {
      cleanupFailedSlingWorktree(ctx.worktrees, input.branch, ctx.cwd);
      throw cause;
    }

    // Symmetrical to co_merge's reviewer trigger: once the slung child's worktree + kickoff are
    // recorded, the live spawn must succeed or the caller must see the failure. Returning `placed`
    // while no pane exists would make launch failure invisible to recovery/operations.
    if (ctx.reviewerSpawnGate != null) {
      try {
        await ctx.reviewerSpawnGate.spawn(
          ctx.projectId,
          provisionalPlacementRecord(input.agent, placedPayload),
        );
      } catch (cause) {
        cleanupFailedSlingWorktree(ctx.worktrees, input.branch, ctx.cwd);
        retractKickoff(ctx.mail, ctx.agent, kickoff);
        throw cause;
      }
    }
    // Record a PLACED decision only after the sandbox exists, kickoff is durable, and the live launch
    // has either succeeded or is intentionally headless. A git, mail, or spawn failure must not leave
    // a false successful placement.
    try {
      ctx.dispatch.recordPlacement(ctx.agent, placedPayload);
    } catch (cause) {
      cleanupFailedSlingWorktree(ctx.worktrees, input.branch, ctx.cwd);
      retractKickoff(ctx.mail, ctx.agent, kickoff);
      throw cause;
    }

    return {
      status: 'placed',
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

function provisionalPlacementRecord(agent: string, placement: PlacementDecided): PlacementRecord {
  if (placement.kind !== 'placed') {
    throw new Error('co_sling: cannot launch a non-placed dispatch decision.');
  }
  return {
    seq: 0,
    agent,
    role: placement.role,
    workSize: placement.work_size,
    reasoningBudget: placement.reasoning_budget,
    kind: 'placed',
    provider: placement.provider,
    ...(placement.account !== undefined ? { account: placement.account } : {}),
    model: placement.model,
    effort: placement.effort,
    context: placement.context,
    recordedTs: 0,
  };
}

function cleanupFailedSlingWorktree(
  worktrees: WorktreeStore,
  branch: string,
  repoCwd: string,
): void {
  try {
    worktrees.removeWorktree(branch, { repoCwd });
  } catch {
    // Preserve the spawn failure. Orphan detection can surface any cleanup residue later.
  }
  try {
    defaultGitExec(repoCwd, ['branch', '-D', branch]);
  } catch {
    // Preserve the spawn failure. A missing/locked branch can be surfaced by later cleanup.
  }
}

function retractKickoff(mail: MailStore, sender: string, kickoff: DeliveredMail): void {
  try {
    mail.retract(sender, kickoff.seq);
  } catch {
    // Preserve the spawn failure. Orphan detection can surface any cleanup residue later.
  }
}

function withDiagnostics(
  resolution: DispatchResolution,
  diagnostics: readonly DispatchDiagnostic[],
): DispatchResolution {
  if (diagnostics.length === 0) return resolution;
  const relevantDiagnostics =
    resolution.kind === 'waiting'
      ? filterBlockingDiagnostics(resolution, diagnostics)
      : diagnostics;
  if (relevantDiagnostics.length === 0) return resolution;
  const refreshKeys = new Set(relevantDiagnostics.map((d) => `${d.provider}\0${d.code}`));
  const combined = [
    ...(resolution.diagnostics ?? []).filter((d) => !refreshKeys.has(`${d.provider}\0${d.code}`)),
    ...relevantDiagnostics,
  ];
  if (resolution.kind === 'waiting') {
    const diagnosticProviders = uniqueProviders(combined);
    const diagnosticAccounts = uniqueAccounts(combined);
    return {
      ...resolution,
      message: usageUnavailableMessage(resolution.etaResetAt, combined),
      unavailableProviders: uniqueProviderList([
        ...resolution.unavailableProviders,
        ...diagnosticProviders,
      ]),
      unavailableAccounts: uniqueStringList([
        ...resolution.unavailableAccounts,
        ...diagnosticAccounts,
      ]),
      diagnostics: combined,
    };
  }
  return {
    ...resolution,
    diagnostics: combined,
  };
}

function filterBlockingDiagnostics(
  resolution: Extract<DispatchResolution, { readonly kind: 'waiting' }>,
  diagnostics: readonly DispatchDiagnostic[],
): readonly DispatchDiagnostic[] {
  const blockingProviders = new Set([
    ...resolution.maxedProviders,
    ...resolution.unavailableProviders,
  ]);
  return diagnostics.filter((d) => blockingProviders.has(d.provider));
}

function usageUnavailableMessage(
  etaResetAt: string | undefined,
  diagnostics: readonly DispatchDiagnostic[],
): string {
  const eta =
    etaResetAt !== undefined ? `delayed until ${etaResetAt}` : 'delayed — reset ETA unknown';
  const detail = diagnostics.map((d) => `${d.provider}: ${d.reason}`).join('; ');
  return `${eta} — usage source unavailable (${detail})`;
}

function sanitizeDiagnostic(
  diagnostic: DispatchDiagnostic,
): z.infer<typeof dispatchDiagnosticSchema> {
  return {
    provider: diagnostic.provider,
    code: diagnostic.code,
    reason:
      diagnostic.code === 'usage_source_unavailable'
        ? 'usage source unavailable'
        : sanitizeAgentText(diagnostic.reason),
  };
}

function sanitizeAgentText(text: string): string {
  return text
    .replace(/\b(?:claude|codex):[A-Za-z0-9._-]+/gu, '<provider-account>')
    .replace(/Bearer\s+\S+/giu, 'Bearer <redacted>')
    .replace(/\/[^\s;)]+/gu, '<path>');
}

function agentWaitingMessage(
  resolution: Extract<DispatchResolution, { readonly kind: 'waiting' }>,
): string {
  if ((resolution.diagnostics ?? []).length > 0) {
    const eta =
      resolution.etaResetAt !== undefined
        ? `delayed until ${resolution.etaResetAt}`
        : 'delayed — reset ETA unknown';
    return `${eta} — usage source unavailable`;
  }
  return sanitizeAgentText(resolution.message);
}

function agentWaitingReason(
  resolution: Extract<DispatchResolution, { readonly kind: 'waiting' }>,
): string {
  return (resolution.diagnostics ?? []).length > 0
    ? 'usage source unavailable'
    : sanitizeAgentText(resolution.reason);
}

function uniqueProviders(diagnostics: readonly DispatchDiagnostic[]): Provider[] {
  return uniqueProviderList(diagnostics.map((d) => d.provider));
}

function uniqueAccounts(diagnostics: readonly DispatchDiagnostic[]): string[] {
  return uniqueStringList(diagnostics.flatMap((d) => (d.account === undefined ? [] : [d.account])));
}

function uniqueProviderList(providers: readonly Provider[]): Provider[] {
  return [...new Set(providers)];
}

function uniqueStringList(values: readonly string[]): string[] {
  return [...new Set(values)];
}
