/**
 * Stage 11 P1 (OP-IPC · §3b) — the daemon-side operator-IPC SERVER.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 * A JSON-RPC server over a Unix-domain socket that wraps an already-built `ConductorControlSurface`
 * (the daemon-backed router + the live-observe query) plus a {@link MailStore} for the two write
 * verbs, and forwards each daemon tick as a `tick` server-push notification. Started by `co serve`
 * alongside the cadence runner (host.ts wires it through {@link ConductorHostRunnerDeps.onTick} /
 * `onStop`).
 *
 * Reuses the {@link SocketServerTransport} framing from real-transport.ts (line-framed JSON-RPC +
 * `ensurePrivateSocketDirectory`'s `0o700`, uid-owned, non-symlink socket DIR) — we do NOT reinvent
 * socket framing. The one thing the bridge transport does not do that we MUST: chmod the socket FILE
 * to `0o600` after `listen`, so the channel is operator-uid-only by OS permission (AC-S11-1). Never an
 * app/agent responsibility, never an agent surface (Principle 4 + D4; AC-S11-6).
 *
 * Single writer (MNR #2): the write verbs run HERE, in the daemon process, against the daemon's store
 * (a {@link MailStore} opened per write) — the app never writes the store directly. Registers ZERO
 * agent MCP tools: a plain class, no `ToolSpec`.
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 */
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertNever,
  MAIL_APPROVAL,
  MAIL_APPROVAL_RESPONSE,
  MAIL_REVIEW_REQUEST,
  MAIL_REVIEW_RESPONSE,
  OPERATOR,
  OPERATOR_IPC_METHODS,
  OPERATOR_IPC_TICK,
  OPERATOR_IPC_TRANSCRIPT,
  buildHumanReviewVerdict,
  openMailStore,
  openReviewStore,
  type ApprovalDecision,
  type DeliveredMail,
  type LiveObservabilitySnapshot,
  type MailStore,
  type MailType,
  type OperatorIpcMethod,
  type ProjectId,
  type ReviewStore,
  type ReviewVerdictValue,
  type ReplyDraft,
  type Steer,
} from '@co/core';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { SocketServerTransport } from '../conductor/real-transport.js';
import type { ConductorControlSurface } from '../conductor/host.js';
import {
  classifyIncoming,
  makeError,
  makeNotification,
  makeResult,
  WIRE_ERROR,
  type WireId,
  type WirePayload,
} from './wire.js';

/** The operator-IPC socket path under a project's data dir: `<dataDir>/operator-ipc/control.sock`. */
export function operatorIpcSocketPath(dataDir: string): string {
  return join(dataDir, 'operator-ipc', 'control.sock');
}

/** Constructor seams for {@link OperatorIpcServer}. */
export interface OperatorIpcServerDeps {
  /** The operator control/observe surface (the daemon-backed router + live-observe query). */
  readonly control: ConductorControlSurface;
  /** The project whose store the write verbs act on (single writer — MNR #2). */
  readonly projectId: ProjectId;
  /** Absolute Unix socket path to listen on. Derive with {@link operatorIpcSocketPath}. */
  readonly socketPath: string;
  /** Opens the project mail bus for a write verb (open/close per call). Default: {@link openMailStore}. */
  readonly openMail?: (projectId: ProjectId) => MailStore;
  /** Opens the project review store for human `review_response` replies. Default: {@link openReviewStore}. */
  readonly openReview?: (projectId: ProjectId) => ReviewStore;
  /** Diagnostic seam for server-side errors (a push to a gone client, a transport error). Default: none. */
  readonly onError?: (error: unknown) => void;
}

const OPERATOR_IPC_METHOD_SET = new Set<string>(Object.values(OPERATOR_IPC_METHODS));

function isOperatorIpcMethod(method: string): method is OperatorIpcMethod {
  return OPERATOR_IPC_METHOD_SET.has(method);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class InvalidParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidParamsError';
  }
}

function requireString(obj: WirePayload, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidParamsError(
      `operator IPC: missing/invalid '${key}' (expected a non-empty string).`,
    );
  }
  return value;
}

function requireNumber(obj: WirePayload, key: string): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidParamsError(`operator IPC: missing/invalid '${key}' (expected a number).`);
  }
  return value;
}

function requireObject(obj: WirePayload, key: string): WirePayload {
  const value = obj[key];
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidParamsError(`operator IPC: missing/invalid '${key}' (expected an object).`);
  }
  return value as WirePayload;
}

function requireSteer(params: WirePayload): Steer {
  const steer = requireObject(params, 'steer');
  const kind = steer.kind;
  if (kind === 'answer' || kind === 'redirect') {
    return { kind, text: requireString(steer, 'text') };
  }
  if (kind === 'interrupt') {
    return { kind };
  }
  throw new InvalidParamsError(`operator IPC steer: invalid kind '${String(kind)}'.`);
}

function requireDecision(obj: WirePayload, key: string): ApprovalDecision {
  const decision = requireString(obj, key);
  if (decision !== 'approve' && decision !== 'decline') {
    throw new InvalidParamsError(
      `operator IPC: '${key}' must be 'approve' or 'decline', got '${decision}'.`,
    );
  }
  return decision;
}

function requireReviewVerdict(obj: WirePayload, key: string): ReviewVerdictValue {
  const verdict = requireString(obj, key);
  if (verdict !== 'PASS' && verdict !== 'ISSUES') {
    throw new InvalidParamsError(
      `operator IPC: '${key}' must be 'PASS' or 'ISSUES', got '${verdict}'.`,
    );
  }
  return verdict;
}

/**
 * The operator-IPC server. Owns one {@link SocketServerTransport}, routes inbound JSON-RPC requests to
 * the control surface / mail store, and forwards per-tick snapshots via {@link pushTick}. Lifecycle:
 * `start()` (listen + chmod `0o600`) → serve + push → `close()` (tear the socket down).
 */
export class OperatorIpcServer {
  private readonly control: ConductorControlSurface;
  private readonly projectId: ProjectId;
  private readonly socketPath: string;
  private readonly openMail: (projectId: ProjectId) => MailStore;
  private readonly openReview: (projectId: ProjectId) => ReviewStore;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly transport: SocketServerTransport;
  private started = false;

  constructor(deps: OperatorIpcServerDeps) {
    this.control = deps.control;
    this.projectId = deps.projectId;
    this.socketPath = deps.socketPath;
    this.openMail = deps.openMail ?? openMailStore;
    this.openReview = deps.openReview ?? openReviewStore;
    this.onError = deps.onError;
    this.transport = new SocketServerTransport(this.socketPath);
    this.transport.onmessage = (message): void => this.onMessage(message);
    this.transport.onerror = (error): void => this.report(error);
  }

  /** Listen on the socket and lock the socket FILE to `0o600` (operator-uid-only). Fails loud. */
  async start(): Promise<void> {
    if (this.started) throw new Error('OperatorIpcServer.start: already started.');
    this.started = true;
    await this.transport.start();
    // The socket DIR is `0o700` (ensurePrivateSocketDirectory, inside transport.start); now lock the
    // socket FILE itself so only the operator uid can connect — never an app/agent responsibility.
    chmodSync(this.socketPath, 0o600);
  }

  /**
   * Forward a fresh live snapshot to a connected client as the `tick` notification (D6 — the whole
   * snapshot, no deltas). A no-op when no app is attached; a push that races a disconnect is reported,
   * never thrown (a tick push must not crash the daemon — Principle 9).
   */
  pushTick(snapshot: LiveObservabilitySnapshot): void {
    if (!this.transport.connected) return;
    this.safeSend(makeNotification(OPERATOR_IPC_TICK, { snapshot } as unknown as WirePayload));
  }

  /**
   * Stage 12 C-P1 (TRANSCRIPT-SEAM) — forward one chunk of a hosted agent's live pane output as the
   * `transcript:push` notification (mirrors {@link pushTick}). Event-driven, NOT on the tick cadence:
   * `co serve` subscribes this to the engine's transcript stream. A no-op when no app is attached; a
   * push that races a disconnect is reported, never thrown (must not crash the daemon — Principle 9).
   */
  pushTranscript(agentId: string, chunk: string): void {
    if (!this.transport.connected) return;
    this.safeSend(
      makeNotification(OPERATOR_IPC_TRANSCRIPT, { agentId, chunk } as unknown as WirePayload),
    );
  }

  /** Tear the socket down (idempotent via the transport). */
  async close(): Promise<void> {
    await this.transport.close();
  }

  private onMessage(message: JSONRPCMessage): void {
    const incoming = classifyIncoming(message);
    // The server only ACTS on requests; a client never sends it responses/notifications.
    if (incoming.kind !== 'request') return;
    void this.dispatch(incoming.id, incoming.method, incoming.params);
  }

  private async dispatch(id: WireId, method: string, params: WirePayload): Promise<void> {
    if (!isOperatorIpcMethod(method)) {
      this.safeSend(
        makeError(id, WIRE_ERROR.methodNotFound, `operator IPC: unknown method '${method}'.`),
      );
      return;
    }
    try {
      const result = await this.invoke(method, params);
      this.safeSend(makeResult(id, result));
    } catch (error) {
      this.safeSend(
        makeError(
          id,
          error instanceof InvalidParamsError ? WIRE_ERROR.invalidParams : WIRE_ERROR.internalError,
          errorMessage(error),
        ),
      );
    }
  }

  private async invoke(method: OperatorIpcMethod, params: WirePayload): Promise<WirePayload> {
    const router = this.control.router;
    switch (method) {
      case OPERATOR_IPC_METHODS.observe:
        return this.control.observe() as unknown as WirePayload;
      case OPERATOR_IPC_METHODS.pause:
        router.pause(requireString(params, 'agentId'));
        return {};
      case OPERATOR_IPC_METHODS.resume:
        router.resume(requireString(params, 'agentId'));
        return {};
      case OPERATOR_IPC_METHODS.stop:
        router.stop(requireString(params, 'agentId'));
        return {};
      case OPERATOR_IPC_METHODS.unstick: {
        const agentId = requireString(params, 'agentId');
        router.revertStuck(agentId);
        router.rewake(agentId);
        return {};
      }
      case OPERATOR_IPC_METHODS.steer:
        await router.steer(requireString(params, 'agentId'), requireSteer(params));
        return {};
      case OPERATOR_IPC_METHODS.reply:
        return (await this.handleReply(params)) as unknown as WirePayload;
      case OPERATOR_IPC_METHODS.approve:
        return (await this.handleApprove(params)) as unknown as WirePayload;
      case OPERATOR_IPC_METHODS.markRead:
        return (await this.handleMarkRead(params)) as unknown as WirePayload;
      case OPERATOR_IPC_METHODS.transcript:
        // C-P1 — the on-demand bounded tail (operator backfill). Pure read off the control surface.
        return this.control.transcriptTail(
          requireString(params, 'agentId'),
        ) as unknown as WirePayload;
      default:
        return assertNever(method);
    }
  }

  /** Reply to an actionable mail named by `target`, through the daemon's own store (single writer). */
  private async handleReply(params: WirePayload): Promise<DeliveredMail> {
    const target = requireObject(params, 'target');
    const seq = requireNumber(target, 'seq');
    const recipient = requireString(target, 'recipient');
    const draftIn = requireObject(params, 'draft');
    const draft: ReplyDraft = {
      type: requireString(draftIn, 'type') as MailType,
      subject: requireString(draftIn, 'subject'),
      body: requireString(draftIn, 'body'),
      ...(typeof draftIn.from === 'string' ? { from: draftIn.from } : {}),
      ...(typeof draftIn.idempotencyKey === 'string'
        ? { idempotencyKey: draftIn.idempotencyKey }
        : {}),
      ...(typeof draftIn.decision === 'string'
        ? { decision: requireDecision(draftIn, 'decision') }
        : {}),
      ...(typeof draftIn.reviewVerdict === 'string'
        ? { reviewVerdict: requireReviewVerdict(draftIn, 'reviewVerdict') }
        : {}),
    };
    const mail = this.openMail(this.projectId);
    try {
      const found = mail.inbox(recipient).find((m) => m.seq === seq);
      if (found == null) {
        throw new Error(`operator IPC reply: no mail seq=${seq} in '${recipient}' inbox.`);
      }
      if (found.kind !== 'actionable') {
        throw new Error(
          `operator IPC reply: mail seq=${seq} is '${found.kind ?? '<unknown>'}', not actionable.`,
        );
      }
      if (draft.type === MAIL_REVIEW_RESPONSE) {
        return this.handleReviewResponse(mail, found, draft);
      }
      const existing = this.existingIdempotentReply(mail, found, draft);
      if (existing != null) return existing;
      if (found.resolved) {
        throw new Error(`operator IPC reply: mail seq=${seq} is already resolved.`);
      }
      return mail.reply(found, draft);
    } finally {
      mail.close();
    }
  }

  private existingIdempotentReply(
    mail: MailStore,
    answered: DeliveredMail,
    draft: ReplyDraft,
  ): DeliveredMail | undefined {
    if (draft.idempotencyKey == null) return undefined;
    const sender = draft.from ?? answered.recipient;
    const existing = mail
      .inbox(answered.sender)
      .find(
        (m) =>
          m.idempotencyKey === draft.idempotencyKey && m.sender === sender && m.type === draft.type,
      );
    if (existing == null) return undefined;
    if (existing.causationId !== String(answered.seq)) {
      throw new Error(
        `operator IPC reply: idempotency key already answers mail seq=${existing.causationId ?? '<unknown>'}; ` +
          `it cannot answer mail seq=${answered.seq}.`,
      );
    }
    if (existing.subject !== draft.subject || existing.body !== draft.body) {
      throw new Error(
        `operator IPC reply: idempotent retry for mail seq=${answered.seq} changes subject/body.`,
      );
    }
    return existing;
  }

  private handleReviewResponse(
    mail: MailStore,
    requestMail: DeliveredMail,
    draft: ReplyDraft,
  ): DeliveredMail {
    if (requestMail.type !== MAIL_REVIEW_REQUEST) {
      throw new Error(
        `operator IPC review reply: mail seq=${requestMail.seq} is '${requestMail.type}', ` +
          `not ${MAIL_REVIEW_REQUEST}.`,
      );
    }
    if (draft.reviewVerdict == null) {
      throw new InvalidParamsError(
        `operator IPC review reply: ${MAIL_REVIEW_RESPONSE} requires reviewVerdict.`,
      );
    }
    const reviewId = requestMail.idempotencyKey?.startsWith('review-request:')
      ? requestMail.idempotencyKey.slice('review-request:'.length)
      : undefined;
    if (reviewId == null || reviewId.length === 0) {
      throw new Error(
        `operator IPC review reply: malformed review_request mail seq=${requestMail.seq}.`,
      );
    }
    const reviews = this.openReview(this.projectId);
    try {
      const request = reviews.getReviewRequestById(reviewId);
      if (request == null) {
        throw new Error(
          `operator IPC review reply: review_request mail seq=${requestMail.seq} has no ` +
            'matching review.requested row.',
        );
      }
      return mail.replyWithReviewVerdict(
        requestMail,
        draft,
        buildHumanReviewVerdict(reviews, {
          reviewId,
          target: request.target,
          branch: request.branch,
          scope: request.scope,
          verdict: draft.reviewVerdict,
          body: draft.body,
        }),
      );
    } finally {
      reviews.close();
    }
  }

  /** Approve/decline an outstanding operator-terminal `approval` as a structured `approval_response`. */
  private async handleApprove(params: WirePayload): Promise<DeliveredMail> {
    const approvalSeq = requireNumber(params, 'approvalSeq');
    const reply = requireObject(params, 'reply');
    const decision = requireDecision(reply, 'decision');
    const subject = requireString(reply, 'subject');
    const body = requireString(reply, 'body');
    const mail = this.openMail(this.projectId);
    try {
      // Approvals are operator-terminal (validateEnvelope: `approval` must be addressed to @operator),
      // so the approval always lives in @operator's inbox — the single place to resolve it from.
      const approval = mail.inbox(OPERATOR).find((m) => m.seq === approvalSeq);
      if (approval == null) {
        throw new Error(`operator IPC approve: no mail seq=${approvalSeq} in '${OPERATOR}' inbox.`);
      }
      if (approval.type !== MAIL_APPROVAL) {
        throw new Error(
          `operator IPC approve: mail seq=${approvalSeq} is '${approval.type}', not an approval.`,
        );
      }
      if (approval.resolved) {
        throw new Error(`operator IPC approve: mail seq=${approvalSeq} is already resolved.`);
      }
      return mail.reply(approval, { type: MAIL_APPROVAL_RESPONSE, decision, subject, body });
    } finally {
      mail.close();
    }
  }

  /** Mark `recipient`'s informational mail at `seq` read, through the daemon's own store (single writer). */
  private async handleMarkRead(params: WirePayload): Promise<DeliveredMail> {
    const recipient = requireString(params, 'recipient');
    const seq = requireNumber(params, 'seq');
    const mail = this.openMail(this.projectId);
    try {
      return mail.markRead(recipient, seq);
    } finally {
      mail.close();
    }
  }

  /** Send a message, routing a failure (e.g. a client that vanished mid-send) to `onError`. */
  private safeSend(message: JSONRPCMessage): void {
    this.transport.send(message).catch((error) => this.report(error));
  }

  private report(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      /* a diagnostic callback must never break the server */
    }
  }
}
