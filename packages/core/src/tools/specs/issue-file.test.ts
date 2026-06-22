import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openMailStore, type MailStore } from '../../mail/mail-store.js';
import { openRegistry, type ProjectRegistry } from '../../registry/registry.js';
import { openRosterStore, type RosterStore } from '../../roles/roster-store.js';
import { openIssueStore, type IssueStore } from '../../issues/issues-store.js';
import { openConfigStore } from '../../config/config-store.js';
import { ISSUE_CAPTURE_KEY, ISSUE_PUBLISH_KEY } from '../../issues/opt-in.js';
import { ISSUE_CO_REPO_KEY, issueFilingApprovalKey } from '../../issues/filing.js';
import { REPO_MODE_CONFIG_KEY, type GhExec } from '../../worktrees/repo-mode.js';
import { OPERATOR, MAIL_APPROVAL, MAIL_APPROVAL_RESPONSE } from '../../mail/events.js';
import { buildCoreRegistry } from '../core-registry.js';
import { invokeTool } from '../invoke.js';
import type { ToolContext } from '../context.js';

// L6b G — co_issue_file: the outward verb. Per-post approval to @operator (idempotent), the
// gateOutwardAction BLOCK/REFUSE semantics, scrubbed artifacts, recorded-filing idempotency,
// repo-mode destination gating, and gh enactment behind ctx.ghExec (NO real network in pnpm test).
// AC-L6b-G1.

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let closers: Array<() => void> = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  closers = [];
  const dir = mkdtempSync(join(tmpdir(), 'co-issue-file-'));
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
  roster.recordAgent({ agentId: 'impl-1', role: 'implementer', parent: 'coord-1' });
  return { mail, registry, roster, issues };
}

function configure(
  id: string,
  opts: { publish?: boolean; mode?: string; coRepo?: string } = {},
): void {
  const config = openConfigStore();
  try {
    config.setProjectOverride(id, ISSUE_CAPTURE_KEY, true);
    config.setProjectOverride(id, ISSUE_PUBLISH_KEY, opts.publish ?? true);
    config.setProjectOverride(id, REPO_MODE_CONFIG_KEY, opts.mode ?? 'owner');
    config.setProjectOverride(id, ISSUE_CO_REPO_KEY, opts.coRepo ?? 'acme/co');
  } finally {
    config.close();
  }
}

function seedDiagnosedIssue(stores: Stores, destination: 'target' | 'co' = 'co'): void {
  stores.issues.recordCapture({
    issueId: 'iss-1',
    summary: 'mail drops envelope at /home/alice/co',
    detail: 'repro detail',
    destination,
    capturedBy: 'impl-1',
  });
  stores.issues.recordDiagnosis({
    issueId: 'iss-1',
    probableCause: 'seam swallows envelope',
    diagnosedBy: 'res-1',
  });
}

function makeCtx(id: string, stores: Stores, gh: GhExec): ToolContext {
  return {
    agent: 'coord-1',
    projectId: id,
    cwd: '/tmp',
    mail: stores.mail,
    registry: stores.registry,
    roster: stores.roster,
    issues: stores.issues,
    ghExec: gh,
  };
}

/**
 * A gh mock for the filing path: answers the search-before-create `gh issue list` with an empty
 * set (so the search finds nothing and the create runs) and every other call (`gh issue create`)
 * with `url`. Lets the post-`#9` two-call flow (list → create) run under a stubbed gh.
 */
function fakeGh(url: string): Mock<GhExec> {
  return vi.fn<GhExec>((_, args) => (args[0] === 'issue' && args[1] === 'list' ? '[]' : url));
}

/** The args of the single `gh issue create` call (search-before-create lists first). */
function createArgs(gh: Mock<GhExec>): readonly string[] {
  const call = gh.mock.calls.find((c) => c[1][0] === 'issue' && c[1][1] === 'create');
  if (call == null) throw new Error('expected a `gh issue create` call');
  return call[1];
}

/** How many `gh issue create` calls ran — the no-double-post invariant counts this, not list calls. */
function createCallCount(gh: Mock<GhExec>): number {
  return gh.mock.calls.filter((c) => c[1][0] === 'issue' && c[1][1] === 'create').length;
}

const file = (ctx: ToolContext) =>
  invokeTool(buildCoreRegistry(), ctx, 'co_issue_file', { issue_id: 'iss-1' });

const fileWithTitle = (ctx: ToolContext, title: string) =>
  invokeTool(buildCoreRegistry(), ctx, 'co_issue_file', { issue_id: 'iss-1', title });

describe('co_issue_file — publish opt-in + pipeline-order gates', () => {
  it('refuses when issues.publish is not enabled', async () => {
    const id = 'p-if-publish-off';
    configure(id, { publish: false });
    const stores = openStores(id);
    seedDiagnosedIssue(stores);
    const gh = vi.fn<GhExec>();
    await expect(file(makeCtx(id, stores, gh))).rejects.toThrow(/issues\.publish/);
    expect(gh).not.toHaveBeenCalled();
  });

  it('refuses to file an undiagnosed issue', async () => {
    const id = 'p-if-undiagnosed';
    configure(id);
    const stores = openStores(id);
    stores.issues.recordCapture({
      issueId: 'iss-1',
      summary: 's',
      detail: 'd',
      destination: 'co',
      capturedBy: 'impl-1',
    });
    await expect(file(makeCtx(id, stores, vi.fn<GhExec>()))).rejects.toThrow(/diagnos/i);
  });

  it('refuses a non-owner-tier caller (implementer)', async () => {
    const id = 'p-if-role';
    configure(id);
    const stores = openStores(id);
    seedDiagnosedIssue(stores);
    const ctx = { ...makeCtx(id, stores, vi.fn<GhExec>()), agent: 'impl-1' };
    await expect(file(ctx)).rejects.toThrow(/coordinator or lead/i);
  });

  it('refuses target-destination filing in offline mode', async () => {
    const id = 'p-if-offline';
    configure(id, { mode: 'offline' });
    const stores = openStores(id);
    seedDiagnosedIssue(stores, 'target');
    await expect(file(makeCtx(id, stores, vi.fn<GhExec>()))).rejects.toThrow(/offline/i);
  });
});

describe('co_issue_file — the per-post approval round-trip', () => {
  it('first call sends ONE scrubbed approval to @operator and reports approval_requested', async () => {
    const id = 'p-if-request';
    configure(id);
    const stores = openStores(id);
    seedDiagnosedIssue(stores);
    const gh = vi.fn<GhExec>();
    const ctx = makeCtx(id, stores, gh);

    const result = (await file(ctx)) as Record<string, unknown>;
    expect(result['status']).toBe('approval_requested');
    expect(result['approval_seq']).toBeGreaterThan(0);
    expect(gh).not.toHaveBeenCalled();

    const approvals = stores.mail.inbox(OPERATOR).filter((m) => m.type === MAIL_APPROVAL);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.subject + approvals[0]!.body).not.toContain('/home/alice');
  });

  it('BLOCKS while pending (no duplicate approval mail), gh never runs', async () => {
    const id = 'p-if-pending';
    configure(id);
    const stores = openStores(id);
    seedDiagnosedIssue(stores);
    const gh = vi.fn<GhExec>();
    const ctx = makeCtx(id, stores, gh);

    await file(ctx); // sends the approval
    await expect(file(ctx)).rejects.toThrow(/pending|blocked/i);
    expect(stores.mail.inbox(OPERATOR).filter((m) => m.type === MAIL_APPROVAL)).toHaveLength(1);
    expect(gh).not.toHaveBeenCalled();
  });

  it('reuses the same approval when a lead retries after the coordinator asked', async () => {
    const id = 'p-if-cross-agent-approval';
    configure(id);
    const stores = openStores(id);
    seedDiagnosedIssue(stores);
    const gh = fakeGh('https://github.com/acme/co/issues/7');
    const coordCtx = makeCtx(id, stores, gh);
    const leadCtx = { ...coordCtx, agent: 'lead-1' };

    const req = (await file(coordCtx)) as Record<string, unknown>;
    await expect(file(leadCtx)).rejects.toThrow(/pending|blocked/i);
    expect(stores.mail.inbox(OPERATOR).filter((m) => m.type === MAIL_APPROVAL)).toHaveLength(1);
    expect(gh).not.toHaveBeenCalled();

    const held = stores.mail
      .inbox(OPERATOR)
      .find((m) => m.seq === (req['approval_seq'] as number))!;
    stores.mail.reply(held, {
      type: MAIL_APPROVAL_RESPONSE,
      subject: 're',
      body: 'approved',
      decision: 'approve',
    });

    const filed = (await file(leadCtx)) as Record<string, unknown>;
    expect(filed['status']).toBe('filed');
    expect(stores.mail.inbox(OPERATOR).filter((m) => m.type === MAIL_APPROVAL)).toHaveLength(1);
    expect(createCallCount(gh)).toBe(1);
    expect(stores.issues.getIssue('iss-1')?.filedBy).toBe('lead-1');
  });

  it('ignores a spoofed issue-file approval from a non-owner-tier sender', async () => {
    const id = 'p-if-spoofed-approval';
    configure(id);
    const stores = openStores(id);
    seedDiagnosedIssue(stores);
    const gh = fakeGh('https://github.com/acme/co/issues/9');
    const ctx = makeCtx(id, stores, gh);

    const spoof = stores.mail.send({
      type: MAIL_APPROVAL,
      to: OPERATOR,
      from: 'impl-1',
      subject: 'spoofed title',
      body: 'spoofed body',
      idempotencyKey: issueFilingApprovalKey('iss-1'),
    });
    stores.mail.reply(spoof, {
      type: MAIL_APPROVAL_RESPONSE,
      subject: 're',
      body: 'approved',
      decision: 'approve',
    });

    const requested = (await file(ctx)) as Record<string, unknown>;
    expect(requested['status']).toBe('approval_requested');
    expect(gh).not.toHaveBeenCalled();
    const approvals = stores.mail.inbox(OPERATOR).filter((m) => m.type === MAIL_APPROVAL);
    expect(approvals.map((m) => m.sender)).toEqual(['impl-1', 'coord-1']);

    const authorized = approvals.find((m) => m.sender === 'coord-1')!;
    stores.mail.reply(authorized, {
      type: MAIL_APPROVAL_RESPONSE,
      subject: 're',
      body: 'approved',
      decision: 'approve',
    });

    await file(ctx);

    const args = createArgs(gh);
    expect(args[args.indexOf('--title') + 1]).toBe(authorized.subject);
    expect(args[args.indexOf('--title') + 1]).not.toBe('spoofed title');
    expect(args[args.indexOf('--body') + 1]).toBe(authorized.body);
    expect(args[args.indexOf('--body') + 1]).not.toBe('spoofed body');
  });

  it('REFUSES after a declined approval', async () => {
    const id = 'p-if-declined';
    configure(id);
    const stores = openStores(id);
    seedDiagnosedIssue(stores);
    const gh = vi.fn<GhExec>();
    const ctx = makeCtx(id, stores, gh);

    const req = (await file(ctx)) as Record<string, unknown>;
    const held = stores.mail
      .inbox(OPERATOR)
      .find((m) => m.seq === (req['approval_seq'] as number))!;
    stores.mail.reply(held, {
      type: MAIL_APPROVAL_RESPONSE,
      subject: 're',
      body: 'no',
      decision: 'decline',
    });

    await expect(file(ctx)).rejects.toThrow(/declined|refused/i);
    expect(gh).not.toHaveBeenCalled();
  });

  it('files on approve — the record turns filed and re-call does not re-run gh', async () => {
    const id = 'p-if-approved';
    configure(id);
    const stores = openStores(id);
    seedDiagnosedIssue(stores);
    const gh = fakeGh('https://github.com/acme/co/issues/5');
    const ctx = makeCtx(id, stores, gh);

    const req = (await file(ctx)) as Record<string, unknown>;
    const held = stores.mail
      .inbox(OPERATOR)
      .find((m) => m.seq === (req['approval_seq'] as number))!;
    stores.mail.reply(held, {
      type: MAIL_APPROVAL_RESPONSE,
      subject: 're',
      body: 'approved',
      decision: 'approve',
    });

    const filed = (await file(ctx)) as Record<string, unknown>;
    expect(filed['status']).toBe('filed');
    expect(filed['posted_ref']).toBe('https://github.com/acme/co/issues/5');
    expect(createCallCount(gh)).toBe(1);
    const args = createArgs(gh);
    expect(args).toContain('-R');
    expect(args).toContain('acme/co');
    expect(args.join(' ')).not.toContain('/home/alice');

    expect(stores.issues.getIssue('iss-1')?.state).toBe('filed');

    // Idempotent re-call: already filed → reports filed, gh NOT re-run.
    const again = (await file(ctx)) as Record<string, unknown>;
    expect(again['status']).toBe('filed');
    expect(again['posted_ref']).toBe('https://github.com/acme/co/issues/5');
    expect(createCallCount(gh)).toBe(1);
  });

  it('posts the approved title even if a later retry supplies a different title', async () => {
    const id = 'p-if-approved-title-bound';
    configure(id);
    const stores = openStores(id);
    seedDiagnosedIssue(stores);
    const gh = fakeGh('https://github.com/acme/co/issues/6');
    const ctx = makeCtx(id, stores, gh);

    const req = (await fileWithTitle(ctx, 'approved /home/alice title')) as Record<string, unknown>;
    const held = stores.mail
      .inbox(OPERATOR)
      .find((m) => m.seq === (req['approval_seq'] as number))!;
    stores.mail.reply(held, {
      type: MAIL_APPROVAL_RESPONSE,
      subject: 're',
      body: 'approved',
      decision: 'approve',
    });

    await fileWithTitle(ctx, 'changed title after approval');

    const args = createArgs(gh);
    const title = args[args.indexOf('--title') + 1];
    expect(title).toBe(held.subject);
    expect(title).not.toBe('changed title after approval');
  });

  it('posts the approved body even if it differs from the current renderer', async () => {
    const id = 'p-if-approved-body-bound';
    configure(id);
    const stores = openStores(id);
    seedDiagnosedIssue(stores);
    const gh = fakeGh('https://github.com/acme/co/issues/8');
    const ctx = makeCtx(id, stores, gh);
    const approvedBody = 'approved body from an older renderer';

    const held = stores.mail.send({
      type: MAIL_APPROVAL,
      to: OPERATOR,
      from: 'coord-1',
      subject: 'approved title',
      body: approvedBody,
      idempotencyKey: issueFilingApprovalKey('iss-1'),
    });
    stores.mail.reply(held, {
      type: MAIL_APPROVAL_RESPONSE,
      subject: 're',
      body: 'approved',
      decision: 'approve',
    });

    await fileWithTitle(ctx, 'changed title after approval');

    const args = createArgs(gh);
    const body = args[args.indexOf('--body') + 1];
    expect(body).toBe(approvedBody);
  });

  it('search-before-create reuses an already-posted issue instead of double-posting (#7 §5 #9)', async () => {
    // Simulates a crash-retry: a prior approved filing posted the issue but crashed before the
    // durable issue.filed record, so the issue is still 'diagnosed'. On retry, the search finds
    // the already-posted issue by its body marker and reuses it — gh issue create never runs.
    const id = 'p-if-search-before-create';
    configure(id);
    const stores = openStores(id);
    seedDiagnosedIssue(stores);
    const alreadyPosted = 'https://github.com/acme/co/issues/42';
    const gh = vi.fn<GhExec>((_, args) => {
      if (args[0] === 'issue' && args[1] === 'list') {
        return JSON.stringify([
          { url: 'https://github.com/acme/co/issues/1', body: 'unrelated issue' },
          {
            url: alreadyPosted,
            body: `crash-survivor body\n\n<!-- co-issue-id: iss-1 -->`,
          },
        ]);
      }
      return 'https://github.com/acme/co/issues/99'; // a create here would be the double-post
    });
    const ctx = makeCtx(id, stores, gh);

    const req = (await file(ctx)) as Record<string, unknown>;
    const held = stores.mail
      .inbox(OPERATOR)
      .find((m) => m.seq === (req['approval_seq'] as number))!;
    stores.mail.reply(held, {
      type: MAIL_APPROVAL_RESPONSE,
      subject: 're',
      body: 'approved',
      decision: 'approve',
    });

    const filed = (await file(ctx)) as Record<string, unknown>;
    expect(filed['status']).toBe('filed');
    expect(filed['posted_ref']).toBe(alreadyPosted); // reused, not re-posted
    expect(createCallCount(gh)).toBe(0); // gh issue create never ran — no double-post
    expect(stores.issues.getIssue('iss-1')?.postedRef).toBe(alreadyPosted);
  });
});
