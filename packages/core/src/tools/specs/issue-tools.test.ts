import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMailStore, type MailStore } from '../../mail/mail-store.js';
import { openRegistry, type ProjectRegistry } from '../../registry/registry.js';
import { openRosterStore, type RosterStore } from '../../roles/roster-store.js';
import { openIssueStore, type IssueStore } from '../../issues/issues-store.js';
import { openConfigStore } from '../../config/config-store.js';
import { ISSUE_CAPTURE_KEY } from '../../issues/opt-in.js';
import { buildCoreRegistry } from '../core-registry.js';
import { checkToolCompleteness } from '../completeness.js';
import { invokeTool } from '../invoke.js';
import type { ToolContext } from '../context.js';

// L6b G — co_issue_capture / co_issue_list / co_issue_diagnose: the local pipeline verbs.
// Capture is gated on the `issues.capture` opt-in (OFF by default — a stranger repo never
// auto-captures), dedups before recording, and the refusal happens BEFORE any write
// (robust-on-read-only-state regression).

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let closers: Array<() => void> = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  closers = [];
  const dir = mkdtempSync(join(tmpdir(), 'co-issue-tools-'));
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
  issues: IssueStore;
}

function openStores(id: string): Stores {
  const mail = openMailStore(id);
  const registry = openRegistry();
  const roster = openRosterStore(id);
  const issues = openIssueStore(id);
  closers.push(
    () => mail.close(),
    () => registry.close(),
    () => roster.close(),
    () => issues.close(),
  );
  roster.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
  roster.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-1' });
  roster.recordAgent({ agentId: 'impl-1', role: 'implementer', parent: 'lead-1' });
  roster.recordAgent({ agentId: 'res-1', role: 'researcher', parent: 'lead-1' });
  return { mail, registry, roster, issues };
}

function makeCtx(id: string, stores: Stores, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    agent: 'impl-1',
    projectId: id,
    cwd: '/tmp',
    mail: stores.mail,
    registry: stores.registry,
    roster: stores.roster,
    issues: stores.issues,
    ...overrides,
  };
}

function enableCapture(id: string): void {
  const config = openConfigStore();
  try {
    config.setProjectOverride(id, ISSUE_CAPTURE_KEY, true);
  } finally {
    config.close();
  }
}

const CAPTURE_INPUT = {
  issue_id: 'iss-1',
  summary: 'finish silently no-ops',
  detail: 'co_finish reported ok but emitted nothing',
  destination: 'co',
};

describe('co_issue_capture — opt-in gate (OFF by default)', () => {
  it('refuses to capture when issues.capture is not enabled, and nothing is written', async () => {
    const id = 'p-it-capture-off';
    const stores = openStores(id);
    const ctx = makeCtx(id, stores);
    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_issue_capture', CAPTURE_INPUT),
    ).rejects.toThrow(/issues\.capture/);
    expect(stores.issues.listIssues()).toHaveLength(0);
  });

  it('captures when enabled, recording the caller as capturedBy', async () => {
    const id = 'p-it-capture-on';
    enableCapture(id);
    const stores = openStores(id);
    const ctx = makeCtx(id, stores);
    const result = (await invokeTool(buildCoreRegistry(), ctx, 'co_issue_capture', {
      ...CAPTURE_INPUT,
    })) as Record<string, unknown>;
    expect(result['deduped']).toBe(false);
    const issue = result['issue'] as Record<string, unknown>;
    expect(issue['issue_id']).toBe('iss-1');
    expect(issue['captured_by']).toBe('impl-1');
    expect(issue['state']).toBe('captured');
  });

  it('dedups: a same-summary same-destination capture returns the existing record', async () => {
    const id = 'p-it-capture-dedup';
    enableCapture(id);
    const stores = openStores(id);
    const ctx = makeCtx(id, stores);
    await invokeTool(buildCoreRegistry(), ctx, 'co_issue_capture', CAPTURE_INPUT);
    const result = (await invokeTool(buildCoreRegistry(), ctx, 'co_issue_capture', {
      ...CAPTURE_INPUT,
      issue_id: 'iss-2',
      summary: '  FINISH silently   no-ops ',
      detail: 'a different repro of the same friction',
    })) as Record<string, unknown>;
    expect(result['deduped']).toBe(true);
    expect((result['issue'] as Record<string, unknown>)['issue_id']).toBe('iss-1');
    expect(stores.issues.listIssues()).toHaveLength(1);
  });

  it('throws when ctx.issues is not injected', async () => {
    const id = 'p-it-capture-no-store';
    enableCapture(id);
    const stores = openStores(id);
    const ctx = makeCtx(id, stores, { issues: undefined });
    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_issue_capture', CAPTURE_INPUT),
    ).rejects.toThrow(/ctx\.issues absent/i);
  });
});

describe('co_issue_list — read-only visibility for the dedup step', () => {
  it('lists records with optional destination/state filters', async () => {
    const id = 'p-it-list';
    enableCapture(id);
    const stores = openStores(id);
    const ctx = makeCtx(id, stores);
    stores.issues.recordCapture({
      issueId: 'iss-a',
      summary: 'a',
      detail: '',
      destination: 'co',
      capturedBy: 'impl-1',
    });
    stores.issues.recordCapture({
      issueId: 'iss-b',
      summary: 'b',
      detail: '',
      destination: 'target',
      capturedBy: 'impl-1',
    });
    stores.issues.recordDiagnosis({ issueId: 'iss-b', probableCause: 'pc', diagnosedBy: 'res-1' });

    const all = (await invokeTool(buildCoreRegistry(), ctx, 'co_issue_list', {})) as Record<
      string,
      unknown
    >;
    expect((all['issues'] as unknown[]).length).toBe(2);

    const co = (await invokeTool(buildCoreRegistry(), ctx, 'co_issue_list', {
      destination: 'co',
    })) as Record<string, unknown>;
    expect((co['issues'] as Array<Record<string, unknown>>).map((i) => i['issue_id'])).toEqual([
      'iss-a',
    ]);

    const diagnosed = (await invokeTool(buildCoreRegistry(), ctx, 'co_issue_list', {
      state: 'diagnosed',
    })) as Record<string, unknown>;
    expect(
      (diagnosed['issues'] as Array<Record<string, unknown>>).map((i) => i['issue_id']),
    ).toEqual(['iss-b']);
  });
});

describe('co_issue_diagnose — the researcher:diagnostic verb', () => {
  it('records a probable cause from a researcher caller', async () => {
    const id = 'p-it-diag';
    enableCapture(id);
    const stores = openStores(id);
    stores.issues.recordCapture({
      issueId: 'iss-1',
      summary: 's',
      detail: 'd',
      destination: 'co',
      capturedBy: 'impl-1',
    });
    const ctx = makeCtx(id, stores, { agent: 'res-1' });
    const result = (await invokeTool(buildCoreRegistry(), ctx, 'co_issue_diagnose', {
      issue_id: 'iss-1',
      probable_cause: 'the delivery seam swallows the second envelope',
    })) as Record<string, unknown>;
    const issue = result['issue'] as Record<string, unknown>;
    expect(issue['state']).toBe('diagnosed');
    expect(issue['diagnosed_by']).toBe('res-1');
    expect(issue['probable_cause']).toMatch(/delivery seam/);
  });

  it('refuses a non-researcher caller', async () => {
    const id = 'p-it-diag-role';
    enableCapture(id);
    const stores = openStores(id);
    stores.issues.recordCapture({
      issueId: 'iss-1',
      summary: 's',
      detail: 'd',
      destination: 'co',
      capturedBy: 'impl-1',
    });
    const ctx = makeCtx(id, stores, { agent: 'impl-1' });
    await expect(
      invokeTool(buildCoreRegistry(), ctx, 'co_issue_diagnose', {
        issue_id: 'iss-1',
        probable_cause: 'x',
      }),
    ).rejects.toThrow(/researcher/i);
  });
});

describe('issue tools — completeness gate', () => {
  it('the issue verbs are registered and the registry stays complete', () => {
    const registry = buildCoreRegistry();
    expect(checkToolCompleteness(registry)).toEqual([]);
    for (const name of [
      'co_issue_capture',
      'co_issue_list',
      'co_issue_diagnose',
      'co_issue_file',
    ]) {
      expect(registry.has(name)).toBe(true);
    }
  });
});
