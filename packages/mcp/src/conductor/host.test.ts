/**
 * [sandbox] coverage for the `[host-live]` cadence runner + the `co serve` wiring (host.ts). Over
 * `FakePty` + a CONTROLLABLE scheduler (NOT real timers, NEVER a real provider binary), this proves:
 *   - `ConductorHostRunner.start()` recovers + arms the cadence and returns the live set;
 *   - each scheduler beat drives exactly one `daemon.tick()` and reports its outcome;
 *   - the re-entrancy guard SKIPS a beat while a prior tick is still in flight (no overlap);
 *   - `stop()` disarms;
 *   - `serveConductor` wires the whole stack over injected seams and runs;
 *   - the default `makeTransport` is the `[host-live]` operator-handoff seam (fails loud), and
 *     `runServeConductor` fails loud on a missing project id.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  FakePty,
  ReconcileLoop,
  defaultMailRenderer,
  openMailStore,
  openRegistry,
  openRosterStore,
  QUIET_WINDOW_MS,
  type DeliveredMail,
  type MailStore,
  type ProjectId,
  type ProjectRegistry,
  type RosterStore,
} from '@co/core';
import { ConductorEngine, type ConductorEngineDeps } from './engine.js';
import { ConductorDaemon, type DaemonTickOutcome } from './daemon.js';
import {
  ConductorHostRunner,
  hostLiveTransportRequired,
  runServeConductor,
  serveConductor,
  type IntervalHandle,
  type IntervalScheduler,
} from './host.js';
import type { HostedIdentity } from '../live-session-host.js';

const ESC = String.fromCharCode(0x1b);
const CLAUDE_READY = ESC + '[2J' + ESC + '[H' + '╭─ Welcome ─╮\r\n❯ \r\n  ? for shortcuts\r\n';

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let engines: ConductorEngine[] = [];
let registries: ProjectRegistry[] = [];
let mailStores: MailStore[] = [];
let rosterStores: RosterStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  engines = [];
  registries = [];
  mailStores = [];
  rosterStores = [];
});

afterEach(async () => {
  for (const engine of engines) {
    try {
      await engine.closeAll();
    } catch {
      /* best-effort */
    }
  }
  for (const closeable of [...mailStores, ...rosterStores, ...registries]) {
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

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const flush = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i++) await tick();
};

function makeProject(): { projectId: ProjectId; cwd: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'co-host-'));
  dataDirs.push(dataDir);
  process.env.CO_DATA_DIR = dataDir;
  const registry = openRegistry();
  registries.push(registry);
  const cwd = join(dataDir, 'repo');
  return { projectId: registry.register(cwd), cwd };
}

function seedParentChain(projectId: ProjectId): void {
  const roster = openRosterStore(projectId);
  rosterStores.push(roster);
  roster.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
  roster.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-1' });
}

function makeIdentity(agent: string, projectId: ProjectId, cwd: string): HostedIdentity {
  return {
    agent,
    role: 'implementer',
    parent: 'lead-1',
    pane: `pane-${agent}`,
    provider: 'claude',
    projectId,
    cwd,
    resume: { provider: 'claude', sessionId: `session-${agent}` },
  };
}

function seedActionableMail(projectId: ProjectId, agent: string): void {
  const mail = openMailStore(projectId);
  try {
    mail.send({
      type: 'clarify_request',
      to: agent,
      from: 'lead-1',
      subject: 'do it',
      body: 'act',
    });
  } finally {
    mail.close();
  }
}

function outstandingItem(projectId: ProjectId, agent: string): DeliveredMail {
  const store = openMailStore(projectId);
  mailStores.push(store);
  const item = store.outstanding(agent)[0];
  if (item == null) throw new Error(`expected an outstanding item for '${agent}'`);
  return item;
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

function makeReconcile(clock: ReturnType<typeof makeClock>): ReconcileLoop {
  return new ReconcileLoop({
    runningAgents: () => [],
    livenessInputFor: () => undefined,
    now: clock.now,
    onBreak: () => {},
    markStuck: () => {},
  });
}

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
  clock.set(1000 + QUIET_WINDOW_MS + 1);
  qw.settle();
}

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

/** A controllable scheduler: captures the cadence callback so the test fires beats by hand. */
class FakeScheduler implements IntervalScheduler {
  callback: (() => void) | null = null;
  ms: number | null = null;
  cleared = false;
  private handle: IntervalHandle | null = null;

  setInterval(callback: () => void, ms: number): IntervalHandle {
    this.callback = callback;
    this.ms = ms;
    this.handle = {};
    return this.handle;
  }

  clearInterval(handle: IntervalHandle): void {
    if (handle === this.handle) {
      this.cleared = true;
      this.callback = null;
    }
  }

  fire(): void {
    this.callback?.();
  }
}

// ── the cadence runner ───────────────────────────────────────────────────────
describe('ConductorHostRunner — recover + arm, drive a tick per beat, disarm on stop', () => {
  it('start() recovers + arms; a beat drives one tick; stop() disarms', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const pane = await hostPane(engine, pty, makeIdentity('impl-x', projectId, cwd));
    seedActionableMail(projectId, 'impl-x');
    const daemon = new ConductorDaemon({
      engine,
      reconcile: makeReconcile(clock),
      projectId,
      now: clock.now,
      reconcileEvery: 1,
    });

    const scheduler = new FakeScheduler();
    const ticks: DaemonTickOutcome[] = [];
    const runner = new ConductorHostRunner({
      daemon,
      intervalMs: 1000,
      scheduler,
      onTick: (o) => ticks.push(o),
    });

    const live = runner.start();
    expect(runner.started).toBe(true);
    expect(scheduler.ms).toBe(1000);
    expect(live.map((i) => i.agent)).toEqual(['impl-x']);

    scheduler.fire(); // one beat → daemon.tick() (drives impl-x's turn)
    await driveTurnToIdle(pane, outstandingItem(projectId, 'impl-x'), clock, qw);
    await flush();

    expect(ticks).toHaveLength(1);
    expect(ticks[0]!.selected).toBe('impl-x');
    expect(ticks[0]!.cycle?.turn.turnEnd?.idle).toBe(true);

    runner.stop();
    expect(scheduler.cleared).toBe(true);
    expect(runner.started).toBe(false);
  });

  it('refuses a double-start (single cadence owner)', () => {
    const { projectId } = makeProject();
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const daemon = new ConductorDaemon({
      engine,
      reconcile: makeReconcile(clock),
      projectId,
      now: clock.now,
      reconcileEvery: 1,
    });
    const runner = new ConductorHostRunner({
      daemon,
      intervalMs: 1000,
      scheduler: new FakeScheduler(),
    });
    runner.start();
    expect(() => runner.start()).toThrow(/already started/i);
  });

  it('skips a beat while a prior tick is still in flight (re-entrancy guard — no overlap)', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const pane = await hostPane(engine, pty, makeIdentity('impl-x', projectId, cwd));
    seedActionableMail(projectId, 'impl-x');
    const daemon = new ConductorDaemon({
      engine,
      reconcile: makeReconcile(clock),
      projectId,
      now: clock.now,
      reconcileEvery: 1,
    });
    const scheduler = new FakeScheduler();
    const ticks: DaemonTickOutcome[] = [];
    const runner = new ConductorHostRunner({
      daemon,
      intervalMs: 1000,
      scheduler,
      onTick: (o) => ticks.push(o),
    });
    runner.start();

    scheduler.fire(); // beat #1 — daemon.tick() starts and parks at the (unsettled) turn
    await tick(); // let beat #1 reach its in-flight await
    scheduler.fire(); // beat #2 — MUST be skipped (a tick is in flight)
    await tick();

    // Settle the single in-flight turn; only beat #1 completes (beat #2 never ticked).
    await driveTurnToIdle(pane, outstandingItem(projectId, 'impl-x'), clock, qw);
    await flush();
    expect(ticks).toHaveLength(1);

    // After completion the guard is clear: a fresh beat ticks again.
    scheduler.fire();
    await driveTurnToIdle(pane, outstandingItem(projectId, 'impl-x'), clock, qw);
    await flush();
    expect(ticks).toHaveLength(2);
  });
});

// ── serveConductor wiring + the [host-live] handoff seams ─────────────────────
describe('serveConductor — wires the full stack over injected seams (no real binary)', () => {
  it('builds, recovers, arms, and ticks over FakePty + a controllable scheduler', async () => {
    const { projectId } = makeProject();
    const clock = makeClock();
    const qw = makeQuietWindow();
    const pty = new FakePty();
    const scheduler = new FakeScheduler();
    const ticks: DaemonTickOutcome[] = [];
    const runner = await serveConductor({
      projectId,
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      scheduler,
      reconcileEvery: 1,
      onTick: (o) => ticks.push(o),
    });

    expect(runner.started).toBe(true); // autoStart defaults to true (an operator launch runs)
    scheduler.fire();
    await flush();
    expect(ticks).toHaveLength(1);
    expect(ticks[0]!.candidateCount).toBe(0); // empty project ⇒ nothing to drive
    expect(ticks[0]!.selected).toBeNull();
    runner.stop();
  });

  it('autoStart:false builds without arming the cadence', async () => {
    const { projectId } = makeProject();
    const clock = makeClock();
    const qw = makeQuietWindow();
    const scheduler = new FakeScheduler();
    const runner = await serveConductor({
      projectId,
      pty: new FakePty(),
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      scheduler,
      autoStart: false,
    });
    expect(runner.started).toBe(false);
    expect(scheduler.ms).toBeNull();
  });

  it('the default makeTransport is the [host-live] operator-handoff seam (fails loud)', () => {
    expect(() => hostLiveTransportRequired()).toThrow(/host-live/i);
  });

  it('runServeConductor fails loud on a missing project id', async () => {
    await expect(runServeConductor([])).rejects.toThrow(/project id is required/i);
  });
});
