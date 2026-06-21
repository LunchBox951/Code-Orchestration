/**
 * Stage 11 P1 (OP-IPC · §3a) — the TRANSPORT-AGNOSTIC operator-IPC contract.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 * This module is PURE TYPES + a couple of string-constant maps. It does NO I/O and references ONLY
 * core types (all already barrel-exported): the wire shapes the desktop app and the daemon agree on
 * before either touches a socket. The Unix-domain-socket JSON-RPC SERVER (daemon side) and CLIENT
 * (app side) live in `@co/mcp` and speak exactly this vocabulary — keeping the contract here (core)
 * means the app can type against it without taking an `@co/mcp` dependency for the shapes alone.
 *
 * Registers ZERO agent MCP tools — there is no `ToolSpec` here. The operator IPC is filesystem-
 * permissioned (operator-uid-only socket), NEVER an agent surface (Principle 4 + D4; AC-S11-6).
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 */
import type { ApprovalDecision, DeliveredMail } from '../mail/events.js';
import type { ReplyDraft } from '../mail/mail-store.js';
import type { Steer } from '../pty/steer.js';
import type { LiveObservabilitySnapshot, ObservabilitySnapshot } from '../doctor/observability.js';
import type { Criterion } from '../specs/criteria-schema.js';

/**
 * The JSON-RPC method names the operator-IPC wire speaks. Server + client agree on these — a single
 * source so a typo cannot drift the two sides apart. CONTROL verbs act on live agents (via the
 * daemon-backed router); OBSERVE reads the live snapshot; the two mail WRITE verbs route through the
 * daemon (single writer — MNR #2).
 */
export const OPERATOR_IPC_METHODS = {
  /** Snapshot the LIVE observability view (roster ⊕ warm/paused/stuck + outstanding + cost). */
  observe: 'observe',
  /** List archived (unmerged) coordinator branches — degrades silently to `[]` when the socket is down. */
  listArchive: 'listArchive',
  /**
   * Un-archive a coordinator branch: remove the archive record (branch STAYS; no git delete). A control
   * verb — fails loud when the socket is down (Principle 9).
   */
  restoreArchive: 'restoreArchive',
  /**
   * Hard-purge an archived branch: `git branch -D <branch>` then remove the archive record. A control
   * verb — fails loud when the socket is down (Principle 9).
   */
  purgeArchive: 'purgeArchive',
  /** Pause an agent (the daemon skips it until {@link OPERATOR_IPC_METHODS.resume}). */
  pause: 'pause',
  /** Resume a paused agent. */
  resume: 'resume',
  /** Stop an agent (release its warm pane; no further turns). */
  stop: 'stop',
  /** Unstick a STUCK agent = `revertStuck` + `rewake` (MNR #4) — eligible again next tick. */
  unstick: 'unstick',
  /** Steer a warm pane mid-turn (answer / redirect / interrupt) WITHOUT teardown. */
  steer: 'steer',
  /** Reply to an actionable mail (routed through the daemon — single writer). */
  reply: 'reply',
  /**
   * Send a FRESH operator message to an agent (the operator's "message the coordinator" action). Posts
   * an actionable `clarify_request` from `@operator`, so the daemon wakes a WAITING/idle recipient on its
   * next tick (an informational `operator_message` would never drive a turn — see {@link selectEligible}).
   * Distinct from {@link OPERATOR_IPC_METHODS.steer}, which needs an already-warm pane; this is the path
   * that reaches an idle agent. Single writer (daemon-side store).
   */
  operatorMessage: 'operatorMessage',
  /** Approve/decline an outstanding `approval` as a structured `approval_response`. */
  approve: 'approve',
  /** Mark `recipient`'s informational mail at `seq` read (event-sourced — single writer). */
  markRead: 'markRead',
  /** Fetch a hosted agent's bounded transcript tail (most-recent pane bytes) on demand. */
  transcript: 'transcript',
  /** Fetch everything the in-app Review view needs for a pending human review (diff + criteria + refs). */
  reviewContext: 'reviewContext',
  /**
   * Start a ROOT coordinator session (operator-only — the IPC socket is operator-uid-only by OS
   * permission; this is NEVER an agent-callable MCP tool). Provisions the worktree, seeds the
   * actionable `clarify_request` kickoff, and registers the roster coordinator. The running daemon then
   * cold-starts the root on its next tick. Exactly one of `prompt` / `specBody` is required.
   */
  startSession: 'startSession',
  /**
   * Delete an agent and its entire subtree (recursive descendants + their worktrees + branches). The
   * daemon's single writer: callers never act on the stores directly. Delegates to
   * `ConductorControlSurface.deleteAgent` which cascades through the core primitive.
   */
  deleteAgent: 'deleteAgent',
  /**
   * Re-wake a stopped/paused/stuck agent by clearing all suppression state and posting an actionable
   * `clarify_request` from `@operator` — so `selectEligible` picks it up on the next daemon tick.
   * Unlike {@link OPERATOR_IPC_METHODS.operatorMessage} (which posts but does not unstop), this verb
   * ALWAYS clears suppression first, then posts.
   */
  rewake: 'rewake',
  /** Send raw keystroke bytes into a hosted agent's PTY stdin (live xterm → PTY passthrough). */
  sendInput: 'session:input',
  /** Resize a hosted agent's PTY to the given cols × rows (xterm fit → PTY width sync). */
  resize: 'session:resize',
} as const;

/** The set of operator-IPC request method names. */
export type OperatorIpcMethod = (typeof OPERATOR_IPC_METHODS)[keyof typeof OPERATOR_IPC_METHODS];

/**
 * The server-push notification method. The daemon forwards a FRESH whole snapshot on every tick (D6 —
 * push the entire {@link LiveObservabilitySnapshot}; do NOT optimize to deltas to start). It is a
 * JSON-RPC notification (no id, no response).
 */
export const OPERATOR_IPC_TICK = 'tick' as const;

/**
 * The server-push notification method for the LIVE TRANSCRIPT stream (Stage 12 C-P1). As a hosted
 * agent's pane produces output bytes, the daemon forwards each chunk outward as a JSON-RPC notification
 * (no id, no response). It is EVENT-DRIVEN — fired on each new chunk, NOT on the {@link OPERATOR_IPC_TICK}
 * cadence — so it rides its own engine subscription rather than the tick. A DISTINCT string from the
 * `transcript` request method ({@link OPERATOR_IPC_METHODS.transcript}) so the push and the on-demand
 * tail request are unambiguous and self-documenting on the wire.
 */
export const OPERATOR_IPC_TRANSCRIPT = 'transcript:push' as const;

/**
 * A locator for a mail being answered: its store `seq` plus whose inbox holds it. The cross-process
 * client never ships a whole {@link DeliveredMail} back to be replied to — it names the target, and
 * the daemon re-reads the authoritative row from its own store (single writer — MNR #2).
 */
export interface OperatorMailRef {
  /** The store seq (identity) of the mail being answered. */
  readonly seq: number;
  /** The recipient whose inbox holds that mail (the inbox the daemon reads it from). */
  readonly recipient: string;
}

/**
 * The prose + decision an approve/decline write carries. The daemon turns it into the structured
 * `approval_response` reply (`{ type: 'approval_response', decision, subject, body }`) and posts it
 * back to the asker through its own {@link MailStore} (single writer — MNR #2).
 */
export interface ApprovalReply {
  /** Bless the action (`approve`) or refuse it (`decline`). */
  readonly decision: ApprovalDecision;
  readonly subject: string;
  readonly body: string;
}

/**
 * Parameters for the `startSession` operator-IPC method. Exactly one of `prompt` / `specBody` is
 * required (Principle 9 — fail loud). Operator-only: the IPC socket is operator-uid-only by OS
 * permission; this is NEVER an agent-callable MCP tool (Principle 4 + D4).
 */
export interface StartSessionParams {
  /**
   * A human-readable name for this coordinator (e.g. `'Auth Refactor'`). Optional at the type level
   * so the existing desktop call still compiles before C1 lands, but the server enforces it at
   * runtime via `requireString` (Principle 9 — fail loud).
   */
  readonly name?: string;
  /** The operator's free-form kickoff prompt. Exactly one of `prompt` / `specBody`. */
  readonly prompt?: string;
  /** A draft-spec brief to kick off from. Exactly one of `prompt` / `specBody`. */
  readonly specBody?: string;
}

/**
 * The result of a `startSession` call: the deterministic root coordinator id + worktree facts. The
 * daemon will cold-start the root on its next tick (the start primitive does NOT mint a session).
 */
export interface StartSessionResult {
  /** The deterministic root coordinator id, now registered (roster) + provisioned (worktree). */
  readonly coordinator: string;
  /** Absolute path of the root's provisioned worktree (the daemon's cold-start cwd). */
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseRef: string;
  readonly baseSha: string;
}

/**
 * One archived coordinator branch entry — a mirror of the store's `ArchiveRecord`, carried over the
 * wire. All six fields are read-only (desktop renders, never mutates). Numbers match the store's
 * epoch-ms convention. Named `ArchiveEntry` (not `ArchiveRecord`) so the contract has no implicit
 * dependency on the store layer's internal type — the desktop never imports from the store directly.
 */
export interface ArchiveEntry {
  readonly id: string;
  readonly name: string;
  readonly branch: string;
  readonly baseRef: string;
  /** Epoch ms when the coordinator branch was archived (deleted from the active roster). */
  readonly deletedAt: number;
  /** Epoch ms when the reaper will hard-delete the branch unless the operator restores or purges it first. */
  readonly expiresAt: number;
}

/**
 * The transport-agnostic operator surface the wire exposes: the daemon-side SERVER implements it over
 * a live Conductor control surface + a {@link MailStore}; the app-side CLIENT calls it over the
 * socket. Every method is async (the wire is async); the void verbs resolve once the daemon has
 * applied them.
 */
export interface OperatorIpcSurface {
  /** The live observability snapshot (the same shape the in-process daemon builds). */
  observe(): Promise<LiveObservabilitySnapshot>;
  /** Pause `agentId` (daemon skips it until {@link resume}). */
  pause(agentId: string): Promise<void>;
  /** Resume a paused `agentId`. */
  resume(agentId: string): Promise<void>;
  /** Stop `agentId` — release its warm pane; no further turns. */
  stop(agentId: string): Promise<void>;
  /** Unstick `agentId` (`revertStuck` + `rewake`) — eligible again next tick (MNR #4). */
  unstick(agentId: string): Promise<void>;
  /** Steer `agentId`'s warm pane mid-turn WITHOUT teardown. */
  steer(agentId: string, steer: Steer): Promise<void>;
  /** Reply to the mail named by `target` with `draft` (single writer — daemon-side). */
  reply(target: OperatorMailRef, draft: ReplyDraft): Promise<DeliveredMail>;
  /**
   * Send a fresh operator message to `agentId` as an actionable `clarify_request` from `@operator`
   * (single writer — daemon-side). Unlike {@link steer} (which requires a warm pane), this reaches an
   * idle/WAITING agent: the daemon selects it on the next tick because the message is outstanding +
   * actionable. The operator's "message the coordinator" affordance routes here when the agent is cold.
   */
  operatorMessage(agentId: string, subject: string, body: string): Promise<DeliveredMail>;
  /** Approve/decline the `approval` at `approvalSeq` (operator-terminal; single writer). */
  approve(approvalSeq: number, reply: ApprovalReply): Promise<DeliveredMail>;
  /** Mark `recipient`'s mail at `seq` read (event-sourced read-state — single writer, MNR #2). */
  markRead(recipient: string, seq: number): Promise<DeliveredMail>;
  /** Fetch `agentId`'s bounded transcript tail (most-recent pane bytes; `''` if none/not hosted). */
  transcript(agentId: string): Promise<TranscriptTail>;
  /** Resolve `reviewId`'s review context (diff + criteria + branch/target/scope). DEGRADES EXPLICITLY. */
  reviewContext(reviewId: string): Promise<ReviewContext>;
  /**
   * Start a ROOT coordinator session (operator-only — IPC socket is operator-uid-only). Provisions
   * the worktree, seeds the `clarify_request` kickoff, and registers the roster coordinator. The
   * daemon cold-starts the root on its next tick. Fails loud unless exactly one of `prompt` /
   * `specBody` is supplied (Principle 9).
   */
  startSession(params: StartSessionParams): Promise<StartSessionResult>;
  /**
   * Delete `agentId` and its entire subtree (recursive descendants + worktrees + branches). A
   * control verb that requires the daemon socket — throws a clear error when the Conductor is down
   * (Principle 9). Delegates to `ConductorControlSurface.deleteAgent` which cascades through the
   * core primitive.
   */
  deleteAgent(agentId: string): Promise<void>;
  /**
   * Re-wake `agentId`: clear all suppression state (stopped/paused/stuck) then post an actionable
   * `clarify_request` from `@operator` so the daemon's `selectEligible` wakes the recipient on its
   * next tick. Fails loud when the Conductor socket is down (Principle 9).
   */
  rewake(agentId: string, message: string): Promise<DeliveredMail>;
  /** Send raw keystroke bytes into `agentId`'s warm PTY stdin (live xterm → PTY passthrough). */
  sendInput(agentId: string, data: string): Promise<void>;
  /** Resize `agentId`'s warm PTY to `cols` × `rows` (xterm fit → PTY width sync). */
  resize(agentId: string, cols: number, rows: number): Promise<void>;
  /**
   * List archived (unmerged) coordinator branches. A READ — degrades silently to `[]` when the
   * Conductor socket is down (mirrors {@link observe}; never hangs, never throws — Principle 9 / MNR #3).
   */
  listArchive(): Promise<readonly ArchiveEntry[]>;
  /**
   * Un-archive a coordinator branch: remove the archive record so the reaper skips it. The branch STAYS
   * (Restore = promote to an ordinary branch; no git delete). A control verb — fails loud when down
   * (Principle 9).
   */
  restoreArchive(id: string): Promise<void>;
  /**
   * Hard-purge an archived branch now: `git branch -D <branch>` then remove the archive record.
   * A control verb — fails loud when the Conductor socket is down (Principle 9).
   */
  purgeArchive(id: string): Promise<void>;
}

/**
 * The `tick` server-push payload: the whole fresh live snapshot (D6 — no deltas yet). Carried as the
 * notification `params` so a reconnecting client resumes the stream with a complete picture.
 */
export interface OperatorIpcTick {
  readonly snapshot: LiveObservabilitySnapshot;
}

/**
 * The `transcript:push` ({@link OPERATOR_IPC_TRANSCRIPT}) server-push payload: one chunk of a hosted
 * agent's live pane output, carried as the notification `params`. The chunk is the raw pane `string`
 * with ANSI/ESC control bytes PRESERVED (xterm.js consumes the string directly; JSON round-trips a
 * string exactly, escapes included). PINNED public shape — Console phases C-P2/C-P3 and the renderer
 * consume it; do not rename.
 */
export interface OperatorIpcTranscript {
  readonly agentId: string;
  /** Absolute character offset where `chunk` starts in the agent's pane transcript stream. */
  readonly offset: number;
  readonly chunk: string;
}

/**
 * The on-demand `transcript` ({@link OPERATOR_IPC_METHODS.transcript}) request result: a hosted agent's
 * bounded transcript tail — the most-recent pane bytes, up to the engine's character bound. `tail` is
 * `''` when the agent is not hosted or has produced no output yet (the read DEGRADES cleanly — never a
 * hang/throw). PINNED public shape — Console phases C-P2/C-P3 and the renderer consume it; do not rename.
 */
export interface TranscriptTail {
  readonly agentId: string;
  /** Absolute character offset where `tail` starts in the agent's pane transcript stream. */
  readonly offset: number;
  readonly tail: string;
}

/**
 * The on-demand `reviewContext` ({@link OPERATOR_IPC_METHODS.reviewContext}) result — everything the
 * in-app Review view needs for a pending HUMAN review. DEGRADES EXPLICITLY (never blank — Principle 9):
 * a missing review, a missing worktree, an unresolved spec, and a down conductor each surface a NAMED
 * state the view renders. PINNED public shape — ReviewVM (R-B) and the renderer (R-C) consume it; do
 * not rename fields.
 */
export type ReviewContext =
  | ReviewContextResolved
  | { readonly kind: 'not-found'; readonly reviewId: string }
  | { readonly kind: 'conductor-down'; readonly reviewId: string };

/** The fully-resolved context: the request's branch/target/scope ⊕ a diff half ⊕ a criteria half. */
export interface ReviewContextResolved {
  readonly kind: 'resolved';
  readonly reviewId: string;
  /** Fingerprint of the exact diff/criteria/finish evidence the operator reviewed. */
  readonly evidenceFingerprint: string;
  /** The source branch under review. */
  readonly branch: string;
  /** The merge target the diff is computed against (`git diff target...branch`). */
  readonly target: string;
  /** The review scope label (e.g. `'pr_merge'`). */
  readonly scope: string;
  /** The unified diff, or an explicit unavailable marker (never a silent `''` on failure). */
  readonly diff: ReviewDiff;
  /** The source's acceptance criteria, or the explicit no-locked-spec marker. */
  readonly criteria: ReviewCriteria;
}

/** The diff half: the patch text (possibly `''` = no changes), or a NAMED reason it is unavailable. */
export type ReviewDiff =
  | { readonly kind: 'patch'; readonly patch: string }
  | { readonly kind: 'unavailable'; readonly reason: 'worktree-missing' | 'git-failed' };

/** The criteria half: the resolved AC ref + criteria, or the explicit no-locked-spec marker. */
export type ReviewCriteria =
  | { readonly kind: 'criteria'; readonly specRef: string; readonly criteria: readonly Criterion[] }
  | { readonly kind: 'no-locked-spec' };

/** Why the live overlay is unavailable in a degraded (static) read. One reason for v1. */
export type OperatorUnavailableReason = 'conductor-not-running';

/**
 * A HYBRID read result (D5). When the socket is up, the client returns the engine-backed LIVE overlay;
 * when the Conductor is down/absent it falls back to the pure-static {@link ObservabilitySnapshot}
 * (a direct program-data read) tagged with a clear reason — never a hang, never an unhandled throw
 * (Principle 9 / MNR #3). The two are distinguished by `kind`, so a UI can render "Conductor not
 * running" without guessing.
 */
export type OperatorObservation =
  | { readonly kind: 'live'; readonly snapshot: LiveObservabilitySnapshot }
  | {
      readonly kind: 'static';
      readonly snapshot: ObservabilitySnapshot;
      readonly reason: OperatorUnavailableReason;
    };

/** The client's socket-connection state — surfaced so a UI can show live vs degraded + reconnect. */
export type OperatorIpcConnectionState = 'connected' | 'disconnected';
