import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPERATOR } from '../../mail/events.js';
import { openMailStore, type MailStore } from '../../mail/mail-store.js';
import { openRegistry, type ProjectRegistry } from '../../registry/registry.js';
import { openSpecStore, type SpecStore } from '../../specs/specs-store.js';
import type { Criterion } from '../../specs/criteria-schema.js';
import { buildCoreRegistry } from '../core-registry.js';
import { checkToolCompleteness } from '../completeness.js';
import { invokeTool } from '../invoke.js';
import type { ToolContext } from '../context.js';

// L6b F2 — co_spec_lock: OPERATOR-ONLY. Locks a valid-criteria draft; non-operator rejected (named,
// F2); lock REFUSED for fuzzy criteria (the RG-4 join); refused if no draft / already locked;
// ctx.specs guard.

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
  const dir = mkdtempSync(join(tmpdir(), 'co-spec-lock-'));
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

function makeCtx(id: string, agent: string, overrides: Partial<ToolContext> = {}): ToolContext {
  const { mail, specs, registry } = openStores(id);
  return { agent, projectId: id, cwd: '/tmp', mail, registry, specs, ...overrides };
}

const VALID_CRITERIA: Criterion[] = [
  { text: 'expired tokens rejected (401)', verify: 'pnpm vitest run packages/core/x' },
  { text: 'format check passes', verify: 'pnpm format:check' },
];

function seedDraft(specs: SpecStore, taskId: string, criteria: readonly Criterion[]): void {
  specs.recordDraft({
    taskId,
    title: 'T',
    goal: 'G',
    criteria,
    body: 'body',
    actor: 'coord-1',
  });
}

const registry = buildCoreRegistry();

describe('co_spec_lock — the operator locks a valid-criteria draft', () => {
  it('locks the spec and returns the locked record (locked_by = operator)', async () => {
    const ctx = makeCtx('p-spec-lock-valid', OPERATOR);
    seedDraft(ctx.specs!, 'task-lock-1', VALID_CRITERIA);

    const result = (await invokeTool(registry, ctx, 'co_spec_lock', {
      task_id: 'task-lock-1',
    })) as Record<string, unknown>;

    expect(result['state']).toBe('locked');
    expect(result['locked_by']).toBe(OPERATOR);
    expect(result['locked_ts']).toBeGreaterThan(0);
    expect(ctx.specs!.getSpec('task-lock-1')?.state).toBe('locked');
  });
});

describe('co_spec_lock — operator gate (F2): only @operator may lock', () => {
  it('rejects a non-operator caller with a named violation, leaving the spec a draft', async () => {
    const ctx = makeCtx('p-spec-lock-nonop', 'coord-1');
    seedDraft(ctx.specs!, 'task-lock-2', VALID_CRITERIA);

    await expect(
      invokeTool(registry, ctx, 'co_spec_lock', { task_id: 'task-lock-2' }),
    ).rejects.toThrow(/only @operator may lock a spec \(caller 'coord-1'\)/i);
    expect(ctx.specs!.getSpec('task-lock-2')?.state).toBe('draft');
  });
});

describe('co_spec_lock — the RG-4 join: fuzzy criteria are REFUSED', () => {
  it('refuses to lock when a criterion has no wired command, leaving the spec a draft', async () => {
    const ctx = makeCtx('p-spec-lock-fuzzy', OPERATOR);
    seedDraft(ctx.specs!, 'task-lock-3', [
      { text: 'expired tokens rejected (401)', verify: 'pnpm vitest run packages/core/x' },
      { text: 'auth works' }, // no wired verification command
    ]);

    await expect(
      invokeTool(registry, ctx, 'co_spec_lock', { task_id: 'task-lock-3' }),
    ).rejects.toThrow(/refusing to lock 'task-lock-3'.*no wired verification command/is);
    expect(ctx.specs!.getSpec('task-lock-3')?.state).toBe('draft');
  });

  it('refuses to lock when a criterion text is vacuous even with a command', async () => {
    const ctx = makeCtx('p-spec-lock-vacuous', OPERATOR);
    seedDraft(ctx.specs!, 'task-lock-4', [{ text: 'works', verify: 'pnpm test' }]);

    await expect(
      invokeTool(registry, ctx, 'co_spec_lock', { task_id: 'task-lock-4' }),
    ).rejects.toThrow(/refusing to lock.*vacuous acceptance text/is);
    expect(ctx.specs!.getSpec('task-lock-4')?.state).toBe('draft');
  });
});

describe('co_spec_lock — lifecycle guards', () => {
  it('refuses when there is no draft for the task id', async () => {
    const ctx = makeCtx('p-spec-lock-nodraft', OPERATOR);

    await expect(
      invokeTool(registry, ctx, 'co_spec_lock', { task_id: 'ghost-task' }),
    ).rejects.toThrow(/no spec record for task 'ghost-task'/i);
  });

  it('refuses to re-lock an already-locked spec', async () => {
    const ctx = makeCtx('p-spec-lock-already', OPERATOR);
    seedDraft(ctx.specs!, 'task-lock-5', VALID_CRITERIA);
    ctx.specs!.recordLock('task-lock-5', OPERATOR);

    await expect(
      invokeTool(registry, ctx, 'co_spec_lock', { task_id: 'task-lock-5' }),
    ).rejects.toThrow(/is in state 'locked', not 'draft'/i);
  });
});

describe('co_spec_lock — absent store → loud-fail (Principle 9)', () => {
  it('missing ctx.specs → throws', async () => {
    const ctx = { ...makeCtx('p-spec-lock-nostore', OPERATOR), specs: undefined };
    await expect(
      invokeTool(registry, ctx as ToolContext, 'co_spec_lock', { task_id: 'x' }),
    ).rejects.toThrow(/ctx\.specs absent/i);
  });
});

describe('co_spec_lock — completeness gate', () => {
  it('co_spec_lock is registered and the gate stays green', () => {
    const reg = buildCoreRegistry();
    expect(checkToolCompleteness(reg)).toEqual([]);
    expect(reg.get('co_spec_lock')).not.toBeUndefined();
  });
});
