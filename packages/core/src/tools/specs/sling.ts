import { z } from 'zod';
import { slingWorktree } from '../../worktrees/sling.js';
import type { ToolSpec } from '../registry.js';

// Every input field carries a .describe() (Principle 5 — the schemas are the single syntax source).
// The caller never supplies its own identity; `parent` is the SPAWNER this sandbox is for, a
// required, explicit input — there is NO `@operator` default and none is baked (the child's-parent
// resolver rule is L6, not built here).
const slingInput = z.object({
  parent: z
    .string()
    .min(1)
    .describe(
      'The spawning agent this sandbox is created for, recorded as the worktree’s parent. ' +
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
});
type SlingInput = z.infer<typeof slingInput>;

const slingOutput = z.object({
  branch: z.string().describe('The branch that was created.'),
  base_ref: z
    .string()
    .describe('The base ref the sandbox was cut from (auto-detected unless overridden).'),
  base_sha: z.string().describe('The full commit sha the base ref resolved to at branch-off.'),
  worktree_path: z
    .string()
    .describe('Absolute path of the created sandbox (under program-data, never inside the repo).'),
  baseline_captured: z
    .boolean()
    .describe('True once a test baseline for this branch has been recorded at branch-off.'),
});
type SlingOutput = z.infer<typeof slingOutput>;

/**
 * `co_sling` (AC-L3-1): create + RECORD an isolated worktree+branch sandbox from an auto-detected
 * base ref, and capture the branch-off test baseline. The base is auto-detected (origin/HEAD → main
 * → master → local HEAD) unless overridden — NEVER a hard-coded `master`. The sandbox lives under
 * program-data, never in the repo (Principle 12).
 *
 * In Stage 3 this creates + records the sandbox and provisions it (phase B — `defaultProvisioner`
 * runs right after `git worktree add`): it does NOT spawn an agent into it (L7).
 *
 * The handler loud-fails if the mount did not inject a worktree store (Principle 9 — a tool never
 * opens its own store; the mount resolves and injects it), mirroring the L1 optional-seam pattern.
 */
export const slingTool: ToolSpec<SlingInput, SlingOutput> = {
  name: 'co_sling',
  title: 'Sling a worktree',
  description:
    'Create an isolated worktree + branch sandbox from an auto-detected base ref (origin/HEAD → ' +
    'main → master → local HEAD, unless you override it), record it, and capture a test baseline ' +
    'at branch-off. The sandbox lives in program-data, never in the repo.',
  inputSchema: slingInput,
  outputSchema: slingOutput,
  handler: (ctx, input): SlingOutput => {
    if (!ctx.worktrees) {
      throw new Error(
        'co_sling: the mount did not inject a worktree store (ctx.worktrees absent).',
      );
    }
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
  },
};
