import { z } from 'zod';
import type { NewEvent } from '../store/types.js';
import type { SchemaMap } from '../replay/decode.js';
import type { UpcasterRegistry } from '../replay/upcaster.js';

/**
 * Registry events live in the GLOBAL store (freeze #4 — program-data only): the
 * owning projectId is the sentinel `@global` and they share the `registry` scope.
 * Nothing here is read from or written to the target repo.
 */
export const GLOBAL_PROJECT_ID = '@global';
export const REGISTRY_SCOPE = 'registry';

/** Event-type discriminants for the project registry. */
export const EVENT_PROJECT_REGISTERED = 'project.registered' as const;
export const EVENT_PROJECT_RELINKED = 'project.relinked' as const;

/** Current payload schema version — v1; no upcasters yet (see {@link registryUpcasters}). */
export const REGISTRY_EVENT_V = 1;

/** `project.registered` — first sighting of a path; mints the opaque id (freeze #1). */
export const projectRegisteredSchema = z.object({
  projectId: z.string(),
  path: z.string(),
});
/** `project.relinked` — headless move; same id, new path, append-only (freeze #5). */
export const projectRelinkedSchema = z.object({
  projectId: z.string(),
  oldPath: z.string(),
  newPath: z.string(),
});

export type ProjectRegistered = z.infer<typeof projectRegisteredSchema>;
export type ProjectRelinked = z.infer<typeof projectRelinkedSchema>;

/** Current-version schema per event type — validated on append AND on read (decode). */
export const registrySchemas: SchemaMap = new Map<string, z.ZodType>([
  [EVENT_PROJECT_REGISTERED, projectRegisteredSchema],
  [EVENT_PROJECT_RELINKED, projectRelinkedSchema],
]);

/** No payload migrations at v1 (an empty chain is the identity upcast). */
export const registryUpcasters: UpcasterRegistry = new Map();

/** Build + validate a `project.registered` event (payload validated before append). */
export function makeRegisteredEvent(projectId: string, path: string): NewEvent {
  return {
    projectId: GLOBAL_PROJECT_ID,
    scope: REGISTRY_SCOPE,
    type: EVENT_PROJECT_REGISTERED,
    v: REGISTRY_EVENT_V,
    payload: projectRegisteredSchema.parse({ projectId, path }),
  };
}

/** Build + validate a `project.relinked` event (payload validated before append). */
export function makeRelinkedEvent(projectId: string, oldPath: string, newPath: string): NewEvent {
  return {
    projectId: GLOBAL_PROJECT_ID,
    scope: REGISTRY_SCOPE,
    type: EVENT_PROJECT_RELINKED,
    v: REGISTRY_EVENT_V,
    payload: projectRelinkedSchema.parse({ projectId, oldPath, newPath }),
  };
}
