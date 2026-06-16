/**
 * Stage 14 · P2 [sandbox] — SLING KICKOFF → DAEMON FIRST-TURN. Proves that after `co_sling`
 * provisions a child and seeds an actionable `clarify_request` kickoff, a `daemon.tick()` selects
 * the child and drives its first turn — the cold→warm→first-turn path. Ladders AC-S14-2.
 *
 * Composition mirrors `daemon.test.ts` / `daemon-cold-start.test.ts`: `FakePty`, injected counter
 * clock, `makeReconcile`, `InMemoryTransport`. The kickoff is seeded by the REAL `co_sling` tool
 * (via `invokeTool`) and asserted via the stores + tick outcome — never the scripted agent's claims.
 * Across-tree: a coordinator-slung lead gets its first turn driven, and a lead-slung worker gets
 * its first turn driven, each on its own daemon tick.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  FakePty,
  WEDGE_MS,
  ReconcileLoop,
  accountForProvider,
  buildCoreRegistry,
  defaultMailRenderer,
  invokeTool,
  openDispatchStore,
  openMailStore,
  openRegistry,
  openRosterStore,
  openWorktreeStore,
  type DeliveredMail,
  type DispatchStore,
  type MailStore,
  type ProjectId,
  type ProjectRegistry,
  type ReviewerSpawnGate,
  type RosterStore,
  type UsageSnapshot,
  type WorktreeStore,
} from '@co/core';
import { ConductorDaemon } from './daemon.js';
import { ConductorEngine } from './engine.js';
import type { HostedIdentity } from '../live-session-host.js';

// ── Scripted startup fixture. ESC via fromCharCode so the SOURCE holds no raw control byte. ──
const ESC = String.fromCharCode(0x1b);
const CLAUDE_READY = ESC + '[2J' + ESC + '[H' + '╭─ Welcome ─╮\r\n❯ \r\n  ? for shortcuts\r\n';

// ── A healthy Claude usage snapshot for dispatch placement ────────────────────────────────────────
const HEALTHY_SNAPSHOT: UsageSnapshot = {
  provider: 'claude',
  account: accountForProvider('claude'),
  available: true,
  source: 'fake',
  sampled_at: new Date().toISOString(),
  windows: [
    {
      kind: 'five_hour',
      used_pct: 20,
      reset_at: new Date(Date.now() + 5 * 3600_000).toISOString(),
    },
  ],
};

// ── Cleanup state ────────────────────────────────────────────────────────────────────────────────
const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let repoDirs: string[] = [];
let engines: ConductorEngine[] = [];
let registries: ProjectRegistry[] = [];
let mailStores: MailStore[] = [];
let rosterStores: RosterStore[] = [];
let worktreeStores: WorktreeStore[] = [];
let dispatchStores: DispatchStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  repoDirs = [];
  engines = [];
  registries = [];
  mailStores = [];
  rosterStores = [];
  worktreeStores = [];
  dispatchStores = [];
});

afterEach(async () => {
  for (const engine of engines) {
    try {
      await engine.closeAll();
    } catch {
      /* best-effort */
    }
  }
  for (const closeable of [
    ...mailStores,
    ...rosterStores,
    ...worktreeStores,
    ...dispatchStores,
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

// ── Git / project helpers (mirror daemon-cold-start.test.ts) ─────────────────────────────────────

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-sling-kickoff-repo-'));
  repoDirs.push(dir);
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir, 'README.md'), 'base\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'chore: init', '-m', 'Signed-off-by: Test <t@example.com>');
  return dir;
}

function makeProject(): { projectId: ProjectId; repo: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'co-sling-kickoff-data-'));
  dataDirs.push(dataDir);
  process.env.CO_DATA_DIR = dataDir;
  const repo = makeRepo();
  const registry = openRegistry();
  registries.push(registry);
  return { projectId: registry.register(repo), repo };
}

// ── Deterministic seams (counter clock + controllable quiet window — never a wall clock) ─────────

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

// ── Engine + daemon factories (mirror daemon.test.ts) ────────────────────────────────────────────

function makeEngine(
  clock: ReturnType<typeof makeClock>,
  qw: ReturnType<typeof makeQuietWindow>,
): { engine: ConductorEngine; pty: FakePty } {
  const pty = new FakePty();
  const engine = new ConductorEngine({
    pty,
    makeTransport: () => InMemoryTransport.createLinkedPair(),
    now: clock.now,
    quietWindow: qw.quietWindow,
    injectOptions: { retryDelay: () => new Promise<void>(() => {}) },
  });
  engines.push(engine);
  return { engine, pty };
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

function makeDaemon(
  engine: ConductorEngine,
  clock: ReturnType<typeof makeClock>,
  projectId: ProjectId,
): ConductorDaemon {
  return new ConductorDaemon({
    engine,
    reconcile: makeReconcile(clock),
    projectId,
    now: clock.now,
    reconcileEvery: 1,
  });
}

/** Host a pane like daemon.test.ts's hostPane — spawn + CLAUDE_READY + await ready. */
async function hostPane(
  engine: ConductorEngine,
  pty: FakePty,
  identity: HostedIdentity,
): Promise<FakePty['panes'][number]> {
  const ensureP = engine.ensureHosted(identity);
  const pane = pty.panes[pty.panes.length - 1]!;
  pane.emit(CLAUDE_READY);
  await ensureP;
  return pane;
}

/** Drive a hosted FakePty pane through ONE idle turn (echo the inject, emit bytes, settle quiet). */
async function driveTurnToIdle(
  pane: FakePty['panes'][number],
  item: DeliveredMail,
  clock: ReturnType<typeof makeClock>,
  qw: ReturnType<typeof makeQuietWindow>,
): Promise<void> {
  await tick();
  pane.emit(defaultMailRenderer(item));
  await tick();
  clock.set(1000);
  pane.emit('⠋ working…\r\n');
  await tick();
  clock.set(1000 + WEDGE_MS + 1);
  qw.settle();
}

/** Read the first outstanding item for agent — fail loud if absent (test precondition). */
function kickoffFor(mail: MailStore, agent: string): DeliveredMail {
  const item = mail.outstanding(agent)[0];
  if (item == null) throw new Error(`test expected an outstanding kickoff for '${agent}'`);
  return item;
}

/** Build a ToolContext-like object for co_sling: all required stores plus a dispatch snapshot. */
function makeToolContext(
  callerAgent: string,
  projectId: ProjectId,
  repo: string,
): {
  agent: string;
  projectId: ProjectId;
  cwd: string;
  mail: MailStore;
  registry: ReturnType<typeof openRegistry>;
  worktrees: WorktreeStore;
  dispatch: DispatchStore;
  roster: RosterStore;
} {
  const registry = openRegistry();
  registries.push(registry);
  const mail = openMailStore(projectId);
  mailStores.push(mail);
  const worktrees = openWorktreeStore(projectId);
  worktreeStores.push(worktrees);
  const dispatch = openDispatchStore(projectId);
  dispatchStores.push(dispatch);
  const roster = openRosterStore(projectId);
  rosterStores.push(roster);
  dispatch.recordSnapshot(HEALTHY_SNAPSHOT);
  return { agent: callerAgent, projectId, cwd: repo, mail, registry, worktrees, dispatch, roster };
}

// ── AC-S14-2: co_sling seeds kickoff → daemon drives first turn ───────────────────────────────────

describe('co_sling kickoff → daemon first-turn (AC-S14-2)', () => {
  it('slung child has a kickoff in its inbox and the daemon drives its first turn in one tick', async () => {
    const { projectId, repo } = makeProject();
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const daemon = makeDaemon(engine, clock, projectId);

    // Register the parent chain: coord-1 (coordinator) → lead-1 (lead, the slinger).
    const roster = openRosterStore(projectId);
    rosterStores.push(roster);
    roster.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
    roster.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-1' });

    // Build a ToolContext for lead-1 (the slinging parent).
    const ctx = makeToolContext('lead-1', projectId, repo);

    // Spy gate: records agent ids spawned (mirrors sling.test.ts's spawn-gate integration test).
    const spawned: string[] = [];
    const spyGate: ReviewerSpawnGate = {
      spawn: async (_pId, record) => {
        spawned.push(record.agent);
      },
    };

    // co_sling: provisions the child worktree + seeds the kickoff clarify_request.
    const out = (await invokeTool(
      buildCoreRegistry(),
      { ...ctx, reviewerSpawnGate: spyGate },
      'co_sling',
      {
        parent: 'lead-1',
        agent: 'impl-1',
        branch: 'co/sling-kickoff-test',
        kickoff: 'Implement the feature per the spec in your session context.',
      },
    )) as { status: string; worktree_path: string };

    expect(out.status).toBe('placed');
    expect(spawned).toEqual(['impl-1']); // spawn gate was called for the slung child

    // The kickoff is in the child's outstanding inbox — seeded by co_sling's PLACED path.
    const kickoff = kickoffFor(ctx.mail, 'impl-1');
    expect(kickoff.type).toBe('clarify_request');
    expect(kickoff.recipient).toBe('impl-1');
    expect(kickoff.sender).toBe('lead-1');
    expect(kickoff.body).toBe('Implement the feature per the spec in your session context.');
    expect(kickoff.kind).toBe('actionable');

    // Host the child pane (stands in for the P2 spawn gate hosing it in production).
    const identity: HostedIdentity = {
      agent: 'impl-1',
      role: 'implementer',
      parent: 'lead-1',
      pane: 'pane-impl-1',
      projectId,
      cwd: out.worktree_path,
      provider: 'claude',
      resume: { provider: 'claude', sessionId: 'session-impl-1' },
    };
    const pane = await hostPane(engine, pty, identity);

    // daemon.tick() selects impl-1 (warm + outstanding actionable kickoff) and drives its first turn.
    const tickP = daemon.tick();
    await driveTurnToIdle(pane, kickoff, clock, qw);
    const tickOut = await tickP;

    expect(tickOut.selected).toBe('impl-1');
    expect(tickOut.candidateCount).toBe(1);
    expect(tickOut.cycle?.turn.errored).toBe(false);
    expect(tickOut.cycle?.turn.turnEnd?.idle).toBe(true);
    // EXACTLY one turn driven: one Enter submitted.
    expect(pane.written.filter((w) => w === '\r')).toHaveLength(1);
    // Warm reuse: still hosted, no second pane spawned.
    expect(engine.isHosted(projectId, 'impl-1')).toBe(true);
    expect(pty.panes).toHaveLength(1);
  });

  it('across the tree (coordinator-slung lead): coord slings lead, daemon drives lead first turn', async () => {
    const { projectId, repo } = makeProject();
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const daemon = makeDaemon(engine, clock, projectId);

    // Register coord-1 (coordinator, parent=@operator) — the slinger for the lead.
    const roster = openRosterStore(projectId);
    rosterStores.push(roster);
    roster.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });

    // Build a ToolContext for coord-1 (the slinging parent).
    const ctx = makeToolContext('coord-1', projectId, repo);
    const spawnedFromCoord: string[] = [];
    const coordSpawnGate: ReviewerSpawnGate = {
      spawn: async (_pId, record) => {
        spawnedFromCoord.push(record.agent);
      },
    };

    // co_sling: coord-1 slings lead-1.
    const leadOut = (await invokeTool(
      buildCoreRegistry(),
      { ...ctx, reviewerSpawnGate: coordSpawnGate },
      'co_sling',
      {
        parent: 'coord-1',
        agent: 'lead-1',
        branch: 'co/lead-tree-kickoff',
        role: 'lead',
        kickoff: 'Coordinate the feature implementation across your implementers.',
      },
    )) as { status: string; worktree_path: string };

    expect(leadOut.status).toBe('placed');
    expect(spawnedFromCoord).toEqual(['lead-1']);

    // lead-1 has its kickoff in its inbox.
    const leadKickoff = kickoffFor(ctx.mail, 'lead-1');
    expect(leadKickoff.type).toBe('clarify_request');
    expect(leadKickoff.sender).toBe('coord-1');
    expect(leadKickoff.recipient).toBe('lead-1');
    expect(leadKickoff.kind).toBe('actionable');

    // Host lead-1 (stands in for the P2 spawn gate hosting it).
    const leadIdentity: HostedIdentity = {
      agent: 'lead-1',
      role: 'lead',
      parent: 'coord-1',
      pane: 'pane-lead-1',
      projectId,
      cwd: leadOut.worktree_path,
      provider: 'claude',
      resume: { provider: 'claude', sessionId: 'session-lead-1' },
    };
    const leadPane = await hostPane(engine, pty, leadIdentity);

    // Daemon tick: selects lead-1 (the only warm candidate with outstanding actionable kickoff).
    const tickP = daemon.tick();
    await driveTurnToIdle(leadPane, leadKickoff, clock, qw);
    const tickOut = await tickP;

    expect(tickOut.selected).toBe('lead-1');
    expect(tickOut.candidateCount).toBe(1);
    expect(tickOut.cycle?.turn.errored).toBe(false);
    expect(tickOut.cycle?.turn.turnEnd?.idle).toBe(true);
    expect(pty.panes).toHaveLength(1);
  });

  it('across the tree (lead-slung worker): lead slings worker, daemon drives worker first turn', async () => {
    const { projectId, repo } = makeProject();
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const daemon = makeDaemon(engine, clock, projectId);

    // Register the parent chain: coord-1 → lead-1 (the slinger for the worker).
    const roster = openRosterStore(projectId);
    rosterStores.push(roster);
    roster.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
    roster.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-1' });

    // Build a ToolContext for lead-1 (the slinging parent).
    const ctx = makeToolContext('lead-1', projectId, repo);
    const spawnedFromLead: string[] = [];
    const leadSpawnGate: ReviewerSpawnGate = {
      spawn: async (_pId, record) => {
        spawnedFromLead.push(record.agent);
      },
    };

    // co_sling: lead-1 slings impl-1.
    const workerOut = (await invokeTool(
      buildCoreRegistry(),
      { ...ctx, reviewerSpawnGate: leadSpawnGate },
      'co_sling',
      {
        parent: 'lead-1',
        agent: 'impl-1',
        branch: 'co/worker-tree-kickoff',
        kickoff: 'Implement the parser module per the spec in your session context.',
      },
    )) as { status: string; worktree_path: string };

    expect(workerOut.status).toBe('placed');
    expect(spawnedFromLead).toEqual(['impl-1']);

    // impl-1 has its kickoff in its inbox.
    const workerKickoff = kickoffFor(ctx.mail, 'impl-1');
    expect(workerKickoff.type).toBe('clarify_request');
    expect(workerKickoff.sender).toBe('lead-1');
    expect(workerKickoff.recipient).toBe('impl-1');
    expect(workerKickoff.kind).toBe('actionable');

    // Host impl-1.
    const workerIdentity: HostedIdentity = {
      agent: 'impl-1',
      role: 'implementer',
      parent: 'lead-1',
      pane: 'pane-impl-1',
      projectId,
      cwd: workerOut.worktree_path,
      provider: 'claude',
      resume: { provider: 'claude', sessionId: 'session-impl-1' },
    };
    const workerPane = await hostPane(engine, pty, workerIdentity);

    // Daemon tick: selects impl-1 (the only warm candidate with outstanding actionable kickoff).
    const tickP = daemon.tick();
    await driveTurnToIdle(workerPane, workerKickoff, clock, qw);
    const tickOut = await tickP;

    expect(tickOut.selected).toBe('impl-1');
    expect(tickOut.candidateCount).toBe(1);
    expect(tickOut.cycle?.turn.errored).toBe(false);
    expect(tickOut.cycle?.turn.turnEnd?.idle).toBe(true);
    expect(pty.panes).toHaveLength(1);
  });
});
