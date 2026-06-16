/**
 * SH-1 PROOF HARNESS (Stage 14 · P3 KEYSTONE) — a deterministic sandbox proof of the FULL self-host
 * lifecycle, driven end to end by the REAL daemon + mail bus + real co tools, with ZERO hand-stitched
 * inter-agent transitions. The lifecycle proven (each arrow a loop-driven transition asserted via the
 * program-data stores + the tmp repo's git log — NEVER a scripted agent's claim):
 *
 *   operator start  →  daemon COLD-STARTS the root coordinator  →  coordinator (driven turn) drafts a
 *   spec (`co_spec_draft`) + brainstorms the operator (`co_mail_send` clarify_request)  →  operator
 *   answers + `co_spec_lock`  →  coordinator (driven turn) `co_sling`s the lead  →  lead (driven turn)
 *   `co_sling`s the worker  →  worker (driven turn) `co_finish`  →  worker_done → lead  →  lead
 *   `co_merge` (#1) → review_request → operator PASS via the operator-IPC review path → review_response
 *   → lead  →  lead `co_merge` (#2) → the merge LANDS on the integration branch.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 * CRITICAL — THIS TEST PROVES THE LOOP **PLUMBING + WIRING** ONLY.
 *
 * Over `FakePty` the agents' "work" is **scripted MCP tool-calls** by a client bound to each hosted
 * pane's transport (the architectural stand-in for a real provider making real MCP calls — the real
 * transport throws by design, `hostLiveTransportRequired` in `host.ts`). It is **NOT** the `SH-1`
 * acceptance bar — `SH-1` (a real agent making a real change to the `co` repo) stays a **host-live
 * operator proof** (`docs/sh1-runbook.md`). The value here is a deterministic regression guard that the
 * whole orchestration LOOP — cold-start, sling-kickoff, daemon-driven turns, finish→worker_done, and the
 * gated merge→review→PASS→re-merge round-trip — composes correctly with zero hand-stitched transitions.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * WHAT IS LOOP-DRIVEN, AND THE BOUNDARIES (Principle 9 — no silent papering-over):
 *   - The MOTOR is the REAL {@link ConductorDaemon} + {@link ConductorEngine} over `FakePty`, with an
 *     injected counter clock (DATA, never a wall clock), a controllable byte-quiet window, and
 *     `InMemoryTransport` for the per-pane MCP bind — exactly like `daemon-cold-start.test.ts` /
 *     `host-proof.test.ts`.
 *   - START + COLD-START (P1): {@link startCoordinatorSession} registers + provisions the root and seeds
 *     its actionable kickoff; the daemon's tick-0 `coldStartRootCoordinators` LAUNCHES it over `FakePty`
 *     (mints its session) and `runCycle` drives its first turn — all in one `daemon.tick()`.
 *   - SLINGS (P2): the daemon-driven coordinator calls the REAL `co_sling` to create the lead, and the
 *     daemon-driven lead calls `co_sling` to create the worker. Each `co_sling` fires the engine-wired
 *     spawn gate (auto-hosting the child pane) and seeds the child's actionable kickoff, so the daemon
 *     selects + drives the child on the NEXT tick. No manual `slingWorktree`, no manual roster seeding.
 *   - DETERMINISTIC L4 PLACEMENT (the central obstacle the prior rehearsal documented): `co_sling`'s
 *     L4 dispatch-PLACEMENT shell reads the wall clock + a live usage source, which would make the loop
 *     flaky. We resolve it WITHOUT weakening the proof: a FRESH program-data usage cache is pre-recorded
 *     (a far-future-dated healthy snapshot) so `co_sling`'s `refreshUsageForAccounts` is served from the
 *     cache and NEVER performs a live read (`readProviderUsageCached`), and the placement decision is
 *     deterministic ("placed" on claude). The wall clock `co_sling` reads internally cannot change the
 *     OUTCOME (healthy fixed cache ⇒ placed), and the harness itself uses no wall clock / randomness.
 *   - OPERATOR gates (start, brainstorm answer, lock, PASS) are the HUMAN operator's inputs, driven
 *     through the real operator tool/core (start primitive, `co_spec_lock`) and — for the verdict — the
 *     REAL operator-IPC server's `reviewContext` + `reply` path with the evidence-fingerprint check
 *     (exactly as the desktop Review view does), NOT a conductor-hosted pane.
 *   - The MERGE-from-worktree boundary: the integration branch (`main`) must be checkout-able in the
 *     lead's own slung worktree for the gated local merge (`git checkout <into>` + `--no-ff`). So the tmp
 *     repo parks its HEAD off `main` (a detached checkout) — `main` stays a valid ref but is checked out
 *     in NO worktree, so the lead can land the merge in its sandbox. This is a test-fixture nicety, not a
 *     weakening: the merge still round-trips the full human-review gate.
 *
 * DETERMINISM: no wall clock (`Date.now()`/`new Date()`), no `Math.random()` anywhere in this harness —
 * the engine + daemon read the injected counter clock; ids/branches are fixed literals (the merge's
 * review-id is a production `randomUUID`, read back from the store, never asserted as a literal). The full
 * flow is run TWICE on fresh tmp repos to confirm it is not timing-flaky (identical transition + tick
 * fingerprints).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  defaultGitRawReader,
  defaultMailRenderer,
  invokeTool,
  openConfigStore,
  openDispatchStore,
  openMailStore,
  openRegistry,
  openReviewStore,
  openSpecStore,
  openWorktreeStore,
  parseSubRoleId,
  reviewReviewerKey,
  startCoordinatorSession,
  worktreePathFor,
  type DeliveredMail,
  type DispatchStore,
  type MailStore,
  type PlacementRecord,
  type ProjectId,
  type ProjectRegistry,
  type ReviewStore,
  type ReviewerSpawnGate,
  type Role,
  type SlingDeps,
  type SpecStore,
  type UsageSnapshot,
  type WorktreeStore,
} from '@co/core';
import { ConductorDaemon, type DaemonTickOutcome } from './daemon.js';
import { ConductorEngine, type HostedPane } from './engine.js';
import { resolveReviewContext } from './review-context.js';
import type { ConductorControlSurface } from './host.js';
import type { DaemonBackedAgentRouter } from './agent-router.js';
import type { HostedIdentity } from '../live-session-host.js';
import { openContextStores } from '../context.js';
import { OperatorIpcServer } from '../operator-ipc/server.js';
import { OperatorIpcClient } from '../operator-ipc/client.js';

// ── Scripted startup fixture. ESC authored via fromCharCode so the SOURCE holds no raw control byte. ──
const ESC = String.fromCharCode(0x1b);
const CLAUDE_READY = ESC + '[2J' + ESC + '[H' + '╭─ Welcome ─╮\r\n❯ \r\n  ? for shortcuts\r\n';

// ── Fixed identities / ids / branches (deterministic — no randomness in the harness) ─────────────────
const TASK_ID = '2026-06-15-sh1-dry-run-toy';
const TOY_BRANCH = 'co/sh1-dry-run-toy'; // the worker's branch.
const LEAD_BRANCH = 'co/sh1-dry-run-lead'; // the lead's branch.
const INTEGRATION = 'main';
const LEAD = 'lead-sh1-toy';
const WORKER = 'impl-sh1-toy';

// A far-future, healthy usage snapshot. Recorded into the dispatch cache so `co_sling`'s usage refresh
// is served from program-data (`readProviderUsageCached`) and never performs a live read — making L4
// placement deterministic without any wall clock in the harness (a future-dated sample is never "stale").
const FAR_FUTURE_SAMPLED = '2999-01-01T00:00:00.000Z';
const FAR_FUTURE_RESET = '2999-01-01T05:00:00.000Z';

// A no-op provisioner + clean baseline so the root's worktree provisioning is deterministic (no manifest
// I/O). `co_sling`'s own slingWorktree uses the default empty-manifest provisioner (no install) for a
// fresh test project, so the lead/worker worktrees are equally deterministic.
const SLING_DEPS: SlingDeps = {
  provisioner: () => ({ provisioned: [], skipped: [] }),
  probe: () => [],
};

// ── Cleanup state (mirrors host-proof.test.ts / daemon.test.ts) ────────────────────────────────────
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
let dispatchStores: DispatchStore[] = [];
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
  dispatchStores = [];
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
    ...dispatchStores,
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

// ── Deterministic seams (counter clock + controllable quiet window — never a wall clock) ───────────
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

/** Drain microtasks + a macrotask (mirrors the engine/daemon test harnesses). */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
/** A few ticks for steps with several chained internal awaits (e.g. MCP bind handshake). */
const flush = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i++) await tick();
};

// ── Real throwaway git repo in a tmp dir (mirrors merge.test.ts makeRepo) ──────────────────────────
function git(cwd: string, ...args: string[]): string {
  // stderr ignored so git's "Switched to branch …" chatter does not pollute test output.
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * A real repo (NO remote → resolves to offline mode), on the integration branch with one base commit,
 * then PARKED on a detached HEAD so `main` is checked out in no worktree — the lead's own slung worktree
 * can then `git checkout main` for the gated local merge (see the file docstring's merge boundary note).
 */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-sh1-dry-run-repo-'));
  repoDirs.push(dir);
  execFileSync('git', ['init', '-b', INTEGRATION, dir], { stdio: 'ignore' });
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'base\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'chore: init', '-m', 'Signed-off-by: Test <t@example.com>');
  // Park HEAD off `main` so the integration branch is free to be checked out in a slung worktree.
  git(dir, 'checkout', '--detach');
  return dir;
}

function makeProject(): { projectId: ProjectId; repo: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'co-sh1-dry-run-data-'));
  dataDirs.push(dataDir);
  process.env.CO_DATA_DIR = dataDir;
  const repo = makeRepo();
  const registry = openRegistry();
  registries.push(registry);
  return { projectId: registry.register(repo), repo };
}

// ── Tracked store openers (all share one per-project node:sqlite DB) ───────────────────────────────
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
function specs(projectId: ProjectId): SpecStore {
  const store = openSpecStore(projectId);
  specStores.push(store);
  return store;
}
function dispatch(projectId: ProjectId): DispatchStore {
  const store = openDispatchStore(projectId);
  dispatchStores.push(store);
  return store;
}

/**
 * Record a fresh, far-future-dated healthy usage cache for EVERY default provider account so
 * `co_sling`'s `refreshUsageForAccounts` is served entirely from the program-data cache and performs NO
 * live read for any provider (an uncached account would shell out to a real provider source and time out
 * ~5s in the sandbox). A future-dated sample is never "stale", so the cache hits regardless of the wall
 * clock `co_sling` reads internally — keeping L4 placement deterministic with no wall clock in the harness.
 * Claude is left the roomier provider so placement is deterministic (the chosen provider is irrelevant to
 * the proof — the spawn gate hosts every child over `FakePty` as claude — only that placement SUCCEEDS).
 */
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

// ── Engine / daemon composition (mirrors daemon.test.ts) ───────────────────────────────────────────
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
    // A never-resolving retryDelay so injectMail waits for the scripted echo and never times out.
    injectOptions: { retryDelay: () => new Promise<void>(() => {}) },
    reviewerSpawnGate,
  });
  engines.push(engine);
  return engine;
}

/** An inert reconcile loop (empty running set) — the watchdog sweep is daemon.test's concern, not this. */
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
 * The engine-wired SPAWN GATE that auto-hosts a slung child over `FakePty`. When `co_sling` records a
 * placed child and fires `ctx.reviewerSpawnGate.spawn(...)`, this resolves the child's just-recorded
 * worktree, builds its launch identity (mirroring `buildPlacementLaunchSpec`'s identity), and hosts it
 * via `engine.ensureHosted` — feeding the freshly-spawned pane the `CLAUDE_READY` bytes so the bind
 * completes. The HOST is thus a loop-driven CONSEQUENCE of the agent's `co_sling`, never a manual
 * pre-seed. The captured pane is recorded in `agentPanes` so the daemon-driven first turn can echo into
 * it. (The host-live gate is `EngineReviewerSpawnGate`, which builds a fully-isolated provider spawn
 * spec; over `FakePty` the default minimal spec is sufficient — same launch authority, MNR-5.)
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
          `sh1-dry-run spawn gate: placement for '${record.agent}' is '${record.kind}'.`,
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
          `sh1-dry-run spawn gate: no live worktree (with role) for '${record.agent}'.`,
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
  const client = new Client({ name: 'sh1-dry-run-scripted-agent', version: '0.0.0' });
  clients.push(client);
  await client.connect(transport);
  return client;
}

/** Call a co tool over the scripted agent's MCP client; throw loud if the tool reported an error. */
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
    throw new Error(`sh1-dry-run: co tool '${name}' returned an error: ${text}`);
  }
}

/** Drive a hosted pane through ONE idle turn: echo the injected item, emit turn bytes, settle quiet. */
async function driveTurnToIdle(
  pane: FakePty['panes'][number],
  item: DeliveredMail,
  clock: ReturnType<typeof makeClock>,
  qw: ReturnType<typeof makeQuietWindow>,
  base: number,
): Promise<void> {
  await tick(); // injectMail has written the payload and is awaiting the echo
  pane.emit(defaultMailRenderer(item)); // composer echoes the injected text → exactly one Enter
  await tick(); // injectMail submits; observeTurnEnd arms the first quiet window
  clock.set(base);
  pane.emit('⠋ working…\r\n'); // the turn produces bytes, then goes quiet
  await tick(); // the new bytes re-arm the quiet window
  clock.set(base + WEDGE_MS + 1);
  qw.settle(); // the window elapses with no further output ⇒ idle
}

/** The first daemon-drivable item for `agent` — matching the engine's actionable-or-wake selector. */
function firstDrivableMail(projectId: ProjectId, agent: string): DeliveredMail {
  const store = mail(projectId);
  const item = store.outstanding(agent)[0] ?? store.inbox(agent).find(isUnreadTurnWakeMail);
  if (item == null) throw new Error(`sh1-dry-run: expected a drivable mail item for '${agent}'`);
  return item;
}

function isUnreadTurnWakeMail(item: DeliveredMail): boolean {
  return (
    !item.read &&
    !item.retracted &&
    (item.type === MAIL_APPROVAL_RESPONSE ||
      item.type === MAIL_CLARIFY_RESPONSE ||
      item.type === MAIL_WORKER_DONE ||
      item.type === MAIL_REVIEW_RESPONSE)
  );
}

// ── The structured outcome of one proof run ────────────────────────────────────────────────────────
interface Sh1DryRunResult {
  readonly coordinator: string;
  readonly coldStartTick: DaemonTickOutcome;
  readonly specDrafted: boolean;
  readonly brainstormDelivered: boolean;
  readonly brainstormAnswered: boolean;
  readonly specLocked: boolean;
  readonly leadSlingTick: DaemonTickOutcome;
  readonly leadProvisioned: boolean;
  readonly workerSlingTick: DaemonTickOutcome;
  readonly workerProvisioned: boolean;
  readonly worktreePath: string;
  readonly finishTick: DaemonTickOutcome;
  readonly finishRecorded: boolean;
  readonly finishCommitSha: string;
  readonly workerDonePersisted: boolean;
  readonly reviewRequested: boolean;
  readonly mergePending: boolean;
  readonly passVerdictRecorded: boolean;
  readonly merged: boolean;
  readonly mergeCommitSha: string;
  readonly mergedFileOnIntegration: boolean;
  readonly finalTick: DaemonTickOutcome;
}

/**
 * Drive the full toy change through the loop. Returns the structured transition facts (read from the
 * program-data stores + the tmp repo's git log) so the test asserts the PLUMBING, not the scripted
 * agent's claims.
 */
async function driveSh1DryRun(projectId: ProjectId, repo: string): Promise<Sh1DryRunResult> {
  const reg = buildCoreRegistry();
  // Deterministic L4 placement: a fresh far-future usage cache means `co_sling` never reads live usage.
  recordFreshUsageCache(projectId);

  // ── Phase 0a — OPERATOR START (P1). Provision + register the root coordinator + seed its kickoff. ──
  const { coordinator: COORD } = startCoordinatorSession(
    {
      projectId,
      repoCwd: repo,
      prompt: 'Orchestrate the SH-1 dry-run toy change with the operator.',
      base: INTEGRATION,
    },
    { slingDeps: SLING_DEPS },
  );

  // ── Compose the REAL daemon + engine + spawn gate over FakePty + the injected counter clock. ──────
  const clock = makeClock();
  const qw = makeQuietWindow();
  const pty = new FakePty();
  const agentPanes = new Map<string, FakePty['panes'][number]>();
  const skipped = new Set<string>();
  // A const holder breaks the construction cycle (the gate wraps the engine; the engine's lazy factory
  // reads the gate) without a reassigned `let`.
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

  // ── Phase 0b — TICK 1: the daemon COLD-STARTS the root + drives its first turn (draft + brainstorm). ──
  const coldStartTick = await (async (): Promise<DaemonTickOutcome> => {
    const tickP = daemon.tick();
    await tick(); // let coldStartRootCoordinators → ensureHosted spawn the root pane + start the MCP bind
    const coordPane = pty.panes[pty.panes.length - 1]!;
    agentPanes.set(COORD, coordPane);
    coordPane.emit(CLAUDE_READY); // drive startup to ready ⇒ ensureHosted resolves; runCycle selects it
    await flush(); // let ensureHosted resolve fully (session minted; getHosted populated; runCycle injecting)
    const coordHosted = engine.getHosted(projectId, COORD)!;
    const coordClient = await connectScriptedAgent(coordHosted.clientTransport);
    // DURING the driven turn, the scripted coordinator drafts the toy spec and brainstorms the operator.
    await callToolOrThrow(coordClient, 'co_spec_draft', {
      task_id: TASK_ID,
      title: 'SH-1 dry-run toy change',
      goal: 'Exercise the orchestration loop end to end.',
      criteria: [
        {
          text: 'the toy change merges cleanly into the integration branch',
          verify: 'pnpm vitest run packages/mcp/src/conductor/sh1-dry-run.test.ts',
        },
      ],
      body: 'A minimal toy change used to rehearse the SH-1 runbook flow in-sandbox.',
    });
    await callToolOrThrow(coordClient, 'co_mail_send', {
      to: OPERATOR,
      type: 'clarify_request',
      subject: 'Brainstorm: scope the SH-1 dry-run toy change',
      body: 'Proposed scope: a single toy file landed through the full loop. OK to lock?',
    });
    const injected = firstDrivableMail(projectId, COORD);
    await driveTurnToIdle(coordPane, injected, clock, qw, 1000);
    return tickP;
  })();
  const specDrafted = specs(projectId).getSpec(TASK_ID)?.state === 'draft';
  const brainstorm = mail(projectId)
    .inbox(OPERATOR)
    .find((m) => m.type === 'clarify_request' && m.sender === COORD);
  const brainstormDelivered = brainstorm != null;

  // ── Operator answers the brainstorm and LOCKS the spec (the asserted operator gate). The
  //    clarify_response itself is the daemon-drivable wake item for the coordinator's next turn. ─────
  if (brainstorm == null)
    throw new Error('sh1-dry-run: coordinator did not brainstorm the operator');
  mail(projectId).reply(brainstorm, {
    type: MAIL_CLARIFY_RESPONSE,
    subject: 'Re: scope the SH-1 dry-run toy change',
    body: 'Approved — lock it and sling your lead.',
  });
  const brainstormAnswered = mail(projectId)
    .inbox(COORD)
    .some((m) => m.type === MAIL_CLARIFY_RESPONSE && m.sender === OPERATOR);
  const operatorCtx = openContextStores({ agent: OPERATOR, projectId, cwd: repo });
  contextHandles.push(operatorCtx);
  await invokeTool(reg, operatorCtx.ctx, 'co_spec_lock', { task_id: TASK_ID });
  const specLocked = specs(projectId).getSpec(TASK_ID)?.state === 'locked';

  // ── Phase 1a — TICK 2: drive the coordinator's turn; it `co_sling`s the lead (spawn gate hosts it). ──
  const coordClient = await connectScriptedAgent(
    engine.getHosted(projectId, COORD)!.clientTransport,
  );
  const leadSlingTick = await driveDaemonTurn(
    daemon,
    clock,
    qw,
    projectId,
    COORD,
    agentPanes,
    110000,
    async () => {
      await callToolOrThrow(coordClient, 'co_sling', {
        parent: COORD,
        agent: LEAD,
        role: 'lead',
        branch: LEAD_BRANCH,
        base: INTEGRATION,
        kickoff: 'Coordinate the toy change: sling a worker, integrate its reviewed branch.',
      });
    },
  );
  const leadProvisioned = worktrees(projectId).getWorktree(LEAD_BRANCH)?.removed === false;
  // The coordinator has dispatched its lead. SKIP it (don't release): a released root would be re-
  // cold-started by the next tick (it stays a registered root with a provisioned worktree + no session),
  // hanging on a startup byte we never feed. Skipping keeps it warm but out of the candidate set.
  skipped.add(COORD);

  // ── Phase 1b — TICK 3: drive the lead's turn; it `co_sling`s the worker (spawn gate hosts it). ──────
  const leadClient = await connectScriptedAgent(engine.getHosted(projectId, LEAD)!.clientTransport);
  const workerSlingTick = await driveDaemonTurn(
    daemon,
    clock,
    qw,
    projectId,
    LEAD,
    agentPanes,
    210000,
    async () => {
      await callToolOrThrow(leadClient, 'co_sling', {
        parent: LEAD,
        agent: WORKER,
        role: 'implementer',
        branch: TOY_BRANCH,
        base: INTEGRATION,
        kickoff: 'Make the toy change in your worktree and finish through the gate.',
      });
    },
  );
  const workerWorktree = worktrees(projectId).getWorktree(TOY_BRANCH);
  const workerProvisioned = workerWorktree?.removed === false;
  const worktreePath = workerWorktree?.path ?? '';

  // ── Phase 2 — TICK 4: drive the worker's turn; it makes the toy edit + `co_finish` (inside the turn). ──
  // Write the toy change in the worker's worktree (the scripted co_finish commits it). Skip the lead so
  // the daemon selects the worker this tick (both are warm with drivable kickoff mail).
  writeFileSync(join(worktreePath, 'toy.txt'), 'the toy change\n');
  skipped.add(LEAD);
  const workerClient = await connectScriptedAgent(
    engine.getHosted(projectId, WORKER)!.clientTransport,
  );
  const finishTick = await driveDaemonTurn(
    daemon,
    clock,
    qw,
    projectId,
    WORKER,
    agentPanes,
    310000,
    async () => {
      await callToolOrThrow(workerClient, 'co_finish', {
        intent: { type: 'feat', scope: 'toy', summary: 'add the toy change' },
        tests: [{ name: 'toy-suite', passed: true }],
        notes: 'sh1 dry-run',
      });
    },
  );
  const finishRecord = worktrees(projectId).getFinish(TOY_BRANCH);
  const finishCommitSha = finishRecord?.commitSha ?? '';
  const finishRecorded =
    finishRecord != null && finishCommitSha === git(repo, 'rev-parse', TOY_BRANCH);
  const workerDonePersisted = mail(projectId)
    .inbox(LEAD)
    .some((m) => m.type === 'worker_done' && m.sender === WORKER);
  await engine.release(projectId, WORKER); // the worker is done — release its warm pane.

  // ── Phase 3 — the gated merge round-trip: co_merge (#1) → review_request → operator PASS via IPC. ──
  // Configure the worker_merge scope to require a HUMAN review (the runbook's operator path). The lead's
  // co_merge then arises the review_request via its engine-wired spawn gate (returns review_pending).
  const cfg = openConfigStore();
  try {
    cfg.setProjectOverride(projectId, reviewReviewerKey('worker_merge'), 'human');
  } finally {
    cfg.close();
  }
  // Drive merge #1 INSIDE a daemon-selected lead turn (mirrors the worker's co_finish tick): un-skip the
  // lead so the daemon selects it (warm, with unread worker_done wake mail) and run co_merge DURING the
  // driven turn — so even the merge transitions are daemon-sequenced, never directly invoked.
  // Capture the tool JSON via an outer `let` (driveDaemonTurn returns the tick outcome, not the result).
  skipped.delete(LEAD);
  let merge1: { review_pending?: boolean; merged?: boolean } | undefined;
  await driveDaemonTurn(daemon, clock, qw, projectId, LEAD, agentPanes, 410000, async () => {
    merge1 = (await callToolJson(leadClient, 'co_merge', {
      branch: TOY_BRANCH,
      into: INTEGRATION,
      intent: { summary: 'land the SH-1 dry-run toy change' },
      spec_ref: `spec:${TASK_ID}#locked`,
    })) as { review_pending?: boolean; merged?: boolean };
  });
  if (merge1 == null) throw new Error('sh1-dry-run: co_merge (#1) returned no result');
  const mergePending = merge1.review_pending === true && merge1.merged !== true;
  const reviewRequest = reviews(projectId).getReviewRequest(INTEGRATION, TOY_BRANCH);
  const reviewRequested = reviewRequest != null;
  if (reviewRequest == null) throw new Error('sh1-dry-run: co_merge did not request a review');

  // OPERATOR PASS through the REAL operator-IPC review path (reviewContext fingerprint → reply PASS).
  await operatorPassViaIpc(projectId, reviewRequest.reviewId);
  const passVerdictRecorded =
    reviews(projectId).getVerdict(INTEGRATION, TOY_BRANCH)?.verdict === 'PASS';

  // ── Phase 4 — the lead re-runs co_merge; the recorded PASS lets the gated merge LAND on main. ──────
  // Daemon-driven too: the lead is still warm (the review_response PASS is now unread wake mail), so the
  // daemon selects + drives it while the scripted co_merge lands the merge DURING the driven turn.
  const integrationHeadBefore = git(repo, 'rev-parse', INTEGRATION);
  await driveDaemonTurn(daemon, clock, qw, projectId, LEAD, agentPanes, 510000, async () => {
    await callToolOrThrow(leadClient, 'co_merge', {
      branch: TOY_BRANCH,
      into: INTEGRATION,
      intent: { summary: 'land the SH-1 dry-run toy change' },
      spec_ref: `spec:${TASK_ID}#locked`,
    });
  });
  const mergeCommitSha = git(repo, 'rev-parse', INTEGRATION);
  const merged = mergeCommitSha !== integrationHeadBefore;
  const mergedFileOnIntegration = git(repo, 'cat-file', '-t', `${INTEGRATION}:toy.txt`) === 'blob';
  await engine.release(projectId, LEAD); // the lead has landed the merge — release its warm pane.

  // ── Phase 5 — a final tick proves the daemon deterministically reconstructs the post-merge live set. ──
  const finalTick = await daemon.tick();

  return {
    coordinator: COORD,
    coldStartTick,
    specDrafted,
    brainstormDelivered,
    brainstormAnswered,
    specLocked,
    leadSlingTick,
    leadProvisioned,
    workerSlingTick,
    workerProvisioned,
    worktreePath,
    finishTick,
    finishRecorded,
    finishCommitSha,
    workerDonePersisted,
    reviewRequested,
    mergePending,
    passVerdictRecorded,
    merged,
    mergeCommitSha,
    mergedFileOnIntegration,
    finalTick,
  };
}

/**
 * Drive ONE daemon tick over an already-warm `agent`: start the tick, let `runCycle` select + inject,
 * echo-submit the selected mail so the provider turn is active, run the scripted MCP work (`doWork`),
 * then settle the agent's pane to idle. Returns the tick outcome. The agent must already be hosted
 * (warm) — its pane is in `agentPanes`.
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
): Promise<DaemonTickOutcome> {
  const tickP = daemon.tick();
  await flush(); // let runCycle select the warm agent + injectMail start (awaiting the echo)
  const injected = firstDrivableMail(projectId, agent);
  const pane = agentPanes.get(agent)!;
  await tick(); // injectMail has written the payload and is awaiting the echo
  pane.emit(defaultMailRenderer(injected)); // composer echoes the injected text → exactly one Enter
  await tick(); // injectMail submits; observeTurnEnd is now subscribed to MCP tool activity
  await doWork();
  clock.set(base);
  pane.emit('⠋ working…\r\n');
  await tick();
  clock.set(base + WEDGE_MS + 1);
  qw.settle();
  return tickP;
}

/** Call a co tool and return its parsed structured content (for inspecting co_merge's review_pending). */
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
    throw new Error(`sh1-dry-run: co tool '${name}' returned an error: ${text}`);
  }
  if (res.structuredContent != null) return res.structuredContent;
  const text = (res.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * Drive the operator's PASS verdict through the REAL operator-IPC server, exactly as the desktop Review
 * view does: (1) fetch the pending review's context (diff + criteria + evidence fingerprint) over the
 * production wire; (2) submit a `review_response` reply carrying `reviewVerdict: 'PASS'` + the matching
 * fingerprint. The server routes it to `handleReviewResponse` → `mail.replyWithReviewVerdict`, which
 * records the PASS verdict AND sends the review_response back to the lead. A stale fingerprint fails loud.
 */
async function operatorPassViaIpc(projectId: ProjectId, reviewId: string): Promise<void> {
  const sockDir = mkdtempSync(join(tmpdir(), 'co-sh1-sock-'));
  dataDirs.push(sockDir);
  const socketPath = join(sockDir, 'control.sock');
  // The daemon-side control surface: only `reviewContext` (the REAL resolver) is exercised by the
  // reviewContext + review_response reply path; the router/observe/transcript members are inert here.
  const control: ConductorControlSurface = {
    router: {} as DaemonBackedAgentRouter,
    observe: () => {
      throw new Error('sh1-dry-run: operator-IPC observe is not used by the review path');
    },
    transcriptTail: (agentId) => ({ agentId, offset: 0, tail: '' }),
    onTranscript: () => () => {},
    // These store factories need no afterEach tracking: resolveReviewContext OWNS each store's lifecycle —
    // it opens one per read and closes it in a `finally` before the next read (open→read→close, see
    // review-context.ts), so no handle leaks past the call. This mirrors how host.ts wires the production
    // openers; routing through the tracked reviews()/specs()/worktrees() openers here would double-close.
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
  };
  const server = new OperatorIpcServer({ control, projectId, socketPath });
  ipcServers.push(server);
  await server.start();
  const client = new OperatorIpcClient({ projectId, socketPath });
  ipcClients.push(client);

  // (1) Fetch the review context over the production wire → its evidence fingerprint.
  const context = await client.reviewContext(reviewId);
  if (context.kind !== 'resolved') {
    throw new Error(
      `sh1-dry-run: reviewContext for '${reviewId}' is '${context.kind}', not resolved`,
    );
  }

  // (2) Submit PASS by replying to the review_request in @operator's inbox (the daemon re-reads the row).
  const requestMail = mail(projectId)
    .inbox(OPERATOR)
    .find(
      (m) => m.type === MAIL_REVIEW_REQUEST && m.idempotencyKey === `review-request:${reviewId}`,
    );
  if (requestMail == null) {
    throw new Error(`sh1-dry-run: no review_request mail for '${reviewId}' in @operator's inbox`);
  }
  await client.reply(
    { seq: requestMail.seq, recipient: OPERATOR },
    {
      type: MAIL_REVIEW_RESPONSE,
      reviewVerdict: 'PASS',
      reviewContextFingerprint: context.evidenceFingerprint,
      subject: `PASS: '${TOY_BRANCH}' into '${INTEGRATION}'`,
      body: 'Reviewed the diff + locked acceptance criteria. PASS.',
    },
  );
}

/** A replay-stable fingerprint of one run (excludes per-run git SHAs + the production-random review-id). */
function determinismFingerprint(r: Sh1DryRunResult): Record<string, unknown> {
  // The root coordinator id is `coord-root-<sha256(projectId)>` — project-derived, so it differs per run.
  // Normalize it to a stable token so the fingerprint compares the STRUCTURE (who was selected), not the
  // per-project id (lead/worker ids are fixed literals already).
  const norm = (agent: string | null): string | null =>
    agent === r.coordinator ? '<root-coordinator>' : agent;
  return {
    // Cold-start (P1).
    coldStarted: r.coldStartTick.coldStarted.map((a) => norm(a)),
    coldSelected: norm(r.coldStartTick.selected),
    coldCandidateCount: r.coldStartTick.candidateCount,
    coldErrored: r.coldStartTick.cycle?.turn.errored ?? null,
    coldIdle: r.coldStartTick.cycle?.turn.turnEnd?.idle ?? null,
    // Brainstorm + lock (D2 + operator gate).
    specDrafted: r.specDrafted,
    brainstormDelivered: r.brainstormDelivered,
    brainstormAnswered: r.brainstormAnswered,
    specLocked: r.specLocked,
    // Slings (P2).
    leadSlingSelected: norm(r.leadSlingTick.selected),
    leadSlingCandidateCount: r.leadSlingTick.candidateCount,
    leadSlingIdle: r.leadSlingTick.cycle?.turn.turnEnd?.idle ?? null,
    leadProvisioned: r.leadProvisioned,
    workerSlingSelected: r.workerSlingTick.selected,
    workerSlingCandidateCount: r.workerSlingTick.candidateCount,
    workerSlingIdle: r.workerSlingTick.cycle?.turn.turnEnd?.idle ?? null,
    workerProvisioned: r.workerProvisioned,
    // Finish → worker_done.
    finishSelected: r.finishTick.selected,
    finishCandidateCount: r.finishTick.candidateCount,
    finishErrored: r.finishTick.cycle?.turn.errored ?? null,
    finishIdle: r.finishTick.cycle?.turn.turnEnd?.idle ?? null,
    finishSawCompletionVerb: r.finishTick.cycle?.turn.turnEnd?.sawCompletionVerb ?? null,
    finishRecorded: r.finishRecorded,
    workerDonePersisted: r.workerDonePersisted,
    // Merge → review → PASS → merge.
    reviewRequested: r.reviewRequested,
    mergePending: r.mergePending,
    passVerdictRecorded: r.passVerdictRecorded,
    merged: r.merged,
    mergedFileOnIntegration: r.mergedFileOnIntegration,
    // Final tick reconstruction.
    finalTickNum: r.finalTick.tick,
    finalSelected: r.finalTick.selected,
    finalCandidateCount: r.finalTick.candidateCount,
    finalColdStarted: [...r.finalTick.coldStarted],
  };
}

describe('SH-1 proof harness — PROVES THE FULL LOOP (cold-start → slings → finish → gated review-merge) over FakePty with ZERO hand-stitched transitions; NOT the SH-1 acceptance bar (which stays a host-live operator proof: docs/sh1-runbook.md)', () => {
  it('drives operator-start → cold-start → brainstorm/lock → slings → finish → review-gate → gated-merge, asserting every transition via the stores + git log', async () => {
    const { projectId, repo } = makeProject();
    const result = await driveSh1DryRun(projectId, repo);

    // (0) START + COLD-START: the daemon cold-started the registered-but-unhosted root and drove it.
    expect(result.coldStartTick.coldStarted).toEqual([result.coordinator]);
    expect(result.coldStartTick.selected).toBe(result.coordinator);
    expect(result.coldStartTick.cycle?.turn.errored).toBe(false);
    expect(result.coldStartTick.cycle?.turn.turnEnd?.idle).toBe(true);

    // (1) D2 brainstorm + draft, then the OPERATOR gate: a locked spec record exists.
    expect(result.specDrafted).toBe(true);
    expect(result.brainstormDelivered).toBe(true);
    expect(result.brainstormAnswered).toBe(true);
    expect(result.specLocked).toBe(true);

    // (2) SLINGS: the coordinator slung the lead and the lead slung the worker — both daemon-driven, both
    //     provisioned via the loop-driven co_sling (real worktrees on their branches off integration).
    expect(result.leadSlingTick.selected).toBe(result.coordinator);
    expect(result.leadProvisioned).toBe(true);
    expect(git(repo, 'rev-parse', '--verify', LEAD_BRANCH)).toMatch(/^[0-9a-f]{40}$/);
    expect(result.workerSlingTick.selected).toBe(LEAD);
    expect(result.workerProvisioned).toBe(true);
    expect(result.worktreePath).toBe(worktreePathFor(projectId, TOY_BRANCH));

    // (3) The daemon selected + drove the worker through EXACTLY ONE idle turn. The scripted co_finish
    //     ran during the observed provider turn, so the MCP sentinel saw the completion verb.
    expect(result.finishTick.selected).toBe(WORKER);
    expect(result.finishTick.candidateCount).toBe(1);
    expect(result.finishTick.cycle?.turn.errored).toBe(false);
    expect(result.finishTick.cycle?.turn.turnEnd?.idle).toBe(true);
    expect(result.finishTick.cycle?.turn.turnEnd?.sawCompletionVerb).toBe(true);

    // (4) FINISH: a finish record exists and its commit sha matches the branch head (the merge's
    //     reviewed-ref check depends on this), and worker_done reached the lead's inbox.
    expect(result.finishRecorded).toBe(true);
    expect(result.finishCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.workerDonePersisted).toBe(true);

    // (5) MERGE → REVIEW → PASS → MERGE: the lead's co_merge arose the review_request (pending), the
    //     operator's IPC PASS recorded a PASS verdict, and the re-merge landed on the integration branch.
    expect(result.reviewRequested).toBe(true);
    expect(result.mergePending).toBe(true);
    expect(result.passVerdictRecorded).toBe(true);
    expect(result.merged).toBe(true);
    expect(result.mergeCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.mergedFileOnIntegration).toBe(true);
    // The merge commit really sits on the integration branch (no orchestration file left in the tree).
    expect(git(repo, 'rev-parse', INTEGRATION)).toBe(result.mergeCommitSha);
    expect(existsSync(join(repo, '.co'))).toBe(false);

    // (6) The final tick deterministically reconstructs the post-merge live set: every agent was released,
    //     so nothing remains to drive (no spurious turn), and it cold-starts nothing (the root is done).
    //     It is tick 7: cold-start, 2 slings, finish, + the 2 now-daemon-driven merges, then this one.
    expect(result.finalTick.tick).toBe(7);
    expect(result.finalTick.selected).toBeNull();
    expect(result.finalTick.candidateCount).toBe(0);
    expect(result.finalTick.coldStarted).toEqual([]);
    // observedAt is injected DATA, never a wall clock.
    expect(Number.isFinite(result.coldStartTick.observedAt)).toBe(true);
    expect(Number.isFinite(result.finalTick.observedAt)).toBe(true);
  });

  it('is deterministic: two runs on fresh tmp repos produce identical transition + tick fingerprints (not timing-flaky)', async () => {
    const first = makeProject();
    const run1 = await driveSh1DryRun(first.projectId, first.repo);

    const second = makeProject();
    const run2 = await driveSh1DryRun(second.projectId, second.repo);

    // Same scripted MCP-calls + same injected counter-clock sequence ⇒ identical loop outcome. Per-run
    // git SHAs + the production-random review-id differ, so the fingerprint excludes them and compares
    // the full set of loop-driven transitions + tick outcomes.
    expect(determinismFingerprint(run1)).toEqual(determinismFingerprint(run2));
    // Both runs fully landed the gated merge through the human-review round-trip.
    expect(run1.merged).toBe(true);
    expect(run2.merged).toBe(true);
    expect(run1.passVerdictRecorded).toBe(true);
    expect(run2.passVerdictRecorded).toBe(true);
  });
});
