/**
 * AC-S10-3 [sandbox] acceptance for the Conductor CONTROL + OBSERVE surface (Stage 10 P3 · CTL-OBS).
 * Over an in-process {@link ConductorEngine} + `FakePty` + injected time + in-memory transports, this
 * proves the DAEMON-BACKED router acts on LIVE agents — replacing the CLI's `[host-live]` throws — and
 * the live-observe query returns the engine overlay. The six proofs (spec §4):
 *   1. stop        — a hosted agent's pane is killed + released (`isHosted` flips false; no further turns).
 *   2. pause       — a paused agent with outstanding mail is SKIPPED by candidate selection; resume re-drives.
 *   3. revertStuck + rewake (MNR #4) — an agent flipped STUCK via the WIRED markStuck is reverted and
 *      ACTUALLY re-woken (the daemon drives it next tick) — never a silent multi-hour-reap no-op.
 *   4. steer       — operator steer reaches `engine.steer` and injects into the warm pane, no teardown.
 *   5. live-observe — the combined query returns the live snapshot (hosted/paused/stuck/outstanding +
 *      roster/cost), distinguishable from the pure-static `queryObservability`.
 *   6. zero agent MCP tools — the control/observe surface registers NO agent MCP tool (Principle 4 + D4).
 *
 * Determinism (AC-S10-1 discipline): NO wall clock — `now` reads a mutable counter; `quietWindow` is a
 * controllable settle seam. The harness mirrors `engine.test.ts`/`daemon.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  FakePty,
  ReconcileLoop,
  buildCoreRegistry,
  checkToolCompleteness,
  defaultMailRenderer,
  openMailStore,
  openRegistry,
  openRosterStore,
  openSessionStore,
  queryObservability,
  queryLiveObservability,
  WEDGE_MS,
  type DeliveredMail,
  type DetectorEvent,
  type LivenessInput,
  type MailStore,
  type ProjectId,
  type ProjectRegistry,
  type ReconcileSeams,
  type RosterStore,
  type RunningAgent,
  type SessionStore,
} from '@co/core';
import { ConductorEngine, type ConductorEngineDeps, type HostedPane } from './engine.js';
import { ConductorDaemon } from './daemon.js';
import { DaemonBackedAgentRouter } from './agent-router.js';
import { EngineLiveStateProvider } from './live-observe.js';
import type { HostedIdentity } from '../live-session-host.js';

// ── Scripted startup fixture. ESC authored via fromCharCode so the SOURCE holds no raw control byte. ──
const ESC = String.fromCharCode(0x1b);
const CR = String.fromCharCode(0x0d);
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

// ── Helpers (mirroring engine.test.ts / daemon.test.ts) ─────────────────────────
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function makeProject(): { projectId: ProjectId; cwd: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'co-ctlobs-'));
  dataDirs.push(dataDir);
  process.env.CO_DATA_DIR = dataDir;
  const registry = openRegistry();
  registries.push(registry);
  const cwd = join(dataDir, 'repo');
  return { projectId: registry.register(cwd), cwd };
}

/** Seed the parent chain a real Conductor spawn would have recorded (mirrors engine.test.ts). */
function seedParentChain(projectId: ProjectId): void {
  const roster = openRosterStore(projectId);
  rosterStores.push(roster);
  roster.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
  roster.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-1' });
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

function runningAgentIds(projectId: ProjectId): readonly string[] {
  const store = openSessionStore(projectId);
  sessionStores.push(store);
  return store.listSessions().map((s) => s.agentId);
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

/** Spawn + drive a pane to ready (a P2 spawn stand-in: writes the session + roster records). */
async function hostPane(
  engine: ConductorEngine,
  pty: FakePty,
  identity: HostedIdentity,
): Promise<{ hosted: HostedPane; pane: FakePty['panes'][number] }> {
  const ensureP = engine.ensureHosted(identity);
  const pane = pty.panes[pty.panes.length - 1]!;
  pane.emit(CLAUDE_READY);
  const hosted = await ensureP;
  return { hosted, pane };
}

// ── AC-S10-3.1 — stop: kill + release a live agent (no further turns) ────────────────────────────
describe('AC-S10-3.1 — stop kills + releases the warm pane (isHosted false; no further turns)', () => {
  it('kills the pane, releases it (isHosted flips false), and drops it from the running set', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const { pane } = await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));
    let exited = false;
    pane.onExit(() => void (exited = true));

    const router = new DaemonBackedAgentRouter({ engine, projectId });
    router.stop('impl-x');

    // The pane was killed and the warm-pane ledger dropped SYNCHRONOUSLY (release deletes before its await).
    expect(exited).toBe(true);
    expect(engine.isHosted(projectId, 'impl-x')).toBe(false);
    expect(router.isStopped('impl-x')).toBe(true);

    // Drain the async release tail (the MCP session close ends the session record).
    await router.drain();
    // No further turns: the agent has left the RUNNING set (session ended) — the daemon won't re-drive it.
    expect(runningAgentIds(projectId)).not.toContain('impl-x');
  });

  it('still releases the session when pane.kill and the stop-error reporter throw', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const { pane } = await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));
    (pane as unknown as { kill: () => void }).kill = () => {
      throw new Error('kill failed in test');
    };
    const errors: Array<{ agent: string; error: unknown }> = [];
    const router = new DaemonBackedAgentRouter({
      engine,
      projectId,
      onStopError: (agent, error) => {
        errors.push({ agent, error });
        throw new Error('reporter failed in test');
      },
    });

    expect(() => router.stop('impl-x')).not.toThrow();
    await expect(router.drain()).resolves.toBeUndefined();

    expect(engine.isHosted(projectId, 'impl-x')).toBe(false);
    expect(runningAgentIds(projectId)).not.toContain('impl-x');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.agent).toBe('impl-x');
  });

  it('a stop on a not-hosted agent is RECORDED (never a silent no-op), not a throw', () => {
    const { projectId } = makeProject();
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const unhosted: string[] = [];
    const router = new DaemonBackedAgentRouter({
      engine,
      projectId,
      onStopUnhosted: (a) => unhosted.push(a),
    });

    expect(() => router.stop('ghost')).not.toThrow();
    expect(unhosted).toEqual(['ghost']);
    expect(router.isStopped('ghost')).toBe(true);
    expect(router.shouldSkip(projectId, 'ghost')).toBe(true);
  });

  it('a throwing unhosted-stop diagnostic callback does not make stop throw', () => {
    const { projectId } = makeProject();
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const router = new DaemonBackedAgentRouter({
      engine,
      projectId,
      onStopUnhosted: () => {
        throw new Error('diagnostic failed in test');
      },
    });

    expect(() => router.stop('ghost')).not.toThrow();
    expect(router.isStopped('ghost')).toBe(true);
    expect(router.shouldSkip(projectId, 'ghost')).toBe(true);
  });
});

// ── AC-S10-3.2 — pause: the daemon SKIPS a paused agent; resume re-drives ─────────────────────────
describe('AC-S10-3.2 — a paused agent with outstanding mail is SKIPPED by candidate selection', () => {
  it('pause suppresses the agent (NOT driven), and resume drives it again', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const { pane } = await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));
    seedActionableMail(projectId, 'impl-x');

    const router = new DaemonBackedAgentRouter({ engine, projectId });
    const daemon = new ConductorDaemon({
      engine,
      reconcile: makeReconcile(clock),
      projectId,
      now: clock.now,
      reconcileEvery: 1,
      recover: () => {},
      isSkipped: (pid, agent) => router.shouldSkip(pid, agent),
    });

    // Paused: the agent has outstanding actionable mail BUT is filtered out of candidates.
    router.pause('impl-x');
    const out1 = await daemon.tick();
    expect(out1.selected).toBeNull();
    expect(out1.candidateCount).toBe(0);
    expect(engine.isHosted(projectId, 'impl-x')).toBe(true); // pausing never tears down
    expect(outstandingCount(projectId, 'impl-x')).toBe(1); // its mail was never consumed

    // Resume: the next tick re-selects + drives the still-outstanding item.
    router.resume('impl-x');
    const tickP = daemon.tick();
    await driveTurnToIdle(pane, outstandingItem(projectId, 'impl-x'), clock, qw);
    const out2 = await tickP;
    expect(out2.selected).toBe('impl-x');
    expect(out2.cycle?.turn.turnEnd?.idle).toBe(true);
  });
});

// ── AC-S10-3.3 — revertStuck + rewake genuinely re-wakes a STUCK agent (MNR #4) ───────────────────
describe('AC-S10-3.3 — MNR #4: an agent STUCK via the wired markStuck is reverted + ACTUALLY re-woken', () => {
  it('STUCK (via the reconcile-wired markStuck) skips the agent; revertStuck+rewake re-drives it', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const { pane } = await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));

    const router = new DaemonBackedAgentRouter({ engine, projectId });

    // The watchdog's running set + a MUTABLE liveness input: the canonical silent-stop (idle, no verb,
    // quiet) that escalates to STUCK, flippable to healthy once the operator unsticks.
    const wpty = new FakePty();
    const stuckPane = wpty.spawn({ command: 'claude', args: [], cwd, env: {} });
    const silentStop: LivenessInput = {
      trace: [{ kind: 'bytes', at: 0, bytes: 100 } satisfies DetectorEvent],
      exited: false,
      pidAlive: true,
      turnActive: false,
    };
    const healthy: LivenessInput = {
      trace: [{ kind: 'bytes', at: 10_000, bytes: 100 } satisfies DetectorEvent],
      exited: false,
      pidAlive: true,
      turnActive: false,
    };
    let live: LivenessInput = silentStop;
    clock.set(10_000); // > QUIET_WINDOW_MS so detectTurnEnd reads idle on the silentStop trace

    // The reconcile loop's markStuck seam is WIRED to the router (the §3a/§3d host wiring).
    const reconcile = makeReconcile(clock, {
      runningAgents: (): readonly RunningAgent[] => [
        { agentId: 'impl-x', pane: stuckPane, provider: 'claude' },
      ],
      livenessInputFor: () => live,
      markStuck: (agent) => router.markStuck(agent),
    });
    const daemon = new ConductorDaemon({
      engine,
      reconcile,
      projectId,
      now: clock.now,
      reconcileEvery: 1,
      recover: () => {},
      isSkipped: (pid, agent) => router.shouldSkip(pid, agent),
    });

    // Two cadence ticks escalate detect → nudge → STUCK (no mail yet ⇒ runCycle drives nothing).
    await daemon.tick();
    await daemon.tick();
    expect(router.isStuck('impl-x')).toBe(true); // the WIRED markStuck landed in the router's STUCK set

    // Now the agent has work — but while STUCK it is SKIPPED (the stalled-unstick no-op the bug caused).
    seedActionableMail(projectId, 'impl-x');
    const stuckTick = await daemon.tick();
    expect(stuckTick.selected).toBeNull();
    expect(outstandingCount(projectId, 'impl-x')).toBe(1); // never driven while STUCK

    // `co unstick`'s composition: revertStuck + rewake. After it, the agent is eligible again.
    router.revertStuck('impl-x');
    router.rewake('impl-x');
    expect(router.isStuck('impl-x')).toBe(false);
    live = healthy; // the operator unstuck it ⇒ the watchdog no longer re-escalates

    // The cure: the daemon ACTUALLY re-drives it next tick (NOT a silent no-op).
    const tickP = daemon.tick();
    await driveTurnToIdle(pane, outstandingItem(projectId, 'impl-x'), clock, qw);
    const rewoken = await tickP;
    expect(rewoken.selected).toBe('impl-x');
    expect(rewoken.cycle?.turn.turnEnd?.idle).toBe(true);
  });
});

// ── AC-S10-3.4 — steer: operator steer reaches engine.steer (warm pane, no teardown) ─────────────
describe('AC-S10-3.4 — operator steer injects into the warm pane mid-turn without teardown', () => {
  it('answer routes the operator text + exactly one submit into the warm pane (echo-verified)', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const { pane } = await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));
    const router = new DaemonBackedAgentRouter({ engine, projectId });

    const steerP = router.steer('impl-x', { kind: 'answer', text: 'use claude' });
    await tick(); // injectMail wrote the text and awaits the composer echo
    pane.emit('use claude'); // the composer echoes the operator's answer → exactly one submit
    await steerP;

    expect(pane.written.join('')).toContain('use claude');
    expect(pane.written.filter((w) => w === CR)).toHaveLength(1);
    expect(engine.isHosted(projectId, 'impl-x')).toBe(true); // still warm — steering never releases
  });

  it('interrupt routes exactly the provider key (claude ⇒ ESC) and keeps the pane warm', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const { pane } = await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));
    const router = new DaemonBackedAgentRouter({ engine, projectId });
    const before = pane.written.length;

    await router.steer('impl-x', { kind: 'interrupt' });

    expect(pane.written.slice(before)).toEqual([ESC]);
    expect(pane.stopped).toBe(false);
    expect(engine.isHosted(projectId, 'impl-x')).toBe(true);
  });

  it('throws fail-loud when the agent is not hosted (steering never relaunches)', async () => {
    const { projectId } = makeProject();
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const router = new DaemonBackedAgentRouter({ engine, projectId });
    await expect(router.steer('nope', { kind: 'interrupt' })).rejects.toThrow(/not hosted/i);
  });
});

// ── AC-S10-3.5 — live-observe: the combined query carries the engine overlay ──────────────────────
describe('AC-S10-3.5 — queryLiveObservability returns the live overlay (distinguishable from static)', () => {
  it('merges hosted/paused/outstanding onto the roster + cost, beyond the pure-static snapshot', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId); // roster: coord-1, lead-1 (both COLD — never hosted)
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd })); // WARM
    seedActionableMail(projectId, 'impl-x'); // 1 outstanding actionable item

    const router = new DaemonBackedAgentRouter({ engine, projectId });
    router.pause('impl-x'); // also exercise the paused overlay
    const provider = new EngineLiveStateProvider({ engine, projectId, router });

    const live = queryLiveObservability(projectId, provider);
    const byId = new Map(live.agents.map((a) => [a.agentId, a]));

    // The WARM agent: hosted + paused + its outstanding-mail count (the engine-only overlay).
    const x = byId.get('impl-x')!;
    expect(x.hosted).toBe(true);
    expect(x.paused).toBe(true);
    expect(x.stuck).toBe(false);
    expect(x.outstandingMail).toBe(1);
    expect(x.role).toBe('implementer');
    expect(x.parent).toBe('lead-1');
    expect(typeof x.costUsd).toBe('number'); // cost rollup joined (0 when none recorded)

    // A COLD roster agent: not hosted, nothing outstanding.
    const lead = byId.get('lead-1')!;
    expect(lead.hosted).toBe(false);
    expect(lead.outstandingMail).toBe(0);

    // The full static rollup rides along, and the LIVE snapshot is DISTINGUISHABLE from the static one:
    // the static ObservabilitySnapshot has no per-agent hosted/paused/outstanding overlay.
    const stat = queryObservability(projectId);
    expect(live.snapshot.agents.map((a) => a.agentId).sort()).toEqual(
      stat.agents.map((a) => a.agentId).sort(),
    );
    expect(stat.agents.every((a) => !('hosted' in a) && !('outstandingMail' in a))).toBe(true);
    expect(live.agents.every((a) => 'hosted' in a && 'outstandingMail' in a)).toBe(true);
  });

  it('with no control router wired, paused/stuck default false (pure engine-observe)', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));
    const provider = new EngineLiveStateProvider({ engine, projectId }); // no router

    const live = queryLiveObservability(projectId, provider);
    const x = live.agents.find((a) => a.agentId === 'impl-x')!;
    expect(x.hosted).toBe(true);
    expect(x.paused).toBe(false);
    expect(x.stuck).toBe(false);
  });
});

// ── AC-S10-3.6 — the control/observe surface registers ZERO agent MCP tools ───────────────────────
describe('AC-S10-3.6 — control/observe is operator-only (registers ZERO agent MCP tools; Principle 4 + D4)', () => {
  it('no control/observe verb appears in the canonical agent tool registry; completeness stays green', () => {
    const names = buildCoreRegistry()
      .list()
      .map((t) => t.name);

    // None of the CONTROL verbs nor the OBSERVE surface may be an agent-callable MCP tool.
    const forbidden = [
      'revertstuck',
      'rewake',
      'pause',
      'resume',
      'stop',
      'unstick',
      'steer',
      'router',
      'observe',
      'livestate',
      'liveobservability',
    ];
    for (const verb of forbidden) {
      expect(names.some((n) => n.toLowerCase().includes(verb))).toBe(false);
    }
    // The surface is plain classes/functions, not ToolSpecs — the completeness gate is green by construction.
    expect(checkToolCompleteness(buildCoreRegistry())).toEqual([]);
  });
});
