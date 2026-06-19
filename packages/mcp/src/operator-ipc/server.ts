/**
 * Stage 11 P1 (OP-IPC · §3b) — the daemon-side operator-IPC SERVER.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 * A JSON-RPC server over a Unix-domain socket that wraps an already-built `ConductorControlSurface`
 * (the daemon-backed router + the live-observe query) plus a {@link MailStore} for the two write
 * verbs, and forwards each daemon tick as a `tick` server-push notification. Started by `co-mcp serve`
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
  MAIL_CLARIFY_REQUEST,
  MAIL_REVIEW_REQUEST,
  MAIL_REVIEW_RESPONSE,
  OPERATOR,
  OPERATOR_IPC_METHODS,
  OPERATOR_IPC_TICK,
  OPERATOR_IPC_TRANSCRIPT,
  buildHumanReviewVerdict,
  openMailStore,
  openRegistry,
  openReviewStore,
  startCoordinatorSession,
  type ApprovalDecision,
  type DeliveredMail,
  type LiveObservabilitySnapshot,
  type MailStore,
  type MailType,
  type OperatorIpcMethod,
  type ProjectId,
  type ProjectRegistry,
  type ReviewContext,
  type ReviewStore,
  type ReviewVerdictValue,
  type ReplyDraft,
  type StartSessionResult,
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
  /** Locks the socket file after listen. Default: {@link chmodSync}. Injected for lifecycle tests. */
  readonly chmodSocket?: (socketPath: string, mode: number) => void;
  /** Opens the global registry to resolve the repo path for `startSession`. Default: {@link openRegistry}. */
  readonly openRegistryFn?: () => ProjectRegistry;
  /** The start primitive for `startSession`. Default: {@link startCoordinatorSession}. */
  readonly startFn?: typeof startCoordinatorSession;
}

const OPERATOR_IPC_METHOD_SET = new Set<string>(Object.values(OPERATOR_IPC_METHODS));
const TRANSCRIPT_PENDING_MAX_CHARS = 64 * 1024;
const TRANSCRIPT_PENDING_MAX_AGENTS = 256;

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

function requirePositiveDim(obj: WirePayload, key: string): number {
  const value = obj[key];
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    !Number.isInteger(value)
  ) {
    throw new InvalidParamsError(
      `operator IPC: missing/invalid '${key}' (expected a positive integer dimension).`,
    );
  }
  return value;
}

// A terminal keystroke/paste chunk. Bounded so a buggy renderer can't push an unbounded string
// straight through to node-pty's write (the operator-uid socket is the only caller, but fail closed).
const MAX_INPUT_CHARS = 1024 * 1024;

function requireInputData(obj: WirePayload, key: string): string {
  const value = obj[key];
  if (typeof value !== 'string') {
    throw new InvalidParamsError(`operator IPC: missing/invalid '${key}' (expected a string).`);
  }
  if (value.length > MAX_INPUT_CHARS) {
    throw new InvalidParamsError(
      `operator IPC: '${key}' exceeds the ${MAX_INPUT_CHARS}-character input limit.`,
    );
  }
  return value;
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

function assertReviewEvidenceReady(context: ReviewContext): void {
  if (context.kind !== 'resolved') {
    throw new Error(
      `operator IPC review reply: review evidence is unavailable for '${context.reviewId}'.`,
    );
  }
  if (context.diff.kind !== 'patch') {
    throw new Error(
      `operator IPC review reply: review diff is unavailable (${context.diff.reason}).`,
    );
  }
  if (context.criteria.kind !== 'criteria') {
    throw new Error('operator IPC review reply: locked acceptance criteria are unavailable.');
  }
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
  private readonly chmodSocket: (socketPath: string, mode: number) => void;
  private readonly openRegistryFn: () => ProjectRegistry;
  private readonly startFn: typeof startCoordinatorSession;
  private readonly transport: SocketServerTransport;
  private readonly pendingTranscriptPushes = new Map<string, { offset: number; chunk: string }>();
  private transcriptPushInFlight = false;
  private started = false;

  constructor(deps: OperatorIpcServerDeps) {
    this.control = deps.control;
    this.projectId = deps.projectId;
    this.socketPath = deps.socketPath;
    this.openMail = deps.openMail ?? openMailStore;
    this.openReview = deps.openReview ?? openReviewStore;
    this.onError = deps.onError;
    this.chmodSocket = deps.chmodSocket ?? chmodSync;
    this.openRegistryFn = deps.openRegistryFn ?? openRegistry;
    this.startFn = deps.startFn ?? startCoordinatorSession;
    this.transport = new SocketServerTransport(this.socketPath);
    this.transport.onmessage = (message): void => this.onMessage(message);
    this.transport.onerror = (error): void => this.report(error);
  }

  /** Listen on the socket and lock the socket FILE to `0o600` (operator-uid-only). Fails loud. */
  async start(): Promise<void> {
    if (this.started) throw new Error('OperatorIpcServer.start: already started.');
    this.started = true;
    try {
      await this.transport.start();
      // The socket DIR is `0o700` (ensurePrivateSocketDirectory, inside transport.start); now lock the
      // socket FILE itself so only the operator uid can connect — never an app/agent responsibility.
      this.chmodSocket(this.socketPath, 0o600);
    } catch (error) {
      this.started = false;
      try {
        await this.transport.close();
      } catch (cleanupError) {
        this.report(cleanupError);
      }
      throw error;
    }
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
   * `co-mcp serve` subscribes this to the engine's transcript stream. A no-op when no app is attached; a
   * push that races a disconnect is reported, never thrown (must not crash the daemon — Principle 9).
   */
  pushTranscript(agentId: string, chunk: string, offset: number): void {
    if (!this.transport.connected) return;
    if (this.transcriptPushInFlight) {
      this.queueTranscriptPush(agentId, chunk, offset);
      return;
    }
    this.sendTranscriptPush(agentId, chunk, offset);
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
      case OPERATOR_IPC_METHODS.operatorMessage:
        // The operator's "message an agent" verb: a fresh actionable `clarify_request` from @operator
        // that wakes an idle recipient on the next tick (steer needs a warm pane — this does not).
        return (await this.handleOperatorMessage(params)) as unknown as WirePayload;
      case OPERATOR_IPC_METHODS.approve:
        return (await this.handleApprove(params)) as unknown as WirePayload;
      case OPERATOR_IPC_METHODS.markRead:
        return (await this.handleMarkRead(params)) as unknown as WirePayload;
      case OPERATOR_IPC_METHODS.transcript:
        // C-P1 — the on-demand bounded tail (operator backfill). Pure read off the control surface.
        return this.control.transcriptTail(
          requireString(params, 'agentId'),
        ) as unknown as WirePayload;
      case OPERATOR_IPC_METHODS.reviewContext:
        // Stage 13 R-A — the on-demand Review-view context (diff + criteria + refs). A daemon-side READ
        // off the control surface; degrades to a named state, never throws to the view (Principle 9).
        return (await this.control.reviewContext(
          requireString(params, 'reviewId'),
        )) as unknown as WirePayload;
      case OPERATOR_IPC_METHODS.startSession:
        // Stage 14 P4 — the operator-only START verb over the operator-IPC wire (the IPC socket is
        // operator-uid-only by OS permission; this is NEVER an agent-callable tool — Principle 4 + D4).
        // Resolve the project's repo path via the registry exactly as `runStartSessionCommand` does,
        // then delegate to the same core primitive (single source of truth; never duplicated here).
        return (await this.handleStartSession(params)) as unknown as WirePayload;
      case OPERATOR_IPC_METHODS.sendInput:
        // Stage 15 §7 — raw keystroke passthrough: operator writes into the agent's warm PTY stdin.
        await router.sendInput(requireString(params, 'agentId'), requireInputData(params, 'data'));
        return {};
      case OPERATOR_IPC_METHODS.resize:
        // Stage 15 §7 — PTY resize sync: xterm fit dispatches the terminal dimensions to the PTY.
        await router.resize(
          requireString(params, 'agentId'),
          requirePositiveDim(params, 'cols'),
          requirePositiveDim(params, 'rows'),
        );
        return {};
      default:
        return assertNever(method);
    }
  }

  /**
   * Start a ROOT coordinator session via the operator-IPC wire. Resolves the project's repo path
   * from the registry, then delegates to the core `startCoordinatorSession` primitive. Fails loud
   * (Principle 9) unless exactly one of `prompt` / `specBody` is supplied.
   */
  private async handleStartSession(params: WirePayload): Promise<StartSessionResult> {
    const prompt = typeof params['prompt'] === 'string' ? params['prompt'].trim() : '';
    const specBody = typeof params['specBody'] === 'string' ? params['specBody'].trim() : '';
    const fromPrompt = prompt.length > 0;
    const fromSpec = specBody.length > 0;
    if (fromPrompt === fromSpec) {
      throw new InvalidParamsError(
        'operator IPC startSession: exactly one of `prompt` / `specBody` is required ' +
          '(Principle 9 — fail loud).',
      );
    }
    const registry = this.openRegistryFn();
    let repoCwd: string | undefined;
    try {
      repoCwd = registry.pathFor(this.projectId) ?? undefined;
    } finally {
      registry.close();
    }
    if (repoCwd == null) {
      throw new Error(`operator IPC startSession: unknown project id '${this.projectId}'.`);
    }
    return this.startFn({
      projectId: this.projectId,
      repoCwd,
      ...(fromPrompt ? { prompt } : { specBody }),
    });
  }

  /**
   * Send a FRESH operator message to an agent (the "message the coordinator" verb). Posts an actionable
   * `clarify_request` from {@link OPERATOR} to `agentId` through the daemon's own store (single writer —
   * MNR #2), the SAME shape the kickoff seeds (`start-coordinator-session`). Because the item is
   * outstanding + actionable, the daemon's `selectEligible` wakes the recipient on its next tick even
   * when it is cold/idle — which `steer` (warm-pane-only) and an informational `operator_message`
   * (never a wake item) cannot do.
   */
  private async handleOperatorMessage(params: WirePayload): Promise<DeliveredMail> {
    const agentId = requireString(params, 'agentId');
    const subject = requireString(params, 'subject');
    const body = requireString(params, 'body');
    const mail = this.openMail(this.projectId);
    try {
      return mail.send({
        type: MAIL_CLARIFY_REQUEST,
        to: agentId,
        from: OPERATOR,
        subject,
        body,
      });
    } finally {
      mail.close();
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
      ...(typeof draftIn.reviewContextFingerprint === 'string'
        ? { reviewContextFingerprint: requireString(draftIn, 'reviewContextFingerprint') }
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
        return await this.handleReviewResponse(mail, found, draft);
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

  private existingIdempotentReviewReply(
    mail: MailStore,
    answered: DeliveredMail,
    draft: ReplyDraft,
  ): DeliveredMail | undefined {
    const existing = this.existingIdempotentReply(mail, answered, draft);
    if (existing == null) return undefined;
    if (existing.reviewVerdict !== draft.reviewVerdict) {
      throw new Error(
        `operator IPC reply: idempotent retry for mail seq=${answered.seq} changes review verdict.`,
      );
    }
    return existing;
  }

  private async handleReviewResponse(
    mail: MailStore,
    requestMail: DeliveredMail,
    draft: ReplyDraft,
  ): Promise<DeliveredMail> {
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
    const existing = this.existingIdempotentReviewReply(mail, requestMail, draft);
    if (existing != null) return existing;

    const context = await this.control.reviewContext(reviewId);
    assertReviewEvidenceReady(context);

    const reviews = this.openReview(this.projectId);
    try {
      const request = reviews.getReviewRequestById(reviewId);
      if (request == null) {
        throw new Error(
          `operator IPC review reply: review_request mail seq=${requestMail.seq} has no ` +
            'matching review.requested row.',
        );
      }
      if (
        context.kind === 'resolved' &&
        (context.target !== request.target ||
          context.branch !== request.branch ||
          context.scope !== request.scope)
      ) {
        throw new Error(
          `operator IPC review reply: review evidence for '${reviewId}' does not match the ` +
            'durable review request.',
        );
      }
      if (
        context.kind === 'resolved' &&
        draft.reviewContextFingerprint !== context.evidenceFingerprint
      ) {
        throw new Error(
          `operator IPC review reply: review evidence fingerprint for '${reviewId}' is stale ` +
            'or missing; reload the Review view before submitting a verdict.',
        );
      }
      if (request.specRef.kind !== 'criteria') {
        throw new Error(
          `operator IPC review reply: review '${reviewId}' has no locked acceptance criteria ` +
            'recorded on the durable review request.',
        );
      }
      if (context.kind === 'resolved' && context.criteria.kind === 'criteria') {
        if (context.criteria.specRef !== request.specRef.ref) {
          throw new Error(
            `operator IPC review reply: locked acceptance criteria for '${reviewId}' do not ` +
              'match the durable review request.',
          );
        }
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

  private queueTranscriptPush(agentId: string, chunk: string, offset: number): void {
    const pending = this.pendingTranscriptPushes.get(agentId);
    const canCoalesce = pending != null && offset === pending.offset + pending.chunk.length;
    const nextOffset = canCoalesce ? pending.offset : offset;
    const next = canCoalesce ? pending.chunk + chunk : chunk;
    if (next.length > TRANSCRIPT_PENDING_MAX_CHARS) {
      const dropped = next.length - TRANSCRIPT_PENDING_MAX_CHARS;
      this.pendingTranscriptPushes.set(agentId, {
        offset: nextOffset + dropped,
        chunk: next.slice(dropped),
      });
    } else {
      this.pendingTranscriptPushes.set(agentId, { offset: nextOffset, chunk: next });
    }

    while (this.pendingTranscriptPushes.size > TRANSCRIPT_PENDING_MAX_AGENTS) {
      const drop =
        [...this.pendingTranscriptPushes.keys()].find((candidate) => candidate !== agentId) ??
        this.pendingTranscriptPushes.keys().next().value;
      if (drop == null) break;
      this.pendingTranscriptPushes.delete(drop);
    }
  }

  private sendTranscriptPush(agentId: string, chunk: string, offset: number): void {
    this.transcriptPushInFlight = true;
    this.transport
      .send(
        makeNotification(OPERATOR_IPC_TRANSCRIPT, {
          agentId,
          offset,
          chunk,
        } as unknown as WirePayload),
      )
      .then(
        () => this.drainTranscriptPush(),
        (error: unknown) => {
          this.pendingTranscriptPushes.clear();
          this.transcriptPushInFlight = false;
          this.report(error);
        },
      );
  }

  private drainTranscriptPush(): void {
    if (!this.transport.connected) {
      this.pendingTranscriptPushes.clear();
      this.transcriptPushInFlight = false;
      return;
    }
    const next = this.pendingTranscriptPushes.entries().next().value as
      | [agentId: string, transcript: { offset: number; chunk: string }]
      | undefined;
    if (next == null) {
      this.transcriptPushInFlight = false;
      return;
    }
    const [agentId, transcript] = next;
    this.pendingTranscriptPushes.delete(agentId);
    this.sendTranscriptPush(agentId, transcript.chunk, transcript.offset);
  }

  private report(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      /* a diagnostic callback must never break the server */
    }
  }
}
