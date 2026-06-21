/**
 * SH-1 PROOF HARNESS (Stage 14 · P3 KEYSTONE, extended in Stage 15 · P-D to MULTI-PHASE) — a
 * deterministic sandbox proof of the FULL self-host lifecycle across ≥2 plan phases, driven end to end
 * by the REAL daemon + mail bus + real co tools, with ZERO hand-stitched inter-agent transitions. The
 * lifecycle proven (each arrow a loop-driven transition asserted via the program-data stores + the tmp
 * repo's git log — NEVER a scripted agent's claim):
 *
 *   operator start  →  daemon COLD-STARTS the root coordinator  →  coordinator (driven turn) drafts a
 *   spec (`co_spec_draft`) + brainstorms the operator (`co_mail_send` clarify_request)  →  operator
 *   answers + `co_spec_lock`  →  coordinator (driven turn) `co_plan_ingest`s a 2-PHASE plan + `co_sling`s
 *   phase 1's lead + records phase1 → building (`co_phase_update`)  →  lead (driven turn) `co_finish`
 *   → worker_done → coordinator  →  coordinator `co_merge` (#1, lead→integration) → review_request →
 *   operator PASS via the operator-IPC review path → review_response → coordinator  →  coordinator
 *   `co_merge` (#2) LANDS phase 1 on the integration branch, and IN THAT SAME LANDING TURN records
 *   `phase.verified(phase1, pass)` + phase1 → merged, confirms phase1 ready (`co_phase_status`), then
 *   ADVANCES — `co_sling`s phase 2's lead (causally gated on phase 1's merge landing).  →  phase 2
 *   repeats the same shape  →  on the LAST phase the coordinator `co_task_complete`s the task.
 *
 * THE ADVANCE IS THE KEYSTONE TRANSITION (Stage 15 P-D): the DAEMON is UNCHANGED — it only WAKES the
 * coordinator (the PASS `review_response` to the `co_merge` caller is an actionable turn-wake). The
 * COORDINATOR advances (records verified+merged, slings the next phase, or completes) — orchestration
 * lives in the agent via MCP tools (Principle 4), never in the daemon. The gated lead→integration
 * review IS the phase verification (Principle 10 / RG-4): `phase.verified(pass)` is recorded at the
 * point the gated merge lands, NOT via a separate phase-tester run.
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
  openPlanStore,
  openRegistry,
  openReviewStore,
  openSpecStore,
  openWorktreeStore,
  parseSubRoleId,
  CoRepoModeGate,
  defaultRemoteProbe,
  detectRepoMode,
  repoModeCapabilities,
  resolveRepoMode,
  reviewReviewerKey,
  startCoordinatorSession,
  type DeliveredMail,
  type DispatchStore,
  type MailStore,
  type PlacementRecord,
  type PlanStore,
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
const INTEGRATION = 'main';
// One lead per phase. The lead's OWN branch carries the phase change (it does the phase work itself +
// co_finish); the COORDINATOR merges the lead→integration branch and advances. With no sub-worker under
// a lead, the readiness fold's `workersComplete` is vacuously true (readiness rests on `verifiedPass`).
const LEAD1 = 'lead-sh1-pd-1';
const LEAD1_BRANCH = 'co/sh1-pd-lead1';
const LEAD2 = 'lead-sh1-pd-2';
const LEAD2_BRANCH = 'co/sh1-pd-lead2';
// The locked spec's single acceptance criterion — task_criteria MUST match it exactly at ingestion.
const SPEC_CRITERIA = [
  {
    text: 'the toy change merges cleanly into the integration branch',
    verify: 'pnpm vitest run packages/mcp/src/conductor/sh1-dry-run.test.ts',
  },
];

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
let planStores: PlanStore[] = [];
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
  planStores = [];
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
    ...planStores,
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
/** The loop-driven facts of ONE plan phase: lead finish → coordinator gated merge → land → verified. */
interface PhaseRunFacts {
  readonly leadProvisioned: boolean;
  readonly finishTick: DaemonTickOutcome;
  readonly finishRecorded: boolean;
  readonly workerDonePersisted: boolean;
  /** co_merge (#1) returned review_pending (the gated review was triggered, no merge yet). */
  readonly mergePending: boolean;
  /** The repo mode co_merge resolved (merge.ts → resolveRepoMode); 'offline' for the no-remote harness repo (SH-4). */
  readonly mergeMode: string;
  readonly reviewRequested: boolean;
  readonly passVerdictRecorded: boolean;
  /** The coordinator turn that LANDED the merge AND advanced (verified+merged, then sling/complete). */
  readonly landTick: DaemonTickOutcome;
  readonly merged: boolean;
  readonly mergeCommitSha: string;
  readonly mergedFileOnIntegration: boolean;
  /** `merge.serialized` was recorded for (integration, lead branch) — the ADVANCE evidence. */
  readonly serialized: boolean;
  /** A green `phase.verified` was recorded for the phase (verifiedPass === true). */
  readonly verifiedPass: boolean;
  /** The phase's status after landing (`merged`). */
  readonly statusAfterLand: string;
  /** co_phase_status reports THIS phase ready (verifiedPass ∧ workersComplete) at the advance point. */
  readonly phaseReadyAfterLand: boolean;
}

interface Sh1DryRunResult {
  readonly coordinator: string;
  readonly coldStartTick: DaemonTickOutcome;
  readonly specDrafted: boolean;
  readonly brainstormDelivered: boolean;
  readonly brainstormAnswered: boolean;
  readonly specLocked: boolean;
  readonly planIngested: boolean;
  /** Phase statuses straight out of co_plan_ingest — every phase starts 'planned'. */
  readonly statusesAtIngest: readonly string[];
  /** TICK 2 — the coordinator turn that ingested the plan + slung phase 1's lead + recorded building. */
  readonly phase1SlingTick: DaemonTickOutcome;
  /** phase 1 status after its lead is slung ('building'). */
  readonly phase1StatusAfterSling: string;
  readonly phase1: PhaseRunFacts;
  /** phase 2 status after the ADVANCE slung its lead ('building') — captured in phase 1's landing turn. */
  readonly phase2StatusAfterAdvance: string;
  readonly phase2: PhaseRunFacts;
  /** The two integration merge commits (one per phase) are distinct (git log). */
  readonly twoDistinctMergeCommits: boolean;
  /** task.completed was recorded in the plan store (the LAST-phase close). */
  readonly taskCompleted: boolean;
  readonly finalTick: DaemonTickOutcome;
}

/**
 * Drive a 2-PHASE plan through the loop. Returns the structured transition facts (read from the
 * program-data stores + the tmp repo's git log) so the test asserts the PLUMBING, not the scripted
 * agent's claims. The KEYSTONE is the ADVANCE: after phase 1's gated merge lands, the COORDINATOR
 * (woken by the PASS review_response — the daemon is unchanged) records verified+merged, confirms the
 * phase ready, then slings phase 2; after phase 2 lands it completes the task.
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
      prompt: 'Orchestrate the SH-1 dry-run multi-phase change with the operator.',
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
  // Force deterministic single-candidate selection: skip every known agent EXCEPT `target`. Skipping a
  // not-yet-slung lead is harmless (no session ⇒ not a candidate); skipping the warm root keeps it out
  // of the candidate set WITHOUT releasing it (a released root would be re-cold-started, then hang on a
  // startup byte we never feed). The COORDINATOR is the workhorse here (it merges + advances), so it is
  // un-skipped on its turns and skipped only while a lead is driven.
  const ALL_AGENTS = [COORD, LEAD1, LEAD2];
  const only = (target: string): void => {
    skipped.clear();
    for (const a of ALL_AGENTS) if (a !== target) skipped.add(a);
  };

  // The gated merges require a HUMAN review (the runbook's operator-IPC PASS path).
  const cfg = openConfigStore();
  try {
    cfg.setProjectOverride(projectId, reviewReviewerKey('worker_merge'), 'human');
  } finally {
    cfg.close();
  }

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
  only(COORD);
  // Connected ONCE here and reused across every coordinator turn — the pane stays warm (never released).
  let coordClient!: Client;
  const coldStartTick = await (async (): Promise<DaemonTickOutcome> => {
    const tickP = daemon.tick();
    await tick(); // let coldStartRootCoordinators → ensureHosted spawn the root pane + start the MCP bind
    const coordPane = pty.panes[pty.panes.length - 1]!;
    agentPanes.set(COORD, coordPane);
    coordPane.emit(CLAUDE_READY); // drive startup to ready ⇒ ensureHosted resolves; runCycle selects it
    await flush(); // let ensureHosted resolve fully (session minted; getHosted populated; runCycle injecting)
    const coordHosted = engine.getHosted(projectId, COORD)!;
    coordClient = await connectScriptedAgent(coordHosted.clientTransport);
    // DURING the driven turn, the scripted coordinator drafts the toy spec and brainstorms the operator.
    await callToolOrThrow(coordClient, 'co_spec_draft', {
      task_id: TASK_ID,
      title: 'SH-1 dry-run multi-phase change',
      goal: 'Exercise the multi-phase autonomous loop end to end.',
      criteria: SPEC_CRITERIA,
      body: 'A minimal multi-phase change used to rehearse the SH-1 runbook flow in-sandbox.',
    });
    await callToolOrThrow(coordClient, 'co_mail_send', {
      to: OPERATOR,
      type: 'clarify_request',
      subject: 'Brainstorm: scope the SH-1 dry-run multi-phase change',
      body: 'Proposed scope: two toy phases landed through the full loop. OK to lock?',
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
    subject: 'Re: scope the SH-1 dry-run multi-phase change',
    body: 'Approved — lock it, plan the phases, and sling phase 1.',
  });
  const brainstormAnswered = mail(projectId)
    .inbox(COORD)
    .some((m) => m.type === MAIL_CLARIFY_RESPONSE && m.sender === OPERATOR);
  const operatorCtx = openContextStores({ agent: OPERATOR, projectId, cwd: repo });
  contextHandles.push(operatorCtx);
  await invokeTool(reg, operatorCtx.ctx, 'co_spec_lock', { task_id: TASK_ID });
  const specLocked = specs(projectId).getSpec(TASK_ID)?.state === 'locked';

  // The plan the coordinator ingests: 2 phases, phase2 gated on phase1, each with a wired criterion.
  // task_criteria MUST equal the locked spec criteria exactly (the ingest gate enforces it).
  const PLAN_PHASES = [
    {
      phase_id: 'phase1',
      name: 'Phase one',
      owner: LEAD1,
      deps: [] as string[],
      criteria: [
        { text: 'phase 1 change lands on integration', verify: 'pnpm vitest run packages/mcp' },
      ],
    },
    {
      phase_id: 'phase2',
      name: 'Phase two',
      owner: LEAD2,
      deps: ['phase1'],
      criteria: [
        { text: 'phase 2 change lands on integration', verify: 'pnpm vitest run packages/mcp' },
      ],
    },
  ];

  // ── TICK 2 — coordinator turn: INGEST the 2-phase plan, sling phase 1's lead, record phase1 → building. ──
  only(COORD); // the clarify_response is the wake; LEAD1/LEAD2 are not yet slung.
  let statusesAtIngest: string[] = [];
  const phase1SlingTick = await driveDaemonTurn(
    daemon,
    clock,
    qw,
    projectId,
    COORD,
    agentPanes,
    110000,
    async () => {
      const ingest = await callToolJson(coordClient, 'co_plan_ingest', {
        task_id: TASK_ID,
        goal: 'Exercise the multi-phase autonomous loop end to end.',
        task_criteria: SPEC_CRITERIA,
        phases: PLAN_PHASES,
      });
      statusesAtIngest = (ingest['phases'] as Array<{ status: string }>).map((p) => p.status);
      await callToolOrThrow(coordClient, 'co_sling', {
        parent: COORD,
        agent: LEAD1,
        role: 'lead',
        branch: LEAD1_BRANCH,
        base: INTEGRATION,
        kickoff: 'Make the phase-1 change in your worktree and finish through the gate.',
      });
      await callToolOrThrow(coordClient, 'co_phase_update', {
        task_id: TASK_ID,
        phase_id: 'phase1',
        status: 'building',
      });
    },
  );
  const planIngested = plans(projectId).getPlan(TASK_ID) != null;
  const phase1StatusAfterSling =
    plans(projectId)
      .getPlan(TASK_ID)
      ?.phases.find((p) => p.phaseId === 'phase1')?.status ?? '<none>';

  // ── PHASE 1 (ticks 3–5): lead finish → coordinator gated merge → LAND + ADVANCE (sling phase 2). ──
  const phase1 = await drivePhaseToMerged({
    phaseId: 'phase1',
    lead: LEAD1,
    leadBranch: LEAD1_BRANCH,
    bases: { finish: 210000, merge1: 310000, land: 410000 },
    // The ADVANCE — runs INSIDE phase 1's landing turn, ONLY after phase 1 is confirmed ready: the
    // coordinator slings phase 2's lead (causally gated on phase 1's merge landing) + records building.
    advanceInLandingTurn: async () => {
      await callToolOrThrow(coordClient, 'co_sling', {
        parent: COORD,
        agent: LEAD2,
        role: 'lead',
        branch: LEAD2_BRANCH,
        base: INTEGRATION,
        kickoff: 'Make the phase-2 change in your worktree and finish through the gate.',
      });
      await callToolOrThrow(coordClient, 'co_phase_update', {
        task_id: TASK_ID,
        phase_id: 'phase2',
        status: 'building',
      });
    },
  });
  const phase2StatusAfterAdvance =
    plans(projectId)
      .getPlan(TASK_ID)
      ?.phases.find((p) => p.phaseId === 'phase2')?.status ?? '<none>';
  await engine.release(projectId, LEAD1); // phase 1 done — release its warm pane (session ends).

  // ── PHASE 2 (ticks 6–8): same shape; on the LAST phase the coordinator COMPLETES the task. ─────────
  const phase2 = await drivePhaseToMerged({
    phaseId: 'phase2',
    lead: LEAD2,
    leadBranch: LEAD2_BRANCH,
    bases: { finish: 510000, merge1: 610000, land: 710000 },
    // The COMPLETE — runs INSIDE phase 2's landing turn (last phase): the coordinator closes the task.
    advanceInLandingTurn: async () => {
      await callToolOrThrow(coordClient, 'co_task_complete', { task_id: TASK_ID });
    },
  });
  await engine.release(projectId, LEAD2); // phase 2 done — release its warm pane.

  const twoDistinctMergeCommits =
    phase1.mergeCommitSha !== phase2.mergeCommitSha &&
    /^[0-9a-f]{40}$/.test(phase1.mergeCommitSha) &&
    /^[0-9a-f]{40}$/.test(phase2.mergeCommitSha);
  const taskCompleted = plans(projectId).getPlan(TASK_ID)?.completedTs != null;

  // ── A final tick proves the daemon deterministically reconstructs the post-completion live set. ────
  only('<none>'); // skip the still-warm root; both leads are released (sessions ended).
  const finalTick = await daemon.tick();

  return {
    coordinator: COORD,
    coldStartTick,
    specDrafted,
    brainstormDelivered,
    brainstormAnswered,
    specLocked,
    planIngested,
    statusesAtIngest,
    phase1SlingTick,
    phase1StatusAfterSling,
    phase1,
    phase2StatusAfterAdvance,
    phase2,
    twoDistinctMergeCommits,
    taskCompleted,
    finalTick,
  };

  // ── Per-phase driver (closure over the engine/daemon/clock/skip state) ────────────────────────────
  /**
   * Drive ONE phase to merged: (1) write the phase change into the lead's worktree + drive the lead's
   * `co_finish` turn (worker_done → coordinator); (2) drive the coordinator's `co_merge` (#1) turn
   * (gated review triggered → review_pending); (3) operator PASS via the real IPC path; (4) drive the
   * coordinator's `co_merge` (#2) LANDING turn, which IN THE SAME TURN records phase.verified + the
   * phase status `verified`→`merged`, confirms the phase ready via `co_phase_status`, and ADVANCES
   * (`advanceInLandingTurn`). Returns the loop-driven facts read from the stores + git.
   */
  async function drivePhaseToMerged(opts: {
    phaseId: string;
    lead: string;
    leadBranch: string;
    bases: { finish: number; merge1: number; land: number };
    advanceInLandingTurn: () => Promise<void>;
  }): Promise<PhaseRunFacts> {
    const { phaseId, lead, leadBranch, bases, advanceInLandingTurn } = opts;
    // The lead was hosted by the coordinator's sling (prior turn); connect a client to its warm pane.
    const leadClient = await connectScriptedAgent(
      engine.getHosted(projectId, lead)!.clientTransport,
    );
    const leadWorktree = worktrees(projectId).getWorktree(leadBranch);
    const leadProvisioned = leadWorktree?.removed === false;
    // The lead does the phase work itself: write the change into its worktree; the scripted co_finish
    // commits it onto the lead's branch (the branch the coordinator then merges).
    writeFileSync(join(leadWorktree?.path ?? '', `${phaseId}.txt`), `the ${phaseId} change\n`);

    // (1) LEAD FINISH turn.
    only(lead);
    const finishTick = await driveDaemonTurn(
      daemon,
      clock,
      qw,
      projectId,
      lead,
      agentPanes,
      bases.finish,
      async () => {
        await callToolOrThrow(leadClient, 'co_finish', {
          intent: { type: 'feat', scope: phaseId, summary: `add the ${phaseId} change` },
          tests: [{ name: 'phase-suite', passed: true }],
          notes: `sh1 dry-run ${phaseId}`,
        });
      },
    );
    const finishRecord = worktrees(projectId).getFinish(leadBranch);
    const finishRecorded =
      finishRecord != null && finishRecord.commitSha === git(repo, 'rev-parse', leadBranch);
    const workerDonePersisted = mail(projectId)
      .inbox(COORD)
      .some((m) => m.type === 'worker_done' && m.sender === lead);

    // (2) COORDINATOR co_merge (#1) turn — the gated review is triggered (no merge yet). The coordinator
    //     is the worktree parent of the lead's branch, so co_merge accepts it (worktree.parent === caller).
    only(COORD);
    let merge1: { review_pending?: boolean; merged?: boolean; mode?: string } | undefined;
    await driveDaemonTurn(
      daemon,
      clock,
      qw,
      projectId,
      COORD,
      agentPanes,
      bases.merge1,
      async () => {
        merge1 = (await callToolJson(coordClient, 'co_merge', {
          branch: leadBranch,
          into: INTEGRATION,
          intent: { summary: `land the SH-1 dry-run ${phaseId} change` },
          spec_ref: `spec:${TASK_ID}#locked`,
        })) as { review_pending?: boolean; merged?: boolean; mode?: string };
      },
    );
    if (merge1 == null)
      throw new Error(`sh1-dry-run: co_merge (#1) for ${phaseId} returned no result`);
    const mergePending = merge1.review_pending === true && merge1.merged !== true;
    // The repo mode co_merge itself resolved (merge.ts → resolveRepoMode). For the no-remote harness
    // repo this is 'offline' — direct evidence the gated round-trip ran in Offline mode (SH-4).
    const mergeMode = merge1.mode ?? '';
    const reviewRequest = reviews(projectId).getReviewRequest(INTEGRATION, leadBranch);
    const reviewRequested = reviewRequest != null;
    if (reviewRequest == null)
      throw new Error(`sh1-dry-run: co_merge (#1) for ${phaseId} did not request a review`);

    // (3) OPERATOR PASS through the REAL operator-IPC path → records PASS + review_response → coordinator.
    await operatorPassViaIpc(projectId, reviewRequest.reviewId, leadBranch);
    const passVerdictRecorded =
      reviews(projectId).getVerdict(INTEGRATION, leadBranch)?.verdict === 'PASS';

    // (4) COORDINATOR co_merge (#2) LANDING turn + the ADVANCE. The PASS review_response is the unread
    //     wake mail that selects the coordinator; in this ONE turn it lands the merge, records
    //     phase.verified + merged (the gated review IS the verification), confirms the phase ready, then
    //     advances. The daemon only WOKE the coordinator — orchestration is the coordinator's, not the
    //     daemon's (Principle 4).
    const integrationHeadBefore = git(repo, 'rev-parse', INTEGRATION);
    let phaseReadyAfterLand = false;
    const landTick = await driveDaemonTurn(
      daemon,
      clock,
      qw,
      projectId,
      COORD,
      agentPanes,
      bases.land,
      async () => {
        await callToolOrThrow(coordClient, 'co_merge', {
          branch: leadBranch,
          into: INTEGRATION,
          intent: { summary: `land the SH-1 dry-run ${phaseId} change` },
          spec_ref: `spec:${TASK_ID}#locked`,
        });
        // The gated lead→integration review IS the phase verification (Principle 10 / RG-4): record
        // phase.verified at the landing point, baseline = the post-merge integration head.
        const baselineSha = git(repo, 'rev-parse', INTEGRATION);
        await callToolOrThrow(coordClient, 'co_phase_update', {
          task_id: TASK_ID,
          phase_id: phaseId,
          status: 'verified',
          verified: { baseline_sha: baselineSha, pass: true },
        });
        await callToolOrThrow(coordClient, 'co_phase_update', {
          task_id: TASK_ID,
          phase_id: phaseId,
          status: 'merged',
        });
        // The fold gate: the coordinator confirms THIS phase is ready before advancing — the advance is
        // causally gated on the merge landing (verifiedPass ∧ workersComplete), not mere sequencing.
        const status = await callToolJson(coordClient, 'co_phase_status', { task_id: TASK_ID });
        phaseReadyAfterLand =
          (status['phases'] as Array<{ phase_id: string; ready: boolean }>).find(
            (p) => p.phase_id === phaseId,
          )?.ready === true;
        if (!phaseReadyAfterLand) {
          throw new Error(
            `sh1-dry-run: advance gate — ${phaseId} not ready after its merge landed`,
          );
        }
        await advanceInLandingTurn();
      },
    );
    const mergeCommitSha = git(repo, 'rev-parse', INTEGRATION);
    const merged = mergeCommitSha !== integrationHeadBefore;
    const mergedFileOnIntegration =
      git(repo, 'cat-file', '-t', `${INTEGRATION}:${phaseId}.txt`) === 'blob';
    const serialized = reviews(projectId).serializedBranches(INTEGRATION).includes(leadBranch);
    const landedPhase = plans(projectId)
      .getPlan(TASK_ID)
      ?.phases.find((p) => p.phaseId === phaseId);

    return {
      leadProvisioned,
      finishTick,
      finishRecorded,
      workerDonePersisted,
      mergePending,
      mergeMode,
      reviewRequested,
      passVerdictRecorded,
      landTick,
      merged,
      mergeCommitSha,
      mergedFileOnIntegration,
      serialized,
      verifiedPass: landedPhase?.verifiedPass === true,
      statusAfterLand: landedPhase?.status ?? '<none>',
      phaseReadyAfterLand,
    };
  }
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
async function operatorPassViaIpc(
  projectId: ProjectId,
  reviewId: string,
  branch: string,
): Promise<void> {
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
    deleteAgent: () => Promise.reject(new Error('sh1-dry-run: deleteAgent is not used here')),
    listArchive: () => Promise.resolve([]),
    restoreArchive: () => Promise.reject(new Error('sh1-dry-run: restoreArchive is not used here')),
    purgeArchive: () => Promise.reject(new Error('sh1-dry-run: purgeArchive is not used here')),
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
      subject: `PASS: '${branch}' into '${INTEGRATION}'`,
      body: 'Reviewed the diff + locked acceptance criteria. PASS.',
    },
  );
}

/** A replay-stable fingerprint of one run (excludes per-run git SHAs + the production-random review-id). */
function determinismFingerprint(r: Sh1DryRunResult): Record<string, unknown> {
  // The root coordinator id is `coord-root-<sha256(projectId)>` — project-derived, so it differs per run.
  // Normalize it to a stable token so the fingerprint compares the STRUCTURE (who was selected), not the
  // per-project id (lead ids are fixed literals already).
  const norm = (agent: string | null): string | null =>
    agent === r.coordinator ? '<root-coordinator>' : agent;
  // Per-phase fingerprint: finish (lead) + the coordinator landing turn + the verified/merged/advance
  // facts. Statuses + booleans only — never a raw git SHA or an event timestamp (those differ per run).
  const phaseFp = (p: PhaseRunFacts): Record<string, unknown> => ({
    leadProvisioned: p.leadProvisioned,
    finishSelected: p.finishTick.selected,
    finishCandidateCount: p.finishTick.candidateCount,
    finishErrored: p.finishTick.cycle?.turn.errored ?? null,
    finishIdle: p.finishTick.cycle?.turn.turnEnd?.idle ?? null,
    finishSawCompletionVerb: p.finishTick.cycle?.turn.turnEnd?.sawCompletionVerb ?? null,
    finishRecorded: p.finishRecorded,
    workerDonePersisted: p.workerDonePersisted,
    mergePending: p.mergePending,
    mergeMode: p.mergeMode,
    reviewRequested: p.reviewRequested,
    passVerdictRecorded: p.passVerdictRecorded,
    landSelected: norm(p.landTick.selected),
    landCandidateCount: p.landTick.candidateCount,
    landErrored: p.landTick.cycle?.turn.errored ?? null,
    landIdle: p.landTick.cycle?.turn.turnEnd?.idle ?? null,
    merged: p.merged,
    mergedFileOnIntegration: p.mergedFileOnIntegration,
    serialized: p.serialized,
    verifiedPass: p.verifiedPass,
    statusAfterLand: p.statusAfterLand,
    phaseReadyAfterLand: p.phaseReadyAfterLand,
  });
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
    // Plan ingest (L6b E1) — every phase starts 'planned'.
    planIngested: r.planIngested,
    statusesAtIngest: [...r.statusesAtIngest],
    // Phase 1 sling (the coordinator turn that ingested + slung phase 1's lead).
    phase1SlingSelected: norm(r.phase1SlingTick.selected),
    phase1SlingCandidateCount: r.phase1SlingTick.candidateCount,
    phase1SlingIdle: r.phase1SlingTick.cycle?.turn.turnEnd?.idle ?? null,
    phase1StatusAfterSling: r.phase1StatusAfterSling,
    // Phase 1 run + the ADVANCE.
    phase1: phaseFp(r.phase1),
    phase2StatusAfterAdvance: r.phase2StatusAfterAdvance,
    // Phase 2 run + the COMPLETE.
    phase2: phaseFp(r.phase2),
    twoDistinctMergeCommits: r.twoDistinctMergeCommits,
    taskCompleted: r.taskCompleted,
    // Final tick reconstruction.
    finalTickNum: r.finalTick.tick,
    finalSelected: norm(r.finalTick.selected),
    finalCandidateCount: r.finalTick.candidateCount,
    finalColdStarted: r.finalTick.coldStarted.map((a) => norm(a)),
  };
}

describe('SH-1 proof harness — PROVES THE FULL MULTI-PHASE LOOP (cold-start → plan → phase 1 [sling→finish→gated-merge→LAND] → ADVANCE → phase 2 → task-complete) over FakePty with ZERO hand-stitched transitions; NOT the SH-1 acceptance bar (which stays a host-live operator proof: docs/sh1-runbook.md)', () => {
  it('drives operator-start → cold-start → brainstorm/lock → plan-ingest → 2 phases each [finish → review-gate → gated-merge → verified+merged] → coordinator ADVANCE → task-complete, asserting every transition via the stores + git log', async () => {
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

    // (2) PLAN INGEST (L6b E1): the coordinator ingested the 2-phase plan; every phase starts 'planned'.
    expect(result.planIngested).toBe(true);
    expect(result.statusesAtIngest).toEqual(['planned', 'planned']);

    // (3) PHASE 1 SLING: the coordinator (daemon-driven) slung phase 1's lead off integration and
    //     recorded phase1 → building. (lead-per-phase: the lead's own branch carries the change.)
    expect(result.phase1SlingTick.selected).toBe(result.coordinator);
    expect(result.phase1.leadProvisioned).toBe(true);
    expect(git(repo, 'rev-parse', '--verify', LEAD1_BRANCH)).toMatch(/^[0-9a-f]{40}$/);
    expect(result.phase1StatusAfterSling).toBe('building');

    // (4) PHASE 1 FINISH: the daemon selected + drove the lead through EXACTLY ONE idle turn; the
    //     scripted co_finish ran during the observed turn (sentinel saw the completion verb) and a
    //     finish record + worker_done (→ coordinator) exist.
    expect(result.phase1.finishTick.selected).toBe(LEAD1);
    expect(result.phase1.finishTick.candidateCount).toBe(1);
    expect(result.phase1.finishTick.cycle?.turn.turnEnd?.idle).toBe(true);
    expect(result.phase1.finishTick.cycle?.turn.turnEnd?.sawCompletionVerb).toBe(true);
    expect(result.phase1.finishRecorded).toBe(true);
    expect(result.phase1.workerDonePersisted).toBe(true);

    // (5) PHASE 1 GATED MERGE → REVIEW → PASS → LAND: the COORDINATOR's co_merge (#1) arose the review
    //     (pending), the operator's IPC PASS recorded a PASS verdict, and the coordinator's landing turn
    //     merged phase 1 onto integration.
    expect(result.phase1.mergePending).toBe(true);
    expect(result.phase1.reviewRequested).toBe(true);
    expect(result.phase1.passVerdictRecorded).toBe(true);
    expect(result.phase1.landTick.selected).toBe(result.coordinator);
    expect(result.phase1.merged).toBe(true);
    expect(result.phase1.mergedFileOnIntegration).toBe(true);

    // (6) PHASE 1 VERIFIED + MERGED (Principle 10 / RG-4 — the gated review IS the verification): a green
    //     phase.verified was recorded at the landing point and the phase status advanced to 'merged'.
    expect(result.phase1.verifiedPass).toBe(true);
    expect(result.phase1.statusAfterLand).toBe('merged');

    // (7) THE ADVANCE (the keystone transition): the fold passes — co_phase_status reports phase 1 ready
    //     (verifiedPass ∧ workersComplete) — AND merge.serialized exists for phase 1's branch. ONLY then
    //     did the coordinator sling phase 2 (causally gated on phase 1's merge landing, not sequencing):
    //     phase 2 is now 'building'.
    expect(result.phase1.phaseReadyAfterLand).toBe(true);
    expect(result.phase1.serialized).toBe(true);
    expect(result.phase2StatusAfterAdvance).toBe('building');

    // (8) PHASE 2 (same shape, driven ONLY after phase 1 landed): finish → gated merge → land → verified.
    expect(result.phase2.finishTick.selected).toBe(LEAD2);
    expect(result.phase2.finishRecorded).toBe(true);
    expect(result.phase2.workerDonePersisted).toBe(true);
    expect(result.phase2.mergePending).toBe(true);
    expect(result.phase2.passVerdictRecorded).toBe(true);
    expect(result.phase2.landTick.selected).toBe(result.coordinator);
    expect(result.phase2.merged).toBe(true);
    expect(result.phase2.mergedFileOnIntegration).toBe(true);
    expect(result.phase2.verifiedPass).toBe(true);
    expect(result.phase2.statusAfterLand).toBe('merged');
    expect(result.phase2.phaseReadyAfterLand).toBe(true);
    expect(result.phase2.serialized).toBe(true);

    // (9) TWO DISTINCT INTEGRATION MERGES (git): one merge commit per phase, both on integration; both
    //     phase files landed; no orchestration footprint left in the tree (Principle 12).
    expect(result.twoDistinctMergeCommits).toBe(true);
    expect(git(repo, 'rev-parse', INTEGRATION)).toBe(result.phase2.mergeCommitSha);
    expect(git(repo, 'cat-file', '-t', `${INTEGRATION}:phase1.txt`)).toBe('blob');
    expect(git(repo, 'cat-file', '-t', `${INTEGRATION}:phase2.txt`)).toBe('blob');
    expect(existsSync(join(repo, '.co'))).toBe(false);

    // (10) TASK COMPLETE (the last-phase close): task.completed is present in the plan store, and BOTH
    //      phases progressed planned → building → verified → merged.
    expect(result.taskCompleted).toBe(true);
    const finalPlan = plans(projectId).getPlan(TASK_ID);
    expect(finalPlan?.completedTs).toBeGreaterThan(0);
    expect(finalPlan?.phases.map((p) => p.status)).toEqual(['merged', 'merged']);
    expect(finalPlan?.phases.every((p) => p.verifiedPass === true)).toBe(true);

    // (11) The final tick deterministically reconstructs the post-completion live set: both leads were
    //      released and the root is skipped, so nothing remains to drive (no spurious turn) and it
    //      cold-starts nothing. It is tick 9: cold-start, phase-1 sling, + 2 phases × (finish, merge #1,
    //      land) = 6, then this final tick.
    expect(result.finalTick.tick).toBe(9);
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
    // the full set of loop-driven transitions + tick outcomes — INCLUDING the per-phase statuses,
    // phase.verified pass, both integration merges, the advance, and task.completed.
    expect(determinismFingerprint(run1)).toEqual(determinismFingerprint(run2));
    // Both runs fully landed BOTH phases through the human-review round-trip and completed the task.
    expect(run1.phase1.merged && run1.phase2.merged).toBe(true);
    expect(run2.phase1.merged && run2.phase2.merged).toBe(true);
    expect(run1.taskCompleted).toBe(true);
    expect(run2.taskCompleted).toBe(true);
  });
});

// ── SH-4 — the loop drives on a LOCAL-ONLY, no-remote repo (Offline mode) ──────────────────────────────
// The harness repo (makeRepo) deliberately has NO remote, so it resolves to Offline mode. This proves
// the SH-4 IN-SANDBOX half: Offline auto-detect (repo-mode.ts / WT-4), push/PR disabled, merge STILL
// gated. The real stranger-repo live run stays an operator TODO (docs/offline-runbook.md, docs/v1-handoff.md).
// Asserted against PHASE 1's facts — driveSh1DryRun now drives the full 2-phase loop, and phase 1's gated
// lead→integration merge is itself the offline-mode evidence (phase 2 lands identically).
describe('SH-4 offline self-host — drives the loop on a local-only no-remote repo: Offline auto-detect, push/PR disabled, merge still gated (NOT the host-live stranger-repo bar — docs/offline-runbook.md)', () => {
  it('auto-detects Offline mode, disables push/PR, and still gates the merge through the human-review round-trip', async () => {
    const { projectId, repo } = makeProject();

    // (1) OFFLINE AUTO-DETECT (WT-4). The repo has no remote, so BOTH the pure detector over the real
    //     read-only prober AND the effective resolver (override ⊕ detection) resolve to 'offline'. The
    //     default prober's `git ls-remote origin` fails fast on a remote-less repo — no network read.
    expect(detectRepoMode(defaultRemoteProbe(repo))).toBe('offline');
    expect(resolveRepoMode(projectId, repo)).toBe('offline');

    // (2) PUSH / PR DISABLED. Offline's capability lookup refuses both, and the enactment gate fails
    //     LOUD (Principle 9 — no silent no-op) instead of silently skipping a push / PR.
    expect(repoModeCapabilities('offline')).toEqual({ push: false, pr: false });
    const gate = new CoRepoModeGate();
    expect(() =>
      gate.enactPush({ branch: LEAD1_BRANCH, into: INTEGRATION, repoCwd: repo }, 'offline'),
    ).toThrow(/offline/iu);
    expect(() =>
      gate.enactPrMerge(
        { branch: LEAD1_BRANCH, into: INTEGRATION, title: 'x', description: 'y', repoCwd: repo },
        'offline',
      ),
    ).toThrow(/offline/iu);

    // (3) MERGE STILL GATED. Drive the full (2-phase) loop on the offline repo. co_merge resolves the
    //     repo mode itself (merge.ts → resolveRepoMode), so the landed merge ran in 'offline' mode — yet
    //     phase 1 STILL round-tripped the human-review gate: merge #1 returned review_pending (no PASS
    //     yet), and the merge LANDED only after the operator's recorded PASS, as a LOCAL merge (no push,
    //     no PR).
    const result = await driveSh1DryRun(projectId, repo);
    expect(result.phase1.mergeMode).toBe('offline');
    expect(result.phase1.reviewRequested).toBe(true);
    expect(result.phase1.mergePending).toBe(true); // the gate held: pending before PASS
    expect(result.phase1.passVerdictRecorded).toBe(true);
    expect(result.phase1.merged).toBe(true); // landed only after the recorded PASS
    expect(result.phase1.mergedFileOnIntegration).toBe(true);
    // The repo never gained a remote — the whole loop ran Offline end to end.
    expect(resolveRepoMode(projectId, repo)).toBe('offline');
  });
});
