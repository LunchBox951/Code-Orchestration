/**
 * The L8 operator-cleanup plug-point — the cleanup VERBS that L3-E's teardown + orphan-detection
 * PRIMITIVES stop short of (AC-L3-5, boundary freeze). In L3, {@link
 * import('./worktree-store.js').WorktreeStore.removeWorktree} tears one sandbox down and {@link
 * import('./worktree-store.js').WorktreeStore.detectOrphans} SURFACES recorded-vs-reality
 * mismatches, then STOP: they are reusable primitives. The operator-facing verbs that ACT on those
 * facts are L8:
 *   - `cleanup` — remove a finished sandbox once its work is PROVEN merged (no silent data loss);
 *   - `unstick` — recover a stuck / locked worktree (e.g. `git worktree repair`/`prune`) safely,
 *     reverting the STUCK flip and re-waking the agent within a BOUNDED window (MNR-3);
 *   - `nuke`    — force-remove a sandbox the operator has explicitly condemned (gated);
 *   - `pause`   — pause an agent's turns via the router seam;
 *   - `stop`    — stop (kill) an agent via the router seam.
 * The "prove the work is merged before removing" safety check is L8's invariant — NOT this layer's.
 *
 * This is a TYPED stub marking that seam — copied from L1's then-throwing live-delivery stub (now the
 * real {@link import('../mail/delivery.js').LiveDelivery}, made real in L7; the same pattern L3-C used
 * for the review gate, since made real in L5): it fails loud (Principle 9) rather than
 * being a silent no-op, because a silent stub is exactly the fallback that hid the prototype's gaps.
 * Nothing in L3 calls it — it exists so the L8 plug-point is a real, typed thing rather than an
 * absence, and so the lack of a cleanup verb in L3 is a deliberate, documented boundary (P7 —
 * gated-by-default holds because the verbs are simply NOT BUILT here). No `co_*` tool is declared.
 */
import type { WorktreeRecord } from './events.js';
import type { WorktreeStore, Orphan, SandboxFs } from './worktree-store.js';
import type { GitExec } from './sling.js';

// ── Shared types ─────────────────────────────────────────────────────────────────────────────────

/**
 * Prove that `branch`'s work is merged into `targetRef`. Returns `true` iff the branch is proven
 * merged — e.g. a `git merge-base --is-ancestor branch targetRef` check, or a recorded merge.
 * Injectable so `cleanup` is testable headless without a real git repo.
 */
export type MergeProbeSeam = (branch: string, targetRef: string) => boolean;

/**
 * Repair/prune stale git worktree metadata from the main repo's `.git/worktrees/…` admin dir.
 * Injectable seam for `unstick` — the real implementation runs `git worktree repair` / `git
 * worktree prune`; in sandbox tests the spy records the call without touching the FS.
 */
export type WorktreeRepairSeam = (repoCwd: string) => void;

/**
 * Router seam for agent-lifecycle operations (`pause`, `stop`, `unstick`'s re-wake side).
 * The live implementation is host-side (the Conductor's router owns agent state); sandbox tests
 * inject a spy. `[host-live]` deferred — wiring the real router is the P7 / Conductor layer.
 */
export interface AgentRouterSeam {
  /**
   * Revert the STUCK flip — the inverse of P4's `markStuck`. After this call the agent is no
   * longer in the STUCK state and can receive new turns (re-wake follows).
   */
  revertStuck(agentId: string): void;
  /** Re-wake the agent so the runtime gives it a new turn (bounded by the reconcile window). */
  rewake(agentId: string): void;
  /** Pause an agent's turns — it will not be given new work until resumed. */
  pause(agentId: string): void;
  /** Stop (kill) an agent. The agent receives no further turns. */
  stop(agentId: string): void;
}

// ── Return types ──────────────────────────────────────────────────────────────────────────────────

/** What `cleanup` returns in dry-run mode: a report of what WOULD be removed, nothing done. */
export interface CleanupDryRun {
  readonly branch: string;
  readonly dryRun: true;
  /** The sandbox path that WOULD be removed (merge is proven; only `dryRun` stops it). */
  readonly wouldRemovePath: string;
  /** Orphans detected alongside this branch (surface-only in dry-run). */
  readonly orphansFound: readonly Orphan[];
}

/** What `cleanup` returns when actually executed (dryRun: false). */
export interface CleanupExecuted {
  readonly branch: string;
  readonly dryRun: false;
  /** The updated record (marked `removed`). */
  readonly removed: WorktreeRecord;
  /** Orphans detected alongside this branch (surface-only — acting on them is the caller's job). */
  readonly orphansFound: readonly Orphan[];
}

export type CleanupReport = CleanupDryRun | CleanupExecuted;

/** What `unstick` returns. */
export interface UnstickReport {
  readonly branch: string;
  /** True iff the git worktree repair/prune seam was invoked. */
  readonly repaired: boolean;
  /** True iff the router's revertStuck + rewake were invoked (bounded window, MNR-3). */
  readonly agentRewoken: boolean;
}

// ── Gate interface ────────────────────────────────────────────────────────────────────────────────

/**
 * The L8 operator-cleanup gate. Extends the typed stub seam with real return types and options;
 * `CleanupGateStub` keeps its loud-fail behavior for every verb (the headless default). The real
 * implementation is `CleanupGateImpl`. These verbs are NEVER registered as agent MCP tools —
 * operator-only, so the completeness gate (AC-L2-3) stays green by construction.
 */
export interface CleanupGate {
  /**
   * Remove a finished sandbox once its work is proven merged. Dry-run by default (reports what
   * WOULD be removed without doing it). Refuses if the branch is not proven merged (no silent
   * data loss). Also reconciles `detectOrphans` alongside the sweep (surface-only).
   */
  cleanup(
    branch: string,
    opts?: { readonly dryRun?: boolean; readonly targetRef?: string },
  ): CleanupReport;
  /**
   * Recover a stuck / locked worktree: run `git worktree repair`/`prune` via the seam, then
   * revert the STUCK flip and re-wake the agent within a BOUNDED window (MNR-3).
   */
  unstick(branch: string, opts?: { readonly repoCwd?: string }): UnstickReport;
  /**
   * Force-remove an explicitly condemned sandbox, bypassing the merge-proof. Gated: requires
   * `{ confirm: true }` (explicit operator authority). Never fires by default.
   */
  nuke(branch: string, opts: { readonly confirm: true }): WorktreeRecord;
  /** Pause an agent's turns via the router seam. */
  pause(agentId: string): void;
  /** Stop (kill) an agent via the router seam. */
  stop(agentId: string): void;
}

// ── Loud-fail stub (preserved, headless default, Principle 9) ────────────────────────────────────

/**
 * The L8 STUB gate. Every verb fails loud (Principle 9) until L8 owns operator cleanup — never a
 * silent no-op. The signatures omit the params the interface declares (TS lets a method ignore
 * trailing parameters) — they always throw regardless of arguments.
 */
export class CleanupGateStub implements CleanupGate {
  // L8 PLUG-POINT (operator cleanup verbs). The production gate must, per verb:
  //  (1) PROVE the work is merged before removing (no silent data loss) — the safety invariant;
  //  (2) call the L3 `removeWorktree` primitive to tear the proven-merged sandbox down;
  //  (3) reconcile `detectOrphans` output (drop an untracked sandbox / re-record or clear a dangling
  //      record), with `unstick`/`nuke` covering the stuck + condemned cases.
  // Until then every verb fails loud (Principle 9).
  cleanup(): CleanupReport {
    throw new Error(
      'CleanupGateStub.cleanup: the operator cleanup verb is not implemented at L3. This is the ' +
        'L8 plug-point: PROVE the work is merged, then call removeWorktree to tear the sandbox ' +
        'down. L3 ships removeWorktree + detectOrphans as primitives — no cleanup verb here (P7).',
    );
  }

  unstick(): UnstickReport {
    throw new Error(
      'CleanupGateStub.unstick: the operator unstick verb is not implemented at L3. This is the ' +
        'L8 plug-point: safely recover a stuck / locked worktree. L3 ships removeWorktree + ' +
        'detectOrphans as primitives — no unstick verb here (P7).',
    );
  }

  nuke(): WorktreeRecord {
    throw new Error(
      'CleanupGateStub.nuke: the operator nuke verb is not implemented at L3. This is the L8 ' +
        'plug-point: force-remove an explicitly condemned sandbox. L3 ships removeWorktree + ' +
        'detectOrphans as primitives — no nuke verb here (P7).',
    );
  }

  pause(): void {
    throw new Error(
      'CleanupGateStub.pause: the operator pause verb is not implemented at L3. This is the ' +
        'L8 plug-point: pause an agent via the router seam.',
    );
  }

  stop(): void {
    throw new Error(
      'CleanupGateStub.stop: the operator stop verb is not implemented at L3. This is the ' +
        'L8 plug-point: stop (kill) an agent via the router seam.',
    );
  }
}

// ── Real implementation deps ──────────────────────────────────────────────────────────────────────

/**
 * Constructor-injected seams for `CleanupGateImpl`. Every external dependency enters here so the
 * implementation is testable headless with NO real git, FS, or router.
 */
export interface CleanupGateDeps {
  /** The worktree store — for `removeWorktree`, `getWorktree`, `detectOrphans`. */
  readonly store: WorktreeStore;
  /** The main repo cwd for git teardown (used by `removeWorktree` and `unstick`'s repair seam). */
  readonly repoCwd: string;
  /**
   * Merge-proof seam: returns `true` iff `branch` is proven merged into `targetRef`. Sandbox:
   * spy (returns configurable boolean); host-side: real `git merge-base --is-ancestor`.
   */
  readonly mergeProbe: MergeProbeSeam;
  /**
   * Worktree repair/prune seam (for `unstick`'s git side). Sandbox: spy; host-side: real
   * `git worktree repair` / `git worktree prune` — `[host-live]`.
   */
  readonly repair: WorktreeRepairSeam;
  /**
   * Router seam for agent-lifecycle (`pause`, `stop`, `unstick` re-wake). Sandbox: spy;
   * host-side: the Conductor's router — `[host-live]`.
   */
  readonly router: AgentRouterSeam;
  /** Mutating git seam passed through to `removeWorktree` (defaults to the real git exec). */
  readonly gitExec?: GitExec;
  /** Sandbox-dir FS seam passed through to `removeWorktree` (defaults to the real FS). */
  readonly fs?: SandboxFs;
}

// ── Real implementation ───────────────────────────────────────────────────────────────────────────

/**
 * The real L8 `CleanupGate`. Builds the operator recovery/cleanup verbs over the L3 primitives
 * (`removeWorktree`, `detectOrphans`) and injected seams (merge-proof, repair, router). None of
 * these verbs is a `ToolSpec` — they are plain functions, operator-only, never mounted as agent
 * MCP tools. The completeness gate (AC-L2-3) stays green by construction.
 */
export class CleanupGateImpl implements CleanupGate {
  private readonly deps: CleanupGateDeps;

  constructor(deps: CleanupGateDeps) {
    this.deps = deps;
  }

  /**
   * Prove the branch is merged into `targetRef` (default `'main'`), then remove the sandbox.
   * Dry-run by default: if `dryRun` is not explicitly `false`, reports what WOULD happen without
   * doing it. Refuses on an unproven-merged branch (no silent data loss, Principle 9).
   */
  cleanup(
    branch: string,
    opts?: { readonly dryRun?: boolean; readonly targetRef?: string },
  ): CleanupReport {
    const dryRun = opts?.dryRun !== false; // default true
    const targetRef = opts?.targetRef ?? 'main';

    const record = this.deps.store.getWorktree(branch);
    if (!record) {
      throw new Error(`CleanupGateImpl.cleanup: no worktree recorded for branch '${branch}'.`);
    }

    // Safety invariant: PROVE the branch is merged before touching anything.
    if (!this.deps.mergeProbe(branch, targetRef)) {
      throw new Error(
        `CleanupGateImpl.cleanup: branch '${branch}' is NOT proven merged into '${targetRef}'. ` +
          'Refusing to remove — no silent data loss (Principle 9).',
      );
    }

    // Detect orphans alongside (surface-only in both modes).
    const orphansFound = this.deps.store.detectOrphans();

    if (dryRun) {
      return { branch, dryRun: true, wouldRemovePath: record.path, orphansFound };
    }

    const removed = this.deps.store.removeWorktree(branch, {
      repoCwd: this.deps.repoCwd,
      gitExec: this.deps.gitExec,
      fs: this.deps.fs,
    });

    return { branch, dryRun: false, removed, orphansFound };
  }

  /**
   * Recover a stuck / locked worktree. Runs `git worktree repair`/`prune` via the seam, then
   * reverts the STUCK flip and re-wakes the agent within the bounded reconcile window (MNR-3).
   * The bounded window is structural: the reconcile loop (P4) drives the detect→nudge→STUCK
   * escalation in tens of seconds; `unstick` reverts the flip so the next reconcile tick can
   * re-issue a turn. The break-signal rides the L6 monitor — never a multi-hour reap.
   */
  unstick(branch: string, opts?: { readonly repoCwd?: string }): UnstickReport {
    const repoCwd = opts?.repoCwd ?? this.deps.repoCwd;

    // 1. Git side: repair/prune stale `.git/worktrees/…` admin metadata.
    this.deps.repair(repoCwd);

    // 2. Router side: revert STUCK flip + re-wake the agent (bounded window, MNR-3).
    this.deps.router.revertStuck(branch);
    this.deps.router.rewake(branch);

    return { branch, repaired: true, agentRewoken: true };
  }

  /**
   * Force-remove an explicitly condemned sandbox, bypassing the merge-proof. Gated: the caller
   * MUST pass `{ confirm: true }` to authorize force-removal. Never fires by default.
   */
  nuke(branch: string, opts: { readonly confirm: true }): WorktreeRecord {
    if (!opts.confirm) {
      throw new Error(
        `CleanupGateImpl.nuke: explicit operator confirmation required. ` +
          `Pass { confirm: true } to force-remove branch '${branch}'.`,
      );
    }
    return this.deps.store.removeWorktree(branch, {
      repoCwd: this.deps.repoCwd,
      gitExec: this.deps.gitExec,
      fs: this.deps.fs,
    });
  }

  /** Pause an agent's turns via the router seam. Host-side: the Conductor's router. `[host-live]` */
  pause(agentId: string): void {
    this.deps.router.pause(agentId);
  }

  /** Stop (kill) an agent via the router seam. Host-side: the Conductor's router. `[host-live]` */
  stop(agentId: string): void {
    this.deps.router.stop(agentId);
  }
}
