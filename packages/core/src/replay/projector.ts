import type { Store, StoreTx, StoredEvent } from '../store/types.js';

/**
 * A read-model derived from the event log. A projector OWNS its read-model
 * table/namespace (named by `name`): it creates the table on `reset`/first use
 * (`CREATE TABLE IF NOT EXISTS …` via `tx.raw as DatabaseSync`), and `reset`
 * must leave it EMPTY so a full re-fold reproduces it deterministically.
 */
export interface Projector {
  readonly name: string; // also its read-model table/namespace
  handles(type: string): boolean; // which event types it folds
  reset(tx: StoreTx): void; // drop/clear this projection's read-model to empty
  apply(tx: StoreTx, event: StoredEvent): void; // fold ONE event (payload already upcast+validated)
}

/**
 * Shared fold step — used BOTH live (inside an append tx) AND during rebuild.
 * Routes the event to every projector whose `handles(event.type)` is true, in
 * input-array order (deterministic; no wall-clock — freeze #6). Running this one
 * code path on both paths is what guarantees a live read-model and a replayed
 * read-model are byte-identical.
 *
 * Live mutation flow parts C/D MUST follow — append, decode, fold, all in ONE
 * `store.transaction` so the event and its projection writes commit atomically:
 *
 *   store.transaction((tx) => {
 *     const [stored] = tx.append([newEvent]);
 *     applyEvent(tx, decode(stored, upcasters, schemas), projectors);
 *   });
 */
export function applyEvent(
  tx: StoreTx,
  event: StoredEvent,
  projectors: readonly Projector[],
): void {
  for (const projector of projectors) {
    if (projector.handles(event.type)) {
      projector.apply(tx, event);
    }
  }
}

/** Page size for streaming the whole log during a rebuild (bounds memory). */
const REPLAY_PAGE_SIZE = 1000;

/**
 * Drop ALL projections then re-fold the WHOLE log in seq order via `applyEvent`.
 * Everything (every `reset` + every fold) commits atomically in ONE transaction,
 * so a rebuild is all-or-nothing. `decode` (Task 3) is applied to each raw event
 * before folding — the SAME upcast+validate the live path runs — and defaults to
 * identity when omitted.
 *
 * This is the AC-L0-2 target: apply a sequence live → snapshot → rebuildAll →
 * snapshot → byte-equal.
 */
export function rebuildAll(
  store: Store,
  projectors: readonly Projector[],
  decode: (e: StoredEvent) => StoredEvent = (e) => e,
): void {
  store.transaction((tx) => {
    for (const projector of projectors) {
      projector.reset(tx);
    }
    // Reading from `store` inside the same tx is safe: node:sqlite is synchronous
    // on a single connection, and replay only writes projection tables (never
    // `events`), so the log we page over is stable.
    let afterSeq = 0;
    for (;;) {
      const batch = store.readAll({ afterSeq, limit: REPLAY_PAGE_SIZE });
      for (const event of batch) {
        applyEvent(tx, decode(event), projectors);
        afterSeq = event.seq;
      }
      if (batch.length < REPLAY_PAGE_SIZE) break;
    }
  });
}
