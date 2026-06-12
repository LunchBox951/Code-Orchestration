/**
 * L7 session event definitions: the durable record of which pty session backs a given agent pane.
 * Stored in the PROJECT store (program-data only — Principle 12 pristine-repo). One stream per
 * agent, keyed by `session:<agentId>`. A second `session.created` for the same active agent fails
 * loud until a later explicit `session.ended` event exists, so duplicate hosts cannot hide each other.
 */
import { z } from 'zod';
import type { NewEvent } from '../store/types.js';
import type { SchemaMap } from '../replay/decode.js';
import type { UpcasterRegistry } from '../replay/upcaster.js';

/** Current payload schema version — v1; no upcasters yet. */
export const SESSION_EVENT_V = 1;

/** A pty session was created for an agent pane. */
export const EVENT_SESSION_CREATED = 'session.created' as const;

/** A pty session ended for an agent pane, clearing the active read-model row. */
export const EVENT_SESSION_ENDED = 'session.ended' as const;

/** Scope prefix for the per-agent session stream; suffix is the agent id. */
export const SESSION_SCOPE_PREFIX = 'session:';

/** The per-agent stream scope: `session:<agentId>`. */
export function sessionScope(agentId: string): string {
  return SESSION_SCOPE_PREFIX + agentId;
}

/**
 * Resume handle: discriminated by provider.
 *   claude → a session id usable by `claude --resume <id>`
 *   codex  → the isolated CODEX_HOME path (`codex resume --last` keys off it)
 */
const resumeHandleSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('claude'), sessionId: z.string().min(1) }),
  z.object({ provider: z.literal('codex'), codexHome: z.string().min(1) }),
]);
export type ResumeHandle = z.infer<typeof resumeHandleSchema>;

/** The `session.created` payload — FROZEN cross-phase contract; do not rename fields. */
export const sessionCreatedSchema = z
  .object({
    agentId: z.string().min(1),
    pane: z.string().min(1),
    cwd: z.string().min(1),
    provider: z.enum(['claude', 'codex']),
    resume: resumeHandleSchema,
  })
  .refine((d) => d.resume.provider === d.provider, {
    message: 'resume.provider must match provider (fail-loud: Principle 9)',
  });
export type SessionCreated = z.infer<typeof sessionCreatedSchema>;

/** The `session.ended` payload — closes one active agent↔pane binding. */
export const sessionEndedSchema = z.object({
  agentId: z.string().min(1),
  pane: z.string().min(1),
});
export type SessionEnded = z.infer<typeof sessionEndedSchema>;

/** Current-version schema map for session events — validated on append AND on read (decode). */
export const sessionSchemas: SchemaMap = new Map<string, z.ZodType>([
  [EVENT_SESSION_CREATED, sessionCreatedSchema],
  [EVENT_SESSION_ENDED, sessionEndedSchema],
]);

/** No payload migrations at v1 (an empty chain is the identity upcast). */
export const sessionUpcasters: UpcasterRegistry = new Map();

/**
 * Build + validate a `session.created` NewEvent. The agent id keys the stream scope and is the
 * actor (the agent owns its own session). Replay-safe: `.parse` validates the payload at
 * construction time (fail-loud on bad data, Principle 9).
 */
export function makeSessionCreatedEvent(projectId: string, rec: SessionCreated): NewEvent {
  const payload = sessionCreatedSchema.parse(rec);
  return {
    projectId,
    scope: sessionScope(payload.agentId),
    type: EVENT_SESSION_CREATED,
    v: SESSION_EVENT_V,
    payload,
    actor: payload.agentId,
  };
}

/**
 * Build + validate a `session.ended` NewEvent. The pane is included so stale pane teardown cannot
 * accidentally clear a newer active session for the same agent.
 */
export function makeSessionEndedEvent(projectId: string, rec: SessionEnded): NewEvent {
  const payload = sessionEndedSchema.parse(rec);
  return {
    projectId,
    scope: sessionScope(payload.agentId),
    type: EVENT_SESSION_ENDED,
    v: SESSION_EVENT_V,
    payload,
    actor: payload.agentId,
  };
}

/**
 * Persisted, read-back session record — the read-model shape the session store facade returns.
 * `createdTs` is the PERSISTED event ts (freeze #6 — never wall-clock on read).
 */
export interface SessionRecord {
  readonly agentId: string;
  readonly pane: string;
  readonly cwd: string;
  readonly provider: 'claude' | 'codex';
  readonly resume: ResumeHandle;
  readonly createdTs: number;
}
