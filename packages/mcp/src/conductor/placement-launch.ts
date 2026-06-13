/**
 * Stage 9 · Phase P2 — spawn-from-placement: pure launch-spec builder.
 *
 * Converts a placed PlacementRecord + WorktreeRecord into a (HostedIdentity, SpawnSpec) pair
 * ready for ConductorEngine.ensureHosted. Composes buildPaneLaunchConfig for per-pane isolation
 * (MNR-6): the produced SpawnSpec.env references ONLY the isolated home dir, never the user's
 * global CLAUDE_CONFIG_DIR / CODEX_HOME / hooks / MCP servers.
 *
 * PURE — no I/O. Same inputs ⇒ same spec (replay-deterministic). The host-side write of the
 * codex config.toml / prelaunch files + credential copy is [host-live], deferred.
 */
import type { PaneIdentity, PlacementRecord, ProjectId, SpawnSpec, WorktreeRecord } from '@co/core';
import { buildPaneLaunchConfig, parseSubRoleId } from '@co/core';
import type { Role } from '@co/core';
import type { HostedIdentity } from '../live-session-host.js';

/** Co MCP + CLI command paths the pane needs for isolated config. Host-injected; always absolute. */
export interface CoMcpPaths {
  /** Path to the co MCP JSON config forwarded to Claude --mcp-config. */
  readonly coMcpConfig?: string;
  /** Codex MCP server command (must be an absolute path — validated by buildPaneLaunchConfig). */
  readonly coMcpCommand: string;
  /** Codex MCP server args. */
  readonly coMcpArgs?: readonly string[];
  /** Codex hook CLI command (must be an absolute path — validated by buildPaneLaunchConfig). */
  readonly coCliCommand: string;
}

/**
 * Build the PURE per-pane launch spec from a placed PlacementRecord + WorktreeRecord.
 *
 * @param record - A 'placed' placement (kind === 'placed', provider present).
 * @param worktree - The agent's worktree: cwd = worktree.path; parent for identity hierarchy.
 * @param projectId - The project the agent belongs to.
 * @param isolatedHomeDir - Isolated config/home for this pane (NEVER the user's global dir).
 * @param coMcpPaths - Host-injected MCP + CLI paths for the isolated config.
 * @returns The HostedIdentity (engine's authoritative view) + SpawnSpec (what to spawn).
 */
export function buildPlacementLaunchSpec(
  record: PlacementRecord & { readonly kind: 'placed'; readonly provider: string },
  worktree: WorktreeRecord,
  projectId: ProjectId,
  isolatedHomeDir: string,
  coMcpPaths: CoMcpPaths,
): { readonly identity: HostedIdentity; readonly spec: SpawnSpec } {
  const provider = record.provider as 'claude' | 'codex';
  const paneIdentity: PaneIdentity = {
    cwd: worktree.path,
    isolatedHomeDir,
    coMcpConfig: coMcpPaths.coMcpConfig,
    coMcpCommand: coMcpPaths.coMcpCommand,
    coMcpArgs: coMcpPaths.coMcpArgs,
    coCliCommand: coMcpPaths.coCliCommand,
  };
  const paneLaunchConfig = buildPaneLaunchConfig(provider, paneIdentity);

  const parsed = parseSubRoleId(record.role);
  const identity: HostedIdentity = {
    agent: record.agent,
    role: parsed.baseRole as Role,
    ...(parsed.name != null ? { subRole: parsed.name } : {}),
    parent: worktree.parent,
    pane: `pane-${record.agent}`,
    projectId,
    cwd: worktree.path,
    provider,
    resume:
      provider === 'codex'
        ? { provider: 'codex', codexHome: isolatedHomeDir }
        : { provider: 'claude', sessionId: record.agent },
  };

  const spec: SpawnSpec = {
    command: provider,
    args: [...paneLaunchConfig.args],
    cwd: worktree.path,
    env: { ...paneLaunchConfig.env },
    prelaunchFiles: paneLaunchConfig.prelaunchFiles,
  };

  return { identity, spec };
}
