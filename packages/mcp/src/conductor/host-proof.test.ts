/**
 * AC-S10-4·2 — the scripted host-proof driver: proves the FULL sequence deterministically over
 * `FakePty` + in-memory transport + injected time (no real binary, no real clock).
 *
 *   spawn → inject 1 mail → 1 turn idle → live-pane steer → SIGKILL → recoverProjectStore
 *   → reconstruct session
 *
 * Clone of the `engine.test.ts` harness pattern: the test drives the FakePty pane in parallel
 * with the async driver using scripted bytes + the controllable quiet window.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  FakePty,
  MAIL_CHAT,
  OPERATOR,
  WEDGE_MS,
  defaultMailRenderer,
  openMailStore,
  openRegistry,
  openRosterStore,
  type DeliveredMail,
  type ProjectId,
  type ProjectRegistry,
  type RosterStore,
  type MailStore,
  type SpawnSpec,
} from '@co/core';
import type { HostedIdentity } from '../live-session-host.js';
import { buildHostProofSpawnSpec, hostProofMailRenderer, runHostProof } from './host-proof.js';
import { createStreamTransportPair } from './real-transport.js';

// ── Startup fixture ────────────────────────────────────────────────────────────
// ESC authored as a \u escape so the source holds no raw control byte.
const ESC = '\u001B';
const CLAUDE_READY = ESC + '[2J' + ESC + '[H' + '╭─ Welcome ─╮\r\n❯ \r\n  ? for shortcuts\r\n';
const CLAUDE_OAUTH_LOGIN =
  ESC +
  '[2J' +
  'Opening browser to sign in…\r\n' +
  "Browser didn't open? Use the url below to sign in (c to copy)\r\n" +
  'Paste code here if prompted >\r\n';

// ── Cleanup state ──────────────────────────────────────────────────────────────
const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let registries: ProjectRegistry[] = [];
let mailStores: MailStore[] = [];
let rosterStores: RosterStore[] = [];
let clients: Client[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  registries = [];
  mailStores = [];
  rosterStores = [];
  clients = [];
});

afterEach(async () => {
  for (const client of clients) {
    try {
      await client.close();
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

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeProject(): { projectId: ProjectId; cwd: string; dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'co-hp-'));
  dataDirs.push(dataDir);
  process.env.CO_DATA_DIR = dataDir;
  const registry = openRegistry();
  registries.push(registry);
  const cwd = join(dataDir, 'repo');
  return { projectId: registry.register(cwd), cwd, dataDir };
}

function seedParentChain(projectId: ProjectId): void {
  const roster = openRosterStore(projectId);
  rosterStores.push(roster);
  roster.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
}

function seedActionableMail(projectId: ProjectId, agent: string): void {
  const mail = openMailStore(projectId);
  mailStores.push(mail);
  mail.send({
    type: 'clarify_request',
    to: agent,
    from: 'coord-1',
    subject: 'host-proof task',
    body: 'prove the plumbing',
  });
}

function outstandingItem(projectId: ProjectId, agent: string): DeliveredMail {
  const store = openMailStore(projectId);
  mailStores.push(store);
  const item = store.outstanding(agent)[0];
  if (item == null) throw new Error(`test expected outstanding mail for '${agent}'`);
  return item;
}

function makeIdentity(agent: string, projectId: ProjectId, cwd: string): HostedIdentity {
  return {
    agent,
    role: 'implementer',
    parent: 'coord-1',
    pane: `pane-${agent}`,
    provider: 'claude',
    resume: { provider: 'claude', sessionId: `session-${agent}` },
    projectId,
    cwd,
  };
}

/** Drain microtasks + a macrotask. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
/** A few ticks for steps with several chained internal awaits (e.g. MCP bind handshake). */
const flush = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i++) await tick();
};
const waitUntil = async (predicate: () => boolean, timeoutMs = 1000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for test predicate');
};

/** Mutable monotonic clock — DATA, never a wall clock. */
function makeClock(): { now: () => number; set: (t: number) => void } {
  let t = 0;
  return { now: () => t, set: (next) => void (t = next) };
}

/** Controllable byte-quiet window: resolves on `settle()` or on its own re-arm abort. */
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

/** Drive a hosted pane through ONE idle turn: echo the injected text, emit turn bytes, settle quiet. */
async function driveTurnToIdle(
  pane: FakePty['panes'][number],
  item: DeliveredMail,
  clock: ReturnType<typeof makeClock>,
  qw: ReturnType<typeof makeQuietWindow>,
): Promise<void> {
  await tick(); // injectMail has written the payload and is awaiting the echo
  pane.emit(defaultMailRenderer(item)); // composer echoes the injected text → exactly one Enter
  await tick(); // injectMail submits; observeTurnEnd arms the first quiet window
  clock.set(1000);
  pane.emit('⠋ working…\r\n'); // the turn produces bytes, then goes quiet
  await tick(); // the new bytes re-arm the quiet window
  clock.set(1000 + WEDGE_MS + 1);
  qw.settle(); // the window elapses with no further output ⇒ idle
}

const neverResolve = (): Promise<void> => new Promise<void>(() => {});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('runHostProof — AC-S10-4·2: full sequence deterministically over FakePty + fakes', () => {
  it('runs spawn → inject → 1 turn → steer → SIGKILL → recover → reconstruct deterministically', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    seedActionableMail(projectId, 'impl-hp');
    const identity = makeIdentity('impl-hp', projectId, cwd);
    const mail = outstandingItem(projectId, 'impl-hp');

    const pty = new FakePty();
    const clock = makeClock();
    const qw = makeQuietWindow();
    const paneRef: { current?: FakePty['panes'][number] } = {};
    let beforeSteerSawInterrupt = false;

    // Start the driver — it will block at ensureHosted until the pane emits startup bytes.
    // awaitMailRouted: simulates the agent calling co_mail_send via the live MCP surface to
    // prove LiveDelivery routing works (the FakePty architectural constraint means the pane
    // can't make real MCP calls itself; this seam bridges that gap in-sandbox).
    const proofP = runHostProof(projectId, identity, mail, {
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      injectOptions: { retryDelay: neverResolve },
      beforeSteer: async () => {
        beforeSteerSawInterrupt = paneRef.current?.written.includes(ESC) ?? false;
      },
      expectedRouteNonce: 'nonce-ok',
      awaitMailRouted: async (clientTransport) => {
        const c = new Client({ name: 'fake-provider-router', version: '0.0.0' });
        clients.push(c);
        await c.connect(clientTransport);
        await c.callTool({
          name: 'co_mail_send',
          arguments: {
            to: 'coord-1',
            type: 'clarify_request',
            subject: 'turn complete nonce-ok',
            body: 'proof routing nonce-ok',
          },
        });
      },
    });

    // The pane is spawned synchronously before ensureHosted's first await.
    expect(pty.panes).toHaveLength(1);
    const pane = pty.panes[0]!;
    paneRef.current = pane;
    expect(pane.spec.command).toBe('claude');
    let hadInterruptBeforeCrash = false;
    pane.onExit(() => {
      hadInterruptBeforeCrash = pane.written.includes(ESC);
    });

    // Drive startup to ready.
    pane.emit(CLAUDE_READY);
    await flush(6); // driveToReady resolves, MCP bind completes, injectMail starts

    // Drive EXACTLY ONE turn to its idle boundary.
    await driveTurnToIdle(pane, mail, clock, qw);

    // Await the full proof.
    const result = await proofP;

    // AC-S10-4·2 (1): turn ran without error and reached an idle boundary.
    expect(result.turnRan).toBe(true);
    expect(result.turnIdle).toBe(true);

    // AC-S10-4·2 (emitted mail routed): fake MCP client called co_mail_send → LiveDelivery routed
    // it to coord-1's inbox through the real MCP surface (proven without a real binary).
    expect(result.mailRouted).toBe(true);

    // AC-S10-4·2 (2): recoverProjectStore + listSessions reconstructed the agent's session.
    expect(result.sessionReconstructed).toBe(true);
    expect(result.recoveredSessions.some((s) => s.agentId === 'impl-hp')).toBe(true);

    // AC-S10-4·2 (3): interrupt steer completed before the simulated crash.
    expect(result.steerCompleted).toBe(true);
    expect(result.steerMidTurn).toBe(true);
    expect(beforeSteerSawInterrupt).toBe(false);
    // Interrupt key (ESC) was written to the pane.
    expect(pane.written).toContain(ESC);
    expect(hadInterruptBeforeCrash).toBe(true);

    // EXACTLY one turn submitted: the composer received exactly one Enter.
    expect(pane.written.filter((w) => w === '\r')).toHaveLength(1);
  });

  it('uses the supplied SpawnSpec so host-live can attach provider MCP config', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    seedActionableMail(projectId, 'impl-hp');
    const identity = makeIdentity('impl-hp', projectId, cwd);
    const mail = outstandingItem(projectId, 'impl-hp');
    const spawnSpec: SpawnSpec = {
      command: 'claude',
      args: ['--strict-mcp-config', '--mcp-config', '/tmp/host-proof-co-mcp.json'],
      cwd,
      env: { CLAUDE_CONFIG_DIR: '/tmp/host-proof-claude' },
      prelaunchFiles: [{ path: '/tmp/host-proof-co-mcp.json', contents: '{"mcpServers":{}}\n' }],
    };

    const pty = new FakePty();
    const clock = makeClock();
    const qw = makeQuietWindow();

    const proofP = runHostProof(projectId, identity, mail, {
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      injectOptions: { retryDelay: neverResolve },
      spawnSpec,
      expectedRouteNonce: 'spawn-spec-nonce',
      awaitMailRouted: async (clientTransport) => {
        const c = new Client({ name: 'fake-provider-router', version: '0.0.0' });
        clients.push(c);
        await c.connect(clientTransport);
        await c.callTool({
          name: 'co_mail_send',
          arguments: {
            to: 'coord-1',
            type: 'clarify_request',
            subject: 'turn complete spawn-spec-nonce',
            body: 'proof routing spawn-spec-nonce',
          },
        });
      },
    });

    expect(pty.panes).toHaveLength(1);
    const pane = pty.panes[0]!;
    expect(pane.spec).toEqual(spawnSpec);
    pane.emit(CLAUDE_READY);
    await flush(6);
    await driveTurnToIdle(pane, mail, clock, qw);

    const result = await proofP;

    expect(result.turnRan).toBe(true);
    expect(result.mailRouted).toBe(true);
    expect(result.steerMidTurn).toBe(true);
  });

  it('reports steerMidTurn=false if beforeSteer lets the turn settle before interrupt', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    seedActionableMail(projectId, 'impl-hp');
    const identity = makeIdentity('impl-hp', projectId, cwd);
    const mail = outstandingItem(projectId, 'impl-hp');

    const pty = new FakePty();
    const clock = makeClock();
    const qw = makeQuietWindow();
    let markBeforeSteer!: () => void;
    const beforeSteerStarted = new Promise<void>((resolve) => {
      markBeforeSteer = resolve;
    });
    let releaseBeforeSteer!: () => void;
    const holdBeforeSteer = new Promise<void>((resolve) => {
      releaseBeforeSteer = resolve;
    });

    const proofP = runHostProof(projectId, identity, mail, {
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      injectOptions: { retryDelay: neverResolve },
      beforeSteer: async () => {
        markBeforeSteer();
        await holdBeforeSteer;
      },
      expectedRouteNonce: 'before-steer-nonce',
      awaitMailRouted: async (clientTransport) => {
        const c = new Client({ name: 'fake-provider-router', version: '0.0.0' });
        clients.push(c);
        await c.connect(clientTransport);
        await c.callTool({
          name: 'co_mail_send',
          arguments: {
            to: 'coord-1',
            type: 'clarify_request',
            subject: 'turn complete before-steer-nonce',
            body: 'proof routing before-steer-nonce',
          },
        });
      },
    });

    expect(pty.panes).toHaveLength(1);
    const pane = pty.panes[0]!;
    pane.emit(CLAUDE_READY);
    await flush(6);
    await beforeSteerStarted;
    await driveTurnToIdle(pane, mail, clock, qw);
    releaseBeforeSteer();

    const result = await proofP;

    expect(result.turnRan).toBe(true);
    expect(result.turnIdle).toBe(true);
    expect(result.mailRouted).toBe(true);
    expect(result.steerCompleted).toBe(true);
    expect(result.steerMidTurn).toBe(false);
  });

  it('can prove routing idle on one turn and mid-turn steering on a separate warm-pane turn', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    seedActionableMail(projectId, 'impl-hp');
    const identity = makeIdentity('impl-hp', projectId, cwd);
    const mail = outstandingItem(projectId, 'impl-hp');

    const pty = new FakePty();
    const clock = makeClock();
    const qw = makeQuietWindow();
    const paneRef: { current?: FakePty['panes'][number] } = {};
    let beforeSteerRan = false;

    const proofP = runHostProof(projectId, identity, mail, {
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      injectOptions: { retryDelay: neverResolve },
      separateSteerTurn: true,
      steerTurnStartDelayMs: 0,
      expectedRouteNonce: 'split-turn-nonce',
      awaitMailRouted: async (clientTransport) => {
        const c = new Client({ name: 'fake-provider-router', version: '0.0.0' });
        clients.push(c);
        await c.connect(clientTransport);
        await c.callTool({
          name: 'co_mail_send',
          arguments: {
            to: 'coord-1',
            type: 'clarify_request',
            subject: 'turn complete split-turn-nonce',
            body: 'proof routing split-turn-nonce',
          },
        });
      },
      beforeSteer: async () => {
        beforeSteerRan = true;
        const store = openMailStore(projectId);
        mailStores.push(store);
        const pane = paneRef.current;
        if (pane == null) throw new Error('test expected pane reference');
        expect(
          store
            .outstanding('impl-hp')
            .some((item) => item.subject.includes('host-proof steer split-turn-nonce')),
        ).toBe(true);
        expect(pane.written.filter((w) => w === '\r')).toHaveLength(2);
        expect(pane.written).not.toContain(ESC);
        setTimeout(() => {
          clock.set(2000 + WEDGE_MS + 1);
          qw.settle();
        }, 0);
      },
    });

    expect(pty.panes).toHaveLength(1);
    const pane = pty.panes[0]!;
    paneRef.current = pane;
    pane.emit(CLAUDE_READY);
    await flush(6);
    await driveTurnToIdle(pane, mail, clock, qw);
    const store = openMailStore(projectId);
    mailStores.push(store);
    await waitUntil(() =>
      store
        .outstanding('impl-hp')
        .some((item) => item.subject.includes('host-proof steer split-turn-nonce')),
    );
    const steerMail = store
      .outstanding('impl-hp')
      .find((item) => item.subject.includes('host-proof steer split-turn-nonce'));
    if (steerMail == null) throw new Error('test expected seeded steer proof mail');
    pane.emit(defaultMailRenderer(steerMail));
    await tick();
    clock.set(2000);
    pane.emit('⠋ still working before interrupt\r\n');
    await tick();

    const result = await proofP;

    expect(beforeSteerRan).toBe(true);
    expect(result.turnRan).toBe(true);
    expect(result.turnIdle).toBe(true);
    expect(result.mailRouted).toBe(true);
    expect(result.steerCompleted).toBe(true);
    expect(result.steerMidTurn).toBe(true);
    expect(pane.written.filter((w) => w === '\r')).toHaveLength(2);
  });

  it('waits for the separate steer mail to submit before interrupting fallback injection', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    seedActionableMail(projectId, 'impl-hp');
    const identity = makeIdentity('impl-hp', projectId, cwd);
    const mail = outstandingItem(projectId, 'impl-hp');

    const pty = new FakePty();
    const clock = makeClock();
    const qw = makeQuietWindow();
    const paneRef: { current?: FakePty['panes'][number] } = {};
    let retryAttempts = 0;
    let releaseSecondRetry: (() => void) | undefined;
    let beforeSteerRan = false;
    const retryDelay = (signal?: AbortSignal): Promise<void> =>
      new Promise<void>((resolve) => {
        retryAttempts += 1;
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', finish);
          resolve();
        };
        signal?.addEventListener('abort', finish, { once: true });
        if (retryAttempts === 2) releaseSecondRetry = finish;
      });

    const proofP = runHostProof(projectId, identity, mail, {
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      injectOptions: { retryDelay, allowUnverifiedSubmit: true },
      separateSteerTurn: true,
      steerTurnStartDelayMs: 0,
      expectedRouteNonce: 'split-fallback-nonce',
      awaitMailRouted: async (clientTransport) => {
        const c = new Client({ name: 'fake-provider-router', version: '0.0.0' });
        clients.push(c);
        await c.connect(clientTransport);
        await c.callTool({
          name: 'co_mail_send',
          arguments: {
            to: 'coord-1',
            type: 'clarify_request',
            subject: 'turn complete split-fallback-nonce',
            body: 'proof routing split-fallback-nonce',
          },
        });
      },
      beforeSteer: async () => {
        beforeSteerRan = true;
        const pane = paneRef.current;
        if (pane == null) throw new Error('test expected pane reference');
        expect(pane.written.filter((w) => w === '\r')).toHaveLength(2);
        expect(pane.written).not.toContain(ESC);
        clock.set(2000);
        pane.emit('⠋ still working after fallback submit\r\n');
        await tick();
        setTimeout(() => {
          clock.set(2000 + WEDGE_MS + 1);
          qw.settle();
        }, 0);
      },
    });

    expect(pty.panes).toHaveLength(1);
    const pane = pty.panes[0]!;
    paneRef.current = pane;
    pane.emit(CLAUDE_READY);
    await flush(6);
    await driveTurnToIdle(pane, mail, clock, qw);
    await waitUntil(() => retryAttempts >= 2);

    expect(beforeSteerRan).toBe(false);
    expect(pane.written.filter((w) => w === '\r')).toHaveLength(1);
    releaseSecondRetry?.();

    const result = await proofP;

    expect(beforeSteerRan).toBe(true);
    expect(result.turnRan).toBe(true);
    expect(result.turnIdle).toBe(true);
    expect(result.mailRouted).toBe(true);
    expect(result.steerMidTurn).toBe(true);
    expect(pane.written.filter((w) => w === '\r')).toHaveLength(2);
    expect(pane.written).toContain(ESC);
  });

  it('fails loud if the separate steer turn errors before injection completes', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    seedActionableMail(projectId, 'impl-hp');
    const identity = makeIdentity('impl-hp', projectId, cwd);
    const mail = outstandingItem(projectId, 'impl-hp');

    const pty = new FakePty();
    const clock = makeClock();
    const qw = makeQuietWindow();

    const proofP = runHostProof(projectId, identity, mail, {
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      injectOptions: { retryDelay: neverResolve },
      separateSteerTurn: true,
      steerTurnStartDelayMs: 0,
      expectedRouteNonce: 'split-inject-fail-nonce',
      renderMail: (item) =>
        item.subject.includes('host-proof steer') ? ' ' : defaultMailRenderer(item),
      awaitMailRouted: async (clientTransport) => {
        const c = new Client({ name: 'fake-provider-router', version: '0.0.0' });
        clients.push(c);
        await c.connect(clientTransport);
        await c.callTool({
          name: 'co_mail_send',
          arguments: {
            to: 'coord-1',
            type: 'clarify_request',
            subject: 'turn complete split-inject-fail-nonce',
            body: 'proof routing split-inject-fail-nonce',
          },
        });
      },
    });

    expect(pty.panes).toHaveLength(1);
    const pane = pty.panes[0]!;
    pane.emit(CLAUDE_READY);
    await flush(6);
    await driveTurnToIdle(pane, mail, clock, qw);

    await expect(proofP).rejects.toThrow(
      /separate steer turn failed before injection completed.*empty/i,
    );
  });

  it('fails before injection when startup surfaces login_required', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    seedActionableMail(projectId, 'impl-hp');
    const identity = makeIdentity('impl-hp', projectId, cwd);
    const mail = outstandingItem(projectId, 'impl-hp');

    const pty = new FakePty();
    const clock = makeClock();
    const qw = makeQuietWindow();

    const proofP = runHostProof(projectId, identity, mail, {
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      injectOptions: { retryDelay: async () => {}, maxEchoAttempts: 1 },
    });
    const proofRejects = expect(proofP).rejects.toThrow(/login required|not authenticated/i);

    expect(pty.panes).toHaveLength(1);
    const pane = pty.panes[0]!;
    pane.emit(CLAUDE_OAUTH_LOGIN);
    await flush(6);
    qw.settle();

    await proofRejects;
    expect(pane.written).toEqual([]);
  });

  it('returns mailRouted=false when the parent pre-holds an item but the hosted agent routes nothing (regression guard: old tautological check)', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);

    // Pre-seed an item in coord-1's outstanding queue FROM a different sender (not impl-hp).
    // This mirrors the [host-live] @operator case: @operator already holds the injected test
    // mail BEFORE the turn runs. Under the OLD `.length > 0` check, mailRouted would be
    // unconditionally true — this test catches that regression.
    const preStore = openMailStore(projectId);
    mailStores.push(preStore);
    preStore.send({
      type: 'clarify_request',
      to: 'coord-1',
      from: 'unrelated-agent',
      subject: 'pre-existing item',
      body: 'already in the queue before the turn',
    });

    seedActionableMail(projectId, 'impl-hp');
    const identity = makeIdentity('impl-hp', projectId, cwd);
    const mail = outstandingItem(projectId, 'impl-hp');

    const pty = new FakePty();
    const clock = makeClock();
    const qw = makeQuietWindow();

    // awaitMailRouted intentionally omitted — the hosted agent routes nothing during the turn.
    const proofP = runHostProof(projectId, identity, mail, {
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      injectOptions: { retryDelay: neverResolve },
      routeTimeoutMs: 50,
    });

    expect(pty.panes).toHaveLength(1);
    const pane = pty.panes[0]!;
    pane.emit(CLAUDE_READY);
    await flush(6);
    await driveTurnToIdle(pane, mail, clock, qw);

    const result = await proofP;

    // mailRouted must be false: coord-1's only outstanding item has sender='unrelated-agent',
    // not 'impl-hp'. The old check (.length > 0) would have returned true here — silent failure.
    expect(result.mailRouted).toBe(false);
  });

  it('returns mailRouted=false when only a stale same-sender parent item exists', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);

    const preStore = openMailStore(projectId);
    mailStores.push(preStore);
    preStore.send({
      type: 'clarify_request',
      to: 'coord-1',
      from: 'impl-hp',
      subject: 'stale same sender',
      body: 'already in the queue before the turn',
    });

    seedActionableMail(projectId, 'impl-hp');
    const identity = makeIdentity('impl-hp', projectId, cwd);
    const mail = outstandingItem(projectId, 'impl-hp');

    const pty = new FakePty();
    const clock = makeClock();
    const qw = makeQuietWindow();

    const proofP = runHostProof(projectId, identity, mail, {
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      injectOptions: { retryDelay: neverResolve },
      expectedRouteNonce: 'fresh-nonce',
      routeTimeoutMs: 50,
    });

    expect(pty.panes).toHaveLength(1);
    const pane = pty.panes[0]!;
    pane.emit(CLAUDE_READY);
    await flush(6);
    await driveTurnToIdle(pane, mail, clock, qw);

    const result = await proofP;

    expect(result.mailRouted).toBe(false);
  });

  it('returns mailRouted=false when the hosted agent sends a new message without the proof nonce', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    seedActionableMail(projectId, 'impl-hp');
    const identity = makeIdentity('impl-hp', projectId, cwd);
    const mail = outstandingItem(projectId, 'impl-hp');

    const pty = new FakePty();
    const clock = makeClock();
    const qw = makeQuietWindow();

    const proofP = runHostProof(projectId, identity, mail, {
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      injectOptions: { retryDelay: neverResolve },
      expectedRouteNonce: 'fresh-nonce',
      awaitMailRouted: async (clientTransport) => {
        const c = new Client({ name: 'fake-provider-router', version: '0.0.0' });
        clients.push(c);
        await c.connect(clientTransport);
        await c.callTool({
          name: 'co_mail_send',
          arguments: {
            to: 'coord-1',
            type: 'clarify_request',
            subject: 'turn complete',
            body: 'proof routing',
          },
        });
      },
    });

    expect(pty.panes).toHaveLength(1);
    const pane = pty.panes[0]!;
    pane.emit(CLAUDE_READY);
    await flush(6);
    await driveTurnToIdle(pane, mail, clock, qw);

    const result = await proofP;

    expect(result.mailRouted).toBe(false);
  });

  it('waits briefly for a valid routed proof mail that arrives after byte-idle', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    seedActionableMail(projectId, 'impl-hp');
    const identity = makeIdentity('impl-hp', projectId, cwd);
    const mail = outstandingItem(projectId, 'impl-hp');

    const pty = new FakePty();
    const clock = makeClock();
    const qw = makeQuietWindow();
    const routeStore = openMailStore(projectId);
    mailStores.push(routeStore);

    const proofP = runHostProof(projectId, identity, mail, {
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      injectOptions: { retryDelay: neverResolve },
      expectedRouteNonce: 'late-route-nonce',
      routeTimeoutMs: 100,
      routePostSettleGraceMs: 100,
    });

    expect(pty.panes).toHaveLength(1);
    const pane = pty.panes[0]!;
    pane.emit(CLAUDE_READY);
    await flush(6);
    await driveTurnToIdle(pane, mail, clock, qw);
    const routeLater = new Promise<void>((resolve) => {
      setTimeout(() => {
        routeStore.send({
          type: 'clarify_request',
          to: 'coord-1',
          from: 'impl-hp',
          subject: 'late proof late-route-nonce',
          body: 'routed after idle',
        });
        resolve();
      }, 0);
    });
    await routeLater;

    const result = await proofP;

    expect(result.mailRouted).toBe(true);
  });

  it('does not wait for the full route timeout after a fast no-route turn settles', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    seedActionableMail(projectId, 'impl-hp');
    const identity = makeIdentity('impl-hp', projectId, cwd);
    const mail = outstandingItem(projectId, 'impl-hp');

    const pty = new FakePty();
    const clock = makeClock();
    const qw = makeQuietWindow();

    const proofP = runHostProof(projectId, identity, mail, {
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      injectOptions: { retryDelay: neverResolve },
      expectedRouteNonce: 'never-routed',
      routeTimeoutMs: 750,
      routePostSettleGraceMs: 10,
    });

    expect(pty.panes).toHaveLength(1);
    const pane = pty.panes[0]!;
    pane.emit(CLAUDE_READY);
    await flush(6);
    const started = Date.now();
    await driveTurnToIdle(pane, mail, clock, qw);

    const result = await proofP;

    expect(Date.now() - started).toBeLessThan(500);
    expect(result.mailRouted).toBe(false);
  });

  it('returns mailRouted=false when the hosted agent sends the proof nonce with the wrong mail type', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    seedActionableMail(projectId, 'impl-hp');
    const identity = makeIdentity('impl-hp', projectId, cwd);
    const mail = outstandingItem(projectId, 'impl-hp');

    const pty = new FakePty();
    const clock = makeClock();
    const qw = makeQuietWindow();

    const proofP = runHostProof(projectId, identity, mail, {
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      injectOptions: { retryDelay: neverResolve },
      expectedRouteNonce: 'wrong-type-nonce',
      awaitMailRouted: async (clientTransport) => {
        const c = new Client({ name: 'fake-provider-router', version: '0.0.0' });
        clients.push(c);
        await c.connect(clientTransport);
        await c.callTool({
          name: 'co_mail_send',
          arguments: {
            to: 'coord-1',
            type: MAIL_CHAT,
            subject: 'turn complete wrong-type-nonce',
            body: 'proof routing wrong-type-nonce',
          },
        });
      },
    });

    expect(pty.panes).toHaveLength(1);
    const pane = pty.panes[0]!;
    pane.emit(CLAUDE_READY);
    await flush(6);
    await driveTurnToIdle(pane, mail, clock, qw);

    const result = await proofP;

    expect(result.mailRouted).toBe(false);
  });

  it('returns mailRouted=false when duplicate matching proof mails are sent', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    seedActionableMail(projectId, 'impl-hp');
    const identity = makeIdentity('impl-hp', projectId, cwd);
    const mail = outstandingItem(projectId, 'impl-hp');

    const pty = new FakePty();
    const clock = makeClock();
    const qw = makeQuietWindow();

    const proofP = runHostProof(projectId, identity, mail, {
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      injectOptions: { retryDelay: neverResolve },
      expectedRouteNonce: 'duplicate-nonce',
      awaitMailRouted: async (clientTransport) => {
        const c = new Client({ name: 'fake-provider-router', version: '0.0.0' });
        clients.push(c);
        await c.connect(clientTransport);
        for (let i = 0; i < 2; i++) {
          await c.callTool({
            name: 'co_mail_send',
            arguments: {
              to: 'coord-1',
              type: 'clarify_request',
              subject: `turn complete duplicate-nonce ${i}`,
              body: 'proof routing duplicate-nonce',
            },
          });
        }
      },
    });

    expect(pty.panes).toHaveLength(1);
    const pane = pty.panes[0]!;
    pane.emit(CLAUDE_READY);
    await flush(6);
    await driveTurnToIdle(pane, mail, clock, qw);

    const result = await proofP;

    expect(result.mailRouted).toBe(false);
  });

  it('returns mailRouted=false when a valid proof mail is followed by an extra invalid mail', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    seedActionableMail(projectId, 'impl-hp');
    const identity = makeIdentity('impl-hp', projectId, cwd);
    const mail = outstandingItem(projectId, 'impl-hp');

    const pty = new FakePty();
    const clock = makeClock();
    const qw = makeQuietWindow();

    const proofP = runHostProof(projectId, identity, mail, {
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      injectOptions: { retryDelay: neverResolve },
      expectedRouteNonce: 'extra-invalid-nonce',
      awaitMailRouted: async (clientTransport) => {
        const c = new Client({ name: 'fake-provider-router', version: '0.0.0' });
        clients.push(c);
        await c.connect(clientTransport);
        await c.callTool({
          name: 'co_mail_send',
          arguments: {
            to: 'coord-1',
            type: 'clarify_request',
            subject: 'turn complete extra-invalid-nonce',
            body: 'proof routing extra-invalid-nonce',
          },
        });
        await c.callTool({
          name: 'co_mail_send',
          arguments: {
            to: 'coord-1',
            type: MAIL_CHAT,
            subject: 'extra chatter',
            body: 'not part of the proof',
          },
        });
      },
    });

    expect(pty.panes).toHaveLength(1);
    const pane = pty.panes[0]!;
    pane.emit(CLAUDE_READY);
    await flush(6);
    await driveTurnToIdle(pane, mail, clock, qw);

    const result = await proofP;

    expect(result.mailRouted).toBe(false);
  });

  it('recomputes final proof-mail exactness after an early route and catches later duplicates', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    seedActionableMail(projectId, 'impl-hp');
    const identity = makeIdentity('impl-hp', projectId, cwd);
    const mail = outstandingItem(projectId, 'impl-hp');

    const pty = new FakePty();
    const clock = makeClock();
    const qw = makeQuietWindow();
    const routeStore = openMailStore(projectId);
    mailStores.push(routeStore);
    let beforeSteerStarted = false;

    const proofP = runHostProof(projectId, identity, mail, {
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      injectOptions: { retryDelay: neverResolve },
      expectedRouteNonce: 'early-duplicate-nonce',
      routeTimeoutMs: 500,
      beforeSteer: async () => {
        beforeSteerStarted = true;
        routeStore.send({
          type: 'clarify_request',
          to: 'coord-1',
          from: 'impl-hp',
          subject: 'duplicate proof early-duplicate-nonce',
          body: 'second matching proof mail',
        });
      },
    });

    expect(pty.panes).toHaveLength(1);
    const pane = pty.panes[0]!;
    pane.emit(CLAUDE_READY);
    await flush(6);
    routeStore.send({
      type: 'clarify_request',
      to: 'coord-1',
      from: 'impl-hp',
      subject: 'first proof early-duplicate-nonce',
      body: 'first matching proof mail',
    });
    await waitUntil(() => beforeSteerStarted);
    await driveTurnToIdle(pane, mail, clock, qw);

    const result = await proofP;

    expect(result.steerMidTurn).toBe(true);
    expect(result.mailRouted).toBe(false);
  });

  it('full proof can use the stream-backed transport pair, not only InMemoryTransport', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    seedActionableMail(projectId, 'impl-hp');
    const identity = makeIdentity('impl-hp', projectId, cwd);
    const mail = outstandingItem(projectId, 'impl-hp');

    const pty = new FakePty();
    const clock = makeClock();
    const qw = makeQuietWindow();

    const proofP = runHostProof(projectId, identity, mail, {
      pty,
      makeTransport: createStreamTransportPair,
      now: clock.now,
      quietWindow: qw.quietWindow,
      injectOptions: { retryDelay: neverResolve },
      expectedRouteNonce: 'stream-nonce',
      awaitMailRouted: async (clientTransport) => {
        const c = new Client({ name: 'fake-provider-router', version: '0.0.0' });
        clients.push(c);
        await c.connect(clientTransport);
        await c.callTool({
          name: 'co_mail_send',
          arguments: {
            to: 'coord-1',
            type: 'clarify_request',
            subject: 'turn complete stream-nonce',
            body: 'proof routing stream-nonce',
          },
        });
      },
    });

    expect(pty.panes).toHaveLength(1);
    const pane = pty.panes[0]!;
    pane.emit(CLAUDE_READY);
    await flush(6);
    await driveTurnToIdle(pane, mail, clock, qw);

    const result = await proofP;

    expect(result.turnRan).toBe(true);
    expect(result.turnIdle).toBe(true);
    expect(result.mailRouted).toBe(true);
    expect(result.steerMidTurn).toBe(true);
  });
});

describe('buildHostProofSpawnSpec — real-provider MCP config', () => {
  it('renders the tool-call prompt only for the route-proof mail, not the separate steer mail', () => {
    const { projectId } = makeProject();
    const store = openMailStore(projectId);
    mailStores.push(store);
    const renderer = hostProofMailRenderer('route-nonce', 'mcp__co__co_mail_send');
    const routeMail = store.send({
      type: 'clarify_request',
      to: 'impl-hp',
      from: OPERATOR,
      subject: 'host-proof route-nonce',
      body: 'route proof',
    });
    const steerMail = store.send({
      type: 'clarify_request',
      to: 'impl-hp',
      from: OPERATOR,
      subject: 'host-proof steer route-nonce',
      body: 'Do not call tools. Keep the turn active briefly until interrupted.',
    });

    const renderedRoute = renderer(routeMail);
    const renderedSteer = renderer(steerMail);

    expect(renderedRoute).toContain('mcp__co__co_mail_send');
    expect(renderedRoute).toContain('host-proof complete route-nonce');
    expect(renderedSteer).toContain('Do not call tools');
    expect(renderedSteer).not.toContain('mcp__co__co_mail_send');
  });

  it('builds a Claude spawn spec with scoped stdio co-mcp JSON config', () => {
    const { projectId, cwd, dataDir } = makeProject();
    const identity = {
      ...makeIdentity('host-proof-claude', projectId, cwd),
      role: 'coordinator',
      parent: '@operator',
    } satisfies HostedIdentity;

    const spec = buildHostProofSpawnSpec(identity, {
      isolatedHomeDir: join(dataDir, 'isolated', identity.agent),
      coMcpCommand: '/usr/bin/node',
      coMcpArgs: ['/repo/packages/mcp/dist/bin.js'],
      coCliCommand: '/repo/packages/cli/dist/index.js',
      claudeCredentialsJson: '{"claude":true}\n',
      claudeStateJson: JSON.stringify({
        oauthAccount: true,
        hasCompletedOnboarding: true,
        projects: { '/repo': { allowedTools: ['Bash'] } },
        mcpServers: { userConfigured: true },
        history: ['do not copy'],
      }),
    });

    expect(spec.command).toBe('claude');
    expect(spec.args).toContain('--mcp-config');
    const configPath = spec.args[spec.args.indexOf('--mcp-config') + 1];
    expect(configPath).toBe(`${dataDir}/isolated/host-proof-claude/mcp/co-mcp.json`);
    const config = spec.prelaunchFiles?.find((file) => file.path === configPath);
    expect(config).toBeDefined();
    const parsed = JSON.parse(config!.contents) as {
      mcpServers?: { co?: { command?: string; args?: string[]; env?: Record<string, string> } };
    };
    expect(parsed.mcpServers?.co).toEqual({
      command: '/usr/bin/node',
      args: ['/repo/packages/mcp/dist/bin.js'],
      env: {
        CO_AGENT: 'host-proof-claude',
        CO_ROLE: 'coordinator',
        CO_PARENT: '@operator',
        CO_PROJECT_ID: projectId,
      },
    });
    expect(spec.prelaunchFiles).toContainEqual({
      path: `${dataDir}/isolated/host-proof-claude/.credentials.json`,
      contents: '{"claude":true}\n',
    });
    const stateFile = spec.prelaunchFiles?.find((file) => file.path.endsWith('/.claude.json'));
    expect(stateFile).toBeDefined();
    expect(JSON.parse(stateFile!.contents)).toEqual({
      oauthAccount: true,
      hasCompletedOnboarding: true,
    });
  });

  it('builds a Codex spawn spec with scoped stdio co-mcp env in config.toml', () => {
    const { projectId, cwd, dataDir } = makeProject();
    const identity: HostedIdentity = {
      agent: 'host-proof-codex',
      role: 'coordinator',
      parent: '@operator',
      pane: 'host-proof-pane-codex',
      projectId,
      cwd,
      provider: 'codex',
      resume: { provider: 'codex', codexHome: join(dataDir, 'isolated', 'host-proof-codex') },
    };

    const spec = buildHostProofSpawnSpec(identity, {
      isolatedHomeDir: join(dataDir, 'isolated', identity.agent),
      coMcpCommand: '/usr/bin/node',
      coMcpArgs: ['/repo/packages/mcp/dist/bin.js'],
      coMcpBridgeSocketPath: () => `${dataDir}/sockets/co.sock`,
      coCliCommand: '/repo/packages/cli/dist/index.js',
      codexAuthJson: '{"codex":true}\n',
    });

    expect(spec.command).toBe('codex');
    expect(spec.args).toEqual(['--add-dir', `${dataDir}/sockets`]);
    expect(spec.env['CODEX_HOME']).toBe(`${dataDir}/isolated/host-proof-codex`);
    const configToml = spec.prelaunchFiles?.find((file) => file.path.endsWith('/config.toml'));
    expect(configToml).toBeDefined();
    expect(configToml!.contents).toContain(
      `args = ["/repo/packages/mcp/dist/bin.js", "bridge", "${dataDir}/sockets/co.sock"]`,
    );
    expect(configToml!.contents).toContain('[mcp_servers.co.env]');
    expect(configToml!.contents).toContain('CO_AGENT = "host-proof-codex"');
    expect(configToml!.contents).toContain('CO_ROLE = "coordinator"');
    expect(configToml!.contents).toContain('CO_PARENT = "@operator"');
    expect(configToml!.contents).toContain(`CO_PROJECT_ID = "${projectId}"`);
    expect(configToml!.contents).toContain(
      `CO_MCP_BRIDGE_LOG = "${dataDir}/isolated/host-proof-codex/mcp/bridge.log"`,
    );
    expect(spec.prelaunchFiles).toContainEqual({
      path: `${dataDir}/isolated/host-proof-codex/auth.json`,
      contents: '{"codex":true}\n',
    });
  });
});
