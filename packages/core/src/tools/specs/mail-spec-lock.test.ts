import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAIL_APPROVAL, OPERATOR, type DeliveredMail } from '../../mail/events.js';
import { openMailStore, type MailStore } from '../../mail/mail-store.js';
import { openRegistry, type ProjectRegistry } from '../../registry/registry.js';
import { openSpecStore, type SpecStore } from '../../specs/specs-store.js';
import { specLockApprovalKey } from '../../specs/spec-lock-approval.js';
import type { Criterion } from '../../specs/criteria-schema.js';
import type { ToolContext } from '../context.js';
import { mailSendTool } from './mail.js';
import type { WireMail } from './wire.js';

// Issue #91 — co_mail_send surface parity: minting a `lock_task_id` request stamps the spec-lock key,
// and an approve reply on such a request bridges to the real lock (D3 gate, recordLock as @operator).

const ORIGINAL_ENV = process.env;
let dataDir: string;
let mail: MailStore;
let specs: SpecStore;
let registry: ProjectRegistry;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDir = mkdtempSync(join(tmpdir(), 'co-mail-spec-lock-'));
  process.env.CO_DATA_DIR = dataDir;
  mail = openMailStore('p-mail-lock');
  specs = openSpecStore('p-mail-lock');
  registry = openRegistry();
});

afterEach(() => {
  mail.close();
  specs.close();
  registry.close();
  process.env = ORIGINAL_ENV;
  rmSync(dataDir, { recursive: true, force: true });
});

function ctx(agent: string): ToolContext {
  return { agent, projectId: 'p-mail-lock', cwd: dataDir, mail, specs, registry };
}

const VALID_CRITERIA: Criterion[] = [
  { text: 'expired tokens rejected (401)', verify: 'pnpm vitest run packages/core/x' },
  { text: 'format check passes', verify: 'pnpm format:check' },
];

function seedDraft(taskId: string, criteria: readonly Criterion[]): void {
  specs.recordDraft({ taskId, title: 'T', goal: 'G', criteria, body: 'body', actor: 'coord-1' });
}

function send(agent: string, input: Record<string, unknown>): WireMail {
  return mailSendTool.handler(ctx(agent), input as never) as WireMail;
}

describe('co_mail_send — #91 spec-lock request minting', () => {
  it('lock_task_id mints a spec-lock-keyed approval to @operator with a criteria preview', () => {
    seedDraft('task-1', VALID_CRITERIA);
    const sent = send('coord-1', {
      type: MAIL_APPROVAL,
      subject: 'ignored',
      body: 'ignored',
      lock_task_id: 'task-1',
    });
    expect(sent.type).toBe(MAIL_APPROVAL);
    expect(sent.recipient).toBe(OPERATOR);
    expect(sent.body).toContain('expired tokens rejected (401)');
    // The wire view omits idempotencyKey; read it back off the operator inbox.
    const stored = mail.inbox(OPERATOR).find((m) => m.seq === sent.seq);
    expect(stored?.idempotencyKey).toBe(specLockApprovalKey('task-1'));
  });

  it('lock_task_id without a drafted spec fails loud', () => {
    expect(() =>
      send('coord-1', { type: MAIL_APPROVAL, subject: 's', body: 'b', lock_task_id: 'ghost' }),
    ).toThrow(/no spec record for task 'ghost'/i);
  });

  it('lock_task_id on a non-approval type fails loud', () => {
    seedDraft('task-2', VALID_CRITERIA);
    expect(() =>
      send('coord-1', { type: 'chat', subject: 's', body: 'b', lock_task_id: 'task-2' }),
    ).toThrow(/lock_task_id is only valid for a new 'approval' request/i);
  });

  it('rejects caller-supplied spec-lock idempotency keys outside lock_task_id', () => {
    seedDraft('task-reserved', VALID_CRITERIA);

    expect(() =>
      send('coord-1', {
        type: MAIL_APPROVAL,
        to: OPERATOR,
        subject: 'plain approval',
        body: 'not the criteria preview',
        idempotency_key: specLockApprovalKey('task-reserved'),
      }),
    ).toThrow(/spec-lock.*reserved.*lock_task_id/i);
  });
});

describe('co_mail_send — #91 approve-reply bridges the lock', () => {
  it('operator approve reply on a spec-lock request flips the spec draft->locked', () => {
    seedDraft('task-3', VALID_CRITERIA);
    const req = send('coord-1', {
      type: MAIL_APPROVAL,
      subject: 's',
      body: 'b',
      lock_task_id: 'task-3',
    });

    send(OPERATOR, {
      type: 'approval_response',
      subject: 're: lock',
      body: 'approved',
      in_reply_to: req.seq,
      decision: 'approve',
    });

    expect(specs.getSpec('task-3')?.state).toBe('locked');
    expect(specs.getSpec('task-3')?.lockedBy).toBe(OPERATOR);
  });

  it('decline reply on a spec-lock request leaves the spec draft', () => {
    seedDraft('task-4', VALID_CRITERIA);
    const req = send('coord-1', {
      type: MAIL_APPROVAL,
      subject: 's',
      body: 'b',
      lock_task_id: 'task-4',
    });
    send(OPERATOR, {
      type: 'approval_response',
      subject: 're: lock',
      body: 'no',
      in_reply_to: req.seq,
      decision: 'decline',
    });
    expect(specs.getSpec('task-4')?.state).toBe('draft');
  });

  it('approve reply on a spec-lock request with FUZZY criteria is refused (spec stays draft)', () => {
    seedDraft('task-5', [
      { text: 'expired tokens rejected (401)', verify: 'pnpm vitest run packages/core/x' },
      { text: 'auth works' },
    ]);
    const req = send('coord-1', {
      type: MAIL_APPROVAL,
      subject: 's',
      body: 'b',
      lock_task_id: 'task-5',
    });
    expect(() =>
      send(OPERATOR, {
        type: 'approval_response',
        subject: 're: lock',
        body: 'approved',
        in_reply_to: req.seq,
        decision: 'approve',
      }),
    ).toThrow(/refusing to lock 'task-5'/i);
    expect(specs.getSpec('task-5')?.state).toBe('draft');
  });

  it('approve reply on a NON-lock approval does nothing to specs', () => {
    seedDraft('task-6', VALID_CRITERIA);
    // A plain approval (no spec-lock key) to @operator.
    const plain = mail.send({
      type: MAIL_APPROVAL,
      to: OPERATOR,
      from: 'coord-1',
      subject: 'publish?',
      body: 'bless',
    });
    send(OPERATOR, {
      type: 'approval_response',
      subject: 're',
      body: 'ok',
      in_reply_to: plain.seq,
      decision: 'approve',
    });
    expect(specs.getSpec('task-6')?.state).toBe('draft');
  });

  it('rejects decision on a non-approval_response reply before locking', () => {
    seedDraft('task-7', VALID_CRITERIA);
    const req = send('coord-1', {
      type: MAIL_APPROVAL,
      subject: 's',
      body: 'b',
      lock_task_id: 'task-7',
    });

    expect(() =>
      send(OPERATOR, {
        type: 'chat',
        subject: 'not a structured approval',
        body: 'approved',
        in_reply_to: req.seq,
        decision: 'approve',
      }),
    ).toThrow(/decision.*approval_response/i);
    expect(specs.getSpec('task-7')?.state).toBe('draft');
    expect(mail.inbox('coord-1').some((m) => m.causationId === String(req.seq))).toBe(false);
  });

  it('rejects lock_task_id in reply mode instead of ignoring it', () => {
    const plain = mail.send({
      type: 'chat',
      to: OPERATOR,
      from: 'coord-1',
      subject: 'hello',
      body: 'world',
    });

    expect(() =>
      send(OPERATOR, {
        type: 'chat',
        subject: 're',
        body: 'reply',
        in_reply_to: plain.seq,
        lock_task_id: 'task-ignored',
      }),
    ).toThrow(/lock_task_id.*new approval request/i);
    expect(mail.inbox('coord-1').some((m) => m.causationId === String(plain.seq))).toBe(false);
  });

  it('spec-lock approval_response requires an injected spec store before resolving', () => {
    seedDraft('task-8', VALID_CRITERIA);
    const req = send('coord-1', {
      type: MAIL_APPROVAL,
      subject: 's',
      body: 'b',
      lock_task_id: 'task-8',
    });

    expect(() =>
      mailSendTool.handler({ ...ctx(OPERATOR), specs: undefined }, {
        type: 'approval_response',
        subject: 're: lock',
        body: 'approved',
        in_reply_to: req.seq,
        decision: 'approve',
      } as never),
    ).toThrow(/spec store/i);
    expect(specs.getSpec('task-8')?.state).toBe('draft');
    expect(mail.inbox(OPERATOR).find((m) => m.seq === req.seq)?.resolved).toBe(false);
    expect(mail.inbox('coord-1').some((m) => m.causationId === String(req.seq))).toBe(false);
  });
});

// Type guard: the helper returns a DeliveredMail-shaped wire object.
const _typecheck: (m: DeliveredMail) => void = () => {};
void _typecheck;
