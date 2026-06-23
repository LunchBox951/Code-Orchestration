/**
 * L6b E4 — the MAX-ACTIVE-CHILDREN cap (the child-cap half of E4; the per-target merge lock in
 * `review/serialize.ts` is the OTHER, distinct E4 primitive — reused verbatim, not rebuilt here).
 *
 * A parent may keep only so many children working concurrently. An ACTIVE child is a non-reviewer
 * child of a parent whose branch is NOT yet merged (its slot is still occupied); reviewers never
 * occupy a slot, and a child whose branch has merged has freed its slot. When the active count is at
 * or beyond the cap, a NEW dispatch must QUEUE → WAITING — a first-class returned disposition, never a
 * throw and never a silent overrun (Principle 9), mirroring
 * {@link import('../review/serialize.js').acquireMergeSlot}'s `{ queued: true }` shape.
 *
 * The policy here is PURE (no I/O, no clock) over injected children + an `isMerged` predicate; the
 * configurable cap reader (`resolveMaxActiveChildren`) clones
 * {@link import('../review/strikes.js').resolveReviewRoundBudget} verbatim. The dispatch-decision
 * enforcement lives in `tools/specs/sling.ts` (it assembles `children` + `isMerged` from the stores
 * and returns WAITING for the excess).
 */
import { openConfigStore, type ConfigStore } from '../config/config-store.js';
import type { Role } from '../tools/scoping.js';

/** Config key for the per-parent max-active-children cap (tunable per project). */
export const MAX_ACTIVE_CHILDREN_KEY = 'dispatch.maxActiveChildren' as const;

/** Default max active (non-reviewer, unmerged) children per parent before a new dispatch queues. */
export const MAX_ACTIVE_CHILDREN_DEFAULT = 2;

/**
 * Resolve the configured max-active-children cap for a project, defaulting to
 * {@link MAX_ACTIVE_CHILDREN_DEFAULT} when unset. Clones
 * {@link import('../review/strikes.js').resolveReviewRoundBudget}: a positive-integer config value
 * overrides the default; a non-integer / `< 1` value fails loud (Principle 9).
 */
export function resolveMaxActiveChildren(projectId: string, config?: ConfigStore): number {
  const store = config ?? openConfigStore();
  const ownsStore = config == null;
  try {
    const effective = store.resolveEffective(projectId);
    if (!Object.prototype.hasOwnProperty.call(effective, MAX_ACTIVE_CHILDREN_KEY)) {
      return MAX_ACTIVE_CHILDREN_DEFAULT;
    }
    const raw = effective[MAX_ACTIVE_CHILDREN_KEY];
    if (!Number.isInteger(raw) || Number(raw) < 1) {
      throw new Error(
        `${MAX_ACTIVE_CHILDREN_KEY}: expected a positive integer max-active-children cap.`,
      );
    }
    return Number(raw);
  } finally {
    if (ownsStore) store.close();
  }
}

/** One child of a parent, reduced to the facts the cap policy needs. `branch` is `undefined` for a
 * child with no resolvable worktree record (counted as still-active — its slot is conservatively
 * assumed occupied). */
export interface CapChild {
  readonly childId: string;
  readonly role: Role;
  readonly branch?: string;
}

/** A child-cap disposition — `{ queued: true }` means a new dispatch must WAIT (never a throw). */
export interface ChildCapDisposition {
  /** True when `activeCount >= cap` — the new dispatch must queue → WAITING. */
  readonly queued: boolean;
  /** The number of active (non-reviewer, unmerged) children counted. */
  readonly activeCount: number;
  /** The resolved cap the count was compared against. */
  readonly cap: number;
}

/**
 * Count a parent's ACTIVE children: non-reviewer children whose branch is NOT merged AND that are
 * NOT inactive. Reviewers are EXCLUDED (they never occupy a slot); a child for which `isMerged`
 * returns true has freed its slot; a child for which `isInactive` returns true no longer occupies a
 * slot either — the caller OR-composes every lifecycle-terminal signal into `isInactive` (durably
 * STOPPED by the operator — #131; a researcher that FINALIZED its result — #158; a worker that
 * recorded `co_finish` — #166). `isInactive` defaults to `() => false`, preserving the
 * existence-only behaviour for every caller that does not supply it. Pure + deterministic over the
 * injected `children` + the two predicates.
 */
export function activeChildCount(
  children: readonly CapChild[],
  isMerged: (child: CapChild) => boolean,
  isInactive: (child: CapChild) => boolean = () => false,
): number {
  return children.filter((c) => c.role !== 'reviewer' && !isMerged(c) && !isInactive(c)).length;
}

/**
 * Decide whether a NEW dispatch under this parent must queue. Returns `{ queued: true }` when the
 * active-child count is at or beyond `cap` (the new dispatch WAITS), else `{ queued: false }`. The
 * optional `isInactive` predicate excludes children that hold no live slot (#131 — e.g. operator
 * STOPPED children); it defaults to `() => false`, so existing two-arg callers are unaffected. Pure —
 * mirrors `acquireMergeSlot`'s first-class queued result; the caller surfaces WAITING loudly.
 */
export function childCapDisposition(
  children: readonly CapChild[],
  isMerged: (child: CapChild) => boolean,
  cap: number,
  isInactive: (child: CapChild) => boolean = () => false,
): ChildCapDisposition {
  const activeCount = activeChildCount(children, isMerged, isInactive);
  return { queued: activeCount >= cap, activeCount, cap };
}
