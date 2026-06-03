import { z } from 'zod';
import type { ToolSpec } from '../registry.js';
import { readWorktreeInfo } from '../worktree.js';

const worktreeInfoInput = z.object({});
type WorktreeInfoInput = z.infer<typeof worktreeInfoInput>;

const worktreeInfoOutput = z.object({
  path: z.string().describe('The absolute path of the worktree (your cwd).'),
  project_id: z.string().describe('The resolved project id for this worktree.'),
  branch: z.string().describe('The current git branch (or HEAD if detached).'),
  head_sha: z.string().describe('The full HEAD commit sha.'),
  dirty: z.boolean().describe('True iff the working tree has uncommitted changes.'),
});
type WorktreeInfoOutput = z.infer<typeof worktreeInfoOutput>;

/**
 * `base` (the branch this worktree was cut from) is deliberately OMITTED — it is a dispatch
 * metadatum (L3+), not reliably git-derivable. Read-only: the handler runs only read-only git
 * and writes nothing into the repo (Principle 12 — pristine-repo holds).
 */
export const worktreeInfoTool: ToolSpec<WorktreeInfoInput, WorktreeInfoOutput> = {
  name: 'co_worktree_info',
  title: 'Worktree info',
  description:
    'Report read-only facts about the git worktree you are operating in: its path, project, ' +
    'current branch, HEAD commit, and whether it has uncommitted changes.',
  inputSchema: worktreeInfoInput,
  outputSchema: worktreeInfoOutput,
  handler: (ctx): WorktreeInfoOutput => {
    const info = readWorktreeInfo(ctx.cwd);
    return {
      path: ctx.cwd,
      project_id: ctx.projectId,
      branch: info.branch,
      head_sha: info.headSha,
      dirty: info.dirty,
    };
  },
};
