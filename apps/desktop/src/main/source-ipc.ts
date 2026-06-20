import type { BranchInfo, PullRequestInfo } from '@co/core';
import { listBranches as defaultListBranches } from '@co/core';
import { listPullRequests as defaultListPullRequests } from '@co/core';

/**
 * P-ON4 — the Source view's read-only branch + local PR-ref surface (AC-S15-7).
 *
 * `source:refresh` resolves the open repo's LOCAL branches and locally-fetched PR refs for the
 * read-only Source view. It is a direct, offline-safe read in the main process (no daemon, no
 * operator-IPC verb) — the same shape as the other static reads the app does — and consumes
 * `@co/core` as the single source of truth rather than re-implementing git reads in the adapter.
 *
 * Every effect is an injectable seam (the current-project path lookup + the branch reader) so the whole
 * resolve path is exercised HEADLESSLY — no real Electron, no real git. The outcomes are NAMED,
 * visible states (Principle 9 — no-silent-failures): source data, "no project open", open-project
 * path-missing, or a surfaced error (not a repo / git unavailable). The renderer renders each
 * explicitly.
 */
export type SourceState =
  | {
      readonly kind: 'source';
      readonly branches: readonly BranchInfo[];
      readonly pullRequests: readonly PullRequestInfo[];
    }
  | { readonly kind: 'no-project' }
  | { readonly kind: 'path-missing'; readonly projectId: string; readonly message: string }
  | { readonly kind: 'error'; readonly message: string };

export type SourceProjectState = {
  readonly projectId: string;
  readonly path: string | null;
} | null;

export interface SourceIpcDeps {
  /** The open project identity/path, or `null` when no project is open. Production: `controller.currentProject`. */
  readonly currentProject: () => SourceProjectState;
  /** Read a repo's local branches. Injectable for tests; production: `@co/core` {@link listBranches}. */
  readonly listBranches?: (repoCwd: string) => readonly BranchInfo[];
  /** Read locally-fetched pull-request refs. Injectable for tests; production: `@co/core`. */
  readonly listPullRequests?: (repoCwd: string) => readonly PullRequestInfo[];
}

/**
 * Resolve the Source view state for `source:refresh`. No project open ⇒ `no-project`; an open project
 * without a path ⇒ `path-missing` (the readers are never called in either case); otherwise read the
 * branches + local PR refs, mapping a thrown reader error (not a git repo / git unavailable) to a
 * visible `error` state instead of letting it escape as an unhandled rejection.
 */
export function resolveSourceState(deps: SourceIpcDeps): SourceState {
  const project = deps.currentProject();
  if (project == null) return { kind: 'no-project' };
  const repoCwd = project.path;
  if (repoCwd == null) {
    return {
      kind: 'path-missing',
      projectId: project.projectId,
      message: `Project ${project.projectId} is open, but its repository path is unavailable.`,
    };
  }
  const readBranches = deps.listBranches ?? defaultListBranches;
  const readPullRequests = deps.listPullRequests ?? defaultListPullRequests;
  try {
    return {
      kind: 'source',
      branches: readBranches(repoCwd),
      pullRequests: readPullRequests(repoCwd),
    };
  } catch (e: unknown) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
