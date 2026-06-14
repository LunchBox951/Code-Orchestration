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
  QUIET_WINDOW_MS,
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
import { buildHostProofSpawnSpec, runHostProof } from './host-proof.js';
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
  clock.set(1000 + QUIET_WINDOW_MS + 1);
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
