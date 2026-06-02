/**
 * Versioning / migration strategy (Part C.2).
 *
 * Events are immutable: once written, a log row is never rewritten. Each event
 * carries its own payload schema version `v` (as stored, pre-upcast). When a
 * payload shape changes we DO NOT migrate the log; instead we ship an upcaster
 * `vN -> v(N+1)` and apply the chain on read/replay only, transforming an old
 * payload into the current shape in memory. `decode` (upcast + validate) runs
 * identically on the live path and during `rebuildAll`, so a discard+replay
 * reproduces byte-identical read-models from the original events alone.
 *
 * Because the `events` table already declares the four reserved L1 envelope
 * columns (`actor` / `causation_id` / `correlation_id` / `idempotency_key`,
 * LOCKED spec Part B §3 D2; NULL at L0, populated L1+), L1 needs no
 * events-table migration — only new upcasters/schemas as payloads evolve.
 */

/** Transforms a payload from version N to version N+1 for a single event type. */
export type Upcaster = (payload: unknown) => unknown;

/** Per-type ordered upcaster chain: index 0 is v1->v2, index 1 is v2->v3, … */
export type UpcasterRegistry = Map<string /* type */, readonly Upcaster[]>;

/**
 * Walk the registered chain for `type`, lifting `payload` from `fromV` to the
 * current version. Pure: never writes back to the log (events are immutable).
 * An absent or empty chain means the current version is 1; `fromV === current`
 * is identity. Throws loudly when `fromV > current` (Principle 9 — a future
 * event written by a newer `co` must not be silently accepted).
 */
export function upcast(
  type: string,
  fromV: number,
  payload: unknown,
  reg: UpcasterRegistry,
): unknown {
  const chain = reg.get(type) ?? [];
  const currentVersion = chain.length + 1;
  if (fromV > currentVersion) {
    throw new Error(
      `upcast: unsupported future event version for type '${type}': v${fromV} > current v${currentVersion}`,
    );
  }
  let p = payload;
  for (let v = fromV; v - 1 < chain.length; v++) {
    p = chain[v - 1]!(p);
  }
  return p;
}
