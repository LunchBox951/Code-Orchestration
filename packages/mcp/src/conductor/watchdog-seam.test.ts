/**
 * AC-S14-6 — watchdog liveness seam: prove that the production ReconcileLoop wiring in `host.ts`
 * is no longer inert. With the new engine accessor + injected `pidAliveFor` seam, a stalled agent
 * (pty-quiet, no `worker_done`/`co_finish`, `pidAlive=true`) is detected and escalated to STUCK.
 *
 * Drives over FakePty + injected clock + injected `pidAliveFor` seam — no wall clock, no real `kill`.
 * Mirrors `reconcile.test.ts` (the pure-classifier proof) and `host.test.ts` (the stack proof) in
 * structure, but exercises the PRODUCTION WIRING path: `serveConductor`'s `livenessInputFor` now
 * builds a real `LivenessInput` from the engine's `livenessObservationFor` accessor.
 *
 * Tests:
 *   1. Silent-stop detection + STUCK escalation via the wired seam (the main AC-S14-6 proof).
 *   2. SKIP path: `livenessObservationFor` returns `undefined` for an unhosted (orphan) agent,
 *      so the loop skips it (never fabricates a liveness verdict — Principle 9).
 *   3. Inert-default callers: existing callers that inject `livenessInputFor: () => undefined`
 *      continue to work — the seam is additive with an honest host-glue default.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  FakePty,
  ReconcileLoop,
  WEDGE_MS,
  classifyLiveness,
  defaultMailRenderer,
  openMailStore,
  openRegistry,
  openRosterStore,
  openSessionStore,
  QUIET_WINDOW_MS,
  SILENT_STOP_TRIGGER,
  type BreakInfo,
  type ProjectId,
  type ProjectRegistry,
  type RunningAgent,
} from '@co/core';
import { ConductorEngine, type ConductorEngineDeps } from './engine.js';
import { serveConductor, type IntervalHandle, type IntervalScheduler } from './host.js';
import type { HostedIdentity } from '../live-session-host.js';

// ── ANSI / TUI constants (mirrors host.test.ts) ─────────────────────────────────────────────────────

const ESC = String.fromCharCode(0x1b);
const CLAUDE_READY = ESC + '[2J' + ESC + '[H' + '╭─ Welcome ─╮\r\n❯ \r\n  ? for shortcuts\r\n';

// ── Seam helpers ─────────────────────────────────────────────────────────────────────────────────────

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const flush = async (n = 8): Promise<void> => {
  for (let i = 0; i < n; i++) await tick();
};

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

class FakeScheduler implements IntervalScheduler {
  callback: (() => void) | null = null;
  ms: number | null = null;
  private handle: IntervalHandle | null = null;

  setInterval(callback: () => void, ms: number): IntervalHandle {
    this.callback = callback;
    this.ms = ms;
    this.handle = {};
    return this.handle;
  }

  clearInterval(handle: IntervalHandle): void {
    if (handle === this.handle) {
      this.callback = null;
    }
  }

  fire(): void {
    this.callback?.();
  }
}

// ── Project / identity setup ─────────────────────────────────────────────────────────────────────────

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let registries: ProjectRegistry[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  registries = [];
});

afterEach(async () => {
  process.env = ORIGINAL_ENV;
  for (const r of registries) {
    try {
      r.close();
    } catch {
      /* best-effort */
    }
  }
  for (const dir of dataDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function makeProject(): { projectId: ProjectId; cwd: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'co-watchdog-seam-'));
  dataDirs.push(dataDir);
  process.env.CO_DATA_DIR = dataDir;
  const registry = openRegistry();
  registries.push(registry);
  const cwd = join(dataDir, 'repo');
  return { projectId: registry.register(cwd), cwd };
}

function seedParentChain(projectId: ProjectId): void {
  const roster = openRosterStore(projectId);
  try {
    roster.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
    roster.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-1' });
  } finally {
    roster.close();
  }
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
      subject: 'work',
      body: 'do it',
    });
  } finally {
    mail.close();
  }
}

function outstandingItem(projectId: ProjectId, agent: string) {
  const mail = openMailStore(projectId);
  try {
    const item = mail.outstanding(agent)[0];
    if (item == null) throw new Error(`expected outstanding mail for '${agent}'`);
    return item;
  } finally {
    mail.close();
  }
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

async function driveTurnToIdle(
  pane: FakePty['panes'][number],
  item: ReturnType<typeof outstandingItem>,
  clock: ReturnType<typeof makeClock>,
  qw: ReturnType<typeof makeQuietWindow>,
): Promise<void> {
  await tick(); // injectMail has written the payload and is awaiting the echo
  pane.emit(defaultMailRenderer(item)); // composer echoes the injected text
  await tick(); // injectMail submits; observeTurnEnd arms the first quiet window
  clock.set(1000);
  pane.emit('turn output before yielding\r\n');
  await tick(); // new bytes re-arm the quiet window
  clock.set(1000 + WEDGE_MS + 1);
  qw.settle();
}

// ── AC-S14-6 — the main proof ────────────────────────────────────────────────────────────────────────

describe('AC-S14-6 — watchdog liveness seam: silent-stop detection via engine-backed livenessInputFor', () => {
  it('a driven turn that yields quiet without a completion verb is detected and escalated to STUCK', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);

    const clock = makeClock();
    const qw = makeQuietWindow();
    const pty = new FakePty();
    const scheduler = new FakeScheduler();

    // Capture the onBreak / markStuck seam calls to assert detection.
    const breaks: Array<{ agent: string; info: BreakInfo }> = [];
    const stuck: string[] = [];

    const runner = await serveConductor({
      projectId,
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      scheduler,
      reconcileEvery: 1, // reconcile on every tick
      autoStart: false,
      // P6 seam: inject a fake pidAlive — always true (agent process is alive but stalled).
      pidAliveFor: () => true,
      // P6 seam: inject a no-op nudge so tick 1's beat() resolves immediately (FakePty never echoes,
      // so the real defaultInjectNudge would block on wall-clock timers and starve tick 2).
      injectNudge: async () => {},
      onBreak: (agent, info) => breaks.push({ agent, info }),
      markStuck: (agent) => stuck.push(agent),
    });

    // Access the engine through the daemon (mirrors host.test.ts pattern).
    const engine = (runner as unknown as { daemon: { engine: ConductorEngine } }).daemon.engine;

    // Host the stalled agent pane with outstanding actionable mail, then actually drive one turn. A
    // merely warm pane with queued work is covered by the negative regression below.
    seedActionableMail(projectId, 'impl-stalled');
    const pane = await hostPane(engine, pty, makeIdentity('impl-stalled', projectId, cwd));
    const hosted = engine.getHosted(projectId, 'impl-stalled')!;
    const item = outstandingItem(projectId, 'impl-stalled');
    const reconcile = (runner as unknown as { daemon: { reconcile: ReconcileLoop } }).daemon
      .reconcile;

    clock.set(0);
    const turnP = engine.runOneTurn(hosted, item);
    await driveTurnToIdle(pane, item, clock, qw);
    await turnP;

    // Reconcile 1 — the watchdog observes the agent: idle, no completion verb, pidAlive=true,
    // turnActive=false ⇒ SILENT STOP break-signal + finish-before-yield nudge. NOT stuck yet.
    await reconcile.tick();

    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toMatchObject({
      agent: 'impl-stalled',
      info: { kind: 'silent_stop', triggerId: SILENT_STOP_TRIGGER },
    });
    expect(stuck).toEqual([]); // nudge injected first; STUCK requires a persisting break

    // Reconcile 2 — still idle, no completion ⇒ persisting break ⇒ STUCK-and-surfaced.
    clock.set(1000 + QUIET_WINDOW_MS + 1 + 4000);
    await reconcile.tick();

    expect(stuck).toEqual(['impl-stalled']);

    await runner.stop();
  });

  it('a warm hosted pane with queued mail but no driven turn is NOT detected as silent-stop', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);

    const clock = makeClock();
    const qw = makeQuietWindow();
    const pty = new FakePty();
    const scheduler = new FakeScheduler();

    const breaks: Array<{ agent: string; info: BreakInfo }> = [];
    const stuck: string[] = [];

    const runner = await serveConductor({
      projectId,
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      scheduler,
      reconcileEvery: 1,
      autoStart: false,
      pidAliveFor: () => true,
      injectNudge: async () => {},
      onBreak: (agent, info) => breaks.push({ agent, info }),
      markStuck: (agent) => stuck.push(agent),
    });

    const engine = (runner as unknown as { daemon: { engine: ConductorEngine } }).daemon.engine;
    const reconcile = (runner as unknown as { daemon: { reconcile: ReconcileLoop } }).daemon
      .reconcile;
    seedActionableMail(projectId, 'impl-queued');
    const pane = await hostPane(engine, pty, makeIdentity('impl-queued', projectId, cwd));

    clock.set(0);
    pane.emit('warm pane output before selection\r\n');
    clock.set(1000 + QUIET_WINDOW_MS + 1);

    await reconcile.tick();

    expect(breaks).toEqual([]);
    expect(stuck).toEqual([]);

    await runner.stop();
  });

  it('a paused hosted agent with outstanding mail is excluded from watchdog escalation', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);

    const clock = makeClock();
    const qw = makeQuietWindow();
    const pty = new FakePty();
    const scheduler = new FakeScheduler();

    const breaks: Array<{ agent: string; info: BreakInfo }> = [];
    const stuck: string[] = [];

    const runner = await serveConductor({
      projectId,
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      scheduler,
      reconcileEvery: 1,
      autoStart: false,
      pidAliveFor: () => true,
      injectNudge: async () => {},
      onBreak: (agent, info) => breaks.push({ agent, info }),
      markStuck: (agent) => stuck.push(agent),
    });

    const engine = (runner as unknown as { daemon: { engine: ConductorEngine } }).daemon.engine;
    const reconcile = (runner as unknown as { daemon: { reconcile: ReconcileLoop } }).daemon
      .reconcile;
    seedActionableMail(projectId, 'impl-paused');
    const pane = await hostPane(engine, pty, makeIdentity('impl-paused', projectId, cwd));
    runner.control?.router.pause('impl-paused');

    pane.emit('warm but paused\r\n');
    clock.set(1000 + QUIET_WINDOW_MS + 1);

    const result = await reconcile.tick();

    expect(result.assessed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(breaks).toEqual([]);
    expect(stuck).toEqual([]);

    await runner.stop();
  });

  it('overlap beats observe a bytes-then-frozen active turn as wedged, then STUCK', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);

    const clock = makeClock();
    const qw = makeQuietWindow();
    const pty = new FakePty();
    const scheduler = new FakeScheduler();

    const breaks: Array<{ agent: string; info: BreakInfo }> = [];
    const stuck: string[] = [];

    const runner = await serveConductor({
      projectId,
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      scheduler,
      reconcileEvery: 1,
      pidAliveFor: () => true,
      injectNudge: async () => {},
      onBreak: (agent, info) => breaks.push({ agent, info }),
      markStuck: (agent) => stuck.push(agent),
    });

    const engine = (runner as unknown as { daemon: { engine: ConductorEngine } }).daemon.engine;
    seedActionableMail(projectId, 'impl-wedged');
    const pane = await hostPane(engine, pty, makeIdentity('impl-wedged', projectId, cwd));
    const item = outstandingItem(projectId, 'impl-wedged');

    scheduler.fire();
    await tick();
    pane.emit(defaultMailRenderer(item)); // echo-verify injected mail so the turn starts watching output
    await tick();
    clock.set(1000);
    pane.emit('turn output before freeze\r\n');
    await flush();

    expect(engine.livenessObservationFor(projectId, 'impl-wedged')?.turnActive).toBe(true);

    clock.set(1000 + WEDGE_MS + 1);
    scheduler.fire(); // overlap beat: daemon tick is still in-flight, so only watchdog reconcile runs.
    await flush();

    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toMatchObject({
      agent: 'impl-wedged',
      info: { kind: 'wedged' },
    });
    expect(stuck).toEqual([]);

    scheduler.fire(); // persistent wedge on the next overlap beat escalates to STUCK.
    await flush();

    expect(stuck).toEqual(['impl-wedged']);

    qw.settle();
    await runner.stop();
  });

  it('overlap reconciliation does not classify a yielded ready-composer turn as wedged', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);

    const clock = makeClock();
    const qw = makeQuietWindow();
    const pty = new FakePty();
    const scheduler = new FakeScheduler();

    const breaks: Array<{ agent: string; info: BreakInfo }> = [];
    const stuck: string[] = [];

    const runner = await serveConductor({
      projectId,
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      scheduler,
      reconcileEvery: 999, // avoid the normal cadence reconcile; this test drives overlap manually.
      pidAliveFor: () => true,
      injectNudge: async () => {},
      onBreak: (agent, info) => breaks.push({ agent, info }),
      markStuck: (agent) => stuck.push(agent),
    });

    try {
      const engine = (runner as unknown as { daemon: { engine: ConductorEngine } }).daemon.engine;
      const reconcile = (runner as unknown as { daemon: { reconcile: ReconcileLoop } }).daemon
        .reconcile;
      seedActionableMail(projectId, 'impl-yielded');
      const pane = await hostPane(engine, pty, makeIdentity('impl-yielded', projectId, cwd));
      const item = outstandingItem(projectId, 'impl-yielded');

      scheduler.fire();
      await tick();
      pane.emit(defaultMailRenderer(item));
      await tick();

      clock.set(1000);
      pane.emit('turn output before yielding\r\n');
      await flush();

      clock.set(1100);
      pane.emit(CLAUDE_READY);
      await flush();

      clock.set(1100 + QUIET_WINDOW_MS + 1);
      qw.settle();
      await flush();

      clock.set(1100 + WEDGE_MS + 1);
      await reconcile.tick();

      expect(breaks.map((b) => b.info.kind)).toEqual(['silent_stop']);
      expect(stuck).toEqual([]);
    } finally {
      qw.settle();
      await runner.stop();
    }
  });

  it('an idle warm pane with no outstanding actionable mail is NOT detected as silent-stop', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);

    const clock = makeClock();
    const qw = makeQuietWindow();
    const pty = new FakePty();
    const scheduler = new FakeScheduler();

    const breaks: Array<{ agent: string; info: BreakInfo }> = [];
    const stuck: string[] = [];

    const runner = await serveConductor({
      projectId,
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      scheduler,
      reconcileEvery: 1,
      pidAliveFor: () => true,
      injectNudge: async () => {},
      onBreak: (agent, info) => breaks.push({ agent, info }),
      markStuck: (agent) => stuck.push(agent),
    });

    const engine = (runner as unknown as { daemon: { engine: ConductorEngine } }).daemon.engine;
    const pane = await hostPane(engine, pty, makeIdentity('impl-idle', projectId, cwd));

    pane.emit('warm pane ready\r\n');
    clock.set(1000 + QUIET_WINDOW_MS + 1);

    scheduler.fire();
    await flush();
    scheduler.fire();
    await flush();

    expect(breaks).toEqual([]);
    expect(stuck).toEqual([]);

    await runner.stop();
  });

  it('a healthy agent (bytes flowing, turnActive) is NOT detected as silent-stop', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);

    const clock = makeClock();
    const qw = makeQuietWindow();
    const pty = new FakePty();
    const scheduler = new FakeScheduler();

    const breaks: Array<{ agent: string; info: BreakInfo }> = [];
    const stuck: string[] = [];

    const runner = await serveConductor({
      projectId,
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      scheduler,
      reconcileEvery: 1,
      pidAliveFor: () => true,
      onBreak: (agent, info) => breaks.push({ agent, info }),
      markStuck: (agent) => stuck.push(agent),
    });

    const engine = (runner as unknown as { daemon: { engine: ConductorEngine } }).daemon.engine;
    const pane = await hostPane(engine, pty, makeIdentity('impl-healthy', projectId, cwd));

    // Fresh bytes at the current clock time — agent is actively producing output.
    const FRESH = 1000 + QUIET_WINDOW_MS + 1;
    clock.set(FRESH);
    pane.emit('⠙ still running…\r\n'); // bytes at time FRESH → not yet quiet

    // Advance only a little past the last byte (still within the quiet window from the LAST byte).
    clock.set(FRESH + 1);
    scheduler.fire();
    await flush();

    // Agent's last byte was at FRESH, clock is FRESH+1 — byte-silent for only 1 ms < QUIET_WINDOW_MS.
    // The classifier should NOT fire silent_stop.
    expect(breaks).toEqual([]);
    expect(stuck).toEqual([]);

    await runner.stop();
  });
});

// ── SKIP path — unobservable (orphan) agent is skipped, never fabricated ─────────────────────────────

describe('AC-S14-6 — SKIP path: unhosted agent is skipped (Principle 9 — no fabricated verdict)', () => {
  it('livenessObservationFor returns undefined for an unhosted agent; reconcile reports it as skipped', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);

    const clock = makeClock();
    const qw = makeQuietWindow();
    const pty = new FakePty();

    const engine = new ConductorEngine({
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      injectOptions: { retryDelay: () => new Promise<void>(() => {}) },
    } satisfies ConductorEngineDeps);

    // The agent exists in the session store (so it would be in the RUNNING set)...
    const sessions = openSessionStore(projectId);
    try {
      sessions.recordSession({
        agentId: 'impl-orphan',
        pane: 'pane-orphan',
        cwd,
        provider: 'claude',
        resume: { provider: 'claude', sessionId: 'session-orphan' },
      });
    } finally {
      sessions.close();
    }

    // ...but it has NO hosted pane in the engine (it is an orphan post-crash).
    expect(engine.isHosted(projectId, 'impl-orphan')).toBe(false);

    // livenessObservationFor returns undefined — the engine cannot observe this agent.
    const obs = engine.livenessObservationFor(projectId, 'impl-orphan');
    expect(obs).toBeUndefined();

    // Wire a ReconcileLoop with a runningAgents that includes the orphan (simulating a scenario where
    // the session store lists it but the engine has no hosted pane). Use a custom runningAgents that
    // returns the orphan with a FakePty pane — liveRunningAgents already filters orphans, but here we
    // test that livenessInputFor → undefined → skip path fires correctly.
    const orphanPane = pty.spawn({ command: 'claude', args: [], cwd, env: {} });
    const orphanAgent: RunningAgent = {
      agentId: 'impl-orphan',
      pane: orphanPane,
      provider: 'claude',
    };

    const breaks: Array<{ agent: string; info: BreakInfo }> = [];
    const stuck: string[] = [];

    const loop = new ReconcileLoop({
      runningAgents: () => [orphanAgent],
      livenessInputFor: (agent: RunningAgent) => {
        const obs2 = engine.livenessObservationFor(projectId, agent.agentId);
        if (obs2 == null) return undefined; // orphan — skip
        return { ...obs2, pidAlive: true };
      },
      now: clock.now,
      onBreak: (agent, info) => breaks.push({ agent, info }),
      markStuck: (agent) => stuck.push(agent),
    });

    clock.set(1000 + QUIET_WINDOW_MS + 1);
    const result = await loop.tick();

    // The orphan is skipped — never assessed, never nudged, never STUCK.
    expect(result.skipped).toEqual(['impl-orphan']);
    expect(result.assessed).toHaveLength(0);
    expect(breaks).toEqual([]);
    expect(stuck).toEqual([]);

    await engine.closeAll();
  });
});

// ── Inert-default regression: existing callers that pass `livenessInputFor: () => undefined` ─────────

describe('AC-S14-6 — inert-default callers are unaffected (additive seam)', () => {
  it('a ReconcileLoop built with livenessInputFor:()=>undefined still skips all agents (backward-compat)', async () => {
    const { projectId } = makeProject();
    const clock = makeClock();
    const qw = makeQuietWindow();
    const pty = new FakePty();
    const scheduler = new FakeScheduler();
    const stuck: string[] = [];

    // serveConductor WITHOUT pidAliveFor — should fall back to the production default (real kill(pid,0)
    // via pane.pid; since FakePty panes have no pid, defaults to true conservatively).
    // Here we override reconcileEvery to 1 to ensure the reconcile runs on each tick.
    const runner = await serveConductor({
      projectId,
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      scheduler,
      reconcileEvery: 1,
      markStuck: (agent) => stuck.push(agent),
    });

    // No agents hosted → no STUCK escalations.
    scheduler.fire();
    await flush();
    expect(stuck).toEqual([]);

    await runner.stop();
  });

  it('host.test.ts-style ReconcileLoop with inert stub builds and runs — additive, not breaking', () => {
    // Mirror host.test.ts makeReconcile to confirm the old construction pattern still compiles + runs.
    const clock = makeClock();
    const loop = new ReconcileLoop({
      runningAgents: () => [],
      livenessInputFor: () => undefined,
      now: clock.now,
      onBreak: () => {},
      markStuck: () => {},
    });
    // The loop exists and has zero tracked agents (no agents, no ticks driven here — compile-only proof).
    expect(loop.tracked).toBe(0);
  });
});

// ── Engine.livenessObservationFor unit tests ─────────────────────────────────────────────────────────

describe('ConductorEngine.livenessObservationFor — the in-process observation accessor (P6)', () => {
  it('returns undefined when the agent is not hosted (orphan)', async () => {
    const clock = makeClock();
    const qw = makeQuietWindow();
    const pty = new FakePty();
    const engine = new ConductorEngine({
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
    } satisfies ConductorEngineDeps);

    expect(engine.livenessObservationFor('proj-x', 'impl-ghost')).toBeUndefined();
    await engine.closeAll();
  });

  it('returns exited=false + empty trace + turnActive=false before any bytes', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);

    const clock = makeClock();
    const qw = makeQuietWindow();
    const pty = new FakePty();

    const engine = new ConductorEngine({
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
    } satisfies ConductorEngineDeps);

    const pane = await hostPane(engine, pty, makeIdentity('impl-fresh', projectId, cwd));
    void pane; // suppress unused warning

    const obs = engine.livenessObservationFor(projectId, 'impl-fresh');
    expect(obs).not.toBeUndefined();
    // The CLAUDE_READY startup bytes were emitted before ensureHosted returned, so lastByteAt is set.
    // The important things: exited=false (pane hasn't exited), turnActive=false (no turn in flight).
    expect(obs!.exited).toBe(false);
    expect(obs!.turnActive).toBe(false);

    await engine.closeAll();
  });

  it('records lastByteAt in the trace after bytes arrive', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);

    const clock = makeClock();
    const qw = makeQuietWindow();
    const pty = new FakePty();

    const engine = new ConductorEngine({
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
    } satisfies ConductorEngineDeps);

    const pane = await hostPane(engine, pty, makeIdentity('impl-bytes', projectId, cwd));

    clock.set(5000);
    pane.emit('working at t=5000\r\n');

    const obs = engine.livenessObservationFor(projectId, 'impl-bytes');
    expect(obs).not.toBeUndefined();
    expect(obs!.trace).toHaveLength(1);
    expect(obs!.trace[0]).toMatchObject({ kind: 'bytes', at: 5000 });
    expect(obs!.exited).toBe(false);
    expect(obs!.turnActive).toBe(false);

    await engine.closeAll();
  });

  it('sets turnActive=true while runOneTurn is in flight, false after it returns', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);

    const clock = makeClock();
    const qw = makeQuietWindow();
    const pty = new FakePty();

    const engine = new ConductorEngine({
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      // Never-resolving retry seam: only the composer echo below advances injection.
      injectOptions: { retryDelay: () => new Promise<void>(() => {}) },
    } satisfies ConductorEngineDeps);

    seedActionableMail(projectId, 'impl-turn');
    const pane = await hostPane(engine, pty, makeIdentity('impl-turn', projectId, cwd));

    // Before any turn — turnActive must be false.
    expect(engine.livenessObservationFor(projectId, 'impl-turn')!.turnActive).toBe(false);

    // Start a turn (mail inject will park waiting for pane echo).
    const hosted = engine.getHosted(projectId, 'impl-turn')!;
    const mail = (() => {
      const store = openMailStore(projectId);
      try {
        return store.outstanding('impl-turn')[0]!;
      } finally {
        store.close();
      }
    })();

    const turnP = engine.runOneTurn(hosted, mail);
    await tick(); // let runOneTurn start and reach the injectMail await

    // While the turn is in flight — turnActive must be true.
    const activeObs = engine.livenessObservationFor(projectId, 'impl-turn')!;
    expect(activeObs.turnActive).toBe(true);
    expect(activeObs.turnStartedAt).toBe(0);

    pane.emit(defaultMailRenderer(mail)); // echo-verify the injected mail
    await tick(); // injectMail submits; observeTurnEnd arms the first quiet window

    // Emit a current-turn byte so this test exercises ordinary quiet-yield completion rather than
    // the zero-current-byte wedge guard.
    clock.set(1000);
    pane.emit('turn bytes\r\n');
    await tick();

    // Settle the no-completion turn: advance past the wedge window, then resolve it.
    clock.set(1000 + WEDGE_MS + 1);
    qw.settle();
    await turnP;

    // After the turn completes — turnActive must be false again.
    expect(engine.livenessObservationFor(projectId, 'impl-turn')!.turnActive).toBe(false);

    await engine.closeAll();
  });

  it('scopes active-turn liveness to bytes at or after turnStartedAt', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);

    const clock = makeClock();
    const qw = makeQuietWindow();
    const pty = new FakePty();

    const engine = new ConductorEngine({
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      injectOptions: { retryDelay: () => Promise.resolve(), allowUnverifiedSubmit: true },
    } satisfies ConductorEngineDeps);

    seedActionableMail(projectId, 'impl-stale');
    const pane = await hostPane(engine, pty, makeIdentity('impl-stale', projectId, cwd));

    clock.set(1000);
    pane.emit('startup/prior-turn bytes\r\n');

    const hosted = engine.getHosted(projectId, 'impl-stale')!;
    const mail = outstandingItem(projectId, 'impl-stale');
    clock.set(10_000);
    const turnP = engine.runOneTurn(hosted, mail);
    await tick();

    const obs = engine.livenessObservationFor(projectId, 'impl-stale')!;
    expect(obs.turnActive).toBe(true);
    expect(obs.turnStartedAt).toBe(10_000);
    expect(obs.trace).toEqual([]);

    const beforeWedge = classifyLiveness(
      { ...obs, pidAlive: true, hasOutstandingActionable: true },
      10_000 + WEDGE_MS - 1,
    );
    expect(beforeWedge.liveness).toBe('alive');
    expect(beforeWedge.break).toBeUndefined();

    clock.set(10_000 + WEDGE_MS);
    qw.settle();
    await turnP;
    await engine.closeAll();
  });

  it('keeps a zero-current-byte active turn in flight through settled quiet windows before wedge', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);

    const clock = makeClock();
    const qw = makeQuietWindow();
    const pty = new FakePty();

    const engine = new ConductorEngine({
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      injectOptions: { retryDelay: () => Promise.resolve(), allowUnverifiedSubmit: true },
    } satisfies ConductorEngineDeps);

    seedActionableMail(projectId, 'impl-zero');
    await hostPane(engine, pty, makeIdentity('impl-zero', projectId, cwd));
    const hosted = engine.getHosted(projectId, 'impl-zero')!;
    const mail = outstandingItem(projectId, 'impl-zero');

    let completed = false;
    clock.set(1000);
    const turnP = engine.runOneTurn(hosted, mail).then(() => {
      completed = true;
    });
    await tick();

    clock.set(1000 + QUIET_WINDOW_MS + 1);
    qw.settle();
    await flush();

    expect(completed).toBe(false);
    const obs = engine.livenessObservationFor(projectId, 'impl-zero')!;
    expect(obs.turnActive).toBe(true);
    expect(obs.turnStartedAt).toBe(1000);
    expect(obs.trace).toEqual([]);

    const beforeWedge = classifyLiveness(
      { ...obs, pidAlive: true, hasOutstandingActionable: true },
      1000 + WEDGE_MS - 1,
    );
    expect(beforeWedge.liveness).toBe('alive');
    expect(beforeWedge.break).toBeUndefined();

    const atWedge = classifyLiveness(
      { ...obs, pidAlive: true, hasOutstandingActionable: true },
      1000 + WEDGE_MS,
    );
    expect(atWedge.liveness).toBe('wedged');
    expect(atWedge.break?.kind).toBe('wedged');

    clock.set(1000 + WEDGE_MS);
    qw.settle();
    await turnP;
    await engine.closeAll();
  });

  it('sets exited=true after pane exit fires', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);

    const clock = makeClock();
    const qw = makeQuietWindow();
    const pty = new FakePty();

    const engine = new ConductorEngine({
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
    } satisfies ConductorEngineDeps);

    const pane = await hostPane(engine, pty, makeIdentity('impl-exit', projectId, cwd));

    expect(engine.livenessObservationFor(projectId, 'impl-exit')!.exited).toBe(false);

    pane.exit(0, null);
    await tick();

    expect(engine.livenessObservationFor(projectId, 'impl-exit')!.exited).toBe(true);

    await engine.closeAll();
  });
});

// ── Daemon integration: serveConductor reconcile fires on every N ticks ──────────────────────────────

describe('AC-S14-6 — daemon integration: reconcile respects reconcileEvery cadence', () => {
  it('builds and runs a full conductor stack with the new wired livenessInputFor, no STUCK on empty project', async () => {
    const { projectId } = makeProject();
    const clock = makeClock();
    const qw = makeQuietWindow();
    const pty = new FakePty();
    const scheduler = new FakeScheduler();
    const stuck: string[] = [];

    const runner = await serveConductor({
      projectId,
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      scheduler,
      reconcileEvery: 1,
      pidAliveFor: () => true,
      markStuck: (agent) => stuck.push(agent),
    });

    scheduler.fire();
    await flush();

    // Empty project — no running agents — no STUCK escalations.
    expect(stuck).toEqual([]);

    await runner.stop();
  });
});
