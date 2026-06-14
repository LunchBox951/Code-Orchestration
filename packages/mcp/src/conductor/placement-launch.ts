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
import type {
  PaneIdentity,
  PlacementRecord,
  PrelaunchFile,
  ProjectId,
  SpawnSpec,
  WorktreeRecord,
} from '@co/core';
import { buildPaneLaunchConfig, parseSubRoleId } from '@co/core';
import type { Role } from '@co/core';
import { dirname } from 'node:path';
import type { HostedIdentity } from '../live-session-host.js';
import {
  CO_AGENT_ENV,
  CO_MCP_BRIDGE_LOG_ENV,
  CO_PARENT_ENV,
  CO_PROJECT_ID_ENV,
  CO_ROLE_ENV,
} from '../context.js';

/** Co MCP + CLI command paths the pane needs for isolated config. Host-injected; always absolute. */
export interface CoMcpPaths {
  /** Path to the co MCP JSON config forwarded to Claude --mcp-config. */
  readonly coMcpConfig?: string;
  /** Co MCP server command (must be an absolute path — validated by buildPaneLaunchConfig). */
  readonly coMcpCommand: string;
  /** Codex MCP server args. */
  readonly coMcpArgs?: readonly string[];
  /**
   * Optional per-pane bridge socket path. When present, provider config launches
   * `co-mcp ... bridge <socket>` so the external stdio MCP process connects back to the
   * Conductor-owned engine session for this pane.
   */
  readonly coMcpBridgeSocketPath?: (isolatedHomeDir: string, agent: string) => string;
  /** Codex hook CLI command (must be an absolute path — validated by buildPaneLaunchConfig). */
  readonly coCliCommand: string;
  /** Optional Codex hook CLI args, e.g. an absolute script path for `node <script>`. */
  readonly coCliArgs?: readonly string[];
  /** Optional host-copied Claude auth file contents for the isolated CLAUDE_CONFIG_DIR. */
  readonly claudeCredentialsJson?: string;
  /** Optional host-copied Codex auth file contents for the isolated CODEX_HOME. */
  readonly codexAuthJson?: string;
}

export interface ProviderAuthPrelaunchPaths {
  readonly claudeCredentialsJson?: string;
  readonly codexAuthJson?: string;
}

export function providerAuthPrelaunchFiles(
  provider: 'claude' | 'codex',
  isolatedHomeDir: string,
  paths: ProviderAuthPrelaunchPaths,
): readonly PrelaunchFile[] {
  const home = isolatedHomeDir.replace(/\/+$/u, '');
  if (provider === 'claude' && paths.claudeCredentialsJson != null) {
    return [{ path: `${home}/.credentials.json`, contents: paths.claudeCredentialsJson }];
  }
  if (provider === 'codex' && paths.codexAuthJson != null) {
    return [{ path: `${home}/auth.json`, contents: paths.codexAuthJson }];
  }
  return [];
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
  const parsed = parseSubRoleId(record.role);
  const mountedRole = parsed.name != null ? `${parsed.baseRole}:${parsed.name}` : parsed.baseRole;
  const bridgeSocketPath = coMcpPaths.coMcpBridgeSocketPath?.(isolatedHomeDir, record.agent);
  const coMcpArgs =
    bridgeSocketPath == null
      ? coMcpPaths.coMcpArgs
      : [...(coMcpPaths.coMcpArgs ?? []), 'bridge', bridgeSocketPath];
  const paneIdentity: PaneIdentity = {
    cwd: worktree.path,
    isolatedHomeDir,
    ...(provider === 'claude'
      ? {
          coMcpConfig:
            coMcpPaths.coMcpConfig ?? `${isolatedHomeDir.replace(/\/+$/u, '')}/mcp/co-mcp.json`,
        }
      : {}),
    coMcpCommand: coMcpPaths.coMcpCommand,
    coMcpArgs,
    coMcpEnv: {
      [CO_AGENT_ENV]: record.agent,
      [CO_ROLE_ENV]: mountedRole,
      [CO_PARENT_ENV]: worktree.parent,
      [CO_PROJECT_ID_ENV]: projectId,
      ...bridgeDiagnosticEnv(isolatedHomeDir, bridgeSocketPath),
    },
    coCliCommand: coMcpPaths.coCliCommand,
    ...(coMcpPaths.coCliArgs != null ? { coCliArgs: coMcpPaths.coCliArgs } : {}),
  };
  const paneLaunchConfig = buildPaneLaunchConfig(provider, paneIdentity);

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
    args: [...paneLaunchConfig.args, ...codexBridgeSocketArgs(provider, bridgeSocketPath)],
    cwd: worktree.path,
    env: { ...paneLaunchConfig.env },
    prelaunchFiles: [
      ...(paneLaunchConfig.prelaunchFiles ?? []),
      ...providerAuthPrelaunchFiles(provider, isolatedHomeDir, coMcpPaths),
    ],
  };

  return { identity, spec };
}

function bridgeDiagnosticEnv(
  isolatedHomeDir: string,
  bridgeSocketPath: string | undefined,
): Record<string, string> {
  if (bridgeSocketPath == null) return {};
  return {
    [CO_MCP_BRIDGE_LOG_ENV]: `${isolatedHomeDir.replace(/\/+$/u, '')}/mcp/bridge.log`,
  };
}

function codexBridgeSocketArgs(
  provider: 'claude' | 'codex',
  bridgeSocketPath: string | undefined,
): readonly string[] {
  if (provider !== 'codex' || bridgeSocketPath == null) return [];
  return ['--add-dir', dirname(bridgeSocketPath)];
}
