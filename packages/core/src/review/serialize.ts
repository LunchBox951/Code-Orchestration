import { resolveRefSha, type GitReader } from '../worktrees/detect-base.js';
import type { MergeSerialized, ReviewVerdictRecorded } from './events.js';

/**
 * L5 Phase F — per-target merge SERIALIZATION + the re-review base (AC-L5-7). The cure for the
 * prototype's two concurrent-merge failures: (1) two branches merging into the same target at once
 * (a race), and (2) the second branch re-reviewing/re-merging against the caller's STALE checkout
 * instead of the base that exists AFTER the first one lands (the `co merge` worktree-drift gotcha).
 *
 * The merge lock is event-sourced over the `merge.serialized` events already defined + folded since
 * Phase A — one stream per target (`review:<target>`). At most ONE active reviewer/merge per target:
 * the FIRST branch to {@link acquireMergeSlot} holds the slot; a second branch QUEUES (waits) until the
 * holder {@link releaseMergeSlot}s on landing. Two queued merges to one target therefore serialize —
 * no thrash (AC-L5-7).
 *
 * The model is a TOGGLE over the ordered `merge.serialized` log (see {@link foldActiveSlot}): the only
 * event available is `{target, branch}` (its schema is frozen across A–F), so an acquire and its paired
 * release are recorded as TWO `merge.serialized` events for the same branch — odd occurrence acquires,
 * even occurrence releases. This keeps the writes replay-equal (the projector's `serialized` flag is
 * set idempotently either way) while the slot state stays derivable purely from the log.
 *
 * Everything here is clock-free + deterministic (AC-L5-11): the pure {@link foldActiveSlot} is a
 * left-to-right fold with no Map-iteration nondeterminism, and {@link acquireMergeSlot}/{@link
 * releaseMergeSlot} are thin store-bound orchestrators (mirroring {@link
 * import('./strikes.js').applyStrikePolicy}) over an injectable {@link MergeSlotStore} seam. The
 * re-review base ({@link reReviewBase}) is resolved via refs — the post-landing commit, NEVER a stale
 * checkout.
 */

/** One merge-slot grant, as folded from a target's ordered `merge.serialized` log (queue order). */
export interface MergeSlotEntry {
  /** The branch the `merge.serialized` event granted (or released) the slot for. */
  readonly branch: string;
}

/**
 * Fold a target's ORDERED `merge.serialized` entries into the branch currently holding the merge slot.
 * Each entry TOGGLES its branch: an odd occurrence ACQUIRES the slot (the branch now holds it), the
 * next (even) occurrence RELEASES it. Under the acquire-only-when-free discipline at most one branch is
 * ever held, so the fold collapses to a single holder; returns undefined when none is held. Pure +
 * deterministic — no clock, no I/O, a single left-to-right pass (no Map-iteration nondeterminism).
 */
export function foldActiveSlot(entries: readonly MergeSlotEntry[]): string | undefined {
  let held: string | undefined;
  for (const entry of entries) {
    held = held === entry.branch ? undefined : entry.branch;
  }
  return held;
}

/**
 * The minimal review-store seam {@link acquireMergeSlot}/{@link releaseMergeSlot} drive — a subset of
 * {@link import('./review-store.js').ReviewStore}. `recordSerialized` appends a `merge.serialized`
 * event (+ folds it); `activeSerialized` reads back the branch currently holding the target's slot
 * (the {@link foldActiveSlot} of the target's log). Injectable so the lock is headless-testable.
 */
export interface MergeSlotStore {
  recordSerialized(m: MergeSerialized): void;
  activeSerialized(target: string): string | undefined;
  acquireSerialized?(m: MergeSerialized): MergeSlotResult;
  releaseSerialized?(m: MergeSerialized): void;
  recordVerdictAndRelease?(verdict: ReviewVerdictRecorded): void;
}

/** The outcome of an {@link acquireMergeSlot} attempt — never a throw (the queued case is first-class). */
export interface MergeSlotResult {
  /** True when this branch now holds the slot (freshly recorded, or it already held it). */
  readonly acquired: boolean;
  /** True when a DIFFERENT branch holds the slot and this branch must wait (serialize — AC-L5-7). */
  readonly queued: boolean;
  /** The branch currently holding the slot after the attempt (this branch when acquired). */
  readonly active: string;
  /** True only when this acquire call appended the slot-holding event. */
  readonly fresh: boolean;
}

/**
 * Acquire the per-target merge slot for `branch` (AC-L5-7). Records a `merge.serialized` (claiming the
 * slot) IFF no active slot is held; if THIS branch already holds it, the acquire is idempotent (no
 * second record). If a DIFFERENT branch holds it, the branch QUEUES — a first-class `{queued: true}`
 * result, never a throw, never a silent overrun (so the caller can wait / surface the wait loudly,
 * Principle 9). Two queued merges to one target serialize — exactly one active at a time.
 */
export function acquireMergeSlot(
  store: MergeSlotStore,
  target: string,
  branch: string,
): MergeSlotResult {
  if (store.acquireSerialized != null) {
    return store.acquireSerialized({ target, branch });
  }
  const active = store.activeSerialized(target);
  if (active === undefined) {
    store.recordSerialized({ target, branch });
    return { acquired: true, queued: false, active: branch, fresh: true };
  }
  if (active === branch) {
    return { acquired: true, queued: false, active: branch, fresh: false }; // already the holder.
  }
  return { acquired: false, queued: true, active, fresh: false };
}

/**
 * Release the per-target merge slot held by `branch` on a landing (AC-L5-7). Records the paired
 * (even) `merge.serialized` event that toggles the slot free, so the next queued branch can acquire it.
 * Fails loud (Principle 9) if `branch` is not the current holder — releasing a slot you do not hold is
 * a programming error, never a silent no-op.
 */
export function releaseMergeSlot(store: MergeSlotStore, target: string, branch: string): void {
  if (store.releaseSerialized != null) {
    store.releaseSerialized({ target, branch });
    return;
  }
  const active = store.activeSerialized(target);
  if (active === undefined) return;
  if (active !== branch) {
    throw new Error(
      `releaseMergeSlot: '${branch}' does not hold the merge slot for '${target}' ` +
        `(active holder: ${active ?? 'none'}). Releasing a slot you do not hold is refused.`,
    );
  }
  store.recordSerialized({ target, branch }); // even occurrence → toggles the slot free.
}

/**
 * The re-review base for the next queued branch (AC-L5-7): the commit `target` resolves to RIGHT NOW,
 * via refs — i.e. the POST-LANDING base after the prior merge landed, NEVER the caller's stale checkout
 * (the `co merge` worktree-drift gotcha). A thin, intention-revealing wrapper over {@link resolveRefSha}
 * so the serialization story names the post-landing-base resolution at its call site. Fails loud if the
 * ref cannot be resolved (Principle 9 — never a fabricated sha). `gitReader` is injectable for headless
 * tests.
 */
export function reReviewBase(repoCwd: string, target: string, gitReader?: GitReader): string {
  return resolveRefSha(repoCwd, target, gitReader);
}
