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
  assertNever,
  OPERATOR_IPC_METHODS,
  OPERATOR_IPC_TICK,
  OPERATOR_IPC_TRANSCRIPT,
  openArchiveStore,
  queryObservability,
  type ApprovalReply,
  type ArchiveEntry,
  type DeliveredMail,
  type LiveObservabilitySnapshot,
  type ObservabilitySnapshot,
  type OperatorIpcConnectionState,
  type OperatorIpcSurface,
  type OperatorIpcTick,
  type OperatorIpcTranscript,
  type OperatorMailRef,
  type OperatorObservation,
  type OperatorUnavailableReason,
  type ProjectId,
  type ReplyDraft,
  type ReviewContext,
  type StartSessionParams,
  type StartSessionResult,
  type Steer,
  type TranscriptTail,
} from '@co/core';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { SocketClientTransport } from '../conductor/real-transport.js';
import { classifyIncoming, makeRequest, type WireId, type WirePayload } from './wire.js';

const EXPECTED_CONNECT_UNAVAILABLE_CODES = new Set(['ENOENT', 'ECONNREFUSED']);

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error != null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isExpectedConnectUnavailable(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && EXPECTED_CONNECT_UNAVAILABLE_CODES.has(code);
}

function archiveEntriesFromStore(projectId: ProjectId): readonly ArchiveEntry[] {
  const archive = openArchiveStore(projectId);
  try {
    return archive.listRecords().map((record) => ({
      id: record.id,
      name: record.name,
      branch: record.branch,
      baseRef: record.baseRef,
      deletedAt: record.deletedAt,
      expiresAt: record.expiresAt,
    }));
  } finally {
    archive.close();
  }
}

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
  private readonly transcriptListeners = new Set<(transcript: OperatorIpcTranscript) => void>();
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

  async operatorMessage(agentId: string, subject: string, body: string): Promise<DeliveredMail> {
    const result = await this.call(OPERATOR_IPC_METHODS.operatorMessage, {
      agentId,
      subject,
      body,
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

  async markRead(recipient: string, seq: number): Promise<DeliveredMail> {
    const result = await this.call(OPERATOR_IPC_METHODS.markRead, {
      recipient,
      seq,
    } as unknown as WirePayload);
    return result as unknown as DeliveredMail;
  }

  /** Stage 12 C-P1 — fetch `agentId`'s bounded transcript tail on demand (mirrors {@link observe}). */
  async transcript(agentId: string): Promise<TranscriptTail> {
    return (await this.call(OPERATOR_IPC_METHODS.transcript, {
      agentId,
    })) as unknown as TranscriptTail;
  }

  /** Stage 13 R-A — resolve `reviewId`'s review context on demand (mirrors {@link transcript}). */
  async reviewContext(reviewId: string): Promise<ReviewContext> {
    return (await this.call(OPERATOR_IPC_METHODS.reviewContext, {
      reviewId,
    })) as unknown as ReviewContext;
  }

  /** Stage 14 P4 — start a ROOT coordinator session (operator-only; mirrors {@link reviewContext}). */
  async startSession(params: StartSessionParams): Promise<StartSessionResult> {
    return (await this.call(OPERATOR_IPC_METHODS.startSession, {
      ...(params.name != null ? { name: params.name } : {}),
      ...(params.prompt != null ? { prompt: params.prompt } : {}),
      ...(params.specBody != null ? { specBody: params.specBody } : {}),
    } as unknown as WirePayload)) as unknown as StartSessionResult;
  }

  /** B4 — delete `agentId` and its entire subtree (recursive; cascade via the daemon's control surface). */
  async deleteAgent(agentId: string): Promise<void> {
    await this.call(OPERATOR_IPC_METHODS.deleteAgent, { agentId });
  }

  /** B4 — re-wake `agentId`: post follow-up mail, then clear suppression. */
  async rewake(agentId: string, message: string): Promise<DeliveredMail> {
    return (await this.call(OPERATOR_IPC_METHODS.rewake, {
      agentId,
      message,
    } as unknown as WirePayload)) as unknown as DeliveredMail;
  }

  /** Stage 15 §7 — send raw keystroke bytes into `agentId`'s warm PTY stdin. */
  async sendInput(agentId: string, data: string): Promise<void> {
    await this.call(OPERATOR_IPC_METHODS.sendInput, { agentId, data } as unknown as WirePayload);
  }

  /** Stage 15 §7 — resize `agentId`'s warm PTY to `cols` × `rows`. */
  async resize(agentId: string, cols: number, rows: number): Promise<void> {
    await this.call(OPERATOR_IPC_METHODS.resize, {
      agentId,
      cols,
      rows,
    } as unknown as WirePayload);
  }

  /** B5 — list archived branches (the cross-process read; static-store fallback by the facade). */
  async listArchive(): Promise<readonly ArchiveEntry[]> {
    // The server wraps the array in { entries } so the result is an object (JSON-RPC 2.0 constraint).
    const result = await this.call(OPERATOR_IPC_METHODS.listArchive, {});
    return (result as unknown as { entries: readonly ArchiveEntry[] }).entries;
  }

  /** B5 — un-archive `id`: remove the archive record (branch stays). Fails loud when down. */
  async restoreArchive(id: string): Promise<void> {
    await this.call(OPERATOR_IPC_METHODS.restoreArchive, { id } as unknown as WirePayload);
  }

  /** B5 — hard-purge `id`: `git branch -D <branch>` then remove the archive record. Fails loud when down. */
  async purgeArchive(id: string): Promise<void> {
    await this.call(OPERATOR_IPC_METHODS.purgeArchive, { id } as unknown as WirePayload);
  }

  /** Subscribe to the per-tick `tick` push; returns an unsubscribe fn. */
  onTick(listener: (tick: OperatorIpcTick) => void): () => void {
    this.tickListeners.add(listener);
    return () => this.tickListeners.delete(listener);
  }

  /** Stage 12 C-P1 — subscribe to the `transcript:push` stream; returns an unsubscribe fn. */
  onTranscript(listener: (transcript: OperatorIpcTranscript) => void): () => void {
    this.transcriptListeners.add(listener);
    return () => this.transcriptListeners.delete(listener);
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
          this.fanOutTick(tick);
        } else if (incoming.method === OPERATOR_IPC_TRANSCRIPT) {
          const transcript = incoming.params as unknown as OperatorIpcTranscript;
          this.fanOutTranscript(transcript);
        }
        return;
      }
      case 'request':
      case 'unknown':
        // The client never receives requests; unclassified messages are ignored.
        return;
      default:
        return assertNever(incoming);
    }
  }

  private fanOutTick(tick: OperatorIpcTick): void {
    for (const listener of [...this.tickListeners]) {
      try {
        listener(tick);
      } catch {
        /* push subscribers are app surfaces; one bad callback must not starve later listeners */
      }
    }
  }

  private fanOutTranscript(transcript: OperatorIpcTranscript): void {
    for (const listener of [...this.transcriptListeners]) {
      try {
        listener(transcript);
      } catch {
        /* push subscribers are app surfaces; one bad callback must not starve later listeners */
      }
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    // Never leave a caller hanging: reject every in-flight call (Principle 9 / MNR #3).
    const error = new Error('operator IPC: connection closed before the response arrived.');
    for (const pending of [...this.pending.values()]) pending.reject(error);
    this.pending.clear();
    for (const listener of [...this.closeListeners]) {
      try {
        listener();
      } catch {
        /* close subscribers are app surfaces; one bad callback must not starve later listeners */
      }
    }
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
  /** The operator-IPC socket path (where `co-mcp serve <projectId>` listens). */
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
  private readonly transcriptListeners = new Set<(transcript: OperatorIpcTranscript) => void>();
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

  /**
   * Send a fresh operator message to `agentId` (a `clarify_request` from `@operator`). A WRITE verb that
   * needs the socket — if the Conductor is down it throws a clear {@link ConductorUnavailableError}
   * (Principle 9). The daemon wakes the recipient on its next tick even when it is idle/cold.
   */
  operatorMessage(agentId: string, subject: string, body: string): Promise<DeliveredMail> {
    return this.withConnection((c) => c.operatorMessage(agentId, subject, body));
  }

  approve(approvalSeq: number, reply: ApprovalReply): Promise<DeliveredMail> {
    return this.withConnection((c) => c.approve(approvalSeq, reply));
  }

  markRead(recipient: string, seq: number): Promise<DeliveredMail> {
    return this.withConnection((c) => c.markRead(recipient, seq));
  }

  /**
   * Stage 12 C-P1 — fetch `agentId`'s bounded transcript tail. DEGRADES cleanly like a hybrid read
   * (Principle 9 / MNR #3): with NO socket it returns an EMPTY tail (`{ agentId, generation: 0,
   * offset: 0, tail: '' }`) rather than hanging or throwing — the renderer shows nothing until the Conductor is back. A live socket
   * returns the daemon's bounded tail; an UNEXPECTED daemon-side fault is surfaced to `onError` (not
   * masked as "down") while still degrading to an empty tail.
   */
  async transcript(agentId: string): Promise<TranscriptTail> {
    const connection = await this.ensureConnection();
    if (connection != null) {
      try {
        return await connection.transcript(agentId);
      } catch (error) {
        // A socket drop nulls the connection (an ordinary degrade — silent per D5/MNR #3). Any OTHER
        // error is unexpected: surface it for diagnostics rather than masking a real fault. Either way
        // fall through to an empty tail — never hang, never throw.
        if (this.connection != null) this.report(error);
      }
    }
    return { agentId, generation: 0, offset: 0, tail: '' };
  }

  /**
   * Stage 13 R-A — resolve `reviewId`'s review context for the in-app Review view. DEGRADES EXACTLY
   * like {@link transcript} (Principle 9 / MNR #3): with NO socket / on a connection drop it returns
   * the explicit `{ kind: 'conductor-down', reviewId }` state (never hangs, never throws); an
   * UNEXPECTED daemon fault is surfaced to `onError` (not masked as "down") while STILL degrading.
   */
  async reviewContext(reviewId: string): Promise<ReviewContext> {
    const connection = await this.ensureConnection();
    if (connection != null) {
      try {
        return await connection.reviewContext(reviewId);
      } catch (error) {
        if (this.connection != null) this.report(error);
      }
    }
    return { kind: 'conductor-down', reviewId };
  }

  /**
   * Stage 14 P4 — start a ROOT coordinator session (operator-only; wraps the core primitive). Unlike
   * observe/transcript, this is a WRITE verb that requires the socket; if the Conductor is down it
   * throws a clear {@link ConductorUnavailableError} (Principle 9 — control needs the daemon).
   */
  async startSession(params: StartSessionParams): Promise<StartSessionResult> {
    return this.withConnection((c) => c.startSession(params));
  }

  /**
   * B4 — delete `agentId` and its entire subtree. A control verb: throws a clear
   * {@link ConductorUnavailableError} when the Conductor socket is down (Principle 9).
   */
  async deleteAgent(agentId: string): Promise<void> {
    await this.withConnection((c) => c.deleteAgent(agentId));
  }

  /**
   * B4 — re-wake `agentId`: post follow-up mail, then clear suppression. A
   * control verb: throws a clear {@link ConductorUnavailableError} when the socket is down (Principle 9).
   */
  rewake(agentId: string, message: string): Promise<DeliveredMail> {
    return this.withConnection((c) => c.rewake(agentId, message));
  }

  /** Stage 15 §7 — send raw keystroke bytes into `agentId`'s warm PTY stdin. */
  async sendInput(agentId: string, data: string): Promise<void> {
    await this.withConnection((c) => c.sendInput(agentId, data));
  }

  /** Stage 15 §7 — resize `agentId`'s warm PTY to `cols` × `rows`. */
  async resize(agentId: string, cols: number, rows: number): Promise<void> {
    await this.withConnection((c) => c.resize(agentId, cols, rows));
  }

  /**
   * B5 — list archived branches. READ/degrade (mirrors {@link observe}): with NO socket it reads the
   * static archive store rather than hiding preserved branches. A live socket returns the daemon's list.
   */
  async listArchive(): Promise<readonly ArchiveEntry[]> {
    const connection = await this.ensureConnection();
    if (connection != null) {
      try {
        return await connection.listArchive();
      } catch (error) {
        // A socket drop nulls the connection — ordinary degrade (silent per D5/MNR #3). Any OTHER error
        // is unexpected: surface it for diagnostics rather than masking a real fault. Either way fall
        // through to the empty list — never hang, never throw.
        if (this.connection != null) this.report(error);
      }
    }
    return archiveEntriesFromStore(this.projectId);
  }

  /**
   * B5 — un-archive `id`: remove the archive record (branch stays). A control verb: throws a clear
   * {@link ConductorUnavailableError} when the Conductor socket is down (Principle 9).
   */
  async restoreArchive(id: string): Promise<void> {
    await this.withConnection((c) => c.restoreArchive(id));
  }

  /**
   * B5 — hard-purge `id`: `git branch -D <branch>` then remove the archive record. A control verb:
   * throws a clear {@link ConductorUnavailableError} when the Conductor socket is down (Principle 9).
   */
  async purgeArchive(id: string): Promise<void> {
    await this.withConnection((c) => c.purgeArchive(id));
  }

  /** Subscribe to the per-tick push; survives reconnects. Returns an unsubscribe fn. */
  onTick(listener: (tick: OperatorIpcTick) => void): () => void {
    this.tickListeners.add(listener);
    return () => this.tickListeners.delete(listener);
  }

  /**
   * Stage 12 C-P1 — subscribe to the live transcript push; survives reconnects (the listeners live on
   * the facade, re-attached to each new connection). Returns an unsubscribe fn.
   */
  onTranscript(listener: (transcript: OperatorIpcTranscript) => void): () => void {
    this.transcriptListeners.add(listener);
    return () => this.transcriptListeners.delete(listener);
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
        'operator IPC: the Conductor is not running — control and mail writes need `co-mcp serve <projectId>`.',
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
      connection.onTranscript((transcript) => this.fanOutTranscript(transcript));
      connection.onClose(() => this.handleDisconnect(connection));
      this.connection = connection;
      this.emitState('connected');
      return connection;
    } catch (error) {
      // Daemon down / socket absent — degraded, not an error (D5 / MNR #3).
      if (!isExpectedConnectUnavailable(error)) this.report(error);
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
    for (const listener of [...this.tickListeners]) {
      try {
        listener(tick);
      } catch (error) {
        this.report(error);
      }
    }
  }

  private fanOutTranscript(transcript: OperatorIpcTranscript): void {
    for (const listener of [...this.transcriptListeners]) {
      try {
        listener(transcript);
      } catch (error) {
        this.report(error);
      }
    }
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
