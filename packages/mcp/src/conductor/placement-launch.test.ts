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
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  FakePty,
  openDispatchStore,
  openRegistry,
  openRosterStore,
  openSessionStore,
  openWorktreeStore,
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
  it('claude spec: env has ONLY CLAUDE_CONFIG_DIR set to the isolated dir', () => {
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

    // MNR-6: only the isolated dir in env — no leakage of user-global config
    expect(spec.env).toEqual({ CLAUDE_CONFIG_DIR: isolatedHomeDir });
    expect(spec.env).not.toHaveProperty('CODEX_HOME');
    // --strict-mcp-config suppresses user MCP servers
    expect(spec.args).toContain('--strict-mcp-config');
    // no CODEX-style prelaunch files for claude
    expect(spec.prelaunchFiles ?? []).toHaveLength(0);
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

    // MNR-6: only the isolated dir in env
    expect(spec.env).toEqual({ CODEX_HOME: isolatedHomeDir });
    expect(spec.env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
    // prelaunch files carry the isolated config.toml (approval_policy = "never")
    expect(spec.prelaunchFiles).toBeDefined();
    const configToml = spec.prelaunchFiles!.find((f) => f.path.endsWith('config.toml'));
    expect(configToml).toBeDefined();
    expect(configToml!.contents).toContain('approval_policy = "never"');
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

  it('throws if reviewBranch is absent from the placement', async () => {
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

    const placement = recordPlacement(projectId, 'reviewer@rev-y', 'reviewer', 'claude');
    // no reviewBranch in this placement
    await expect(gate.spawn(projectId, placement)).rejects.toThrow(/no reviewBranch/);
  });
});
