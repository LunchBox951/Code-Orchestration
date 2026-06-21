import { describe, it, expect, vi } from 'vitest';
import type { SettingDescriptor } from '@co/core';
import { buildSettingsRows, SettingsVM, type SettingsData } from './settings-vm.js';

function desc(
  over: Partial<SettingDescriptor> & Pick<SettingDescriptor, 'key'>,
): SettingDescriptor {
  return {
    section: 'Issues',
    label: over.key,
    description: '',
    control: { kind: 'toggle' },
    defaultValue: false,
    perProject: true,
    primaryLayer: 'project',
    ...over,
  } as SettingDescriptor;
}

const CAPTURE = desc({ key: 'issues.capture', label: 'Capture' });
const PUBLISH = desc({
  key: 'issues.publish',
  label: 'Publish',
  dependsOn: { key: 'issues.capture', equals: true },
});
const MAXED = desc({
  key: 'dispatch.maxedThresholdPct',
  label: 'Threshold',
  section: 'Headroom & Concurrency',
  control: { kind: 'integer', min: 0, max: 100 },
  defaultValue: 95,
});
const DESCRIPTORS = [CAPTURE, PUBLISH, MAXED];

const rowFor = (rows: ReturnType<typeof buildSettingsRows>, key: string) =>
  rows.find((r) => r.descriptor.key === key)!;

describe('buildSettingsRows — source & reset (AC-SET-3)', () => {
  it('project layer: override > inherited > default', () => {
    const rows = buildSettingsRows({
      descriptors: DESCRIPTORS,
      global: { 'dispatch.maxedThresholdPct': 80, 'issues.capture': true },
      project: { 'dispatch.maxedThresholdPct': 60 },
      activeLayer: 'project',
      hasProject: true,
    });
    const maxed = rowFor(rows, 'dispatch.maxedThresholdPct');
    expect(maxed.source).toBe('override');
    expect(maxed.effectiveValue).toBe(60);
    expect(maxed.canReset).toBe(true);

    const capture = rowFor(rows, 'issues.capture');
    expect(capture.source).toBe('inherited'); // only set globally
    expect(capture.effectiveValue).toBe(true);
    expect(capture.canReset).toBe(false);

    const publish = rowFor(rows, 'issues.publish');
    expect(publish.source).toBe('default'); // set nowhere
    expect(publish.effectiveValue).toBe(false);
  });

  it('global layer: set → override, unset → default; never inherited', () => {
    const rows = buildSettingsRows({
      descriptors: DESCRIPTORS,
      global: { 'dispatch.maxedThresholdPct': 80 },
      project: { 'dispatch.maxedThresholdPct': 60 }, // ignored in global view
      activeLayer: 'global',
      hasProject: true,
    });
    const maxed = rowFor(rows, 'dispatch.maxedThresholdPct');
    expect(maxed.source).toBe('override');
    expect(maxed.effectiveValue).toBe(80); // global, NOT the project override
    expect(maxed.canReset).toBe(true);
    expect(rowFor(rows, 'issues.capture').source).toBe('default');
  });
});

describe('buildSettingsRows — gating & no-project', () => {
  it('disables a dependent row until its parent is effectively on', () => {
    const off = buildSettingsRows({
      descriptors: DESCRIPTORS,
      global: {},
      project: {},
      activeLayer: 'project',
      hasProject: true,
    });
    expect(rowFor(off, 'issues.publish').disabledReason).toMatch(/Requires/);

    const on = buildSettingsRows({
      descriptors: DESCRIPTORS,
      global: {},
      project: { 'issues.capture': true },
      activeLayer: 'project',
      hasProject: true,
    });
    expect(rowFor(on, 'issues.publish').disabledReason).toBeNull();
  });

  it('disables every row in the project layer when no project is open', () => {
    const rows = buildSettingsRows({
      descriptors: DESCRIPTORS,
      global: {},
      project: {},
      activeLayer: 'project',
      hasProject: false,
    });
    for (const r of rows) expect(r.disabledReason).toMatch(/No project open/);
  });
});

describe('SettingsVM', () => {
  const data = (over: Partial<SettingsData> = {}): SettingsData => ({
    descriptors: DESCRIPTORS,
    global: {},
    project: {},
    projectId: 'p1',
    hasProject: true,
    ...over,
  });

  it('starts empty and populates on setData', () => {
    const vm = new SettingsVM();
    expect(vm.state.rows).toHaveLength(0);
    vm.setData(data());
    expect(vm.state.rows).toHaveLength(3);
    expect(vm.state.projectId).toBe('p1');
  });

  it('falls back to the global layer when no project is open', () => {
    const vm = new SettingsVM();
    vm.setData(data({ projectId: null, hasProject: false }));
    expect(vm.state.activeLayer).toBe('global');
  });

  it('setActiveLayer switches and re-emits; project switch is a no-op without a project', () => {
    const vm = new SettingsVM();
    const listener = vi.fn();
    vm.subscribe(listener);
    vm.setData(data());
    expect(vm.state.activeLayer).toBe('project');
    vm.setActiveLayer('global');
    expect(vm.state.activeLayer).toBe('global');

    vm.setData(data({ projectId: null, hasProject: false }));
    listener.mockClear();
    vm.setActiveLayer('project'); // no project → ignored
    expect(vm.state.activeLayer).toBe('global');
    expect(listener).not.toHaveBeenCalled();
  });

  it('notifies subscribers on data change and stops after unsubscribe', () => {
    const vm = new SettingsVM();
    const listener = vi.fn();
    const off = vm.subscribe(listener);
    vm.setData(data());
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    vm.setData(data({ global: { 'issues.capture': true } }));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
