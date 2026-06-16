/**
 * Stage 9 · Phase P2 — real engine-backed placement spawn gate.
 *
 * Fills the ReviewerSpawnGateStub (packages/core) with a live launch: receives a placed
 * PlacementRecord for a reviewer seat or slung child, resolves its worktree, builds the isolated
 * launch spec via buildPlacementLaunchSpec (MNR-6), and calls engine.ensureHosted (MNR-5 guard
 * enforces single-launch).
 *
 * Lives in packages/mcp because it depends on ConductorEngine, which imports the MCP SDK.
 */
import {
  openRosterStore,
  openSessionStore,
  type PlacementRecord,
  type ReviewerSpawnGate,
  type RosterStore,
  type SessionStore,
  type WorktreeStore,
} from '@co/core';
import type { ConductorEngine } from './engine.js';
import { buildPlacementLaunchSpec, type CoMcpPaths } from './placement-launch.js';

/** Engine-backed placement spawn gate. Wired by the Conductor host layer (not by L5 core). */
export class EngineReviewerSpawnGate implements ReviewerSpawnGate {
  constructor(
    private readonly engine: ConductorEngine,
    private readonly worktrees: WorktreeStore,
    private readonly isolatedHomeDirFor: (agent: string) => string,
    private readonly coMcpPaths: CoMcpPaths,
    private readonly openRoster: (projectId: string) => RosterStore = openRosterStore,
    private readonly openSessions: (projectId: string) => SessionStore = openSessionStore,
  ) {}

  async spawn(projectId: string, record: PlacementRecord): Promise<void> {
    if (record.kind !== 'placed' || record.provider == null) {
      throw new Error(
        `EngineReviewerSpawnGate.spawn: placement for '${record.agent}' is '${record.kind}' — ` +
          'only a placed placement can launch a pane.',
      );
    }
    if (this.engine.isHosted(projectId, record.agent)) return;
    // Reviewers supply a reviewBranch (the branch being reviewed as the pane cwd); slung children
    // are resolved from their recorded worktree keyed by agent.
    const worktree =
      record.reviewBranch != null
        ? this.worktrees.getWorktree(record.reviewBranch)
        : this.worktrees.listWorktrees().find((w) => !w.removed && w.agent === record.agent);
    if (worktree == null || worktree.removed) {
      throw new Error(
        `EngineReviewerSpawnGate.spawn: no live worktree found for '${record.agent}' ` +
          `(reviewBranch='${String(record.reviewBranch ?? '–')}') — cannot launch pane.`,
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

  async release(projectId: string, agent: string): Promise<void> {
    const errors: Error[] = [];
    try {
      await this.engine.release(projectId, agent);
    } catch (cause) {
      errors.push(releaseError(`release hosted session for '${agent}'`, cause));
    }

    const sessionStillActive = this.sessionStillActive(projectId, agent, errors);
    if (sessionStillActive === false) {
      const roster = this.openRoster(projectId);
      try {
        if (roster.getAgent(agent) != null) roster.removeAgent(agent);
      } catch (cause) {
        errors.push(releaseError(`remove roster row for '${agent}'`, cause));
      } finally {
        roster.close();
      }
    }

    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `EngineReviewerSpawnGate.release: cleanup for '${agent}' failed: ` +
          errors.map((error) => error.message).join('; '),
      );
    }
  }

  private sessionStillActive(
    projectId: string,
    agent: string,
    errors: Error[],
  ): boolean | undefined {
    let sessions: SessionStore | undefined;
    try {
      sessions = this.openSessions(projectId);
      return sessions.getSession(agent) != null;
    } catch (cause) {
      errors.push(releaseError(`inspect session row for '${agent}'`, cause));
      return undefined;
    } finally {
      try {
        sessions?.close();
      } catch (cause) {
        errors.push(releaseError(`close session store for '${agent}'`, cause));
      }
    }
  }
}

function releaseError(operation: string, cause: unknown): Error {
  return new Error(
    `${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    {
      cause,
    },
  );
}
