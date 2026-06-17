/**
 * Stage 14 · P1 (KEYSTONE) [sandbox] — ROOT COLD-START over `FakePty`. Proves the daemon cold-starts a
 * registered-but-unhosted ROOT coordinator (the {@link startCoordinatorSession} primitive registered it
 * + provisioned its worktree but minted NO session) and drives its first turn — all deterministic,
 * composed exactly like `daemon.test.ts` / `sh1-dry-run.test.ts` (real engine + daemon over `FakePty`,
 * an injected counter clock, a controllable byte-quiet window, `InMemoryTransport` for the MCP bind).
 * Ladders AC-S14-1.
 *
 * What it proves:
 *   (1) After `startCoordinatorSession(...)` + a `daemon.tick()`, the root is HOSTED, a SESSION record
 *       exists, the ROSTER has it (`coordinator`/`@operator`), and the daemon DROVE its first turn (the
 *       outstanding kickoff `clarify_request` was selected + injected) — asserted via the stores + tick
 *       outcome, never the scripted pane's claims.
 *   (2) The `impl-cold` invariant stays green: a recovered CHILD session is NEVER cold-launched, even
 *       alongside a root that IS cold-started.
 *   (3) Deterministic: the same injected clock + scripted bytes ⇒ the same cold-start outcome (run twice).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  FakePty,
  OPERATOR,
  WEDGE_MS,
  ReconcileLoop,
  defaultMailRenderer,
  type DetectorEvent,
  openMailStore,
  openRegistry,
  openRosterStore,
  openSessionStore,
  startCoordinatorSession,
  type DeliveredMail,
  type ProjectId,
  type Role,
  type SlingDeps,
} from '@co/core';
import { ConductorDaemon, type DaemonTickOutcome } from './daemon.js';
import { ConductorEngine } from './engine.js';
import type { HostedIdentity } from '../live-session-host.js';

// ── Scripted startup fixture. ESC via fromCharCode so the SOURCE holds no raw control byte. ──
const ESC = String.fromCharCode(0x1b);
const CLAUDE_READY = ESC + '[2J' + ESC + '[H' + '╭─ Welcome ─╮\r\n❯ \r\n  ? for shortcuts\r\n';

// A no-op provisioner + clean baseline so the worktree-provisioning is deterministic (no manifest I/O).
const SLING_DEPS: SlingDeps = {
  provisioner: () => ({ provisioned: [], skipped: [] }),
  probe: () => [],
};

const ORIGINAL_ENV = process.env;
let dirs: string[] = [];
let engines: ConductorEngine[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dirs = [];
  engines = [];
});

afterEach(async () => {
  for (const engine of engines) {
    try {
      await engine.closeAll();
    } catch {
      /* best-effort */
    }
  }
  process.env = ORIGINAL_ENV;
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** A real repo (no remote → offline), on `main` with one base commit (mirrors sh1-dry-run.makeRepo). */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-cold-repo-'));
  dirs.push(dir);
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
  const dataDir = mkdtempSync(join(tmpdir(), 'co-cold-data-'));
  dirs.push(dataDir);
  process.env.CO_DATA_DIR = dataDir;
  const repo = makeRepo();
  const registry = openRegistry();
  try {
    return { projectId: registry.register(repo), repo };
  } finally {
    registry.close();
  }
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
  pty: FakePty,
  clock: ReturnType<typeof makeClock>,
  qw: ReturnType<typeof makeQuietWindow>,
  opts: { readonly mcpActivity?: (push: (ev: DetectorEvent) => void) => void } = {},
): ConductorEngine {
  const engine = new ConductorEngine({
    pty,
    makeTransport: () => InMemoryTransport.createLinkedPair(),
    now: clock.now,
    quietWindow: qw.quietWindow,
    injectOptions: { retryDelay: () => new Promise<void>(() => {}) },
    ...(opts.mcpActivity != null
      ? {
          mcpActivity: (_pane, push) => {
            opts.mcpActivity!(push);
            return () => {};
          },
        }
      : {}),
  });
  engines.push(engine);
  return engine;
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

/** Read the single outstanding kickoff for `agent` (the daemon will inject it during the driven turn). */
function kickoffFor(projectId: ProjectId, agent: string): DeliveredMail {
  const mail = openMailStore(projectId);
  try {
    const item = mail.outstanding(agent)[0];
    if (item == null) throw new Error(`expected an outstanding kickoff for '${agent}'`);
    return item;
  } finally {
    mail.close();
  }
}

interface ColdStartRun {
  readonly coordinator: string;
  readonly out: DaemonTickOutcome;
  readonly hosted: boolean;
  readonly sessionExists: boolean;
  readonly rosterRole: string | undefined;
  readonly rosterParent: string | undefined;
}

/** Start a root, compose the daemon over FakePty, and drive ONE tick that cold-starts + drives it. */
async function driveColdStart(projectId: ProjectId, repo: string): Promise<ColdStartRun> {
  const { coordinator } = startCoordinatorSession(
    { projectId, repoCwd: repo, prompt: 'orchestrate the toy change', base: 'main' },
    { slingDeps: SLING_DEPS },
  );

  const clock = makeClock();
  const qw = makeQuietWindow();
  const pty = new FakePty();
  const engine = makeEngine(pty, clock, qw);
  const daemon = new ConductorDaemon({
    engine,
    reconcile: makeReconcile(clock),
    projectId,
    now: clock.now,
    reconcileEvery: 1,
  });

  const kickoff = kickoffFor(projectId, coordinator);

  // ONE tick cold-starts the registered-but-unhosted root (hosts + mints its session) and drives its
  // first turn within the same tick. Feed startup bytes to the freshly-spawned pane, then drive the turn.
  const tickP = daemon.tick();
  await tick(); // let ensureHosted spawn the pane + connect the MCP bind
  const rootPane = pty.panes[pty.panes.length - 1]!;
  rootPane.emit(CLAUDE_READY); // drive startup to ready ⇒ ensureHosted resolves; runCycle then selects it
  await driveTurnToIdle(rootPane, kickoff, clock, qw);
  const out = await tickP;

  const sessions = openSessionStore(projectId);
  const roster = openRosterStore(projectId);
  try {
    const session = sessions.getSession(coordinator);
    const agent = roster.getAgent(coordinator);
    return {
      coordinator,
      out,
      hosted: engine.isHosted(projectId, coordinator),
      sessionExists: session?.agentId === coordinator,
      rosterRole: agent?.role,
      rosterParent: agent?.parent,
    };
  } finally {
    sessions.close();
    roster.close();
  }
}

describe('ConductorDaemon — Stage 14 P1 root cold-start (AC-S14-1)', () => {
  it('cold-starts a registered-but-unhosted root coordinator and drives its first turn in one tick', async () => {
    const { projectId, repo } = makeProject();

    // Before any tick: the start primitive left the root registered (roster) but UN-SESSIONED.
    const coordinator = startCoordinatorSession(
      { projectId, repoCwd: repo, prompt: 'orchestrate', base: 'main' },
      { slingDeps: SLING_DEPS },
    ).coordinator;
    const sessionsBefore = openSessionStore(projectId);
    try {
      expect(sessionsBefore.getSession(coordinator)).toBeUndefined();
    } finally {
      sessionsBefore.close();
    }

    // Drive the cold-start over a FRESH project (the assertion above consumed one start already).
    const fresh = makeProject();
    const run = await driveColdStart(fresh.projectId, fresh.repo);

    // The daemon cold-started the root + drove its first turn (kickoff clarify selected + injected).
    expect(run.out.coldStarted).toEqual([run.coordinator]);
    expect(run.out.reWarmed).toEqual([]); // cold-start is NOT re-warm — the root path is unchanged (P-E)
    expect(run.out.selected).toBe(run.coordinator);
    expect(run.out.coldCandidates).toEqual([]);
    expect(run.out.candidateCount).toBe(1);
    expect(run.out.cycle?.turn.errored).toBe(false);
    expect(run.out.cycle?.turn.turnEnd?.idle).toBe(true);
    // Turn-end is a liveness signal ONLY — completion stays verb-keyed (NOT inferred from idle).
    expect(run.out.cycle?.turn.turnEnd?.sawCompletionVerb).toBe(false);

    // AC-S14-1: after the first driven tick BOTH the session + roster records exist, and it is warm.
    expect(run.hosted).toBe(true);
    expect(run.sessionExists).toBe(true);
    expect(run.rosterRole).toBe('coordinator');
    expect(run.rosterParent).toBe(OPERATOR);
  });

  it('does not re-select the consumed root kickoff when later operator work arrives', async () => {
    const { projectId, repo } = makeProject();
    const { coordinator } = startCoordinatorSession(
      { projectId, repoCwd: repo, prompt: 'orchestrate', base: 'main' },
      { slingDeps: SLING_DEPS },
    );

    const clock = makeClock();
    const qw = makeQuietWindow();
    const pty = new FakePty();
    const engine = makeEngine(pty, clock, qw, {
      mcpActivity: (push) => {
        push({ kind: 'mcp_start', at: clock.now(), verb: 'co_spec_draft' });
        push({ kind: 'mcp_end', at: clock.now(), verb: 'co_spec_draft' });
      },
    });
    const daemon = new ConductorDaemon({
      engine,
      reconcile: makeReconcile(clock),
      projectId,
      now: clock.now,
      reconcileEvery: 1,
    });

    const firstKickoff = kickoffFor(projectId, coordinator);
    const firstTick = daemon.tick();
    await tick();
    const rootPane = pty.panes[pty.panes.length - 1]!;
    rootPane.emit(CLAUDE_READY);
    await driveTurnToIdle(rootPane, firstKickoff, clock, qw);
    await firstTick;

    const mail = openMailStore(projectId);
    let proceed: DeliveredMail;
    try {
      proceed = mail.send({
        type: 'clarify_request',
        to: coordinator,
        from: OPERATOR,
        subject: 'Proceed',
        body: 'Spec is locked; continue.',
      });
    } finally {
      mail.close();
    }

    const secondTickP = daemon.tick();
    await tick();
    const injected = kickoffFor(projectId, coordinator);
    await driveTurnToIdle(rootPane, injected, clock, qw);
    const secondTick = await secondTickP;

    expect(secondTick.selected).toBe(coordinator);
    expect(secondTick.cycle?.mail.seq).toBe(proceed.seq);
  });

  it('does NOT cold-start a coordinator registered without a provisioned worktree (a roster ancestor)', async () => {
    const { projectId } = makeProject();
    // A coordinator registered directly (e.g. a roster parent-ancestor) — NO worktree, NO session. The
    // start primitive provisions a worktree before registering a real root, so a worktree-less
    // coordinator is not a launchable root and must be skipped (never fail-loud, never cold-launched).
    const roster = openRosterStore(projectId);
    try {
      roster.recordAgent({ agentId: 'coord-ancestor', role: 'coordinator', parent: OPERATOR });
    } finally {
      roster.close();
    }

    const clock = makeClock();
    const qw = makeQuietWindow();
    const pty = new FakePty();
    const engine = makeEngine(pty, clock, qw);
    const daemon = new ConductorDaemon({
      engine,
      reconcile: makeReconcile(clock),
      projectId,
      now: clock.now,
      reconcileEvery: 1,
    });

    const out = await daemon.tick();

    expect(out.coldStarted).toEqual([]);
    expect(out.selected).toBeNull();
    expect(engine.isHosted(projectId, 'coord-ancestor')).toBe(false);
    expect(pty.panes).toHaveLength(0);
  });

  it('does NOT cold-start a registered root while router skip state suppresses it', async () => {
    const { projectId, repo } = makeProject();
    const { coordinator } = startCoordinatorSession(
      { projectId, repoCwd: repo, prompt: 'orchestrate', base: 'main' },
      { slingDeps: SLING_DEPS },
    );

    const clock = makeClock();
    const qw = makeQuietWindow();
    const pty = new FakePty();
    const engine = makeEngine(pty, clock, qw);
    const daemon = new ConductorDaemon({
      engine,
      reconcile: makeReconcile(clock),
      projectId,
      now: clock.now,
      reconcileEvery: 1,
      isSkipped: (pid, agent) => pid === projectId && agent === coordinator,
    });

    const out = await daemon.tick();

    expect(out.coldStarted).toEqual([]);
    expect(out.selected).toBeNull();
    expect(engine.isHosted(projectId, coordinator)).toBe(false);
    expect(pty.panes).toHaveLength(0);

    const sessions = openSessionStore(projectId);
    try {
      expect(sessions.getSession(coordinator)).toBeUndefined();
    } finally {
      sessions.close();
    }
  });

  it('is deterministic: two runs on fresh projects produce identical cold-start outcomes', async () => {
    // The root id is a deterministic function of the project id (a per-project randomUUID), so it
    // differs by project — exactly like sh1-dry-run's fingerprint excludes per-run git SHAs. Normalize
    // the id-bearing fields into booleans so the OUTCOME SHAPE is what is compared for replay-stability.
    const fingerprint = (r: ColdStartRun): Record<string, unknown> => ({
      coldStartedCount: r.out.coldStarted.length,
      coldStartedRoot: r.out.coldStarted[0] === r.coordinator,
      selectedRoot: r.out.selected === r.coordinator,
      candidateCount: r.out.candidateCount,
      coldCandidates: r.out.coldCandidates,
      reWarmed: r.out.reWarmed,
      idle: r.out.cycle?.turn.turnEnd?.idle ?? null,
      errored: r.out.cycle?.turn.errored ?? null,
      sawCompletionVerb: r.out.cycle?.turn.turnEnd?.sawCompletionVerb ?? null,
      observedAt: r.out.observedAt,
      hosted: r.hosted,
      sessionExists: r.sessionExists,
      rosterRole: r.rosterRole,
      rosterParent: r.rosterParent,
    });

    const a = makeProject();
    const run1 = await driveColdStart(a.projectId, a.repo);
    const b = makeProject();
    const run2 = await driveColdStart(b.projectId, b.repo);

    // The root id differs per project (derived from the project id); everything else is identical.
    expect(fingerprint(run2)).toEqual(fingerprint(run1));
    expect(run1.out.coldStarted).toEqual([run1.coordinator]);
    expect(run2.out.coldStarted).toEqual([run2.coordinator]);
  });
});

// ── Stage 15 · P-E (AC-S15-2 / ST-2) — RE-WARM recovered NON-root agents ─────────────────────────────
//
// GENERALIZES the root cold-start to the recovered live set: after a daemon restart the RUNNING set is
// reconstructed but the NON-root agents (implementers/leads) are COLD in this fresh engine process and
// today are only REPORTED (`coldCandidates`), never driven. The daemon now SELECTS them and re-warms each
// through the SAME single launch authority (`engine.ensureHosted`, MNR-5) — no second launcher.
//
// SELECTION-ONLY harness: a recovered agent ALREADY has an active session, so the real
// `ensureHosted → hostSession → recordSession` REFUSES to re-record it ("already has an active session")
// — re-spawning the crashed provider + reconciling its session row is `[host-live]` glue (host.ts), not
// in-sandbox. So these prove the in-sandbox SELECTION against a SPY launch authority (exactly what the
// brief calls for): the spy records each `ensureHosted` identity and marks the agent hosted, so the
// `isHosted` no-double-dispatch gate is exercised against real daemon code + real recovery stores.

/** A spy standing in for the engine's launch authority: records every `ensureHosted` identity + the
 *  `drivable` set each `runCycle` saw, and tracks hosted state so `isHosted` reflects a re-warm. The
 *  `ensureHosted` MNR-5 guard is mirrored so a buggy double-dispatch fails loud. */
function makeSpyEngine(): {
  engine: ConductorEngine;
  ensureHostedCalls: HostedIdentity[];
  drivableSeen: HostedIdentity[][];
} {
  const hosted = new Set<string>();
  const ensureHostedCalls: HostedIdentity[] = [];
  const drivableSeen: HostedIdentity[][] = [];
  const key = (id: HostedIdentity): string => `${id.projectId}:${id.agent}`;
  const fake = {
    isHosted: (projectId: ProjectId, agent: string): boolean => hosted.has(`${projectId}:${agent}`),
    ensureHosted: async (identity: HostedIdentity): Promise<void> => {
      if (hosted.has(key(identity))) {
        throw new Error(
          `spy ensureHosted: '${identity.agent}' already hosted — MNR-5 backstop (no double-dispatch).`,
        );
      }
      ensureHostedCalls.push(identity);
      hosted.add(key(identity));
    },
    runCycle: async (drivable: readonly HostedIdentity[]): Promise<null> => {
      drivableSeen.push([...drivable]);
      return null; // selection-only: drive nothing (the SELECTION is what these prove)
    },
    tickClarifyTimeouts: async (): Promise<readonly DeliveredMail[]> => [],
  };
  return { engine: fake as unknown as ConductorEngine, ensureHostedCalls, drivableSeen };
}

/** A launch-authority stand-in whose `ensureHosted` runs the recovered agent back through the REAL
 *  session store (`recordSession`) — exactly what the engine's `hostSession` does — so it THROWS the
 *  GENUINE production failure ("already has an active session") for an agent that still owns its
 *  recovered session row. This exercises the daemon's review-375 GUARD against the real default-path
 *  throw — NOT an always-succeeds spy (the always-succeeds spy is precisely what masked the bug).
 *  Records each `ensureHosted` attempt + counts `runCycle` runs so the test can prove the tick SURVIVED
 *  the throw and did NOT churn a pane every tick. */
function makeRecoveredRelaunchEngine(): {
  engine: ConductorEngine;
  ensureHostedCalls: HostedIdentity[];
  runCycleCount: () => number;
} {
  const ensureHostedCalls: HostedIdentity[] = [];
  let runCycles = 0;
  const fake = {
    isHosted: (): boolean => false, // a recovered agent is cold in this fresh engine process
    ensureHosted: async (identity: HostedIdentity): Promise<void> => {
      ensureHostedCalls.push(identity);
      const sessions = openSessionStore(identity.projectId);
      try {
        // The REAL store refuses a duplicate active session — the production throw the GUARD must survive
        // (the real session-reconciling relaunch is deferred [host-live] glue).
        sessions.recordSession({
          agentId: identity.agent,
          pane: identity.pane,
          cwd: identity.cwd,
          provider: identity.provider,
          resume: identity.resume,
        });
      } finally {
        sessions.close();
      }
    },
    runCycle: async (): Promise<null> => {
      runCycles += 1;
      return null;
    },
    tickClarifyTimeouts: async (): Promise<readonly DeliveredMail[]> => [],
  };
  return {
    engine: fake as unknown as ConductorEngine,
    ensureHostedCalls,
    runCycleCount: () => runCycles,
  };
}

/** Register the coord-1 → lead-1 parent chain a real spawn would have recorded (the roster REFUSES an
 *  agent whose parent is unregistered). coord-1 has NO provisioned worktree, so it is never a cold-start
 *  root — it stays inert (no session ⇒ not a candidate; no worktree ⇒ not cold-started). */
function seedLeadChain(projectId: ProjectId): void {
  const roster = openRosterStore(projectId);
  try {
    roster.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: OPERATOR });
    roster.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-1' });
  } finally {
    roster.close();
  }
}

/** Seed a recovered agent the daemon will rebuild into the RUNNING set: a roster row + an ACTIVE session
 *  (so it is cold-in-this-engine but durable), mirroring what a real spawn would have persisted. */
function recordRecoveredAgent(
  projectId: ProjectId,
  cwd: string,
  agentId: string,
  role: Role,
  parent: string,
): void {
  const roster = openRosterStore(projectId);
  try {
    roster.recordAgent({ agentId, role, parent });
  } finally {
    roster.close();
  }
  const sessions = openSessionStore(projectId);
  try {
    sessions.recordSession({
      agentId,
      pane: `pane-${agentId}`,
      cwd,
      provider: 'claude',
      resume: { provider: 'claude', sessionId: `session-${agentId}` },
    });
  } finally {
    sessions.close();
  }
}

function makeReWarmDaemon(
  projectId: ProjectId,
  engine: ConductorEngine,
  clock: ReturnType<typeof makeClock>,
): ConductorDaemon {
  return new ConductorDaemon({
    engine,
    reconcile: makeReconcile(clock),
    projectId,
    now: clock.now,
    reconcileEvery: 1,
  });
}

describe('ConductorDaemon — Stage 15 P-E re-warm recovered NON-root agents (AC-S15-2 / ST-2)', () => {
  it('re-warms a cold recovered NON-root agent via the single launch authority (becomes hosted, joins drivable)', async () => {
    const { projectId, repo } = makeProject();
    seedLeadChain(projectId);
    recordRecoveredAgent(projectId, repo, 'impl-cold', 'implementer', 'lead-1');

    const clock = makeClock();
    const spy = makeSpyEngine();
    const out = await makeReWarmDaemon(projectId, spy.engine, clock).tick();

    // SELECTED + re-warmed through the SAME launch authority, now hosted — distinct from a cold-start.
    expect(out.reWarmed).toEqual(['impl-cold']);
    expect(out.coldStarted).toEqual([]); // it had a recovered session ⇒ not a cold-start
    expect(spy.engine.isHosted(projectId, 'impl-cold')).toBe(true);
    expect(out.coldCandidates).toEqual([]); // re-warmed ⇒ no longer reported as cold

    // Re-warm ran BEFORE the cycle: the re-warmed agent joined the drivable set THIS tick (mirrors step 0).
    expect(spy.drivableSeen.at(-1)?.map((i) => i.agent)).toEqual(['impl-cold']);

    // The launch authority was invoked ONCE, with impl-cold's RECOVERED identity (pane/cwd/provider) —
    // assert the AGENT + recovered fields, not merely the call count.
    expect(spy.ensureHostedCalls).toHaveLength(1);
    expect(spy.ensureHostedCalls[0]).toMatchObject({
      agent: 'impl-cold',
      role: 'implementer',
      pane: 'pane-impl-cold',
      provider: 'claude',
      cwd: repo,
    });
  });

  it('no double-dispatch: a re-warmed agent is NOT re-warmed again on the next tick (ensureHosted called exactly once for it)', async () => {
    const { projectId, repo } = makeProject();
    seedLeadChain(projectId);
    recordRecoveredAgent(projectId, repo, 'impl-cold', 'implementer', 'lead-1');

    const clock = makeClock();
    const spy = makeSpyEngine();
    const daemon = makeReWarmDaemon(projectId, spy.engine, clock);

    const t1 = await daemon.tick();
    expect(t1.reWarmed).toEqual(['impl-cold']);

    const t2 = await daemon.tick();
    expect(t2.reWarmed).toEqual([]); // now warm ⇒ never re-warmed again
    expect(t2.coldCandidates).toEqual([]); // warm, so not a cold candidate either

    // EXACTLY ONE launch for impl-cold across BOTH ticks — the isHosted gate prevents a second dispatch.
    expect(spy.ensureHostedCalls.map((i) => i.agent)).toEqual(['impl-cold']);
  });

  it('cold-starts the root AND re-warms a recovered child in ONE tick — the dispatch split (cold-start root-only, re-warm non-root)', async () => {
    const { projectId, repo } = makeProject();
    // A registered-but-unhosted ROOT (worktree provisioned, NO session) → cold-start target (step 0).
    const { coordinator } = startCoordinatorSession(
      { projectId, repoCwd: repo, prompt: 'orchestrate', base: 'main' },
      { slingDeps: SLING_DEPS },
    );
    // A recovered CHILD under it (active session, cold in this engine) → re-warm target (step 1a).
    recordRecoveredAgent(projectId, repo, 'impl-cold', 'implementer', coordinator);

    const clock = makeClock();
    const spy = makeSpyEngine();
    const out = await makeReWarmDaemon(projectId, spy.engine, clock).tick();

    // The SPLIT: cold-start stays ROOT-only; re-warm handles the NON-root recovered child.
    expect(out.coldStarted).toEqual([coordinator]);
    expect(out.reWarmed).toEqual(['impl-cold']);
    expect(out.coldStarted).not.toContain('impl-cold');
    expect(out.reWarmed).not.toContain(coordinator);
    // BOTH went through the SAME single launch authority — root first (step 0), then child (step 1a).
    expect(spy.ensureHostedCalls.map((i) => i.agent)).toEqual([coordinator, 'impl-cold']);
  });

  it('does NOT re-warm a recovered ROOT-with-session (re-warm is non-root-gated; root handling unchanged)', async () => {
    const { projectId, repo } = makeProject();
    // A recovered ROOT coordinator WITH an active session, cold in this engine (e.g. a previously
    // cold-started root after a daemon restart). It is neither cold-started (it already has a session)
    // nor re-warmed (re-warm is NON-root) — it stays a cold candidate, exactly as root handling was.
    recordRecoveredAgent(projectId, repo, 'coord-recovered', 'coordinator', OPERATOR);

    const clock = makeClock();
    const spy = makeSpyEngine();
    const out = await makeReWarmDaemon(projectId, spy.engine, clock).tick();

    expect(out.reWarmed).toEqual([]); // NON-root gate: the recovered root is not re-warmed
    expect(out.coldStarted).toEqual([]); // not cold-started either (it already has a session)
    expect(out.coldCandidates).toEqual(['coord-recovered']); // stays a cold candidate (unchanged)
    expect(spy.ensureHostedCalls).toEqual([]); // the launch authority was never invoked
  });

  it('is deterministic: the same recovered state ⇒ the same re-warm selection (session creation order)', async () => {
    async function reWarmSelection(): Promise<readonly string[]> {
      const { projectId, repo } = makeProject();
      seedLeadChain(projectId);
      recordRecoveredAgent(projectId, repo, 'impl-a', 'implementer', 'lead-1');
      recordRecoveredAgent(projectId, repo, 'impl-b', 'implementer', 'lead-1');
      const clock = makeClock();
      return (await makeReWarmDaemon(projectId, makeSpyEngine().engine, clock).tick()).reWarmed;
    }

    const run1 = await reWarmSelection();
    const run2 = await reWarmSelection();
    expect(run2).toEqual(run1); // replay-stable: no wall clock in the selection
    expect(run1).toEqual(['impl-a', 'impl-b']); // candidates order = session creation order
  });

  it('GUARDS a throwing per-tick relaunch (review-375): a recovered agent that still owns its session row makes ensureHosted→recordSession THROW — the tick survives (runCycle still runs) and does not churn (attempted once)', async () => {
    const { projectId, repo } = makeProject();
    seedLeadChain(projectId);
    recordRecoveredAgent(projectId, repo, 'impl-cold', 'implementer', 'lead-1');

    const clock = makeClock();
    const engine = makeRecoveredRelaunchEngine();
    const daemon = makeReWarmDaemon(projectId, engine.engine, clock);

    // TICK 1 — the REAL recordSession throw is GUARDED: the tick COMPLETES (does NOT reject), runCycle
    // still ran, and nothing was re-warmed. PRE-GUARD this throw rejected the whole tick (starving
    // runCycle) and spawned+killed a pane every tick (the review-375 default-path bug).
    const t1 = await daemon.tick();
    expect(t1.reWarmed).toEqual([]); // the launch authority refused the recovered agent
    expect(engine.ensureHostedCalls.map((i) => i.agent)).toEqual(['impl-cold']); // attempted once
    expect(engine.runCycleCount()).toBe(1); // runCycle RAN despite the throw — not starved
    expect(t1.coldCandidates).toEqual(['impl-cold']); // stays a cold candidate (reported, not driven)

    // TICK 2 — NO CHURN: the refused agent is NOT re-attempted (a re-attempt would spawn+kill a pane
    // every tick), yet the daemon keeps ticking and running runCycle.
    const t2 = await daemon.tick();
    expect(t2.reWarmed).toEqual([]);
    expect(engine.ensureHostedCalls.map((i) => i.agent)).toEqual(['impl-cold']); // STILL once — no per-tick churn
    expect(engine.runCycleCount()).toBe(2); // runCycle ran again
    expect(t2.coldCandidates).toEqual(['impl-cold']);
  });
});
