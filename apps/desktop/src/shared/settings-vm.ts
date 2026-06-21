import type { SettingDescriptor } from '@co/core';

/**
 * Pure, Electron-free view-model for the Settings tab. `buildSettingsRows` turns the registry
 * descriptors + the two config layers into render-ready rows (effective value, source badge, reset
 * availability, gating); `SettingsVM` holds the latest data and emits on change. The renderer is a
 * thin DOM layer over this — all the source/reset/gating logic lives here so it is unit-testable
 * without a browser or Electron.
 */

export type SettingsLayer = 'global' | 'project';
/** Where the effective value comes from, relative to the active layer. */
export type SettingSource = 'override' | 'inherited' | 'default';

export interface SettingsRow {
  readonly descriptor: SettingDescriptor;
  /** The value applied from the active layer's perspective (override → inherited → default). */
  readonly effectiveValue: unknown;
  readonly source: SettingSource;
  /** True when the ACTIVE layer holds an explicit value that reset (↺) would clear. */
  readonly canReset: boolean;
  /** Non-null when the row should be disabled (no project open, or a gating dependency is off). */
  readonly disabledReason: string | null;
}

export interface SettingsState {
  readonly activeLayer: SettingsLayer;
  readonly projectId: string | null;
  readonly hasProject: boolean;
  readonly rows: readonly SettingsRow[];
}

export interface SettingsData {
  readonly descriptors: readonly SettingDescriptor[];
  readonly global: Readonly<Record<string, unknown>>;
  readonly project: Readonly<Record<string, unknown>>;
  readonly projectId: string | null;
  readonly hasProject: boolean;
}

const has = (map: Readonly<Record<string, unknown>>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(map, key);

/** Build render rows for one active layer. Pure — no I/O, deterministic over its inputs. */
export function buildSettingsRows(args: {
  descriptors: readonly SettingDescriptor[];
  global: Readonly<Record<string, unknown>>;
  project: Readonly<Record<string, unknown>>;
  activeLayer: SettingsLayer;
  hasProject: boolean;
}): readonly SettingsRow[] {
  const { descriptors, global, project, activeLayer, hasProject } = args;
  const labelByKey = new Map(descriptors.map((d) => [d.key, d.label]));

  // The project-wins-over-global precedence below MUST stay in step with core's canonical cascade in
  // ConfigStore.resolveEffective (packages/core/src/config/config-store.ts). It is duplicated here only
  // because the UI additionally needs per-layer SOURCE attribution (override/inherited/default), which
  // the flattened resolveEffective cannot supply. If core ever adds a cascade layer, update both.

  const resolve = (
    d: SettingDescriptor,
  ): { effectiveValue: unknown; source: SettingSource; canReset: boolean } => {
    if (activeLayer === 'project') {
      if (has(project, d.key))
        return { effectiveValue: project[d.key], source: 'override', canReset: true };
      if (has(global, d.key))
        return { effectiveValue: global[d.key], source: 'inherited', canReset: false };
      return { effectiveValue: d.defaultValue, source: 'default', canReset: false };
    }
    if (has(global, d.key))
      return { effectiveValue: global[d.key], source: 'override', canReset: true };
    return { effectiveValue: d.defaultValue, source: 'default', canReset: false };
  };

  const effectiveByKey = new Map(descriptors.map((d) => [d.key, resolve(d).effectiveValue]));

  return descriptors.map((d) => {
    const { effectiveValue, source, canReset } = resolve(d);
    let disabledReason: string | null = null;
    if (activeLayer === 'project' && !hasProject) {
      disabledReason = 'No project open — switch to All projects to edit global defaults.';
    } else if (d.dependsOn && effectiveByKey.get(d.dependsOn.key) !== d.dependsOn.equals) {
      const parentLabel = labelByKey.get(d.dependsOn.key) ?? d.dependsOn.key;
      disabledReason = `Requires “${parentLabel}” first.`;
    }
    return { descriptor: d, effectiveValue, source, canReset, disabledReason };
  });
}

export class SettingsVM {
  private _state: SettingsState = {
    activeLayer: 'project',
    projectId: null,
    hasProject: false,
    rows: [],
  };
  private descriptors: readonly SettingDescriptor[] = [];
  private global: Readonly<Record<string, unknown>> = {};
  private project: Readonly<Record<string, unknown>> = {};
  private readonly listeners = new Set<(state: SettingsState) => void>();

  get state(): SettingsState {
    return this._state;
  }

  /** Replace the underlying data (registry + both layers) and re-derive rows. */
  setData(data: SettingsData): void {
    this.descriptors = data.descriptors;
    this.global = data.global;
    this.project = data.project;
    // Without an open project there are no overrides to edit — fall back to the global layer.
    const activeLayer: SettingsLayer = data.hasProject ? this._state.activeLayer : 'global';
    this._state = {
      ...this._state,
      activeLayer,
      projectId: data.projectId,
      hasProject: data.hasProject,
    };
    this.rebuild();
  }

  /** Switch the edited layer (the `This project | All projects` toggle). */
  setActiveLayer(layer: SettingsLayer): void {
    if (this._state.activeLayer === layer) return;
    if (layer === 'project' && !this._state.hasProject) return; // can't edit a project that isn't open
    this._state = { ...this._state, activeLayer: layer };
    this.rebuild();
  }

  subscribe(listener: (state: SettingsState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private rebuild(): void {
    const rows = buildSettingsRows({
      descriptors: this.descriptors,
      global: this.global,
      project: this.project,
      activeLayer: this._state.activeLayer,
      hasProject: this._state.hasProject,
    });
    this._state = { ...this._state, rows };
    this.emit();
  }

  private emit(): void {
    const state = this._state;
    for (const listener of [...this.listeners]) listener(state);
  }
}
