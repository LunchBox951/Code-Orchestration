import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPERATOR, MAIL_APPROVAL, MAIL_APPROVAL_RESPONSE } from '../mail/events.js';
import { openMailStore } from '../mail/mail-store.js';
import { approvalOutcome } from '../mail/approval.js';
import type { GhExec } from '../worktrees/repo-mode.js';
import type { IssueRecord } from './events.js';
import {
  assertIssueDestinationAllowed,
  buildIssueFilingApproval,
  fileIssueOutward,
  findIssueFilingApproval,
  ghIssueCreateArgs,
  issueFilingApprovalKey,
  renderIssueBody,
} from './filing.js';

// L6b G — the outward filing gate: per-post approval (the FIRST real consumer of
// mail/approval.ts's gateOutwardAction), scrubbed artifacts, destination gating by repo mode,
// and gh enactment behind the injectable GhExec seam (no real network in pnpm test).

const ORIGINAL_ENV = process.env;
let dataDir = '';

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDir = mkdtempSync(join(tmpdir(), 'co-issue-filing-'));
  process.env.CO_DATA_DIR = dataDir;
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  rmSync(dataDir, { recursive: true, force: true });
});

const ISSUE: IssueRecord = {
  issueId: 'iss-9',
  summary: 'mail bus drops attachment at /home/alice/co',
  detail: 'Repro: send mail from /home/alice/co; contact someone@example.com for the trace.',
  destination: 'co',
  capturedBy: 'lead-7',
  state: 'diagnosed',
  probableCause: 'delivery seam swallows the second envelope',
  diagnosedBy: 'res-diag-1',
  capturedTs: 1,
  diagnosedTs: 2,
};

describe('issueFilingApprovalKey + buildIssueFilingApproval', () => {
  it('addresses the per-post approval to @operator with a per-issue idempotency key', () => {
    const envelope = buildIssueFilingApproval({ from: 'coord-1', issue: ISSUE });
    expect(envelope.type).toBe(MAIL_APPROVAL);
    expect(envelope.to).toBe(OPERATOR);
    expect(envelope.from).toBe('coord-1');
    expect(envelope.idempotencyKey).toBe(issueFilingApprovalKey('iss-9'));
  });

  it('the approval preview is SCRUBBED — what the operator approves is what goes out', () => {
    const envelope = buildIssueFilingApproval({ from: 'coord-1', issue: ISSUE });
    const artifact = envelope.subject + '\n' + envelope.body;
    expect(artifact).not.toContain('/home/alice');
    expect(artifact).not.toContain('someone@example.com');
    expect(artifact).toContain('/home/[redacted]');
    expect(envelope.body).toContain('delivery seam swallows');
  });
});

describe('findIssueFilingApproval — idempotent approval lookup', () => {
  it('finds the previously-sent approval by idempotency key, undefined when none', () => {
    const mail = openMailStore('p-filing-find');
    try {
      expect(findIssueFilingApproval(mail, 'coord-1', 'iss-9')).toBeUndefined();
      const sent = mail.send(buildIssueFilingApproval({ from: 'coord-1', issue: ISSUE }));
      const found = findIssueFilingApproval(mail, 'coord-1', 'iss-9');
      expect(found?.seq).toBe(sent.seq);
      expect(findIssueFilingApproval(mail, 'lead-1', 'iss-9')?.seq).toBe(sent.seq);
      expect(findIssueFilingApproval(mail, 'coord-1', 'iss-other')).toBeUndefined();
    } finally {
      mail.close();
    }
  });
});

describe('assertIssueDestinationAllowed — repo-mode gating', () => {
  it('refuses target-repo filing in offline mode (no remote to file against)', () => {
    expect(() => assertIssueDestinationAllowed('target', 'offline')).toThrow(/offline/i);
  });

  it('allows target filing in owner/contributor modes and co filing everywhere', () => {
    expect(() => assertIssueDestinationAllowed('target', 'owner')).not.toThrow();
    expect(() => assertIssueDestinationAllowed('target', 'contributor')).not.toThrow();
    expect(() => assertIssueDestinationAllowed('co', 'offline')).not.toThrow();
    expect(() => assertIssueDestinationAllowed('co', 'owner')).not.toThrow();
  });
});

describe('ghIssueCreateArgs — destination routing', () => {
  it('routes co-destination issues to the configured co repo slug', () => {
    const args = ghIssueCreateArgs({
      destination: 'co',
      coRepoSlug: 'acme/co',
      title: 'T',
      body: 'B',
    });
    expect(args).toEqual(['issue', 'create', '-R', 'acme/co', '--title', 'T', '--body', 'B']);
  });

  it('routes target-destination issues to the cwd origin (no -R flag)', () => {
    const args = ghIssueCreateArgs({ destination: 'target', title: 'T', body: 'B' });
    expect(args).toEqual(['issue', 'create', '--title', 'T', '--body', 'B']);
  });

  it('fails loud when a co-destination filing has no configured co repo slug', () => {
    expect(() => ghIssueCreateArgs({ destination: 'co', title: 'T', body: 'B' })).toThrow(
      /issues\.coRepo/,
    );
  });
});

describe('renderIssueBody — the outward artifact', () => {
  it('renders detail + probable cause, scrubbed', () => {
    const body = renderIssueBody(ISSUE);
    expect(body).toContain('delivery seam swallows the second envelope');
    expect(body).toContain('Repro: send mail');
    expect(body).not.toContain('/home/alice');
    expect(body).not.toContain('someone@example.com');
  });
});

describe('fileIssueOutward — gateOutwardAction is the gate', () => {
  const fileViaGh = (gh: GhExec, outcome: 'pending' | 'approved' | 'declined') =>
    fileIssueOutward({
      outcome,
      ghExec: gh,
      cwd: '/tmp/repo',
      destination: 'co',
      coRepoSlug: 'acme/co',
      issueId: 'iss-12',
      title: 'T',
      body: 'B',
    });

  it('BLOCKS while the approval is pending — gh never runs', () => {
    const gh = vi.fn<GhExec>();
    expect(() => fileViaGh(gh, 'pending')).toThrow(/blocked|pending/i);
    expect(gh).not.toHaveBeenCalled();
  });

  it('REFUSES on a declined approval — gh never runs', () => {
    const gh = vi.fn<GhExec>();
    expect(() => fileViaGh(gh, 'declined')).toThrow(/refused|declined/i);
    expect(gh).not.toHaveBeenCalled();
  });

  it('runs gh on approval and returns the posted ref (after a search-before-create list)', () => {
    // The search-before-create `issue list` returns an empty set, so the create runs (#7 §5 #9).
    const gh = vi.fn<GhExec>((_, args) =>
      args[1] === 'list' ? '[]' : 'https://github.com/acme/co/issues/12',
    );
    const ref = fileViaGh(gh, 'approved');
    expect(ref).toBe('https://github.com/acme/co/issues/12');
    const createCalls = gh.mock.calls.filter((c) => c[1][0] === 'issue' && c[1][1] === 'create');
    expect(createCalls).toHaveLength(1); // exactly one create — no double-post
    expect(gh).toHaveBeenCalledWith('/tmp/repo', [
      'issue',
      'create',
      '-R',
      'acme/co',
      '--title',
      'T',
      '--body',
      'B',
    ]);
  });
});

describe('end-to-end approval thread → outcome → gated filing', () => {
  it('approval sent → operator approves in-thread → outcome approved → filing proceeds', () => {
    const mail = openMailStore('p-filing-e2e');
    const gh = vi.fn<GhExec>().mockReturnValue('https://github.com/acme/co/issues/3');
    try {
      const approval = mail.send(buildIssueFilingApproval({ from: 'coord-1', issue: ISSUE }));
      expect(approvalOutcome(mail, approval)).toBe('pending');

      const held = mail.inbox(OPERATOR).find((m) => m.seq === approval.seq)!;
      mail.reply(held, {
        type: MAIL_APPROVAL_RESPONSE,
        subject: 're: file issue',
        body: 'go ahead',
        decision: 'approve',
      });

      const outcome = approvalOutcome(mail, approval);
      expect(outcome).toBe('approved');
      const ref = fileIssueOutward({
        outcome,
        ghExec: gh,
        cwd: '/tmp/repo',
        destination: 'co',
        coRepoSlug: 'acme/co',
        issueId: ISSUE.issueId,
        title: 'T',
        body: renderIssueBody(ISSUE),
      });
      expect(ref).toBe('https://github.com/acme/co/issues/3');
    } finally {
      mail.close();
    }
  });
});
