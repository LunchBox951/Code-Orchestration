/**
 * The L5 review-trigger + merge plug-point — the gate `co_finish` STOPS short of (AC-L3-6, freeze
 * #2). In L3, `co_finish` commits the worktree, records the finish, and emits `worker_done`
 * (informational), then STOPS: it does NOT dispatch a reviewer and it does NOT merge. Triggering the
 * honest-verification review (comparing the finish's tests against the captured baseline) and the
 * gated merge to a phase/integration branch are L5's job.
 *
 * This is a TYPED stub marking that seam — copied from L1's {@link import('../mail/delivery.js').LiveDeliveryStub}
 * / L2's `LiveSessionHostStub`: it fails loud (Principle 9) rather than being a silent no-op, because
 * a silent stub is exactly the fallback that hid the prototype's gaps. `co_finish` never calls it —
 * it exists so the L5 plug-point is a real, typed thing rather than an absence, and so the absence of
 * a gated merge/push/PR verb in L3 is a deliberate, documented boundary (P7 — gated-by-default holds
 * because the gated verbs are simply NOT BUILT here).
 */
export interface FinishReviewGate {
  /**
   * Dispatch the honest-verification reviewer for a finished branch and gate on its verdict.
   * Returns `never`: L5 finalizes the parameters + lifecycle; this signature only marks the seam.
   */
  triggerReview(branch: string): never;
  /**
   * Merge a reviewed branch (only on a PASS) in the project's repository-relationship mode.
   * Returns `never`: the gated merge/push/PR verbs are L5; this signature only marks the seam.
   */
  merge(branch: string): never;
}

/**
 * The L5 STUB gate. Both methods fail loud (Principle 9) until L5 owns the review-trigger + merge —
 * never a silent no-op. The signatures omit the params the interface declares (TS allows a method to
 * ignore trailing parameters) — they always throw regardless of arguments.
 */
export class FinishReviewGateStub implements FinishReviewGate {
  // L5 PLUG-POINT (review-gates.md). The production gate must:
  //  (1) run the finish's test suite in the sandbox and compare it against the captured baseline
  //      (a NEW failure is a regression; a pre-existing one is not) — the honest-verification step;
  //  (2) dispatch a reviewer and gate the merge on a PASS (no path to master/remote/PR without one);
  //  (3) render the merge/PR text via the message contract (renderMergeMessage / renderPrMessage)
  //      in the project's repository-relationship mode.
  // Until then this stub fails loud (Principle 9).
  triggerReview(): never {
    throw new Error(
      'FinishReviewGateStub.triggerReview: the honest-verification review-trigger is not ' +
        'implemented at L3. This is the L5 plug-point: compare the finish record against the ' +
        'captured baseline and gate on a reviewer PASS. co_finish only records the finish here.',
    );
  }

  merge(): never {
    throw new Error(
      'FinishReviewGateStub.merge: the gated merge is not implemented at L3. This is the L5 ' +
        'plug-point: merge a reviewed branch only on a PASS (no un-gated merge/push/PR verb is ' +
        'exposed in L3 — P7). co_finish does not merge.',
    );
  }
}
