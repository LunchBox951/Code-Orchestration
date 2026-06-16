/**
 * Stage 9 P4 (L8-WDOG) — the silent-stop watchdog-reconcile loop.
 *
 * AC-S9-4: a synthesized "idle, no `worker_done`, pty-quiet" trace OVER THE RECORDED RUNNING-STATE
 * (P3's `selectAllSessions` after `recoverProjectStore`) fires the watchdog → nudge → (still broken)
 * STUCK-and-surfaced. MNR-1 (the canonical bug) is proven explicitly, with its INVERSE: an idle turn
 * that DID emit `co_finish`/`worker_done` is NEVER flagged. Completion keys on the MCP verbs, NEVER
 * turn-end. Plus the loop mechanics: wedged ⇒ STUCK, dead ⇒ reap, watchdog persistence/pruning across
 * ticks, unobservable-agent skip, and per-agent failure isolation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openProjectStore } from '../store/sqlite-store.js';
import { openSessionStore } from '../session/session-store.js';
import { recoverProjectStore, selectAllSessions } from '../replay/recovery.js';
import { FakePty } from './fake-pty.js';
import type { Pane, SpawnSpec } from './pty-host.js';
import type { DetectorEvent } from './turn-end-detector.js';
import { QUIET_WINDOW_MS } from './turn-end-detector.js';
import {
  WEDGE_MS,
  SILENT_STOP_TRIGGER,
  type BreakInfo,
  type LivenessConfig,
  type LivenessInput,
} from './liveness-watchdog.js';
import { ReconcileLoop, type RunningAgent, type ReconcileSeams } from './reconcile.js';

const SPEC: SpawnSpec = { command: 'claude', args: [], cwd: '/work/agent', env: {} };

// ── Fake router + synthesized inputs (mirroring liveness-watchdog.test.ts) ──────────────────────────

/** A fake router + nudge-spy capturing the reconcile seams (break-signal, STUCK, injected nudges). */
function fakeRouter() {
  const breaks: Array<{ agent: string; info: BreakInfo }> = [];
  const stuck: string[] = [];
  const nudges: Array<{ triggerId: string }> = [];
  return {
    breaks,
    stuck,
    nudges,
    onBreak: (agent: string, info: BreakInfo) => breaks.push({ agent, info }),
    markStuck: (agent: string) => stuck.push(agent),
    injectNudge: async (_pane: Pane, triggerId: string) => {
      nudges.push({ triggerId });
    },
  };
}

/** One running agent over a fresh FakePty pane (the realistic path: provider carried from the session). */
function runningAgent(agentId: string, host: FakePty): RunningAgent {
  return { agentId, pane: host.spawn(SPEC), provider: 'claude' };
}

/** The canonical bytes-then-quiet trace: bytes through 1000 ms, then silence. */
function idleNoCompletionTrace(): DetectorEvent[] {
  const trace: DetectorEvent[] = [];
  for (let t = 0; t <= 1000; t += 250) trace.push({ kind: 'bytes', at: t, bytes: 12 });
  return trace;
}

/** The canonical silent-stop input: idle, NO completion verb, pty-quiet, turn yielded. */
function silentStopInput(): LivenessInput {
  return { trace: idleNoCompletionTrace(), exited: false, pidAlive: true, turnActive: false };
}

/** An idle turn that DID finish: the same idle/quiet trace, but with a completion verb in the call-log. */
function completedTurnInput(verb: 'co_finish' | 'worker_done'): LivenessInput {
  const trace = idleNoCompletionTrace();
  trace.push({ kind: 'mcp', at: 900, verb });
  return { trace, exited: false, pidAlive: true, turnActive: false };
}

/** A frozen (SIGSTOP) turn: bytes through 5000 ms, then byte-silent while the turn is still ACTIVE. */
function wedgedInput(): LivenessInput {
  const trace: DetectorEvent[] = [];
  for (let t = 0; t <= 5000; t += 250) trace.push({ kind: 'bytes', at: t, bytes: 12 });
  return { trace, exited: false, pidAlive: true, turnActive: true };
}

/** An exited pane ⇒ dead (highest precedence). */
function deadInput(): LivenessInput {
  return {
    trace: [{ kind: 'bytes', at: 0, bytes: 12 }],
    exited: true,
    pidAlive: false,
    turnActive: true,
  };
}

/** The observed-at at which the canonical idle trace has been quiet just past the idle window. */
const IDLE_OBSERVED_AT = 1000 + QUIET_WINDOW_MS + 1;

/** Wire a {@link ReconcileLoop} from partial seams + a {@link fakeRouter}, reducing boilerplate. */
function buildLoop(
  opts: {
    runningAgents: () => readonly RunningAgent[];
    livenessInputFor: ReconcileSeams['livenessInputFor'];
    now: () => number;
    injectNudge?: ReconcileSeams['injectNudge'];
    config?: LivenessConfig;
  },
  router: ReturnType<typeof fakeRouter>,
): ReconcileLoop {
  const seams: ReconcileSeams = {
    runningAgents: opts.runningAgents,
    livenessInputFor: opts.livenessInputFor,
    now: opts.now,
    onBreak: router.onBreak,
    markStuck: router.markStuck,
    injectNudge: opts.injectNudge ?? router.injectNudge,
  };
  return new ReconcileLoop(seams, opts.config);
}

// ── AC-S9-4 — over the RECORDED running-state (real P3 selectAllSessions) ────────────────────────────

const PROJECT_ID = 'test-reconcile-project';
const ORIGINAL_ENV = process.env;
let dataDir: string;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDir = mkdtempSync(join(tmpdir(), 'co-reconcile-'));
  process.env.CO_DATA_DIR = dataDir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  rmSync(dataDir, { recursive: true, force: true });
});

/**
 * Seed one RUNNING session (impl-1) and one ENDED session (coord-1), simulate crash + relaunch via
 * `recoverProjectStore`, then return the recovered RUNNING set as {@link RunningAgent}s over FakePty
 * panes — exactly how the host joins P3's `selectAllSessions` to its hosted panes.
 */
function recoverRunningSet(): RunningAgent[] {
  const sessions = openSessionStore(PROJECT_ID);
  sessions.recordSession({
    agentId: 'impl-1',
    pane: 'pane-impl',
    cwd: '/tmp/wt/impl',
    provider: 'claude',
    resume: { provider: 'claude', sessionId: 'sess-abc' },
  });
  sessions.recordSession({
    agentId: 'coord-1',
    pane: 'pane-coord',
    cwd: '/tmp/wt/coord',
    provider: 'claude',
    resume: { provider: 'claude', sessionId: 'sess-xyz' },
  });
  sessions.endSession('coord-1', 'pane-coord'); // coord-1 finished — NOT a reconcile candidate
  sessions.close();

  recoverProjectStore(PROJECT_ID); // crash + relaunch: rebuild read-models from the event log alone

  const store = openProjectStore(PROJECT_ID);
  try {
    const running = store.transaction((tx) => selectAllSessions(tx.raw as DatabaseSync));
    const host = new FakePty();
    return running.map((s) => ({
      agentId: s.agentId,
      pane: host.spawn(SPEC),
      provider: s.provider,
    }));
  } finally {
    store.close();
  }
}

describe('ReconcileLoop — AC-S9-4: silent-stop over the recorded running-state ⇒ nudge ⇒ STUCK-and-surfaced', () => {
  it('a synthesized idle/no-worker_done/pty-quiet trace over selectAllSessions fires the watchdog → nudge → STUCK', async () => {
    const running = recoverRunningSet();
    // Only the RUNNING agent survives recovery — coord-1 ended its session (P3 running-state).
    expect(running.map((a) => a.agentId)).toEqual(['impl-1']);

    const router = fakeRouter();
    let clock = IDLE_OBSERVED_AT;
    const loop = buildLoop(
      {
        runningAgents: () => running,
        livenessInputFor: () => silentStopInput(),
        now: () => clock,
      },
      router,
    );

    // Tick 1: detect the silent stop → SURFACE the break + the gentle corrective nudge. NOT stuck yet.
    const t1 = await loop.tick();
    expect(t1.assessed).toHaveLength(1);
    expect(t1.assessed[0]?.verdict.break?.kind).toBe('silent_stop');
    expect(router.breaks).toHaveLength(1);
    expect(router.breaks[0]).toMatchObject({ agent: 'impl-1', info: { kind: 'silent_stop' } });
    expect(router.nudges).toEqual([{ triggerId: SILENT_STOP_TRIGGER }]);
    expect(router.stuck).toEqual([]);

    // Tick 2: still idle, still no completion ⇒ persisting break ⇒ STUCK-and-surfaced (bounded: 2 ticks).
    clock += 4000;
    await loop.tick();
    expect(router.nudges).toHaveLength(1); // not re-nudged
    expect(router.stuck).toEqual(['impl-1']); // escalated
  });
});

// ── MNR-1 — the canonical bug, plus its inverse (no false STUCK) ─────────────────────────────────────

describe('ReconcileLoop — MNR-1: idle + no completion verb ⇒ silent_stop ⇒ nudge ⇒ persisting ⇒ STUCK', () => {
  it('fires the finish-before-yield nudge, then escalates to STUCK on persistence', async () => {
    const host = new FakePty();
    const router = fakeRouter();
    let clock = IDLE_OBSERVED_AT;
    const loop = buildLoop(
      {
        runningAgents: () => [runningAgent('impl-7', host)],
        livenessInputFor: () => silentStopInput(),
        now: () => clock,
      },
      router,
    );

    await loop.tick(); // fire → nudge
    expect(router.breaks[0]?.info.kind).toBe('silent_stop');
    expect(router.breaks[0]?.info.triggerId).toBe('finish-before-yield');
    expect(router.nudges).toEqual([{ triggerId: 'finish-before-yield' }]);
    expect(router.stuck).toEqual([]);

    clock += 4000;
    await loop.tick(); // persisting → STUCK
    expect(router.stuck).toEqual(['impl-7']);
  });

  it('serializes concurrent ticks so an overlap reconcile cannot mark STUCK before the nudge completes', async () => {
    const host = new FakePty();
    const router = fakeRouter();
    let releaseNudge!: () => void;
    let clock = IDLE_OBSERVED_AT;
    const loop = buildLoop(
      {
        runningAgents: () => [runningAgent('impl-serial', host)],
        livenessInputFor: () => silentStopInput(),
        now: () => clock,
        injectNudge: async (_pane, triggerId) => {
          router.nudges.push({ triggerId });
          await new Promise<void>((resolve) => {
            releaseNudge = resolve;
          });
        },
      },
      router,
    );

    const first = loop.tick();
    await Promise.resolve(); // let the first tick signal the break and park in injectNudge
    const concurrent = loop.tick();
    await Promise.resolve();

    expect(router.breaks).toHaveLength(1);
    expect(router.nudges).toEqual([{ triggerId: SILENT_STOP_TRIGGER }]);
    expect(router.stuck).toEqual([]);

    releaseNudge();
    await Promise.all([first, concurrent]);
    expect(router.stuck).toEqual([]);

    clock += 4000;
    await loop.tick();
    expect(router.stuck).toEqual(['impl-serial']);
  });

  it('the INVERSE: an idle turn that DID call co_finish is NOT flagged (no nudge, no false STUCK)', async () => {
    const host = new FakePty();
    const router = fakeRouter();
    let clock = IDLE_OBSERVED_AT;
    const loop = buildLoop(
      {
        runningAgents: () => [runningAgent('impl-8', host)],
        livenessInputFor: () => completedTurnInput('co_finish'),
        now: () => clock,
      },
      router,
    );

    // Same number of idle ticks that would STUCK a silent-stop — but completion was recorded.
    await loop.tick();
    clock += 4000;
    const last = await loop.tick();
    expect(last.assessed[0]?.verdict.liveness).toBe('alive');
    expect(last.assessed[0]?.verdict.break).toBeUndefined();
    expect(router.breaks).toEqual([]);
    expect(router.nudges).toEqual([]);
    expect(router.stuck).toEqual([]); // never falsely STUCK
  });

  it('completion keys on worker_done too — and NEVER on turn-end (idle alone never finishes work)', async () => {
    const host = new FakePty();
    const router = fakeRouter();
    const loop = buildLoop(
      {
        runningAgents: () => [runningAgent('impl-9', host)],
        livenessInputFor: () => completedTurnInput('worker_done'),
        now: () => IDLE_OBSERVED_AT,
      },
      router,
    );

    const t = await loop.tick();
    // The turn is idle (turn-end) yet healthy because the worker_done VERB was seen — turn-end ≠ work-end.
    expect(t.assessed[0]?.verdict.break).toBeUndefined();
    expect(router.stuck).toEqual([]);
  });
});

// ── Wedged / dead / loop mechanics ──────────────────────────────────────────────────────────────────

describe('ReconcileLoop — wedged / dead / persistence / pruning / skip / isolation', () => {
  it('wedged ⇒ bounded (~8 s) break-signal then STUCK on persistence, never nudged (frozen pane cannot echo)', async () => {
    const host = new FakePty();
    const router = fakeRouter();
    let clock = 5000 + WEDGE_MS - 1; // 1 ms before the 8 s boundary
    const loop = buildLoop(
      {
        runningAgents: () => [runningAgent('impl-1', host)],
        livenessInputFor: () => wedgedInput(),
        now: () => clock,
      },
      router,
    );

    const before = await loop.tick();
    expect(before.assessed[0]?.verdict.liveness).toBe('alive'); // not yet wedged
    expect(router.breaks).toEqual([]);

    clock = 5000 + WEDGE_MS; // exactly at the boundary
    await loop.tick();
    expect(router.breaks[0]?.info.kind).toBe('wedged');
    expect(router.nudges).toEqual([]); // a frozen process carries no catalog nudge
    expect(router.stuck).toEqual([]);

    clock += 2000; // still wedged ⇒ STUCK
    await loop.tick();
    expect(router.stuck).toEqual(['impl-1']);
  });

  it('dead ⇒ the reap signal (break-signal once), never nudged, never marked STUCK', async () => {
    const host = new FakePty();
    const router = fakeRouter();
    let clock = 100;
    const loop = buildLoop(
      {
        runningAgents: () => [runningAgent('impl-1', host)],
        livenessInputFor: () => deadInput(),
        now: () => clock,
      },
      router,
    );

    await loop.tick();
    clock = 200;
    await loop.tick();
    expect(router.breaks).toHaveLength(1); // emitted once — the runtime reaps a dead pane
    expect(router.breaks[0]?.info.kind).toBe('dead');
    expect(router.nudges).toEqual([]);
    expect(router.stuck).toEqual([]);
  });

  it('persists one watchdog per agent; a healthy sweep resets the episode so a later break nudges afresh', async () => {
    const host = new FakePty();
    const router = fakeRouter();
    let clock = IDLE_OBSERVED_AT;
    let phase: 'break' | 'healthy' = 'break';
    const healthyInput: LivenessInput = {
      trace: [{ kind: 'bytes', at: 9000, bytes: 12 }],
      exited: false,
      pidAlive: true,
      turnActive: true,
    };
    const loop = buildLoop(
      {
        runningAgents: () => [runningAgent('impl-1', host)],
        livenessInputFor: () => (phase === 'break' ? silentStopInput() : healthyInput),
        now: () => clock,
      },
      router,
    );

    await loop.tick(); // break → nudge
    expect(router.nudges).toHaveLength(1);
    expect(loop.tracked).toBe(1);

    // Healthy sweep (bytes flowing, mid-turn) ⇒ episode reset on the SAME persisted watchdog.
    phase = 'healthy';
    clock = 9100;
    const healthy = await loop.tick();
    expect(healthy.assessed[0]?.verdict.break).toBeUndefined();
    expect(loop.tracked).toBe(1); // still RUNNING ⇒ still tracked

    // A fresh break afterwards nudges AGAIN (new episode), not straight to STUCK.
    phase = 'break';
    clock = 11000 + QUIET_WINDOW_MS + 1;
    await loop.tick();
    expect(router.nudges).toHaveLength(2);
    expect(router.stuck).toEqual([]);
  });

  it('drops the watchdog when an agent leaves the RUNNING set; a returning id starts a fresh episode', async () => {
    const host = new FakePty();
    const router = fakeRouter();
    const agent = runningAgent('impl-1', host);
    let running: RunningAgent[] = [agent];
    let clock = IDLE_OBSERVED_AT;
    const loop = buildLoop(
      {
        runningAgents: () => running,
        livenessInputFor: () => silentStopInput(),
        now: () => clock,
      },
      router,
    );

    await loop.tick(); // impl-1 breaks → nudge
    expect(router.nudges).toHaveLength(1);
    expect(loop.tracked).toBe(1);

    // impl-1 leaves the running set (finished / session ended) ⇒ its watchdog is dropped, NOT escalated.
    running = [];
    clock += 4000;
    await loop.tick();
    expect(loop.tracked).toBe(0);
    expect(router.stuck).toEqual([]); // a departed agent is never falsely STUCK

    // It returns (a fresh run reusing the id) ⇒ a NEW episode: nudge again, not an immediate STUCK.
    running = [agent];
    clock += 4000;
    await loop.tick();
    expect(router.nudges).toHaveLength(2);
    expect(router.stuck).toEqual([]);
  });

  it('skips agents the host cannot observe this tick (livenessInputFor ⇒ undefined — orphan, no live pane)', async () => {
    const host = new FakePty();
    const router = fakeRouter();
    const a = runningAgent('impl-1', host);
    const b = runningAgent('impl-2', host);
    const loop = buildLoop(
      {
        runningAgents: () => [a, b],
        livenessInputFor: (agent) => (agent.agentId === 'impl-2' ? undefined : silentStopInput()),
        now: () => IDLE_OBSERVED_AT,
      },
      router,
    );

    const t = await loop.tick();
    expect(t.skipped).toEqual(['impl-2']); // unobservable this tick — surfaced, not silently dropped
    expect(t.assessed.map((x) => x.agent)).toEqual(['impl-1']);
    expect(loop.tracked).toBe(1); // only the observed agent got a watchdog
  });

  it('isolates + surfaces a per-agent failure (nudge throws) so the rest of the sweep still completes', async () => {
    const host = new FakePty();
    const router = fakeRouter();
    const a = runningAgent('impl-1', host); // its nudge injection throws
    const b = runningAgent('impl-2', host); // still reconciled despite a failing
    const loop = buildLoop(
      {
        runningAgents: () => [a, b],
        livenessInputFor: () => silentStopInput(),
        now: () => IDLE_OBSERVED_AT,
        injectNudge: async (pane, triggerId) => {
          if (pane === a.pane) throw new Error('pty write failed');
          router.nudges.push({ triggerId });
        },
      },
      router,
    );

    const t = await loop.tick();
    // impl-1's nudge threw — SURFACED in errors (never swallowed), and its break-signal still fired first.
    expect(t.errors).toHaveLength(1);
    expect(t.errors[0]?.agent).toBe('impl-1');
    expect(router.breaks.map((x) => x.agent)).toEqual(['impl-1', 'impl-2']);
    // impl-2 was still reconciled + nudged despite impl-1 failing.
    expect(t.assessed.map((x) => x.agent)).toEqual(['impl-2']);
    expect(router.nudges).toEqual([{ triggerId: SILENT_STOP_TRIGGER }]);
  });

  it('threads the loop base config to each assess (a widened idle window suppresses a premature break)', async () => {
    const host = new FakePty();
    const router = fakeRouter();
    // A RunningAgent WITHOUT a provider exercises the base-config path (no per-agent provider merge).
    const loop = buildLoop(
      {
        runningAgents: () => [{ agentId: 'impl-1', pane: host.spawn(SPEC) }],
        livenessInputFor: () => silentStopInput(),
        now: () => IDLE_OBSERVED_AT,
        config: { quietWindowMs: 10_000 }, // widen the idle window well past the elapsed silence
      },
      router,
    );

    const t = await loop.tick();
    // With the wider window the turn is NOT yet idle, so the base config must have reached the classifier.
    expect(t.assessed[0]?.verdict.break).toBeUndefined();
    expect(router.nudges).toEqual([]);
    expect(router.stuck).toEqual([]);
  });
});

// ── MNR-2 (#b) — errored_waiting break signal ────────────────────────────────────────────────────
// AC-S10-5 (#b): an agent whose last turn errored + is waiting + has outstanding actionable mail
// emits the `errored_waiting` break so the conductor can re-inject the still-outstanding item.

/** The errored-waiting input: turn errored, has waiting items, has outstanding actionable mail. */
function erroredWaitingInput(): LivenessInput {
  return {
    trace: idleNoCompletionTrace(),
    exited: false,
    pidAlive: true,
    turnActive: false,
    lastTurnErrored: true,
    hasWaitingItems: true,
    hasOutstandingActionable: true,
  };
}

describe('ReconcileLoop — errored_waiting break (MNR-2 re-wake signal)', () => {
  it('emits errored_waiting once when last turn errored + waiting + outstanding; no nudge, no STUCK', async () => {
    const host = new FakePty();
    const router = fakeRouter();
    const loop = buildLoop(
      {
        runningAgents: () => [runningAgent('impl-err', host)],
        livenessInputFor: () => erroredWaitingInput(),
        now: () => IDLE_OBSERVED_AT,
      },
      router,
    );

    // Tick 1: the errored_waiting break is emitted — once, no nudge (re-inject, not a pane nudge).
    const t1 = await loop.tick();
    expect(t1.assessed[0]?.verdict.break?.kind).toBe('errored_waiting');
    expect(router.breaks).toHaveLength(1);
    expect(router.breaks[0]).toMatchObject({
      agent: 'impl-err',
      info: { kind: 'errored_waiting' },
    });
    expect(router.nudges).toEqual([]); // no pane nudge — conductor re-injects the outstanding item
    expect(router.stuck).toEqual([]); // not escalated to STUCK — it needs re-injection, not unstick

    // Tick 2: same conditions persist — NOT re-emitted (signaled flag set; break episode persists).
    await loop.tick();
    expect(router.breaks).toHaveLength(1); // still only once
    expect(router.stuck).toEqual([]); // never STUCK from errored_waiting alone
  });

  it('the INVERSE: errored turn WITHOUT waiting/outstanding is NOT flagged as errored_waiting', async () => {
    const host = new FakePty();
    const router = fakeRouter();
    const loop = buildLoop(
      {
        runningAgents: () => [runningAgent('impl-ok', host)],
        livenessInputFor: () => ({
          ...erroredWaitingInput(),
          hasWaitingItems: false,
          hasOutstandingActionable: false,
        }),
        now: () => IDLE_OBSERVED_AT,
      },
      router,
    );

    // An errored turn with no waiting/outstanding does not fire the errored_waiting break.
    // It may fire silent_stop instead (same trace), but NOT errored_waiting.
    const t = await loop.tick();
    expect(t.assessed[0]?.verdict.break?.kind).not.toBe('errored_waiting');
  });
});

// ── ST-2/ST-3 (#c) — crash → recover → reconcile integration test ─────────────────────────────────
// AC-S10-5 (#c): recoverProjectStore → selectAllSessions → ReconcileLoop end-to-end integration test.
// A crash is simulated by calling recoverProjectStore on an existing event log; the recovered RUNNING
// set feeds ReconcileLoop, which drives a stuck/zombie agent back toward WAITING (silent-stop cure).

describe('ST-2/ST-3 integration — crash→recover→reconcile end-to-end (AC-S10-5.3)', () => {
  it('a crash-recovered RUNNING set feeds ReconcileLoop and a zombie agent escalates to STUCK-and-surfaced', async () => {
    // recoverRunningSet seeds sessions, simulates crash + relaunch (recoverProjectStore), then
    // queries selectAllSessions — exactly the crash→recover portion of ST-2/ST-3.
    const running = recoverRunningSet();
    // After recovery, only impl-1 is RUNNING (coord-1 ended its session — not a reconcile candidate).
    expect(running.map((r) => r.agentId)).toEqual(['impl-1']);

    // Feed the recovered RUNNING set into ReconcileLoop with a synthesized silent-stop trace
    // (the canonical zombie: idle, no worker_done, pty-quiet — ST-2 reconcile half).
    const router = fakeRouter();
    let clock = IDLE_OBSERVED_AT;
    const loop = buildLoop(
      {
        runningAgents: () => running,
        livenessInputFor: () => silentStopInput(),
        now: () => clock,
      },
      router,
    );

    // Tick 1: detect silent stop → break-signal + nudge. NOT stuck yet.
    const t1 = await loop.tick();
    expect(t1.assessed).toHaveLength(1);
    expect(t1.assessed[0]?.agent).toBe('impl-1');
    expect(t1.assessed[0]?.verdict.break?.kind).toBe('silent_stop');
    expect(router.breaks).toHaveLength(1);
    expect(router.nudges).toEqual([{ triggerId: SILENT_STOP_TRIGGER }]);
    expect(router.stuck).toEqual([]);

    // Tick 2: persisting silent stop → STUCK-and-surfaced (bounded: 2 ticks, AC-L7-5).
    clock += 4000;
    await loop.tick();
    expect(router.stuck).toEqual(['impl-1']); // escalated — the canonical zombie cure (ST-3)
  });
});
