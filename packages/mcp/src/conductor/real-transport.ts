/**
 * P4 (Stage 10 · AC-S10-4·1) — stream-backed MCP transport seams for the Conductor engine.
 *
 * `createStreamTransportPair()` is the in-process, stream-serialized sandbox pair used by fake clients.
 * `createSocketBridgeTransportPair()` is the host-live pair: the engine hosts the server side on a Unix
 * socket, while the real provider spawns `co-mcp bridge <socket>` as its stdio MCP server.
 */
import {
  appendFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { once } from 'node:events';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { TransportPair } from './engine.js';

/**
 * Create a stream-backed {@link TransportPair} for one MCP bind.
 *
 * Two `PassThrough` pipes cross-link the sides:
 * - `c2s`: client writes → server reads (client→server direction)
 * - `s2c`: server writes → client reads (server→client direction)
 *
 * Both transports are {@link StdioServerTransport} instances backed by these pipes, giving the pair
 * a real JSON-RPC line-framing path. The returned pair is `[clientTransport, serverTransport]`,
 * matching the {@link TransportPair} convention the engine expects.
 *
 * @returns `[clientTransport, serverTransport]` — the engine hands the server side to
 *   `host.hostSession`; a provider's MCP client (or a fake `Client` in-sandbox) attaches to the
 *   client side.
 */
export function createStreamTransportPair(): TransportPair {
  const c2s = new PassThrough();
  const s2c = new PassThrough();

  // serverTransport: reads from the client→server pipe, writes to the server→client pipe.
  const serverTransport = new StdioServerTransport(c2s, s2c);
  // clientTransport: reads from the server→client pipe, writes to the client→server pipe.
  const clientTransport = new StdioServerTransport(s2c, c2s);

  return [clientTransport, serverTransport];
}

export function createSocketBridgeTransportPair(
  socketPath: string,
  diagnosticLogPath?: string,
): TransportPair {
  const diagnostics = new SocketBridgeDiagnostics(diagnosticLogPath);
  return [
    new SocketClientTransport(socketPath),
    new SocketServerTransport(socketPath, diagnostics),
  ];
}

export interface SocketConnectRetryOptions {
  readonly retryDelayMs?: number;
  readonly timeoutMs?: number;
}

export async function connectSocketWithRetry(
  socketPath: string,
  opts: SocketConnectRetryOptions = {},
): Promise<Socket> {
  const retryDelayMs = opts.retryDelayMs ?? 50;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  let lastError: Error | undefined;

  for (;;) {
    try {
      return await connectSocketOnce(socketPath);
    } catch (error) {
      if (!isRetryableConnectError(error)) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `co-mcp bridge: timed out connecting to socket '${socketPath}' after ` +
            `${timeoutMs}ms: ${lastError.message}`,
          { cause: error },
        );
      }
      await sleep(Math.min(retryDelayMs, remaining));
    }
  }
}

export interface SocketBridgeStreams {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly diagnosticLogPath?: string;
}

export async function runSocketBridge(
  socketPath: string,
  streams: SocketBridgeStreams = { stdin: process.stdin, stdout: process.stdout },
): Promise<void> {
  const diagnostics = new SocketBridgeDiagnostics(
    streams.diagnosticLogPath ?? process.env['CO_MCP_BRIDGE_LOG'],
  );
  diagnostics.write('start', { socketPath, pid: String(process.pid) });
  let socket: Socket;
  try {
    socket = await connectSocketWithRetry(socketPath);
  } catch (error) {
    diagnostics.write('connect_error', errorDiagnosticFields(error));
    throw error;
  }
  diagnostics.write('connect_ok', { socketPath });
  let stdinBytes = 0;
  let stdinChunks = 0;
  let socketBytes = 0;
  let socketChunks = 0;
  const onStdinData = (chunk: Buffer | string): void => {
    stdinChunks += 1;
    stdinBytes += byteLength(chunk);
    diagnostics.write('stdin_data', {
      socketPath,
      chunks: String(stdinChunks),
      totalBytes: String(stdinBytes),
      bytes: String(byteLength(chunk)),
    });
  };
  const onSocketData = (chunk: Buffer | string): void => {
    socketChunks += 1;
    socketBytes += byteLength(chunk);
    diagnostics.write('socket_data', {
      socketPath,
      chunks: String(socketChunks),
      totalBytes: String(socketBytes),
      bytes: String(byteLength(chunk)),
    });
  };
  const onSocketError = (error: Error): void => {
    diagnostics.write('socket_error', errorDiagnosticFields(error));
  };
  streams.stdin.on('data', onStdinData);
  socket.on('data', onSocketData);
  socket.on('error', onSocketError);
  streams.stdin.pipe(socket);
  socket.pipe(streams.stdout);
  try {
    // Provider stdin EOF means the stdio MCP process is shutting down. Treat it as bridge abort
    // semantics: stop this bridge promptly rather than waiting for unrelated future socket output.
    const reason = await Promise.race([
      once(socket, 'close').then(() => 'socket_close' as const),
      once(streams.stdin, 'end').then(() => 'stdin_end' as const),
    ]);
    diagnostics.write(reason, { socketPath });
  } finally {
    streams.stdin.off('data', onStdinData);
    socket.off('data', onSocketData);
    socket.off('error', onSocketError);
    streams.stdin.unpipe(socket);
    socket.unpipe(streams.stdout);
    if (!socket.destroyed) socket.end();
    diagnostics.write('stop', { socketPath });
  }
}

export async function runSocketBridgeCommand(argv: readonly string[]): Promise<void> {
  const socketPath = argv[0]?.trim();
  if (socketPath == null || socketPath.length === 0) {
    throw new Error('co-mcp bridge: socket path is required (usage: co-mcp bridge <socketPath>).');
  }
  await runSocketBridge(socketPath);
}

function connectSocketOnce(socketPath: string): Promise<Socket> {
  const socket = createConnection(socketPath);
  return new Promise<Socket>((resolve, reject) => {
    const onConnect = (): void => {
      socket.off('error', onError);
      resolve(socket);
    };
    const onError = (error: Error): void => {
      socket.off('connect', onConnect);
      socket.destroy();
      reject(error);
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

function isRetryableConnectError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ECONNREFUSED';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function byteLength(chunk: Buffer | string): number {
  return typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.length;
}

class SocketBridgeDiagnostics {
  constructor(private readonly logPath: string | undefined) {}

  write(event: string, fields: Readonly<Record<string, string>> = {}): void {
    if (this.logPath == null || this.logPath.trim().length === 0) return;
    try {
      mkdirSync(dirname(this.logPath), { recursive: true });
      const suffix = Object.entries(fields)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join(' ');
      appendFileSync(
        this.logPath,
        `[${new Date().toISOString()}] ${event}${suffix.length > 0 ? ` ${suffix}` : ''}\n`,
      );
    } catch {
      // Diagnostics must never break the MCP protocol path.
    }
  }
}

function errorDiagnosticFields(error: unknown): Record<string, string> {
  const errno = error as NodeJS.ErrnoException | undefined;
  return {
    code: errno?.code ?? 'ERROR',
    message: error instanceof Error ? error.message : String(error),
  };
}

class SocketLineBuffer {
  private buffer: Buffer = Buffer.alloc(0);

  append(chunk: Buffer | string): void {
    const next = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    this.buffer = this.buffer.length === 0 ? next : Buffer.concat([this.buffer, next]);
  }

  read(): JSONRPCMessage | undefined {
    const index = this.buffer.indexOf('\n');
    if (index < 0) return undefined;
    const line = this.buffer.toString('utf8', 0, index).replace(/\r$/u, '');
    this.buffer = this.buffer.subarray(index + 1);
    return JSONRPCMessageSchema.parse(JSON.parse(line));
  }

  clear(): void {
    this.buffer = Buffer.alloc(0);
  }
}

function serializedMessage(message: JSONRPCMessage): string {
  return JSON.stringify(message) + '\n';
}

function writeSerializedMessage(out: Writable, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      out.off('drain', onDrain);
      out.off('error', onError);
      out.off('close', onClose);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error != null) reject(error);
      else resolve();
    };
    const onDrain = (): void => finish();
    const onError = (error: Error): void => finish(error);
    const onClose = (): void => {
      finish(new Error('Socket transport closed before buffered write drained.'));
    };

    out.once('drain', onDrain);
    out.once('error', onError);
    out.once('close', onClose);

    try {
      if (out.write(message)) {
        finish();
        return;
      }
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
      return;
    }
  });
}

abstract class SocketTransportBase implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly readBuffer = new SocketLineBuffer();
  protected socket: Socket | undefined;

  constructor(
    private readonly diagnosticPrefix: string,
    protected readonly diagnostics: SocketBridgeDiagnostics = new SocketBridgeDiagnostics(
      undefined,
    ),
  ) {}

  /** Whether a peer socket is currently attached (operator-IPC uses this to skip a no-consumer push). */
  get connected(): boolean {
    return this.socket != null;
  }

  protected attachSocket(socket: Socket): void {
    this.readBuffer.clear();
    this.socket = socket;
    socket.on('data', (chunk) => {
      if (this.socket === socket) {
        this.diagnostics.write(`${this.diagnosticPrefix}_recv`, {
          bytes: String(byteLength(chunk)),
        });
        this.processChunk(chunk);
      } else {
        this.diagnostics.write(`${this.diagnosticPrefix}_stale_recv`, {
          bytes: String(byteLength(chunk)),
        });
      }
    });
    socket.on('error', (error) => {
      if (this.socket === socket) {
        this.diagnostics.write(
          `${this.diagnosticPrefix}_socket_error`,
          errorDiagnosticFields(error),
        );
        this.onerror?.(error);
      }
    });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.diagnostics.write(`${this.diagnosticPrefix}_socket_close`);
      this.handleActiveSocketClose();
    });
  }

  protected handleActiveSocketClose(): void {
    this.onclose?.();
  }

  protected processChunk(chunk: Buffer | string): void {
    this.readBuffer.append(chunk);
    let messages = 0;
    for (;;) {
      try {
        const message = this.readBuffer.read();
        if (message == null) break;
        messages += 1;
        this.onmessage?.(message);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.diagnostics.write(
          `${this.diagnosticPrefix}_parse_error`,
          errorDiagnosticFields(error),
        );
        this.onerror?.(error);
      }
    }
    if (messages > 0) {
      this.diagnostics.write(`${this.diagnosticPrefix}_messages`, { count: String(messages) });
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.socket == null) throw new Error('Socket transport is not connected.');
    const serialized = serializedMessage(message);
    this.diagnostics.write(`${this.diagnosticPrefix}_send`, {
      bytes: String(Buffer.byteLength(serialized, 'utf8')),
    });
    await writeSerializedMessage(this.socket, serialized);
  }

  async close(): Promise<void> {
    this.readBuffer.clear();
    const socket = this.socket;
    this.socket = undefined;
    if (socket != null && !socket.destroyed) socket.end();
    this.diagnostics.write(`${this.diagnosticPrefix}_close`);
    this.onclose?.();
  }

  abstract start(): Promise<void>;
}

export class SocketServerTransport extends SocketTransportBase {
  private server: Server | undefined;
  private started = false;

  constructor(
    private readonly socketPath: string,
    diagnostics: SocketBridgeDiagnostics = new SocketBridgeDiagnostics(undefined),
  ) {
    super('server', diagnostics);
  }

  protected override handleActiveSocketClose(): void {
    // The provider can restart its stdio bridge while the hosted MCP session remains live.
    // A socket close only detaches that bridge client; `close()` tears down the MCP transport.
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('SocketServerTransport already started.');
    this.started = true;
    this.diagnostics.write('server_start', { socketPath: this.socketPath });
    ensurePrivateSocketDirectory(this.socketPath);
    try {
      unlinkSync(this.socketPath);
    } catch {
      // No stale socket to remove.
    }
    this.server = createServer((socket) => {
      const previous = this.socket;
      this.diagnostics.write('server_socket', {
        socketPath: this.socketPath,
        hadPrevious: String(previous != null),
      });
      this.attachSocket(socket);
      if (previous != null && !previous.destroyed) {
        this.diagnostics.write('server_replace', { socketPath: this.socketPath });
        previous.end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      const server = this.server!;
      const onError = (error: Error): void => {
        server.off('listening', onListening);
        this.diagnostics.write('server_error', errorDiagnosticFields(error));
        reject(error);
      };
      const onListening = (): void => {
        server.off('error', onError);
        this.diagnostics.write('server_listening', { socketPath: this.socketPath });
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.socketPath);
    });
  }

  override async close(): Promise<void> {
    await super.close();
    const server = this.server;
    this.server = undefined;
    if (server != null) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    try {
      unlinkSync(this.socketPath);
    } catch {
      // Already removed or never materialized.
    }
    try {
      rmdirSync(dirname(this.socketPath));
    } catch {
      // Custom socket directories may be non-empty or host-owned.
    }
    this.diagnostics.write('server_stop', { socketPath: this.socketPath });
  }
}

function ensurePrivateSocketDirectory(socketPath: string): void {
  const socketDir = dirname(socketPath);
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  const dirEntry = lstatSync(socketDir);
  if (dirEntry.isSymbolicLink()) {
    throw new Error(`Socket transport directory '${socketDir}' must not be a symlink.`);
  }
  const stat = statSync(socketDir);
  if (!stat.isDirectory()) {
    throw new Error(`Socket transport directory '${socketDir}' is not a directory.`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(
      `Socket transport directory '${socketDir}' is owned by uid ${stat.uid}, expected ` +
        `${process.getuid()}.`,
    );
  }
  if ((stat.mode & 0o077) !== 0) {
    chmodSync(socketDir, 0o700);
    const repaired = statSync(socketDir);
    if ((repaired.mode & 0o077) !== 0) {
      throw new Error(`Socket transport directory '${socketDir}' is not private.`);
    }
  }
}

export class SocketClientTransport extends SocketTransportBase {
  private started = false;

  constructor(private readonly socketPath: string) {
    super('client');
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('SocketClientTransport already started.');
    this.started = true;
    const socket = createConnection(this.socketPath);
    this.attachSocket(socket);
    try {
      await waitForSocketConnect(socket, this.socketPath);
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }
}

function waitForSocketConnect(socket: Socket, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      socket.off('connect', onConnect);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onConnect = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error(`Socket transport closed before connecting to '${socketPath}'.`));
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}
