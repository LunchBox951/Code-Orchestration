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
import { randomBytes } from 'node:crypto';
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
  applyApprovalLockSideEffect,
  buildHumanReviewVerdict,
  isSpecLockApprovalKey,
  mintAvailableCoordinatorId,
  openMailStore,
  openRegistry,
  openReviewStore,
  openRosterStore,
  openSpecStore,
  startCoordinatorSession,
  type ArchiveStore,
  type ApprovalDecision,
  type DeliveredMail,
  type LiveObservabilitySnapshot,
  type MailStore,
  type MailType,
  type OperatorIpcMethod,
  type ProjectId,
  type ProjectRegistry,
  type RosterStore,
  type ReviewContext,
  type ReviewStore,
  type SpecStore,
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
  /** Opens the project spec store for the #91 approve→spec-lock bridge. Default: {@link openSpecStore}. */
  readonly openSpec?: (projectId: ProjectId) => SpecStore;
  /** Diagnostic seam for server-side errors (a push to a gone client, a transport error). Default: none. */
  readonly onError?: (error: unknown) => void;
  /** Locks the socket file after listen. Default: {@link chmodSync}. Injected for lifecycle tests. */
  readonly chmodSocket?: (socketPath: string, mode: number) => void;
  /** Opens the global registry to resolve the repo path for `startSession`. Default: {@link openRegistry}. */
  readonly openRegistryFn?: () => ProjectRegistry;
  /** Opens the roster to avoid coordinator id collisions while minting startSession ids. */
  readonly openRoster?: (projectId: ProjectId) => RosterStore;
  /** Opens archived branches to avoid coordinator id collisions with archived roots. */
  readonly openArchive?: (projectId: ProjectId) => ArchiveStore;
  /** Entropy seam for name-derived coordinator ids. */
  readonly randomHex?: () => string;
  /** The start primitive for `startSession`. Default: {@link startCoordinatorSession}. */
  readonly startFn?: typeof startCoordinatorSession;
}

const OPERATOR_IPC_METHOD_SET = new Set<string>(Object.values(OPERATOR_IPC_METHODS));
const TRANSCRIPT_PENDING_MAX_CHARS = 64 * 1024;
const TRANSCRIPT_PENDING_MAX_AGENTS = 256;
const TRANSCRIPT_PENDING_MAX_CHARS_PER_AGENT = 4 * TRANSCRIPT_PENDING_MAX_CHARS;

interface PendingTranscriptPush {
  readonly agentId: string;
  readonly generation: number;
  offset: number;
  chunk: string;
}

function splitTranscriptPush(
  chunk: string,
  offset: number,
): Array<{ readonly offset: number; readonly chunk: string }> {
  if (chunk.length <= TRANSCRIPT_PENDING_MAX_CHARS) return [{ offset, chunk }];
  const pieces: Array<{ offset: number; chunk: string }> = [];
  for (let start = 0; start < chunk.length; start += TRANSCRIPT_PENDING_MAX_CHARS) {
    pieces.push({
      offset: offset + start,
      chunk: chunk.slice(start, start + TRANSCRIPT_PENDING_MAX_CHARS),
    });
  }
  return pieces;
}

function isOperatorIpcMethod(method: string): method is OperatorIpcMethod {
  return OPERATOR_IPC_METHOD_SET.has(method);
}

function errorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    const inner = error.errors.map((e) => errorMessage(e)).filter((msg) => msg.length > 0);
    return inner.length > 0 ? `${error.message}: ${inner.join('; ')}` : error.message;
  }
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
  private readonly openSpec: (projectId: ProjectId) => SpecStore;
  private readonly onError: ((error: unknown) => void) | undefined;
  private readonly chmodSocket: (socketPath: string, mode: number) => void;
  private readonly openRegistryFn: () => ProjectRegistry;
  private readonly openRoster: (projectId: ProjectId) => RosterStore;
  private readonly openArchive: ((projectId: ProjectId) => ArchiveStore) | undefined;
  private readonly randomHex: () => string;
  private readonly startFn: typeof startCoordinatorSession;
  private readonly transport: SocketServerTransport;
  private readonly pendingTranscriptPushes: PendingTranscriptPush[] = [];
  private transcriptPushInFlight = false;
  private started = false;

  constructor(deps: OperatorIpcServerDeps) {
    this.control = deps.control;
    this.projectId = deps.projectId;
    this.socketPath = deps.socketPath;
    this.openMail = deps.openMail ?? openMailStore;
    this.openReview = deps.openReview ?? openReviewStore;
    this.openSpec = deps.openSpec ?? openSpecStore;
    this.onError = deps.onError;
    this.chmodSocket = deps.chmodSocket ?? chmodSync;
    this.openRegistryFn = deps.openRegistryFn ?? openRegistry;
    this.openRoster = deps.openRoster ?? openRosterStore;
    this.openArchive = deps.openArchive;
    this.randomHex = deps.randomHex ?? (() => randomBytes(3).toString('hex'));
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
  pushTranscript(agentId: string, generation: number, chunk: string, offset: number): void {
    if (!this.transport.connected) return;
    const [first, ...rest] = splitTranscriptPush(chunk, offset);
    if (first == null) return;
    if (this.transcriptPushInFlight) {
      this.queueTranscriptPushes(generation, agentId, [
        { offset: first.offset, chunk: first.chunk },
        ...rest,
      ]);
      return;
    }
    this.queueTranscriptPushes(generation, agentId, rest);
    this.sendTranscriptPush(agentId, generation, first.chunk, first.offset);
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
      case OPERATOR_IPC_METHODS.deleteAgent:
        // B4 — cascade-delete the agent and its entire subtree via the daemon's control surface.
        await this.control.deleteAgent(requireString(params, 'agentId'));
        return {};
      case OPERATOR_IPC_METHODS.reclaimChild:
        // #131 — GRANULAR reclaim of a single leaf child (frees its dispatch slot). Refuses a non-leaf.
        await this.control.reclaimChild(requireString(params, 'childId'));
        return {};
      case OPERATOR_IPC_METHODS.rewake:
        // B4 — post actionable follow-up work, then clear suppression.
        return (await this.handleRewake(params)) as unknown as WirePayload;
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
      case OPERATOR_IPC_METHODS.listArchive:
        // B5 — READ: list archived branches; wrapped in { entries } so the result is an
        // object (JSON-RPC 2.0 result MUST be an object — never an array on the wire).
        return { entries: await this.control.listArchive() } as unknown as WirePayload;
      case OPERATOR_IPC_METHODS.restoreArchive:
        // B5 — CONTROL: remove the archive record (branch stays; expiry cancelled). Fail loud when down.
        await this.control.restoreArchive(requireString(params, 'id'));
        return {};
      case OPERATOR_IPC_METHODS.purgeArchive:
        // B5 — CONTROL: git branch -D then remove the archive record. Fail loud when down.
        await this.control.purgeArchive(requireString(params, 'id'));
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
    const name = requireString(params, 'name').trim();
    if (name.length === 0) {
      throw new InvalidParamsError(
        "operator IPC: missing/invalid 'name' (expected a non-empty string).",
      );
    }
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
    // Mint a name-derived unique coordinator id through the core policy; retry boundedly on roster and
    // archive collisions so duplicate names remain valid.
    const coordinatorId = mintAvailableCoordinatorId(this.projectId, name, {
      randomHex: this.randomHex,
      ...(this.openArchive != null ? { openArchive: this.openArchive } : {}),
      openRoster: this.openRoster,
    });
    return this.startFn({
      projectId: this.projectId,
      repoCwd,
      name,
      coordinatorId,
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
    // Reject an unregistered recipient before posting (mirrors handleRewake). mail.send validates
    // only address SHAPE, not roster membership, so a typo'd/stale id would otherwise deliver into a
    // phantom inbox no agent ever reads — a silent misaddressed operator action (Principle 9).
    const roster = this.openRoster(this.projectId);
    try {
      if (roster.getAgent(agentId) == null) {
        throw new Error(`operator IPC message: unknown or unregistered agent '${agentId}'.`);
      }
    } finally {
      roster.close();
    }
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

  /**
   * Re-wake an agent: post an actionable `clarify_request` from `@operator` through the daemon's own
   * store (single writer — MNR #2), then clear suppression via `this.control.router.unstop`, so
   * `selectEligible` wakes the recipient on its next tick. Mirrors {@link handleOperatorMessage} but
   * also unstops after the mail commit.
   */
  private async handleRewake(params: WirePayload): Promise<DeliveredMail> {
    const agentId = requireString(params, 'agentId');
    const message = requireString(params, 'message').trim();
    if (message.length === 0) {
      throw new InvalidParamsError(
        "operator IPC: missing/invalid 'message' (expected a non-empty string).",
      );
    }
    const roster = this.openRoster(this.projectId);
    try {
      if (roster.getAgent(agentId) == null) {
        throw new Error(`operator IPC rewake: unknown or unregistered agent '${agentId}'.`);
      }
    } finally {
      roster.close();
    }
    const mail = this.openMail(this.projectId);
    let delivered: DeliveredMail;
    try {
      delivered = mail.send({
        type: MAIL_CLARIFY_REQUEST,
        to: agentId,
        from: OPERATOR,
        subject: 'Operator rewake',
        body: message,
      });
    } finally {
      mail.close();
    }
    // Unstop AFTER the mail is committed so the agent is immediately eligible on the next tick.
    this.control.router.unstop(agentId);
    return delivered;
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
      if (draft.type === MAIL_APPROVAL_RESPONSE && draft.decision != null) {
        const sender = draft.from ?? found.recipient;
        if (sender !== found.recipient) {
          throw new Error(
            `operator IPC reply: approval_response sender '${sender}' must match holder ` +
              `'${found.recipient}'.`,
          );
        }
        this.applySpecLockApprovalSideEffectBeforeResponse(found, draft.decision);
      }
      return mail.reply(found, draft);
    } finally {
      mail.close();
    }
  }

  private applySpecLockApprovalSideEffectBeforeResponse(
    approval: DeliveredMail,
    decision: ApprovalDecision,
  ): void {
    if (approval.type !== MAIL_APPROVAL || !isSpecLockApprovalKey(approval.idempotencyKey)) return;
    const specs = this.openSpec(this.projectId);
    try {
      applyApprovalLockSideEffect(specs, approval, decision);
    } finally {
      specs.close();
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
    let approval: DeliveredMail;
    try {
      // Approvals are operator-terminal (validateEnvelope: `approval` must be addressed to @operator),
      // so the approval always lives in @operator's inbox — the single place to resolve it from.
      const found = mail.inbox(OPERATOR).find((m) => m.seq === approvalSeq);
      if (found == null) {
        throw new Error(`operator IPC approve: no mail seq=${approvalSeq} in '${OPERATOR}' inbox.`);
      }
      if (found.type !== MAIL_APPROVAL) {
        throw new Error(
          `operator IPC approve: mail seq=${approvalSeq} is '${found.type}', not an approval.`,
        );
      }
      if (found.resolved) {
        throw new Error(`operator IPC approve: mail seq=${approvalSeq} is already resolved.`);
      }
      approval = found;
      // Issue #91 — bridge an approve of a `spec-lock:<taskId>` approval to the real lock path. Run
      // the lock BEFORE recording the approval_response: if D3 refuses the lock, the operator action
      // must remain unresolved/retryable instead of being consumed by a failed side effect.
      this.applySpecLockApprovalSideEffectBeforeResponse(approval, decision);
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

  private queueTranscriptPushes(
    generation: number,
    agentId: string,
    pushes: readonly { readonly offset: number; readonly chunk: string }[],
  ): void {
    for (const push of pushes) {
      this.queueTranscriptPiece(agentId, generation, push.chunk, push.offset);
    }
  }

  private queueTranscriptPiece(
    agentId: string,
    generation: number,
    chunk: string,
    offset: number,
  ): void {
    if (chunk.length === 0) return;
    for (let i = this.pendingTranscriptPushes.length - 1; i >= 0; i--) {
      const pending = this.pendingTranscriptPushes[i];
      if (pending?.agentId === agentId && pending.generation !== generation) {
        this.pendingTranscriptPushes.splice(i, 1);
      }
    }
    const lastIndex = this.pendingTranscriptPushes.findLastIndex(
      (p) => p.agentId === agentId && p.generation === generation,
    );
    const last = lastIndex >= 0 ? this.pendingTranscriptPushes[lastIndex] : undefined;
    if (last != null) {
      const expected = last.offset + last.chunk.length;
      if (offset === expected && last.chunk.length + chunk.length <= TRANSCRIPT_PENDING_MAX_CHARS) {
        last.chunk += chunk;
        this.prunePendingTranscriptBytes(agentId);
        return;
      }
      if (offset !== expected) {
        for (let i = this.pendingTranscriptPushes.length - 1; i >= 0; i--) {
          if (this.pendingTranscriptPushes[i]?.agentId === agentId) {
            this.pendingTranscriptPushes.splice(i, 1);
          }
        }
      }
    }

    for (const piece of splitTranscriptPush(chunk, offset)) {
      this.pendingTranscriptPushes.push({
        agentId,
        generation,
        offset: piece.offset,
        chunk: piece.chunk,
      });
    }
    this.prunePendingTranscriptBytes(agentId);

    while (
      new Set(this.pendingTranscriptPushes.map((p) => p.agentId)).size >
      TRANSCRIPT_PENDING_MAX_AGENTS
    ) {
      const drop =
        this.pendingTranscriptPushes.find((candidate) => candidate.agentId !== agentId)?.agentId ??
        this.pendingTranscriptPushes[0]?.agentId;
      if (drop == null) break;
      for (let i = this.pendingTranscriptPushes.length - 1; i >= 0; i--) {
        if (this.pendingTranscriptPushes[i]?.agentId === drop)
          this.pendingTranscriptPushes.splice(i, 1);
      }
    }
  }

  private prunePendingTranscriptBytes(agentId: string): void {
    let total = this.pendingTranscriptPushes
      .filter((p) => p.agentId === agentId)
      .reduce((n, p) => n + p.chunk.length, 0);

    for (
      let i = 0;
      i < this.pendingTranscriptPushes.length && total > TRANSCRIPT_PENDING_MAX_CHARS_PER_AGENT;
    ) {
      const pending = this.pendingTranscriptPushes[i]!;
      if (pending.agentId !== agentId) {
        i++;
        continue;
      }
      const excess = total - TRANSCRIPT_PENDING_MAX_CHARS_PER_AGENT;
      if (excess >= pending.chunk.length) {
        total -= pending.chunk.length;
        this.pendingTranscriptPushes.splice(i, 1);
        continue;
      }
      pending.offset += excess;
      pending.chunk = pending.chunk.slice(excess);
      total -= excess;
      i++;
    }
  }

  private sendTranscriptPush(
    agentId: string,
    generation: number,
    chunk: string,
    offset: number,
  ): void {
    this.transcriptPushInFlight = true;
    this.transport
      .send(
        makeNotification(OPERATOR_IPC_TRANSCRIPT, {
          agentId,
          generation,
          offset,
          chunk,
        } as unknown as WirePayload),
      )
      .then(
        () => this.drainTranscriptPush(),
        (error: unknown) => {
          this.pendingTranscriptPushes.length = 0;
          this.transcriptPushInFlight = false;
          this.report(error);
        },
      );
  }

  private drainTranscriptPush(): void {
    if (!this.transport.connected) {
      this.pendingTranscriptPushes.length = 0;
      this.transcriptPushInFlight = false;
      return;
    }
    const next = this.pendingTranscriptPushes.shift();
    if (next == null) {
      this.transcriptPushInFlight = false;
      return;
    }
    this.sendTranscriptPush(next.agentId, next.generation, next.chunk, next.offset);
  }

  private report(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      /* a diagnostic callback must never break the server */
    }
  }
}
