/**
 * L6b E2/E4 — the shared, read-only BRANCH-RESOLUTION + MERGED-CHECK convention used by both the
 * `co_phase_status` readiness fold (E3/D5) and the `co_sling` child-cap enforcement (E4). Factored
 * here so the one convention — "which branch is an agent's, and when does a branch count as merged" —
 * lives in exactly one place (it would otherwise drift between the two call sites).
 *
 * Read-only over injected stores (records nothing); not pure (it reads), but it owns no store — the
 * tool passes the already-injected `WorktreeStore` / `ReviewStore` in (Principle 9 — a tool never
 * opens its own store).
 */
import type { WorktreeStore } from '../worktrees/worktree-store.js';
import type { ReviewStore } from '../review/review-store.js';

/**
 * Resolve an agent's branch from the worktree records. CONVENTION: the agent's branch is the branch of
 * the MOST RECENTLY created worktree assigned to it (`listWorktrees` is creation order, so the last
 * match wins). `removed` records are intentionally NOT filtered out — a merged-then-torn-down branch
 * must still resolve so its merge verdict stays visible to the readiness / cap folds. Returns
 * `undefined` when no worktree was ever assigned to the agent.
 */
export function resolveAgentBranch(
  worktrees: Pick<WorktreeStore, 'listWorktrees'>,
  agentId: string,
): string | undefined {
  let branch: string | undefined;
  for (const w of worktrees.listWorktrees()) {
    if (w.agent === agentId) branch = w.branch;
  }
  return branch;
}

/**
 * Whether `branch` counts as MERGED into `target`. CONVENTION (shared by `co_phase_status` + the E4
 * child-cap): a worker/child branch is merged iff a `PASS` verdict is recorded for
 * `(target integration branch, worker branch)`. The codebase's `Verdict` is `PASS | ISSUES` (there is
 * no `SOFT_PASS`), so only `PASS` clears the gate. Returns `false` when any input is absent (no
 * reviews store, no resolvable target branch, or no resolvable worker branch) — a conservative
 * "not merged yet", so readiness/cap stay reachable only through a real recorded PASS.
 */
export function branchMerged(
  reviews: Pick<ReviewStore, 'getVerdict'> | undefined,
  target: string | undefined,
  branch: string | undefined,
): boolean {
  if (reviews == null || target == null || branch == null) return false;
  return reviews.getVerdict(target, branch)?.verdict === 'PASS';
}
