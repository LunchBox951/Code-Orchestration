import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMailStore, type MailStore } from '../../mail/mail-store.js';
import { openRegistry, type ProjectRegistry } from '../../registry/registry.js';
import { openSpecStore, type SpecStore } from '../../specs/specs-store.js';
import { buildCoreRegistry } from '../core-registry.js';
import { checkToolCompleteness } from '../completeness.js';
import { invokeTool } from '../invoke.js';
import type { ToolContext } from '../context.js';

// L6b F1 — co_spec_get: returns a spec record when found, a structured not-found when absent,
// and throws when ctx.specs is absent.

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let mailStores: MailStore[] = [];
let specStores: SpecStore[] = [];
let registries: ProjectRegistry[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  mailStores = [];
  specStores = [];
  registries = [];
  const dir = mkdtempSync(join(tmpdir(), 'co-spec-get-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const m of mailStores) m.close();
  for (const s of specStores) s.close();
  for (const r of registries) r.close();
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
  mailStores = [];
  specStores = [];
  registries = [];
});

function openStores(id: string): { mail: MailStore; specs: SpecStore; registry: ProjectRegistry } {
  const mail = openMailStore(id);
  mailStores.push(mail);
  const specs = openSpecStore(id);
  specStores.push(specs);
  const registry = openRegistry();
  registries.push(registry);
  return { mail, specs, registry };
}

function makeCtx(id: string, overrides: Partial<ToolContext> = {}): ToolContext {
  const { mail, specs, registry } = openStores(id);
  return {
    agent: 'impl-test-1',
    projectId: id,
    cwd: '/tmp',
    mail,
    registry,
    specs,
    ...overrides,
  };
}

const SAMPLE_CRITERIA = [
  { text: 'spec is queryable by task id', verify: 'pnpm vitest run packages/core' },
  { text: 'not-found result is structured' },
];

describe('co_spec_get — found', () => {
  it('returns the full spec record when the spec exists', async () => {
    const ctx = makeCtx('p-spec-get-found');
    ctx.specs!.recordDraft({
      taskId: 'task-abc',
      title: 'My Spec',
      goal: 'Achieve X',
      criteria: SAMPLE_CRITERIA,
      body: 'Full body text.',
      actor: 'coord-1',
    });

    const result = (await invokeTool(buildCoreRegistry(), ctx, 'co_spec_get', {
      task_id: 'task-abc',
    })) as Record<string, unknown>;

    expect(result['found']).toBe(true);
    expect(result['task_id']).toBe('task-abc');
    expect(result['title']).toBe('My Spec');
    expect(result['goal']).toBe('Achieve X');
    expect(result['body']).toBe('Full body text.');
    expect(result['state']).toBe('draft');

    const criteria = result['criteria'] as Array<{ text: string; verify?: string }>;
    expect(criteria).toHaveLength(2);
    expect(criteria[0]?.text).toBe('spec is queryable by task id');
    expect(criteria[0]?.verify).toBe('pnpm vitest run packages/core');
    expect(criteria[1]?.text).toBe('not-found result is structured');
    expect(criteria[1]?.verify).toBeUndefined();
  });

  it('returns locked spec with locked_by and locked_ts', async () => {
    const ctx = makeCtx('p-spec-get-locked');
    ctx.specs!.recordDraft({
      taskId: 'task-1',
      title: 'T',
      goal: 'G',
      criteria: [],
      body: '',
      actor: 'a',
    });
    ctx.specs!.recordLock('task-1', 'coord-1');

    const result = (await invokeTool(buildCoreRegistry(), ctx, 'co_spec_get', {
      task_id: 'task-1',
    })) as Record<string, unknown>;

    expect(result['found']).toBe(true);
    expect(result['state']).toBe('locked');
    expect(result['locked_by']).toBe('coord-1');
    expect(result['locked_ts']).toBeGreaterThan(0);
  });
});

describe('co_spec_get — not found', () => {
  it('returns structured not-found result when spec is absent', async () => {
    const ctx = makeCtx('p-spec-get-absent');

    const result = await invokeTool(buildCoreRegistry(), ctx, 'co_spec_get', {
      task_id: 'ghost-task',
    });

    expect(result).toEqual({ found: false, task_id: 'ghost-task' });
  });
});

describe('co_spec_get — ctx.specs absent', () => {
  it('throws when ctx.specs is not injected', async () => {
    const { mail, registry } = openStores('p-spec-get-no-store');
    const ctx: ToolContext = {
      agent: 'impl-test-1',
      projectId: 'p-spec-get-no-store',
      cwd: '/tmp',
      mail,
      registry,
    };

    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_spec_get', { task_id: 'any' }),
    ).rejects.toThrow(/ctx\.specs absent/i);
  });
});

describe('co_spec_get — completeness gate', () => {
  it('co_spec_get is registered and passes the completeness gate', () => {
    const registry = buildCoreRegistry();
    const violations = checkToolCompleteness(registry);
    expect(violations).toHaveLength(0);

    const tool = registry.list().find((t) => t.name === 'co_spec_get');
    expect(tool).not.toBeUndefined();
    expect(tool?.name).toBe('co_spec_get');
  });
});
