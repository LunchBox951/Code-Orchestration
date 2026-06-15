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

/**
 * The JSON-RPC method names the operator-IPC wire speaks. Server + client agree on these — a single
 * source so a typo cannot drift the two sides apart. CONTROL verbs act on live agents (via the
 * daemon-backed router); OBSERVE reads the live snapshot; the two mail WRITE verbs route through the
 * daemon (single writer — MNR #2).
 */
export const OPERATOR_IPC_METHODS = {
  /** Snapshot the LIVE observability view (roster ⊕ warm/paused/stuck + outstanding + cost). */
  observe: 'observe',
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
  /** Approve/decline an outstanding `approval` as a structured `approval_response`. */
  approve: 'approve',
  /** Mark `recipient`'s informational mail at `seq` read (event-sourced — single writer). */
  markRead: 'markRead',
  /** Fetch a hosted agent's bounded transcript tail (most-recent pane bytes) on demand. */
  transcript: 'transcript',
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
  /** Approve/decline the `approval` at `approvalSeq` (operator-terminal; single writer). */
  approve(approvalSeq: number, reply: ApprovalReply): Promise<DeliveredMail>;
  /** Mark `recipient`'s mail at `seq` read (event-sourced read-state — single writer, MNR #2). */
  markRead(recipient: string, seq: number): Promise<DeliveredMail>;
  /** Fetch `agentId`'s bounded transcript tail (most-recent pane bytes; `''` if none/not hosted). */
  transcript(agentId: string): Promise<TranscriptTail>;
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
  readonly tail: string;
}

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
