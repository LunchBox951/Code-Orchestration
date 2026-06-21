import type { DatabaseSync } from 'node:sqlite';
import { decode } from '../replay/decode.js';
import { applyEvent } from '../replay/projector.js';
import { openGlobalStore } from '../store/sqlite-store.js';
import type { ProjectId } from '../registry/registry.js';
import {
  GLOBAL_CONFIG_LAYER,
  configSchemas,
  configUpcasters,
  globalConfigScope,
  makeConfigSetEvent,
  makeConfigClearEvent,
  projectConfigScope,
} from './events.js';
import { ConfigProjector, ensureConfigTable } from './config-projector.js';

/** Effective config = a resolved key→value map (global ⊕ project-overrides). */
export type EffectiveConfig = Readonly<Record<string, unknown>>;

/** The two cascade layers read separately (for source indicators in the UI). */
export interface ConfigLayers {
  readonly global: EffectiveConfig;
  readonly project: EffectiveConfig;
}

/**
 * The config cascade (AC-L0-4). Two layers — a global base and per-project
 * overrides — both stored in the GLOBAL program-data store (freeze #4), keyed by
 * project id; NEVER in any target repo. `resolveEffective` merges them with the
 * project layer winning, reading program-data ONLY.
 */
export interface ConfigStore {
  setGlobal(key: string, value: unknown): void;
  /** Stored in program-data, keyed by project id — never in the repo. */
  setProjectOverride(projectId: ProjectId, key: string, value: unknown): void;
  /** global ⊕ project-overrides; project wins per key; reads program-data ONLY. */
  resolveEffective(projectId: ProjectId): EffectiveConfig;
  /** Remove a key from the global base layer (reset to its built-in default). */
  clearGlobal(key: string): void;
  /** Remove a key from a project override layer (reset to the inherited global). */
  clearProjectOverride(projectId: ProjectId, key: string): void;
  /** The global and project layers read separately (NOT merged); reads program-data ONLY. */
  resolveLayers(projectId: ProjectId): ConfigLayers;
  /** Close the underlying global store (lifecycle helper; not part of the C.3 contract). */
  close(): void;
}

/** Open the GLOBAL store and wire the config projector (the cascade's read-model). */
export function openConfigStore(): ConfigStore {
  // The global store holds the config log + the `config` read-model, alongside the
  // registry. The projection is maintained incrementally and atomically in each
  // set tx — we deliberately do NOT rebuild on open (same as the registry).
  const store = openGlobalStore();
  const projectors = [new ConfigProjector()];

  /** One tx: append the `config.set` event → decode → fold (the documented live flow). */
  const setInScope = (scope: string, key: string, value: unknown): void => {
    store.transaction((tx) => {
      const [stored] = tx.append([makeConfigSetEvent(scope, key, value)]);
      applyEvent(tx, decode(stored!, configUpcasters, configSchemas), projectors);
    });
  };

  /** One tx: append the `config.clear` event → decode → fold (DELETE the row). */
  const clearInScope = (scope: string, key: string): void => {
    store.transaction((tx) => {
      const [stored] = tx.append([makeConfigClearEvent(scope, key)]);
      applyEvent(tx, decode(stored!, configUpcasters, configSchemas), projectors);
    });
  };

  /** Read ONE layer's rows into a plain key→value map (program-data only). */
  const readScope = (db: DatabaseSync, layer: string): Record<string, unknown> => {
    ensureConfigTable(db);
    const out: Record<string, unknown> = {};
    const rows = db
      .prepare('SELECT key, value FROM config WHERE scope = ? ORDER BY key')
      .all(layer);
    for (const row of rows) {
      out[String(row.key)] = JSON.parse(String(row.value));
    }
    return out;
  };

  return {
    setGlobal(key: string, value: unknown): void {
      setInScope(globalConfigScope(), key, value);
    },

    setProjectOverride(projectId: ProjectId, key: string, value: unknown): void {
      setInScope(projectConfigScope(projectId), key, value);
    },

    resolveEffective(projectId: ProjectId): EffectiveConfig {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        return Object.freeze({
          ...readScope(db, GLOBAL_CONFIG_LAYER), // base layer (lower precedence)
          ...readScope(db, projectId), // project overrides win — same keys overwrite the base
        });
      });
    },

    clearGlobal(key: string): void {
      clearInScope(globalConfigScope(), key);
    },

    clearProjectOverride(projectId: ProjectId, key: string): void {
      clearInScope(projectConfigScope(projectId), key);
    },

    resolveLayers(projectId: ProjectId): ConfigLayers {
      return store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        return Object.freeze({
          global: Object.freeze(readScope(db, GLOBAL_CONFIG_LAYER)),
          project: Object.freeze(readScope(db, projectId)),
        });
      });
    },

    close(): void {
      store.close();
    },
  };
}
