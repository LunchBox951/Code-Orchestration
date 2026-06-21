import type { DatabaseSync } from 'node:sqlite';
import type { Projector } from '../replay/projector.js';
import type { StoredEvent, StoreTx } from '../store/types.js';
import {
  EVENT_CONFIG_SET,
  EVENT_CONFIG_CLEAR,
  configLayerForScope,
  type ConfigSet,
  type ConfigClear,
} from './events.js';

const CREATE_CONFIG_TABLE = `
  CREATE TABLE IF NOT EXISTS config (
    scope TEXT NOT NULL,
    key   TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (scope, key)
  )
`;

/**
 * Defensive create of the `config` read-model. Called from the projector's
 * reset/apply AND the config read path, so a freshly opened store can resolve
 * before any write has happened.
 */
export function ensureConfigTable(db: DatabaseSync): void {
  db.exec(CREATE_CONFIG_TABLE);
}

/**
 * Folds `config.set` / `config.clear` events into the `config` read-model in the
 * GLOBAL db. The row layer is derived from the event scope (`config:global` →
 * `global`, `config:<id>` → `<id>`), so each layer is an independent partition
 * keyed by (scope, key). Maintained in the SAME tx as the append, so the log and
 * the projection commit atomically; carries NO wall-clock field (freeze #6).
 *
 * Config is a generic key→value map that grows by KEYS, not by event types. The
 * two event types map to the two row operations: `config.set` upserts the
 * (scope, key) row; `config.clear` deletes it (reset to inherited/default).
 */
export class ConfigProjector implements Projector {
  readonly name = 'config';

  handles(type: string): boolean {
    return type === EVENT_CONFIG_SET || type === EVENT_CONFIG_CLEAR;
  }

  reset(tx: StoreTx): void {
    const db = tx.raw as DatabaseSync;
    ensureConfigTable(db);
    db.exec('DELETE FROM config');
  }

  apply(tx: StoreTx, event: StoredEvent): void {
    const db = tx.raw as DatabaseSync;
    ensureConfigTable(db);
    const layer = configLayerForScope(event.scope);
    if (event.type === EVENT_CONFIG_CLEAR) {
      const { key } = event.payload as ConfigClear;
      db.prepare('DELETE FROM config WHERE scope = ? AND key = ?').run(layer, key);
      return;
    }
    const { key, value } = event.payload as ConfigSet;
    const json = JSON.stringify(value);
    db.prepare(
      'INSERT INTO config (scope, key, value) VALUES (?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = ?',
    ).run(layer, key, json, json);
  }
}
