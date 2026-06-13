import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPERATOR } from '../../mail/events.js';
import { openMailStore, type MailStore } from '../../mail/mail-store.js';
import { openRegistry, type ProjectRegistry } from '../../registry/registry.js';
import { openRosterStore, type RosterStore } from '../../roles/roster-store.js';
import { openSpecStore, type SpecStore } from '../../specs/specs-store.js';
import type { Criterion } from '../../specs/criteria-schema.js';
import { buildCoreRegistry } from '../core-registry.js';
import { checkToolCompleteness } from '../completeness.js';
import { invokeTool } from '../invoke.js';
import type { ToolContext } from '../context.js';

// L9 tail — co_spec_archive: a coordinator archives a locked spec; non-coordinators rejected;
// draft/archived/absent spec refused loud; ctx.specs/ctx.roster guards; completeness gate + AC-S9-8
// guard both stay green with the new tool added.

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let mailStores: MailStore[] = [];
let specStores: SpecStore[] = [];
let rosterStores: RosterStore[] = [];
let registries: ProjectRegistry[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  mailStores = [];
  specStores = [];
  rosterStores = [];
  registries = [];
  const dir = mkdtempSync(join(tmpdir(), 'co-spec-archive-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const m of mailStores) m.close();
  for (const s of specStores) s.close();
  for (const r of rosterStores) r.close();
  for (const r of registries) r.close();
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
  mailStores = [];
  specStores = [];
  rosterStores = [];
  registries = [];
});

function openStores(id: string): {
  mail: MailStore;
  specs: SpecStore;
  roster: RosterStore;
  registry: ProjectRegistry;
} {
  const mail = openMailStore(id);
  mailStores.push(mail);
  const specs = openSpecStore(id);
  specStores.push(specs);
  const roster = openRosterStore(id);
  rosterStores.push(roster);
  const registry = openRegistry();
  registries.push(registry);
  return { mail, specs, roster, registry };
}

function makeCtx(id: string, agent: string, overrides: Partial<ToolContext> = {}): ToolContext {
  const { mail, specs, roster, registry } = openStores(id);
  return {
    agent,
    projectId: id,
    cwd: '/tmp',
    mail,
    registry,
    specs,
    roster,
    ...overrides,
  };
}

const VALID_CRITERIA: Criterion[] = [
  { text: 'expired tokens rejected (401)', verify: 'pnpm vitest run packages/core/x' },
  { text: 'format check passes', verify: 'pnpm format:check' },
];

function seedLockedSpec(specs: SpecStore, taskId: string): void {
  specs.recordDraft({
    taskId,
    title: 'T',
    goal: 'G',
    criteria: VALID_CRITERIA,
    body: 'body',
    actor: 'coord-1',
  });
  specs.recordLock(taskId, OPERATOR);
}

const registry = buildCoreRegistry();

describe('co_spec_archive — coordinator archives a locked spec', () => {
  it('archives the spec and returns the archived record', async () => {
    const ctx = makeCtx('p-spec-archive-ok', 'coord-1');
    ctx.roster!.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
    seedLockedSpec(ctx.specs!, 'task-arc-1');

    const result = (await invokeTool(registry, ctx, 'co_spec_archive', {
      task_id: 'task-arc-1',
    })) as Record<string, unknown>;

    expect(result['state']).toBe('archived');
    expect(result['task_id']).toBe('task-arc-1');
    expect(result['archived_ts']).toBeGreaterThan(0);
    expect(ctx.specs!.getSpec('task-arc-1')?.state).toBe('archived');
  });

  it('archived spec is still queryable via getSpec', async () => {
    const ctx = makeCtx('p-spec-archive-query', 'coord-1');
    ctx.roster!.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
    seedLockedSpec(ctx.specs!, 'task-arc-query');

    await invokeTool(registry, ctx, 'co_spec_archive', { task_id: 'task-arc-query' });

    const rec = ctx.specs!.getSpec('task-arc-query');
    expect(rec).toBeDefined();
    expect(rec!.state).toBe('archived');
    expect(rec!.archivedTs).toBeGreaterThan(0);
  });
});

describe('co_spec_archive — role gate: only coordinator may archive', () => {
  it('rejects a lead with a named violation', async () => {
    const ctx = makeCtx('p-spec-archive-lead', 'lead-1');
    ctx.roster!.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
    ctx.roster!.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-1' });
    seedLockedSpec(ctx.specs!, 'task-arc-lead');

    await expect(
      invokeTool(registry, ctx, 'co_spec_archive', { task_id: 'task-arc-lead' }),
    ).rejects.toThrow(/co_spec_archive.*requires coordinator/i);
    expect(ctx.specs!.getSpec('task-arc-lead')?.state).toBe('locked');
  });

  it('rejects an implementer with a named violation', async () => {
    const ctx = makeCtx('p-spec-archive-impl', 'impl-1');
    ctx.roster!.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
    ctx.roster!.recordAgent({ agentId: 'impl-1', role: 'implementer', parent: 'coord-1' });
    seedLockedSpec(ctx.specs!, 'task-arc-impl');

    await expect(
      invokeTool(registry, ctx, 'co_spec_archive', { task_id: 'task-arc-impl' }),
    ).rejects.toThrow(/co_spec_archive.*requires coordinator/i);
  });

  it('rejects an unregistered caller', async () => {
    const ctx = makeCtx('p-spec-archive-ghost', 'ghost-1');

    await expect(
      invokeTool(registry, ctx, 'co_spec_archive', { task_id: 'task-arc-ghost' }),
    ).rejects.toThrow(/co_spec_archive.*not registered/i);
  });
});

describe('co_spec_archive — lifecycle guards', () => {
  it('refuses to archive a draft (not-locked) spec', async () => {
    const ctx = makeCtx('p-spec-archive-draft', 'coord-1');
    ctx.roster!.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
    ctx.specs!.recordDraft({
      taskId: 'task-arc-draft',
      title: 'T',
      goal: 'G',
      criteria: VALID_CRITERIA,
      body: '',
      actor: 'coord-1',
    });

    await expect(
      invokeTool(registry, ctx, 'co_spec_archive', { task_id: 'task-arc-draft' }),
    ).rejects.toThrow(/is in state 'draft', not 'locked'/i);
    expect(ctx.specs!.getSpec('task-arc-draft')?.state).toBe('draft');
  });

  it('refuses to archive an already-archived spec', async () => {
    const ctx = makeCtx('p-spec-archive-already', 'coord-1');
    ctx.roster!.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
    seedLockedSpec(ctx.specs!, 'task-arc-already');
    ctx.specs!.recordArchive('task-arc-already');

    await expect(
      invokeTool(registry, ctx, 'co_spec_archive', { task_id: 'task-arc-already' }),
    ).rejects.toThrow(/is in state 'archived', not 'locked'/i);
  });

  it('refuses when there is no spec for the task id', async () => {
    const ctx = makeCtx('p-spec-archive-absent', 'coord-1');
    ctx.roster!.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });

    await expect(
      invokeTool(registry, ctx, 'co_spec_archive', { task_id: 'ghost-task' }),
    ).rejects.toThrow(/no spec record for task 'ghost-task'/i);
  });
});

describe('co_spec_archive — absent stores → loud-fail (Principle 9)', () => {
  it('missing ctx.specs → throws', async () => {
    const ctx = { ...makeCtx('p-spec-archive-nospecs', 'coord-1'), specs: undefined };
    await expect(
      invokeTool(registry, ctx as ToolContext, 'co_spec_archive', { task_id: 'x' }),
    ).rejects.toThrow(/ctx\.specs absent/i);
  });

  it('missing ctx.roster → throws', async () => {
    const ctx = { ...makeCtx('p-spec-archive-noroster', 'coord-1'), roster: undefined };
    await expect(
      invokeTool(registry, ctx as ToolContext, 'co_spec_archive', { task_id: 'x' }),
    ).rejects.toThrow(/ctx\.roster absent/i);
  });
});

describe('co_spec_archive — completeness gate', () => {
  it('co_spec_archive is registered and the gate stays green', () => {
    const reg = buildCoreRegistry();
    expect(checkToolCompleteness(reg)).toEqual([]);
    expect(reg.get('co_spec_archive')).not.toBeUndefined();
  });
});
