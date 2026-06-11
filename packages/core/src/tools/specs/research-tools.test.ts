import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMailStore, type MailStore } from '../../mail/mail-store.js';
import { openRegistry, type ProjectRegistry } from '../../registry/registry.js';
import { openRosterStore, type RosterStore } from '../../roles/roster-store.js';
import { openResearchStore, type ResearchStore } from '../../research/research-store.js';
import { buildCoreRegistry } from '../core-registry.js';
import { checkToolCompleteness } from '../completeness.js';
import { invokeTool } from '../invoke.js';
import type { ToolContext } from '../context.js';

// L6b H — co_research_finalize / co_research_get: the static locator surface. Finalize is
// researcher-only and validates the map contract (pointers, not a dump); get is offered broadly
// so a requester reads the durable map instead of re-searching (AC-L6b-H1).

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let closers: Array<() => void> = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  closers = [];
  const dir = mkdtempSync(join(tmpdir(), 'co-research-tools-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const close of closers) close();
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
  closers = [];
});

interface Stores {
  mail: MailStore;
  registry: ProjectRegistry;
  roster: RosterStore;
  research: ResearchStore;
}

function openStores(id: string): Stores {
  const mail = openMailStore(id);
  const registry = openRegistry();
  const roster = openRosterStore(id);
  const research = openResearchStore(id);
  closers.push(
    () => mail.close(),
    () => registry.close(),
    () => roster.close(),
    () => research.close(),
  );
  roster.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
  roster.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-1' });
  roster.recordAgent({ agentId: 'res-1', role: 'researcher', parent: 'lead-1' });
  return { mail, registry, roster, research };
}

function makeCtx(id: string, stores: Stores, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agent: 'res-1',
    projectId: id,
    cwd: '/tmp',
    mail: stores.mail,
    registry: stores.registry,
    roster: stores.roster,
    research: stores.research,
    ...overrides,
  };
}

const MAP_INPUT = {
  research_id: 'res-q-1',
  question: 'where does mail delivery happen?',
  requested_by: 'lead-1',
  kind: 'map',
  map: {
    question: 'where does mail delivery happen?',
    entries: [
      {
        path: 'packages/core/src/mail/delivery.ts',
        why: 'the injectable delivery seam',
        symbols: ['Delivery'],
      },
    ],
    readOrder: ['packages/core/src/mail/delivery.ts'],
  },
};

describe('co_research_finalize — researcher-only, contract-validated', () => {
  it('records a locator map finalize with the caller as researcher', async () => {
    const id = 'p-rt-finalize';
    const stores = openStores(id);
    const result = (await invokeTool(
      buildCoreRegistry(),
      makeCtx(id, stores),
      'co_research_finalize',
      MAP_INPUT,
    )) as Record<string, unknown>;
    expect(result['research_id']).toBe('res-q-1');
    expect(result['researcher']).toBe('res-1');
    expect(result['kind']).toBe('map');
    expect(result['finalized_ts']).toBeGreaterThan(0);
  });

  it('rejects an incoherent map (read order pointing at a ghost file) with named violations', async () => {
    const id = 'p-rt-bad-map';
    const stores = openStores(id);
    const bad = {
      ...MAP_INPUT,
      research_id: 'res-q-bad',
      map: { ...MAP_INPUT.map, readOrder: ['ghost.ts'] },
    };
    await expect(
      invokeTool(buildCoreRegistry(), makeCtx(id, stores), 'co_research_finalize', bad),
    ).rejects.toThrow(/ghost\.ts/);
  });

  it('records a cited answer finalize', async () => {
    const id = 'p-rt-answer';
    const stores = openStores(id);
    const result = (await invokeTool(
      buildCoreRegistry(),
      makeCtx(id, stores),
      'co_research_finalize',
      {
        research_id: 'res-q-2',
        question: 'is delivery pluggable?',
        requested_by: 'lead-1',
        kind: 'answer',
        answer: {
          text: 'yes — the seam is injectable',
          citations: [{ source: 'packages/core/src/mail/delivery.ts' }],
        },
      },
    )) as Record<string, unknown>;
    expect(result['kind']).toBe('answer');
  });

  it('refuses a non-researcher caller', async () => {
    const id = 'p-rt-role';
    const stores = openStores(id);
    await expect(
      invokeTool(
        buildCoreRegistry(),
        makeCtx(id, stores, { agent: 'lead-1' }),
        'co_research_finalize',
        MAP_INPUT,
      ),
    ).rejects.toThrow(/researcher/i);
  });
});

describe('co_research_get — durable read-back for any agent', () => {
  it('returns the finalized record, and a structured not-found for absent ids', async () => {
    const id = 'p-rt-get';
    const stores = openStores(id);
    await invokeTool(buildCoreRegistry(), makeCtx(id, stores), 'co_research_finalize', MAP_INPUT);

    const found = (await invokeTool(
      buildCoreRegistry(),
      makeCtx(id, stores, { agent: 'lead-1' }),
      'co_research_get',
      { research_id: 'res-q-1' },
    )) as Record<string, unknown>;
    expect(found['found']).toBe(true);
    expect((found['map'] as Record<string, unknown>)['entries']).toHaveLength(1);

    const absent = await invokeTool(buildCoreRegistry(), makeCtx(id, stores), 'co_research_get', {
      research_id: 'ghost',
    });
    expect(absent).toEqual({ found: false, research_id: 'ghost' });
  });
});

describe('research tools — completeness gate', () => {
  it('the research verbs are registered and the registry stays complete', () => {
    const registry = buildCoreRegistry();
    expect(checkToolCompleteness(registry)).toEqual([]);
    expect(registry.has('co_research_finalize')).toBe(true);
    expect(registry.has('co_research_get')).toBe(true);
  });
});
