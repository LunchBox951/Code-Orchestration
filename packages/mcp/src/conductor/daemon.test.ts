/**
 * AC-S10-1 [sandbox] acceptance for the Conductor DAEMON. Over `FakePty` + injected time, a
 * deterministic test proves the run-loop:
 *   recover (`recoverProjectStore`) → reconstruct the live set (`selectAllSessions` joined to the
 *   roster) → select a WAITING+actionable candidate → `runCycle` drives EXACTLY ONE turn → on cadence,
 *   `tickClarifyTimeouts` AND `ReconcileLoop.tick` both fire → deterministic / replay-consistent →
 *   single launch authority (warm reuse, MNR-5) → an errored turn does NOT drop its mail (MNR-2).
 *
 * Plus the must-not-regress invariants: #1 silent-stop (the reconcile cadence drives the watchdog →
 * nudge → STUCK; completion stays verb-keyed, never turn-end), #2 errored turn keeps mail, #5 single
 * launch authority. Determinism: NO wall clock in the testable path — `now` reads a mutable counter;
 * `quietWindow` is a controllable settle seam. The harness mirrors `engine.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CoReviewGate,
  FakePty,
  MAIL_CLARIFY_REQUEST,
  MAIL_CLARIFY_RESPONSE,
  ReconcileLoop,
  accountForProvider,
  buildCoreRegistry,
  defaultMailRenderer,
  openDispatchStore,
  openMailStore,
  openRegistry,
  openReviewStore,
  openRosterStore,
  openSessionStore,
  openWorktreeStore,
  recoverProjectStore,
  WEDGE_MS,
  type BreakInfo,
  type DeliveredMail,
  type DetectorEvent,
  type LivenessInput,
  type MailStore,
  type PlacementRecord,
  type ProjectId,
  type ProjectRegistry,
  type ReconcileSeams,
  type ReviewerSpawnGate,
  type RosterStore,
  type RunningAgent,
  type SessionStore,
} from '@co/core';
import { ConductorEngine, type ConductorEngineDeps } from './engine.js';
import { ConductorDaemon, type DaemonTickOutcome } from './daemon.js';
import type { HostedIdentity } from '../live-session-host.js';

// ── Scripted startup fixture. ESC authored via `fromCharCode` so the SOURCE holds no raw control byte. ──
const ESC = String.fromCharCode(0x1b);
const CLAUDE_READY = ESC + '[2J' + ESC + '[H' + '╭─ Welcome ─╮\r\n❯ \r\n  ? for shortcuts\r\n';

// ── Cleanup state ────────────────────────────────────────────────────────────
const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let engines: ConductorEngine[] = [];
let registries: ProjectRegistry[] = [];
let mailStores: MailStore[] = [];
let rosterStores: RosterStore[] = [];
let sessionStores: SessionStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  engines = [];
  registries = [];
  mailStores = [];
  rosterStores = [];
  sessionStores = [];
});

afterEach(async () => {
  for (const engine of engines) {
    try {
      await engine.closeAll();
    } catch {
      /* best-effort */
    }
  }
  for (const closeable of [...mailStores, ...rosterStores, ...sessionStores, ...registries]) {
    try {
      closeable.close();
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

// ── Helpers (mirroring engine.test.ts) ─────────────────────────────────────────
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function makeProject(): { projectId: ProjectId; cwd: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'co-daemon-'));
  dataDirs.push(dataDir);
  process.env.CO_DATA_DIR = dataDir;
  const registry = openRegistry();
  registries.push(registry);
  const cwd = join(dataDir, 'repo');
  return { projectId: registry.register(cwd), cwd };
}

/** Seed the parent chain a real Conductor spawn would have recorded (mirrors engine.test.ts). */
function seedParentChain(projectId: ProjectId, parent: string): void {
  const roster = openRosterStore(projectId);
  rosterStores.push(roster);
  if (parent === '@operator') return;
  roster.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
  if (parent === 'coord-1') return;
  if (parent === 'lead-1') {
    roster.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-1' });
    return;
  }
  throw new Error(`test fixture does not know how to seed parent '${parent}'`);
}

function makeIdentity(
  over: Partial<HostedIdentity> & Pick<HostedIdentity, 'agent' | 'projectId' | 'cwd'>,
): HostedIdentity {
  return {
    role: 'implementer',
    parent: 'lead-1',
    pane: `pane-${over.agent}`,
    provider: 'claude',
    resume: { provider: 'claude', sessionId: `session-${over.agent}` },
    ...over,
  };
}

function seedActionableMail(projectId: ProjectId, agent: string, from = 'lead-1'): void {
  const mail = openMailStore(projectId);
  try {
    mail.send({
      type: 'clarify_request',
      to: agent,
      from,
      subject: 'do the thing',
      body: 'please act',
    });
  } finally {
    mail.close();
  }
}

function seedUnreadTurnWakeMail(projectId: ProjectId, agent: string): DeliveredMail {
  const mail = openMailStore(projectId);
  try {
    const request = mail.send({
      type: MAIL_CLARIFY_REQUEST,
      to: 'lead-1',
      from: agent,
      subject: 'question',
      body: 'need input',
    });
    return mail.reply(request, {
      type: MAIL_CLARIFY_RESPONSE,
      from: 'lead-1',
      subject: 'answer',
      body: 'resolved',
    });
  } finally {
    mail.close();
  }
}

function seedWorktree(projectId: ProjectId, identity: HostedIdentity): void {
  const worktrees = openWorktreeStore(projectId);
  try {
    worktrees.recordWorktree({
      branch: `co/${identity.agent}`,
      baseRef: 'main',
      baseSha: 'a'.repeat(40),
      path: identity.cwd,
      parent: identity.parent,
      agent: identity.agent,
      role: identity.role,
      ...(identity.subRole != null ? { subRole: identity.subRole } : {}),
    });
  } finally {
    worktrees.close();
  }
}

function outstandingItem(projectId: ProjectId, agent: string): DeliveredMail {
  const store = openMailStore(projectId);
  mailStores.push(store);
  const item = store.outstanding(agent)[0];
  if (item == null) throw new Error(`test expected an outstanding item for '${agent}'`);
  return item;
}

function outstandingCount(projectId: ProjectId, agent: string): number {
  const store = openMailStore(projectId);
  mailStores.push(store);
  return store.outstanding(agent).length;
}

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

function makeEngine(
  clock: ReturnType<typeof makeClock>,
  qw: ReturnType<typeof makeQuietWindow>,
  over: Partial<ConductorEngineDeps> = {},
): { engine: ConductorEngine; pty: FakePty } {
  const pty = new FakePty();
  const engine = new ConductorEngine({
    pty,
    makeTransport: () => InMemoryTransport.createLinkedPair(),
    now: clock.now,
    quietWindow: qw.quietWindow,
    injectOptions: { retryDelay: () => new Promise<void>(() => {}) },
    ...over,
  });
  engines.push(engine);
  return { engine, pty };
}

/** A reconcile loop whose seams are inert by default (empty running set); override per test. */
function makeReconcile(
  clock: ReturnType<typeof makeClock>,
  over: Partial<ReconcileSeams> = {},
): ReconcileLoop {
  return new ReconcileLoop({
    runningAgents: () => [],
    livenessInputFor: () => undefined,
    now: clock.now,
    onBreak: () => {},
    markStuck: () => {},
    ...over,
  });
}

function makeDaemon(
  engine: ConductorEngine,
  reconcile: ReconcileLoop,
  projectId: ProjectId,
  clock: ReturnType<typeof makeClock>,
  over: Partial<
    Omit<
      ConstructorParameters<typeof ConductorDaemon>[0],
      'engine' | 'reconcile' | 'projectId' | 'now'
    >
  > = {},
): ConductorDaemon {
  return new ConductorDaemon({
    engine,
    reconcile,
    projectId,
    now: clock.now,
    reconcileEvery: 1,
    ...over,
  });
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

/** Spawn + drive a pane to ready (stands in for a P2 spawn: writes the session + roster records). */
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

// ── AC-S10-1 (1)+(2): recover → reconstruct the live set → select → drive one turn ──────────────
describe('ConductorDaemon — recover → reconstruct live set → select → drive EXACTLY ONE turn', () => {
  it('recovers, reconstructs the live set from selectAllSessions+roster, and drives one idle turn', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);

    // A spawn (P2 stand-in) hosts impl-x: writes the session.created + roster records the daemon recovers.
    const pane = await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));
    seedActionableMail(projectId, 'impl-x');

    let recoverCalls = 0;
    const daemon = makeDaemon(engine, makeReconcile(clock), projectId, clock, {
      // real recovery: rebuild every read-model from the event log (byte-equal to pre-crash).
      recover: (pid) => {
        recoverCalls += 1;
        recoverProjectStore(pid);
      },
    });

    // recover() reconstructs the live set: impl-x with role/parent joined from the roster.
    const live = daemon.recover();
    expect(recoverCalls).toBe(1);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      agent: 'impl-x',
      role: 'implementer',
      parent: 'lead-1',
      pane: 'pane-impl-x',
      provider: 'claude',
      projectId,
      cwd,
    });

    // tick: select impl-x (warm reuse — no relaunch), drive EXACTLY ONE turn to an idle boundary.
    const tickP = daemon.tick();
    await driveTurnToIdle(pane, outstandingItem(projectId, 'impl-x'), clock, qw);
    const out = await tickP;

    expect(recoverCalls).toBe(1); // tick did NOT recover again (recovery is once, on start)
    expect(out.selected).toBe('impl-x');
    expect(out.candidateCount).toBe(1);
    expect(out.cycle?.turn.errored).toBe(false);
    expect(out.cycle?.turn.turnEnd?.idle).toBe(true);
    // turn-end is a liveness signal ONLY — NOT "done" (completion stays verb-keyed).
    expect(out.cycle?.turn.turnEnd?.sawCompletionVerb).toBe(false);
    // EXACTLY one turn: the composer received exactly one submit (Enter).
    expect(pane.written.filter((w) => w === '\r')).toHaveLength(1);
    // warm reuse: still hosted, no second pane spawned (single launch authority).
    expect(engine.isHosted(projectId, 'impl-x')).toBe(true);
    expect(pty.panes).toHaveLength(1);
  });

  it('lazily recovers on the first tick when recover() was not called explicitly', async () => {
    const { projectId } = makeProject();
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    let recoverCalls = 0;
    const daemon = makeDaemon(engine, makeReconcile(clock), projectId, clock, {
      recover: () => void (recoverCalls += 1),
    });

    const out = await daemon.tick(); // empty project ⇒ no candidates, nothing driven
    expect(recoverCalls).toBe(1);
    expect(out.selected).toBeNull();
    expect(out.candidateCount).toBe(0);

    await daemon.tick();
    expect(recoverCalls).toBe(1); // still once — recovery is a one-time start operation
  });

  it('recovers the GLOBAL store (config + registry) on start, not just the project (#7 §5 #7)', () => {
    const { projectId } = makeProject();
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    let projectRecovers = 0;
    let globalRecovers = 0;
    const daemon = makeDaemon(engine, makeReconcile(clock), projectId, clock, {
      recover: () => void (projectRecovers += 1),
      recoverGlobal: () => void (globalRecovers += 1),
    });

    daemon.recover();
    expect(projectRecovers).toBe(1);
    expect(globalRecovers).toBe(1);
  });
});

// ── AC-S10-1 (2) / Principle 9: a session with no roster record fails loud (never silently dropped) ──
describe('ConductorDaemon — buildCandidates fails loud on a corrupt/partial recovered state', () => {
  it('throws when a running session has no roster record (does not silently drop the agent)', () => {
    const { projectId, cwd } = makeProject();
    // Record a session for a ghost agent WITHOUT a roster record (corrupt/partial state).
    const sessions = openSessionStore(projectId);
    sessionStores.push(sessions);
    sessions.recordSession({
      agentId: 'ghost',
      pane: 'pane-ghost',
      cwd,
      provider: 'claude',
      resume: { provider: 'claude', sessionId: 'session-ghost' },
    });

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const daemon = makeDaemon(engine, makeReconcile(clock), projectId, clock);

    expect(() => daemon.buildCandidates()).toThrow(/no roster record|fail loud/i);
  });
});

// ── AC-S10-1 (3): the reconcile/clarify cadence fires only every Nth tick ────────────────────────
describe('ConductorDaemon — the reconcile + clarify cadence fires every N ticks', () => {
  it('runs ReconcileLoop.tick + tickClarifyTimeouts only on cadence ticks (N=2)', async () => {
    const { projectId } = makeProject();
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);

    let reconcileTicks = 0;
    const reconcile = makeReconcile(clock, {
      runningAgents: () => {
        reconcileTicks += 1; // runningAgents is read once per ReconcileLoop.tick
        return [];
      },
    });
    const daemon = makeDaemon(engine, reconcile, projectId, clock, { reconcileEvery: 2 });

    const t1 = await daemon.tick();
    expect(t1.cadenceFired).toBe(false);
    expect(t1.reconcile).toBeNull();
    expect(reconcileTicks).toBe(0);

    const t2 = await daemon.tick();
    expect(t2.cadenceFired).toBe(true);
    expect(t2.reconcile).not.toBeNull();
    expect(reconcileTicks).toBe(1);

    const t3 = await daemon.tick();
    expect(t3.cadenceFired).toBe(false);
    const t4 = await daemon.tick();
    expect(t4.cadenceFired).toBe(true);
    expect(reconcileTicks).toBe(2);
  });

  it('the cadence tick forwards an expired clarify-timeout (tickClarifyTimeouts is wired)', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw, { clarifyTimeoutSeconds: () => 1800 });

    // impl-x is a hosted asker (no outstanding actionable item — it's waiting on lead-1).
    await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));
    const store = openMailStore(projectId);
    mailStores.push(store);
    const clarify = store.send({
      type: 'clarify_request',
      to: 'lead-1',
      from: 'impl-x',
      subject: 'which provider?',
      body: 'claude or codex?',
    });

    const daemon = makeDaemon(engine, makeReconcile(clock), projectId, clock);

    clock.set(0);
    const t1 = await daemon.tick(); // observes the clarify, starts its clock; selects nothing
    expect(t1.selected).toBeNull();
    expect(t1.clarifyForwarded).toHaveLength(0);

    clock.set(1800 * 1000 + 1);
    const t2 = await daemon.tick(); // past the timeout ⇒ forwards lead-1's held clarify up to coord-1
    expect(t2.clarifyForwarded).toHaveLength(1);
    const escalation = store.inbox('coord-1').find((m) => m.causationId === String(clarify.seq));
    expect(escalation?.type).toBe('escalation');
    expect(escalation?.sender).toBe('lead-1');
  });
});

// ── AC-S10-1 (4): deterministic / replay-consistent ─────────────────────────────────────────────
describe('ConductorDaemon — deterministic: same injected inputs ⇒ same tick-outcome sequence', () => {
  type Summary = {
    tick: number;
    candidateCount: number;
    selected: string | null;
    cadenceFired: boolean;
    idle: boolean | undefined;
    errored: boolean | undefined;
  };
  const summarize = (o: DaemonTickOutcome): Summary => ({
    tick: o.tick,
    candidateCount: o.candidateCount,
    selected: o.selected,
    cadenceFired: o.cadenceFired,
    idle: o.cycle?.turn.turnEnd?.idle,
    errored: o.cycle?.turn.errored,
  });

  async function runScenario(): Promise<Summary[]> {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const pane = await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));
    seedActionableMail(projectId, 'impl-x');
    const daemon = makeDaemon(engine, makeReconcile(clock), projectId, clock);

    const summaries: Summary[] = [];
    for (let i = 0; i < 2; i++) {
      // the actionable item is unresolved (completion is verb-keyed) ⇒ re-selectable each tick.
      const item = outstandingItem(projectId, 'impl-x');
      const tickP = daemon.tick();
      await driveTurnToIdle(pane, item, clock, qw);
      summaries.push(summarize(await tickP));
    }
    return summaries;
  }

  it('two identical runs produce identical tick-outcome summaries', async () => {
    const run1 = await runScenario();
    const run2 = await runScenario();
    expect(run2).toEqual(run1);
    expect(run1).toEqual([
      {
        tick: 1,
        candidateCount: 1,
        selected: 'impl-x',
        cadenceFired: true,
        idle: true,
        errored: false,
      },
      {
        tick: 2,
        candidateCount: 1,
        selected: 'impl-x',
        cadenceFired: true,
        idle: true,
        errored: false,
      },
    ]);
  });
});

// ── AC-S10-1 (5) / MNR #5: single launch authority — no duplicate host across ticks ─────────────
describe('ConductorDaemon — single launch authority (MNR-5): warm reuse, never a second spawn', () => {
  // Stage 15 P-E (AC-S15-2 / ST-2): a NON-skipped recovered cold NON-root agent is now RE-WARMED through
  // the single launch authority (proven against a spy in daemon-cold-start.test.ts — the real
  // `ensureHosted` refuses to re-record an already-active session). A SKIPPED one, by contrast, is filtered
  // out of candidates entirely and is NEVER re-warmed — `spawnSpecFor` throwing proves no launch is even
  // attempted (single launch authority respects the operator pause / STUCK suppression).
  it('does NOT re-warm a SKIPPED recovered cold session (no launch attempted)', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const roster = openRosterStore(projectId);
    rosterStores.push(roster);
    roster.recordAgent({ agentId: 'impl-cold', role: 'implementer', parent: 'lead-1' });
    const sessions = openSessionStore(projectId);
    sessionStores.push(sessions);
    sessions.recordSession({
      agentId: 'impl-cold',
      pane: 'pane-impl-cold',
      cwd,
      provider: 'claude',
      resume: { provider: 'claude', sessionId: 'session-impl-cold' },
    });
    seedActionableMail(projectId, 'impl-cold');

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw, {
      spawnSpecFor: () => {
        throw new Error('a skipped recovered agent must never be launched / re-warmed');
      },
    });
    const daemon = makeDaemon(engine, makeReconcile(clock), projectId, clock, {
      isSkipped: (_pid, agent) => agent === 'impl-cold',
    });

    const out = await daemon.tick();

    // Skipped ⇒ filtered from candidates entirely: not a candidate, not re-warmed, never launched.
    expect(out.candidateCount).toBe(0);
    expect(out.reWarmed).toEqual([]);
    expect(out.coldCandidates).toEqual([]);
    expect(out.selected).toBeNull();
    expect(out.cycle).toBeNull();
    expect(engine.isHosted(projectId, 'impl-cold')).toBe(false);
    expect(pty.panes).toHaveLength(0);
  });

  it('re-hosts a stopped non-root agent with a live worktree and wake mail', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    await hostPane(engine, pty, identity);
    seedWorktree(projectId, identity);
    await engine.release(projectId, 'impl-x');
    expect(engine.isHosted(projectId, 'impl-x')).toBe(false);
    seedActionableMail(projectId, 'impl-x', '@operator');

    const daemon = makeDaemon(engine, makeReconcile(clock), projectId, clock);
    const item = outstandingItem(projectId, 'impl-x');
    const tickP = daemon.tick();
    await tick();

    expect(pty.panes).toHaveLength(2);
    const rehostedPane = pty.panes[1]!;
    rehostedPane.emit(CLAUDE_READY);
    await driveTurnToIdle(rehostedPane, item, clock, qw);
    const out = await tickP;

    expect(out.selected).toBe('impl-x');
    expect(out.candidateCount).toBe(1);
    expect(out.cycle?.turn.errored).toBe(false);
    expect(engine.isHosted(projectId, 'impl-x')).toBe(true);
  });

  it('re-hosts a stopped non-root agent for unread turn-wake response mail', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    await hostPane(engine, pty, identity);
    seedWorktree(projectId, identity);
    await engine.release(projectId, 'impl-x');
    expect(engine.isHosted(projectId, 'impl-x')).toBe(false);
    const item = seedUnreadTurnWakeMail(projectId, 'impl-x');

    const daemon = makeDaemon(engine, makeReconcile(clock), projectId, clock);
    const tickP = daemon.tick();
    await tick();

    expect(pty.panes).toHaveLength(2);
    const rehostedPane = pty.panes[1]!;
    rehostedPane.emit(CLAUDE_READY);
    await driveTurnToIdle(rehostedPane, item, clock, qw);
    const out = await tickP;

    expect(out.selected).toBe('impl-x');
    expect(out.candidateCount).toBe(1);
    expect(out.cycle?.mail.type).toBe(MAIL_CLARIFY_RESPONSE);
    expect(engine.isHosted(projectId, 'impl-x')).toBe(true);
  });

  it('reuses the warm pane across two ticks and never spawns a second pane for one agent', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const pane = await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));
    seedActionableMail(projectId, 'impl-x');
    const daemon = makeDaemon(engine, makeReconcile(clock), projectId, clock);

    for (let i = 0; i < 2; i++) {
      const item = outstandingItem(projectId, 'impl-x');
      const tickP = daemon.tick();
      await driveTurnToIdle(pane, item, clock, qw);
      const out = await tickP;
      expect(out.cycle?.hosted.pane).toBe(pane); // the SAME warm pane each tick
      expect(pty.panes).toHaveLength(1); // never a second spawn
    }

    // The launch authority is claimed: a direct duplicate host for the warm agent is REFUSED (MNR-5).
    await expect(
      engine.ensureHosted(makeIdentity({ agent: 'impl-x', projectId, cwd })),
    ).rejects.toThrow(/already hosted|MNR-5/i);
    expect(pty.panes).toHaveLength(1);
  });
});

// ── AC-S10-1 (6) / MNR #2: an errored turn does NOT consume-and-drop its actionable mail ────────
describe('ConductorDaemon — MNR-2: an errored turn keeps its mail outstanding and re-selects', () => {
  it('an errored turn yields without consuming the mail; the agent is re-selected next tick', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const clock = makeClock();
    const qw = makeQuietWindow();
    // An injection that can never echo-verify (retryDelay resolves immediately, no echo) ⇒ the turn errors.
    const { engine, pty } = makeEngine(clock, qw, {
      injectOptions: { retryDelay: async () => {}, maxEchoAttempts: 2 },
    });
    await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));
    seedActionableMail(projectId, 'impl-x');
    const daemon = makeDaemon(engine, makeReconcile(clock), projectId, clock);

    const t1 = await daemon.tick();
    expect(t1.selected).toBe('impl-x');
    expect(t1.cycle?.turn.errored).toBe(true);
    // The mail was NEVER marked read/resolved — it stays outstanding for re-injection.
    expect(outstandingCount(projectId, 'impl-x')).toBe(1);

    // Next tick: the still-outstanding item re-selects impl-x (the warm pane is reused).
    const t2 = await daemon.tick();
    expect(t2.selected).toBe('impl-x');
    expect(t2.cycle?.turn.errored).toBe(true);
    expect(outstandingCount(projectId, 'impl-x')).toBe(1);
    expect(pty.panes).toHaveLength(1);
  });
});

// ── MNR #1: the reconcile cadence drives the silent-stop watchdog → nudge → STUCK ───────────────
describe('ConductorDaemon — MNR #1: the reconcile cadence drives silent-stop → nudge → STUCK', () => {
  it('a daemon cadence reaches the bounded escalation for the canonical idle/no-verb/quiet trace', async () => {
    const { projectId, cwd } = makeProject();
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw); // empty live set ⇒ runCycle drives nothing

    // The canonical silent-stop observation: the turn went idle (turnActive=false) with bytes-then-quiet
    // and NO completion verb ⇒ alive + a `silent_stop` break (classified at observedAt past the window).
    clock.set(10_000); // > QUIET_WINDOW_MS so detectTurnEnd reads idle
    const silentStopTrace: DetectorEvent[] = [{ kind: 'bytes', at: 0, bytes: 100 }];
    const input: LivenessInput = {
      trace: silentStopTrace,
      exited: false,
      pidAlive: true,
      turnActive: false,
    };

    const wpty = new FakePty();
    const stuckPane = wpty.spawn({ command: 'claude', args: [], cwd, env: {} });
    const breaks: Array<{ agent: string; info: BreakInfo }> = [];
    const stuck: string[] = [];
    const nudges: string[] = [];
    const reconcile = makeReconcile(clock, {
      runningAgents: (): readonly RunningAgent[] => [
        { agentId: 'impl-stuck', pane: stuckPane, provider: 'claude' },
      ],
      livenessInputFor: () => input,
      onBreak: (agent, info) => void breaks.push({ agent, info }),
      markStuck: (agent) => void stuck.push(agent),
      injectNudge: async (_pane, triggerId) => void nudges.push(triggerId),
    });

    const daemon = makeDaemon(engine, reconcile, projectId, clock); // reconcileEvery=1 ⇒ every tick reconciles

    // Cadence #1: detect the silent-stop break → break-signal + gentle corrective nudge (not yet STUCK).
    const t1 = await daemon.tick();
    expect(t1.reconcile?.assessed).toHaveLength(1);
    expect(breaks.map((b) => b.info.kind)).toEqual(['silent_stop']);
    expect(nudges).toEqual(['finish-before-yield']);
    expect(stuck).toHaveLength(0);

    // Cadence #2: the break persists ⇒ escalate to STUCK-and-surfaced (the bounded-window cure).
    await daemon.tick();
    expect(stuck).toEqual(['impl-stuck']);
  });
});

// ── Stage 10 P3 (§3c): the additive candidate-skip seam (operator pause / STUCK) ────────────────
describe('ConductorDaemon — §3c isSkipped seam filters suppressed agents from candidates (additive)', () => {
  it('default (no isSkipped wired) drives the agent — P1 behavior byte-for-byte unchanged', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const pane = await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));
    seedActionableMail(projectId, 'impl-x');
    const daemon = makeDaemon(engine, makeReconcile(clock), projectId, clock); // no isSkipped

    expect(daemon.buildCandidates().map((i) => i.agent)).toEqual(['impl-x']);
    const tickP = daemon.tick();
    await driveTurnToIdle(pane, outstandingItem(projectId, 'impl-x'), clock, qw);
    expect((await tickP).selected).toBe('impl-x');
  });

  it('a suppressed agent is filtered out (NOT driven); clearing the skip drives it again (resume)', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const pane = await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));
    seedActionableMail(projectId, 'impl-x');

    const skipped = new Set<string>(['impl-x']);
    const daemon = makeDaemon(engine, makeReconcile(clock), projectId, clock, {
      isSkipped: (_pid, agent) => skipped.has(agent),
    });

    // While suppressed: candidates EXCLUDE it; the tick selects nothing — pause takes effect (not a no-op).
    expect(daemon.buildCandidates()).toHaveLength(0);
    const out1 = await daemon.tick();
    expect(out1.selected).toBeNull();
    expect(out1.candidateCount).toBe(0);
    expect(engine.isHosted(projectId, 'impl-x')).toBe(true); // still warm — suppression never tears down
    expect(outstandingCount(projectId, 'impl-x')).toBe(1); // the mail is untouched (never driven)

    // Clear the skip ⇒ the next tick re-selects + drives the still-outstanding item.
    skipped.delete('impl-x');
    const tickP = daemon.tick();
    await driveTurnToIdle(pane, outstandingItem(projectId, 'impl-x'), clock, qw);
    expect((await tickP).selected).toBe('impl-x');
  });

  it('consults the predicate with this daemon’s projectId and each candidate agent', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));
    const calls: Array<{ pid: string; agent: string }> = [];
    const daemon = makeDaemon(engine, makeReconcile(clock), projectId, clock, {
      isSkipped: (pid, agent) => {
        calls.push({ pid, agent });
        return false;
      },
    });

    daemon.buildCandidates();
    expect(calls).toContainEqual({ pid: projectId, agent: 'impl-x' });
  });
});

// ── #133: the daemon-tick re-drive for WAITING reviewer seats ───────────────────────────────────
describe('ConductorDaemon — waiting-reviewer re-drive backstop (#133)', () => {
  const REVIEW_BRANCH_PREFIX = 'co/feat-';

  /**
   * Seed a recorded `waiting` reviewer placement + its review request via the SAME trigger path. Each
   * review uses a DISTINCT target so several can coexist as the active-serialized branch for their own
   * target (reviews into ONE target serialize — AC-L5-7).
   */
  function seedWaitingReviewer(
    projectId: ProjectId,
    reviewId: string,
    branch: string,
    target = `co/dev-${reviewId}`,
  ): void {
    const reviews = openReviewStore(projectId);
    const worktrees = openWorktreeStore(projectId);
    const mail = openMailStore(projectId);
    const dispatch = openDispatchStore(projectId);
    try {
      const setupGate = new CoReviewGate({
        reviews,
        worktrees,
        mail,
        resolveMode: () => 'offline',
        dispatch,
        nowMs: 0,
      });
      setupGate.triggerReview({
        reviewId,
        target,
        branch,
        requestedBy: 'lead-1',
        scope: 'pr_merge',
        projectId,
      });
    } finally {
      dispatch.close();
      mail.close();
      worktrees.close();
      reviews.close();
    }
  }

  /** Record a healthy provider snapshot so the per-tick re-resolution flips waiting → placed. */
  function recoverCapacity(projectId: ProjectId): void {
    const dispatch = openDispatchStore(projectId);
    try {
      dispatch.recordSnapshot({
        provider: 'claude',
        account: accountForProvider('claude'),
        available: true,
        source: 'test',
        sampled_at: '1970-01-01T00:00:00.000Z',
        windows: [{ kind: 'five_hour', used_pct: 1, reset_at: '1970-01-01T05:00:00.000Z' }],
      });
    } finally {
      dispatch.close();
    }
  }

  function seedUnknownWaitingReviewer(projectId: ProjectId, reviewId: string): void {
    const dispatch = openDispatchStore(projectId);
    try {
      dispatch.recordPlacement(`reviewer:pr@${reviewId}`, {
        kind: 'waiting',
        role: 'reviewer:pr',
        work_size: 'technical',
        reasoning_budget: 'standard',
        review_id: reviewId,
        review_target: `co/dev-${reviewId}`,
        review_branch: `${REVIEW_BRANCH_PREFIX}${reviewId}`,
        review_scope: 'pr_merge',
        reason: 'fixture: no review request exists for this waiting seat',
        maxed_providers: ['claude'],
        maxed_accounts: [accountForProvider('claude')],
        unavailable_providers: [],
        unavailable_accounts: [],
      });
    } finally {
      dispatch.close();
    }
  }

  /**
   * A fake reviewer spawn gate that routes EVERY launch through `engine.ensureHosted` (single authority).
   * It does NOT drive readiness inline — the test concurrently drives the freshly-spawned panes via
   * {@link drivePanesReady} while the daemon tick awaits the launch (mirrors the cold-rewake re-host test).
   */
  function routingSpawnGate(
    engine: ConductorEngine,
    cwd: string,
  ): { gate: ReviewerSpawnGate; launches: string[] } {
    const launches: string[] = [];
    const gate: ReviewerSpawnGate = {
      spawn: async (projectId: string, record: PlacementRecord): Promise<void> => {
        launches.push(record.agent);
        await engine.ensureHosted({
          agent: record.agent,
          role: 'reviewer',
          parent: 'lead-1',
          pane: `pane-${record.agent}`,
          projectId,
          cwd,
          provider: 'claude',
          resume: { provider: 'claude', sessionId: `session-${record.agent}` },
        });
      },
    };
    return { gate, launches };
  }

  /**
   * Resolve `tickP` while concurrently driving every newly-spawned FakePty pane to ready (emit
   * CLAUDE_READY once per pane). The daemon tick blocks on the re-drive's `engine.ensureHosted` →
   * `driveToReady`, so the tick cannot settle until each reviewer pane is driven; this loop unblocks it.
   * The re-driven reviewer is suppressed from candidate selection (the test's `isSkipped`), so the SAME
   * tick's `runCycle` never DRIVES the fresh reviewer — only ready-driving is needed here.
   */
  async function drivePanesReady<T>(tickP: Promise<T>, pty: FakePty): Promise<T> {
    const driven = new Set<FakePty['panes'][number]>();
    let settled = false;
    const result = tickP.then((value) => {
      settled = true;
      return value;
    });
    while (!settled) {
      for (const pane of pty.panes) {
        if (!driven.has(pane)) {
          driven.add(pane);
          pane.emit(CLAUDE_READY);
        }
      }
      await tick();
    }
    return result;
  }

  /** Skip every re-driven reviewer seat from candidate selection so `runCycle` never drives it this tick. */
  function skipReviewerSeats(_pid: ProjectId, agent: string): boolean {
    return agent.includes('@rev-');
  }

  it('ONE tick launches the recovered reviewer through engine.ensureHosted + reports it in the outcome', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    seedWaitingReviewer(projectId, 'rev-A', `${REVIEW_BRANCH_PREFIX}a`);
    recoverCapacity(projectId);

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const { gate: spawnGate, launches } = routingSpawnGate(engine, cwd);
    const daemon = makeDaemon(engine, makeReconcile(clock), projectId, clock, {
      reviewerSpawnGate: () => spawnGate,
      isSkipped: skipReviewerSeats, // launch the reviewer this tick, but don't drive its kickoff turn here
    });

    const out = await drivePanesReady(daemon.tick(), pty);

    expect(launches).toEqual(['reviewer:pr@rev-A']); // launched EXACTLY once via the single authority.
    expect(out.reviewersRedriven).toEqual(['reviewer:pr@rev-A']);
    expect(out.reviewerRedriveErrors).toEqual([]);
    expect(engine.isHosted(projectId, 'reviewer:pr@rev-A')).toBe(true);
    // The seat flipped waiting → placed (single placement append).
    const dispatch = openDispatchStore(projectId);
    try {
      expect(dispatch.readPlacements('reviewer:pr@rev-A').map((p) => p.kind)).toEqual([
        'waiting',
        'placed',
      ]);
    } finally {
      dispatch.close();
    }
  });

  it('drains N waiting seats at ≤K per tick (no thundering herd), the rest next tick', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    // Three waiting reviewer seats; the per-tick cap is 2.
    for (const id of ['rev-1', 'rev-2', 'rev-3']) {
      seedWaitingReviewer(projectId, id, `${REVIEW_BRANCH_PREFIX}${id}`);
    }
    recoverCapacity(projectId);

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const { gate: spawnGate, launches } = routingSpawnGate(engine, cwd);
    const daemon = makeDaemon(engine, makeReconcile(clock), projectId, clock, {
      reviewerSpawnGate: () => spawnGate,
      maxReviewerRedrivesPerTick: 2,
      isSkipped: skipReviewerSeats, // launch reviewers, but don't drive their kickoff turns this tick
    });

    const first = await drivePanesReady(daemon.tick(), pty);
    expect(first.reviewersRedriven).toHaveLength(2); // capped at K=2 this tick.
    expect(launches).toHaveLength(2);

    const second = await drivePanesReady(daemon.tick(), pty);
    expect(second.reviewersRedriven).toHaveLength(1); // the third drains next tick.
    expect(launches).toHaveLength(3);
    expect(new Set(launches)).toEqual(
      new Set(['reviewer:pr@rev-1', 'reviewer:pr@rev-2', 'reviewer:pr@rev-3']),
    );

    // A third tick is idle — all seats are placed (idempotent; no churn).
    const third = await daemon.tick();
    expect(third.reviewersRedriven).toEqual([]);
    expect(launches).toHaveLength(3);
  });

  it('does not let no-op lower-sorted seats consume the per-tick launch cap', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    seedUnknownWaitingReviewer(projectId, 'rev-000-no-request'); // sorts before the valid seat
    seedWaitingReviewer(projectId, 'rev-999-valid', `${REVIEW_BRANCH_PREFIX}valid`);
    recoverCapacity(projectId);

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const { gate: spawnGate, launches } = routingSpawnGate(engine, cwd);
    const daemon = makeDaemon(engine, makeReconcile(clock), projectId, clock, {
      reviewerSpawnGate: () => spawnGate,
      maxReviewerRedrivesPerTick: 1,
      isSkipped: skipReviewerSeats,
    });

    const out = await drivePanesReady(daemon.tick(), pty);

    expect(out.reviewersRedriven).toEqual(['reviewer:pr@rev-999-valid']);
    expect(out.reviewerRedriveErrors).toEqual([]);
    expect(launches).toEqual(['reviewer:pr@rev-999-valid']);
  });

  it('retries an already-placed reviewer seat after a transient spawn failure', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    seedWaitingReviewer(projectId, 'rev-flaky', `${REVIEW_BRANCH_PREFIX}flaky`);
    recoverCapacity(projectId);

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const { gate: baseGate, launches } = routingSpawnGate(engine, cwd);
    let failNextSpawn = true;
    const flakyGate: ReviewerSpawnGate = {
      spawn: async (projectId, record) => {
        if (failNextSpawn) {
          failNextSpawn = false;
          launches.push(record.agent);
          throw new Error('fixture spawn failed once');
        }
        await baseGate.spawn(projectId, record);
      },
    };
    const daemon = makeDaemon(engine, makeReconcile(clock), projectId, clock, {
      reviewerSpawnGate: () => flakyGate,
      isSkipped: skipReviewerSeats,
    });

    const first = await daemon.tick();

    expect(first.reviewersRedriven).toEqual([]);
    expect(first.reviewerRedriveErrors).toEqual([
      { agent: 'reviewer:pr@rev-flaky', message: 'fixture spawn failed once' },
    ]);
    expect(engine.isHosted(projectId, 'reviewer:pr@rev-flaky')).toBe(false);
    const dispatch = openDispatchStore(projectId);
    try {
      expect(dispatch.readPlacements('reviewer:pr@rev-flaky').map((p) => p.kind)).toEqual([
        'waiting',
        'placed',
      ]);
    } finally {
      dispatch.close();
    }

    const second = await drivePanesReady(daemon.tick(), pty);

    expect(second.reviewersRedriven).toEqual(['reviewer:pr@rev-flaky']);
    expect(second.reviewerRedriveErrors).toEqual([]);
    expect(engine.isHosted(projectId, 'reviewer:pr@rev-flaky')).toBe(true);
    expect(launches).toEqual(['reviewer:pr@rev-flaky', 'reviewer:pr@rev-flaky']);
    const dispatchAfterRetry = openDispatchStore(projectId);
    try {
      expect(dispatchAfterRetry.readPlacements('reviewer:pr@rev-flaky').map((p) => p.kind)).toEqual([
        'waiting',
        'placed',
      ]);
    } finally {
      dispatchAfterRetry.close();
    }
  });

  it('reports per-seat redrive errors and still runs the normal daemon cycle', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    seedWaitingReviewer(projectId, 'rev-mailfail', `${REVIEW_BRANCH_PREFIX}mailfail`);
    recoverCapacity(projectId);

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const pane = await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));
    seedActionableMail(projectId, 'impl-x');
    const throwingMail = {
      send: () => {
        throw new Error('fixture kickoff mail failed');
      },
      outstanding: () => [],
      inbox: () => [],
      close: () => {},
    } as unknown as MailStore;
    const { gate: spawnGate } = routingSpawnGate(engine, cwd);
    const daemon = makeDaemon(engine, makeReconcile(clock), projectId, clock, {
      reviewerSpawnGate: () => spawnGate,
      openMail: () => throwingMail,
    });

    const tickP = daemon.tick();
    await driveTurnToIdle(pane, outstandingItem(projectId, 'impl-x'), clock, qw);
    const out = await tickP;

    expect(out.selected).toBe('impl-x');
    expect(out.reviewerRedriveErrors).toEqual([
      { agent: 'reviewer:pr@rev-mailfail', message: 'fixture kickoff mail failed' },
    ]);
  });

  it('a still-maxed window leaves waiting seats untouched (no launch, no churn)', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    seedWaitingReviewer(projectId, 'rev-maxed', `${REVIEW_BRANCH_PREFIX}maxed`);
    // NO capacity recovered ⇒ canResume is false ⇒ the drain is skipped entirely.

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { gate: spawnGate, launches } = routingSpawnGate(engine, cwd);
    const daemon = makeDaemon(engine, makeReconcile(clock), projectId, clock, {
      reviewerSpawnGate: () => spawnGate,
    });

    const out = await daemon.tick();

    expect(out.reviewersRedriven).toEqual([]);
    expect(launches).toEqual([]);
    const dispatch = openDispatchStore(projectId);
    try {
      // Unchanged — still a single waiting row (no churn).
      expect(dispatch.readPlacements('reviewer:pr@rev-maxed').map((p) => p.kind)).toEqual([
        'waiting',
      ]);
    } finally {
      dispatch.close();
    }
  });

  it('no spawn gate wired ⇒ the drain is a no-op (never churns a waiting placement)', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId, 'lead-1');
    seedWaitingReviewer(projectId, 'rev-nogate', `${REVIEW_BRANCH_PREFIX}nogate`);
    recoverCapacity(projectId);

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const daemon = makeDaemon(engine, makeReconcile(clock), projectId, clock); // no reviewerSpawnGate

    const out = await daemon.tick();

    expect(out.reviewersRedriven).toEqual([]);
    expect(out.reviewerRedriveErrors).toEqual([]);
    const dispatch = openDispatchStore(projectId);
    try {
      expect(dispatch.readPlacements('reviewer:pr@rev-nogate').map((p) => p.kind)).toEqual([
        'waiting',
      ]);
    } finally {
      dispatch.close();
    }
  });
});

// ── Scope guardrail: the daemon registers ZERO agent MCP tools (Principle 4 + D4) ───────────────
describe('ConductorDaemon — registers ZERO agent MCP tools (never agent-callable)', () => {
  it('no conductor/daemon/serve verb appears in the canonical agent tool registry', () => {
    const names = buildCoreRegistry()
      .list()
      .map((t) => t.name);
    expect(names.some((n) => /daemon|conductor|serve|reconcile|tick/i.test(n))).toBe(false);
  });
});
