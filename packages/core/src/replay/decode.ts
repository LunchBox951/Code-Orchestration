import type { z } from 'zod';
import type { StoredEvent } from '../store/types.js';
import { upcast, type UpcasterRegistry } from './upcaster.js';

/** Current-version zod schema per event type. */
export type SchemaMap = Map<string /* type */, z.ZodType>;

/**
 * Read-path decode: lift `event.payload` from its stored version to the current
 * one (via `upcasters`) and validate it against the current schema, returning a
 * StoredEvent whose `payload` is the validated value. The payload is ALREADY a
 * JS value (the store JSON-parsed it on read) — decode does NOT JSON.parse.
 *
 * This is the single transform applied IDENTICALLY on the live path and inside
 * `rebuildAll`; running it on both is what makes a discard+replay reproduce a
 * byte-identical read-model (AC-L0-2).
 *
 * No-schema policy: a type with no registered schema is a programming error (an
 * event type was written without registering its current-version schema), so we
 * throw loudly rather than skip validation (Principle 9 — no-silent-failures).
 * `v` is left as STORED — only `payload` is replaced.
 */
export function decode(
  event: StoredEvent,
  upcasters: UpcasterRegistry,
  schemas: SchemaMap,
): StoredEvent {
  const schema = schemas.get(event.type);
  if (!schema) {
    throw new Error(`decode: no schema registered for event type '${event.type}'`);
  }
  const upcasted = upcast(event.type, event.v, event.payload, upcasters);
  const payload = schema.parse(upcasted);
  return { ...event, payload };
}
