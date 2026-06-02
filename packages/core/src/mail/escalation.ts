import {
  MAIL_CHAT,
  MAIL_CLARIFY_REQUEST,
  MAIL_ESCALATION,
  OPERATOR,
  type DeliveredMail,
  type MailType,
} from './events.js';
import type { MailStore } from './mail-store.js';

/**
 * The escalation protocol (AC-L1-6, spec §3.2 Q3/Q4, freeze #5/#7; docs/architecture/mail-bus.md
 * "Escalation is a first-class protocol" + "Two hard guarantees"). A received escalation/clarify
 * is **resolved within mandate or forwarded up the chain — never dropped** (even when the
 * underlying write fails); an agent uncertain on intent raises a **threaded** parent↔child
 * brainstorm rather than guessing; a raised escalation is **sticky until resolved-or-forwarded**;
 * the clarify-timeout policy **defaults to forward-up**; and a coordinator's escalation parent is
 * **always `@operator`** (operator Q3, freeze #5).
 *
 * Like {@link module:./approval}, this is a focused module over a {@link MailStore} (+ a
 * {@link ParentResolver}). It NEVER touches the store directly — every write goes through
 * `send`/`reply`/the {@link module:./delivery.Delivery} seam, which throws on a failed persist, so
 * a dropped write surfaces as a throw (never-drop). The completion semantics live entirely in the
 * generic completion-predicate registry (events.ts): this module is just the typed operations.
 */

/**
 * Resolves an agent's escalation parent (one upward step along the spawn hierarchy).
 *
 * L6 PLUG-POINT: the real resolver knows the spawn hierarchy + escalation authority by ROLE
 * (implementer → its lead → its coordinator → `@operator`). It is a clean seam so L1 can exercise
 * the chain with an injectable double while L6 owns the production, role-based implementation.
 */
export interface ParentResolver {
  /** The agent one step UP the escalation chain from `agentId`. */
  parentOf(agentId: string): string;
}

/**
 * The spawn chain the PROTOTYPE resolver double exercises:
 * `implementer → lead → coordinator → @operator`. Only the three sub-operator ids are
 * configured; the `coordinator → @operator` edge is NOT taken from here — it is forced
 * structurally (freeze #5), so it can never be misconfigured to a peer.
 */
export interface PrototypeChain {
  readonly implementer: string;
  readonly lead: string;
  readonly coordinator: string;
}

/**
 * An injectable PROTOTYPE {@link ParentResolver} double (spec §2 PROTOTYPE — L6 owns the real,
 * role-based one). It wires the full chain `implementer → lead → coordinator → @operator` and
 * **enforces freeze #5 structurally**: a coordinator's parent is decided HERE as {@link OPERATOR}
 * BEFORE any configured edge is consulted, and the configured map deliberately holds no
 * coordinator entry — so a coordinator can never be misconfigured to a peer. The operator is the
 * top of the chain, so asking for ITS parent fails loud (Principle 9); so does an unknown id.
 */
export function prototypeParentResolver(chain: PrototypeChain): ParentResolver {
  // Only the sub-operator edges are configurable; coordinator → @operator is structural (below).
  const parents = new Map<string, string>([
    [chain.implementer, chain.lead],
    [chain.lead, chain.coordinator],
  ]);
  return {
    parentOf(agentId: string): string {
      if (agentId === OPERATOR) {
        throw new Error(
          `prototype parent-resolver: '${OPERATOR}' is the top of the escalation chain (no parent)`,
        );
      }
      // Freeze #5, STRUCTURAL: a coordinator's escalation parent is ALWAYS the operator. Decided
      // here, never from the configured map (which has no coordinator entry), so it cannot drift.
      if (agentId === chain.coordinator) {
        return OPERATOR;
      }
      const parent = parents.get(agentId);
      if (parent == null) {
        throw new Error(
          `prototype parent-resolver: no parent for '${agentId}' ` +
            `(known: ${[...parents.keys(), chain.coordinator].join(', ')})`,
        );
      }
      return parent;
    },
  };
}

/** What a caller raises an escalation from — the asker + a readable problem summary + context. */
export interface EscalationRequest {
  readonly from: string;
  readonly subject: string;
  readonly body: string;
  readonly idempotencyKey?: string;
}

/**
 * RAISE an escalation: `req.from` escalates UP to `resolver.parentOf(req.from)`. Routes through
 * `send`/the Delivery seam, which THROWS on a failed persist — we deliberately do not swallow it
 * (never-drop, freeze #5): a dropped write surfaces as a throw, never a silent success.
 */
export function escalate(
  mail: MailStore,
  resolver: ParentResolver,
  req: EscalationRequest,
): DeliveredMail {
  return mail.send({
    type: MAIL_ESCALATION,
    to: resolver.parentOf(req.from),
    from: req.from,
    subject: req.subject,
    body: req.body,
    ...(req.idempotencyKey != null ? { idempotencyKey: req.idempotencyKey } : {}),
  });
}

/**
 * FORWARD a held escalation UP: the holder (`held.recipient`) re-raises it to ITS parent
 * (`resolver.parentOf(holder)`), reusing the thread (`correlationId`) and setting
 * `causationId = held.seq`. Because the new escalation's `sender` is the holder and its
 * `causationId` is `held.seq`, folding it DISCHARGES `held` (the holder acted — resolve-or-forward)
 * AND leaves the parent holding a fresh outstanding escalation, so the chain advances by one step.
 * Routes through `send`/the Delivery seam → throws on a failed persist (never-drop, freeze #5).
 */
export function forwardEscalation(
  mail: MailStore,
  resolver: ParentResolver,
  held: DeliveredMail,
): DeliveredMail {
  const holder = held.recipient;
  return mail.send({
    type: MAIL_ESCALATION,
    to: resolver.parentOf(holder),
    from: holder,
    subject: held.subject,
    body: held.body,
    // Reuse the thread; if `held` is the root it has no correlationId, so its own seq IS the thread.
    correlationId: held.correlationId ?? String(held.seq),
    causationId: String(held.seq),
  });
}

/** How a holder resolves a held escalation DOWN to the asker: prose + an optional carrier type. */
export interface EscalationResolution {
  /** The carrier for the answer; defaults to an informational {@link MAIL_CHAT}. */
  readonly type?: MailType;
  readonly subject: string;
  readonly body: string;
  readonly idempotencyKey?: string;
}

/**
 * RESOLVE a held escalation DOWN: the holder (`held.recipient`) replies in-thread to the asker
 * (`held.sender`) via {@link MailStore.reply}, which sets `causationId = held.seq` and threads the
 * answer back to the asker. The reply's `sender` is the holder and its `causationId` is `held.seq`,
 * so folding it DISCHARGES `held` (resolve-or-forward). The carrier defaults to an informational
 * `chat` (the resolution itself demands no further action). Throws on a failed persist (never-drop).
 */
export function resolveEscalation(
  mail: MailStore,
  held: DeliveredMail,
  resolution: EscalationResolution,
): DeliveredMail {
  return mail.reply(held, {
    type: resolution.type ?? MAIL_CHAT,
    subject: resolution.subject,
    body: resolution.body,
    ...(resolution.idempotencyKey != null ? { idempotencyKey: resolution.idempotencyKey } : {}),
  });
}

// ── Clarify-timeout policy (Q4) — POLICY/DATA ONLY; the FIRING is L7 (no wall-clock here) ──

/** The config key for the clarify-timeout (seconds an asker waits before the policy applies). */
export const CLARIFY_TIMEOUT_SECONDS_KEY = 'clarify_timeout_seconds' as const;

/** Default clarify-timeout: 30 minutes. The asker blocks at most this long before forward-up. */
export const CLARIFY_TIMEOUT_SECONDS_DEFAULT = 1800;

/** The clarify-timeout policy. `forward-up` is the only v1 policy (Q4): escalate it up the chain. */
export type ClarifyTimeoutPolicy = 'forward-up';

/** The active clarify-timeout policy (Q4) — forward an unanswered question up the chain. */
export const CLARIFY_TIMEOUT_POLICY: ClarifyTimeoutPolicy = 'forward-up';

/**
 * Apply the clarify-timeout policy ({@link CLARIFY_TIMEOUT_POLICY} = `forward-up`, Q4) to an
 * `unanswered` clarify/escalation: forward it UP the chain via the SAME threading as a manual
 * {@link forwardEscalation} (reuse `correlationId`, `causationId = unanswered.seq`, route to the
 * holder's parent). An unanswered question thus becomes a problem for the higher level, which now
 * has the context/authority to settle it.
 *
 * ⚠️ THE FIRING IS L7, NOT HERE. This function encodes only WHAT the policy does, never WHEN. A
 * wall-clock timer (Conductor-side, deterministic-replay-safe) is what decides to call this after
 * `clarify_timeout_seconds` of no answer. We deliberately read NO clock and run NO timer here
 * (freeze #6) — so replay stays deterministic. What L7 must do: track each unresolved
 * clarify/escalation's age against {@link CLARIFY_TIMEOUT_SECONDS_KEY} and invoke this on expiry.
 */
export function forwardOnTimeout(
  mail: MailStore,
  resolver: ParentResolver,
  unanswered: DeliveredMail,
): DeliveredMail {
  return forwardEscalation(mail, resolver, unanswered);
}

// ── Asker-blocked / WAITING (own the bus-side DATA; the lifecycle/suspend is L6/L7) ──

/**
 * The unresolved `clarify_request`s an agent RAISED — the items it is WAITING on (never-guess: it
 * blocks rather than proceeding on a guess). Derived purely from the inbox read-model by `sender`
 * + unresolved, so it is a function of the log and survives a `rebuildAll` (replay-safe).
 *
 * This owns only the bus-side DATA the WAITING lifecycle reads. The actual turn suspend/resume —
 * flipping the asker to WAITING and waking it on an answer — is L6/L7, NOT modeled here.
 */
export function waitingItems(mail: MailStore, agent: string): readonly DeliveredMail[] {
  return mail.sentBy(agent).filter((m) => m.type === MAIL_CLARIFY_REQUEST && !m.resolved);
}

/** Whether `agent` is WAITING — it has at least one unresolved `clarify_request` it raised. */
export function isAwaitingReply(mail: MailStore, agent: string): boolean {
  return waitingItems(mail, agent).length > 0;
}
