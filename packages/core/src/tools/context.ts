import type {
  CommitIdentityReader,
  GitConfigIdentityReader,
} from '../permissions/identity-guard.js';
import type { ReviewerSpawnGate } from '../review/merge.js';
import type { MailStore } from '../mail/mail-store.js';
import type { ProjectRegistry, ProjectId } from '../registry/registry.js';
import type { WorktreeStore } from '../worktrees/worktree-store.js';
import type { DispatchStore } from '../dispatch/dispatch-store.js';
import type { ReviewStore } from '../review/review-store.js';
import type { RosterStore } from '../roles/roster-store.js';
import type { SpecStore } from '../specs/specs-store.js';
import type { PlanStore } from '../plans/plans-store.js';
import type { IssueStore } from '../issues/issues-store.js';
import type { ResearchStore } from '../research/research-store.js';
import type { UsageSourceFactory } from '../dispatch/cli-render.js';
import type { GhExec } from '../worktrees/repo-mode.js';
import type { ArchiveStore } from '../archive/archive-store.js';

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
   * ToolContext construction site (L1/L2/L3/L4/L5 tests, mcp/cli) keeps compiling; L6/L6a tools
   * that need it (`co_finish`, `co_merge`, `co_review_finalize`, `co_push`, `co_pr_merge`,
   * `co_kickback`) loud-fail when absent (Principle 9), mirroring the reviews seam.
   */
  readonly roster?: RosterStore;
  /**
   * OPTIONAL L6b program-data handle: the spec record store (spec draft/lock/archive records),
   * opened + injected by the mount alongside {@link roster}. Optional + additive so every existing
   * ToolContext construction site (L1/L2/L3/L4/L5/L6a tests, mcp/cli) keeps compiling; L6b tools
   * that need it (`co_spec_get`) loud-fail when absent (Principle 9), mirroring the roster seam.
   */
  readonly specs?: SpecStore;
  /**
   * OPTIONAL L6b E1 program-data handle: the plan record store (plan draft/phase-status/replan
   * records), opened + injected by the mount alongside {@link specs}. Optional + additive so every
   * existing ToolContext construction site keeps compiling; L6b E1 tools that need it
   * (`co_plan_ingest`) loud-fail when absent (Principle 9), mirroring the specs seam.
   */
  readonly plans?: PlanStore;
  /**
   * OPTIONAL L6b G program-data handle: the issue record store (capture/diagnose/file records),
   * opened + injected by the mount alongside {@link plans}. Optional + additive so every existing
   * ToolContext construction site keeps compiling; the issue verbs (`co_issue_capture`,
   * `co_issue_list`, `co_issue_diagnose`, `co_issue_file`) loud-fail when absent (Principle 9),
   * mirroring the specs/plans seams.
   */
  readonly issues?: IssueStore;
  /**
   * OPTIONAL L6b H program-data handle: the research record store (finalized maps/answers),
   * opened + injected by the mount alongside {@link issues}. Optional + additive; the research
   * verbs (`co_research_finalize`, `co_research_get`) loud-fail when absent (Principle 9).
   */
  readonly research?: ResearchStore;
  /**
   * OPTIONAL archive handle for branch-residue preservation. Tools that need to record recoverable
   * teardown residue loud-fail when it is absent rather than creating invisible refs.
   */
  readonly archive?: ArchiveStore;
  /** Optional deterministic clock seam for tool-created records that need payload timestamps. */
  readonly nowMs?: number;
  /**
   * OPTIONAL L4 passive/live usage-source factory. When the mount supplies it, dispatching tools refresh
   * stale/missing usage buckets through {@link import('../dispatch/provider-source.js').readProviderUsageCached}
   * before placement. Tests may omit it and seed `dispatch` directly.
   */
  readonly usageSourceFactory?: UsageSourceFactory;
  /**
   * OPTIONAL L6a injectable commit-identity reader seam (AC-L6a-7): used by `co_merge`,
   * `co_push`, and `co_pr_merge` to read commit identities for the guard pre-check. Defaults to
   * `defaultCommitIdentityReader` (real `git log`); tests inject a fixture reader so no real git
   * is needed for guard logic tests.
   */
  readonly commitIdentityReader?: CommitIdentityReader;
  /**
   * OPTIONAL L6a injectable git-config identity reader seam (AC-L6a-7): used by `co_merge`
   * to read the repo-local identity that would author a merge commit. Defaults to
   * `defaultGitConfigIdentityReader`; tests inject a fixture reader so no real git config is needed.
   */
  readonly gitConfigIdentityReader?: GitConfigIdentityReader;
  /**
   * OPTIONAL L5/L6a injectable GitHub CLI seam for `co_pr_merge`. Defaults to the production
   * `gh pr create` runner; tests can inject a fake so PR creation remains headless.
   */
  readonly ghExec?: GhExec;
  /**
   * OPTIONAL L7/P2 spawn gate: wired by the Conductor host layer when running the live daemon
   * (`co-mcp serve`). Used by two call-sites symmetrically:
   *   - `co_merge`: when no recorded PASS verdict exists, triggers the review (recording
   *     `review.requested` + a reviewer placement) and fires the gate — the engine launches the
   *     reviewer pane (AC-S10-2.1 / RG-4).
   *   - `co_sling`: immediately after the placed child's worktree + placement are recorded, fires
   *     the gate so the engine launches the child pane (AC-S10-2 / sling path).
   * When absent (headless/tests/prototype), both tools behave exactly as before (the seam is
   * OPTIONAL + additive; the headless paths are unchanged).
   */
  readonly reviewerSpawnGate?: ReviewerSpawnGate;
}
