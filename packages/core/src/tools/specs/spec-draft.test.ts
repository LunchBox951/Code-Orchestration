import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMailStore, type MailStore } from '../../mail/mail-store.js';
import { openRegistry, type ProjectRegistry } from '../../registry/registry.js';
import { openRosterStore, type RosterStore } from '../../roles/roster-store.js';
import { openSpecStore, type SpecStore } from '../../specs/specs-store.js';
import { buildCoreRegistry } from '../core-registry.js';
import { checkToolCompleteness } from '../completeness.js';
import { invokeTool } from '../invoke.js';
import type { ToolContext } from '../context.js';

// L6b F2 — co_spec_draft: a coordinator drafts a lockable spec record; non-coordinators are rejected
// (named); ctx.specs/ctx.roster guards. Draft runs the criterion validator so fuzzy drafts do not
// dead-end before lock.

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
  const dir = mkdtempSync(join(tmpdir(), 'co-spec-draft-'));
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

const DRAFT_INPUT = {
  task_id: 'task-draft-1',
  title: 'Token refresh',
  goal: 'Refresh tokens are rejected after expiry',
  criteria: [
    { text: 'expired tokens rejected (401)', verify: 'pnpm vitest run packages/core/x' },
    { text: 'format check passes', verify: 'pnpm format:check' },
  ],
  body: 'Full spec body.',
};

const registry = buildCoreRegistry();

describe('co_spec_draft — a coordinator drafts a spec', () => {
  it('records the spec and returns the drafted record', async () => {
    const ctx = makeCtx('p-spec-draft-coord', 'coord-1');
    ctx.roster!.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });

    const result = (await invokeTool(registry, ctx, 'co_spec_draft', DRAFT_INPUT)) as Record<
      string,
      unknown
    >;

    expect(result['task_id']).toBe('task-draft-1');
    expect(result['title']).toBe('Token refresh');
    expect(result['goal']).toBe('Refresh tokens are rejected after expiry');
    expect(result['body']).toBe('Full spec body.');
    expect(result['state']).toBe('draft');
    expect(result['drafted_ts']).toBeGreaterThan(0);

    const criteria = result['criteria'] as Array<{ text: string; verify?: string }>;
    expect(criteria).toHaveLength(2);
    expect(criteria[0]?.verify).toBe('pnpm vitest run packages/core/x');
    expect(criteria[1]?.verify).toBe('pnpm format:check');

    // The durable record is queryable and the actor is the drafting coordinator.
    const stored = ctx.specs!.getSpec('task-draft-1');
    expect(stored?.state).toBe('draft');
    expect(stored?.criteria).toHaveLength(2);
  });

  it('rejects fuzzy criteria at draft time so lock cannot dead-end', async () => {
    const ctx = makeCtx('p-spec-draft-fuzzy', 'coord-1');
    ctx.roster!.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });

    await expect(
      invokeTool(registry, ctx, 'co_spec_draft', {
        task_id: 'task-fuzzy',
        title: 'T',
        goal: 'G',
        criteria: [{ text: 'works' }], // vacuous AND no command
        body: '',
      }),
    ).rejects.toThrow(/co_spec_draft.*no wired verification command/is);

    expect(ctx.specs!.getSpec('task-fuzzy')).toBeUndefined();
  });

  it('rejects an empty criteria list', async () => {
    const ctx = makeCtx('p-spec-draft-empty', 'coord-1');
    ctx.roster!.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });

    await expect(
      invokeTool(registry, ctx, 'co_spec_draft', {
        task_id: 'task-empty',
        title: 'T',
        goal: 'G',
        criteria: [],
        body: '',
      }),
    ).rejects.toThrow(/at least one acceptance criterion/i);

    expect(ctx.specs!.getSpec('task-empty')).toBeUndefined();
  });
});

describe('co_spec_draft — caller must be a coordinator', () => {
  it('rejects a non-coordinator with a named violation', async () => {
    const ctx = makeCtx('p-spec-draft-noncoord', 'lead-1');
    ctx.roster!.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
    ctx.roster!.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-1' });

    await expect(invokeTool(registry, ctx, 'co_spec_draft', DRAFT_INPUT)).rejects.toThrow(
      /co_spec_draft.*requires coordinator/i,
    );
    expect(ctx.specs!.getSpec('task-draft-1')).toBeUndefined();
  });

  it('rejects an unregistered caller', async () => {
    const ctx = makeCtx('p-spec-draft-ghost', 'ghost-1');

    await expect(invokeTool(registry, ctx, 'co_spec_draft', DRAFT_INPUT)).rejects.toThrow(
      /co_spec_draft.*not registered/i,
    );
    expect(ctx.specs!.getSpec('task-draft-1')).toBeUndefined();
  });
});

describe('co_spec_draft — absent stores → loud-fail (Principle 9)', () => {
  it('missing ctx.specs → throws', async () => {
    const ctx = { ...makeCtx('p-spec-draft-nospecs', 'coord-1'), specs: undefined };
    await expect(
      invokeTool(registry, ctx as ToolContext, 'co_spec_draft', DRAFT_INPUT),
    ).rejects.toThrow(/ctx\.specs absent/i);
  });

  it('missing ctx.roster → throws', async () => {
    const ctx = { ...makeCtx('p-spec-draft-noroster', 'coord-1'), roster: undefined };
    await expect(
      invokeTool(registry, ctx as ToolContext, 'co_spec_draft', DRAFT_INPUT),
    ).rejects.toThrow(/ctx\.roster absent/i);
  });
});

describe('co_spec_draft — completeness gate', () => {
  it('co_spec_draft is registered and the gate stays green', () => {
    const reg = buildCoreRegistry();
    expect(checkToolCompleteness(reg)).toEqual([]);
    expect(reg.get('co_spec_draft')).not.toBeUndefined();
  });
});
