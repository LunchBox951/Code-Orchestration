import { describe, it, expect } from 'vitest';
import { FakePty, type FakePtyPane } from './fake-pty.js';
import type { SpawnSpec } from './pty-host.js';
import type { DetectorEvent } from './turn-end-detector.js';
import { QUIET_WINDOW_MS } from './turn-end-detector.js';
import {
  classifyLiveness,
  LivenessWatchdog,
  WEDGE_MS,
  SILENT_STOP_TRIGGER,
  type BreakInfo,
  type LivenessInput,
} from './liveness-watchdog.js';

const SPEC: SpawnSpec = { command: 'claude', args: [], cwd: '/work/agent', env: {} };

/**
 * A trace recorder over a real {@link FakePtyPane}: every `emitAt(at, chunk)` drives the pane's output
 * (so any watcher sees it) AND records a `{ kind: 'bytes', at }` event via the pane's own `onData`, so
 * the classifier trace is SYNTHESIZED from genuine FakePty emissions. `exited` tracks `onExit`.
 */
function record(pane: FakePtyPane): {
  trace: DetectorEvent[];
  exited: () => boolean;
  emitAt: (at: number, chunk: string) => void;
} {
  const trace: DetectorEvent[] = [];
  let clock = 0;
  let exited = false;
  pane.onData((chunk) => trace.push({ kind: 'bytes', at: clock, bytes: chunk.length }));
  pane.onExit(() => {
    exited = true;
  });
  return {
    trace,
    exited: () => exited,
    emitAt: (at, chunk) => {
      clock = at;
      pane.emit(chunk);
    },
  };
}

const SPINNER = 'spinner-frame'; // any non-empty chunk; the classifier counts byte ACTIVITY, not content

describe('classifyLiveness — alive vs wedged (the 8 s boundary)', () => {
  it('continuous spinner bytes ⇒ alive (a working session is never byte-silent)', () => {
    const pane = new FakePty().spawn(SPEC);
    const rec = record(pane);
    for (let t = 0; t <= 4000; t += 250) rec.emitAt(t, SPINNER);

    const input: LivenessInput = {
      trace: rec.trace,
      exited: rec.exited(),
      pidAlive: true,
      turnActive: true,
    };
    const v = classifyLiveness(input, 4100); // 100 ms since the last frame
    expect(v.liveness).toBe('alive');
    expect(v.break).toBeUndefined();
  });

  it('SIGSTOP ⇒ zero bytes ⇒ wedged AT the 8 s boundary and NOT before; SIGCONT ⇒ back to alive', () => {
    const pane = new FakePty().spawn(SPEC);
    const rec = record(pane);
    for (let t = 0; t <= 5000; t += 250) rec.emitAt(t, SPINNER); // alive phase
    pane.signal('SIGSTOP'); // frozen mid-turn — no further bytes, pid still alive
    expect(pane.stopped).toBe(true);

    const frozenInput = (): LivenessInput => ({
      trace: rec.trace,
      exited: rec.exited(), // false — SIGSTOP does not exit
      pidAlive: true, // kill(pid, 0) still succeeds while stopped
      turnActive: true, // the turn never yielded
    });

    // 1 ms before the boundary: still alive (silence = 7999 ms < WEDGE_MS).
    const justBefore = classifyLiveness(frozenInput(), 5000 + WEDGE_MS - 1);
    expect(justBefore.liveness).toBe('alive');
    expect(justBefore.break).toBeUndefined();

    // Exactly at the boundary: wedged (silence = 8000 ms).
    const atBoundary = classifyLiveness(frozenInput(), 5000 + WEDGE_MS);
    expect(atBoundary.liveness).toBe('wedged');
    expect(atBoundary.break?.kind).toBe('wedged');

    // SIGCONT resumes rendering ⇒ bytes flow again ⇒ back to alive.
    pane.signal('SIGCONT');
    expect(pane.stopped).toBe(false);
    rec.emitAt(14000, SPINNER);
    const resumed = classifyLiveness(frozenInput(), 14100);
    expect(resumed.liveness).toBe('alive');
    expect(resumed.break).toBeUndefined();
  });

  it('long command-silent but spinner-rendering turn ⇒ stays alive past 8 s (bytes flowing)', () => {
    const pane = new FakePty().spawn(SPEC);
    const rec = record(pane);
    // 30 s turn whose underlying command is silent, but the spinner keeps rendering frames.
    for (let t = 0; t <= 30000; t += 200) rec.emitAt(t, SPINNER);

    const v = classifyLiveness(
      { trace: rec.trace, exited: rec.exited(), pidAlive: true, turnActive: true },
      30100, // 100 ms since the last frame — well past 8 s of wall time, but bytes flowed throughout
    );
    expect(v.liveness).toBe('alive'); // never misclassified as wedged
    expect(v.break).toBeUndefined();
  });
});

describe('classifyLiveness — dead (highest precedence)', () => {
  it('a FakePty exit ⇒ dead, even with a recent byte and an active turn', () => {
    const pane = new FakePty().spawn(SPEC);
    const rec = record(pane);
    rec.emitAt(0, SPINNER);
    pane.exit(null, 9); // hard death (SIGKILL)
    expect(rec.exited()).toBe(true);

    const v = classifyLiveness(
      { trace: rec.trace, exited: rec.exited(), pidAlive: false, turnActive: true },
      100,
    );
    expect(v.liveness).toBe('dead');
    expect(v.break?.kind).toBe('dead');
  });
});

describe('classifyLiveness — silent-stop (must-not-regress: NOT a reap, NOT misread as alive)', () => {
  it('idle, no co_finish, quiet pty ⇒ silent_stop break (liveness alive, finish-before-yield nudge)', () => {
    const pane = new FakePty().spawn(SPEC);
    const rec = record(pane);
    for (let t = 0; t <= 1000; t += 250) rec.emitAt(t, SPINNER);
    // The agent yielded its turn (turnActive = false) without ever calling co_finish/worker_done.

    const v = classifyLiveness(
      { trace: rec.trace, exited: rec.exited(), pidAlive: true, turnActive: false },
      1000 + QUIET_WINDOW_MS + 1, // pty has been quiet past the idle window
      { provider: 'claude' },
    );

    expect(v.liveness).toBe('alive'); // the process is alive — NOT dead, NOT a reap
    expect(v.break).toBeDefined(); // …but it broke protocol — NOT misread as healthy
    expect(v.break?.kind).toBe('silent_stop');
    expect(v.break?.triggerId).toBe(SILENT_STOP_TRIGGER);
    expect(v.break?.triggerId).toBe('finish-before-yield');
  });

  it('a yielded turn is NEVER wedged — even when quiet far past 8 s (turnActive separates them)', () => {
    const pane = new FakePty().spawn(SPEC);
    const rec = record(pane);
    for (let t = 0; t <= 1000; t += 250) rec.emitAt(t, SPINNER);

    const v = classifyLiveness(
      { trace: rec.trace, exited: rec.exited(), pidAlive: true, turnActive: false },
      1000 + WEDGE_MS + 5000, // quiet for >> 8 s, but the turn was yielded, not frozen
      { provider: 'claude' },
    );
    expect(v.liveness).toBe('alive');
    expect(v.break?.kind).toBe('silent_stop'); // silent-stop, never wedged
  });

  it('a finished turn (co_finish in the call-log) is healthy — no break', () => {
    const pane = new FakePty().spawn(SPEC);
    const rec = record(pane);
    for (let t = 0; t <= 1000; t += 250) rec.emitAt(t, SPINNER);
    rec.trace.push({ kind: 'mcp', at: 900, verb: 'co_finish' }); // the agent DID finish

    const v = classifyLiveness(
      { trace: rec.trace, exited: rec.exited(), pidAlive: true, turnActive: false },
      1000 + QUIET_WINDOW_MS + 1,
      { provider: 'claude' },
    );
    expect(v.liveness).toBe('alive');
    expect(v.break).toBeUndefined(); // saw the completion verb ⇒ no silent-stop
  });
});

/** A fake L6 monitor capturing the injected seams (break-signal, STUCK, nudge). */
function fakeMonitor(pane: FakePtyPane) {
  const breaks: Array<{ agent: string; info: BreakInfo }> = [];
  const stuck: string[] = [];
  const nudges: Array<{ triggerId: string }> = [];
  const watchdog = new LivenessWatchdog({
    pane,
    onBreak: (agent, info) => breaks.push({ agent, info }),
    markStuck: (agent) => stuck.push(agent),
    injectNudge: async (_pane, triggerId) => {
      nudges.push({ triggerId });
    },
  });
  return { watchdog, breaks, stuck, nudges };
}

function silentStopInput(): LivenessInput {
  const trace: DetectorEvent[] = [];
  for (let t = 0; t <= 1000; t += 250) trace.push({ kind: 'bytes', at: t, bytes: 12 });
  return { trace, exited: false, pidAlive: true, turnActive: false };
}

function wedgedInput(): LivenessInput {
  const trace: DetectorEvent[] = [];
  for (let t = 0; t <= 5000; t += 250) trace.push({ kind: 'bytes', at: t, bytes: 12 });
  return { trace, exited: false, pidAlive: true, turnActive: true };
}

describe('LivenessWatchdog — break ⇒ nudge ⇒ break-signal ⇒ STUCK on persistence', () => {
  it('silent-stop: injectNudge(finish-before-yield) + break-signal first, STUCK only when it persists', async () => {
    const pane = new FakePty().spawn(SPEC);
    const mon = fakeMonitor(pane);
    const at = 1000 + QUIET_WINDOW_MS + 1;

    // First observation of the break: gentle corrective + break-signal, NO STUCK yet.
    const v1 = await mon.watchdog.assess('impl-7', silentStopInput(), at, { provider: 'claude' });
    expect(v1.break?.kind).toBe('silent_stop');
    expect(mon.nudges).toEqual([{ triggerId: 'finish-before-yield' }]); // the RIGHT trigger
    expect(mon.breaks).toHaveLength(1);
    expect(mon.breaks[0]).toMatchObject({ agent: 'impl-7', info: { kind: 'silent_stop' } });
    expect(mon.stuck).toEqual([]); // not stuck yet — the nudge gets a chance

    // The break persists (next observation still silent-stop): escalate to STUCK, no re-nudge.
    await mon.watchdog.assess('impl-7', silentStopInput(), at + 4000, { provider: 'claude' });
    expect(mon.nudges).toHaveLength(1); // not nudged again
    expect(mon.breaks).toHaveLength(1); // break-signal already emitted
    expect(mon.stuck).toEqual(['impl-7']); // escalated
  });

  it('wedged is bounded (~8 s, not a multi-hour wait): break-signal at the boundary, STUCK on persistence', async () => {
    const pane = new FakePty().spawn(SPEC);
    const mon = fakeMonitor(pane);

    // Before the boundary: alive, no break-signal, no STUCK.
    const before = await mon.watchdog.assess('impl-7', wedgedInput(), 5000 + WEDGE_MS - 1);
    expect(before.liveness).toBe('alive');
    expect(mon.breaks).toEqual([]);

    // At the boundary (logical 8 s of silence — NOT hours): wedged break-signal emitted, no nudge
    // (a frozen process cannot echo one), no STUCK yet.
    const atBoundary = await mon.watchdog.assess('impl-7', wedgedInput(), 5000 + WEDGE_MS);
    expect(atBoundary.liveness).toBe('wedged');
    expect(mon.breaks).toHaveLength(1);
    expect(mon.breaks[0]?.info.kind).toBe('wedged');
    expect(mon.nudges).toEqual([]); // wedged carries no catalog nudge
    expect(mon.stuck).toEqual([]);

    // Still wedged on the next sweep ⇒ STUCK.
    await mon.watchdog.assess('impl-7', wedgedInput(), 5000 + WEDGE_MS + 2000);
    expect(mon.stuck).toEqual(['impl-7']);
  });

  it('recovery clears the episode: a healthy sweep resets, so a later break nudges afresh', async () => {
    const pane = new FakePty().spawn(SPEC);
    const mon = fakeMonitor(pane);
    const at = 1000 + QUIET_WINDOW_MS + 1;

    await mon.watchdog.assess('impl-7', silentStopInput(), at, { provider: 'claude' });
    expect(mon.nudges).toHaveLength(1);

    // Healthy sweep (bytes flowing, mid-turn) ⇒ episode reset.
    const healthy: LivenessInput = {
      trace: [{ kind: 'bytes', at: 9000, bytes: 12 }],
      exited: false,
      pidAlive: true,
      turnActive: true,
    };
    const v = await mon.watchdog.assess('impl-7', healthy, 9100);
    expect(v.break).toBeUndefined();

    // A fresh break afterwards nudges again (new episode), does not jump straight to STUCK.
    await mon.watchdog.assess('impl-7', silentStopInput(), 11000 + QUIET_WINDOW_MS + 1, {
      provider: 'claude',
    });
    expect(mon.nudges).toHaveLength(2);
    expect(mon.stuck).toEqual([]);
  });

  it('dead: break-signal emitted once, never nudged, never marked stuck (the runtime reaps it)', async () => {
    const pane = new FakePty().spawn(SPEC);
    const mon = fakeMonitor(pane);
    const deadInput: LivenessInput = {
      trace: [{ kind: 'bytes', at: 0, bytes: 12 }],
      exited: true,
      pidAlive: false,
      turnActive: true,
    };

    await mon.watchdog.assess('impl-7', deadInput, 100);
    await mon.watchdog.assess('impl-7', deadInput, 200);
    expect(mon.breaks).toHaveLength(1); // emitted once
    expect(mon.breaks[0]?.info.kind).toBe('dead');
    expect(mon.nudges).toEqual([]);
    expect(mon.stuck).toEqual([]);
  });
});
