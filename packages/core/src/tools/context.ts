import type { CommitIdentityReader } from '../permissions/identity-guard.js';
import type { MailStore } from '../mail/mail-store.js';
import type { ProjectRegistry, ProjectId } from '../registry/registry.js';
import type { WorktreeStore } from '../worktrees/worktree-store.js';
import type { DispatchStore } from '../dispatch/dispatch-store.js';
import type { ReviewStore } from '../review/review-store.js';
import type { RosterStore } from '../roles/roster-store.js';
import type { UsageSourceFactory } from '../dispatch/cli-render.js';

/**
 * What every tool handler receives. Assembled by whoever MOUNTS the surface — the
 * in-process test harness at L2, the Conductor at L7 — NEVER invented by a tool. This is
 * the seam that makes every tool callable headless (inject a context) while deferring
 * live identity-injection + session wiring to L7 (transport-agnostic — mcp-tools.md).
 */
export interface ToolContext {
  /** The calling agent's identity (opaque id). Injected by the mount; a tool never invents it. */
  readonly agent: string;
  /** The resolved project id for this invocation (registry.resolve(cwd)). */
  readonly projectId: ProjectId;
  /** Absolute path of the worktree/cwd the agent is operating in. */
  readonly cwd: string;
  /** The L1 mail bus over this project, opened by the mount (tools never open their own store). */
  readonly mail: MailStore;
  /** The project registry (path <-> id). */
  readonly registry: ProjectRegistry;
  /**
   * OPTIONAL L3 program-data handle: the worktree store (worktree records + branch-off baselines),
   * opened + injected by the mount alongside {@link mail}. Optional + additive so every existing
   * ToolContext construction site and L1/L2 handler stays untouched and keeps compiling; an L3 tool
   * that needs it loud-fails when it is absent (Principle 9), mirroring L1's optional-method seams.
   */
  readonly worktrees?: WorktreeStore;
  /**
   * OPTIONAL L4 program-data handle: the dispatch store (usage/cost/placement records), opened +
   * injected by the mount alongside {@link worktrees}. Optional + additive so every existing
   * ToolContext construction site (L1/L2/L3 tests, mcp/cli) keeps compiling; an L4 tool that needs
   * it loud-fails when absent (Principle 9), mirroring the worktrees seam.
   */
  readonly dispatch?: DispatchStore;
  /**
   * OPTIONAL L5 program-data handle: the review store (verdict records, keyed by merge target +
   * branch), opened + injected by the mount alongside {@link worktrees}. Optional + additive so every
   * existing ToolContext construction site (L1/L2/L3/L4 tests, mcp/cli) keeps compiling; an L5 tool
   * that needs it (`co_merge`, `co_review_finalize`) loud-fails when absent (Principle 9), mirroring
   * the worktrees/dispatch seams.
   */
  readonly reviews?: ReviewStore;
  /**
   * OPTIONAL L6a program-data handle: the agent roster store (agent→role→parent records), opened +
   * injected by the mount alongside {@link reviews}. Optional + additive so every existing
   * ToolContext construction site (L1/L2/L3/L4/L5 tests, mcp/cli) keeps compiling; an L6 tool
   * that needs it (`co_kickback`) loud-fails when absent (Principle 9), mirroring the reviews seam.
   */
  readonly roster?: RosterStore;
  /**
   * OPTIONAL L4 passive/live usage-source factory. When the mount supplies it, dispatching tools refresh
   * stale/missing usage buckets through {@link import('../dispatch/provider-source.js').readProviderUsageCached}
   * before placement. Tests may omit it and seed `dispatch` directly.
   */
  readonly usageSourceFactory?: UsageSourceFactory;
  /**
   * OPTIONAL L6a injectable commit-identity reader seam (AC-L6a-7): used by `co_push` and
   * `co_pr_merge` to read commit identities for the guard pre-check. Defaults to
   * `defaultCommitIdentityReader` (real `git log`); tests inject a fixture reader so no real git
   * is needed for guard logic tests.
   */
  readonly commitIdentityReader?: CommitIdentityReader;
}
