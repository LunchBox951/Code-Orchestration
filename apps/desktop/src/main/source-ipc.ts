import type { BranchInfo } from '@co/core';
import { listBranches as defaultListBranches } from '@co/core';

/**
 * P-ON4 — the Source view's read-only branch surface (AC-S15-7).
 *
 * `source:refresh` resolves the open repo's LOCAL branches for the read-only Source view. It is a
 * direct, offline-safe read in the main process (no daemon, no operator-IPC verb) — the same shape as
 * the other static reads the app does — and consumes `@co/core`'s {@link listBranches} as the single
 * source of truth rather than re-implementing a git read in the adapter.
 *
 * Every effect is an injectable seam (the current-project path lookup + the branch reader) so the whole
 * resolve path is exercised HEADLESSLY — no real Electron, no real git. The three outcomes are NAMED,
 * visible states (Principle 9 — no-silent-failures): a branch list, "no project open", or a surfaced
 * error (not a repo / git unavailable). The renderer renders each explicitly.
 */
export type SourceState =
  | { readonly kind: 'branches'; readonly branches: readonly BranchInfo[] }
  | { readonly kind: 'no-project' }
  | { readonly kind: 'error'; readonly message: string };

export interface SourceIpcDeps {
  /** The absolute path of the open repo, or `null` when no project is open. Production: `controller.currentProject?.path`. */
  readonly currentProjectPath: () => string | null;
  /** Read a repo's local branches. Injectable for tests; production: `@co/core` {@link listBranches}. */
  readonly listBranches?: (repoCwd: string) => readonly BranchInfo[];
}

/**
 * Resolve the Source view state for `source:refresh`. No project open ⇒ `no-project` (the reader is
 * never called); otherwise read the branches, mapping a thrown reader error (not a git repo / git
 * unavailable) to a visible `error` state instead of letting it escape as an unhandled rejection.
 */
export function resolveSourceState(deps: SourceIpcDeps): SourceState {
  const repoCwd = deps.currentProjectPath();
  if (repoCwd == null) return { kind: 'no-project' };
  const read = deps.listBranches ?? defaultListBranches;
  try {
    return { kind: 'branches', branches: read(repoCwd) };
  } catch (e: unknown) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
