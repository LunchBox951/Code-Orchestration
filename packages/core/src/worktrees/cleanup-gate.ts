/**
 * The L8 operator-cleanup plug-point — the cleanup VERBS that L3-E's teardown + orphan-detection
 * PRIMITIVES stop short of (AC-L3-5, boundary freeze). In L3, {@link
 * import('./worktree-store.js').WorktreeStore.removeWorktree} tears one sandbox down and {@link
 * import('./worktree-store.js').WorktreeStore.detectOrphans} SURFACES recorded-vs-reality
 * mismatches, then STOP: they are reusable primitives. The operator-facing verbs that ACT on those
 * facts are L8:
 *   - `cleanup` — remove a finished sandbox once its work is PROVEN merged (no silent data loss);
 *   - `unstick` — recover a stuck / locked worktree (e.g. `git worktree repair`/`prune`) safely;
 *   - `nuke`    — force-remove a sandbox the operator has explicitly condemned.
 * The "prove the work is merged before removing" safety check is L8's invariant — NOT this layer's.
 *
 * This is a TYPED stub marking that seam — copied from L1's
 * {@link import('../mail/delivery.js').LiveDeliveryStub} (the same pattern L3-C used for the review
 * gate, since made real in L5): it fails loud (Principle 9) rather than
 * being a silent no-op, because a silent stub is exactly the fallback that hid the prototype's gaps.
 * Nothing in L3 calls it — it exists so the L8 plug-point is a real, typed thing rather than an
 * absence, and so the lack of a cleanup verb in L3 is a deliberate, documented boundary (P7 —
 * gated-by-default holds because the verbs are simply NOT BUILT here). No `co_*` tool is declared.
 */
export interface CleanupGate {
  /**
   * Remove a finished sandbox once its work is proven merged. Returns `never`: L8 finalizes the
   * merge-proof + lifecycle; this signature only marks the seam.
   */
  cleanup(branch: string): never;
  /**
   * Recover a stuck / locked worktree. Returns `never`: the safe-recovery policy is L8; this
   * signature only marks the seam.
   */
  unstick(branch: string): never;
  /**
   * Force-remove an explicitly condemned sandbox. Returns `never`: the force-removal authority is
   * L8; this signature only marks the seam.
   */
  nuke(branch: string): never;
}

/**
 * The L8 STUB gate. Every verb fails loud (Principle 9) until L8 owns operator cleanup — never a
 * silent no-op. The signatures omit the `branch` the interface declares (TS lets a method ignore
 * trailing parameters) — they always throw regardless of arguments.
 */
export class CleanupGateStub implements CleanupGate {
  // L8 PLUG-POINT (operator cleanup verbs). The production gate must, per verb:
  //  (1) PROVE the work is merged before removing (no silent data loss) — the safety invariant;
  //  (2) call the L3 `removeWorktree` primitive to tear the proven-merged sandbox down;
  //  (3) reconcile `detectOrphans` output (drop an untracked sandbox / re-record or clear a dangling
  //      record), with `unstick`/`nuke` covering the stuck + condemned cases.
  // Until then every verb fails loud (Principle 9).
  cleanup(): never {
    throw new Error(
      'CleanupGateStub.cleanup: the operator cleanup verb is not implemented at L3. This is the ' +
        'L8 plug-point: PROVE the work is merged, then call removeWorktree to tear the sandbox ' +
        'down. L3 ships removeWorktree + detectOrphans as primitives — no cleanup verb here (P7).',
    );
  }

  unstick(): never {
    throw new Error(
      'CleanupGateStub.unstick: the operator unstick verb is not implemented at L3. This is the ' +
        'L8 plug-point: safely recover a stuck / locked worktree. L3 ships removeWorktree + ' +
        'detectOrphans as primitives — no unstick verb here (P7).',
    );
  }

  nuke(): never {
    throw new Error(
      'CleanupGateStub.nuke: the operator nuke verb is not implemented at L3. This is the L8 ' +
        'plug-point: force-remove an explicitly condemned sandbox. L3 ships removeWorktree + ' +
        'detectOrphans as primitives — no nuke verb here (P7).',
    );
  }
}
