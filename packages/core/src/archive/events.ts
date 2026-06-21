/**
 * Event definitions for the durable archive of unmerged coordinator branches.
 * Lives in the PROJECT store (one per registered project), program-data only
 * (Principle 12 — pristine-repo).
 *
 * One stream per archived coordinator, keyed by the `archive:<id>` scope pattern.
 * `archive.appended` records the branch record at cascade-delete time.
 * `archive.removed` removes a record (reaper purge or explicit operator action).
 */
import { z } from 'zod';
import type { NewEvent } from '../store/types.js';
import type { SchemaMap } from '../replay/decode.js';
import type { UpcasterRegistry } from '../replay/upcaster.js';

/** Current payload schema version — v1; no upcasters yet. */
export const ARCHIVE_EVENT_V = 1;

/** A coordinator branch record was appended to the archive. */
export const EVENT_ARCHIVE_APPENDED = 'archive.appended' as const;
/** An archived branch record was removed (reaper purge or explicit deletion). */
export const EVENT_ARCHIVE_REMOVED = 'archive.removed' as const;

/** Scope prefix for the per-archived-coordinator stream; suffix is the coordinator id. */
export const ARCHIVE_SCOPE_PREFIX = 'archive:';

/** The per-archive stream scope: `archive:<id>`. */
export function archiveScope(id: string): string {
  return ARCHIVE_SCOPE_PREFIX + id;
}

/**
 * The `archive.appended` payload: all six fields of the archived coordinator branch record.
 * `deletedAt` and `expiresAt` are CALLER-SUPPLIED payload data (injected clock — never
 * wall-clock in core; replay re-inserts the same payload values, so the reaper is deterministic).
 */
export const archiveAppendedSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  branch: z.string().min(1),
  baseRef: z.string().min(1),
  deletedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
});
export type ArchiveAppended = z.infer<typeof archiveAppendedSchema>;

/** The `archive.removed` payload: the coordinator id to remove from the archive read model. */
export const archiveRemovedSchema = z.object({
  id: z.string().min(1),
});
export type ArchiveRemoved = z.infer<typeof archiveRemovedSchema>;

/** Current-version schema map for archive events — validated on append AND on read (decode). */
export const archiveSchemas: SchemaMap = new Map<string, z.ZodType>([
  [EVENT_ARCHIVE_APPENDED, archiveAppendedSchema],
  [EVENT_ARCHIVE_REMOVED, archiveRemovedSchema],
]);

/** No payload migrations at v1 (an empty chain is the identity upcast). */
export const archiveUpcasters: UpcasterRegistry = new Map();

/** Build + validate an `archive.appended` NewEvent. */
export function makeArchiveAppendedEvent(projectId: string, rec: ArchiveAppended): NewEvent {
  const payload = archiveAppendedSchema.parse(rec);
  return {
    projectId,
    scope: archiveScope(payload.id),
    type: EVENT_ARCHIVE_APPENDED,
    v: ARCHIVE_EVENT_V,
    payload,
    actor: projectId,
  };
}

/** Build + validate an `archive.removed` NewEvent. */
export function makeArchiveRemovedEvent(
  projectId: string,
  rec: ArchiveRemoved,
  actor = projectId,
): NewEvent {
  const payload = archiveRemovedSchema.parse(rec);
  return {
    projectId,
    scope: archiveScope(payload.id),
    type: EVENT_ARCHIVE_REMOVED,
    v: ARCHIVE_EVENT_V,
    payload,
    actor,
  };
}

/**
 * A persisted, read-back archive record — the read-model shape the archive store facade returns.
 * All six fields come from the `archive.appended` payload (injected clock, never wall-clock).
 */
export interface ArchiveRecord {
  readonly id: string;
  readonly name: string;
  readonly branch: string;
  readonly baseRef: string;
  readonly deletedAt: number;
  readonly expiresAt: number;
}
