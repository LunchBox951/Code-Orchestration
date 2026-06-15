/**
 * Stage 11 P1 (OP-IPC · §3c) — the app-side operator-IPC CLIENT.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 * Two layers:
 *   - {@link OperatorIpcConnection} — the raw JSON-RPC client over a {@link SocketClientTransport}
 *     (the reused real-transport.ts framing): connect, call methods, subscribe to the `tick` push.
 *   - {@link OperatorIpcClient} — the small DEGRADATION FACADE the desktop app consumes. Hybrid reads
 *     (D5): live overlay when the socket is up, else a fall-back to the static `queryObservability`
 *     direct program-data read tagged "Conductor not running" — never a hang, never an unhandled throw
 *     (Principle 9 / MNR #3). Control + writes need the socket, so they degrade to a clear
 *     {@link ConductorUnavailableError}, not a crash. A reconnect resumes the push stream (the tick
 *     listeners live on the facade, across connections).
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 */
import {
  OPERATOR_IPC_METHODS,
  OPERATOR_IPC_TICK,
  queryObservability,
  type ApprovalReply,
  type DeliveredMail,
  type LiveObservabilitySnapshot,
  type ObservabilitySnapshot,
  type OperatorIpcConnectionState,
  type OperatorIpcSurface,
  type OperatorIpcTick,
  type OperatorMailRef,
  type OperatorObservation,
  type OperatorUnavailableReason,
  type ProjectId,
  type ReplyDraft,
  type Steer,
} from '@co/core';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { SocketClientTransport } from '../conductor/real-transport.js';
import { classifyIncoming, makeRequest, type WireId, type WirePayload } from './wire.js';

/** A pending in-flight request awaiting its response by id. */
interface PendingCall {
  readonly resolve: (result: WirePayload) => void;
  readonly reject: (error: Error) => void;
}

/**
 * The raw operator-IPC connection: a JSON-RPC client speaking {@link OperatorIpcSurface} over a single
 * Unix-socket {@link SocketClientTransport}. Calls resolve/reject by response id; the `tick` push fans
 * out to {@link onTick} listeners. A socket close rejects every in-flight call (never a hang) and fires
 * {@link onClose}.
 */
export class OperatorIpcConnection implements OperatorIpcSurface {
  private readonly transport: SocketClientTransport;
  private nextId = 1;
  private readonly pending = new Map<WireId, PendingCall>();
  private readonly tickListeners = new Set<(tick: OperatorIpcTick) => void>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;
  // Set the instant `close()` is entered (before its await), so a second concurrent close() — and any
  // new call() — short-circuits rather than driving a redundant transport.close(). `closed` proper is
  // still set only by handleClose(), which must run to reject in-flight calls + fire closeListeners.
  private closing = false;

  private constructor(transport: SocketClientTransport) {
    this.transport = transport;
    this.transport.onmessage = (message): void => this.onMessage(message);
    this.transport.onclose = (): void => this.handleClose();
  }

  /** Connect to `socketPath`. Rejects if the socket is absent/refused (the daemon is down). */
  static async connect(socketPath: string): Promise<OperatorIpcConnection> {
    const transport = new SocketClientTransport(socketPath);
    const connection = new OperatorIpcConnection(transport);
    await transport.start();
    return connection;
  }

  async observe(): Promise<LiveObservabilitySnapshot> {
    return (await this.call(
      OPERATOR_IPC_METHODS.observe,
      {},
    )) as unknown as LiveObservabilitySnapshot;
  }

  async pause(agentId: string): Promise<void> {
    await this.call(OPERATOR_IPC_METHODS.pause, { agentId });
  }

  async resume(agentId: string): Promise<void> {
    await this.call(OPERATOR_IPC_METHODS.resume, { agentId });
  }

  async stop(agentId: string): Promise<void> {
    await this.call(OPERATOR_IPC_METHODS.stop, { agentId });
  }

  async unstick(agentId: string): Promise<void> {
    await this.call(OPERATOR_IPC_METHODS.unstick, { agentId });
  }

  async steer(agentId: string, steer: Steer): Promise<void> {
    await this.call(OPERATOR_IPC_METHODS.steer, { agentId, steer } as unknown as WirePayload);
  }

  async reply(target: OperatorMailRef, draft: ReplyDraft): Promise<DeliveredMail> {
    const result = await this.call(OPERATOR_IPC_METHODS.reply, {
      target,
      draft,
    } as unknown as WirePayload);
    return result as unknown as DeliveredMail;
  }

  async approve(approvalSeq: number, reply: ApprovalReply): Promise<DeliveredMail> {
    const result = await this.call(OPERATOR_IPC_METHODS.approve, {
      approvalSeq,
      reply,
    } as unknown as WirePayload);
    return result as unknown as DeliveredMail;
  }

  /** Subscribe to the per-tick `tick` push; returns an unsubscribe fn. */
  onTick(listener: (tick: OperatorIpcTick) => void): () => void {
    this.tickListeners.add(listener);
    return () => this.tickListeners.delete(listener);
  }

  /** Register a one-shot-style close listener (fired once when the socket goes away). */
  onClose(listener: () => void): void {
    this.closeListeners.add(listener);
  }

  /** Close the socket (rejecting any in-flight calls via the close path). Idempotent + concurrency-safe. */
  async close(): Promise<void> {
    if (this.closed || this.closing) return;
    this.closing = true;
    await this.transport.close();
  }

  private call(method: string, params: WirePayload): Promise<WirePayload> {
    if (this.closed || this.closing) {
      return Promise.reject(new Error('operator IPC: connection is closed.'));
    }
    const id = this.nextId++;
    return new Promise<WirePayload>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport.send(makeRequest(id, method, params)).catch((error: unknown) => {
        if (this.pending.delete(id)) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  private onMessage(message: JSONRPCMessage): void {
    const incoming = classifyIncoming(message);
    switch (incoming.kind) {
      case 'result': {
        const pending = this.pending.get(incoming.id);
        if (pending != null) {
          this.pending.delete(incoming.id);
          pending.resolve(incoming.result);
        }
        return;
      }
      case 'error': {
        const pending = this.pending.get(incoming.id);
        if (pending != null) {
          this.pending.delete(incoming.id);
          pending.reject(new Error(incoming.error.message));
        }
        return;
      }
      case 'notification': {
        if (incoming.method === OPERATOR_IPC_TICK) {
          const tick = incoming.params as unknown as OperatorIpcTick;
          for (const listener of [...this.tickListeners]) listener(tick);
        }
        return;
      }
      default:
        // The client never receives requests; `unknown` is ignored.
        return;
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    // Never leave a caller hanging: reject every in-flight call (Principle 9 / MNR #3).
    const error = new Error('operator IPC: connection closed before the response arrived.');
    for (const pending of [...this.pending.values()]) pending.reject(error);
    this.pending.clear();
    for (const listener of [...this.closeListeners]) listener();
  }
}

/**
 * Raised by the facade when a control verb or mail write is attempted while the Conductor socket is
 * down. A CLEAR, catchable signal (Principle 9) — the app renders "needs Conductor", it does not crash.
 */
export class ConductorUnavailableError extends Error {
  readonly reason: OperatorUnavailableReason;

  constructor(message: string, reason: OperatorUnavailableReason = 'conductor-not-running') {
    super(message);
    this.name = 'ConductorUnavailableError';
    this.reason = reason;
  }
}

/** Constructor seams for {@link OperatorIpcClient} (the degradation facade). */
export interface OperatorIpcClientDeps {
  /** The project whose static rollup backs a degraded read. */
  readonly projectId: ProjectId;
  /** The operator-IPC socket path (where `co serve` listens). */
  readonly socketPath: string;
  /** Connect seam (default: {@link OperatorIpcConnection.connect}). Injectable for tests. */
  readonly connect?: (socketPath: string) => Promise<OperatorIpcConnection>;
  /** Static read seam for degraded reads (default: {@link queryObservability}). */
  readonly queryStatic?: (projectId: ProjectId) => ObservabilitySnapshot;
  /** Connection-state diagnostic seam (connected ⇄ disconnected). Default: none. */
  readonly onState?: (state: OperatorIpcConnectionState) => void;
  /**
   * Diagnostic seam for an UNEXPECTED error during a read — e.g. a daemon-side `observe` failure or a
   * malformed response, as opposed to an ordinary connection drop (which degrades silently per D5).
   * Surfaced rather than swallowed so a real fault is not masked as "Conductor not running". Default: none.
   */
  readonly onError?: (error: unknown) => void;
}

/**
 * The app-facing degradation facade (D5). Manages one lazily-(re)established {@link OperatorIpcConnection}
 * and degrades gracefully when it is absent:
 *   - {@link observe} returns a LIVE overlay when connected, else the STATIC rollup tagged
 *     "Conductor not running" — never a hang, never a throw.
 *   - control + write verbs need the socket: they throw a clear {@link ConductorUnavailableError} when
 *     it is down.
 *   - {@link onTick} listeners live on the facade, so a reconnect RESUMES the push stream.
 */
export class OperatorIpcClient {
  private readonly projectId: ProjectId;
  private readonly socketPath: string;
  private readonly connectFn: (socketPath: string) => Promise<OperatorIpcConnection>;
  private readonly queryStatic: (projectId: ProjectId) => ObservabilitySnapshot;
  private readonly onState: ((state: OperatorIpcConnectionState) => void) | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private connection: OperatorIpcConnection | null = null;
  private connecting: Promise<OperatorIpcConnection | null> | null = null;
  private readonly tickListeners = new Set<(tick: OperatorIpcTick) => void>();
  private closed = false;

  constructor(deps: OperatorIpcClientDeps) {
    this.projectId = deps.projectId;
    this.socketPath = deps.socketPath;
    this.connectFn = deps.connect ?? ((socketPath) => OperatorIpcConnection.connect(socketPath));
    this.queryStatic = deps.queryStatic ?? queryObservability;
    this.onState = deps.onState;
    this.onError = deps.onError;
  }

  /** Whether a live socket is currently attached. */
  get connected(): boolean {
    return this.connection != null;
  }

  /** Attempt to (re)connect; resolves true if a live socket is attached, false if degraded. */
  async connect(): Promise<boolean> {
    return (await this.ensureConnection()) != null;
  }

  /**
   * Hybrid read (D5): the LIVE overlay when the socket is up; otherwise the STATIC rollup tagged
   * "Conductor not running". Never hangs, never throws.
   */
  async observe(): Promise<OperatorObservation> {
    const connection = await this.ensureConnection();
    if (connection != null) {
      try {
        return { kind: 'live', snapshot: await connection.observe() };
      } catch (error) {
        // A socket drop nulls the connection (an ordinary degrade — silent per D5/MNR #3). Any OTHER
        // error (a daemon-side observe failure, a malformed response) is unexpected: surface it for
        // diagnostics rather than masking a real fault as "Conductor not running". Still fall through
        // to the static read — never hang, never throw.
        if (this.connection != null) this.report(error);
      }
    }
    return {
      kind: 'static',
      snapshot: this.queryStatic(this.projectId),
      reason: 'conductor-not-running',
    };
  }

  async pause(agentId: string): Promise<void> {
    await this.withConnection((c) => c.pause(agentId));
  }

  async resume(agentId: string): Promise<void> {
    await this.withConnection((c) => c.resume(agentId));
  }

  async stop(agentId: string): Promise<void> {
    await this.withConnection((c) => c.stop(agentId));
  }

  async unstick(agentId: string): Promise<void> {
    await this.withConnection((c) => c.unstick(agentId));
  }

  async steer(agentId: string, steer: Steer): Promise<void> {
    await this.withConnection((c) => c.steer(agentId, steer));
  }

  reply(target: OperatorMailRef, draft: ReplyDraft): Promise<DeliveredMail> {
    return this.withConnection((c) => c.reply(target, draft));
  }

  approve(approvalSeq: number, reply: ApprovalReply): Promise<DeliveredMail> {
    return this.withConnection((c) => c.approve(approvalSeq, reply));
  }

  /** Subscribe to the per-tick push; survives reconnects. Returns an unsubscribe fn. */
  onTick(listener: (tick: OperatorIpcTick) => void): () => void {
    this.tickListeners.add(listener);
    return () => this.tickListeners.delete(listener);
  }

  /** Close the facade and its connection; stops reconnecting. */
  async close(): Promise<void> {
    this.closed = true;
    const connection = this.connection;
    this.connection = null;
    if (connection != null) await connection.close();
  }

  /** Run a control/write verb, mapping "no socket" / "socket dropped" to a clear error. */
  private async withConnection<T>(
    run: (connection: OperatorIpcConnection) => Promise<T>,
  ): Promise<T> {
    const connection = await this.ensureConnection();
    if (connection == null) {
      throw new ConductorUnavailableError(
        'operator IPC: the Conductor is not running — control and mail writes need `co serve`.',
      );
    }
    try {
      return await run(connection);
    } catch (error) {
      if (this.connection == null) {
        // The socket dropped during the call — a clear "needs Conductor", not a raw socket error.
        throw new ConductorUnavailableError(
          'operator IPC: lost the Conductor connection mid-call — retry once it is back.',
        );
      }
      throw error;
    }
  }

  private async ensureConnection(): Promise<OperatorIpcConnection | null> {
    if (this.closed) return null;
    if (this.connection != null) return this.connection;
    if (this.connecting != null) return this.connecting;
    this.connecting = this.openConnection();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async openConnection(): Promise<OperatorIpcConnection | null> {
    try {
      const connection = await this.connectFn(this.socketPath);
      if (this.closed) {
        await connection.close();
        return null;
      }
      connection.onTick((tick) => this.fanOutTick(tick));
      connection.onClose(() => this.handleDisconnect(connection));
      this.connection = connection;
      this.emitState('connected');
      return connection;
    } catch {
      // Daemon down / socket absent — degraded, not an error (D5 / MNR #3).
      return null;
    }
  }

  private handleDisconnect(connection: OperatorIpcConnection): void {
    if (this.connection !== connection) return; // a stale connection's close — ignore
    this.connection = null;
    if (this.closed) return;
    this.emitState('disconnected');
  }

  private fanOutTick(tick: OperatorIpcTick): void {
    for (const listener of [...this.tickListeners]) listener(tick);
  }

  private emitState(state: OperatorIpcConnectionState): void {
    try {
      this.onState?.(state);
    } catch {
      /* a diagnostic callback must never break the client */
    }
  }

  private report(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      /* a diagnostic callback must never break the client */
    }
  }
}
