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
  QUIET_WINDOW_MS,
  ReconcileLoop,
  defaultMailRenderer,
  openMailStore,
  openRegistry,
  openRosterStore,
  openSessionStore,
  startCoordinatorSession,
  type DeliveredMail,
  type ProjectId,
  type SlingDeps,
} from '@co/core';
import { ConductorDaemon, type DaemonTickOutcome } from './daemon.js';
import { ConductorEngine } from './engine.js';

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
): ConductorEngine {
  const engine = new ConductorEngine({
    pty,
    makeTransport: () => InMemoryTransport.createLinkedPair(),
    now: clock.now,
    quietWindow: qw.quietWindow,
    injectOptions: { retryDelay: () => new Promise<void>(() => {}) },
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
  clock.set(1000 + QUIET_WINDOW_MS + 1);
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

  it('does NOT cold-launch a recovered CHILD session, even alongside a root that IS cold-started', async () => {
    const { projectId, repo } = makeProject();
    const { coordinator } = startCoordinatorSession(
      { projectId, repoCwd: repo, prompt: 'orchestrate', base: 'main' },
      { slingDeps: SLING_DEPS },
    );

    // A recovered child chain under the root: lead-1 (lead) → impl-cold (implementer) with a session.
    const roster = openRosterStore(projectId);
    try {
      roster.recordAgent({ agentId: 'lead-1', role: 'lead', parent: coordinator });
      roster.recordAgent({ agentId: 'impl-cold', role: 'implementer', parent: 'lead-1' });
    } finally {
      roster.close();
    }
    const sessions = openSessionStore(projectId);
    try {
      sessions.recordSession({
        agentId: 'impl-cold',
        pane: 'pane-impl-cold',
        cwd: repo,
        provider: 'claude',
        resume: { provider: 'claude', sessionId: 'session-impl-cold' },
      });
    } finally {
      sessions.close();
    }
    const seed = openMailStore(projectId);
    try {
      seed.send({
        type: 'clarify_request',
        to: 'impl-cold',
        from: 'lead-1',
        subject: 'do the thing',
        body: 'please act',
      });
    } finally {
      seed.close();
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

    const kickoff = kickoffFor(projectId, coordinator);
    const tickP = daemon.tick();
    await tick();
    const rootPane = pty.panes[pty.panes.length - 1]!;
    rootPane.emit(CLAUDE_READY);
    await driveTurnToIdle(rootPane, kickoff, clock, qw);
    const out = await tickP;

    // ONLY the root was cold-started + driven; the child stays a cold candidate (never launched).
    expect(out.coldStarted).toEqual([coordinator]);
    expect(out.selected).toBe(coordinator);
    expect(out.coldCandidates).toEqual(['impl-cold']);
    expect(out.coldStarted).not.toContain('impl-cold');
    expect(engine.isHosted(projectId, 'impl-cold')).toBe(false);
    // Exactly one pane was spawned (the root's) — the child was never launched.
    expect(pty.panes).toHaveLength(1);
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
