/**
 * HERMETIC ORCHESTRATION-BENCHMARK harness (runs under `pnpm test`). Drives the FULL
 * coordinator → lead → 2-implementers → merge-up chain for an {@link OrchestrationScenario} over
 * `FakePty` + `InMemoryTransport` + an injected counter clock, with each agent's "work" played as
 * SCRIPTED MCP tool-calls by a client bound to its hosted pane's transport (the only honest sandbox
 * option — a FakePty pane can't self-drive). It is the deterministic CI regression for
 * {@link runOrchestrationBenchmark}: same composition as `sh1-dry-run.test.ts`, generalized one level
 * deeper (a lead that fans out two implementers and merges BOTH their branches up before integrating its
 * barrel) and parameterized by the scenario.
 *
 * WHAT IS PROVEN (the scorecard's hard structural PASS, all from the program-data stores + the git log,
 * NEVER a scripted agent's claim):
 *   - the chain completed (`task.completed` recorded);
 *   - the MERGED artifact is graded CORRECT by the scenario's hidden oracle (it EXECUTES calc.mjs);
 *   - BOTH implementer branches merged up (worktree role + PASS verdict + serialized);
 *   - every merge round-tripped a human review (the operator-IPC PASS path);
 *   - fidelity is `sandbox-fake` (derived from the FakePty — structurally barred from host-live evidence);
 *   - the metrics aggregate (turns / merges / agentsByRole) from the objective stores.
 *
 * It also unit-tests the driver's PURE helpers (done-detector, metrics aggregation, fidelity derivation)
 * with NO pty, so they regress independently of the harness.
 *
 * DETERMINISM: no `Date.now()` / `Math.random()` in the harness — the engine + daemon read an injected
 * counter clock; ids/branches are fixed literals (the merge's review-id is a production `randomUUID`, read
 * back from the store, never asserted as a literal). Git fixtures are init'd with `commit.gpgsign=false`
 * and a Signed-off-by (mirrors sh1-dry-run's `git()` setup).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  FakePty,
  MAIL_APPROVAL_RESPONSE,
  MAIL_CLARIFY_RESPONSE,
  MAIL_REVIEW_REQUEST,
  MAIL_REVIEW_RESPONSE,
  MAIL_WORKER_DONE,
  OPERATOR,
  WEDGE_MS,
  ReconcileLoop,
  accountForProvider,
  buildCoreRegistry,
  calcLibScenario,
  defaultGitRawReader,
  defaultMailRenderer,
  invokeTool,
  openConfigStore,
  openDispatchStore,
  openMailStore,
  openPlanStore,
  openRegistry,
  openReviewStore,
  openRosterStore,
  openSpecStore,
  openWorktreeStore,
  parseSubRoleId,
  renderScorecard,
  reviewRequestEnvelope,
  reviewReviewerKey,
  startCoordinatorSession,
  summarizeRun,
  type DeliveredMail,
  type DispatchStore,
  type MailStore,
  type OrchestrationScenario,
  type PlacementRecord,
  type PlanStore,
  type ProjectId,
  type ProjectRegistry,
  type ReviewStore,
  type ReviewerSpawnGate,
  type Role,
  type RosterStore,
  type SlingDeps,
  type SpecStore,
  type UsageSnapshot,
  type WorktreeStore,
} from '@co/core';
import { ConductorDaemon } from './daemon.js';
import { ConductorEngine, type HostedPane } from './engine.js';
import { resolveReviewContext } from './review-context.js';
import type { ConductorControlSurface } from './host.js';
import type { DaemonBackedAgentRouter } from './agent-router.js';
import type { HostedIdentity } from '../live-session-host.js';
import { openContextStores } from '../context.js';
import { OperatorIpcServer } from '../operator-ipc/server.js';
import { OperatorIpcClient } from '../operator-ipc/client.js';
import {
  ORCH_BENCH_TASK_ID,
  aggregateAgentMetrics,
  aggregateMergeOutcomes,
  countImplementerBranchesMergedUp,
  deriveRunFidelity,
  detectChainCompletion,
  runOrchestrationBenchmark,
  type AgentTurnSample,
  type AutomationDriveResult,
  type OrchestrationAutomation,
} from './orchestration-benchmark.js';

// ── Scripted startup fixture (ESC via fromCharCode so the SOURCE holds no raw control byte). ──────────
const ESC = String.fromCharCode(0x1b);
const CLAUDE_READY = ESC + '[2J' + ESC + '[H' + '╭─ Welcome ─╮\r\n❯ \r\n  ? for shortcuts\r\n';

// ── Fixed identities / branches (deterministic — no randomness in the harness) ───────────────────────
const INTEGRATION = 'main';
const LEAD = 'lead-orch-bench';
const LEAD_BRANCH = 'co/orch-bench-lead';
// Per-implementer ids/branches keyed off the scenario's implementer ids (ops, tokenize).
const implementerAgent = (id: string): string => `impl-orch-bench-${id}`;
const implementerBranch = (id: string): string => `co/orch-bench-impl-${id}`;

// A far-future, healthy usage snapshot so co_sling's L4 placement is served from program-data and never
// performs a live read (mirrors sh1-dry-run's recordFreshUsageCache rationale).
const FAR_FUTURE_SAMPLED = '2999-01-01T00:00:00.000Z';
const FAR_FUTURE_RESET = '2999-01-01T05:00:00.000Z';

// A no-op provisioner + clean baseline so worktree provisioning is deterministic (no manifest I/O).
const SLING_DEPS: SlingDeps = {
  provisioner: () => ({ provisioned: [], skipped: [] }),
  probe: () => [],
};

// ── Cleanup state (mirrors sh1-dry-run.test.ts) ──────────────────────────────────────────────────────
const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let repoDirs: string[] = [];
let engines: ConductorEngine[] = [];
let clients: Client[] = [];
let registries: ProjectRegistry[] = [];
let mailStores: MailStore[] = [];
let reviewStores: ReviewStore[] = [];
let worktreeStores: WorktreeStore[] = [];
let specStores: SpecStore[] = [];
let planStores: PlanStore[] = [];
let dispatchStores: DispatchStore[] = [];
let rosterStores: RosterStore[] = [];
let contextHandles: Array<{ close: () => void }> = [];
let ipcServers: OperatorIpcServer[] = [];
let ipcClients: OperatorIpcClient[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  repoDirs = [];
  engines = [];
  clients = [];
  registries = [];
  mailStores = [];
  reviewStores = [];
  worktreeStores = [];
  specStores = [];
  planStores = [];
  dispatchStores = [];
  rosterStores = [];
  contextHandles = [];
  ipcServers = [];
  ipcClients = [];
});

afterEach(async () => {
  for (const ipcClient of ipcClients) {
    try {
      await ipcClient.close();
    } catch {
      /* best-effort */
    }
  }
  for (const server of ipcServers) {
    try {
      await server.close();
    } catch {
      /* best-effort */
    }
  }
  for (const client of clients) {
    try {
      await client.close();
    } catch {
      /* best-effort */
    }
  }
  for (const engine of engines) {
    try {
      await engine.closeAll();
    } catch {
      /* best-effort */
    }
  }
  for (const closeable of [
    ...mailStores,
    ...reviewStores,
    ...worktreeStores,
    ...specStores,
    ...planStores,
    ...dispatchStores,
    ...rosterStores,
    ...contextHandles,
    ...registries,
  ]) {
    try {
      closeable.close();
    } catch {
      /* best-effort */
    }
  }
  process.env = ORIGINAL_ENV;
  for (const dir of [...dataDirs, ...repoDirs]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// ── Deterministic seams (counter clock + controllable quiet window — never a wall clock) ─────────────
function makeClock(): { now: () => number; set: (t: number) => void } {
  let t = 0;
  return { now: () => t, set: (next) => void (t = next) };
}

function makeQuietWindow(): {
  quietWindow: (signal: AbortSignal) => Promise<void>;
  settle: () => void;
} {
  const waiters = new Set<() => void>();
  return {
    quietWindow: (signal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          waiters.delete(finish);
          signal.removeEventListener('abort', finish);
          resolve();
        };
        signal.addEventListener('abort', finish, { once: true });
        waiters.add(finish);
      }),
    settle: () => {
      for (const w of [...waiters]) w();
    },
  };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const flush = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i++) await tick();
};

// ── Real throwaway git repo (mirrors sh1-dry-run.test.ts makeRepo) ──────────────────────────────────
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * A real repo (NO remote → offline mode), on the integration branch with one base commit, then PARKED on
 * a detached HEAD so `main` is checked out in no worktree — the coordinator's own slung worktree can then
 * `git checkout main` for its gated lead→integration merge (see sh1-dry-run's merge-boundary note).
 */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-orch-bench-repo-'));
  repoDirs.push(dir);
  execFileSync('git', ['init', '-b', INTEGRATION, dir], { stdio: 'ignore' });
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'base\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'chore: init', '-m', 'Signed-off-by: Test <t@example.com>');
  git(dir, 'checkout', '--detach');
  return dir;
}

function makeProject(): { projectId: ProjectId; repo: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'co-orch-bench-data-'));
  dataDirs.push(dataDir);
  process.env.CO_DATA_DIR = dataDir;
  const repo = makeRepo();
  const registry = openRegistry();
  registries.push(registry);
  return { projectId: registry.register(repo), repo };
}

// ── Tracked store openers (all share one per-project node:sqlite DB) ─────────────────────────────────
function mail(projectId: ProjectId): MailStore {
  const store = openMailStore(projectId);
  mailStores.push(store);
  return store;
}
function reviews(projectId: ProjectId): ReviewStore {
  const store = openReviewStore(projectId);
  reviewStores.push(store);
  return store;
}
function worktrees(projectId: ProjectId): WorktreeStore {
  const store = openWorktreeStore(projectId);
  worktreeStores.push(store);
  return store;
}
function plans(projectId: ProjectId): PlanStore {
  const store = openPlanStore(projectId);
  planStores.push(store);
  return store;
}
function dispatch(projectId: ProjectId): DispatchStore {
  const store = openDispatchStore(projectId);
  dispatchStores.push(store);
  return store;
}

/** Record a fresh far-future healthy usage cache for every default account so co_sling never reads live. */
function recordFreshUsageCache(projectId: ProjectId): void {
  const ds = dispatch(projectId);
  const snapshot = (provider: 'claude' | 'codex', usedPct: number): UsageSnapshot => ({
    provider,
    account: accountForProvider(provider),
    available: true,
    source: 'fake',
    sampled_at: FAR_FUTURE_SAMPLED,
    windows: [{ kind: 'primary', used_pct: usedPct, reset_at: FAR_FUTURE_RESET }],
  });
  ds.recordSnapshot(snapshot('claude', 20));
  ds.recordSnapshot(snapshot('codex', 80));
}

// ── Engine / daemon composition (mirrors sh1-dry-run.test.ts) ────────────────────────────────────────
function makeEngine(
  pty: FakePty,
  clock: ReturnType<typeof makeClock>,
  qw: ReturnType<typeof makeQuietWindow>,
  reviewerSpawnGate: () => ReviewerSpawnGate | undefined,
): ConductorEngine {
  const engine = new ConductorEngine({
    pty,
    makeTransport: () => InMemoryTransport.createLinkedPair(),
    now: clock.now,
    quietWindow: qw.quietWindow,
    injectOptions: { retryDelay: () => new Promise<void>(() => {}) },
    reviewerSpawnGate,
  });
  engines.push(engine);
  return engine;
}

function makeReconcile(clock: ReturnType<typeof makeClock>): ReconcileLoop {
  return new ReconcileLoop({
    runningAgents: () => [],
    livenessInputFor: () => undefined,
    now: clock.now,
    onBreak: () => {},
    markStuck: () => {},
  });
}

/**
 * The engine-wired SPAWN GATE that auto-hosts a slung child over `FakePty` (verbatim shape from
 * sh1-dry-run.test.ts). When `co_sling` records a placed child and fires the gate, this resolves the
 * child's just-recorded worktree, builds its launch identity, and hosts it — feeding the fresh pane the
 * `CLAUDE_READY` bytes so the bind completes. The HOST is thus a loop-driven CONSEQUENCE of `co_sling`.
 */
function makeSpawnGate(
  engine: ConductorEngine,
  pty: FakePty,
  agentPanes: Map<string, FakePty['panes'][number]>,
): ReviewerSpawnGate {
  return {
    spawn: async (projectId, record: PlacementRecord): Promise<void> => {
      if (record.kind !== 'placed') {
        throw new Error(
          `orch-bench spawn gate: placement for '${record.agent}' is '${record.kind}'.`,
        );
      }
      if (engine.isHosted(projectId, record.agent)) return;
      const worktreeStore = openWorktreeStore(projectId);
      let worktree;
      try {
        worktree = worktreeStore
          .listWorktrees()
          .find((w) => !w.removed && w.agent === record.agent);
      } finally {
        worktreeStore.close();
      }
      if (worktree == null || worktree.role == null) {
        throw new Error(
          `orch-bench spawn gate: no live worktree (with role) for '${record.agent}'.`,
        );
      }
      const parsed = parseSubRoleId(record.role);
      const identity: HostedIdentity = {
        agent: record.agent,
        role: parsed.baseRole as Role,
        ...(parsed.name != null ? { subRole: parsed.name } : {}),
        parent: worktree.parent,
        pane: `pane-${record.agent}`,
        projectId,
        cwd: worktree.path,
        provider: 'claude',
        resume: { provider: 'claude', sessionId: record.agent },
      };
      const ensureP = engine.ensureHosted(identity);
      const pane = pty.panes[pty.panes.length - 1]!;
      agentPanes.set(record.agent, pane);
      pane.emit(CLAUDE_READY);
      await ensureP;
    },
  };
}

async function connectScriptedAgent(transport: HostedPane['clientTransport']): Promise<Client> {
  const client = new Client({ name: 'orch-bench-scripted-agent', version: '0.0.0' });
  clients.push(client);
  await client.connect(transport);
  return client;
}

async function callToolOrThrow(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content?: Array<{ type?: string; text?: string }>;
  };
  if (res.isError === true) {
    const text = (res.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    throw new Error(`orch-bench: co tool '${name}' returned an error: ${text}`);
  }
}

async function callToolJson(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content?: Array<{ type?: string; text?: string }>;
  };
  if (res.isError === true) {
    const text = (res.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    throw new Error(`orch-bench: co tool '${name}' returned an error: ${text}`);
  }
  if (res.structuredContent != null) return res.structuredContent;
  const text = (res.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  return JSON.parse(text) as Record<string, unknown>;
}

const isUnreadTurnWakeMail = (item: DeliveredMail): boolean =>
  !item.read &&
  !item.retracted &&
  (item.type === MAIL_APPROVAL_RESPONSE ||
    item.type === MAIL_CLARIFY_RESPONSE ||
    item.type === MAIL_WORKER_DONE ||
    item.type === MAIL_REVIEW_RESPONSE);

function firstDrivableMail(projectId: ProjectId, agent: string): DeliveredMail {
  const store = mail(projectId);
  const item = store.outstanding(agent)[0] ?? store.inbox(agent).find(isUnreadTurnWakeMail);
  if (item == null) throw new Error(`orch-bench: expected a drivable mail item for '${agent}'`);
  return item;
}

/**
 * Drive ONE daemon tick over an already-warm `agent`: start the tick, let runCycle select + inject, echo
 * the selected mail so the turn is active, run the scripted MCP work, then settle the pane to idle.
 */
async function driveDaemonTurn(
  daemon: ConductorDaemon,
  clock: ReturnType<typeof makeClock>,
  qw: ReturnType<typeof makeQuietWindow>,
  projectId: ProjectId,
  agent: string,
  agentPanes: Map<string, FakePty['panes'][number]>,
  base: number,
  doWork: () => Promise<void>,
): Promise<void> {
  const tickP = daemon.tick();
  await flush();
  const injected = firstDrivableMail(projectId, agent);
  const pane = agentPanes.get(agent)!;
  await tick();
  pane.emit(defaultMailRenderer(injected));
  await tick();
  await doWork();
  clock.set(base);
  pane.emit('⠋ working…\r\n');
  await tick();
  clock.set(base + WEDGE_MS + 1);
  qw.settle();
  await tickP;
}

/**
 * Drive the operator's PASS verdict through the REAL operator-IPC server, exactly as the desktop Review
 * view does (verbatim shape from sh1-dry-run.test.ts): fetch the pending review's context (diff + criteria
 * + evidence fingerprint) over the production wire, then submit a `review_response` reply carrying
 * `reviewVerdict: 'PASS'` + the matching fingerprint. A stale fingerprint fails loud.
 */
async function operatorPassViaIpc(
  projectId: ProjectId,
  reviewId: string,
  target: string,
  branch: string,
): Promise<void> {
  const sockDir = mkdtempSync(join(tmpdir(), 'co-orch-bench-sock-'));
  dataDirs.push(sockDir);
  const socketPath = join(sockDir, 'control.sock');
  const control: ConductorControlSurface = {
    router: {} as DaemonBackedAgentRouter,
    observe: () => {
      throw new Error('orch-bench: operator-IPC observe is not used by the review path');
    },
    transcriptTail: (agentId) => ({ agentId, offset: 0, tail: '' }),
    onTranscript: () => () => {},
    reviewContext: (rid) =>
      resolveReviewContext(
        {
          openReviews: () => openReviewStore(projectId),
          openSpecs: () => openSpecStore(projectId),
          openWorktrees: () => openWorktreeStore(projectId),
          gitReader: defaultGitRawReader,
        },
        rid,
      ),
    deleteAgent: () => Promise.reject(new Error('orch-bench: deleteAgent is not used here')),
    listArchive: () => Promise.resolve([]),
    restoreArchive: () => Promise.reject(new Error('orch-bench: restoreArchive is not used here')),
    purgeArchive: () => Promise.reject(new Error('orch-bench: purgeArchive is not used here')),
  };
  const server = new OperatorIpcServer({ control, projectId, socketPath });
  ipcServers.push(server);
  await server.start();
  const client = new OperatorIpcClient({ projectId, socketPath });
  ipcClients.push(client);

  const context = await client.reviewContext(reviewId);
  if (context.kind !== 'resolved') {
    throw new Error(
      `orch-bench: reviewContext for '${reviewId}' is '${context.kind}', not resolved`,
    );
  }
  const requestMail = mail(projectId)
    .inbox(OPERATOR)
    .find(
      (m) => m.type === MAIL_REVIEW_REQUEST && m.idempotencyKey === `review-request:${reviewId}`,
    );
  if (requestMail == null) {
    throw new Error(`orch-bench: no review_request mail for '${reviewId}' in @operator's inbox`);
  }
  await client.reply(
    { seq: requestMail.seq, recipient: OPERATOR },
    {
      type: MAIL_REVIEW_RESPONSE,
      reviewVerdict: 'PASS',
      reviewContextFingerprint: context.evidenceFingerprint,
      subject: `PASS: '${branch}' into '${target}'`,
      body: 'Reviewed the diff + locked acceptance criteria. PASS.',
    },
  );
}

// ── The scripted-MCP SANDBOX automation: drives the full chain for one scenario ───────────────────────

/**
 * Build the {@link OrchestrationAutomation} that drives the FULL chain over FakePty + scripted MCP
 * clients. Provisions the root coordinator, composes the real daemon/engine/spawn-gate, then plays each
 * agent's tool-calls in causal order: coordinator draft+brainstorm → operator lock → plan+sling-lead →
 * lead sling 2 implementers → each implementer write+finish → lead gated-merge both up + write barrel +
 * finish → coordinator gated-merge lead up + verify/merge/complete. Returns the per-agent turn samples.
 */
function makeSandboxAutomation(
  projectId: ProjectId,
  repo: string,
  scenario: OrchestrationScenario,
  pty: FakePty,
): OrchestrationAutomation {
  const clock = makeClock();
  const qw = makeQuietWindow();
  const agentPanes = new Map<string, FakePty['panes'][number]>();
  const agentTurns: Record<string, AgentTurnSample> = {};
  const bump = (agent: string): void => {
    const cur = agentTurns[agent] ?? { turnsUsed: 0, wallClockMs: 0 };
    agentTurns[agent] = { turnsUsed: cur.turnsUsed + 1, wallClockMs: cur.wallClockMs + 1000 };
  };

  // Deterministic single-candidate selection: skip every known agent EXCEPT `target`.
  const skipped = new Set<string>();
  const knownAgents: string[] = [];
  const only = (target: string): void => {
    skipped.clear();
    for (const a of knownAgents) if (a !== target) skipped.add(a);
  };

  const gateBox: { gate: ReviewerSpawnGate | undefined } = { gate: undefined };
  const engine = makeEngine(pty, clock, qw, () => gateBox.gate);
  gateBox.gate = makeSpawnGate(engine, pty, agentPanes);
  const daemon = new ConductorDaemon({
    engine,
    reconcile: makeReconcile(clock),
    projectId,
    now: clock.now,
    reconcileEvery: 1,
    isSkipped: (_pid, agent) => skipped.has(agent),
  });

  return {
    pty,
    teardown: async () => {
      await engine.closeAll();
    },
    drive: async (input): Promise<AutomationDriveResult> => {
      const reg = buildCoreRegistry();
      recordFreshUsageCache(projectId);
      const impls = scenario.implementers;
      const implAgents = impls.map((i) => implementerAgent(i.id));
      const implBranches = impls.map((i) => implementerBranch(i.id));

      // ── P0 — OPERATOR START: provision + register the root coordinator + seed its kickoff. ──────────
      const { coordinator: COORD } = startCoordinatorSession(
        {
          projectId,
          repoCwd: repo,
          prompt: scenario.rootBody({ nonce: input.nonce, operator: OPERATOR }),
          base: INTEGRATION,
          coordinatorId: 'coord-orch-bench',
        },
        { slingDeps: SLING_DEPS },
      );
      knownAgents.length = 0;
      knownAgents.push(COORD, LEAD, ...implAgents);

      // Gated merges require a HUMAN review (the runbook's operator-IPC PASS path).
      const cfg = openConfigStore();
      try {
        cfg.setProjectOverride(projectId, reviewReviewerKey('worker_merge'), 'human');
      } finally {
        cfg.close();
      }

      // ── TICK 1: daemon COLD-STARTS the root + drives its first turn (draft spec + brainstorm). ──────
      only(COORD);
      const tickP = daemon.tick();
      await tick();
      const coordPane = pty.panes[pty.panes.length - 1]!;
      agentPanes.set(COORD, coordPane);
      coordPane.emit(CLAUDE_READY);
      await flush();
      const coordClient = await connectScriptedAgent(
        engine.getHosted(projectId, COORD)!.clientTransport,
      );
      await callToolOrThrow(coordClient, 'co_spec_draft', {
        task_id: ORCH_BENCH_TASK_ID,
        title: 'Orchestration-benchmark scenario',
        goal: `Build the ${scenario.id} artifact via the full spawn chain.`,
        criteria: SPEC_CRITERIA,
        body: `Orchestration-benchmark ${scenario.id}: drive coordinator → lead → implementers → merge-up.`,
      });
      await callToolOrThrow(coordClient, 'co_mail_send', {
        to: OPERATOR,
        type: 'clarify_request',
        subject: 'Brainstorm: scope the orchestration-benchmark task',
        body: 'Proposed: one phase, a lead fanning out two implementers, merged up. OK to lock?',
      });
      {
        const injected = firstDrivableMail(projectId, COORD);
        await tick();
        coordPane.emit(defaultMailRenderer(injected));
        await tick();
        clock.set(1000);
        coordPane.emit('⠋ working…\r\n');
        await tick();
        clock.set(1000 + WEDGE_MS + 1);
        qw.settle();
        await tickP;
      }
      bump(COORD);

      // ── OPERATOR answers the brainstorm + LOCKS the spec. ───────────────────────────────────────────
      const brainstorm = mail(projectId)
        .inbox(OPERATOR)
        .find((m) => m.type === 'clarify_request' && m.sender === COORD);
      if (brainstorm == null)
        throw new Error('orch-bench: coordinator did not brainstorm the operator');
      mail(projectId).reply(brainstorm, {
        type: MAIL_CLARIFY_RESPONSE,
        subject: 'Re: scope the orchestration-benchmark task',
        body: 'Approved — lock it, plan the phase, and sling the lead.',
      });
      const operatorCtx = openContextStores({ agent: OPERATOR, projectId, cwd: repo });
      contextHandles.push(operatorCtx);
      await invokeTool(reg, operatorCtx.ctx, 'co_spec_lock', { task_id: ORCH_BENCH_TASK_ID });

      // ── TICK 2 — coordinator: ingest a 1-phase plan, sling the lead, record building. ───────────────
      only(COORD);
      await driveDaemonTurn(daemon, clock, qw, projectId, COORD, agentPanes, 110000, async () => {
        await callToolJson(coordClient, 'co_plan_ingest', {
          task_id: ORCH_BENCH_TASK_ID,
          goal: `Build the ${scenario.id} artifact via the full spawn chain.`,
          task_criteria: SPEC_CRITERIA,
          phases: [
            {
              phase_id: 'phase1',
              name: 'Build the library',
              owner: LEAD,
              deps: [],
              criteria: [{ text: 'the merged artifact executes correctly', verify: 'pnpm test' }],
            },
          ],
        });
        await callToolOrThrow(coordClient, 'co_sling', {
          parent: COORD,
          agent: LEAD,
          role: 'lead',
          branch: LEAD_BRANCH,
          base: INTEGRATION,
          kickoff:
            'Fan out the two implementer modules, merge them up, then write the barrel and finish.',
        });
        await callToolOrThrow(coordClient, 'co_phase_update', {
          task_id: ORCH_BENCH_TASK_ID,
          phase_id: 'phase1',
          status: 'building',
        });
      });
      bump(COORD);

      // ── TICK 3 — LEAD: sling BOTH implementers off the lead branch. ─────────────────────────────────
      const leadClient = await connectScriptedAgent(
        engine.getHosted(projectId, LEAD)!.clientTransport,
      );
      only(LEAD);
      await driveDaemonTurn(daemon, clock, qw, projectId, LEAD, agentPanes, 210000, async () => {
        for (let i = 0; i < impls.length; i++) {
          await callToolOrThrow(leadClient, 'co_sling', {
            parent: LEAD,
            agent: implAgents[i],
            role: 'implementer',
            branch: implBranches[i],
            base: LEAD_BRANCH,
            kickoff: `Write ${impls[i]!.modulePath} and finish through the gate.`,
          });
        }
      });
      bump(LEAD);

      // ── Each IMPLEMENTER: write its reference module + co_finish (worker_done → lead). ──────────────
      for (let i = 0; i < impls.length; i++) {
        const impl = impls[i]!;
        const agent = implAgents[i]!;
        const branch = implBranches[i]!;
        const implClient = await connectScriptedAgent(
          engine.getHosted(projectId, agent)!.clientTransport,
        );
        const wt = worktrees(projectId).getWorktree(branch);
        writeModuleFile(wt?.path ?? '', impl.modulePath, impl.referenceModule);
        only(agent);
        await driveDaemonTurn(
          daemon,
          clock,
          qw,
          projectId,
          agent,
          agentPanes,
          310000 + i * 50000,
          async () => {
            await callToolOrThrow(implClient, 'co_finish', {
              intent: { type: 'feat', scope: impl.id, summary: `add ${impl.modulePath}` },
              tests: [{ name: `${impl.id}-suite`, passed: true }],
              notes: `orch-bench implementer ${impl.id}`,
            });
          },
        );
        bump(agent);
      }

      // ── LEAD: gated-merge BOTH implementer branches up into the lead branch, then (on the LAST merge's
      //    landing turn) write the barrel + co_finish (worker_done → coordinator). Each merge round-trips
      //    the human-review gate. Every lead turn is anchored to a real wake mail: a `worker_done` (the
      //    implementer's finish) drives a merge#1 turn (triggers the review); the operator's PASS
      //    `review_response` then drives the merge#2 LANDING turn. The barrel-write + co_finish folds into
      //    the FINAL landing turn (the lead's session continues working after the last merge lands), so the
      //    chain never needs a wake the daemon can't supply. ─────────────────────────────────────────────
      for (let i = 0; i < impls.length; i++) {
        const branch = implBranches[i]!;
        const isLast = i === impls.length - 1;
        // co_merge (#1) — driven by the implementer's worker_done wake; triggers the gated review.
        only(LEAD);
        await driveDaemonTurn(
          daemon,
          clock,
          qw,
          projectId,
          LEAD,
          agentPanes,
          410000 + i * 50000,
          async () => {
            await callToolJson(leadClient, 'co_merge', {
              branch,
              into: LEAD_BRANCH,
              intent: { summary: `land the ${impls[i]!.id} module` },
              spec_ref: `spec:${ORCH_BENCH_TASK_ID}#locked`,
            });
          },
        );
        bump(LEAD);
        const req = reviews(projectId).getReviewRequest(LEAD_BRANCH, branch);
        if (req == null)
          throw new Error(`orch-bench: lead merge of '${branch}' requested no review`);
        await operatorPassViaIpc(projectId, req.reviewId, LEAD_BRANCH, branch);
        // co_merge (#2) — driven by the PASS review_response wake; lands the merge. On the LAST module
        // the lead also writes the barrel + co_finish in the same turn (its session continues working).
        only(LEAD);
        await driveDaemonTurn(
          daemon,
          clock,
          qw,
          projectId,
          LEAD,
          agentPanes,
          430000 + i * 50000,
          async () => {
            await callToolOrThrow(leadClient, 'co_merge', {
              branch,
              into: LEAD_BRANCH,
              intent: { summary: `land the ${impls[i]!.id} module` },
              spec_ref: `spec:${ORCH_BENCH_TASK_ID}#locked`,
            });
            if (isLast) {
              // The lead branch now carries both merged modules — write the barrel + finish up the chain.
              const leadWt = worktrees(projectId).getWorktree(LEAD_BRANCH);
              writeModuleFile(
                leadWt?.path ?? '',
                scenario.lead.modulePath,
                scenario.lead.referenceModule,
              );
              await callToolOrThrow(leadClient, 'co_finish', {
                intent: {
                  type: 'feat',
                  scope: 'barrel',
                  summary: `add ${scenario.lead.modulePath}`,
                },
                tests: [{ name: 'barrel-suite', passed: true }],
                notes: 'orch-bench lead barrel',
              });
            }
          },
        );
        bump(LEAD);
      }

      // ── COORDINATOR: gated-merge the lead branch up into integration, then verify/merge/complete. ───
      only(COORD);
      await driveDaemonTurn(daemon, clock, qw, projectId, COORD, agentPanes, 610000, async () => {
        await callToolJson(coordClient, 'co_merge', {
          branch: LEAD_BRANCH,
          into: INTEGRATION,
          intent: { summary: 'land the orchestration-benchmark library' },
          spec_ref: `spec:${ORCH_BENCH_TASK_ID}#locked`,
        });
      });
      bump(COORD);
      const leadReq = reviews(projectId).getReviewRequest(INTEGRATION, LEAD_BRANCH);
      if (leadReq == null)
        throw new Error('orch-bench: coordinator lead-merge requested no review');
      await operatorPassViaIpc(projectId, leadReq.reviewId, INTEGRATION, LEAD_BRANCH);

      only(COORD);
      await driveDaemonTurn(daemon, clock, qw, projectId, COORD, agentPanes, 710000, async () => {
        await callToolOrThrow(coordClient, 'co_merge', {
          branch: LEAD_BRANCH,
          into: INTEGRATION,
          intent: { summary: 'land the orchestration-benchmark library' },
          spec_ref: `spec:${ORCH_BENCH_TASK_ID}#locked`,
        });
        const baselineSha = git(repo, 'rev-parse', INTEGRATION);
        await callToolOrThrow(coordClient, 'co_phase_update', {
          task_id: ORCH_BENCH_TASK_ID,
          phase_id: 'phase1',
          status: 'verified',
          verified: { baseline_sha: baselineSha, pass: true },
        });
        await callToolOrThrow(coordClient, 'co_phase_update', {
          task_id: ORCH_BENCH_TASK_ID,
          phase_id: 'phase1',
          status: 'merged',
        });
        await callToolOrThrow(coordClient, 'co_task_complete', { task_id: ORCH_BENCH_TASK_ID });
      });
      bump(COORD);

      return {
        stopReason: 'task-complete',
        agentTurns,
        integrationBranch: INTEGRATION,
      };
    },
  };
}

// The locked spec's single acceptance criterion — task_criteria must match it exactly at plan ingestion.
const SPEC_CRITERIA = [
  {
    text: 'the merged artifact executes correctly against the scenario oracle',
    verify: 'pnpm vitest run packages/mcp/src/conductor/orchestration-benchmark.test.ts',
  },
];

/** Write `referenceModule` to `<worktreePath>/<modulePath>`, creating parent dirs. */
function writeModuleFile(worktreePath: string, modulePath: string, contents: string): void {
  const abs = join(worktreePath, modulePath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

// ── The hermetic end-to-end test ─────────────────────────────────────────────────────────────────────

describe('orchestration benchmark — sandbox harness drives the FULL coordinator → lead → 2-implementers → merge-up chain over FakePty (sandbox-fake; the deterministic CI regression for runOrchestrationBenchmark)', () => {
  it('drives the chain to completion, grades the merged artifact correct via the oracle, merges both implementer branches up, and stamps sandbox-fake', async () => {
    const { projectId, repo } = makeProject();
    const scenario = calcLibScenario();
    const nonce = 'orch-bench-sandbox-nonce';
    const pty = new FakePty();

    const scorecard = await runOrchestrationBenchmark({
      projectId,
      scenario,
      nonce,
      providerMode: 'claude-only',
      repoCwd: repo,
      integrationBranch: INTEGRATION,
      automation: makeSandboxAutomation(projectId, repo, scenario, pty),
    });

    // (1) FIDELITY — derived from the FakePty; structurally barred from host-live evidence (Principle 2).
    expect(scorecard.fidelity).toBe('sandbox-fake');

    // (2) THE HARD STRUCTURAL PASS — the whole chain landed and the merged artifact is correct.
    expect(scorecard.completed).toBe(true);
    expect(scorecard.artifact.correct).toBe(true);
    expect(scorecard.pass).toBe(true);
    expect(scorecard.failures).toEqual([]);

    // (3) BOTH implementer branches merged up (the merge-up floor).
    expect(scorecard.implementerBranchesMergedUp).toBe(2);
    expect(scorecard.requiredImplementerMerges).toBe(2);

    // (4) THE ORACLE graded the MERGED artifact by EXECUTING it (not an LLM judge).
    expect(scorecard.artifact.detail).toMatch(/calc\.mjs correct/u);

    // (5) THE MERGED ARTIFACT actually landed on integration (git is the objective record).
    expect(git(repo, 'cat-file', '-t', `${INTEGRATION}:calc-lib/calc.mjs`)).toBe('blob');
    expect(git(repo, 'cat-file', '-t', `${INTEGRATION}:calc-lib/ops.mjs`)).toBe('blob');
    expect(git(repo, 'cat-file', '-t', `${INTEGRATION}:calc-lib/tokenize.mjs`)).toBe('blob');

    // (6) METRICS aggregated from the objective stores: coordinator + lead + 2 implementers (+ reviewers).
    expect(scorecard.agentsByRole['coordinator']).toBe(1);
    expect(scorecard.agentsByRole['lead']).toBe(1);
    expect(scorecard.agentsByRole['implementer']).toBe(2);
    expect(scorecard.totalTurns).toBeGreaterThan(0);

    // (7) EVERY merge round-tripped a review round (the gate held — 3 merges: 2 impl→lead + 1 lead→int).
    expect(scorecard.merges.length).toBeGreaterThanOrEqual(3);
    expect(scorecard.merges.every((m) => m.reviewRounds >= 1)).toBe(true);
    expect(scorecard.totalReviewRounds).toBeGreaterThanOrEqual(3);

    // (8) NO orchestration footprint left in the repo tree (Principle 12).
    expect(existsSync(join(repo, '.co'))).toBe(false);

    // (9) THE THREE SCORES — correctness is a real number (the oracle case fraction, gated); token-economy
    //     is NULL in the sandbox arm (N/A, never a silent zero — no real tokens are spent); context/tool
    //     efficiency is also null until the per-agent tool-usage rollup surface lands (read via optional
    //     chaining — an absent rollup is an honest N/A, not a 0).
    expect(scorecard.scores.correctness).toBe(1);
    expect(scorecard.scores.tokenEconomy).toBeNull();
    for (const a of scorecard.agents) {
      expect(a.tokenEconomy.tokenEconomy).toBeNull();
      expect(a.tokenEconomy.totalTokens).toBeNull();
    }
    // The rendered scorecard shows N/A (not 0) for the sandbox-arm token economy.
    expect(renderScorecard(scorecard)).toMatch(/token-economy=N\/A/u);
  });
});

// ── Pure-helper unit tests (no pty — they regress independently of the harness) ──────────────────────

describe('orchestration-benchmark pure helpers — unit-tested with no pty (the done-detector, metrics aggregation, fidelity derivation)', () => {
  it('deriveRunFidelity is DERIVED from the pty host (FakePty ⇒ sandbox-fake; a bogus host fails loud)', () => {
    expect(deriveRunFidelity(new FakePty())).toBe('sandbox-fake');
    expect(() => deriveRunFidelity({} as never)).toThrow(/neither a FakePty/u);
  });

  it('detectChainCompletion is false until task.completed, then true (read from the plan store)', () => {
    const { projectId, repo } = makeProject();
    const reg = buildCoreRegistry();
    // A locked spec + ingested plan + a single merged+verified phase, then completed — the only legal path.
    const roster = openRosterStore(projectId);
    rosterStores.push(roster);
    roster.recordAgent({ agentId: 'coord-x', role: 'coordinator', parent: OPERATOR });
    const ctx = openContextStores({ agent: 'coord-x', projectId, cwd: repo });
    contextHandles.push(ctx);

    expect(detectChainCompletion(projectId, 'task-x')).toBe(false);

    const ps = plans(projectId);
    ps.recordDraft({
      taskId: 'task-x',
      goal: 'g',
      taskCriteria: [{ text: 'c', verify: 'pnpm test' }],
      phases: [
        {
          phaseId: 'p1',
          name: 'P1',
          owner: 'coord-x',
          deps: [],
          criteria: [{ text: 'c', verify: 'pnpm test' }],
        },
      ],
      actor: 'coord-x',
    });
    expect(detectChainCompletion(projectId, 'task-x')).toBe(false);
    ps.changePhaseStatus('task-x', 'p1', 'building', 'coord-x');
    ps.recordPhaseVerified('task-x', 'p1', 'deadbeef', true, 'coord-x');
    ps.changePhaseStatus('task-x', 'p1', 'merged', 'coord-x');
    ps.recordTaskCompleted('task-x', 'coord-x');
    expect(detectChainCompletion(projectId, 'task-x')).toBe(true);
    void reg;
  });

  it('aggregateAgentMetrics buckets every registered agent by role + folds in the turn samples + escalations', () => {
    const { projectId } = makeProject();
    const roster = openRosterStore(projectId);
    rosterStores.push(roster);
    roster.recordAgent({ agentId: 'coord-a', role: 'coordinator', parent: OPERATOR });
    roster.recordAgent({ agentId: 'lead-a', role: 'lead', parent: 'coord-a' });
    roster.recordAgent({ agentId: 'impl-a', role: 'implementer', parent: 'lead-a' });
    // An escalation mail to @operator from the lead is counted.
    mail(projectId).send({
      type: 'escalation',
      to: OPERATOR,
      from: 'lead-a',
      subject: 'STUCK',
      body: 'wedged',
    });

    const agents = aggregateAgentMetrics(
      projectId,
      {
        'coord-a': { turnsUsed: 3, wallClockMs: 3000 },
        'lead-a': { turnsUsed: 2, wallClockMs: 2000 },
      },
      'calc-lib',
      'sandbox-fake',
      1,
    );
    // @operator is excluded; every roster agent appears (impl-a with zeroed samples).
    expect(agents.map((a) => a.agentId).sort()).toEqual(['coord-a', 'impl-a', 'lead-a']);
    // The sandbox arm SKIPS the cost read entirely (fidelity-enforced), so the live-only economy score is
    // GUARANTEED null (N/A) — not a silent zero, not an accident of B's store being absent. Without PR B's
    // tool-usage rollup the tool-efficiency score is null too.
    expect(agents.find((a) => a.agentId === 'coord-a')?.tokenEconomy.tokenEconomy).toBeNull();
    expect(
      agents.find((a) => a.agentId === 'coord-a')?.toolEfficiency.contextEfficiency,
    ).toBeNull();
    const summary = summarizeRun({
      runId: 'r',
      scenarioId: 's',
      nonce: 'n',
      providerMode: 'claude-only',
      fidelity: 'sandbox-fake',
      completed: true,
      artifact: { correct: true, detail: 'ok', casesPassed: 1, casesTotal: 1 },
      agents,
      merges: [
        {
          branch: 'b',
          target: 't',
          reviewRounds: 1,
          kickbacks: 0,
          firstTryPass: true,
          mergeCommitSha: 'x',
        },
      ],
      stopReason: 'task-complete',
      implementerBranchesMergedUp: 1,
      requiredImplementerMerges: 1,
    });
    expect(summary.agentsByRole).toEqual({ coordinator: 1, lead: 1, implementer: 1 });
    expect(summary.totalTurns).toBe(5);
    expect(summary.totalEscalations).toBe(1);
    expect(agents.find((a) => a.agentId === 'lead-a')?.escalations).toBe(1);
    expect(agents.find((a) => a.agentId === 'impl-a')?.turnsUsed).toBe(0);
  });

  it('aggregateMergeOutcomes + countImplementerBranchesMergedUp read review rounds/kickbacks/merge-up from the stores', () => {
    const { projectId, repo } = makeProject();
    const wt = worktrees(projectId);
    // Two implementer worktrees off a lead branch (role drives the merge-up classification).
    for (const id of ['ops', 'tokenize']) {
      wt.recordWorktree({
        branch: implementerBranch(id),
        baseRef: LEAD_BRANCH,
        baseSha: 'a'.repeat(40),
        path: join(repo, `wt-${id}`),
        parent: LEAD,
        agent: implementerAgent(id),
        role: 'implementer',
      });
    }
    const rv = reviews(projectId);
    const ms = mail(projectId);
    // Each review ROUND is a `review_request` mail to @operator (a fresh reviewId per re-review) — that
    // append-only mail is the round history the aggregator reads (the verdict store keeps only the latest).
    // The subject MUST be the production shape (`review requested: '<branch>' into '<target>'`) — the
    // aggregator parses (target, branch) from it (the review store loses an older round's reviewId).
    const requestRound = (reviewId: string, branch: string, target = LEAD_BRANCH): void => {
      ms.requestHumanReview(
        reviewRequestEnvelope({
          from: LEAD,
          subject: `review requested: '${branch}' into '${target}'`,
          body: `review ${reviewId}`,
          idempotencyKey: `review-request:${reviewId}`,
        }),
        { reviewId, target, branch, reviewerKind: 'human', requestedBy: LEAD },
      );
    };
    // ops: PASS first try (one round). tokenize: ISSUES then PASS (two rounds = one kickback). Both land.
    requestRound('rev-ops', implementerBranch('ops'));
    rv.recordVerdict({
      reviewId: 'rev-ops',
      target: LEAD_BRANCH,
      branch: implementerBranch('ops'),
      scope: 'worker_merge',
      reviewer: OPERATOR,
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
    });
    rv.recordSerialized({ target: LEAD_BRANCH, branch: implementerBranch('ops') });
    requestRound('rev-tok-1', implementerBranch('tokenize'));
    rv.recordVerdict({
      reviewId: 'rev-tok-1',
      target: LEAD_BRANCH,
      branch: implementerBranch('tokenize'),
      scope: 'worker_merge',
      reviewer: OPERATOR,
      verdict: 'ISSUES',
      blockers: [{ summary: 'fix it' }],
      suggestions: [],
    });
    requestRound('rev-tok-2', implementerBranch('tokenize'));
    rv.recordVerdict({
      reviewId: 'rev-tok-2',
      target: LEAD_BRANCH,
      branch: implementerBranch('tokenize'),
      scope: 'worker_merge',
      reviewer: OPERATOR,
      verdict: 'PASS',
      blockers: [],
      suggestions: [],
    });
    rv.recordSerialized({ target: LEAD_BRANCH, branch: implementerBranch('tokenize') });
    // The lead branch merges up into integration too.
    rv.recordSerialized({ target: INTEGRATION, branch: LEAD_BRANCH });

    const merges = aggregateMergeOutcomes(projectId, INTEGRATION, repo);
    const ops = merges.find((m) => m.branch === implementerBranch('ops'));
    const tok = merges.find((m) => m.branch === implementerBranch('tokenize'));
    expect(ops?.reviewRounds).toBe(1);
    expect(ops?.firstTryPass).toBe(true);
    expect(tok?.reviewRounds).toBe(2);
    expect(tok?.kickbacks).toBe(1);
    expect(tok?.firstTryPass).toBe(false);

    expect(countImplementerBranchesMergedUp(projectId, INTEGRATION)).toBe(2);
  });
});
