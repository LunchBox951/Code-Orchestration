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
  turnKickoffCorrelationId,
  isTurnKickoffMail,
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
import { ConductorEngine, type TurnOutcome } from './engine.js';
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

// ── #77: codex collapsed-paste kickoff re-paste loop — consume-after-cap ──────────────────────────
//
// A daemon kickoff is ALWAYS multiline (the renderer joins header + body), so injectMail bracketed-
// pastes + echo-verifies it. The codex composer is observed to COLLAPSE the paste into a preview
// instead of echoing the full text, so echoed() never matches, the multiline branch THROWS, the turn
// errors, and (pre-#77) F5 never consumed the kickoff → the daemon re-pasted it every tick forever.
// The fix BOUNDS the failed inject attempts and RETRACTS the kickoff after the cap, freeing the pane.

// Codex idle composer fixture: the `send` + `newline` ready anchor group (startup-classifier.ts).
const CODEX_READY = ESC + '[2J' + ESC + '[H' + '› \r\n  send · newline\r\n';

/**
 * Controllable inject-retry seam (the analogue of {@link makeQuietWindow} for `injectMail`): each
 * `retryDelay()` returns a promise the test settles via `settle()`. A FAILED codex turn settles it
 * with NO matching echo (so the multiline branch throws); a SUCCESS turn emits the echo first (which
 * wins the echo-vs-retry race) before settling. maxEchoAttempts:1 keeps one failed turn = one attempt.
 */
function makeInjectRetry(): {
  retryDelay: (signal?: AbortSignal) => Promise<void>;
  settle: () => void;
} {
  const waiters = new Set<() => void>();
  return {
    retryDelay: (signal) =>
      new Promise<void>((resolve) => {
        if (signal?.aborted === true) return resolve();
        const finish = (): void => {
          waiters.delete(finish);
          signal?.removeEventListener('abort', finish);
          resolve();
        };
        signal?.addEventListener('abort', finish, { once: true });
        waiters.add(finish);
      }),
    settle: () => {
      for (const w of [...waiters]) w();
    },
  };
}

function makeCodexEngine(
  clock: ReturnType<typeof makeClock>,
  qw: ReturnType<typeof makeQuietWindow>,
  retry: ReturnType<typeof makeInjectRetry>,
): { engine: ConductorEngine; pty: FakePty } {
  const pty = new FakePty();
  const engine = new ConductorEngine({
    pty,
    makeTransport: () => InMemoryTransport.createLinkedPair(),
    now: clock.now,
    quietWindow: qw.quietWindow,
    injectOptions: { retryDelay: retry.retryDelay, maxEchoAttempts: 1 },
  });
  engines.push(engine);
  return { engine, pty };
}

/** Drive ONE codex turn whose paste never echoes: settle the retry with no echo ⇒ inject THROWS. */
async function driveCodexInjectFailure(
  engine: ConductorEngine,
  hosted: ReturnType<ConductorEngine['getHosted']> & object,
  kickoff: DeliveredMail,
  retry: ReturnType<typeof makeInjectRetry>,
): Promise<TurnOutcome> {
  const turnP = engine.runOneTurn(hosted, kickoff);
  await tick();
  retry.settle(); // retry window wins with no echo ⇒ multiline branch throws
  return turnP;
}

async function hostCodexPane(
  engine: ConductorEngine,
  pty: FakePty,
  identity: HostedIdentity,
): Promise<FakePty['panes'][number]> {
  const ensureP = engine.ensureHosted(identity);
  const pane = pty.panes[pty.panes.length - 1]!;
  pane.emit(CODEX_READY);
  await ensureP;
  return pane;
}

/**
 * Seed a codex child's turn-kickoff exactly as `co_sling`'s PLACED path does — an actionable
 * `clarify_request` carrying `turnKickoffCorrelationId(agent)` (so `isTurnKickoffMail` is true). We
 * seed it directly rather than driving the dispatch balancer to a codex placement: the #77 behavior
 * under test is the engine's consume-after-cap on a real turn-kickoff mail, not the placement policy
 * (the claude `co_sling` cases above already prove the seeding path). The body is single-line, but the
 * renderer joins header + body into MULTILINE text, so injectMail bracketed-pastes it — the codex
 * collapsed-paste failure (#77) the rest of the test exercises.
 */
function seedCodexKickoff(
  projectId: ProjectId,
  repo: string,
): { kickoff: DeliveredMail; worktreePath: string; ctxMail: MailStore } {
  const roster = openRosterStore(projectId);
  rosterStores.push(roster);
  roster.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
  roster.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-1' });
  const mail = openMailStore(projectId);
  mailStores.push(mail);
  const kickoff = mail.send({
    type: 'clarify_request',
    from: 'lead-1',
    to: 'impl-cx',
    subject: 'kickoff',
    body: 'Implement the feature per the spec in your session context.',
    correlationId: turnKickoffCorrelationId('impl-cx'),
  });
  expect(isTurnKickoffMail(kickoff)).toBe(true);
  return { kickoff, worktreePath: repo, ctxMail: mail };
}

function codexIdentity(projectId: ProjectId, worktreePath: string): HostedIdentity {
  return {
    agent: 'impl-cx',
    role: 'implementer',
    parent: 'lead-1',
    pane: 'pane-impl-cx',
    projectId,
    cwd: worktreePath,
    provider: 'codex',
    resume: { provider: 'codex', codexHome: '/tmp/codex-home-impl-cx' },
  };
}

/** Read whether the given kickoff seq is still outstanding for impl-cx (fresh store each call). */
function kickoffOutstanding(projectId: ProjectId, seq: number): boolean {
  const store = openMailStore(projectId);
  mailStores.push(store);
  return store.outstanding('impl-cx').some((m) => m.seq === seq);
}

/** Drive ONE successful codex turn: emit the collapsed-paste preview (needle-matching), then idle. */
async function driveCodexInjectSuccess(
  engine: ConductorEngine,
  hosted: ReturnType<ConductorEngine['getHosted']> & object,
  kickoff: DeliveredMail,
  pane: FakePty['panes'][number],
  clock: ReturnType<typeof makeClock>,
  qw: ReturnType<typeof makeQuietWindow>,
): Promise<TurnOutcome> {
  const turnP = engine.runOneTurn(hosted, kickoff);
  await tick();
  // The codex composer echoes a collapsed-paste preview matching CODEX_COLLAPSED_PASTE_NEEDLES
  // (['pasted','lines']) — echoed() accepts it, injectMail submits, the turn runs to idle.
  pane.emit('Pasted text — 12 lines collapsed\r\n');
  await tick();
  clock.set(1000);
  pane.emit('⠋ working…\r\n');
  await tick();
  clock.set(1000 + WEDGE_MS + 1);
  qw.settle();
  return turnP;
}

describe('#77 codex collapsed-paste kickoff — consume after the inject-attempt cap', () => {
  it('a codex kickoff whose paste never echoes is RETRACTED after the cap (not re-pasted forever)', async () => {
    const { projectId, repo } = makeProject();
    const clock = makeClock();
    const qw = makeQuietWindow();
    const retry = makeInjectRetry();
    const { engine, pty } = makeCodexEngine(clock, qw, retry);
    const { kickoff, worktreePath, ctxMail } = seedCodexKickoff(projectId, repo);
    const pane = await hostCodexPane(engine, pty, codexIdentity(projectId, worktreePath));

    // The kickoff is the only outstanding item, and it IS a turn-kickoff mail.
    expect(ctxMail.outstanding('impl-cx').map((m) => m.seq)).toEqual([kickoff.seq]);

    const CAP = 3; // ConductorEngine.KICKOFF_INJECT_ATTEMPT_CAP
    const hosted = engine.getHosted(projectId, 'impl-cx')!;

    // Drive CAP-1 failed turns: each inject throws (codex multiline paste never echoes); the kickoff
    // is NOT yet consumed (still outstanding for a retry — MNR-2).
    for (let i = 0; i < CAP - 1; i++) {
      const turn = await driveCodexInjectFailure(engine, hosted, kickoff, retry);
      expect(turn.errored).toBe(true);
      expect(kickoffOutstanding(projectId, kickoff.seq)).toBe(true);
    }

    // The CAP-th failed turn crosses the cap: the kickoff is RETRACTED so the warm pane is freed.
    const finalTurn = await driveCodexInjectFailure(engine, hosted, kickoff, retry);
    expect(finalTurn.errored).toBe(true);
    expect(kickoffOutstanding(projectId, kickoff.seq)).toBe(false);
    // No second pane was spawned; the pane is still hosted (freed of the kickoff, not killed).
    expect(pty.panes).toHaveLength(1);
    expect(engine.isHosted(projectId, 'impl-cx')).toBe(true);
    expect(pane.written.filter((w) => w === '\r')).toHaveLength(0); // never blind-fired Enter
  });

  it('NON-VACUOUS: the kickoff SURVIVES every failed turn strictly before the cap, then disappears at it', async () => {
    // Makes the consume-after-cap assertion real: the kickoff must persist at attempts 1 and 2 and
    // vanish exactly at attempt 3 — so the test fails if the cap is removed (never consumed) OR set
    // to 1 (consumed too early).
    const { projectId, repo } = makeProject();
    const clock = makeClock();
    const qw = makeQuietWindow();
    const retry = makeInjectRetry();
    const { engine, pty } = makeCodexEngine(clock, qw, retry);
    const { kickoff, worktreePath } = seedCodexKickoff(projectId, repo);
    await hostCodexPane(engine, pty, codexIdentity(projectId, worktreePath));
    const hosted = engine.getHosted(projectId, 'impl-cx')!;

    await driveCodexInjectFailure(engine, hosted, kickoff, retry); // attempt 1
    expect(kickoffOutstanding(projectId, kickoff.seq)).toBe(true);
    await driveCodexInjectFailure(engine, hosted, kickoff, retry); // attempt 2 (still < cap of 3)
    expect(kickoffOutstanding(projectId, kickoff.seq)).toBe(true);
    await driveCodexInjectFailure(engine, hosted, kickoff, retry); // attempt 3 == cap → retracted
    expect(kickoffOutstanding(projectId, kickoff.seq)).toBe(false);
  });

  it('resets the budget after a SUCCESS — NON-VACUOUS: 2 more failed injects after a success stay under the cap', async () => {
    // A success must CLEAR the failed-inject counter so the cap only ever bounds a contiguous re-paste
    // loop, never a healthy agent's later turns. Non-vacuous: after a success we do 2 MORE failed
    // injects (which, were the budget NOT reset, would be attempts 3+ ⇒ over the cap) and assert the
    // fresh kickoff is STILL outstanding (under the cap) — proving the reset happened.
    const { projectId, repo } = makeProject();
    const clock = makeClock();
    const qw = makeQuietWindow();
    const retry = makeInjectRetry();
    const { engine, pty } = makeCodexEngine(clock, qw, retry);
    const { kickoff, worktreePath } = seedCodexKickoff(projectId, repo);
    const pane = await hostCodexPane(engine, pty, codexIdentity(projectId, worktreePath));
    const hosted = engine.getHosted(projectId, 'impl-cx')!;

    // 2 failed injects (under the cap of 3) — kickoff survives.
    await driveCodexInjectFailure(engine, hosted, kickoff, retry);
    await driveCodexInjectFailure(engine, hosted, kickoff, retry);
    expect(kickoffOutstanding(projectId, kickoff.seq)).toBe(true);

    // A SUCCESS: the collapsed-paste preview echoes, injectMail submits, the turn runs to idle. This
    // consumes the kickoff AND resets the failed-inject counter.
    const successTurn = await driveCodexInjectSuccess(engine, hosted, kickoff, pane, clock, qw);
    expect(successTurn.errored).toBe(false);
    expect(kickoffOutstanding(projectId, kickoff.seq)).toBe(false);

    // Re-seed a fresh kickoff and do 2 MORE failed injects. Were the counter NOT reset, these would be
    // the 3rd/4th attempts (over the cap). Because it WAS reset, they are attempts 1 and 2 — under the
    // cap — so the fresh kickoff stays outstanding.
    const reseed = openMailStore(projectId);
    mailStores.push(reseed);
    const freshKickoff = reseed.send({
      type: 'clarify_request',
      from: 'lead-1',
      to: 'impl-cx',
      subject: 'kickoff',
      body: 'Second kickoff after a successful first turn.',
      correlationId: turnKickoffCorrelationId('impl-cx'),
    });

    await driveCodexInjectFailure(engine, hosted, freshKickoff, retry); // reset-budget attempt 1
    await driveCodexInjectFailure(engine, hosted, freshKickoff, retry); // reset-budget attempt 2 (< cap)
    expect(kickoffOutstanding(projectId, freshKickoff.seq)).toBe(true);
  });

  it('keys the budget by the SPECIFIC kickoff mail — two distinct failing kickoffs do NOT share a budget', async () => {
    // The attempt counter must be keyed by (agent + kickoff mail identity), NOT the agent alone. Drive
    // kickoff A to CAP-1 failed injects (it survives). Then seed a DISTINCT kickoff B for the SAME agent
    // (no success in between, so no reset) and drive B to CAP-1 failed injects. With a SHARED per-agent
    // budget, A's CAP-1 attempts would pre-consume B so its very FIRST failed inject would hit the cap
    // and retract B prematurely. With per-mail keying, B gets its OWN full budget and survives — proving
    // a later legitimate kickoff is never pre-consumed by an earlier one's failures.
    const { projectId, repo } = makeProject();
    const clock = makeClock();
    const qw = makeQuietWindow();
    const retry = makeInjectRetry();
    const { engine, pty } = makeCodexEngine(clock, qw, retry);
    const { kickoff: kickoffA, worktreePath } = seedCodexKickoff(projectId, repo);
    await hostCodexPane(engine, pty, codexIdentity(projectId, worktreePath));
    const hosted = engine.getHosted(projectId, 'impl-cx')!;

    const CAP = 3; // ConductorEngine.KICKOFF_INJECT_ATTEMPT_CAP

    // Kickoff A: CAP-1 failed injects — A survives (strictly under the cap), budget for A = CAP-1.
    for (let i = 0; i < CAP - 1; i++) {
      await driveCodexInjectFailure(engine, hosted, kickoffA, retry);
    }
    expect(kickoffOutstanding(projectId, kickoffA.seq)).toBe(true);

    // Seed a DISTINCT kickoff B for the SAME agent (different seq) — NO success has reset any budget.
    const bus = openMailStore(projectId);
    mailStores.push(bus);
    const kickoffB = bus.send({
      type: 'clarify_request',
      from: 'lead-1',
      to: 'impl-cx',
      subject: 'kickoff',
      body: 'A SECOND distinct kickoff for the same agent (e.g. a re-kick from the parent).',
      correlationId: turnKickoffCorrelationId('impl-cx'),
    });
    expect(isTurnKickoffMail(kickoffB)).toBe(true);
    expect(kickoffB.seq).not.toBe(kickoffA.seq); // genuinely distinct mail

    // Kickoff B: CAP-1 failed injects. Under per-mail keying these are B's OWN attempts 1..CAP-1, so B
    // stays outstanding. Under the OLD shared per-agent budget the FIRST of these would be attempt CAP
    // and retract B immediately — so this assertion fails if the fix is reverted (non-vacuous).
    for (let i = 0; i < CAP - 1; i++) {
      await driveCodexInjectFailure(engine, hosted, kickoffB, retry);
    }
    expect(kickoffOutstanding(projectId, kickoffB.seq)).toBe(true);

    // And B's own budget is honored end-to-end: ITS cap-th failed inject (not A's) retracts B.
    await driveCodexInjectFailure(engine, hosted, kickoffB, retry);
    expect(kickoffOutstanding(projectId, kickoffB.seq)).toBe(false);
  });
});
