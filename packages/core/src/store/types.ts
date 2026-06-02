/** A persisted event as it lives in the log (read shape). Immutable. */
export interface StoredEvent {
  readonly seq: number; // global monotonic total order within this store
  readonly ts: number; // epoch ms, store-assigned & persisted
  readonly projectId: string; // owning project id, or '@global'
  readonly scope: string; // stream/partition: 'registry' | 'config' | `${entity}:${id}`
  readonly type: string; // event-type discriminant
  readonly v: number; // payload schema version as STORED (pre-upcast)
  readonly payload: unknown; // raw JSON value; caller upcasts + validates
  readonly actor?: string; // sender / acting agent id (L1 mail activates this)
  readonly causationId?: string; // id of the triggering event
  readonly correlationId?: string; // thread / conversation id
  readonly idempotencyKey?: string; // dedupe key
}

/** What a caller supplies to append; the Store assigns seq and ts. */
export interface NewEvent {
  readonly projectId: string;
  readonly scope: string;
  readonly type: string;
  readonly v: number;
  readonly payload: unknown; // already validated for (type, v) by the caller (later parts)
  readonly actor?: string; // sender / acting agent id (L1 mail activates this)
  readonly causationId?: string; // id of the triggering event
  readonly correlationId?: string; // thread / conversation id
  readonly idempotencyKey?: string; // dedupe key
}

/** Write handle valid only inside a transaction; append + projection writes in ONE atomic unit. */
export interface StoreTx {
  append(events: readonly NewEvent[]): readonly StoredEvent[]; // consecutive seq in this tx
  readonly raw: unknown; // engine-specific tx handle (the SQLite db, in tx)
}

export interface Store {
  append(events: readonly NewEvent[]): readonly StoredEvent[]; // atomic; wraps a transaction
  readStream(scope: string, opts?: { afterSeq?: number; limit?: number }): readonly StoredEvent[];
  readAll(opts?: { afterSeq?: number; limit?: number }): readonly StoredEvent[];
  transaction<R>(fn: (tx: StoreTx) => R): R; // append + projection writes commit/rollback together
  head(): number; // highest assigned seq (0 if empty)
  close(): void;
}
