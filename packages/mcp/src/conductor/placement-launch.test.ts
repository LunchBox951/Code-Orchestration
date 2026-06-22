/**
 * P2 [sandbox] acceptance for AC-S9-2 — spawn-from-placement / self-launch.
 *
 * Proves over FakePty:
 *   1. buildPlacementLaunchSpec is PURE (same inputs => same spec; deterministic).
 *   2. MNR-6: the produced SpawnSpec.env references ONLY the isolated home dir (never the user's
 *      global CLAUDE_CONFIG_DIR / CODEX_HOME).
 *   3. A PlacementRecord drives engine.ensureHosted: agent.registered + session.created recorded.
 *   4. MNR-5 (engine-wide from the placement entry point): a second ensureHosted for an
 *      already-hosted agent is REFUSED (the launch-authority guard keyed to WorktreeRecord.agent).
 *   5. A placed researcher launches through the same spawn-from-placement path as an implementer.
 *   6. EngineReviewerSpawnGate: a placed reviewer placement launches a reviewer pane.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  FakePty,
  openDispatchStore,
  openRegistry,
  openRosterStore,
  openSessionStore,
  openWorktreeStore,
  roleBasePrompt,
  type PlacementRecord,
  type ProjectId,
  type ProjectRegistry,
  type RosterStore,
  type SessionStore,
  type WorktreeRecord,
  type WorktreeStore,
  type DispatchStore,
} from '@co/core';
import { ConductorEngine, type ConductorEngineDeps, type HostedPane } from './engine.js';
import type { HostedIdentity } from '../live-session-host.js';
import { buildPlacementLaunchSpec, type CoMcpPaths } from './placement-launch.js';
import { EngineReviewerSpawnGate } from './reviewer-gate.js';
import { defaultCoMcpPaths } from './host-launch-paths.js';

// ESC authored as a \u escape so the source holds no raw control byte (pristine-repo rule).
const ESC = '\u001B';
const CLAUDE_READY = ESC + '[2J' + ESC + '[H' + '╭─ Welcome ─╮\r\n❯ \r\n  ? for shortcuts\r\n';

// Test MCP paths (absolute, non-delegating executables).
const TEST_MCP_PATHS: CoMcpPaths = {
  coMcpCommand: '/usr/local/bin/co-mcp',
  coCliCommand: '/usr/local/bin/co',
};

// Cleanup state
const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let engines: ConductorEngine[] = [];
let registries: ProjectRegistry[] = [];
let rosterStores: RosterStore[] = [];
let sessionStores: SessionStore[] = [];
let dispatchStores: DispatchStore[] = [];
let worktreeStores: WorktreeStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  engines = [];
  registries = [];
  rosterStores = [];
  sessionStores = [];
  dispatchStores = [];
  worktreeStores = [];
});

afterEach(async () => {
  for (const engine of engines) {
    try {
      await engine.closeAll();
    } catch {
      /* best-effort */
    }
  }
  for (const c of [
    ...rosterStores,
    ...sessionStores,
    ...dispatchStores,
    ...worktreeStores,
    ...registries,
  ]) {
    try {
      c.close();
    } catch {
      /* best-effort */
    }
  }
  process.env = ORIGINAL_ENV;
  for (const dir of dataDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// Helpers

function makeProject(): { projectId: ProjectId; cwd: string; dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'co-p2-'));
  dataDirs.push(dataDir);
  process.env.CO_DATA_DIR = dataDir;
  const registry = openRegistry();
  registries.push(registry);
  const cwd = join(dataDir, 'repo');
  return { projectId: registry.register(cwd), cwd, dataDir };
}

function seedParentChain(projectId: ProjectId): void {
  const roster = openRosterStore(projectId);
  rosterStores.push(roster);
  roster.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
  roster.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-1' });
}

function recordPlacement(
  projectId: ProjectId,
  agent: string,
  role: string,
  provider: 'claude' | 'codex',
  extras?: Partial<{
    reviewId: string;
    reviewBranch: string;
    reviewTarget: string;
    reviewScope: string;
  }>,
): PlacementRecord {
  const dispatch = openDispatchStore(projectId);
  dispatchStores.push(dispatch);
  return dispatch.recordPlacement(agent, {
    kind: 'placed',
    role,
    work_size: 'technical',
    reasoning_budget: 'standard',
    provider,
    account: `${provider}-default`,
    model: provider === 'claude' ? 'claude-sonnet-4-6' : 'codex-latest',
    effort: 'medium',
    context: 'standard',
    ...(extras?.reviewId != null ? { review_id: extras.reviewId } : {}),
    ...(extras?.reviewBranch != null ? { review_branch: extras.reviewBranch } : {}),
    ...(extras?.reviewTarget != null ? { review_target: extras.reviewTarget } : {}),
    ...(extras?.reviewScope != null
      ? { review_scope: extras.reviewScope as 'worker_merge' | 'phase_merge' | 'pr_merge' }
      : {}),
  });
}

function recordWorktree(
  projectId: ProjectId,
  agent: string,
  branch: string,
  path: string,
): WorktreeRecord {
  const store = openWorktreeStore(projectId);
  worktreeStores.push(store);
  return store.recordWorktree({
    branch,
    baseRef: 'main',
    baseSha: 'abc123',
    path,
    parent: 'lead-1',
    agent,
    role: 'implementer',
  });
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const flush = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i++) await tick();
};

function makeEngine(over: Partial<ConductorEngineDeps> = {}): {
  engine: ConductorEngine;
  pty: FakePty;
} {
  const pty = new FakePty();
  const engine = new ConductorEngine({
    pty,
    makeTransport: () => InMemoryTransport.createLinkedPair(),
    now: () => 0,
    quietWindow: () => new Promise<void>(() => {}),
    injectOptions: { retryDelay: () => new Promise<void>(() => {}) },
    ...over,
  });
  engines.push(engine);
  return { engine, pty };
}

async function hostPaneFromSpec(
  engine: ConductorEngine,
  pty: FakePty,
  identity: HostedIdentity,
  spec?: Parameters<typeof engine.ensureHosted>[1],
): Promise<HostedPane> {
  const ensureP = engine.ensureHosted(identity, spec);
  const pane = pty.panes[pty.panes.length - 1]!;
  pane.emit(CLAUDE_READY);
  return ensureP;
}

// 1. Pure builder

describe('buildPlacementLaunchSpec — pure, deterministic launch-spec builder', () => {
  it('produces the same spec from identical inputs (replay-deterministic)', () => {
    const { projectId, cwd, dataDir } = makeProject();
    const placement = recordPlacement(projectId, 'impl-a', 'implementer', 'claude');
    const worktree = recordWorktree(projectId, 'impl-a', 'co/feat-a', cwd);
    const isolatedHomeDir = join(dataDir, 'isolated', 'impl-a');
    const placed = placement as PlacementRecord & { kind: 'placed'; provider: string };

    const r1 = buildPlacementLaunchSpec(
      placed,
      worktree,
      projectId,
      isolatedHomeDir,
      TEST_MCP_PATHS,
    );
    const r2 = buildPlacementLaunchSpec(
      placed,
      worktree,
      projectId,
      isolatedHomeDir,
      TEST_MCP_PATHS,
    );

    expect(r1.spec).toEqual(r2.spec);
    expect(r1.identity.agent).toBe(r2.identity.agent);
    expect(r1.identity.pane).toBe(r2.identity.pane);
  });

  it('sets identity fields from placement + worktree', () => {
    const { projectId, cwd, dataDir } = makeProject();
    const placement = recordPlacement(projectId, 'impl-b', 'implementer', 'claude');
    const worktree = recordWorktree(projectId, 'impl-b', 'co/feat-b', cwd);
    const isolatedHomeDir = join(dataDir, 'isolated', 'impl-b');

    const { identity } = buildPlacementLaunchSpec(
      placement as PlacementRecord & { kind: 'placed'; provider: string },
      worktree,
      projectId,
      isolatedHomeDir,
      TEST_MCP_PATHS,
    );

    expect(identity.agent).toBe('impl-b');
    expect(identity.role).toBe('implementer');
    expect(identity.projectId).toBe(projectId);
    expect(identity.cwd).toBe(cwd);
    expect(identity.parent).toBe('lead-1');
    expect(identity.provider).toBe('claude');
    expect(identity.pane).toBe('pane-impl-b');
  });

  it('parses sub-role (reviewer:pr) into role + subRole', () => {
    const { projectId, cwd, dataDir } = makeProject();
    const placement = recordPlacement(projectId, 'rev@rev-1', 'reviewer', 'claude');
    const worktree = recordWorktree(projectId, 'rev@rev-1', 'co/impl-1', cwd);
    const isolatedHomeDir = join(dataDir, 'isolated', 'rev');
    const placementWithSubRole = {
      ...placement,
      role: 'reviewer:pr',
    } as PlacementRecord & { kind: 'placed'; provider: string };

    const { identity } = buildPlacementLaunchSpec(
      placementWithSubRole,
      worktree,
      projectId,
      isolatedHomeDir,
      TEST_MCP_PATHS,
    );

    expect(identity.role).toBe('reviewer');
    expect(identity.subRole).toBe('pr');
  });
});

// 2. MNR-6 isolation

describe('MNR-6 — SpawnSpec env references ONLY the isolated home dir', () => {
  it('claude spec: env has ONLY CLAUDE_CONFIG_DIR set to the isolated dir and MCP env is scoped', () => {
    const { projectId, cwd, dataDir } = makeProject();
    const placement = recordPlacement(projectId, 'impl-c', 'implementer', 'claude');
    const worktree = recordWorktree(projectId, 'impl-c', 'co/feat-c', cwd);
    const isolatedHomeDir = join(dataDir, 'isolated', 'impl-c');

    const { spec } = buildPlacementLaunchSpec(
      placement as PlacementRecord & { kind: 'placed'; provider: string },
      worktree,
      projectId,
      isolatedHomeDir,
      TEST_MCP_PATHS,
    );

    // MNR-6: only the isolated dir in env — no leakage of user-global config. CLAUDE_CODE_NO_FLICKER
    // is a static rendering flag (#66), not a path; HOME is the ISOLATED home (RC-5, so `~` cannot
    // resolve to the operator home); LANG is a static locale (RC-6); CO_CLAUDE_STATUSLINE_PATH (#67)
    // points at the per-account statusLine tee file UNDER the isolated home — none weaken isolation.
    expect(spec.env).toEqual({
      CLAUDE_CONFIG_DIR: isolatedHomeDir,
      CLAUDE_CODE_NO_FLICKER: '1',
      CO_CLAUDE_STATUSLINE_PATH: `${isolatedHomeDir}/co-statusline.json`,
      HOME: isolatedHomeDir,
      LANG: 'C.UTF-8',
    });
    expect(spec.env).not.toHaveProperty('CODEX_HOME');
    // --strict-mcp-config suppresses user MCP servers
    expect(spec.args).toContain('--strict-mcp-config');
    const mcpConfig = spec.prelaunchFiles?.find((f) => f.path.endsWith('co-mcp.json'));
    expect(mcpConfig).toBeDefined();
    expect(mcpConfig!.path).toBe(`${isolatedHomeDir}/mcp/co-mcp.json`);
    const parsed = JSON.parse(mcpConfig!.contents) as {
      mcpServers?: { co?: { command?: string; env?: Record<string, string> } };
    };
    expect(parsed.mcpServers?.co?.command).toBe(TEST_MCP_PATHS.coMcpCommand);
    expect(parsed.mcpServers?.co?.env).toEqual({
      CO_AGENT: 'impl-c',
      CO_ROLE: 'implementer',
      CO_PARENT: 'lead-1',
      CO_PROJECT_ID: projectId,
    });
    // F3: with no token configured, GH_TOKEN is absent (no accidental empty/leaked credential).
    expect(parsed.mcpServers?.co?.env).not.toHaveProperty('GH_TOKEN');
  });

  it('F3: a configured ghToken is provisioned into the pane MCP env as GH_TOKEN (and only then)', () => {
    const { projectId, cwd, dataDir } = makeProject();
    const placement = recordPlacement(projectId, 'impl-gh', 'implementer', 'claude');
    const worktree = recordWorktree(projectId, 'impl-gh', 'co/feat-gh', cwd);
    const isolatedHomeDir = join(dataDir, 'isolated', 'impl-gh');

    const { spec } = buildPlacementLaunchSpec(
      placement as PlacementRecord & { kind: 'placed'; provider: string },
      worktree,
      projectId,
      isolatedHomeDir,
      { ...TEST_MCP_PATHS, ghToken: 'gho_test_token' },
    );

    const mcpConfig = spec.prelaunchFiles?.find((f) => f.path.endsWith('co-mcp.json'));
    const parsed = JSON.parse(mcpConfig!.contents) as {
      mcpServers?: { co?: { env?: Record<string, string> } };
    };
    // The token reaches the co MCP server (which runs the gated `gh` publish) — the only channel
    // that survives the pane's sanitized env. It must NOT leak into the pane process env itself.
    expect(parsed.mcpServers?.co?.env?.['GH_TOKEN']).toBe('gho_test_token');
    expect(spec.env).not.toHaveProperty('GH_TOKEN');
  });

  it('RC-1: coMcpExtraEnv (ELECTRON_RUN_AS_NODE) reaches the Claude MCP server env block', () => {
    const { projectId, cwd, dataDir } = makeProject();
    const placement = recordPlacement(projectId, 'impl-el', 'implementer', 'claude');
    const worktree = recordWorktree(projectId, 'impl-el', 'co/feat-el', cwd);
    const isolatedHomeDir = join(dataDir, 'isolated', 'impl-el');

    const { spec } = buildPlacementLaunchSpec(
      placement as PlacementRecord & { kind: 'placed'; provider: string },
      worktree,
      projectId,
      isolatedHomeDir,
      { ...TEST_MCP_PATHS, coMcpExtraEnv: { ELECTRON_RUN_AS_NODE: '1' } },
    );

    const mcpConfig = spec.prelaunchFiles?.find((f) => f.path.endsWith('co-mcp.json'));
    const parsed = JSON.parse(mcpConfig!.contents) as {
      mcpServers?: { co?: { env?: Record<string, string> } };
    };
    // Without this, the provider runs `electron <bin> bridge` with no flag → a GUI Electron, never the
    // Node bridge → the MCP surface never connects. The flag must land in the SERVER env block.
    expect(parsed.mcpServers?.co?.env?.['ELECTRON_RUN_AS_NODE']).toBe('1');
    // It must NOT leak into the pane (provider) process env — only the MCP server child needs it.
    expect(spec.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
  });

  it('RC-1: coMcpExtraEnv (ELECTRON_RUN_AS_NODE) reaches the Codex [mcp_servers.co.env] block', () => {
    const { projectId, cwd, dataDir } = makeProject();
    const placement = recordPlacement(projectId, 'impl-elx', 'implementer', 'codex');
    const worktree = recordWorktree(projectId, 'impl-elx', 'co/feat-elx', cwd);
    const isolatedHomeDir = join(dataDir, 'isolated', 'impl-elx');

    const { spec } = buildPlacementLaunchSpec(
      placement as PlacementRecord & { kind: 'placed'; provider: string },
      worktree,
      projectId,
      isolatedHomeDir,
      { ...TEST_MCP_PATHS, coMcpExtraEnv: { ELECTRON_RUN_AS_NODE: '1' } },
    );

    const configToml = spec.prelaunchFiles!.find((f) => f.path.endsWith('config.toml'));
    expect(configToml!.contents).toContain('[mcp_servers.co.env]');
    expect(configToml!.contents).toContain('ELECTRON_RUN_AS_NODE = "1"');
  });

  it('RC-1: coCliExtraEnv (ELECTRON_RUN_AS_NODE) reaches the Codex hook command only', () => {
    const { projectId, cwd, dataDir } = makeProject();
    const placement = recordPlacement(projectId, 'impl-hook-elx', 'implementer', 'codex');
    const worktree = recordWorktree(projectId, 'impl-hook-elx', 'co/feat-hook-elx', cwd);
    const isolatedHomeDir = join(dataDir, 'isolated', 'impl-hook-elx');

    const { spec } = buildPlacementLaunchSpec(
      placement as PlacementRecord & { kind: 'placed'; provider: string },
      worktree,
      projectId,
      isolatedHomeDir,
      {
        ...TEST_MCP_PATHS,
        coCliCommand: '/electron',
        coCliArgs: ['/repo/packages/cli/dist/index.js'],
        coCliExtraEnv: { ELECTRON_RUN_AS_NODE: '1' },
      },
    );

    const configToml = spec.prelaunchFiles!.find((f) => f.path.endsWith('config.toml'));
    expect(configToml!.contents).toContain(
      'command = "ELECTRON_RUN_AS_NODE=\\"1\\" \\"/electron\\" \\"/repo/packages/cli/dist/index.js\\" hook codex-block-list',
    );
    expect(spec.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
  });

  it('RC-5: the pane HOME is the ISOLATED home dir, never the operator home', () => {
    const { projectId, cwd, dataDir } = makeProject();
    for (const provider of ['claude', 'codex'] as const) {
      const agent = `impl-home-${provider}`;
      const placement = recordPlacement(projectId, agent, 'implementer', provider);
      const worktree = recordWorktree(projectId, agent, `co/${agent}`, cwd);
      const isolatedHomeDir = join(dataDir, 'isolated', agent);
      const { spec } = buildPlacementLaunchSpec(
        placement as PlacementRecord & { kind: 'placed'; provider: string },
        worktree,
        projectId,
        isolatedHomeDir,
        TEST_MCP_PATHS,
      );
      expect(spec.env['HOME']).toBe(isolatedHomeDir);
      // Defensive: never the real operator home.
      expect(spec.env['HOME']).not.toBe(process.env['HOME']);
    }
  });

  it('codex spec: env has ONLY CODEX_HOME set to the isolated dir; prelaunch has approval_policy=never', () => {
    const { projectId, cwd, dataDir } = makeProject();
    const placement = recordPlacement(projectId, 'impl-d', 'implementer', 'codex');
    const worktree = recordWorktree(projectId, 'impl-d', 'co/feat-d', cwd);
    const isolatedHomeDir = join(dataDir, 'isolated', 'impl-d');

    const { spec } = buildPlacementLaunchSpec(
      placement as PlacementRecord & { kind: 'placed'; provider: string },
      worktree,
      projectId,
      isolatedHomeDir,
      TEST_MCP_PATHS,
    );

    // MNR-6: only the isolated dir in env (+ isolated HOME for RC-5 and a static LANG for RC-6).
    expect(spec.env).toEqual({
      CODEX_HOME: isolatedHomeDir,
      HOME: isolatedHomeDir,
      LANG: 'C.UTF-8',
    });
    expect(spec.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    // prelaunch files carry the isolated config.toml (approval_policy = "never")
    expect(spec.prelaunchFiles).toBeDefined();
    const configToml = spec.prelaunchFiles!.find((f) => f.path.endsWith('config.toml'));
    expect(configToml).toBeDefined();
    expect(configToml!.contents).toContain('approval_policy = "never"');
    expect(configToml!.contents).toContain('[mcp_servers.co.env]');
    expect(configToml!.contents).toContain('CO_AGENT = "impl-d"');
    expect(configToml!.contents).toContain('CO_ROLE = "implementer"');
    expect(configToml!.contents).toContain('CO_PARENT = "lead-1"');
    expect(configToml!.contents).toContain(`CO_PROJECT_ID = "${projectId}"`);
  });

  it('uses a per-pane bridge socket in Claude and Codex MCP launch config when supplied', () => {
    const { projectId, cwd, dataDir } = makeProject();
    const bridgePaths: CoMcpPaths = {
      ...TEST_MCP_PATHS,
      coMcpArgs: ['dist/bin.js'],
      coMcpBridgeSocketPath: (isolatedHomeDir) => `${isolatedHomeDir}/mcp/co-mcp.sock`,
    };

    for (const provider of ['claude', 'codex'] as const) {
      const agent = `impl-bridge-${provider}`;
      const placement = recordPlacement(projectId, agent, 'implementer', provider);
      const worktree = recordWorktree(projectId, agent, `co/${agent}`, cwd);
      const isolatedHomeDir = join(dataDir, 'isolated', agent);
      const { spec } = buildPlacementLaunchSpec(
        placement as PlacementRecord & { kind: 'placed'; provider: string },
        worktree,
        projectId,
        isolatedHomeDir,
        bridgePaths,
      );

      if (provider === 'claude') {
        const configPath = spec.args[spec.args.indexOf('--mcp-config') + 1];
        const config = spec.prelaunchFiles?.find((file) => file.path === configPath);
        const parsed = JSON.parse(config!.contents) as {
          mcpServers?: { co?: { args?: string[]; env?: Record<string, string> } };
        };
        expect(parsed.mcpServers?.co?.args).toEqual([
          'dist/bin.js',
          'bridge',
          `${isolatedHomeDir}/mcp/co-mcp.sock`,
        ]);
        expect(parsed.mcpServers?.co?.env?.['CO_MCP_BRIDGE_LOG']).toBe(
          `${isolatedHomeDir}/mcp/bridge.log`,
        );
      } else {
        expect(spec.args).toEqual([
          '--dangerously-bypass-hook-trust',
          // #78: non-interactive tool-approval flag so a hosted codex pane never deadlocks on the
          // MCP-tool approval prompt (PLACEHOLDER — pending live verification).
          '--ask-for-approval',
          'never',
          // Role base-prompt config override (PR D item 1) sits between the approval flag and the
          // bridge --add-dir; it carries the JSON-encoded implementer base prompt.
          '-c',
          `developer_instructions=${JSON.stringify(roleBasePrompt('implementer'))}`,
          '--add-dir',
          `${isolatedHomeDir}/mcp`,
        ]);
        const configToml = spec.prelaunchFiles?.find((file) => file.path.endsWith('/config.toml'));
        expect(configToml!.contents).toContain('args = ["dist/bin.js", "bridge", "');
        expect(configToml!.contents).toContain(`${isolatedHomeDir}/mcp/co-mcp.sock`);
        expect(configToml!.contents).toContain(
          `CO_MCP_BRIDGE_LOG = "${isolatedHomeDir}/mcp/bridge.log"`,
        );
      }
    }
  });

  it('default Codex bridge args grant only the private bridge socket directory', () => {
    const { projectId, cwd, dataDir } = makeProject();
    const agent = 'impl-default-bridge';
    const placement = recordPlacement(projectId, agent, 'implementer', 'codex');
    const worktree = recordWorktree(projectId, agent, 'co/default-bridge', cwd);
    const isolatedHomeDir = join(dataDir, 'isolated', agent);
    const defaultPaths = defaultCoMcpPaths({
      argv: ['node', '/repo/packages/mcp/dist/bin.js'],
      env: { CO_CLI_COMMAND: '/repo/packages/cli/dist/index.js' },
      nodeCommand: '/usr/bin/node',
    });
    const socketPath = defaultPaths.coMcpBridgeSocketPath?.(isolatedHomeDir, agent);
    expect(socketPath).toBeDefined();

    const { spec } = buildPlacementLaunchSpec(
      placement as PlacementRecord & { kind: 'placed'; provider: string },
      worktree,
      projectId,
      isolatedHomeDir,
      defaultPaths,
    );

    const bridgeDir = dirname(socketPath!);
    expect(bridgeDir).not.toBe(tmpdir());
    expect(socketPath).toBe(join(bridgeDir, 'bridge.sock'));
    expect(spec.args).toEqual([
      '--dangerously-bypass-hook-trust',
      '--ask-for-approval', // #78 non-interactive tool approval (PLACEHOLDER)
      'never',
      '-c',
      `developer_instructions=${JSON.stringify(roleBasePrompt('implementer'))}`,
      '--add-dir',
      bridgeDir,
    ]);
    const configToml = spec.prelaunchFiles?.find((file) => file.path.endsWith('/config.toml'));
    expect(configToml!.contents).toContain(`"bridge", "${socketPath}"`);
  });
});

// 3. Spawn from placement: agent.registered + session.created

describe('spawn-from-placement — engine spawns pane, records agent.registered + session.created', () => {
  it('given a PlacementRecord, ensureHosted records both agent.registered and session.created', async () => {
    const { projectId, cwd, dataDir } = makeProject();
    seedParentChain(projectId);
    const placement = recordPlacement(projectId, 'impl-e', 'implementer', 'claude');
    const worktree = recordWorktree(projectId, 'impl-e', 'co/feat-e', cwd);
    const isolatedHomeDir = join(dataDir, 'isolated', 'impl-e');

    const { identity, spec } = buildPlacementLaunchSpec(
      placement as PlacementRecord & { kind: 'placed'; provider: string },
      worktree,
      projectId,
      isolatedHomeDir,
      TEST_MCP_PATHS,
    );

    const { engine, pty } = makeEngine();
    await hostPaneFromSpec(engine, pty, identity, spec);

    // agent.registered
    const roster = openRosterStore(projectId);
    rosterStores.push(roster);
    const agentRecord = roster.getAgent('impl-e');
    expect(agentRecord).toBeDefined();
    expect(agentRecord!.agentId).toBe('impl-e');
    expect(agentRecord!.role).toBe('implementer');

    // session.created
    const sessions = openSessionStore(projectId);
    sessionStores.push(sessions);
    const sessionRecord = sessions.getSession('impl-e');
    expect(sessionRecord).toBeDefined();
    expect(sessionRecord!.agentId).toBe('impl-e');
    expect(sessionRecord!.provider).toBe('claude');

    expect(engine.isHosted(projectId, 'impl-e')).toBe(true);

    // spawned pane used the isolated spec (MNR-6)
    expect(pty.panes[0]!.spec.env['CLAUDE_CONFIG_DIR']).toBe(isolatedHomeDir);
  });
});

// 4. MNR-5 from the placement entry point

describe('MNR-5 (engine-wide from placement entry point) — second spawn for an already-hosted agent refused', () => {
  it('refuses a second ensureHosted for the same agent derived from the same placement', async () => {
    const { projectId, cwd, dataDir } = makeProject();
    seedParentChain(projectId);
    const placement = recordPlacement(projectId, 'impl-f', 'implementer', 'claude');
    const worktree = recordWorktree(projectId, 'impl-f', 'co/feat-f', cwd);
    const isolatedHomeDir = join(dataDir, 'isolated', 'impl-f');

    const { identity, spec } = buildPlacementLaunchSpec(
      placement as PlacementRecord & { kind: 'placed'; provider: string },
      worktree,
      projectId,
      isolatedHomeDir,
      TEST_MCP_PATHS,
    );

    const { engine, pty } = makeEngine();
    await hostPaneFromSpec(engine, pty, identity, spec);

    // Second host request from the same placement must be refused (MNR-5).
    const { identity: id2, spec: spec2 } = buildPlacementLaunchSpec(
      placement as PlacementRecord & { kind: 'placed'; provider: string },
      worktree,
      projectId,
      isolatedHomeDir,
      TEST_MCP_PATHS,
    );
    await expect(engine.ensureHosted(id2, spec2)).rejects.toThrow(/already hosted.*MNR-5/);
  });
});

// 5. Researcher placement — same spawn-from-placement path

describe('researcher placement — spawns through the same spawn-from-placement path', () => {
  it('a placed researcher launches a pane with agent.registered', async () => {
    const { projectId, cwd, dataDir } = makeProject();
    seedParentChain(projectId);
    const placement = recordPlacement(projectId, 'res-g', 'researcher', 'claude');
    const worktree = recordWorktree(projectId, 'res-g', 'co/research-g', cwd);
    const isolatedHomeDir = join(dataDir, 'isolated', 'res-g');

    const { identity, spec } = buildPlacementLaunchSpec(
      placement as PlacementRecord & { kind: 'placed'; provider: string },
      worktree,
      projectId,
      isolatedHomeDir,
      TEST_MCP_PATHS,
    );

    expect(identity.role).toBe('researcher');

    const { engine, pty } = makeEngine();
    await hostPaneFromSpec(engine, pty, identity, spec);

    expect(engine.isHosted(projectId, 'res-g')).toBe(true);

    const roster = openRosterStore(projectId);
    rosterStores.push(roster);
    expect(roster.getAgent('res-g')?.role).toBe('researcher');
  });
});

// 6. EngineReviewerSpawnGate — reviewer pane launched from placement

describe('EngineReviewerSpawnGate — launches a reviewer pane from a placed reviewer placement', () => {
  it('spawn() resolves the branch worktree, builds identity, and calls ensureHosted', async () => {
    const { projectId, cwd, dataDir } = makeProject();
    seedParentChain(projectId);

    // The branch being reviewed and its worktree
    const implBranch = 'co/impl-h';
    recordWorktree(projectId, 'impl-h', implBranch, cwd);

    // Reviewer placement for that branch
    const reviewerAgent = 'reviewer@rev-h';
    const reviewPlacement = recordPlacement(projectId, reviewerAgent, 'reviewer', 'claude', {
      reviewId: 'rev-h',
      reviewBranch: implBranch,
      reviewTarget: 'main',
      reviewScope: 'worker_merge',
    });

    const { engine, pty } = makeEngine();
    // The worktree store is the last one pushed
    const wtStore = worktreeStores[worktreeStores.length - 1]!;
    const gate = new EngineReviewerSpawnGate(
      engine,
      wtStore,
      (agent) => join(dataDir, 'isolated', agent),
      TEST_MCP_PATHS,
    );

    // Drive the pane in parallel with spawn
    const spawnPromise = gate.spawn(projectId, reviewPlacement);
    await flush();
    pty.panes[0]!.emit(CLAUDE_READY);
    await spawnPromise;

    expect(engine.isHosted(projectId, reviewerAgent)).toBe(true);

    const roster = openRosterStore(projectId);
    rosterStores.push(roster);
    expect(roster.getAgent(reviewerAgent)?.role).toBe('reviewer');

    const sessions = openSessionStore(projectId);
    sessionStores.push(sessions);
    const sessionRecord = sessions.getSession(reviewerAgent);
    expect(sessionRecord).toBeDefined();
    expect(sessionRecord!.agentId).toBe(reviewerAgent);
  });

  it('throws if placement kind is waiting (not placed)', async () => {
    const { projectId } = makeProject();
    const { engine } = makeEngine();
    const wtStore = openWorktreeStore(projectId);
    worktreeStores.push(wtStore);
    const gate = new EngineReviewerSpawnGate(
      engine,
      wtStore,
      (agent) => `/isolated/${agent}`,
      TEST_MCP_PATHS,
    );

    const waitingPlacement: PlacementRecord = {
      seq: 1,
      agent: 'reviewer@rev-x',
      role: 'reviewer',
      workSize: 'technical',
      reasoningBudget: 'standard',
      kind: 'waiting',
      reason: 'provider at capacity',
      maxedProviders: ['claude'],
      maxedAccounts: [],
      unavailableProviders: [],
      unavailableAccounts: [],
      recordedTs: 0,
    };
    await expect(gate.spawn(projectId, waitingPlacement)).rejects.toThrow(
      /only a placed placement/,
    );
  });

  it('spawn() resolves a slung child worktree by AGENT (no reviewBranch) and calls ensureHosted', async () => {
    const { projectId, cwd, dataDir } = makeProject();
    seedParentChain(projectId);

    // Slung implementer: worktree keyed to the child agent on a normal branch — NO reviewBranch.
    // Proves the gate's generic fallback: listWorktrees().find(w => w.agent === record.agent).
    const childAgent = 'impl-slung-g';
    recordWorktree(projectId, childAgent, 'co/impl-slung-g', cwd);
    const childPlacement = recordPlacement(projectId, childAgent, 'implementer', 'claude');

    const { engine, pty } = makeEngine();
    const wtStore = worktreeStores[worktreeStores.length - 1]!;
    const gate = new EngineReviewerSpawnGate(
      engine,
      wtStore,
      (agent) => join(dataDir, 'isolated', agent),
      TEST_MCP_PATHS,
    );

    // Drive the pane in parallel with spawn (agent-lookup path, not reviewBranch path)
    const spawnPromise = gate.spawn(projectId, childPlacement);
    await flush();
    pty.panes[0]!.emit(CLAUDE_READY);
    await spawnPromise;

    expect(engine.isHosted(projectId, childAgent)).toBe(true);

    const roster = openRosterStore(projectId);
    rosterStores.push(roster);
    expect(roster.getAgent(childAgent)?.role).toBe('implementer');

    const sessions = openSessionStore(projectId);
    sessionStores.push(sessions);
    expect(sessions.getSession(childAgent)?.agentId).toBe(childAgent);

    // MNR-5 through the gate: a second spawn for the same child agent is an idempotent no-op.
    await expect(gate.spawn(projectId, childPlacement)).resolves.toBeUndefined();
    expect(pty.panes).toHaveLength(1);
  });

  it('release() stops a rollback-spawned slung child and removes its roster row', async () => {
    const { projectId, cwd, dataDir } = makeProject();
    seedParentChain(projectId);

    const childAgent = 'impl-rollback-i';
    recordWorktree(projectId, childAgent, 'co/impl-rollback-i', cwd);
    const childPlacement = recordPlacement(projectId, childAgent, 'implementer', 'claude');

    const { engine, pty } = makeEngine();
    const wtStore = worktreeStores[worktreeStores.length - 1]!;
    const gate = new EngineReviewerSpawnGate(
      engine,
      wtStore,
      (agent) => join(dataDir, 'isolated', agent),
      TEST_MCP_PATHS,
    );

    const spawnPromise = gate.spawn(projectId, childPlacement);
    await flush();
    pty.panes[0]!.emit(CLAUDE_READY);
    await spawnPromise;

    expect(engine.isHosted(projectId, childAgent)).toBe(true);
    await gate.release(projectId, childAgent);
    expect(engine.isHosted(projectId, childAgent)).toBe(false);

    const roster = openRosterStore(projectId);
    rosterStores.push(roster);
    expect(roster.getAgent(childAgent)).toBeUndefined();

    const sessions = openSessionStore(projectId);
    sessionStores.push(sessions);
    expect(sessions.getSession(childAgent)).toBeUndefined();
  });

  it('release() removes the roster row when session cleanup completed before close reported an error', async () => {
    const { projectId, cwd, dataDir } = makeProject();
    seedParentChain(projectId);

    const childAgent = 'impl-rollback-partial';
    recordWorktree(projectId, childAgent, 'co/impl-rollback-partial', cwd);
    const childPlacement = recordPlacement(projectId, childAgent, 'implementer', 'claude');

    const { engine, pty } = makeEngine();
    const wtStore = worktreeStores[worktreeStores.length - 1]!;
    const gate = new EngineReviewerSpawnGate(
      engine,
      wtStore,
      (agent) => join(dataDir, 'isolated', agent),
      TEST_MCP_PATHS,
    );

    const spawnPromise = gate.spawn(projectId, childPlacement);
    await flush();
    pty.panes[0]!.emit(CLAUDE_READY);
    await spawnPromise;
    const hosted = engine.getHosted(projectId, childAgent);
    expect(hosted).toBeDefined();
    const originalClose = hosted!.session.close.bind(hosted!.session);
    hosted!.session.close = async () => {
      await originalClose();
      throw new Error('session close failed after cleanup');
    };

    await expect(gate.release(projectId, childAgent)).rejects.toThrow(
      /session close failed after cleanup/,
    );
    expect(engine.isHosted(projectId, childAgent)).toBe(false);

    const roster = openRosterStore(projectId);
    rosterStores.push(roster);
    expect(roster.getAgent(childAgent)).toBeUndefined();

    const sessions = openSessionStore(projectId);
    sessionStores.push(sessions);
    expect(sessions.getSession(childAgent)).toBeUndefined();
  });
});

// 7. EngineReviewerSpawnGate — no-worktree fallback (nit-b)

describe('EngineReviewerSpawnGate — no-worktree fallback throws cleanly', () => {
  it('throws when no worktree is found for the placement agent via the generic agent-lookup path', async () => {
    // Negative test: a placed placement with NO recorded worktree for its agent must throw with a
    // descriptive error rather than silently doing nothing or crashing with a null-deref.
    // This exercises the fallback branch:
    //   listWorktrees().find(w => !w.removed && w.agent === record.agent) → undefined → throw.
    const { projectId } = makeProject();
    const { engine } = makeEngine();
    const wtStore = openWorktreeStore(projectId);
    worktreeStores.push(wtStore);
    const gate = new EngineReviewerSpawnGate(
      engine,
      wtStore,
      (agent) => `/isolated/${agent}`,
      TEST_MCP_PATHS,
    );

    // A placed placement whose agent has NO worktree recorded → generic lookup returns undefined.
    const placement = recordPlacement(projectId, 'impl-no-wt', 'implementer', 'claude');

    await expect(gate.spawn(projectId, placement)).rejects.toThrow(
      /no live worktree found.*impl-no-wt/,
    );
  });

  it('throws when reviewBranch is set but no worktree is recorded for that branch', async () => {
    // Exercises the reviewer branch-keyed lookup path:
    //   worktrees.getWorktree(record.reviewBranch) → null → throw.
    const { projectId } = makeProject();
    const { engine } = makeEngine();
    const wtStore = openWorktreeStore(projectId);
    worktreeStores.push(wtStore);
    const gate = new EngineReviewerSpawnGate(
      engine,
      wtStore,
      (agent) => `/isolated/${agent}`,
      TEST_MCP_PATHS,
    );

    // Reviewer placement referencing a branch that has no worktree on record.
    const placement = recordPlacement(projectId, 'reviewer@rev-no-wt', 'reviewer', 'claude', {
      reviewId: 'rev-no-wt',
      reviewBranch: 'co/branch-that-does-not-exist',
      reviewTarget: 'main',
      reviewScope: 'worker_merge',
    });

    await expect(gate.spawn(projectId, placement)).rejects.toThrow(
      /no live worktree found.*reviewer@rev-no-wt/,
    );
  });

  it('throws when reviewBranch points at a removed worktree record', async () => {
    const { projectId, cwd } = makeProject();
    const branch = 'co/removed-review-branch';
    const projectDataDir = registries[registries.length - 1]!.dataDirFor(projectId);
    recordWorktree(
      projectId,
      'impl-removed',
      branch,
      join(projectDataDir, 'worktrees', 'co', 'removed'),
    );
    const wtStore = worktreeStores[worktreeStores.length - 1]!;
    wtStore.removeWorktree(branch, {
      repoCwd: cwd,
      gitExec: () => {},
      fs: {
        exists: () => false,
        isSymlink: () => false,
        realpath: (path) => path,
        removeDir: () => {},
      },
    });
    const { engine } = makeEngine();
    const gate = new EngineReviewerSpawnGate(
      engine,
      wtStore,
      (agent) => `/isolated/${agent}`,
      TEST_MCP_PATHS,
    );
    const placement = recordPlacement(projectId, 'reviewer@rev-removed', 'reviewer', 'claude', {
      reviewId: 'rev-removed',
      reviewBranch: branch,
      reviewTarget: 'main',
      reviewScope: 'worker_merge',
    });

    await expect(gate.spawn(projectId, placement)).rejects.toThrow(
      /no live worktree found.*reviewer@rev-removed/i,
    );
  });
});

// 8. Researcher seat + engine-wide single-launch authority (AC-S10-2.3 + AC-S10-2.4 / MNR-5)

describe('researcher seat — engine-wide single-launch authority (AC-S10-2.3 + MNR-5 / AC-S10-2.4)', () => {
  it('a placed researcher is hosted through the same role-agnostic launch path; MNR-5 refuses a second host', async () => {
    const { projectId, cwd, dataDir } = makeProject();
    seedParentChain(projectId);

    // PLACED RESEARCHER seat — no reviewer-specific fields (proves the launch path is role-agnostic,
    // not reviewer-special-cased). A normal branch, NOT a reviewBranch.
    const placement = recordPlacement(projectId, 'res-mnr5', 'researcher', 'claude');
    const worktree = recordWorktree(projectId, 'res-mnr5', 'co/research-mnr5', cwd);
    const isolatedHomeDir = join(dataDir, 'isolated', 'res-mnr5');

    const { identity, spec } = buildPlacementLaunchSpec(
      placement as PlacementRecord & { kind: 'placed'; provider: string },
      worktree,
      projectId,
      isolatedHomeDir,
      TEST_MCP_PATHS,
    );

    expect(identity.role).toBe('researcher');

    const { engine, pty } = makeEngine();
    await hostPaneFromSpec(engine, pty, identity, spec);

    // AC-S10-2.3: researcher pane is hosted; roster + session records carry role 'researcher'.
    expect(engine.isHosted(projectId, 'res-mnr5')).toBe(true);
    const roster = openRosterStore(projectId);
    rosterStores.push(roster);
    expect(roster.getAgent('res-mnr5')?.role).toBe('researcher');
    const sessions = openSessionStore(projectId);
    sessionStores.push(sessions);
    expect(sessions.getSession('res-mnr5')?.agentId).toBe('res-mnr5');

    // AC-S10-2.4 / MNR-5: a second ensureHosted for the SAME agent is REFUSED — the guard is keyed
    // to the agent id, not the role. Proves the launch authority is engine-wide, not role-scoped.
    const { identity: id2, spec: spec2 } = buildPlacementLaunchSpec(
      placement as PlacementRecord & { kind: 'placed'; provider: string },
      worktree,
      projectId,
      isolatedHomeDir,
      TEST_MCP_PATHS,
    );
    await expect(engine.ensureHosted(id2, spec2)).rejects.toThrow(/already hosted.*MNR-5/);
  });
});

// 7. Role base-prompt wiring (PR D item 1): the repo-agnostic per-role base prompt must reach the
//    SPAWNED SpawnSpec.args. This is the load-bearing end-to-end check — the builder only appends
//    the prompt when PaneIdentity.role is set, and buildPlacementLaunchSpec is the production caller
//    that must thread `identity.role`. Without that wiring the prompt is a dead no-op in production.

describe('role base-prompt reaches the spawned SpawnSpec.args (PR D — item 1 wiring)', () => {
  it('claude: args carry --append-system-prompt with the role base prompt for the launched role', () => {
    const { projectId, cwd, dataDir } = makeProject();
    const placement = recordPlacement(projectId, 'impl-bp', 'implementer', 'claude');
    const worktree = recordWorktree(projectId, 'impl-bp', 'co/feat-bp', cwd);
    const isolatedHomeDir = join(dataDir, 'isolated', 'impl-bp');

    const { spec } = buildPlacementLaunchSpec(
      placement as PlacementRecord & { kind: 'placed'; provider: string },
      worktree,
      projectId,
      isolatedHomeDir,
      TEST_MCP_PATHS,
    );

    const flagIdx = spec.args.indexOf('--append-system-prompt');
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    // The value immediately follows the flag and is EXACTLY the implementer base prompt.
    expect(spec.args[flagIdx + 1]).toBe(roleBasePrompt('implementer'));
  });

  it('codex: args carry the codex base-prompt config override for the launched role', () => {
    const { projectId, cwd, dataDir } = makeProject();
    const placement = recordPlacement(projectId, 'impl-cx', 'implementer', 'codex');
    const worktree = recordWorktree(projectId, 'impl-cx', 'co/feat-cx', cwd);
    const isolatedHomeDir = join(dataDir, 'isolated', 'impl-cx');

    const { spec } = buildPlacementLaunchSpec(
      placement as PlacementRecord & { kind: 'placed'; provider: string },
      worktree,
      projectId,
      isolatedHomeDir,
      TEST_MCP_PATHS,
    );

    const flagIdx = spec.args.indexOf('-c');
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    const override = spec.args[flagIdx + 1] ?? '';
    // key=<json-string>; the JSON-encoded value embeds the exact role base prompt.
    expect(override).toContain('developer_instructions=');
    expect(override).toContain(JSON.stringify(roleBasePrompt('implementer')));
  });

  it('sub-role launches append the shipped approach focus to the base prompt', () => {
    const { projectId, cwd, dataDir } = makeProject();
    const placement = {
      ...recordPlacement(projectId, 'rev-pr-bp', 'reviewer', 'claude'),
      role: 'reviewer:pr',
    } as PlacementRecord & { kind: 'placed'; provider: string };
    const worktree = recordWorktree(projectId, 'rev-pr-bp', 'co/feat-rev-pr', cwd);
    const isolatedHomeDir = join(dataDir, 'isolated', 'rev-pr-bp');

    const { spec } = buildPlacementLaunchSpec(
      placement,
      worktree,
      projectId,
      isolatedHomeDir,
      TEST_MCP_PATHS,
    );

    const flagIdx = spec.args.indexOf('--append-system-prompt');
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    const prompt = spec.args[flagIdx + 1] ?? '';
    expect(prompt).toContain('Sub-role focus (reviewer:pr)');
    expect(prompt).toContain('PR review');
    expect(prompt).toContain('co-orchestrated reviewer');
  });

  it('codex sub-role launches carry mounted CO_ROLE and developer_instructions focus', () => {
    const { projectId, cwd, dataDir } = makeProject();
    const placement = recordPlacement(projectId, 'impl-test-cx', 'implementer:test', 'codex');
    const worktree = recordWorktree(projectId, 'impl-test-cx', 'co/feat-impl-test', cwd);
    const isolatedHomeDir = join(dataDir, 'isolated', 'impl-test-cx');

    const { identity, spec } = buildPlacementLaunchSpec(
      placement as PlacementRecord & { kind: 'placed'; provider: string },
      worktree,
      projectId,
      isolatedHomeDir,
      TEST_MCP_PATHS,
    );

    expect(identity.role).toBe('implementer');
    expect(identity.subRole).toBe('test');
    const flagIdx = spec.args.indexOf('-c');
    expect(flagIdx).toBeGreaterThanOrEqual(0);
    const override = spec.args[flagIdx + 1] ?? '';
    expect(override).toContain('developer_instructions=');
    expect(override).toContain('Sub-role focus (implementer:test)');
    expect(override).toContain('test-first');
    const configToml = spec.prelaunchFiles?.find((file) => file.path.endsWith('/config.toml'));
    expect(configToml).toBeDefined();
    expect(configToml!.contents).toContain('CO_ROLE = "implementer:test"');
  });

  it('researcher launches through the same path and gets the researcher base prompt', () => {
    const { projectId, cwd, dataDir } = makeProject();
    const placement = recordPlacement(projectId, 'res-bp', 'researcher', 'claude');
    const worktree = recordWorktree(projectId, 'res-bp', 'co/feat-resbp', cwd);
    const isolatedHomeDir = join(dataDir, 'isolated', 'res-bp');

    const { spec } = buildPlacementLaunchSpec(
      placement as PlacementRecord & { kind: 'placed'; provider: string },
      worktree,
      projectId,
      isolatedHomeDir,
      TEST_MCP_PATHS,
    );

    const flagIdx = spec.args.indexOf('--append-system-prompt');
    expect(spec.args[flagIdx + 1]).toBe(roleBasePrompt('researcher'));
    // The prompt names the role — proof it is role-specific, not a shared constant.
    expect(roleBasePrompt('researcher')).toContain('researcher');
    expect(roleBasePrompt('researcher')).not.toBe(roleBasePrompt('implementer'));
  });
});
