/**
 * AC-S10-4·1 — the real stream-backed {@link TransportPair}: a fake MCP Client completes an
 * `initialize` + `co_mail_inbox` round-trip through the pair without any real provider binary.
 *
 * This proves the real transport plumbing independently of the InMemoryTransport used in the
 * rest of the engine tests. The test follows the same `connectClient` assertion style from
 * `engine.test.ts:262` but uses `createStreamTransportPair()` instead of
 * `InMemoryTransport.createLinkedPair()`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { PassThrough, type Writable } from 'node:stream';
import { dirname } from 'node:path';
import { createConnection, createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  FakePty,
  openRegistry,
  openRosterStore,
  type ProjectId,
  type ProjectRegistry,
  type RosterStore,
} from '@co/core';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ConductorEngine } from './engine.js';
import type { HostedIdentity } from '../live-session-host.js';
import {
  connectSocketWithRetry,
  createSocketBridgeTransportPair,
  createStreamTransportPair,
  runSocketBridge,
} from './real-transport.js';
import { defaultBridgeSocketPath } from './host-launch-paths.js';

// ── Startup fixture (shared with engine.test.ts) ─────────────────────────────
// ESC authored as a \u escape so the source holds no raw control byte.
const ESC = '\u001B';
const CLAUDE_READY = ESC + '[2J' + ESC + '[H' + '╭─ Welcome ─╮\r\n❯ \r\n  ? for shortcuts\r\n';

// ── Cleanup state ─────────────────────────────────────────────────────────────
const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let engines: ConductorEngine[] = [];
let clients: Client[] = [];
let registries: ProjectRegistry[] = [];
let rosterStores: RosterStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  engines = [];
  clients = [];
  registries = [];
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
  for (const client of clients) {
    try {
      await client.close();
    } catch {
      /* best-effort */
    }
  }
  for (const closeable of [...rosterStores, ...registries]) {
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

function makeProject(): { projectId: ProjectId; cwd: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'co-rt-'));
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
}

function makeIdentity(
  over: Partial<HostedIdentity> & Pick<HostedIdentity, 'agent' | 'projectId' | 'cwd'>,
): HostedIdentity {
  return {
    role: 'implementer',
    parent: 'coord-1',
    pane: `pane-${over.agent}`,
    provider: 'claude',
    resume: { provider: 'claude', sessionId: `session-${over.agent}` },
    ...over,
  };
}

const neverResolve = (): Promise<void> => new Promise<void>(() => {});

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

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('createStreamTransportPair — real stream-backed MCP transport', () => {
  it('returns a TransportPair where a fake Client completes initialize + co_mail_inbox', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const identity = makeIdentity({ agent: 'impl-rt', projectId, cwd });

    const pty = new FakePty();
    const engine = new ConductorEngine({
      pty,
      makeTransport: createStreamTransportPair,
      now: () => 0,
      quietWindow: neverResolve,
      injectOptions: { retryDelay: neverResolve },
    });
    engines.push(engine);

    // Spawn → driveToReady → bind using the real stream transport.
    const ensureP = engine.ensureHosted(identity);
    const pane = pty.panes[0]!;
    pane.emit(CLAUDE_READY);
    const hosted = await ensureP;

    expect(hosted.startup).toEqual({ authed: true });

    // Connect a fake MCP Client to the CLIENT side of the real transport pair.
    const client = new Client({ name: 'co-rt-test', version: '0.0.0' });
    clients.push(client);
    await client.connect(hosted.clientTransport);

    // Prove a real MCP round-trip: co_mail_inbox succeeds through the stream-backed pair.
    const inbox = await client.callTool({ name: 'co_mail_inbox', arguments: {} });
    // The response is structured content (an object, not an error).
    expect(inbox.isError).toBeFalsy();
    expect(inbox.content).toBeDefined();

    // Prove co_status round-trip too: the authoritative identity is wired correctly.
    const status = await client.callTool({ name: 'co_status', arguments: {} });
    expect((status.structuredContent as Record<string, unknown>).agent).toBe('impl-rt');
  });

  it('is distinct from InMemoryTransport: both sides perform real stream serialisation', () => {
    const realPair = createStreamTransportPair();
    const memPair = InMemoryTransport.createLinkedPair();
    // Real transport's constructor name is StdioServerTransport, not InMemoryTransport.
    expect(realPair[0].constructor.name).not.toBe('InMemoryTransport');
    expect(realPair[1].constructor.name).not.toBe('InMemoryTransport');
    // Both sides are distinct objects (not the same reference).
    expect(realPair[0]).not.toBe(realPair[1]);
    // InMemoryTransport pair uses its own class.
    expect(memPair[0].constructor.name).toBe('InMemoryTransport');
    void memPair;
  });
});

describe('createSocketBridgeTransportPair — live provider bridge transport', () => {
  it('retries the bridge socket client until the server listener materializes', async () => {
    const socketPath = defaultBridgeSocketPath(join(tmpdir(), 'co-bridge-retry'), 'impl-retry');
    if (!(await unixSocketsAvailable(socketPath))) return;

    const connectP = connectSocketWithRetry(socketPath, { retryDelayMs: 5, timeoutMs: 500 });
    await new Promise((resolve) => setTimeout(resolve, 25));

    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });

    const socket = await connectP;
    expect(socket.destroyed).toBe(false);

    socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      unlinkSync(socketPath);
    } catch {
      // Already removed.
    }
  });

  it('bridges stdio JSON-RPC through the Unix socket to the engine-hosted MCP server', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const identity = makeIdentity({ agent: 'impl-stdio-bridge', projectId, cwd });
    const isolatedHomeDir = join(cwd, 'isolated', 'impl-stdio-bridge');
    const socketPath = defaultBridgeSocketPath(isolatedHomeDir, 'impl-stdio-bridge');
    if (!(await unixSocketsAvailable(socketPath))) return;
    const bridgeLogPath = join(cwd, 'bridge.log');

    const pty = new FakePty();
    const engine = new ConductorEngine({
      pty,
      makeTransport: () => createSocketBridgeTransportPair(socketPath, bridgeLogPath),
      now: () => 0,
      quietWindow: neverResolve,
      injectOptions: { retryDelay: neverResolve },
    });
    engines.push(engine);

    const ensureP = engine.ensureHosted(identity);
    const pane = pty.panes[0]!;
    pane.emit(CLAUDE_READY);
    await ensureP;

    const bridgeInput = new PassThrough();
    const bridgeOutput = new PassThrough();
    const bridgeP = runSocketBridge(socketPath, {
      stdin: bridgeInput,
      stdout: bridgeOutput,
      diagnosticLogPath: bridgeLogPath,
    });
    const client = new Client({ name: 'co-stdio-bridge-test', version: '0.0.0' });
    clients.push(client);
    await client.connect(new StdioServerTransport(bridgeOutput, bridgeInput));

    const status = await client.callTool({ name: 'co_status', arguments: {} });
    expect((status.structuredContent as Record<string, unknown>).agent).toBe('impl-stdio-bridge');

    await client.close();
    bridgeInput.end();
    await bridgeP;

    const log = readFileSync(bridgeLogPath, 'utf8');
    expect(log).toContain('server_start socketPath=');
    expect(log).toContain('server_listening socketPath=');
    expect(log).toContain('server_socket socketPath=');
    expect(log).toContain('server_recv bytes=');
    expect(log).toContain('server_send bytes=');
    expect(log).toContain('start socketPath=');
    expect(log).toContain('connect_ok socketPath=');
    expect(log).toContain('stdin_data socketPath=');
    expect(log).toContain('socket_data socketPath=');
    expect(log).toContain('stdin_end socketPath=');
    expect(log).toContain('stop socketPath=');
  });

  it('bridges a fake Client through a Unix socket to the engine-hosted MCP server', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const identity = makeIdentity({ agent: 'impl-bridge', projectId, cwd });
    const isolatedHomeDir = join(cwd, 'isolated', 'impl-bridge');
    const socketPath = defaultBridgeSocketPath(isolatedHomeDir, 'impl-bridge');
    if (!(await unixSocketsAvailable(socketPath))) return;

    const pty = new FakePty();
    const engine = new ConductorEngine({
      pty,
      makeTransport: () => createSocketBridgeTransportPair(socketPath),
      now: () => 0,
      quietWindow: neverResolve,
      injectOptions: { retryDelay: neverResolve },
    });
    engines.push(engine);

    const ensureP = engine.ensureHosted(identity);
    const pane = pty.panes[0]!;
    pane.emit(CLAUDE_READY);
    const hosted = await ensureP;

    const client = new Client({ name: 'co-bridge-test', version: '0.0.0' });
    clients.push(client);
    await client.connect(hosted.clientTransport);

    const status = await client.callTool({ name: 'co_status', arguments: {} });
    expect((status.structuredContent as Record<string, unknown>).agent).toBe('impl-bridge');
  });

  it('rejects the client transport start when the socket cannot connect', async () => {
    const socketPath = defaultBridgeSocketPath(join(tmpdir(), 'co-bridge-missing'), 'impl-missing');
    const [clientTransport] = createSocketBridgeTransportPair(socketPath);

    await expect(clientTransport.start()).rejects.toThrow();
    await clientTransport.close?.();
  });

  it('treats bridge stdin EOF as abort semantics and does not wait for late socket output', async () => {
    const socketPath = defaultBridgeSocketPath(join(tmpdir(), 'co-bridge-stdin-eof'), 'impl-eof');
    if (!(await unixSocketsAvailable(socketPath))) return;
    const logDir = mkdtempSync(join(tmpdir(), 'co-bridge-eof-'));
    dataDirs.push(logDir);
    const bridgeLogPath = join(logDir, 'bridge.log');
    let acceptedSocket: Socket | undefined;
    let resolveAccepted: () => void = () => {};
    const acceptedP = new Promise<void>((resolve) => {
      resolveAccepted = resolve;
    });
    const server = createServer((socket) => {
      acceptedSocket = socket;
      resolveAccepted();
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });

    try {
      const bridgeInput = new PassThrough();
      const bridgeOutput = new PassThrough();
      let output = '';
      bridgeOutput.on('data', (chunk: Buffer | string) => {
        output += chunk.toString();
      });
      const bridgeP = runSocketBridge(socketPath, {
        stdin: bridgeInput,
        stdout: bridgeOutput,
        diagnosticLogPath: bridgeLogPath,
      });
      await acceptedP;

      bridgeInput.end();
      await bridgeP;
      if (acceptedSocket != null && !acceptedSocket.destroyed) {
        acceptedSocket.write('late-response\n');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(output).toBe('');
      expect(readFileSync(bridgeLogPath, 'utf8')).toContain('stdin_end socketPath=');
    } finally {
      acceptedSocket?.destroy?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        unlinkSync(socketPath);
      } catch {
        // Already removed.
      }
    }
  });

  it('keeps the hosted MCP server alive when one stdio bridge exits before the next starts', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const identity = makeIdentity({ agent: 'impl-bridge-restart', projectId, cwd });
    const isolatedHomeDir = join(cwd, 'isolated', 'impl-bridge-restart');
    const socketPath = defaultBridgeSocketPath(isolatedHomeDir, 'impl-bridge-restart');
    if (!(await unixSocketsAvailable(socketPath))) return;
    const bridgeLogPath = join(cwd, 'bridge-restart.log');

    const pty = new FakePty();
    const engine = new ConductorEngine({
      pty,
      makeTransport: () => createSocketBridgeTransportPair(socketPath, bridgeLogPath),
      now: () => 0,
      quietWindow: neverResolve,
      injectOptions: { retryDelay: neverResolve },
    });
    engines.push(engine);

    const ensureP = engine.ensureHosted(identity);
    const pane = pty.panes[0]!;
    pane.emit(CLAUDE_READY);
    await ensureP;

    for (const name of ['first', 'second']) {
      const bridgeInput = new PassThrough();
      const bridgeOutput = new PassThrough();
      const bridgeP = runSocketBridge(socketPath, {
        stdin: bridgeInput,
        stdout: bridgeOutput,
        diagnosticLogPath: bridgeLogPath,
      });
      const client = new Client({ name: `co-stdio-bridge-${name}`, version: '0.0.0' });
      clients.push(client);
      await client.connect(new StdioServerTransport(bridgeOutput, bridgeInput));

      const status = await client.callTool({ name: 'co_status', arguments: {} });
      expect((status.structuredContent as Record<string, unknown>).agent).toBe(
        'impl-bridge-restart',
      );

      await client.close();
      bridgeInput.end();
      await bridgeP;
    }

    const log = readFileSync(bridgeLogPath, 'utf8');
    expect(log.match(/server_socket socketPath=/g)).toHaveLength(2);
    expect(log.match(/server_send bytes=/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it('replaces a stale socket client when the provider refreshes its stdio bridge', async () => {
    const socketPath = defaultBridgeSocketPath(join(tmpdir(), 'co-bridge-extra'), 'impl-extra');
    if (!(await unixSocketsAvailable(socketPath))) return;

    const [, serverTransport] = createSocketBridgeTransportPair(socketPath);
    let closeCount = 0;
    let resolveServerClose: (() => void) | undefined;
    const serverCloseP = new Promise<void>((resolve) => {
      resolveServerClose = resolve;
    });
    serverTransport.onclose = () => {
      closeCount += 1;
      resolveServerClose?.();
    };
    await serverTransport.start();
    const first = createConnection(socketPath);
    await once(first, 'connect');

    const messageP = new Promise((resolve) => {
      serverTransport.onmessage = resolve;
    });
    const second = createConnection(socketPath);
    await once(second, 'connect');
    await once(first, 'close');

    expect(closeCount).toBe(0);

    second.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    await expect(messageP).resolves.toMatchObject({ id: 1, method: 'tools/list' });

    second.destroy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeCount).toBe(0);
    await serverTransport.close?.();
    await serverCloseP;
    expect(closeCount).toBe(1);
  });

  it('rejects a server send when a backpressured socket closes before draining', async () => {
    const socketPath = defaultBridgeSocketPath(join(tmpdir(), 'co-bridge-backpressure'), 'impl-bp');
    if (!(await unixSocketsAvailable(socketPath))) return;

    const [, serverTransport] = createSocketBridgeTransportPair(socketPath);
    await serverTransport.start();
    const client = createConnection(socketPath);
    await once(client, 'connect');

    const active = (serverTransport as unknown as { socket?: Writable }).socket;
    if (active == null) throw new Error('test expected an active socket transport.');
    active.write = (() => false) as typeof active.write;

    const sendP = serverTransport.send({ jsonrpc: '2.0', id: 1, result: {} });
    active.emit('close');

    await expect(sendP).rejects.toThrow(/closed before buffered write drained/i);
    client.destroy();
    await serverTransport.close?.();
  });

  it('repairs an owned pre-existing socket directory before listening', async () => {
    const socketPath = defaultBridgeSocketPath(join(tmpdir(), 'co-bridge-permissive'), 'impl-dir');
    if (!(await unixSocketsAvailable(socketPath))) return;
    const socketDir = dirname(socketPath);
    mkdirSync(socketDir, { recursive: true, mode: 0o777 });
    chmodSync(socketDir, 0o777);

    const [, serverTransport] = createSocketBridgeTransportPair(socketPath);
    try {
      await serverTransport.start();
      expect(statSync(socketDir).mode & 0o077).toBe(0);
    } finally {
      await serverTransport.close?.();
    }
  });

  it('refuses a symlinked socket directory before listening', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'co-bridge-symlink-'));
    dataDirs.push(dir);
    const target = join(dir, 'target');
    const link = join(dir, 'socket-dir');
    mkdirSync(target);
    symlinkSync(target, link, 'dir');
    const socketPath = join(link, 'bridge.sock');

    const [, serverTransport] = createSocketBridgeTransportPair(socketPath);

    await expect(serverTransport.start()).rejects.toThrow(/must not be a symlink/i);
    await serverTransport.close?.();
  });
});
