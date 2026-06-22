/**
 * Stage 11 P1 (OP-IPC) — [sandbox] acceptance for the cross-process operator-IPC binding.
 *
 * Harness = control-observe.test.ts (an in-process {@link ConductorEngine} + `FakePty` + injected
 * clock/quietWindow + the daemon-backed router + the engine-backed live-observe) ⊕ real-transport.test.ts
 * (a REAL Unix-domain socket pair; the client and server share no memory — they speak only over the
 * socket, the faithfully-isolated cross-process proof the spec sanctions). NO live provider binary, NO
 * wall clock in the engine path.
 *
 * The proofs (spec §5):
 *   - AC-S11-1 — cross-process `observe()` returns the live snapshot; `pause`/`resume`/`stop`/`unstick`
 *     reach the daemon and a follow-up `observe()` reflects the change; the socket is `0o600`
 *     operator-only; a daemon-down read DEGRADES to the static `queryObservability` (never a hang/throw).
 *   - AC-S11-6 — the IPC server + client add NO agent-facing MCP tool; `checkToolCompleteness` stays `[]`.
 *   - MNR #2 — every WRITE (reply/approve) routes through the daemon's own store (single writer).
 *   - MNR #3 — a down→up daemon degrades to a clear state and a reconnect RESUMES the push stream.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  approvalOutcome,
  buildCoreRegistry,
  checkToolCompleteness,
  defaultGitRawReader,
  FakePty,
  MAIL_APPROVAL_RESPONSE,
  MAIL_REVIEW_REQUEST,
  MAIL_REVIEW_RESPONSE,
  OPERATOR,
  openArchiveStore,
  openMailStore,
  openRegistry,
  openReviewStore,
  openRosterStore,
  openSessionStore,
  openSpecStore,
  openWorktreeStore,
  outwardApprovalEnvelope,
  startCoordinatorSession,
  queryLiveObservability,
  queryObservability,
  type DeliveredMail,
  type MailStore,
  type OperatorIpcTick,
  type OperatorIpcTranscript,
  type ProjectId,
  type ProjectRegistry,
  type ReviewContext,
  type ReviewStore,
  type RosterStore,
  type SessionStore,
} from '@co/core';
import { ConductorEngine, type ConductorEngineDeps, type HostedPane } from '../conductor/engine.js';
import { DaemonBackedAgentRouter } from '../conductor/agent-router.js';
import { EngineLiveStateProvider } from '../conductor/live-observe.js';
import {
  serveConductor,
  type ConductorControlSurface,
  type ConductorHostRunner,
  type IntervalHandle,
  type IntervalScheduler,
} from '../conductor/host.js';
import { SocketClientTransport } from '../conductor/real-transport.js';
import type { HostedIdentity } from '../live-session-host.js';
import { resolveReviewContext } from '../conductor/review-context.js';
import { OperatorIpcServer, type OperatorIpcServerDeps } from './server.js';
import { ConductorUnavailableError, OperatorIpcClient, OperatorIpcConnection } from './client.js';
import { classifyIncoming, makeRequest, WIRE_ERROR } from './wire.js';

// ── Scripted startup fixture. ESC/CR via fromCharCode so the SOURCE holds no raw control byte. ──
const ESC = String.fromCharCode(0x1b);
const CR = String.fromCharCode(0x0d);
const CLAUDE_READY = ESC + '[2J' + ESC + '[H' + '╭─ Welcome ─╮\r\n❯ \r\n  ? for shortcuts\r\n';

// ── Cleanup state ────────────────────────────────────────────────────────────
const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let engines: ConductorEngine[] = [];
let registries: ProjectRegistry[] = [];
let mailStores: MailStore[] = [];
let reviewStores: ReviewStore[] = [];
let rosterStores: RosterStore[] = [];
let sessionStores: SessionStore[] = [];
let servers: OperatorIpcServer[] = [];
let clients: OperatorIpcClient[] = [];
let runners: ConductorHostRunner[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  engines = [];
  registries = [];
  mailStores = [];
  reviewStores = [];
  rosterStores = [];
  sessionStores = [];
  servers = [];
  clients = [];
  runners = [];
});

afterEach(async () => {
  for (const runner of runners) {
    try {
      await runner.stop();
    } catch {
      /* best-effort */
    }
  }
  for (const client of clients) {
    try {
      await client.close();
    } catch {
      /* best-effort */
    }
  }
  for (const server of servers) {
    try {
      await server.close();
    } catch {
      /* best-effort */
    }
  }
  for (const engine of engines) {
    try {
      await engine.closeAll();
    } catch {
      /* best-effort */
    }
  }
  for (const closeable of [
    ...mailStores,
    ...reviewStores,
    ...rosterStores,
    ...sessionStores,
    ...registries,
  ]) {
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

// ── Helpers (mirroring control-observe.test.ts) ─────────────────────────────────
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const flush = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i++) await tick();
};

function makeProject(): { projectId: ProjectId; cwd: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'co-opipc-'));
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

function seedActionableMail(projectId: ProjectId, agent: string, from = 'lead-1'): DeliveredMail {
  const mail = openMailStore(projectId);
  try {
    return mail.send({
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

function inboxOf(projectId: ProjectId, agent: string): readonly DeliveredMail[] {
  const store = openMailStore(projectId);
  mailStores.push(store);
  return store.inbox(agent);
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

/** Build the operator control surface `co-mcp serve` wires (the daemon-backed router + live-observe). */
function makeControl(
  engine: ConductorEngine,
  projectId: ProjectId,
  // Stage 13 R-A — the reviewContext accessor is injectable so the agreement proof can wire the REAL
  // resolver over seeded stores; other tests get a harmless not-found stub (they never exercise it).
  reviewContext: ConductorControlSurface['reviewContext'] = (reviewId) =>
    Promise.resolve({ kind: 'not-found', reviewId }),
): { router: DaemonBackedAgentRouter; control: ConductorControlSurface } {
  const router = new DaemonBackedAgentRouter({ engine, projectId });
  const provider = new EngineLiveStateProvider({ engine, projectId, router });
  const control: ConductorControlSurface = {
    router,
    observe: () => queryLiveObservability(projectId, provider),
    // Stage 12 C-P1 (TRANSCRIPT-SEAM) — wire the transcript accessors from the REAL engine, exactly as
    // serveConductor does (host.ts): the tail is the engine's bounded buffer; onTranscript filters the
    // engine's global stream to this project. The cross-process proofs run against these real accessors.
    transcriptTail: (agentId) => engine.transcriptTailSnapshot(projectId, agentId),
    onTranscript: (listener) =>
      engine.onTranscript((pid, agent, generation, chunk, offset) => {
        if (pid === projectId) listener(agent, generation, chunk, offset);
      }),
    reviewContext,
    deleteAgent: () => Promise.reject(new Error('operator-ipc-test: deleteAgent not wired here')),
    listArchive: () => Promise.resolve([]),
    restoreArchive: () =>
      Promise.reject(new Error('operator-ipc-test: restoreArchive not wired here')),
    purgeArchive: () => Promise.reject(new Error('operator-ipc-test: purgeArchive not wired here')),
  };
  return { router, control };
}

const EVIDENCE_SPEC_REF = 'spec:review-task#locked';
const EVIDENCE_FINGERPRINT = 'sha256:review-context-evidence';

function evidenceReviewContext(
  reviewId: string,
  overrides: Partial<Extract<ReviewContext, { kind: 'resolved' }>> = {},
): ReviewContext {
  return {
    kind: 'resolved',
    reviewId,
    branch: 'co/feature',
    target: 'main',
    scope: 'pr_merge',
    evidenceFingerprint: EVIDENCE_FINGERPRINT,
    diff: { kind: 'patch', patch: '@@ -1 +1 @@\n-old\n+new' },
    criteria: {
      kind: 'criteria',
      specRef: EVIDENCE_SPEC_REF,
      criteria: [{ text: 'change is reviewed', verify: 'pnpm test' }],
    },
    ...overrides,
  };
}

/**
 * Wire the engine→IPC transcript push EXACTLY as serveConductor (host.ts) does: forward each chunk the
 * control surface emits to `server.pushTranscript`. The cross-process push proofs use the REAL server +
 * the REAL client over a REAL socket — only this one production-identical wiring line lives in the test.
 */
function wireTranscriptPush(
  control: ConductorControlSurface,
  server: OperatorIpcServer,
): () => void {
  return control.onTranscript((agentId, generation, chunk, offset) =>
    server.pushTranscript(agentId, generation, chunk, offset),
  );
}

/** A short, private socket path (well under the ~108-char Unix limit), cleaned in afterEach. */
function makeSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-opsock-'));
  dataDirs.push(dir);
  return join(dir, 'control.sock');
}

/** Probe whether the sandbox can bind a Unix socket (some CI sandboxes refuse with EPERM). */
async function unixSocketsAvailable(socketPath: string): Promise<boolean> {
  mkdirSync(dirname(socketPath), { recursive: true });
  try {
    unlinkSync(socketPath);
  } catch {
    // Probe path did not exist.
  }
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPERM') resolve(false);
      else reject(error);
    });
    server.listen(socketPath, () => {
      server.close(() => {
        try {
          unlinkSync(socketPath);
        } catch {
          // Already removed.
        }
        resolve(true);
      });
    });
  });
}

/** Start an {@link OperatorIpcServer} over `control` + a fresh client facade on `socketPath`. */
async function startServer(
  control: ConductorControlSurface,
  projectId: ProjectId,
  socketPath: string,
  onError?: (error: unknown) => void,
): Promise<OperatorIpcServer> {
  const server = new OperatorIpcServer({
    control,
    projectId,
    socketPath,
    ...(onError != null ? { onError } : {}),
  });
  servers.push(server);
  await server.start();
  return server;
}

function makeClient(projectId: ProjectId, socketPath: string): OperatorIpcClient {
  const client = new OperatorIpcClient({ projectId, socketPath });
  clients.push(client);
  return client;
}

/** A controllable scheduler: captures the cadence callback so a test fires daemon beats by hand. */
class FakeScheduler implements IntervalScheduler {
  private callback: (() => void) | null = null;
  private handle: IntervalHandle | null = null;

  setInterval(callback: () => void): IntervalHandle {
    this.callback = callback;
    this.handle = {};
    return this.handle;
  }

  clearInterval(handle: IntervalHandle): void {
    if (handle === this.handle) this.callback = null;
  }

  fire(): void {
    this.callback?.();
  }
}

// ── AC-S11-1 — the headline cross-process proof ─────────────────────────────────
describe('AC-S11-1 — cross-process observe + control over a 0o600 operator-only socket', () => {
  it('observe() returns the live snapshot (roster ⊕ warm/outstanding/cost) across the socket', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd })); // WARM
    seedActionableMail(projectId, 'impl-x'); // 1 outstanding actionable item

    const { control } = makeControl(engine, projectId);
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    const obs = await client.observe();
    expect(obs.kind).toBe('live');
    if (obs.kind !== 'live') throw new Error('unreachable');
    const byId = new Map(obs.snapshot.agents.map((a) => [a.agentId, a]));

    // The WARM agent: hosted + its outstanding-mail count + role/parent/cost (the engine-only overlay).
    const x = byId.get('impl-x')!;
    expect(x.hosted).toBe(true);
    expect(x.outstandingMail).toBe(1);
    expect(x.role).toBe('implementer');
    expect(x.parent).toBe('lead-1');
    expect(typeof x.costUsd).toBe('number');

    // A COLD roster agent rides along (not hosted, nothing outstanding).
    const lead = byId.get('lead-1')!;
    expect(lead.hosted).toBe(false);
    expect(lead.outstandingMail).toBe(0);
  });

  it('pause/resume reach the daemon; a follow-up observe() reflects the change', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));

    const { router, control } = makeControl(engine, projectId);
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    await client.pause('impl-x');
    expect(router.isPaused('impl-x')).toBe(true); // the verb reached the daemon's live router
    const paused = await client.observe();
    expect(
      paused.kind === 'live' && paused.snapshot.agents.find((a) => a.agentId === 'impl-x')?.paused,
    ).toBe(true);

    await client.resume('impl-x');
    expect(router.isPaused('impl-x')).toBe(false);
    const resumed = await client.observe();
    expect(
      resumed.kind === 'live' &&
        resumed.snapshot.agents.find((a) => a.agentId === 'impl-x')?.paused,
    ).toBe(false);
  });

  it('stop reaches the daemon: the warm pane is killed and observe() shows it cold', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const { pane } = await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));
    let exited = false;
    pane.onExit(() => void (exited = true));

    const { router, control } = makeControl(engine, projectId);
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    await client.stop('impl-x');
    expect(exited).toBe(true); // engine.release kills the pane synchronously (before its await)
    expect(engine.isHosted(projectId, 'impl-x')).toBe(false);
    expect(router.isStopped('impl-x')).toBe(true);

    await router.drain(); // the async session-teardown tail
    expect(runningAgentIds(projectId)).not.toContain('impl-x');
    const after = await client.observe();
    expect(
      after.kind === 'live' && after.snapshot.agents.find((a) => a.agentId === 'impl-x')?.hosted,
    ).toBe(false);
  });

  it('unstick reaches the daemon: a STUCK agent is reverted + re-woken (observe shows it un-stuck)', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));

    const { router, control } = makeControl(engine, projectId);
    router.markStuck('impl-x'); // the watchdog escalation the operator will clear
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    const before = await client.observe();
    expect(
      before.kind === 'live' && before.snapshot.agents.find((a) => a.agentId === 'impl-x')?.stuck,
    ).toBe(true);

    await client.unstick('impl-x');
    expect(router.isStuck('impl-x')).toBe(false); // revertStuck + rewake reached the daemon (MNR #4)
    const after = await client.observe();
    expect(
      after.kind === 'live' && after.snapshot.agents.find((a) => a.agentId === 'impl-x')?.stuck,
    ).toBe(false);
  });

  it('the socket file is 0o600 operator-only and its directory is 0o700', async () => {
    const { projectId } = makeProject();
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    await startServer(control, projectId, socketPath);

    expect(statSync(socketPath).mode & 0o777).toBe(0o600); // operator-uid rw only, by OS permission
    expect(statSync(dirname(socketPath)).mode & 0o077).toBe(0); // private dir (no group/other access)
  });

  it('closes the listening socket if chmod fails after transport start', async () => {
    const { projectId } = makeProject();
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    const server = new OperatorIpcServer({
      control,
      projectId,
      socketPath,
      chmodSocket: () => {
        throw new Error('chmod failed in test');
      },
    });
    servers.push(server);

    await expect(server.start()).rejects.toThrow(/chmod failed in test/);
    await expect(OperatorIpcConnection.connect(socketPath)).rejects.toThrow();
  });

  it('daemon-down degrades reads to the static rollup and refuses control with a clear error', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    // No server is ever started on this socket — the Conductor is "down".
    const client = makeClient(projectId, socketPath);

    const obs = await client.observe();
    expect(obs.kind).toBe('static'); // hybrid read (D5): fell back to queryObservability
    if (obs.kind !== 'static') throw new Error('unreachable');
    expect(obs.reason).toBe('conductor-not-running');
    // The static snapshot is a real program-data read — the roster is present, never a hang.
    expect(obs.snapshot.agents.map((a) => a.agentId).sort()).toEqual(
      queryObservability(projectId)
        .agents.map((a) => a.agentId)
        .sort(),
    );
    expect(client.connected).toBe(false);

    // Control + writes need the socket: a clear, catchable error — never a crash (Principle 9).
    await expect(client.pause('impl-x')).rejects.toBeInstanceOf(ConductorUnavailableError);
    await expect(
      client.approve(1, { decision: 'approve', subject: 's', body: 'b' }),
    ).rejects.toBeInstanceOf(ConductorUnavailableError);
  });

  it('propagates a daemon-side handler error across the socket (not masked as unavailable)', async () => {
    const { projectId } = makeProject();
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    // steering a non-hosted agent fails loud on the daemon — the message must reach the operator.
    await expect(client.steer('ghost', { kind: 'interrupt' })).rejects.toThrow(/not hosted/i);
    expect(client.connected).toBe(true); // a handler error must not drop the connection
  });

  it('steer (answer) reaches the warm pane cross-process: the operator text + exactly one submit', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const { pane } = await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));

    const { control } = makeControl(engine, projectId);
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    const steerP = client.steer('impl-x', { kind: 'answer', text: 'use claude' });
    // Wait until the steer has crossed the socket and injectMail has written the text, then echo it
    // (the composer echo is what unblocks the exactly-one-submit path) — robust to socket timing.
    for (let i = 0; i < 50 && !pane.written.join('').includes('use claude'); i++) await tick();
    pane.emit('use claude');
    await steerP;

    expect(pane.written.join('')).toContain('use claude');
    expect(pane.written.filter((w) => w === CR)).toHaveLength(1); // exactly one submit
    expect(engine.isHosted(projectId, 'impl-x')).toBe(true); // steering never tears the pane down
  });

  it('steer (redirect) reaches the warm pane cross-process: the operator text + exactly one submit', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const { pane } = await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));

    const { control } = makeControl(engine, projectId);
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    const steerP = client.steer('impl-x', { kind: 'redirect', text: 'try a different approach' });
    for (let i = 0; i < 50 && !pane.written.join('').includes('try a different approach'); i++)
      await tick();
    pane.emit('try a different approach');
    await steerP;

    expect(pane.written.join('')).toContain('try a different approach');
    expect(pane.written.filter((w) => w === CR)).toHaveLength(1); // exactly one submit
    expect(engine.isHosted(projectId, 'impl-x')).toBe(true); // steering never tears the pane down
  });

  it('steer (interrupt) reaches the warm pane cross-process: exactly the provider ESC, no teardown', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const { pane } = await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));

    const { control } = makeControl(engine, projectId);
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    const before = pane.written.length;
    await client.steer('impl-x', { kind: 'interrupt' });

    expect(pane.written.slice(before)).toEqual([ESC]); // claude ⇒ ESC; no text, no submit
    expect(engine.isHosted(projectId, 'impl-x')).toBe(true); // steering never tears the pane down
  });
});

// ── Stage 15 §7: sendInput + resize cross-process over the operator IPC ──────────────────────────
describe('Stage 15 §7 — sendInput / resize: keystroke passthrough + PTY resize cross-process', () => {
  it('sendInput forwards raw data bytes to the warm pane cross-process', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const { pane } = await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));

    const { control } = makeControl(engine, projectId);
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    const before = pane.written.length;
    await client.sendInput('impl-x', 'hello\r');

    expect(pane.written.slice(before)).toEqual(['hello\r']);
    expect(engine.isHosted(projectId, 'impl-x')).toBe(true); // pane still warm
  });

  it('sendInput (non-hosted) fails loud: error crosses the socket, connection stays alive', async () => {
    const { projectId } = makeProject();
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    await expect(client.sendInput('ghost', 'x')).rejects.toThrow(/not hosted/i);
    expect(client.connected).toBe(true);
  });

  it('sendInput rejects bad data (non-string) with an error', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));
    const { control } = makeControl(engine, projectId);
    await startServer(control, projectId, socketPath);
    const rawConn = await OperatorIpcConnection.connect(socketPath);
    // Bypass the typed client to send a raw bad-payload call
    const raw = rawConn as unknown as { call: (m: string, p: unknown) => Promise<unknown> };
    const result = await raw
      .call('session:input', { agentId: 'impl-x', data: 42 })
      .catch((e: Error) => e.message);
    expect(String(result)).toMatch(/string/i);
    await rawConn.close();
  });

  it('resize resizes the warm PTY cross-process to the given dims', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));
    const pane = pty.panes[pty.panes.length - 1]!;

    const { control } = makeControl(engine, projectId);
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    await client.resize('impl-x', 120, 40);

    expect(pane.resizes).toEqual([[120, 40]]);
    expect(engine.isHosted(projectId, 'impl-x')).toBe(true); // pane still warm
  });

  it('resize (non-hosted) fails loud: error crosses the socket, connection stays alive', async () => {
    const { projectId } = makeProject();
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    await expect(client.resize('ghost', 120, 40)).rejects.toThrow(/not hosted/i);
    expect(client.connected).toBe(true);
  });

  it('resize rejects non-positive dims with an error', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));
    const { control } = makeControl(engine, projectId);
    await startServer(control, projectId, socketPath);
    const rawConn = await OperatorIpcConnection.connect(socketPath);
    const raw = rawConn as unknown as { call: (m: string, p: unknown) => Promise<unknown> };
    const badCols = await raw
      .call('session:resize', { agentId: 'impl-x', cols: -1, rows: 40 })
      .catch((e: Error) => e.message);
    expect(String(badCols)).toMatch(/positive integer/i);
    // rows must be validated independently of cols (both dimensions, not just the first).
    const badRows = await raw
      .call('session:resize', { agentId: 'impl-x', cols: 80, rows: 0 })
      .catch((e: Error) => e.message);
    expect(String(badRows)).toMatch(/positive integer/i);
    await rawConn.close();
  });
});

// ── Stage 12 C-P1 (TRANSCRIPT-SEAM) — the live transcript stream over the operator IPC ──
describe('AC-S12-4 — live transcript forwards hosted pane bytes cross-process (default client↔server path)', () => {
  it('bounds server-side transcript push backpressure by coalescing while a write is in flight', async () => {
    const { projectId } = makeProject();
    let releaseFirst!: () => void;
    const firstSend = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const sent: Array<{ method?: string; params?: unknown }> = [];
    const fakeTransport = {
      connected: true,
      send: vi.fn((message: { method?: string; params?: unknown }) => {
        sent.push(message);
        return sent.length === 1 ? firstSend : Promise.resolve();
      }),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
    };
    const staticSnapshot = { agents: [], plans: [], reviews: [], costRollups: [] };
    const fakeControl = {
      router: {} as DaemonBackedAgentRouter,
      observe: () => ({ snapshot: staticSnapshot, agents: [] }),
      transcriptTail: (agentId: string) => ({ agentId, generation: 0, offset: 0, tail: '' }),
      onTranscript: () => () => {},
      reviewContext: (reviewId: string) =>
        Promise.resolve({ kind: 'not-found' as const, reviewId }),
      deleteAgent: () => Promise.reject(new Error('operator-ipc-test: deleteAgent not wired here')),
      listArchive: () => Promise.resolve([]),
      restoreArchive: () =>
        Promise.reject(new Error('operator-ipc-test: restoreArchive not wired here')),
      purgeArchive: () =>
        Promise.reject(new Error('operator-ipc-test: purgeArchive not wired here')),
    } satisfies ConductorControlSurface;
    const server = new OperatorIpcServer({
      control: fakeControl,
      projectId,
      socketPath: '/tmp/not-used.sock',
    });
    Object.defineProperty(server, 'transport', { value: fakeTransport });

    server.pushTranscript('impl-x', 'one', 0);
    server.pushTranscript('impl-x', 'two', 3);
    server.pushTranscript('impl-x', 'three', 6);

    expect(fakeTransport.send).toHaveBeenCalledTimes(1);
    releaseFirst();
    await flush();

    expect(fakeTransport.send).toHaveBeenCalledTimes(2);
    expect(sent[1]).toMatchObject({
      method: 'transcript:push',
      params: { agentId: 'impl-x', offset: 3, chunk: 'twothree' },
    });
  });

  it('does not coalesce a pending transcript push across a same-agent offset reset', async () => {
    const { projectId } = makeProject();
    let releaseFirst!: () => void;
    const firstSend = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const sent: Array<{ method?: string; params?: unknown }> = [];
    const fakeTransport = {
      connected: true,
      send: vi.fn((message: { method?: string; params?: unknown }) => {
        sent.push(message);
        return sent.length === 1 ? firstSend : Promise.resolve();
      }),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
    };
    const staticSnapshot = { agents: [], plans: [], reviews: [], costRollups: [] };
    const fakeControl = {
      router: {} as DaemonBackedAgentRouter,
      observe: () => ({ snapshot: staticSnapshot, agents: [] }),
      transcriptTail: (agentId: string) => ({ agentId, generation: 0, offset: 0, tail: '' }),
      onTranscript: () => () => {},
      reviewContext: (reviewId: string) =>
        Promise.resolve({ kind: 'not-found' as const, reviewId }),
      deleteAgent: () => Promise.reject(new Error('operator-ipc-test: deleteAgent not wired here')),
      listArchive: () => Promise.resolve([]),
      restoreArchive: () =>
        Promise.reject(new Error('operator-ipc-test: restoreArchive not wired here')),
      purgeArchive: () =>
        Promise.reject(new Error('operator-ipc-test: purgeArchive not wired here')),
    } satisfies ConductorControlSurface;
    const server = new OperatorIpcServer({
      control: fakeControl,
      projectId,
      socketPath: '/tmp/not-used.sock',
    });
    Object.defineProperty(server, 'transport', { value: fakeTransport });

    server.pushTranscript('impl-x', 'old-in-flight', 0);
    server.pushTranscript('impl-x', 'old-pending', 'old-in-flight'.length);
    server.pushTranscript('impl-x', 'new-generation', 0);

    expect(fakeTransport.send).toHaveBeenCalledTimes(1);
    releaseFirst();
    await flush();

    expect(fakeTransport.send).toHaveBeenCalledTimes(2);
    expect(sent[1]).toMatchObject({
      method: 'transcript:push',
      params: { agentId: 'impl-x', offset: 0, chunk: 'new-generation' },
    });
  });

  it('bounds same-agent pending transcript backlog while a write is in flight', async () => {
    const { projectId } = makeProject();
    let releaseFirst!: () => void;
    const firstSend = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const sent: Array<{
      method?: string;
      params?: { agentId?: string; offset?: number; chunk?: string };
    }> = [];
    const fakeTransport = {
      connected: true,
      send: vi.fn((message: { method?: string; params?: unknown }) => {
        sent.push(message as (typeof sent)[number]);
        return sent.length === 1 ? firstSend : Promise.resolve();
      }),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
    };
    const staticSnapshot = { agents: [], plans: [], reviews: [], costRollups: [] };
    const fakeControl = {
      router: {} as DaemonBackedAgentRouter,
      observe: () => ({ snapshot: staticSnapshot, agents: [] }),
      transcriptTail: (agentId: string) => ({ agentId, generation: 0, offset: 0, tail: '' }),
      onTranscript: () => () => {},
      reviewContext: (reviewId: string) =>
        Promise.resolve({ kind: 'not-found' as const, reviewId }),
      deleteAgent: () => Promise.reject(new Error('operator-ipc-test: deleteAgent not wired here')),
      listArchive: () => Promise.resolve([]),
      restoreArchive: () =>
        Promise.reject(new Error('operator-ipc-test: restoreArchive not wired here')),
      purgeArchive: () =>
        Promise.reject(new Error('operator-ipc-test: purgeArchive not wired here')),
    } satisfies ConductorControlSurface;
    const server = new OperatorIpcServer({
      control: fakeControl,
      projectId,
      socketPath: '/tmp/not-used.sock',
    });
    Object.defineProperty(server, 'transport', { value: fakeTransport });

    const cap = 64 * 1024;
    server.pushTranscript('impl-x', 'first', 0);
    for (let i = 0; i < 10; i++) {
      server.pushTranscript('impl-x', String(i).repeat(cap), 'first'.length + i * cap);
    }

    expect(fakeTransport.send).toHaveBeenCalledTimes(1);
    releaseFirst();
    await flush(12);

    const pendingSends = sent.slice(1).filter((s) => s.params?.agentId === 'impl-x');
    const totalPendingBytes = pendingSends.reduce((n, s) => n + (s.params?.chunk?.length ?? 0), 0);
    expect(totalPendingBytes).toBeLessThanOrEqual(4 * cap);
    expect(pendingSends.at(0)?.params?.offset).toBe('first'.length + 6 * cap);
  });

  it('splits an over-cap direct transcript push without dropping replay-boundary bytes', async () => {
    const { projectId } = makeProject();
    const sent: Array<{
      method?: string;
      params?: { agentId?: string; offset?: number; chunk?: string };
    }> = [];
    const fakeTransport = {
      connected: true,
      send: vi.fn((message: { method?: string; params?: unknown }) => {
        sent.push(message as (typeof sent)[number]);
        return Promise.resolve();
      }),
      close: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
    };
    const staticSnapshot = { agents: [], plans: [], reviews: [], costRollups: [] };
    const fakeControl = {
      router: {} as DaemonBackedAgentRouter,
      observe: () => ({ snapshot: staticSnapshot, agents: [] }),
      transcriptTail: (agentId: string) => ({ agentId, generation: 0, offset: 0, tail: '' }),
      onTranscript: () => () => {},
      reviewContext: (reviewId: string) =>
        Promise.resolve({ kind: 'not-found' as const, reviewId }),
      deleteAgent: () => Promise.reject(new Error('operator-ipc-test: deleteAgent not wired here')),
      listArchive: () => Promise.resolve([]),
      restoreArchive: () =>
        Promise.reject(new Error('operator-ipc-test: restoreArchive not wired here')),
      purgeArchive: () =>
        Promise.reject(new Error('operator-ipc-test: purgeArchive not wired here')),
    } satisfies ConductorControlSurface;
    const server = new OperatorIpcServer({
      control: fakeControl,
      projectId,
      socketPath: '/tmp/not-used.sock',
    });
    Object.defineProperty(server, 'transport', { value: fakeTransport });

    const cap = 64 * 1024;
    const raw = ESC + '[?1049h' + 'A'.repeat(cap + 10);
    server.pushTranscript('impl-x', raw, 5);
    await flush();

    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      method: 'transcript:push',
      params: { agentId: 'impl-x', offset: 5, chunk: raw.slice(0, cap) },
    });
    expect(sent[1]).toMatchObject({
      method: 'transcript:push',
      params: { agentId: 'impl-x', offset: 5 + cap, chunk: raw.slice(cap) },
    });
  });

  it('push: a hosted pane chunk (ANSI/ESC bytes intact) reaches the SEPARATE client EXACTLY', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const { pane } = await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));

    const { control } = makeControl(engine, projectId);
    const server = await startServer(control, projectId, socketPath);
    wireTranscriptPush(control, server); // the one production-identical line (host.ts wires this)
    const client = makeClient(projectId, socketPath); // the DEFAULT facade: real connect + connection
    expect(await client.connect()).toBe(true);

    const got: OperatorIpcTranscript[] = [];
    client.onTranscript((t) => got.push(t));

    // A chunk carrying ANSI SGR + raw ESC control bytes (ESC via fromCharCode so the SOURCE is clean).
    const chunk = ESC + '[32mhi' + ESC + '[0m world';
    pane.emit(chunk);
    await flush();

    expect(got).toHaveLength(1);
    expect(got[0]!.agentId).toBe('impl-x');
    expect(got[0]!.offset).toBe(CLAUDE_READY.length);
    // EXACT same string cross-process — a serialization / default-derivation bug MUST fail here.
    expect(got[0]!.chunk).toBe(chunk);
    expect(client.connected).toBe(true);
  });

  it('raw connection isolates transcript listener failures so later subscribers still receive the push', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const { pane } = await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));
    const { control } = makeControl(engine, projectId);
    const server = await startServer(control, projectId, socketPath);
    wireTranscriptPush(control, server);
    const connection = await OperatorIpcConnection.connect(socketPath);
    try {
      const got: OperatorIpcTranscript[] = [];
      connection.onTranscript(() => {
        throw new Error('raw transcript listener failed');
      });
      connection.onTranscript((t) => got.push(t));

      pane.emit('hello');
      await flush();

      expect(got.map((t) => t.chunk)).toEqual(['hello']);
    } finally {
      await connection.close();
    }
  });

  it('tail/backfill: transcript() returns the concatenated emitted bytes across the real socket', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const { pane } = await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));

    const { control } = makeControl(engine, projectId);
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    const chunks = ['first ', ESC + '[1msecond' + ESC + '[0m ', 'third'];
    for (const c of chunks) pane.emit(c);

    // The request crosses the real socket; only the daemon-side engine holds the tail (the client has
    // no engine), so an agreeing result proves the round-trip — not a local stub.
    const tail = await client.transcript('impl-x');
    expect(client.connected).toBe(true);
    expect(tail.agentId).toBe('impl-x');
    expect(tail.offset).toBe(0);
    expect(tail.tail).toBe(CLAUDE_READY + chunks.join(''));
  });

  it('per-agent isolation: the push carries agentId — a B-filtered subscriber gets nothing when A emits', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const a = await hostPane(engine, pty, makeIdentity({ agent: 'impl-a', projectId, cwd }));
    await hostPane(engine, pty, makeIdentity({ agent: 'impl-b', projectId, cwd }));

    const { control } = makeControl(engine, projectId);
    const server = await startServer(control, projectId, socketPath);
    wireTranscriptPush(control, server);
    const client = makeClient(projectId, socketPath);
    expect(await client.connect()).toBe(true);

    const forA: OperatorIpcTranscript[] = [];
    const forB: OperatorIpcTranscript[] = [];
    client.onTranscript((t) => {
      if (t.agentId === 'impl-a') forA.push(t);
    });
    client.onTranscript((t) => {
      if (t.agentId === 'impl-b') forB.push(t);
    });

    a.pane.emit('hello from A');
    await flush();

    expect(forA.map((t) => t.chunk)).toEqual(['hello from A']);
    expect(forB).toHaveLength(0); // B's subscriber saw nothing — the stream is keyed by agentId
  });

  it('degrade + reconnect: transcript is empty while down, then the stream resumes after reconnect (Principle 9)', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const { pane } = await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));
    const { control } = makeControl(engine, projectId);

    // Register the listener while the daemon is DOWN (no server yet) — it must survive to reconnect.
    const got: OperatorIpcTranscript[] = [];
    const client = makeClient(projectId, socketPath);
    client.onTranscript((t) => got.push(t));

    // Down: transcript() degrades to an EMPTY tail; never hangs, never throws (Principle 9 / MNR #3).
    expect(await client.transcript('impl-x')).toEqual({
      agentId: 'impl-x',
      generation: 0,
      offset: 0,
      tail: '',
    });
    expect(client.connected).toBe(false);

    // Up: start the daemon on the same socket, wire the push, reconnect.
    const server = await startServer(control, projectId, socketPath);
    wireTranscriptPush(control, server);
    expect(await client.connect()).toBe(true);

    // A later pane chunk reaches the STILL-registered listener — the stream resumed across reconnect.
    pane.emit('resumed bytes');
    await flush();
    expect(got.map((t) => t.chunk)).toContain('resumed bytes');

    // And the on-demand tail is now live (no longer degraded).
    const tail = await client.transcript('impl-x');
    expect(tail.tail).toContain('resumed bytes');
  });

  it('facade isolates transcript listener failures so later UI subscribers still receive the push', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine, pty } = makeEngine(clock, qw);
    const { pane } = await hostPane(engine, pty, makeIdentity({ agent: 'impl-x', projectId, cwd }));
    const { control } = makeControl(engine, projectId);
    const server = await startServer(control, projectId, socketPath);
    wireTranscriptPush(control, server);
    const errors: unknown[] = [];
    const client = new OperatorIpcClient({ projectId, socketPath, onError: (e) => errors.push(e) });
    clients.push(client);
    const got: OperatorIpcTranscript[] = [];
    client.onTranscript(() => {
      throw new Error('facade transcript listener failed');
    });
    client.onTranscript((t) => got.push(t));
    expect(await client.connect()).toBe(true);

    pane.emit('facade bytes');
    await flush();

    expect(got.map((t) => t.chunk)).toEqual(['facade bytes']);
    expect(errors).toHaveLength(1);
  });
});

// ── MNR #2 — every write routes through the daemon (single writer) ────────────────
describe('MNR #2 — mail writes execute in the daemon process against the daemon store', () => {
  it('approve posts a structured approval_response through the daemon (app holds no store)', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    // Seed an outward approval addressed to @operator (operator-terminal by construction).
    const seedStore = openMailStore(projectId);
    let approval: DeliveredMail;
    try {
      approval = seedStore.send(
        outwardApprovalEnvelope({ from: 'coord-1', subject: 'publish?', body: 'bless the push' }),
      );
    } finally {
      seedStore.close();
    }

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    const delivered = await client.approve(approval.seq, {
      decision: 'approve',
      subject: 're: publish?',
      body: 'approved',
    });
    expect(delivered.type).toBe(MAIL_APPROVAL_RESPONSE);
    expect(delivered.decision).toBe('approve');

    // The write landed in the DAEMON's store (a fresh read sees it) and the gate now reads approved.
    const verify = openMailStore(projectId);
    mailStores.push(verify);
    const response = verify.inbox('coord-1').find((m) => m.type === MAIL_APPROVAL_RESPONSE);
    expect(response?.decision).toBe('approve');
    expect(approvalOutcome(verify, approval)).toBe('approved');
  });

  it('approve rejects an already-resolved approval without appending a second response', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const seedStore = openMailStore(projectId);
    let approval: DeliveredMail;
    try {
      approval = seedStore.send(
        outwardApprovalEnvelope({ from: 'coord-1', subject: 'publish?', body: 'bless the push' }),
      );
    } finally {
      seedStore.close();
    }

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    await client.approve(approval.seq, {
      decision: 'approve',
      subject: 'approved',
      body: 'yes',
    });

    await expect(
      client.approve(approval.seq, {
        decision: 'decline',
        subject: 'declined',
        body: 'no',
      }),
    ).rejects.toThrow(/already resolved/i);

    const verify = openMailStore(projectId);
    mailStores.push(verify);
    const responses = verify
      .inbox('coord-1')
      .filter((m) => m.type === MAIL_APPROVAL_RESPONSE && m.causationId === String(approval.seq));
    expect(responses).toHaveLength(1);
    expect(responses[0]?.decision).toBe('approve');
  });

  it('markRead records a read-receipt through the daemon (single writer — informational clears on view)', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    // Seed an informational mail addressed to @operator.
    const seedStore = openMailStore(projectId);
    let inform: DeliveredMail;
    try {
      inform = seedStore.send({
        type: 'chat',
        to: '@operator',
        from: 'lead-1',
        subject: 'hello',
        body: 'world',
      });
    } finally {
      seedStore.close();
    }
    expect(inform.read).toBeFalsy();

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    // Route markRead through the daemon — the app never writes the store directly (MNR #2).
    const after = await client.markRead('@operator', inform.seq);
    expect(after.read).toBe(true);

    // Verify via a fresh store read — the read-receipt was persisted by the daemon.
    const verify = openMailStore(projectId);
    mailStores.push(verify);
    const row = verify.inbox('@operator').find((m) => m.seq === inform.seq);
    expect(row?.read).toBe(true);
  });

  it('reply answers an actionable item through the daemon (resolves it, threads to the asker)', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    // impl-x asked lead-1 a clarify question — the operator answers it on lead-1's behalf.
    const ask = seedActionableMail(projectId, 'lead-1', 'impl-x');

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    const delivered = await client.reply(
      { seq: ask.seq, recipient: 'lead-1' },
      { type: 'clarify_response', subject: 're: do the thing', body: 'use claude' },
    );
    expect(delivered.type).toBe('clarify_response');

    // The reply (lead-1 → impl-x) is in impl-x's inbox, and the original ask is resolved (single writer).
    expect(inboxOf(projectId, 'impl-x').some((m) => m.type === 'clarify_response')).toBe(true);
    const lead = openMailStore(projectId);
    mailStores.push(lead);
    expect(lead.outstanding('lead-1')).toHaveLength(0);
  });

  it('operatorMessage posts an actionable clarify_request from @operator that an idle agent wakes on', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    // The operator messages the coordinator while it is idle/WAITING (no warm pane) — the path steer
    // cannot take. It must arrive as an actionable clarify_request from @operator so the daemon's
    // selectEligible wakes the recipient on its next tick.
    const delivered = await client.operatorMessage(
      'coord-1',
      'Operator message',
      'please fix the unstick bug',
    );
    expect(delivered.type).toBe('clarify_request');
    expect(delivered.sender).toBe('@operator');
    expect(delivered.recipient).toBe('coord-1');

    // It is an OUTSTANDING ACTIONABLE item in coord-1's inbox — exactly what wakes a waiting agent.
    const mail = openMailStore(projectId);
    mailStores.push(mail);
    expect(mail.outstanding('coord-1').some((m) => m.seq === delivered.seq)).toBe(true);
  });

  it('operatorMessage rejects an unregistered recipient before posting mail', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    await expect(client.operatorMessage('missing-agent', 'subject', 'body')).rejects.toThrow(
      /unknown|registered/i,
    );

    const mail = openMailStore(projectId);
    mailStores.push(mail);
    expect(mail.outstanding('missing-agent')).toEqual([]);
  });

  it('reply treats an exact same-key retry after resolution as idempotent', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const ask = seedActionableMail(projectId, 'lead-1', 'impl-x');

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);
    const draft = {
      type: 'clarify_response' as const,
      subject: 're: first',
      body: 'use claude',
      idempotencyKey: 'operator-ipc-reply:exact',
    };

    const first = await client.reply({ seq: ask.seq, recipient: 'lead-1' }, draft);
    const second = await client.reply({ seq: ask.seq, recipient: 'lead-1' }, draft);

    expect(second).toEqual(first);
    const responses = inboxOf(projectId, 'impl-x').filter(
      (m) => m.type === 'clarify_response' && m.causationId === String(ask.seq),
    );
    expect(responses).toHaveLength(1);
  });

  it('reply rejects reusing an idempotency key for a different unresolved target', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const firstAsk = seedActionableMail(projectId, 'lead-1', 'impl-x');
    const secondAsk = seedActionableMail(projectId, 'lead-1', 'impl-x');

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);
    const draft = {
      type: 'clarify_response' as const,
      subject: 're: first',
      body: 'use claude',
      idempotencyKey: 'operator-ipc-reply:reuse',
    };

    await client.reply({ seq: firstAsk.seq, recipient: 'lead-1' }, draft);

    await expect(client.reply({ seq: secondAsk.seq, recipient: 'lead-1' }, draft)).rejects.toThrow(
      /already answers mail/i,
    );

    const responses = inboxOf(projectId, 'impl-x').filter(
      (m) => m.type === 'clarify_response' && m.idempotencyKey === draft.idempotencyKey,
    );
    expect(responses).toHaveLength(1);
    expect(responses[0]?.causationId).toBe(String(firstAsk.seq));
    const lead = openMailStore(projectId);
    mailStores.push(lead);
    expect(lead.outstanding('lead-1').map((m) => m.seq)).toContain(secondAsk.seq);
  });

  it('reply rejects a non-actionable target without appending a response', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const seedStore = openMailStore(projectId);
    let info: DeliveredMail;
    try {
      info = seedStore.send({
        type: 'chat',
        to: 'lead-1',
        from: 'impl-x',
        subject: 'fyi',
        body: 'not actionable',
      });
    } finally {
      seedStore.close();
    }

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    await expect(
      client.reply(
        { seq: info.seq, recipient: 'lead-1' },
        { type: 'clarify_response', subject: 're: fyi', body: 'reply' },
      ),
    ).rejects.toThrow(/not actionable/i);

    const responses = inboxOf(projectId, 'impl-x').filter(
      (m) => m.type === 'clarify_response' && m.causationId === String(info.seq),
    );
    expect(responses).toHaveLength(0);
  });

  it('reply rejects an already-resolved target without appending a second response', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const ask = seedActionableMail(projectId, 'lead-1', 'impl-x');

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    await client.reply(
      { seq: ask.seq, recipient: 'lead-1' },
      { type: 'clarify_response', subject: 're: first', body: 'use claude' },
    );

    await expect(
      client.reply(
        { seq: ask.seq, recipient: 'lead-1' },
        { type: 'clarify_response', subject: 're: second', body: 'use codex' },
      ),
    ).rejects.toThrow(/already resolved/i);

    const responses = inboxOf(projectId, 'impl-x').filter(
      (m) => m.type === 'clarify_response' && m.causationId === String(ask.seq),
    );
    expect(responses).toHaveLength(1);
    expect(responses[0]?.body).toBe('use claude');
  });

  it('reply records review_response verdicts through the human-review path', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const reviews = openReviewStore(projectId);
    reviewStores.push(reviews);
    const seedStore = openMailStore(projectId);
    let request: DeliveredMail;
    try {
      request = seedStore.requestHumanReview(
        {
          type: 'review_request',
          to: '@operator',
          from: 'lead-review',
          subject: 'review requested',
          body: 'please review',
          idempotencyKey: 'review-request:rev-opipc-review',
        },
        {
          reviewId: 'rev-opipc-review',
          target: 'main',
          branch: 'co/feature',
          scope: 'pr_merge',
          requestedBy: 'lead-review',
          reviewerKind: 'human',
          specRefKind: 'criteria',
          specRefRef: EVIDENCE_SPEC_REF,
        },
      ).mail;
    } finally {
      seedStore.close();
    }

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId, (reviewId) =>
      Promise.resolve(evidenceReviewContext(reviewId)),
    );
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    const delivered = await client.reply(
      { seq: request.seq, recipient: '@operator' },
      {
        type: MAIL_REVIEW_RESPONSE,
        subject: 're: review requested',
        body: 'passes',
        reviewVerdict: 'PASS',
        reviewContextFingerprint: EVIDENCE_FINGERPRINT,
        idempotencyKey: 'operator-ipc-review-response:exact',
      },
    );

    expect(delivered.type).toBe(MAIL_REVIEW_RESPONSE);
    expect(delivered.reviewVerdict).toBe('PASS');
    expect(reviews.getVerdict('main', 'co/feature', 'pr_merge')?.verdict).toBe('PASS');
    const response = inboxOf(projectId, 'lead-review').find(
      (m) => m.type === MAIL_REVIEW_RESPONSE && m.causationId === String(request.seq),
    );
    expect(response?.reviewVerdict).toBe('PASS');
  });

  it('reply rejects review_response when locked criteria are unavailable', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const reviews = openReviewStore(projectId);
    reviewStores.push(reviews);
    const seedStore = openMailStore(projectId);
    let request: DeliveredMail;
    try {
      request = seedStore.requestHumanReview(
        {
          type: 'review_request',
          to: '@operator',
          from: 'lead-review',
          subject: 'review requested',
          body: 'please review',
          idempotencyKey: 'review-request:rev-opipc-review-no-spec',
        },
        {
          reviewId: 'rev-opipc-review-no-spec',
          target: 'main',
          branch: 'co/feature',
          scope: 'pr_merge',
          requestedBy: 'lead-review',
          reviewerKind: 'human',
          specRefKind: 'criteria',
          specRefRef: EVIDENCE_SPEC_REF,
        },
      ).mail;
    } finally {
      seedStore.close();
    }

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId, (reviewId) =>
      Promise.resolve(
        evidenceReviewContext(reviewId, {
          criteria: { kind: 'no-locked-spec' },
        }),
      ),
    );
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    await expect(
      client.reply(
        { seq: request.seq, recipient: '@operator' },
        {
          type: MAIL_REVIEW_RESPONSE,
          subject: 're: review requested',
          body: 'passes',
          reviewVerdict: 'PASS',
          reviewContextFingerprint: EVIDENCE_FINGERPRINT,
          idempotencyKey: 'operator-ipc-review-response:no-spec',
        },
      ),
    ).rejects.toThrow(/locked acceptance criteria|review evidence/i);

    expect(reviews.getVerdict('main', 'co/feature', 'pr_merge')).toBeUndefined();
    const responses = inboxOf(projectId, 'lead-review').filter(
      (m) => m.type === MAIL_REVIEW_RESPONSE,
    );
    expect(responses).toHaveLength(0);
  });

  it('reply rejects review_response when context criteria do not match the durable review request', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const reviews = openReviewStore(projectId);
    reviewStores.push(reviews);
    const seedStore = openMailStore(projectId);
    let request: DeliveredMail;
    try {
      request = seedStore.requestHumanReview(
        {
          type: 'review_request',
          to: '@operator',
          from: 'lead-review',
          subject: 'review requested',
          body: 'please review',
          idempotencyKey: 'review-request:rev-opipc-review-wrong-spec',
        },
        {
          reviewId: 'rev-opipc-review-wrong-spec',
          target: 'main',
          branch: 'co/feature',
          scope: 'pr_merge',
          requestedBy: 'lead-review',
          reviewerKind: 'human',
          specRefKind: 'criteria',
          specRefRef: EVIDENCE_SPEC_REF,
        },
      ).mail;
    } finally {
      seedStore.close();
    }

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId, (reviewId) =>
      Promise.resolve(
        evidenceReviewContext(reviewId, {
          criteria: {
            kind: 'criteria',
            specRef: 'spec:other-task#locked',
            criteria: [{ text: 'wrong task', verify: 'pnpm test' }],
          },
        }),
      ),
    );
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    await expect(
      client.reply(
        { seq: request.seq, recipient: '@operator' },
        {
          type: MAIL_REVIEW_RESPONSE,
          subject: 're: review requested',
          body: 'passes',
          reviewVerdict: 'PASS',
          reviewContextFingerprint: EVIDENCE_FINGERPRINT,
          idempotencyKey: 'operator-ipc-review-response:wrong-spec',
        },
      ),
    ).rejects.toThrow(/acceptance criteria|specRef|review evidence/i);

    expect(reviews.getVerdict('main', 'co/feature', 'pr_merge')).toBeUndefined();
    const responses = inboxOf(projectId, 'lead-review').filter(
      (m) => m.type === MAIL_REVIEW_RESPONSE,
    );
    expect(responses).toHaveLength(0);
  });

  it('reply rejects review_response when submitted review evidence fingerprint is stale', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const reviews = openReviewStore(projectId);
    reviewStores.push(reviews);
    const seedStore = openMailStore(projectId);
    let request: DeliveredMail;
    try {
      request = seedStore.requestHumanReview(
        {
          type: 'review_request',
          to: '@operator',
          from: 'lead-review',
          subject: 'review requested',
          body: 'please review',
          idempotencyKey: 'review-request:rev-opipc-review-stale-context',
        },
        {
          reviewId: 'rev-opipc-review-stale-context',
          target: 'main',
          branch: 'co/feature',
          scope: 'pr_merge',
          requestedBy: 'lead-review',
          reviewerKind: 'human',
          specRefKind: 'criteria',
          specRefRef: EVIDENCE_SPEC_REF,
        },
      ).mail;
    } finally {
      seedStore.close();
    }

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId, (reviewId) =>
      Promise.resolve(evidenceReviewContext(reviewId, { evidenceFingerprint: 'sha256:newer' })),
    );
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    await expect(
      client.reply(
        { seq: request.seq, recipient: '@operator' },
        {
          type: MAIL_REVIEW_RESPONSE,
          subject: 're: review requested',
          body: 'passes',
          reviewVerdict: 'PASS',
          reviewContextFingerprint: 'sha256:stale',
          idempotencyKey: 'operator-ipc-review-response:stale-context',
        },
      ),
    ).rejects.toThrow(/review evidence|fingerprint|stale/i);

    expect(reviews.getVerdict('main', 'co/feature', 'pr_merge')).toBeUndefined();
    const responses = inboxOf(projectId, 'lead-review').filter(
      (m) => m.type === MAIL_REVIEW_RESPONSE,
    );
    expect(responses).toHaveLength(0);
  });

  it('reply rejects review_response when the review diff is unavailable', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const reviews = openReviewStore(projectId);
    reviewStores.push(reviews);
    const seedStore = openMailStore(projectId);
    let request: DeliveredMail;
    try {
      request = seedStore.requestHumanReview(
        {
          type: 'review_request',
          to: '@operator',
          from: 'lead-review',
          subject: 'review requested',
          body: 'please review',
          idempotencyKey: 'review-request:rev-opipc-review-no-diff',
        },
        {
          reviewId: 'rev-opipc-review-no-diff',
          target: 'main',
          branch: 'co/feature',
          scope: 'pr_merge',
          requestedBy: 'lead-review',
          reviewerKind: 'human',
          specRefKind: 'criteria',
          specRefRef: EVIDENCE_SPEC_REF,
        },
      ).mail;
    } finally {
      seedStore.close();
    }

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId, (reviewId) =>
      Promise.resolve(
        evidenceReviewContext(reviewId, {
          diff: { kind: 'unavailable', reason: 'worktree-missing' },
        }),
      ),
    );
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    await expect(
      client.reply(
        { seq: request.seq, recipient: '@operator' },
        {
          type: MAIL_REVIEW_RESPONSE,
          subject: 're: review requested',
          body: 'passes',
          reviewVerdict: 'PASS',
          reviewContextFingerprint: EVIDENCE_FINGERPRINT,
          idempotencyKey: 'operator-ipc-review-response:no-diff',
        },
      ),
    ).rejects.toThrow(/diff|review evidence/i);

    expect(reviews.getVerdict('main', 'co/feature', 'pr_merge')).toBeUndefined();
    const responses = inboxOf(projectId, 'lead-review').filter(
      (m) => m.type === MAIL_REVIEW_RESPONSE,
    );
    expect(responses).toHaveLength(0);
  });

  it('reply treats exact review_response retries as idempotent and rejects changed verdicts', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const reviews = openReviewStore(projectId);
    reviewStores.push(reviews);
    const seedStore = openMailStore(projectId);
    let request: DeliveredMail;
    try {
      request = seedStore.requestHumanReview(
        {
          type: 'review_request',
          to: '@operator',
          from: 'lead-review',
          subject: 'review requested',
          body: 'please review',
          idempotencyKey: 'review-request:rev-opipc-review-retry',
        },
        {
          reviewId: 'rev-opipc-review-retry',
          target: 'main',
          branch: 'co/feature',
          scope: 'pr_merge',
          requestedBy: 'lead-review',
          reviewerKind: 'human',
          specRefKind: 'criteria',
          specRefRef: EVIDENCE_SPEC_REF,
        },
      ).mail;
    } finally {
      seedStore.close();
    }

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId, (reviewId) =>
      Promise.resolve(evidenceReviewContext(reviewId)),
    );
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);
    const draft = {
      type: MAIL_REVIEW_RESPONSE,
      subject: 're: review requested',
      body: 'passes',
      reviewVerdict: 'PASS' as const,
      reviewContextFingerprint: EVIDENCE_FINGERPRINT,
      idempotencyKey: 'operator-ipc-review-response:retry',
    };

    const first = await client.reply({ seq: request.seq, recipient: '@operator' }, draft);
    const second = await client.reply({ seq: request.seq, recipient: '@operator' }, draft);

    expect(second).toEqual(first);
    await expect(
      client.reply(
        { seq: request.seq, recipient: '@operator' },
        { ...draft, reviewVerdict: 'ISSUES' as const },
      ),
    ).rejects.toThrow(/review_verdict|review verdict|already resolved/i);
    const responses = inboxOf(projectId, 'lead-review').filter(
      (m) => m.type === MAIL_REVIEW_RESPONSE && m.idempotencyKey === draft.idempotencyKey,
    );
    expect(responses).toHaveLength(1);
    expect(responses[0]?.reviewVerdict).toBe('PASS');
  });
});

// ── MNR #3 — degrade then reconnect; the push stream resumes ─────────────────────
describe('MNR #3 — the per-tick push stream; a down→up daemon reconnects and resumes it', () => {
  it('pushes a snapshot per tick; a reconnect after the daemon restarts resumes the stream', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);

    const states: string[] = [];
    const ticks: OperatorIpcTick[] = [];
    const client = new OperatorIpcClient({
      projectId,
      socketPath,
      onState: (s) => states.push(s),
    });
    clients.push(client);
    client.onTick((t) => ticks.push(t));

    // Up #1: connect + a tick push arrives.
    const server1 = await startServer(control, projectId, socketPath);
    expect(await client.connect()).toBe(true);
    server1.pushTick(control.observe());
    await flush();
    expect(ticks).toHaveLength(1);
    expect(ticks[0]!.snapshot.agents.some((a) => a.agentId === 'lead-1')).toBe(true);

    // Down: the daemon stops → the client degrades; a read falls back to static, control refuses.
    await server1.close();
    await flush();
    expect(states).toContain('disconnected');
    expect((await client.observe()).kind).toBe('static');
    expect(client.connected).toBe(false);

    // Up #2: a fresh daemon on the same socket → reconnect → the push stream RESUMES.
    const server2 = await startServer(control, projectId, socketPath);
    expect(await client.connect()).toBe(true);
    server2.pushTick(control.observe());
    await flush();
    expect(ticks).toHaveLength(2); // the reconnect resumed the per-tick push (not a one-shot)
    expect(states.filter((s) => s === 'connected')).toHaveLength(2);
  });

  it('raw connection isolates tick listener failures so later subscribers still receive the push', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    const server = await startServer(control, projectId, socketPath);
    const connection = await OperatorIpcConnection.connect(socketPath);
    try {
      const ticks: OperatorIpcTick[] = [];
      connection.onTick(() => {
        throw new Error('raw tick listener failed');
      });
      connection.onTick((t) => ticks.push(t));

      server.pushTick(control.observe());
      await flush();

      expect(ticks).toHaveLength(1);
    } finally {
      await connection.close();
    }
  });

  it('raw connection isolates close listener failures so later subscribers still run', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    await startServer(control, projectId, socketPath);
    const connection = await OperatorIpcConnection.connect(socketPath);
    let sawSecondClose = false;
    connection.onClose(() => {
      throw new Error('raw close listener failed');
    });
    connection.onClose(() => {
      sawSecondClose = true;
    });

    await connection.close();
    await flush();

    expect(sawSecondClose).toBe(true);
  });

  it('client reconnects to the SAME running server after a client-side socket drop (app restart, daemon stays up)', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    const server = await startServer(control, projectId, socketPath);

    // Use the injectable `connect` seam for two roles:
    //   1. Capture the live OperatorIpcConnection so the test can close the client side without
    //      touching the server (simulates the app process exiting while `co-mcp serve` keeps running).
    //   2. Gate reconnection attempts via `allowReconnect` so that observe() degrades to static
    //      during the "dropped but server still up" window — proving the degraded-read path before
    //      re-enabling the seam for the explicit reconnect.
    let capturedConn: OperatorIpcConnection | null = null;
    let allowReconnect = true;
    const states: string[] = [];
    const ticks: OperatorIpcTick[] = [];
    const client = new OperatorIpcClient({
      projectId,
      socketPath,
      connect: async (path) => {
        if (!allowReconnect) throw new Error('reconnect gated for test');
        capturedConn = await OperatorIpcConnection.connect(path);
        return capturedConn;
      },
      onState: (s) => states.push(s),
    });
    clients.push(client);
    client.onTick((t) => ticks.push(t));

    // Connect and verify the push stream is live.
    expect(await client.connect()).toBe(true);
    server.pushTick(control.observe());
    await flush();
    expect(ticks).toHaveLength(1);

    // Force a client-side drop: close the client's connection while the server keeps listening.
    // Gate reconnection so that observe() degrades (the drop window before the app re-opens).
    allowReconnect = false;
    await capturedConn!.close();
    await flush();
    expect(states).toContain('disconnected');
    expect(client.connected).toBe(false);
    expect((await client.observe()).kind).toBe('static'); // degraded — connection gated

    // Re-open the gate and reconnect to the SAME still-running server.
    allowReconnect = true;
    expect(await client.connect()).toBe(true);
    server.pushTick(control.observe()); // same server instance, still accepting pushes
    await flush();
    expect(ticks).toHaveLength(2); // the push stream RESUMED on the same server (not a restart)
    expect(states.filter((s) => s === 'connected')).toHaveLength(2);
  });

  it('a tick push with no app attached is a silent no-op (never crashes the daemon)', async () => {
    const { projectId } = makeProject();
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    const errors: unknown[] = [];
    const server = await startServer(control, projectId, socketPath, (e) => errors.push(e));

    expect(() => server.pushTick(control.observe())).not.toThrow(); // no client connected
    await flush();
    expect(errors).toHaveLength(0);
  });

  it('facade isolates tick listener failures so later UI subscribers still receive the push', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    const server = await startServer(control, projectId, socketPath);
    const errors: unknown[] = [];
    const client = new OperatorIpcClient({ projectId, socketPath, onError: (e) => errors.push(e) });
    clients.push(client);
    const ticks: OperatorIpcTick[] = [];
    client.onTick(() => {
      throw new Error('facade tick listener failed');
    });
    client.onTick((t) => ticks.push(t));
    expect(await client.connect()).toBe(true);

    server.pushTick(control.observe());
    await flush();

    expect(ticks).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });
});

// ── serveConductor wiring — `co-mcp serve` starts the IPC server alongside the runner ─
describe('serveConductor wiring — the IPC server rides the cadence runner (push on tick, close on stop)', () => {
  it('a daemon beat pushes a snapshot to a connected app; runner.stop() closes the socket', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

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
      reconcileEvery: 1,
      operatorIpc: { socketPath },
    });
    runners.push(runner);

    // C-P1 — serveConductor wires the transcript accessors into the control surface from the engine
    // (an unknown agent has no warm pane → an empty tail; never a throw).
    expect(runner.control?.transcriptTail('impl-x')).toEqual({
      agentId: 'impl-x',
      generation: 0,
      offset: 0,
      tail: '',
    });

    const client = makeClient(projectId, socketPath);
    const ticks: OperatorIpcTick[] = [];
    client.onTick((t) => ticks.push(t));
    expect(await client.connect()).toBe(true);

    scheduler.fire(); // one daemon.tick → the runner's onTick → ipcServer.pushTick
    await flush();
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    expect(ticks[0]!.snapshot.agents.some((a) => a.agentId === 'lead-1')).toBe(true);

    await runner.stop(); // the onStop seam closes the IPC server (socket torn down)
    await flush();
    expect((await client.observe()).kind).toBe('static'); // the app degrades cleanly once co-mcp serve stops
  });

  it('still pushes an IPC tick when the caller onTick hook throws', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const scheduler = new FakeScheduler();
    const errors: unknown[] = [];
    const runner = await serveConductor({
      projectId,
      pty: new FakePty(),
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      scheduler,
      reconcileEvery: 1,
      onTick: () => {
        throw new Error('caller onTick failed');
      },
      onError: (error) => errors.push(error),
      operatorIpc: { socketPath },
    });
    runners.push(runner);

    const client = makeClient(projectId, socketPath);
    const ticks: OperatorIpcTick[] = [];
    client.onTick((t) => ticks.push(t));
    expect(await client.connect()).toBe(true);

    scheduler.fire();
    await flush();

    expect(ticks).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it('closes the IPC server if auto-start recovery fails after the socket starts', async () => {
    const { projectId, cwd } = makeProject();
    const sessions = openSessionStore(projectId);
    try {
      sessions.recordSession({
        agentId: 'impl-orphan',
        pane: 'pane-impl-orphan',
        cwd,
        provider: 'claude',
        resume: { provider: 'claude', sessionId: 'session-impl-orphan' },
      });
    } finally {
      sessions.close();
    }
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    await expect(
      serveConductor({
        projectId,
        pty: new FakePty(),
        makeTransport: () => InMemoryTransport.createLinkedPair(),
        now: clock.now,
        quietWindow: qw.quietWindow,
        scheduler: new FakeScheduler(),
        reconcileEvery: 1,
        operatorIpc: { socketPath },
      }),
    ).rejects.toThrow(/no roster record/i);

    await expect(OperatorIpcConnection.connect(socketPath)).rejects.toThrow();
  });
});

// ── AC-S11-6 — the surface invariant: ZERO agent MCP tools ───────────────────────
describe('AC-S11-6 — the operator IPC registers NO agent-facing MCP tool (Principle 4 + D4)', () => {
  it('no ipc/observe/control verb appears in the canonical agent tool registry; completeness stays green', () => {
    const names = buildCoreRegistry()
      .list()
      .map((t) => t.name.toLowerCase());

    // None of the operator-IPC verbs (nor "ipc"/"operator"/"tick") may be an agent-callable MCP tool.
    const forbidden = [
      'observe',
      'pause',
      'resume',
      'stop',
      'unstick',
      'steer',
      'reply',
      'approve',
      'tick',
      'transcript',
      'ipc',
      'operator',
    ];
    for (const verb of forbidden) {
      expect(names.some((n) => n.includes(verb))).toBe(false);
    }
    // The server + client are plain classes, not ToolSpecs — the completeness gate is green by construction.
    expect(checkToolCompleteness(buildCoreRegistry())).toEqual([]);
  });
});

// ── Connection lifecycle + diagnostics (review hardening, round 1) ───────────────
describe('operator-IPC client — close concurrency + unexpected-error diagnostics', () => {
  it('OperatorIpcConnection.close() is idempotent + concurrency-safe (in-flight calls still reject)', async () => {
    const { projectId } = makeProject();
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    await startServer(control, projectId, socketPath);

    const connection = await OperatorIpcConnection.connect(socketPath);
    // Two concurrent closes must both settle (the `closing` guard dedupes the single transport.close).
    await Promise.all([connection.close(), connection.close()]);
    await connection.close(); // a third, after-the-fact close is a no-op too
    // A call after close rejects clearly — never a hang (Principle 9).
    await expect(connection.observe()).rejects.toThrow(/closed/i);
  });

  it('observe() surfaces an UNEXPECTED daemon-side error to onError while still degrading to static', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    // A control surface whose observe() throws (a daemon-side fault, not a socket drop).
    const control: ConductorControlSurface = {
      router: new DaemonBackedAgentRouter({ engine, projectId }),
      observe: () => {
        throw new Error('observe boom in test');
      },
      transcriptTail: (agentId) => ({ agentId, generation: 0, offset: 0, tail: '' }),
      onTranscript: () => () => {},
      reviewContext: (reviewId) => Promise.resolve({ kind: 'not-found', reviewId }),
      deleteAgent: () => Promise.reject(new Error('operator-ipc-test: deleteAgent not wired here')),
      listArchive: () => Promise.resolve([]),
      restoreArchive: () =>
        Promise.reject(new Error('operator-ipc-test: restoreArchive not wired here')),
      purgeArchive: () =>
        Promise.reject(new Error('operator-ipc-test: purgeArchive not wired here')),
    };
    await startServer(control, projectId, socketPath);

    const errors: unknown[] = [];
    const client = new OperatorIpcClient({ projectId, socketPath, onError: (e) => errors.push(e) });
    clients.push(client);

    const obs = await client.observe();
    expect(obs.kind).toBe('static'); // still degrades — never hangs/throws
    expect(client.connected).toBe(true); // a handler error is NOT a socket drop; the connection survives
    expect(errors).toHaveLength(1); // the unexpected fault was SURFACED, not silently masked
    expect((errors[0] as Error).message).toMatch(/observe boom/i);
  });

  it('observe() surfaces unexpected connect failures instead of masking them as daemon-down', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId);
    const errors: unknown[] = [];
    const denied = Object.assign(new Error('permission denied connecting to operator socket'), {
      code: 'EACCES',
    });
    const client = new OperatorIpcClient({
      projectId,
      socketPath: '/tmp/co-opipc-denied.sock',
      connect: () => Promise.reject(denied),
      onError: (e) => errors.push(e),
    });
    clients.push(client);

    const obs = await client.observe();

    expect(obs.kind).toBe('static');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe(denied);
  });
});

// ── Wire robustness — the JSON-RPC envelope + unknown-method path ─────────────────
describe('operator-IPC wire — JSON-RPC envelope compatibility + unknown-method error', () => {
  it('answers an unknown method with a JSON-RPC error response over the strict-schema framing', async () => {
    const { projectId } = makeProject();
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    await startServer(control, projectId, socketPath);

    // A raw client transport (the reused framing) — proves our envelopes pass JSONRPCMessageSchema.
    const transport = new SocketClientTransport(socketPath);
    const got = new Promise<ReturnType<typeof classifyIncoming>>((resolve) => {
      transport.onmessage = (message) => resolve(classifyIncoming(message));
    });
    await transport.start();
    try {
      await transport.send(makeRequest(7, 'no_such_method', {}));
      const reply = await got;
      expect(reply.kind).toBe('error');
      if (reply.kind !== 'error') throw new Error('unreachable');
      expect(reply.id).toBe(7);
      expect(reply.error.message).toMatch(/unknown method/i);
    } finally {
      await transport.close();
    }
  });

  it('answers a known method with malformed params as JSON-RPC invalidParams', async () => {
    const { projectId } = makeProject();
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    await startServer(control, projectId, socketPath);

    const transport = new SocketClientTransport(socketPath);
    const got = new Promise<ReturnType<typeof classifyIncoming>>((resolve) => {
      transport.onmessage = (message) => resolve(classifyIncoming(message));
    });
    await transport.start();
    try {
      await transport.send(makeRequest(8, 'pause', {}));
      const reply = await got;
      expect(reply.kind).toBe('error');
      if (reply.kind !== 'error') throw new Error('unreachable');
      expect(reply.id).toBe(8);
      expect(reply.error.code).toBe(WIRE_ERROR.invalidParams);
      expect(reply.error.message).toMatch(/agentId/i);
    } finally {
      await transport.close();
    }
  });

  it('includes AggregateError inner messages in JSON-RPC internal errors', async () => {
    const { projectId } = makeProject();
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control: baseControl } = makeControl(engine, projectId);
    const control: ConductorControlSurface = {
      ...baseControl,
      deleteAgent: () =>
        Promise.reject(
          new AggregateError(
            [new Error('worktree remove failed'), new Error('branch delete failed')],
            'deleteAgent failed',
          ),
        ),
    };
    await startServer(control, projectId, socketPath);

    const transport = new SocketClientTransport(socketPath);
    const got = new Promise<ReturnType<typeof classifyIncoming>>((resolve) => {
      transport.onmessage = (message) => resolve(classifyIncoming(message));
    });
    await transport.start();
    try {
      await transport.send(makeRequest(9, 'deleteAgent', { agentId: 'coord-x' }));
      const reply = await got;
      expect(reply.kind).toBe('error');
      if (reply.kind !== 'error') throw new Error('unreachable');
      expect(reply.id).toBe(9);
      expect(reply.error.code).toBe(WIRE_ERROR.internalError);
      expect(reply.error.message).toContain('deleteAgent failed');
      expect(reply.error.message).toContain('worktree remove failed');
      expect(reply.error.message).toContain('branch delete failed');
    } finally {
      await transport.close();
    }
  });
});

// ── Stage 13 R-A — reviewContext across the PRODUCTION wire ─────────────────────────────────────
//
// The default-path agreement proof (memory: "Test the default path, not just seams"): the REAL
// OperatorIpcServer + a REAL client facade over a REAL Unix socket, the control surface's
// reviewContext running the REAL resolveReviewContext over REAL seeded stores + a REAL temp git repo.
// This exercises the production serialization + wire that seam-only tests miss.

/** Deterministic git in a throwaway repo (no global identity / signing needed; stderr silenced). */
function reviewRepoGit(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.email=t@example.com',
      '-c',
      'user.name=Test',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim();
}

/** A real temp git repo: a base commit on `main`, a MARKED change committed on `co/feature`. */
function makeReviewRepo(): { dir: string; branch: string; target: string; baseSha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'co-rc-repo-'));
  dataDirs.push(dir); // cleaned in afterEach (rmSync)
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  writeFileSync(join(dir, 'file.txt'), 'base\n');
  reviewRepoGit(dir, 'add', '.');
  reviewRepoGit(dir, 'commit', '-m', 'base');
  const baseSha = reviewRepoGit(dir, 'rev-parse', 'HEAD');
  reviewRepoGit(dir, 'checkout', '-b', 'co/feature');
  writeFileSync(join(dir, 'file.txt'), 'base\nREVIEW_CONTEXT_MARKER\n');
  reviewRepoGit(dir, 'add', '.');
  reviewRepoGit(dir, 'commit', '-m', 'feature change');
  return { dir, branch: 'co/feature', target: 'main', baseSha };
}

const REVIEW_CRITERIA = [
  { text: 'expired tokens rejected (401)', verify: 'pnpm vitest run packages/core/x' },
  { text: 'no silent failures' },
] as const;

/** Seed a locked spec, the recorded worktree, and a human review request (criteria spec-ref). */
function seedReviewContext(
  projectId: ProjectId,
  opts: {
    readonly reviewId: string;
    readonly taskId: string;
    readonly repoDir: string;
    readonly branch: string;
    readonly target: string;
    readonly baseSha: string;
  },
): void {
  const specs = openSpecStore(projectId);
  try {
    specs.recordDraft({
      taskId: opts.taskId,
      title: 'Stage 13 R-A',
      goal: 'ship reviewContext',
      criteria: [...REVIEW_CRITERIA],
      body: '',
      actor: 'lead-1',
    });
    specs.recordLock(opts.taskId, OPERATOR);
  } finally {
    specs.close();
  }

  const worktrees = openWorktreeStore(projectId);
  try {
    worktrees.recordWorktree({
      branch: opts.branch,
      baseRef: opts.target,
      baseSha: opts.baseSha,
      path: opts.repoDir,
      parent: 'lead-1',
    });
  } finally {
    worktrees.close();
  }

  const mail = openMailStore(projectId);
  try {
    // The production recorder: review.requested + actionable mail commit atomically (single writer).
    mail.requestHumanReview(
      {
        type: MAIL_REVIEW_REQUEST,
        to: OPERATOR,
        from: 'lead-1',
        subject: `review requested: '${opts.branch}' into '${opts.target}'`,
        body: `Please review. (scope: pr_merge, reviewId: ${opts.reviewId})`,
        idempotencyKey: `review-request:${opts.reviewId}`,
      },
      {
        reviewId: opts.reviewId,
        target: opts.target,
        branch: opts.branch,
        requestedBy: 'lead-1',
        scope: 'pr_merge',
        reviewerKind: 'human',
        specRefKind: 'criteria',
        specRefRef: `spec:${opts.taskId}#locked`,
      },
    );
  } finally {
    mail.close();
  }
}

/** The production daemon-side accessor: resolveReviewContext over real per-call stores + real git. */
function realReviewContext(projectId: ProjectId): ConductorControlSurface['reviewContext'] {
  return (reviewId) =>
    resolveReviewContext(
      {
        openReviews: () => openReviewStore(projectId),
        openSpecs: () => openSpecStore(projectId),
        openWorktrees: () => openWorktreeStore(projectId),
        gitReader: defaultGitRawReader,
      },
      reviewId,
    );
}

describe('Stage 13 R-A — reviewContext over the default socket (client↔server agreement)', () => {
  it('resolved: the real diff + criteria + branch/target/scope round-trip across the production wire', async () => {
    const { projectId } = makeProject();
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const repo = makeReviewRepo();
    const reviewId = 'rev-s13-ra';
    const taskId = 'task-s13-ra';
    seedReviewContext(projectId, {
      reviewId,
      taskId,
      repoDir: repo.dir,
      branch: repo.branch,
      target: repo.target,
      baseSha: repo.baseSha,
    });

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId, realReviewContext(projectId));
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    const result = await client.reviewContext(reviewId);

    expect(result.kind).toBe('resolved');
    if (result.kind !== 'resolved') throw new Error(`expected resolved, got ${result.kind}`);
    expect(result.reviewId).toBe(reviewId);
    expect(result.branch).toBe(repo.branch);
    expect(result.target).toBe(repo.target);
    expect(result.scope).toBe('pr_merge');
    // The REAL unified diff — computed `git diff main...co/feature` in the seeded sandbox.
    expect(result.diff.kind).toBe('patch');
    if (result.diff.kind === 'patch') {
      expect(result.diff.patch).toContain('REVIEW_CONTEXT_MARKER');
      expect(result.diff.patch).toContain('diff --git');
    }
    // The REAL acceptance criteria, sourced from the locked spec record, serialized intact.
    expect(result.criteria).toEqual({
      kind: 'criteria',
      specRef: `spec:${taskId}#locked`,
      criteria: [...REVIEW_CRITERIA],
    });
  });

  it('degrade: a client with NO server returns the named conductor-down state (never hangs/throws)', async () => {
    const { projectId } = makeProject();
    const socketPath = makeSocketPath(); // nothing is listening here
    const client = makeClient(projectId, socketPath);

    expect(await client.reviewContext('rev-absent')).toEqual({
      kind: 'conductor-down',
      reviewId: 'rev-absent',
    });
  });
});

// ── Stage 14 P4 — startSession over the operator-IPC wire ───────────────────────
describe('AC-S14-4 — startSession over the operator-IPC wire (operator-only, never an agent tool)', () => {
  // A canned registry that resolves to the test project's cwd (avoids needing a live registry file).
  function makeOpenRegistryFn(projectId: string, cwd: string): () => ProjectRegistry {
    return () => {
      const reg = openRegistry();
      registries.push(reg);
      // Override pathFor to return the test cwd for our projectId.
      return {
        ...reg,
        pathFor: (pid: string) => (pid === projectId ? cwd : reg.pathFor(pid)),
      };
    };
  }

  it('startSession round-trips: the result flows back across the socket and startFn receives the right params', async () => {
    const { projectId, cwd } = makeProject();
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const fakeResult = {
      coordinator: `coord-root-test`,
      worktreePath: '/tmp/fake/worktree',
      branch: 'co/coord-root-test',
      baseRef: 'main',
      baseSha: 'abc1234',
    };
    const startCalls: Array<{
      projectId: string;
      repoCwd: string;
      name?: string;
      coordinatorId?: string;
      prompt?: string;
      specBody?: string;
    }> = [];
    const startFn: typeof startCoordinatorSession = (params) => {
      startCalls.push({
        projectId: params.projectId,
        repoCwd: params.repoCwd,
        name: params.name,
        coordinatorId: params.coordinatorId,
        prompt: params.prompt,
        specBody: params.specBody,
      });
      return fakeResult;
    };

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    const server = new OperatorIpcServer({
      control,
      projectId,
      socketPath,
      openRegistryFn: makeOpenRegistryFn(projectId, cwd),
      startFn,
    });
    servers.push(server);
    await server.start();
    const client = makeClient(projectId, socketPath);

    const result = await client.startSession({
      name: 'new feature',
      prompt: 'orchestrate the new feature',
    });

    expect(result).toEqual(fakeResult);
    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]).toMatchObject({
      projectId,
      repoCwd: cwd,
      name: 'new feature',
      prompt: 'orchestrate the new feature',
    });
    // The server mints a name-derived coordinatorId — just verify shape (hex suffix varies).
    expect(startCalls[0]?.coordinatorId).toMatch(/^coord-new-feature-[0-9a-f]{6}$/);
    expect(startCalls[0]?.specBody).toBeUndefined();
  });

  it('startSession with specBody: the specBody flows to the startFn (not prompt)', async () => {
    const { projectId, cwd } = makeProject();
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const fakeResult = {
      coordinator: 'coord-root-spec',
      worktreePath: '/tmp/wt',
      branch: 'co/b',
      baseRef: 'main',
      baseSha: 'def',
    };
    const startCalls: Array<{ name?: string; prompt?: string; specBody?: string }> = [];
    const startFn: typeof startCoordinatorSession = (params) => {
      startCalls.push({ name: params.name, prompt: params.prompt, specBody: params.specBody });
      return fakeResult;
    };

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    const server = new OperatorIpcServer({
      control,
      projectId,
      socketPath,
      openRegistryFn: makeOpenRegistryFn(projectId, cwd),
      startFn,
    });
    servers.push(server);
    await server.start();
    const client = makeClient(projectId, socketPath);

    const result = await client.startSession({
      name: 'draft spec task',
      specBody: '# spec\n\n- Do the thing',
    });

    expect(result).toEqual(fakeResult);
    expect(startCalls[0]).toMatchObject({
      name: 'draft spec task',
      specBody: '# spec\n\n- Do the thing',
    });
    expect(startCalls[0]?.prompt).toBeUndefined();
  });

  it('exactly-one-of: both prompt and specBody → InvalidParams error across the socket', async () => {
    const { projectId, cwd } = makeProject();
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    const server = new OperatorIpcServer({
      control,
      projectId,
      socketPath,
      openRegistryFn: makeOpenRegistryFn(projectId, cwd),
      startFn: () => {
        throw new Error('should not reach startFn');
      },
    });
    servers.push(server);
    await server.start();
    const client = makeClient(projectId, socketPath);

    await expect(
      client.startSession({ name: 'my coord', prompt: 'a prompt', specBody: 'a spec' }),
    ).rejects.toThrow(/exactly one/i);
  });

  it('exactly-one-of: neither prompt nor specBody → InvalidParams error across the socket', async () => {
    const { projectId, cwd } = makeProject();
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    const server = new OperatorIpcServer({
      control,
      projectId,
      socketPath,
      openRegistryFn: makeOpenRegistryFn(projectId, cwd),
      startFn: () => {
        throw new Error('should not reach startFn');
      },
    });
    servers.push(server);
    await server.start();
    const client = makeClient(projectId, socketPath);

    // Neither prompt nor specBody supplied (both undefined/empty).
    await expect(client.startSession({ name: 'my coord' })).rejects.toThrow(/exactly one/i);
  });

  it('startSession name: the coordinator id encodes the slug with a 6-hex suffix', async () => {
    // B4: the server mints a name-derived coordinator id from coordinatorIdFromParts(name, randomHex).
    const { projectId, cwd } = makeProject();
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const startCalls: Array<{ coordinatorId?: string; name?: string }> = [];
    const startFn: typeof startCoordinatorSession = (params) => {
      startCalls.push({ coordinatorId: params.coordinatorId, name: params.name });
      // Return the coordinator id the server minted (pass it through so the client sees it).
      return {
        coordinator: params.coordinatorId ?? 'coord-unknown',
        worktreePath: '/tmp/wt',
        branch: `co/${params.coordinatorId ?? 'coord-unknown'}`,
        baseRef: 'main',
        baseSha: 'abc',
      };
    };

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    const server = new OperatorIpcServer({
      control,
      projectId,
      socketPath,
      openRegistryFn: makeOpenRegistryFn(projectId, cwd),
      startFn,
    });
    servers.push(server);
    await server.start();
    const client = makeClient(projectId, socketPath);

    const res = await client.startSession({ name: 'auth refactor', prompt: 'do the thing' });

    // The coordinator id encodes the name-slug + a 6-hex entropy suffix.
    expect(res.coordinator).toMatch(/^coord-auth-refactor-[0-9a-f]{6}$/);
    expect(startCalls[0]?.coordinatorId).toMatch(/^coord-auth-refactor-[0-9a-f]{6}$/);
    expect(startCalls[0]?.name).toBe('auth refactor');
  });

  it('startSession re-rolls the coordinator id when the first suffix collides with the roster', async () => {
    const { projectId, cwd } = makeProject();
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const startCalls: Array<{ coordinatorId?: string; name?: string }> = [];
    const startFn: typeof startCoordinatorSession = (params) => {
      startCalls.push({ coordinatorId: params.coordinatorId, name: params.name });
      return {
        coordinator: params.coordinatorId ?? 'coord-unknown',
        worktreePath: '/tmp/wt',
        branch: `co/${params.coordinatorId ?? 'coord-unknown'}`,
        baseRef: 'main',
        baseSha: 'abc',
      };
    };
    const suffixes = ['aaaaaa', 'bbbbbb'];

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    const deps = {
      control,
      projectId,
      socketPath,
      openRegistryFn: makeOpenRegistryFn(projectId, cwd),
      openRoster: () =>
        ({
          getAgent: (agentId: string) =>
            agentId === 'coord-auth-refactor-aaaaaa'
              ? { agentId, role: 'coordinator', parent: '@operator' }
              : undefined,
          close: () => {},
        }) as unknown as RosterStore,
      randomHex: () => suffixes.shift() ?? 'cccccc',
      startFn,
    } satisfies OperatorIpcServerDeps & {
      openRoster: () => RosterStore;
      randomHex: () => string;
    };
    const server = new OperatorIpcServer(deps);
    servers.push(server);
    await server.start();
    const client = makeClient(projectId, socketPath);

    const res = await client.startSession({ name: 'auth refactor', prompt: 'do the thing' });

    expect(res.coordinator).toBe('coord-auth-refactor-bbbbbb');
    expect(startCalls).toEqual([
      { coordinatorId: 'coord-auth-refactor-bbbbbb', name: 'auth refactor' },
    ]);
  });

  it('startSession trims the coordinator name before minting and starting', async () => {
    const { projectId, cwd } = makeProject();
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const startCalls: Array<{ coordinatorId?: string; name?: string }> = [];
    const startFn: typeof startCoordinatorSession = (params) => {
      startCalls.push({ coordinatorId: params.coordinatorId, name: params.name });
      return {
        coordinator: params.coordinatorId ?? 'coord-unknown',
        worktreePath: '/tmp/wt',
        branch: `co/${params.coordinatorId ?? 'coord-unknown'}`,
        baseRef: 'main',
        baseSha: 'abc',
      };
    };

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    const server = new OperatorIpcServer({
      control,
      projectId,
      socketPath,
      openRegistryFn: makeOpenRegistryFn(projectId, cwd),
      randomHex: () => 'aaaaaa',
      startFn,
    });
    servers.push(server);
    await server.start();
    const client = makeClient(projectId, socketPath);

    const res = await client.startSession({ name: '  auth refactor  ', prompt: 'do the thing' });

    expect(res.coordinator).toBe('coord-auth-refactor-aaaaaa');
    expect(startCalls).toEqual([
      { coordinatorId: 'coord-auth-refactor-aaaaaa', name: 'auth refactor' },
    ]);
  });

  it('startSession rejects whitespace-only names before calling the start primitive', async () => {
    const { projectId, cwd } = makeProject();
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    let calledStart = false;
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    const server = new OperatorIpcServer({
      control,
      projectId,
      socketPath,
      openRegistryFn: makeOpenRegistryFn(projectId, cwd),
      startFn: () => {
        calledStart = true;
        throw new Error('should not reach startFn');
      },
    });
    servers.push(server);
    await server.start();
    const client = makeClient(projectId, socketPath);

    await expect(client.startSession({ name: '   ', prompt: 'something' })).rejects.toThrow(
      /name/i,
    );
    expect(calledStart).toBe(false);
  });

  it('startSession without name → InvalidParams (name is runtime-required)', async () => {
    const { projectId, cwd } = makeProject();
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control } = makeControl(engine, projectId);
    const server = new OperatorIpcServer({
      control,
      projectId,
      socketPath,
      openRegistryFn: makeOpenRegistryFn(projectId, cwd),
      startFn: () => {
        throw new Error('should not reach startFn');
      },
    });
    servers.push(server);
    await server.start();
    const client = makeClient(projectId, socketPath);

    // Bypass the typed client (name is optional at the type level) to exercise the runtime guard.
    const raw = client as unknown as {
      startSession: (p: Record<string, unknown>) => Promise<unknown>;
    };
    await expect(raw.startSession({ prompt: 'something' })).rejects.toThrow(/name/i);
  });
});

// ── B4: deleteAgent + rewake IPC verbs ───────────────────────────────────────
describe('B4 — deleteAgent + rewake operator-IPC verbs', () => {
  it('deleteAgent dispatches end-to-end: control.deleteAgent is called with the right agentId', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);

    // Wire a recording deleteAgent into the control surface so we can assert dispatch.
    const deletedAgentIds: string[] = [];
    const { router, control: baseControl } = makeControl(engine, projectId);
    const control: ConductorControlSurface = {
      ...baseControl,
      deleteAgent: (agentId) => {
        deletedAgentIds.push(agentId);
        return Promise.resolve();
      },
    };

    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    await client.deleteAgent('impl-x');

    expect(deletedAgentIds).toEqual(['impl-x']);
    // The connection must survive a successful control verb.
    expect(client.connected).toBe(true);

    // Suppress unused-variable warning for the router that `makeControl` returns.
    void router;
  });

  it('rewake clears suppression and posts an actionable clarify_request from @operator', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId);
    const roster = openRosterStore(projectId);
    rosterStores.push(roster);
    roster.recordAgent({ agentId: 'impl-x', role: 'implementer', parent: 'lead-1' });
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { router, control } = makeControl(engine, projectId);

    // Suppress the agent (stopped + paused so unstop must clear both).
    router.stop('impl-x');
    router.pause('impl-x');
    expect(router.isStopped('impl-x')).toBe(true);

    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    const delivered = await client.rewake('impl-x', 'address PR review comments');

    // unstop cleared all suppression sets.
    expect(router.isStopped('impl-x')).toBe(false);
    expect(router.isPaused('impl-x')).toBe(false);

    // A clarify_request from @operator landed in impl-x's inbox.
    expect(delivered.type).toBe('clarify_request');
    expect(delivered.sender).toBe('@operator');
    expect(delivered.recipient).toBe('impl-x');
    expect(delivered.body).toBe('address PR review comments');

    // Verify the mail is outstanding (actionable) in the daemon's store.
    const mail = openMailStore(projectId);
    mailStores.push(mail);
    expect(mail.outstanding('impl-x').some((m) => m.seq === delivered.seq)).toBe(true);
  });

  it('rewake rejects whitespace-only messages before clearing suppression or posting mail', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId);
    const roster = openRosterStore(projectId);
    rosterStores.push(roster);
    roster.recordAgent({ agentId: 'impl-x', role: 'implementer', parent: 'lead-1' });
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { router, control } = makeControl(engine, projectId);
    router.stop('impl-x');
    router.pause('impl-x');

    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    await expect(client.rewake('impl-x', '   ')).rejects.toThrow(/message|non-empty/i);
    expect(router.isStopped('impl-x')).toBe(true);
    expect(router.isPaused('impl-x')).toBe(true);

    const mail = openMailStore(projectId);
    mailStores.push(mail);
    expect(mail.outstanding('impl-x')).toEqual([]);
  });

  it('rewake rejects unknown agents before posting mail', async () => {
    const { projectId } = makeProject();
    seedParentChain(projectId);
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { router, control } = makeControl(engine, projectId);

    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    await expect(client.rewake('missing-agent', 'wake up')).rejects.toThrow(/unknown|registered/i);
    expect(router.isStopped('missing-agent')).toBe(false);

    const mail = openMailStore(projectId);
    mailStores.push(mail);
    expect(mail.outstanding('missing-agent')).toEqual([]);
  });
});

// ── B5: listArchive / restoreArchive / purgeArchive operator-IPC verbs ───────────────────────────
describe('B5 — listArchive / restoreArchive / purgeArchive operator-IPC verbs', () => {
  /** Seed one archive record; returns the record's id + branch. */
  function seedArchiveRecord(
    projectId: ProjectId,
    opts: { id: string; branch: string },
  ): { id: string; branch: string } {
    const archive = openArchiveStore(projectId);
    try {
      archive.appendRecord({
        id: opts.id,
        name: `coord-${opts.id}`,
        branch: opts.branch,
        baseRef: 'main',
        deletedAt: Date.now(),
        expiresAt: Date.now() + 86_400_000,
      });
    } finally {
      archive.close();
    }
    return opts;
  }

  it('listArchive returns a seeded record cross-process (id/branch/expiresAt present)', async () => {
    const { projectId } = makeProject();
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const { id, branch } = seedArchiveRecord(projectId, {
      id: 'coord-archive-1',
      branch: 'co/coord-archive-1',
    });

    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control: baseControl } = makeControl(engine, projectId);
    // Wire the REAL listArchive (reads from the actual store) so the cross-process proof exercises
    // the full stack — not the stub that makeControl inserts (which always returns []).
    const control: ConductorControlSurface = {
      ...baseControl,
      listArchive: async () => {
        const archive = openArchiveStore(projectId);
        try {
          return archive.listRecords().map((r) => ({
            id: r.id,
            name: r.name,
            branch: r.branch,
            baseRef: r.baseRef,
            deletedAt: r.deletedAt,
            expiresAt: r.expiresAt,
          }));
        } finally {
          archive.close();
        }
      },
    };
    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    const entries = await client.listArchive();

    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe(id);
    expect(entries[0]?.branch).toBe(branch);
    expect(typeof entries[0]?.expiresAt).toBe('number');
    // The remaining wire fields must also survive the round-trip — a silent field-drop is caught here.
    expect(entries[0]?.name).toBe(`coord-${id}`); // the name seedArchiveRecord wrote
    expect(entries[0]?.baseRef).toBe('main'); // the baseRef seedArchiveRecord wrote
    expect(typeof entries[0]?.deletedAt).toBe('number');
    expect(client.connected).toBe(true);
  });

  it('listArchive reads the static archive store when the Conductor socket is down (READ/degrade)', async () => {
    const { projectId } = makeProject();
    const socketPath = makeSocketPath(); // nothing listening here
    const { id, branch } = seedArchiveRecord(projectId, {
      id: 'coord-archive-down',
      branch: 'co/coord-archive-down',
    });

    const client = makeClient(projectId, socketPath);
    const entries = await client.listArchive();

    expect(entries.map((e) => e.id)).toEqual([id]);
    expect(entries[0]?.branch).toBe(branch);
    expect(client.connected).toBe(false);
  });

  it('restoreArchive removes the archive record (branch stays; no git delete) cross-process', async () => {
    const { projectId } = makeProject();
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const { id } = seedArchiveRecord(projectId, {
      id: 'coord-restore-1',
      branch: 'co/coord-restore-1',
    });

    // Inject a gitExec spy to verify NO branch -D is issued during restoreArchive.
    const gitCalls: string[][] = [];
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    // Build a control with a restoreArchive that records git calls.
    const { control: baseControl } = makeControl(engine, projectId);
    const control: ConductorControlSurface = {
      ...baseControl,
      restoreArchive: async (archiveId: string): Promise<void> => {
        // Mirror the host.ts implementation using the test's seam.
        const archive = openArchiveStore(projectId);
        try {
          archive.removeRecord(archiveId);
        } finally {
          archive.close();
        }
        // No git call issued — record would be empty.
      },
      purgeArchive: async (archiveId: string): Promise<void> => {
        gitCalls.push(['branch', '-D', `co/coord-${archiveId}`]);
        const archive = openArchiveStore(projectId);
        try {
          archive.removeRecord(archiveId);
        } finally {
          archive.close();
        }
      },
    };

    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    await client.restoreArchive(id);

    // The record is gone — restored (un-archived) branch no longer expires.
    const verify = openArchiveStore(projectId);
    try {
      expect(verify.getRecord(id)).toBeUndefined();
    } finally {
      verify.close();
    }
    // NO git call was issued during restore (branch stays — only the archive record is dropped).
    expect(gitCalls).toHaveLength(0);
    expect(client.connected).toBe(true);
  });

  it('restoreArchive is a CONTROL verb: throws ConductorUnavailableError when the socket is down', async () => {
    const { projectId } = makeProject();
    const socketPath = makeSocketPath(); // nothing listening here
    seedArchiveRecord(projectId, { id: 'coord-restore-down', branch: 'co/coord-restore-down' });

    const client = makeClient(projectId, socketPath);

    await expect(client.restoreArchive('coord-restore-down')).rejects.toBeInstanceOf(
      ConductorUnavailableError,
    );
  });

  it('purgeArchive removes the archive record AND issues git branch -D cross-process', async () => {
    const { projectId } = makeProject();
    const socketPath = makeSocketPath();
    if (!(await unixSocketsAvailable(socketPath))) return;

    const { id, branch } = seedArchiveRecord(projectId, {
      id: 'coord-purge-1',
      branch: 'co/coord-purge-1',
    });

    // Wire a recording purgeArchive into the control surface to capture git calls.
    const gitCalls: string[][] = [];
    const clock = makeClock();
    const qw = makeQuietWindow();
    const { engine } = makeEngine(clock, qw);
    const { control: baseControl } = makeControl(engine, projectId);
    const control: ConductorControlSurface = {
      ...baseControl,
      purgeArchive: async (archiveId: string): Promise<void> => {
        const archive = openArchiveStore(projectId);
        try {
          const rec = archive.getRecord(archiveId);
          if (rec != null) gitCalls.push(['branch', '-D', rec.branch]);
          archive.removeRecord(archiveId);
        } finally {
          archive.close();
        }
      },
    };

    await startServer(control, projectId, socketPath);
    const client = makeClient(projectId, socketPath);

    await client.purgeArchive(id);

    // The archive record is gone.
    const verify = openArchiveStore(projectId);
    try {
      expect(verify.getRecord(id)).toBeUndefined();
    } finally {
      verify.close();
    }
    // git branch -D was issued for the correct branch.
    expect(gitCalls).toHaveLength(1);
    expect(gitCalls[0]).toEqual(['branch', '-D', branch]);
    expect(client.connected).toBe(true);
  });

  it('purgeArchive is a CONTROL verb: throws ConductorUnavailableError when the socket is down', async () => {
    const { projectId } = makeProject();
    const socketPath = makeSocketPath(); // nothing listening here
    seedArchiveRecord(projectId, { id: 'coord-purge-down', branch: 'co/coord-purge-down' });

    const client = makeClient(projectId, socketPath);

    await expect(client.purgeArchive('coord-purge-down')).rejects.toBeInstanceOf(
      ConductorUnavailableError,
    );
  });
});
