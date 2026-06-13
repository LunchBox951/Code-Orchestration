/**
 * Stage 9 · Phase P2 — real engine-backed ReviewerSpawnGate.
 *
 * Fills the ReviewerSpawnGateStub (packages/core) with a live launch: receives a placed
 * PlacementRecord for a reviewer seat, resolves the review branch's worktree, builds the
 * isolated launch spec via buildPlacementLaunchSpec (MNR-6), and calls engine.ensureHosted
 * (MNR-5 guard enforces single-launch).
 *
 * Lives in packages/mcp because it depends on ConductorEngine, which imports the MCP SDK.
 */
import type { PlacementRecord, ReviewerSpawnGate, WorktreeStore } from '@co/core';
import type { ConductorEngine } from './engine.js';
import { buildPlacementLaunchSpec, type CoMcpPaths } from './placement-launch.js';

/** Engine-backed reviewer spawn gate. Wired by the Conductor host layer (not by L5 core). */
export class EngineReviewerSpawnGate implements ReviewerSpawnGate {
  constructor(
    private readonly engine: ConductorEngine,
    private readonly worktrees: WorktreeStore,
    private readonly isolatedHomeDirFor: (agent: string) => string,
    private readonly coMcpPaths: CoMcpPaths,
  ) {}

  async spawn(projectId: string, record: PlacementRecord): Promise<void> {
    if (record.kind !== 'placed' || record.provider == null) {
      throw new Error(
        `EngineReviewerSpawnGate.spawn: placement for '${record.agent}' is '${record.kind}' — ` +
          'only a placed placement can launch a reviewer pane.',
      );
    }
    const branch = record.reviewBranch;
    if (branch == null) {
      throw new Error(
        `EngineReviewerSpawnGate.spawn: placement for '${record.agent}' has no reviewBranch — ` +
          'cannot resolve the worktree for the reviewer.',
      );
    }
    const worktree = this.worktrees.getWorktree(branch);
    if (worktree == null) {
      throw new Error(
        `EngineReviewerSpawnGate.spawn: no worktree recorded for branch '${branch}' — ` +
          `cannot launch reviewer '${record.agent}'.`,
      );
    }
    const isolatedHomeDir = this.isolatedHomeDirFor(record.agent);
    const { identity, spec } = buildPlacementLaunchSpec(
      record as PlacementRecord & { kind: 'placed'; provider: string },
      worktree,
      projectId,
      isolatedHomeDir,
      this.coMcpPaths,
    );
    await this.engine.ensureHosted(identity, spec);
  }
}
