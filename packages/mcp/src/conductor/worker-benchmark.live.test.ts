/**
 * The GATED LIVE worker benchmark (the headline of the `CO_LIVE_E2E` live suite; see
 * `docs/worker-benchmark.md`). When the opt-in {@link CO_LIVE_E2E_ENV}=1 is set AND a real provider
 * binary is installed AND node-pty is built, it hosts a REAL implementer-role agent in a REAL node-pty
 * through CO's real socket-bridge MCP surface, gives it a trivial deterministic coding task, lets it
 * work real turns until it routes a nonce-bearing "worker done" `clarify_request`, then OBJECTIVELY
 * grades the artifact it produced by EXECUTING it. Otherwise (the sandbox / CI case) every live case
 * SKIPS LOUDLY with the missing prerequisite named in its title — it never fails and never mock-passes
 * (Principle 9). The always-on guard below proves the gate is OFF without the opt-in.
 *
 * Because `runWorkerBenchmark` resolves the host-live seam bundle lazily, collecting this file under a
 * default `pnpm test` pulls in NO node-pty / host-only graph: the node-pty probe runs only when the
 * opt-in is present (short-circuited otherwise), and all real I/O lives inside the gated cases.
 *
 * COST: a live run spends real Anthropic + OpenAI tokens (it drives real model turns). It is gated OFF
 * by default and run only via `pnpm test:live` on an authenticated operator host — never in CI.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CO_LIVE_E2E_ENV,
  NodePtyHost,
  OPERATOR,
  addModuleScenario,
  defaultGitExec,
  isLiveE2EEnabled,
  openRegistry,
  openRosterStore,
  type ProjectId,
  type SpawnSpec,
} from '@co/core';
import type { HostedIdentity } from '../live-session-host.js';
import { defaultCoMcpPaths } from './host-launch-paths.js';
import { assertHostLiveProof, type ProofResult, type ProofFidelity } from './host-proof.js';
import {
  WORKER_BENCH_DEFAULTS,
  buildWorkerSpawnSpec,
  runWorkerBenchmark,
} from './worker-benchmark.js';

// The CO monorepo root — for the Principle-12 pristine guard (the run must not touch the repo tree).
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

function optInSkipReason(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return isLiveE2EEnabled(env)
    ? undefined
    : `set ${CO_LIVE_E2E_ENV}=1 to run the live worker benchmark`;
}

function commandSkipReason(command: string): string | undefined {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore' });
  return result.error !== undefined ? `command '${command}' is not available on PATH` : undefined;
}

async function probeNodePty(): Promise<string | undefined> {
  try {
    await NodePtyHost.create();
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `node-pty native addon is not built/available: ${message}`;
  }
}

const suffix = (reason: string | undefined): string =>
  reason === undefined ? '' : ` [skipped: ${reason}]`;

const optInSkip = optInSkipReason();
// Only probe node-pty (loads the native addon) when actually opted in — keeps default `pnpm test`
// free of the host-only graph (the `??` short-circuits before `await probeNodePty()` runs).
const nodePtySkip = optInSkip ?? (await probeNodePty());
const claudeSkip = optInSkip ?? commandSkipReason('claude') ?? nodePtySkip;
const codexSkip = optInSkip ?? commandSkipReason('codex') ?? nodePtySkip;

describe('worker benchmark — skip gate (hermetic, always runs)', () => {
  it(`is OFF without ${CO_LIVE_E2E_ENV} — the live benchmark below SKIPS`, () => {
    expect(isLiveE2EEnabled({})).toBe(false);
    expect(isLiveE2EEnabled({ [CO_LIVE_E2E_ENV]: '1' })).toBe(true);
  });

  it('names the missing opt-in as the skip reason instead of failing', () => {
    expect(optInSkipReason({})).toMatch(CO_LIVE_E2E_ENV);
    expect(optInSkipReason({ [CO_LIVE_E2E_ENV]: '1' })).toBeUndefined();
  });
});

// ── Live setup ───────────────────────────────────────────────────────────────────
const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let repoDirs: string[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  repoDirs = [];
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  // CO_BENCH_KEEP=1 preserves the throwaway dirs (and prints them) for post-mortem debugging of a
  // host-live failure (e.g. the codex config.toml + the bridge.log under the isolated home).
  if (process.env['CO_BENCH_KEEP'] === '1') {
    if (dataDirs.length > 0 || repoDirs.length > 0) {
      console.error(
        `[worker-benchmark] kept dirs: data=${dataDirs.join(',')} repo=${repoDirs.join(',')}`,
      );
    }
    return;
  }
  for (const dir of [...dataDirs, ...repoDirs]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function dataDirFor(projectId: ProjectId): string {
  const registry = openRegistry();
  try {
    return registry.dataDirFor(projectId);
  } finally {
    registry.close();
  }
}

interface LiveRun {
  readonly projectId: ProjectId;
  readonly identity: HostedIdentity;
  readonly spawnSpec: SpawnSpec;
  readonly socketPath: string;
  readonly bridgeLogPath: string;
  readonly nonce: string;
}

function setupLiveRun(provider: 'claude' | 'codex'): LiveRun {
  // Program-data → a throwaway CO_DATA_DIR (Principle 12 — never the repo).
  const dataDir = mkdtempSync(join(tmpdir(), 'co-wb-data-'));
  dataDirs.push(dataDir);
  process.env.CO_DATA_DIR = dataDir;

  // The agent's working dir → a SEPARATE throwaway git repo (never the CO tree).
  const repo = mkdtempSync(join(tmpdir(), 'co-wb-repo-'));
  repoDirs.push(repo);
  defaultGitExec(repo, ['init', '-b', 'main']);
  defaultGitExec(repo, ['config', 'user.email', 'worker-bench@example.com']);
  defaultGitExec(repo, ['config', 'user.name', 'Worker Bench']);
  defaultGitExec(repo, ['config', 'commit.gpgsign', 'false']);
  defaultGitExec(repo, ['commit', '--allow-empty', '-m', 'chore: init worker-bench repo']);

  const registry = openRegistry();
  let projectId: ProjectId;
  try {
    projectId = registry.register(repo);
  } finally {
    registry.close();
  }

  const runId = randomUUID();
  const nonce = `wb-${provider}-${runId}`;
  const agent = `wb-${provider}-${runId}`;

  // The implementer needs a registered parent (hostSession records it into the roster, and a
  // non-coordinator role must have a parent whose role may spawn it). Seed a root coordinator
  // (the only role allowed parent=@operator) and host the implementer under it. The coordinator is
  // never spawned — it just owns the roster slot and is where the agent routes its done-mail (a not-yet
  // -hosted parent still receives the persisted mail, exactly as host-proof routes to its parent).
  const coordinator = `wb-coord-${runId}`;
  const roster = openRosterStore(projectId);
  try {
    roster.recordAgent({ agentId: coordinator, role: 'coordinator', parent: OPERATOR });
  } finally {
    roster.close();
  }

  const isolatedHomeDir = join(dataDirFor(projectId), 'worker-benchmark', agent);
  const resume =
    provider === 'claude'
      ? ({ provider: 'claude', sessionId: `wb-${runId}` } as const)
      : ({ provider: 'codex', codexHome: isolatedHomeDir } as const);
  const identity: HostedIdentity = {
    agent,
    role: 'implementer',
    parent: coordinator,
    pane: `wb-pane-${runId}`,
    projectId,
    cwd: repo,
    provider,
    resume,
  };

  // defaultCoMcpPaths derives the co-mcp bridge command from process.argv[1] — correct when launched
  // as `co-mcp serve`, but under vitest argv[1] is the test-runner worker, which is NOT the bridge.
  // Pin it to the BUILT co-mcp bin so the provider spawns the real `co-mcp bridge <socket>` (the
  // provider's required MCP server) instead of the vitest worker — otherwise the MCP initialize
  // handshake fails and a strict provider (codex marks `co` required) aborts its bootstrap.
  const coMcpBin = join(REPO_ROOT, 'packages', 'mcp', 'dist', 'bin.js');
  if (!existsSync(coMcpBin)) {
    throw new Error(
      `worker-benchmark.live: built co-mcp bin not found at ${coMcpBin} — run \`pnpm build\` first ` +
        '(or use `pnpm test:live`, which builds via pretest:live).',
    );
  }
  const mcpPaths = defaultCoMcpPaths({
    includeProviderAuth: true,
    argv: [process.execPath, coMcpBin],
  });
  const socketPath = mcpPaths.coMcpBridgeSocketPath?.(isolatedHomeDir, agent);
  if (socketPath == null) {
    throw new Error(
      'worker-benchmark.live: default MCP paths did not provide a bridge socket path.',
    );
  }
  const bridgeLogPath = `${isolatedHomeDir}/mcp/bridge.log`;
  const spawnSpec = buildWorkerSpawnSpec(identity, { isolatedHomeDir, ...mcpPaths });
  return { projectId, identity, spawnSpec, socketPath, bridgeLogPath, nonce };
}

const shimProofResult = (fidelity: ProofFidelity): ProofResult => ({
  turnRan: true,
  turnIdle: true,
  sessionReconstructed: true,
  mailRouted: true,
  steerCompleted: true,
  steerMidTurn: true,
  recoveredSessions: [],
  fidelity,
});

// Read the SAME budgets the driver uses (shared defaults, so an operator override of CO_BENCH_* keeps
// the test's turn-bound + outer timeout in sync with what the run actually does).
function benchEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = raw == null ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
const benchMaxTurns = benchEnvInt('CO_BENCH_MAX_TURNS', WORKER_BENCH_DEFAULTS.maxTurns);
const benchWallClockMs = benchEnvInt('CO_BENCH_WALLCLOCK_MS', WORKER_BENCH_DEFAULTS.wallClockMs);
const benchPerTurnMs = benchEnvInt('CO_BENCH_PER_TURN_MS', WORKER_BENCH_DEFAULTS.perTurnMs);
// The per-test (per-provider) timeout must exceed the in-driver budget: the wall-clock budget plus one
// over-running final turn (the loop only re-checks the deadline between turns) plus slack.
const LIVE_TIMEOUT_MS = benchWallClockMs + benchPerTurnMs + 120_000;

// Optional single-provider selector for targeted operator runs / debugging, e.g.
// `CO_BENCH_ONLY=codex CO_HOST_PROOF_TRACE=1 pnpm test:live`.
const onlyProvider = process.env['CO_BENCH_ONLY'];

describe(`LIVE worker benchmark [local only; skips loudly unless ${CO_LIVE_E2E_ENV}=1 + provider installed + node-pty built]`, () => {
  for (const provider of ['claude', 'codex'] as const) {
    const selectorSkip =
      onlyProvider != null && onlyProvider !== provider
        ? `CO_BENCH_ONLY=${onlyProvider} selected`
        : undefined;
    const skip = selectorSkip ?? (provider === 'claude' ? claudeSkip : codexSkip);
    it.skipIf(skip !== undefined)(
      `hosts a real ${provider} implementer in a real node-pty, has it write solution.mjs, and grades it${suffix(skip)}`,
      async () => {
        const run = setupLiveRun(provider);

        // Principle 12: the agent's cwd and all program-data are throwaway tmp dirs, NEVER the CO repo
        // tree. A structural check (not a fragile whole-repo before/after diff that any concurrent edit
        // would trip): both must live outside the repo root.
        expect(run.identity.cwd.startsWith(REPO_ROOT)).toBe(false);
        expect((process.env['CO_DATA_DIR'] ?? '').startsWith(REPO_ROOT)).toBe(false);

        const result = await runWorkerBenchmark(provider, {
          projectId: run.projectId,
          identity: run.identity,
          scenario: addModuleScenario(),
          nonce: run.nonce,
          spawnSpec: run.spawnSpec,
          socketPath: run.socketPath,
          bridgeLogPath: run.bridgeLogPath,
          ...(process.env.CO_HOST_PROOF_TRACE === '1'
            ? { onPaneData: (chunk: string) => process.stderr.write(chunk) }
            : {}),
        });

        // The scorecard (a metric line for per-provider comparison).
        console.error(
          `[worker-benchmark] ${provider}: fidelity=${result.fidelity} completed=${result.completed} ` +
            `artifact=${result.artifact.correct} (${result.artifact.detail}) turns=${result.turnsUsed} ` +
            `stop=${result.stopReason} wall=${result.wallClockMs}ms` +
            (result.turnError != null ? ` err=${result.turnError}` : ''),
        );

        // PLUMBING (hard): a real node-pty host, and the forward gate accepts it.
        expect(result.fidelity).toBe('host-live');
        expect(() => assertHostLiveProof(shimProofResult(result.fidelity))).not.toThrow();

        // The agent routed its nonce done-mail through the live MCP surface (bind + LiveDelivery + store).
        expect(result.completed).toBe(true);
        // QUALITY (the headline metric): the produced module, EXECUTED, computes add() correctly.
        expect(result.artifact.correct).toBe(true);

        expect(result.turnsUsed).toBeGreaterThan(0);
        expect(result.turnsUsed).toBeLessThanOrEqual(benchMaxTurns);
      },
      LIVE_TIMEOUT_MS,
    );
  }
});
