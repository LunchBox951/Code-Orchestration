import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openProjectStore } from '../store/sqlite-store.js';
import { applyEvent, rebuildAll, type Projector } from '../replay/projector.js';
import { decode } from '../replay/decode.js';
import type { StoredEvent } from '../store/types.js';
import { assertRepoPristine } from '../config/pristine.js';
import {
  OPERATOR,
  MAIL_CHAT,
  MAIL_APPROVAL,
  MAIL_APPROVAL_RESPONSE,
  MAIL_ESCALATION,
  mailKind,
  completionPredicate,
  makeMailEvent,
  mailUpcasters,
  mailSchemas,
  type ApprovalDecision,
} from './events.js';
import { MailProjector } from './mail-projector.js';
import { openMailStore } from './mail-store.js';
import { approvalOutcome, gateOutwardAction, outwardApprovalEnvelope } from './approval.js';

// ── Program-data dir per test (mirrors mail.test.ts) ──────────────────────────
const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let repoDirs: string[] = [];

function useDataDir(): void {
  const dir = mkdtempSync(join(tmpdir(), 'co-appr-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  repoDirs = [];
  useDataDir();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  for (const dir of repoDirs) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
  repoDirs = [];
});

/** A throwaway repo-like tree (a tracked file + a `.git/HEAD`), mirroring pristine.test.ts. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-appr-repo-'));
  repoDirs.push(dir);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}

/** Drop + re-fold the WHOLE log into a fresh read-model — the AC-L1-5 replay path. */
function rebuildOf(projectId: string): void {
  const store = openProjectStore(projectId);
  try {
    rebuildAll(store, [new MailProjector()], (e) => decode(e, mailUpcasters, mailSchemas));
  } finally {
    store.close();
  }
}

describe('AC-L1-4/5 — registries lit up for the approval pair (registered, not switched)', () => {
  it('approval is actionable with a predicate; approval_response is informational with none', () => {
    expect(mailKind(MAIL_APPROVAL)).toBe('actionable');
    expect(completionPredicate(MAIL_APPROVAL)).toBeTypeOf('function');
    expect(mailKind(MAIL_APPROVAL_RESPONSE)).toBe('informational');
    expect(completionPredicate(MAIL_APPROVAL_RESPONSE)).toBeUndefined();
  });
});

describe('AC-L1-5 — the live outward-action gate (block / proceed / refuse)', () => {
  it('blocks while pending, then PROCEEDS once an approve is recorded (spy called once)', () => {
    const mail = openMailStore('p-gate-approve');
    try {
      const fileIssue = vi.fn(() => 'issue-123'); // the synthetic outward action

      // A worker asks the operator to bless a genuinely-outward action.
      const approval = mail.send(
        outwardApprovalEnvelope({
          from: 'worker',
          subject: 'file an issue upstream?',
          body: 'open issue X on the public tracker',
        }),
      );
      expect(approval.recipient).toBe(OPERATOR);
      expect(approval.kind).toBe('actionable');

      // (1) pending → BLOCKED: the gate throws and the spy is never called.
      expect(approvalOutcome(mail, approval)).toBe('pending');
      expect(() => gateOutwardAction(approvalOutcome(mail, approval), fileIssue)).toThrow(
        /blocked|pending/i,
      );
      expect(fileIssue).not.toHaveBeenCalled();

      // The operator records an in-thread approve.
      const approvalRow = mail.inbox(OPERATOR).find((m) => m.seq === approval.seq)!;
      mail.reply(approvalRow, {
        type: MAIL_APPROVAL_RESPONSE,
        subject: 're: file an issue',
        body: 'go ahead',
        decision: 'approve',
      });

      // (2) approved → PROCEEDS: the gate runs the action exactly once.
      expect(approvalOutcome(mail, approval)).toBe('approved');
      const result = gateOutwardAction(approvalOutcome(mail, approval), fileIssue);
      expect(result).toBe('issue-123');
      expect(fileIssue).toHaveBeenCalledTimes(1);
    } finally {
      mail.close();
    }
  });

  it('REFUSES a declined approval (spy not called; gate throws)', () => {
    const mail = openMailStore('p-gate-decline');
    try {
      const fileIssue = vi.fn();
      const approval = mail.send(
        outwardApprovalEnvelope({
          from: 'worker',
          subject: 'delete prod data?',
          body: 'irreversible',
        }),
      );
      const approvalRow = mail.inbox(OPERATOR).find((m) => m.seq === approval.seq)!;
      mail.reply(approvalRow, {
        type: MAIL_APPROVAL_RESPONSE,
        subject: 're',
        body: 'absolutely not',
        decision: 'decline',
      });

      expect(approvalOutcome(mail, approval)).toBe('declined');
      expect(() => gateOutwardAction(approvalOutcome(mail, approval), fileIssue)).toThrow(
        /refused|declined/i,
      );
      expect(fileIssue).not.toHaveBeenCalled();
    } finally {
      mail.close();
    }
  });

  it('approvalOutcome rejects non-approval mail even when an approval_response references it', () => {
    const mail = openMailStore('p-gate-nonapproval');
    try {
      const chat = mail.send({
        type: MAIL_CHAT,
        to: OPERATOR,
        from: 'worker',
        subject: 'not an approval',
        body: 'just chat',
      });
      mail.send({
        type: MAIL_APPROVAL_RESPONSE,
        to: 'worker',
        from: OPERATOR,
        subject: 'spoof',
        body: 'go ahead',
        decision: 'approve',
        correlationId: String(chat.seq),
        causationId: String(chat.seq),
      });

      expect(() => approvalOutcome(mail, chat)).toThrow(/persisted approval/i);
    } finally {
      mail.close();
    }
  });
});

describe('AC-L1-5 — approval resolution + outstanding (either decision resolves it)', () => {
  it('an approval is actionable + outstanding until answered; an approve clears it', () => {
    const mail = openMailStore('p-appr-out-approve');
    try {
      const approval = mail.send(
        outwardApprovalEnvelope({ from: 'worker', subject: 's', body: 'b' }),
      );
      expect(approval.kind).toBe('actionable');
      expect(approval.resolved).toBe(false);
      expect(mail.outstandingCount(OPERATOR)).toBe(1);
      expect(mail.outstanding(OPERATOR).map((m) => m.seq)).toContain(approval.seq);

      const row = mail.inbox(OPERATOR).find((m) => m.seq === approval.seq)!;
      mail.reply(row, {
        type: MAIL_APPROVAL_RESPONSE,
        subject: 're',
        body: 'ok',
        decision: 'approve',
      });

      expect(mail.outstandingCount(OPERATOR)).toBe(0);
      expect(mail.inbox(OPERATOR).find((m) => m.seq === approval.seq)!.resolved).toBe(true);
    } finally {
      mail.close();
    }
  });

  it('ignores approval_response mail not sent by the approval holder back to the requester', () => {
    const mail = openMailStore('p-appr-spoof');
    try {
      const approval = mail.send(
        outwardApprovalEnvelope({ from: 'worker', subject: 'file issue?', body: 'public action' }),
      );
      expect(mail.outstandingCount(OPERATOR)).toBe(1);

      mail.send({
        type: MAIL_APPROVAL_RESPONSE,
        to: 'worker',
        from: 'intruder',
        subject: 'spoof',
        body: 'go ahead',
        decision: 'approve',
        correlationId: String(approval.seq),
        causationId: String(approval.seq),
      });
      expect(approvalOutcome(mail, approval)).toBe('pending');
      expect(mail.outstandingCount(OPERATOR)).toBe(1);
      expect(mail.inbox(OPERATOR).find((m) => m.seq === approval.seq)!.resolved).toBe(false);

      mail.send({
        type: MAIL_APPROVAL_RESPONSE,
        to: 'worker',
        from: OPERATOR,
        subject: 'off-thread',
        body: 'not in the approval thread',
        decision: 'approve',
        correlationId: 'wrong-thread',
        causationId: String(approval.seq),
      });
      expect(approvalOutcome(mail, approval)).toBe('pending');
      expect(mail.outstandingCount(OPERATOR)).toBe(1);

      mail.send({
        type: MAIL_APPROVAL_RESPONSE,
        to: 'auditor',
        from: OPERATOR,
        subject: 'misrouted',
        body: 'not back to requester',
        decision: 'approve',
        correlationId: String(approval.seq),
        causationId: String(approval.seq),
      });
      expect(approvalOutcome(mail, approval)).toBe('pending');
      expect(mail.outstandingCount(OPERATOR)).toBe(1);

      const row = mail.inbox(OPERATOR).find((m) => m.seq === approval.seq)!;
      mail.reply(row, {
        type: MAIL_APPROVAL_RESPONSE,
        subject: 're',
        body: 'ok',
        decision: 'approve',
      });
      expect(approvalOutcome(mail, approval)).toBe('approved');
      expect(mail.outstandingCount(OPERATOR)).toBe(0);
    } finally {
      mail.close();
    }
  });

  it('a DECLINE also resolves the actionable (the decision has been made)', () => {
    const mail = openMailStore('p-appr-out-decline');
    try {
      const approval = mail.send(
        outwardApprovalEnvelope({ from: 'worker', subject: 's', body: 'b' }),
      );
      expect(mail.outstandingCount(OPERATOR)).toBe(1);

      const row = mail.inbox(OPERATOR).find((m) => m.seq === approval.seq)!;
      mail.reply(row, {
        type: MAIL_APPROVAL_RESPONSE,
        subject: 're',
        body: 'no',
        decision: 'decline',
      });

      expect(mail.outstandingCount(OPERATOR)).toBe(0);
      expect(mail.inbox(OPERATOR).find((m) => m.seq === approval.seq)!.resolved).toBe(true);
    } finally {
      mail.close();
    }
  });
});

describe('AC-L1-5 — replay-safe (outcome + resolved-state survive a rebuild)', () => {
  it('approve stays approved/resolved and pending stays pending across rebuildAll', () => {
    const APPROVED = 'p-appr-replay-approve';
    const PENDING = 'p-appr-replay-pending';
    let approveSeq = -1;
    let pendingSeq = -1;

    {
      const mail = openMailStore(APPROVED);
      try {
        const a = mail.send(outwardApprovalEnvelope({ from: 'worker', subject: 's', body: 'b' }));
        approveSeq = a.seq;
        const row = mail.inbox(OPERATOR).find((m) => m.seq === a.seq)!;
        mail.reply(row, {
          type: MAIL_APPROVAL_RESPONSE,
          subject: 're',
          body: 'ok',
          decision: 'approve',
        });
        expect(approvalOutcome(mail, a)).toBe('approved');
      } finally {
        mail.close();
      }
    }
    {
      const mail = openMailStore(PENDING);
      try {
        const a = mail.send(outwardApprovalEnvelope({ from: 'worker', subject: 's', body: 'b' }));
        pendingSeq = a.seq;
        expect(approvalOutcome(mail, a)).toBe('pending');
      } finally {
        mail.close();
      }
    }

    rebuildOf(APPROVED);
    rebuildOf(PENDING);

    {
      const mail = openMailStore(APPROVED);
      try {
        const a = mail.inbox(OPERATOR).find((m) => m.seq === approveSeq)!;
        expect(a.resolved).toBe(true);
        expect(approvalOutcome(mail, a)).toBe('approved'); // outcome is log-derived
        // the response row's decision column survived the rebuild.
        const resp = mail.inbox('worker').find((m) => m.type === MAIL_APPROVAL_RESPONSE)!;
        expect(resp.decision).toBe('approve');
      } finally {
        mail.close();
      }
    }
    {
      const mail = openMailStore(PENDING);
      try {
        const a = mail.inbox(OPERATOR).find((m) => m.seq === pendingSeq)!;
        expect(a.resolved).toBe(false);
        expect(approvalOutcome(mail, a)).toBe('pending');
        expect(mail.outstandingCount(OPERATOR)).toBe(1);
      } finally {
        mail.close();
      }
    }
  });
});

describe('AC-L1-5 — operator-terminal addressing (operator Q3)', () => {
  it('a genuinely-outward / irreversible approval terminates at @operator', () => {
    const env = outwardApprovalEnvelope({
      from: 'coordinator',
      subject: 'push to origin?',
      body: 'irreversible outward push',
    });
    expect(env.to).toBe(OPERATOR);
    expect(env.type).toBe(MAIL_APPROVAL);

    // End-to-end: it actually lands in the operator's inbox.
    const mail = openMailStore('p-operator-terminal');
    try {
      const a = mail.send(env);
      expect(a.recipient).toBe(OPERATOR);
      expect(mail.inbox(OPERATOR).find((m) => m.seq === a.seq)!.recipient).toBe(OPERATOR);
    } finally {
      mail.close();
    }
  });

  it('rejects a raw approval addressed to a peer instead of @operator', () => {
    const mail = openMailStore('p-peer-approval');
    try {
      expect(() =>
        mail.send({
          type: MAIL_APPROVAL,
          to: 'lead',
          from: 'worker',
          subject: 'approve peer action?',
          body: 'outward approvals must filter to the operator',
        }),
      ).toThrow(/approval.*@operator/i);
    } finally {
      mail.close();
    }
  });

  it('does not allow an approval to be discharged through the forward seam', () => {
    const mail = openMailStore('p-approval-forward');
    try {
      const approval = mail.send(
        outwardApprovalEnvelope({ from: 'worker', subject: 'file issue?', body: 'public action' }),
      );
      const held = mail.inbox(OPERATOR).find((m) => m.seq === approval.seq)!;
      expect(() =>
        mail.forward(held, {
          type: MAIL_ESCALATION,
          to: 'coordinator',
          from: OPERATOR,
          subject: held.subject,
          body: held.body,
          correlationId: String(held.seq),
          causationId: String(held.seq),
        }),
      ).toThrow(/cannot forward.*approval/i);
      expect(mail.outstandingCount(OPERATOR)).toBe(1);
    } finally {
      mail.close();
    }
  });

  it('does not trust a forged DeliveredMail object to forward an approval seq', () => {
    const mail = openMailStore('p-approval-forged-forward');
    try {
      const approval = mail.send(
        outwardApprovalEnvelope({ from: 'worker', subject: 'file issue?', body: 'public action' }),
      );
      const held = mail.inbox(OPERATOR).find((m) => m.seq === approval.seq)!;
      const forged = { ...held, type: MAIL_ESCALATION } as typeof held;

      expect(() =>
        mail.forward(forged, {
          type: MAIL_ESCALATION,
          to: 'coordinator',
          from: OPERATOR,
          subject: held.subject,
          body: held.body,
          correlationId: String(held.seq),
          causationId: String(held.seq),
        }),
      ).toThrow(/cannot forward.*approval/i);
      expect(mail.outstandingCount(OPERATOR)).toBe(1);
    } finally {
      mail.close();
    }
  });
});

describe('AC-L1-5 — validation still strict (no W2/W3 regression)', () => {
  it('approval_response requires an in-enum decision; missing or invalid throws', () => {
    const mail = openMailStore('p-appr-validate');
    try {
      // missing decision → the per-type schema rejects it.
      expect(() =>
        mail.send({
          type: MAIL_APPROVAL_RESPONSE,
          to: 'worker',
          from: OPERATOR,
          subject: 's',
          body: 'b',
        }),
      ).toThrow();
      // a decision outside the enum → rejected.
      expect(() =>
        mail.send({
          type: MAIL_APPROVAL_RESPONSE,
          to: 'worker',
          from: OPERATOR,
          subject: 's',
          body: 'b',
          decision: 'maybe' as ApprovalDecision,
        }),
      ).toThrow();
      // a valid decision is accepted and persisted log-derived.
      const ok = mail.send({
        type: MAIL_APPROVAL_RESPONSE,
        to: 'worker',
        from: OPERATOR,
        subject: 's',
        body: 'b',
        decision: 'approve',
      });
      expect(ok.decision).toBe('approve');
    } finally {
      mail.close();
    }
  });

  it('existing {subject, body} types validate against their OWN schema; a stray decision is ignored', () => {
    const mail = openMailStore('p-appr-noregress');
    try {
      const c = mail.send({ type: MAIL_CHAT, to: 'bob', from: 'alice', subject: 's', body: 'b' });
      expect(c.decision).toBeUndefined();
      // A stray decision on a {subject, body} type is stripped, never persisted.
      const c2 = mail.send({
        type: MAIL_CHAT,
        to: 'bob',
        from: 'alice',
        subject: 's',
        body: 'b2',
        decision: 'approve',
      });
      expect(c2.decision).toBeUndefined();
    } finally {
      mail.close();
    }
  });
});

describe('AC-L1-9 — new approval events replay byte-equal; a gated flow is repo-pristine', () => {
  function apprSnapshot(db: DatabaseSync): string {
    return JSON.stringify(
      db
        .prepare(
          'SELECT seq, recipient, sender, type, subject, body, correlation_id, causation_id, idempotency_key, ts, kind, read, resolved, thread_id, decision FROM inbox ORDER BY seq',
        )
        .all(),
    );
  }

  it('an approval + approve response rebuild byte-identical (incl. resolved + decision)', () => {
    const PID = 'p-appr-bytes';
    const store = openProjectStore(PID);
    const projectors: Projector[] = [new MailProjector()];
    const decodeFn = (e: StoredEvent): StoredEvent => decode(e, mailUpcasters, mailSchemas);

    try {
      const approval = store.transaction((tx) => {
        const [s] = tx.append([
          makeMailEvent(PID, {
            type: MAIL_APPROVAL,
            to: OPERATOR,
            from: 'worker',
            subject: 'q',
            body: '?',
          }),
        ]);
        applyEvent(tx, decodeFn(s!), projectors);
        return s!;
      });
      store.transaction((tx) => {
        const [s] = tx.append([
          makeMailEvent(PID, {
            type: MAIL_APPROVAL_RESPONSE,
            to: 'worker',
            from: OPERATOR,
            subject: 'a',
            body: 'ok',
            decision: 'approve',
            correlationId: String(approval.seq),
            causationId: String(approval.seq),
          }),
        ]);
        applyEvent(tx, decodeFn(s!), projectors);
      });

      const live = store.transaction((tx) => apprSnapshot(tx.raw as DatabaseSync));
      rebuildAll(store, projectors, decodeFn);
      const replayed = store.transaction((tx) => apprSnapshot(tx.raw as DatabaseSync));

      expect(replayed).toBe(live);
      // Guard against a vacuous pass — the approval really was resolved and the decision persisted.
      expect(live).toContain('"decision":"approve"');
      expect(live).toContain('"resolved":1');
    } finally {
      store.close();
    }
  });

  it('a gated approve flow wrapped in assertRepoPristine does not throw (writes only to CO_DATA_DIR)', () => {
    const repo = makeRepo();
    const mail = openMailStore('p-appr-pristine');
    try {
      const ran = assertRepoPristine(repo, () => {
        const approval = mail.send(
          outwardApprovalEnvelope({ from: 'worker', subject: 's', body: 'b' }),
        );
        const row = mail.inbox(OPERATOR).find((m) => m.seq === approval.seq)!;
        mail.reply(row, {
          type: MAIL_APPROVAL_RESPONSE,
          subject: 're',
          body: 'ok',
          decision: 'approve',
        });
        return gateOutwardAction(approvalOutcome(mail, approval), () => 'did-outward-thing');
      });
      expect(ran).toBe('did-outward-thing');
    } finally {
      mail.close();
    }
  });
});
