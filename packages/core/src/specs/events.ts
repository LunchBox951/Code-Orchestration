/**
 * L6b F1 event definitions for the durable spec record. Lives in the PROJECT store (one per
 * registered project). Pure ORCHESTRATION state stored in program-data only (Principle 12 —
 * pristine-repo).
 *
 * One stream per spec, keyed by the `spec:<taskId>` scope pattern. Three event types model the
 * `draft → locked → archived` lifecycle. This layer defines the events + projection + store only
 * — the drafting/locking MCP verbs are a later task.
 */
import { z } from 'zod';
import type { NewEvent } from '../store/types.js';
import type { SchemaMap } from '../replay/decode.js';
import type { UpcasterRegistry } from '../replay/upcaster.js';
import { criterionSchema, type Criterion } from './criteria-schema.js';

/** Current payload schema version — v1; no upcasters yet. */
export const SPECS_EVENT_V = 1;

/** A spec was drafted (initial creation). */
export const EVENT_SPEC_DRAFTED = 'spec.drafted' as const;

/** A spec was locked (criteria frozen, ready for use). */
export const EVENT_SPEC_LOCKED = 'spec.locked' as const;

/** A spec was archived (no longer active). */
export const EVENT_SPEC_ARCHIVED = 'spec.archived' as const;

/** Scope prefix for the per-spec event stream; suffix is the task id. */
export const SPEC_SCOPE_PREFIX = 'spec:';

/** The per-spec stream scope: `spec:<taskId>`. */
export function specScope(taskId: string): string {
  return SPEC_SCOPE_PREFIX + taskId;
}

/** The `spec.drafted` payload. */
export const specDraftedSchema = z
  .object({
    taskId: z.string().min(1),
    title: z.string().min(1),
    goal: z.string().min(1),
    criteria: z.array(criterionSchema),
    body: z.string(),
  })
  .strict();
export type SpecDrafted = z.infer<typeof specDraftedSchema>;

/** The `spec.locked` payload. */
export const specLockedSchema = z
  .object({
    taskId: z.string().min(1),
    lockedBy: z.string().min(1),
  })
  .strict();
export type SpecLocked = z.infer<typeof specLockedSchema>;

/** The `spec.archived` payload. */
export const specArchivedSchema = z
  .object({
    taskId: z.string().min(1),
  })
  .strict();
export type SpecArchived = z.infer<typeof specArchivedSchema>;

/** Current-version schema map for spec events — validated on append AND on read (decode). */
export const specsSchemas: SchemaMap = new Map<string, z.ZodType>([
  [EVENT_SPEC_DRAFTED, specDraftedSchema],
  [EVENT_SPEC_LOCKED, specLockedSchema],
  [EVENT_SPEC_ARCHIVED, specArchivedSchema],
]);

/** No payload migrations at v1 (an empty chain is the identity upcast). */
export const specsUpcasters: UpcasterRegistry = new Map();

/** Build + validate a `spec.drafted` NewEvent. The drafter is the event `actor`. */
export function makeSpecDraftedEvent(projectId: string, rec: SpecDrafted, actor: string): NewEvent {
  const payload = specDraftedSchema.parse(rec);
  return {
    projectId,
    scope: specScope(payload.taskId),
    type: EVENT_SPEC_DRAFTED,
    v: SPECS_EVENT_V,
    payload,
    actor,
  };
}

/** Build + validate a `spec.locked` NewEvent. The `lockedBy` field is also the event `actor`. */
export function makeSpecLockedEvent(projectId: string, rec: SpecLocked): NewEvent {
  const payload = specLockedSchema.parse(rec);
  return {
    projectId,
    scope: specScope(payload.taskId),
    type: EVENT_SPEC_LOCKED,
    v: SPECS_EVENT_V,
    payload,
    actor: payload.lockedBy,
  };
}

/** Build + validate a `spec.archived` NewEvent. */
export function makeSpecArchivedEvent(
  projectId: string,
  rec: SpecArchived,
  actor: string,
): NewEvent {
  const payload = specArchivedSchema.parse(rec);
  return {
    projectId,
    scope: specScope(payload.taskId),
    type: EVENT_SPEC_ARCHIVED,
    v: SPECS_EVENT_V,
    payload,
    actor,
  };
}

/**
 * A persisted, read-back spec record — the read-model shape the spec store facade returns.
 * Timestamps come from `event.ts` on replay (freeze #6 — never wall-clock).
 */
export interface SpecRecord {
  readonly taskId: string;
  readonly title: string;
  readonly goal: string;
  readonly criteria: readonly Criterion[];
  readonly body: string;
  readonly state: 'draft' | 'locked' | 'archived';
  readonly lockedBy?: string;
  readonly draftedTs: number;
  readonly lockedTs?: number;
  readonly archivedTs?: number;
}
