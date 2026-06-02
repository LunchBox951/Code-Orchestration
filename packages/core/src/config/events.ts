import { z } from 'zod';
import type { NewEvent } from '../store/types.js';
import type { SchemaMap } from '../replay/decode.js';
import type { UpcasterRegistry } from '../replay/upcaster.js';
import type { ProjectId } from '../registry/registry.js';

/** JSON-round-trippable value — rejects undefined, NaN, Infinity, functions, symbols. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

// Recursive zod schema enforcing full JSON safety at every nesting level.
// .finite() is load-bearing: it rejects BOTH NaN and Infinity. Do NOT drop it —
// Infinity is not JSON-safe (JSON.stringify(Infinity) === 'null'), which would silently
// corrupt config values.
// The cast is needed because TypeScript cannot prove the lazy union's inferred
// output type is exactly assignable to JsonValue without the recursive annotation.
const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
) as unknown as z.ZodType<JsonValue>;

/**
 * Config events live in the GLOBAL store (freeze #4 — program-data only), so the
 * owning envelope projectId is the sentinel `@global` (the store owner), exactly
 * like the registry. The config *layer* (global base vs. a per-project override)
 * is encoded in the event SCOPE using the C.1 `${entity}:${id}` stream pattern —
 * each layer is its own stream:
 *   - global base:      scope = 'config:global'
 *   - project override: scope = 'config:<projectId>'
 * Nothing here is read from or written to any target repo.
 */
export const GLOBAL_PROJECT_ID = '@global';

/** Scope prefix shared by every config stream; the suffix is the layer. */
export const CONFIG_SCOPE_PREFIX = 'config:';
/** The base (global) layer's suffix — a project id can never collide (ids are UUIDs). */
export const GLOBAL_CONFIG_LAYER = 'global';

/** Single config event type; one generic key→value set per event (seed schema minimal). */
export const EVENT_CONFIG_SET = 'config.set' as const;

/** Current payload schema version — v1; no upcasters yet (see {@link configUpcasters}). */
export const CONFIG_EVENT_V = 1;

/**
 * `config.set` — assign one key to one value in a layer. Config is a generic
 * key→value map: `value` is an opaque JSON value (string, number, boolean, null,
 * object, array). We deliberately do NOT enforce a fixed config schema here —
 * later layers grow their fields THROUGH ConfigStore, not by editing this type.
 */
// jsonValue enforces full JSON safety recursively — Principle 9.
export const configSetSchema = z.object({
  key: z.string(),
  value: jsonValue,
});
export type ConfigSet = z.infer<typeof configSetSchema>;

/** Current-version schema per event type — validated on append AND on read (decode). */
export const configSchemas: SchemaMap = new Map<string, z.ZodType>([
  [EVENT_CONFIG_SET, configSetSchema],
]);

/** No payload migrations at v1 (an empty chain is the identity upcast). */
export const configUpcasters: UpcasterRegistry = new Map();

/** The global base layer's stream scope: `config:global`. */
export function globalConfigScope(): string {
  return CONFIG_SCOPE_PREFIX + GLOBAL_CONFIG_LAYER;
}

/** A project override layer's stream scope: `config:<projectId>` (program-data, keyed by id). */
export function projectConfigScope(projectId: ProjectId): string {
  return CONFIG_SCOPE_PREFIX + projectId;
}

/**
 * Derive the read-model layer key from an event scope:
 * `config:global` → `global`; `config:<id>` → `<id>`. Fails loud (Principle 9)
 * on an unexpected scope rather than silently folding into the wrong layer.
 */
export function configLayerForScope(scope: string): string {
  if (!scope.startsWith(CONFIG_SCOPE_PREFIX)) {
    throw new Error(`config: unexpected scope '${scope}' (want '${CONFIG_SCOPE_PREFIX}…')`);
  }
  return scope.slice(CONFIG_SCOPE_PREFIX.length);
}

/** Build + validate a `config.set` event for `scope` (payload validated before append). */
export function makeConfigSetEvent(scope: string, key: string, value: unknown): NewEvent {
  return {
    projectId: GLOBAL_PROJECT_ID,
    scope,
    type: EVENT_CONFIG_SET,
    v: CONFIG_EVENT_V,
    payload: configSetSchema.parse({ key, value }),
  };
}
