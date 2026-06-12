/**
 * L7 session event definitions: the durable record of which pty session backs a given agent pane.
 * Stored in the PROJECT store (program-data only — Principle 12 pristine-repo). One stream per
 * agent, keyed by `session:<agentId>`. A new `session.created` for the same agent REPLACES the
 * current entry — current-session semantics, not a history log.
 */
import { z } from 'zod';
import type { NewEvent } from '../store/types.js';
import type { SchemaMap } from '../replay/decode.js';
import type { UpcasterRegistry } from '../replay/upcaster.js';

/** Current payload schema version — v1; no upcasters yet. */
export const SESSION_EVENT_V = 1;

/** A pty session was created (or replaced) for an agent pane. */
export const EVENT_SESSION_CREATED = 'session.created' as const;

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

/** Current-version schema map for session events — validated on append AND on read (decode). */
export const sessionSchemas: SchemaMap = new Map<string, z.ZodType>([
  [EVENT_SESSION_CREATED, sessionCreatedSchema],
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
