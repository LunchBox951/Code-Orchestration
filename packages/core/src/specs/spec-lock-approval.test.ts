import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAIL_APPROVAL, OPERATOR, type DeliveredMail } from '../mail/events.js';
import { openSpecStore, type SpecStore } from './specs-store.js';
import type { Criterion } from './criteria-schema.js';
import {
  applyApprovalLockSideEffect,
  buildSpecLockApprovalEnvelope,
  specLockApprovalKey,
  taskIdFromSpecLockApprovalKey,
} from './spec-lock-approval.js';

// Issue #91: an operator `approve` of a `spec-lock:<taskId>` approval must run the SAME lock path as
// co_spec_lock (D3 gate then recordLock, actor=OPERATOR); a non-lock or declined approval is a strict
// no-op on specs.

const ORIGINAL_ENV = process.env;
let dataDir: string;
let stores: SpecStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDir = mkdtempSync(join(tmpdir(), 'co-spec-lock-approval-'));
  process.env.CO_DATA_DIR = dataDir;
  stores = [];
});

afterEach(() => {
  for (const s of stores) s.close();
  process.env = ORIGINAL_ENV;
  rmSync(dataDir, { recursive: true, force: true });
});

function openSpecs(id: string): SpecStore {
  const specs = openSpecStore(id);
  stores.push(specs);
  return specs;
}

const VALID_CRITERIA: Criterion[] = [
  { text: 'expired tokens rejected (401)', verify: 'pnpm vitest run packages/core/x' },
  { text: 'format check passes', verify: 'pnpm format:check' },
];

function seedDraft(specs: SpecStore, taskId: string, criteria: readonly Criterion[]): void {
  specs.recordDraft({ taskId, title: 'T', goal: 'G', criteria, body: 'body', actor: 'coord-1' });
}

/** A spec-lock approval mail shaped like the one a coordinator sends to @operator. */
function specLockApproval(taskId: string, over: Partial<DeliveredMail> = {}): DeliveredMail {
  return {
    seq: 1,
    type: MAIL_APPROVAL,
    sender: 'coord-1',
    recipient: OPERATOR,
    subject: `Lock spec for ${taskId}`,
    body: 'freeze criteria',
    idempotencyKey: specLockApprovalKey(taskId),
    ...over,
  } as DeliveredMail;
}

describe('specLockApprovalKey / taskIdFromSpecLockApprovalKey', () => {
  it('round-trips a task id', () => {
    expect(specLockApprovalKey('task-7')).toBe('spec-lock:task-7');
    expect(taskIdFromSpecLockApprovalKey('spec-lock:task-7')).toBe('task-7');
  });

  it('returns undefined for a non-spec-lock key, an empty task id, or no key', () => {
    expect(taskIdFromSpecLockApprovalKey('issue-file:abc')).toBeUndefined();
    expect(taskIdFromSpecLockApprovalKey('spec-lock:')).toBeUndefined();
    expect(taskIdFromSpecLockApprovalKey(undefined)).toBeUndefined();
  });
});

describe('buildSpecLockApprovalEnvelope', () => {
  it('addresses @operator and stamps the spec-lock idempotency key', () => {
    const specs = openSpecs('p-build-envelope');
    seedDraft(specs, 'task-1', VALID_CRITERIA);
    const env = buildSpecLockApprovalEnvelope({
      from: 'coord-1',
      taskId: 'task-1',
      spec: specs.getSpec('task-1')!,
    });
    expect(env.type).toBe(MAIL_APPROVAL);
    expect(env.to).toBe(OPERATOR);
    expect(env.idempotencyKey).toBe('spec-lock:task-1');
    expect(env.body).toContain('expired tokens rejected (401)');
  });
});

describe('applyApprovalLockSideEffect — the #91 bridge', () => {
  it('approve of a spec-lock approval flips a wired-criteria draft draft->locked as OPERATOR', () => {
    const specs = openSpecs('p-bridge-ok');
    seedDraft(specs, 'task-1', VALID_CRITERIA);

    const locked = applyApprovalLockSideEffect(specs, specLockApproval('task-1'), 'approve');

    expect(locked?.state).toBe('locked');
    expect(locked?.lockedBy).toBe(OPERATOR);
    expect(specs.getSpec('task-1')?.state).toBe('locked');
  });

  it('approve with fuzzy criteria is REFUSED — the spec stays draft (D3 not bypassed)', () => {
    const specs = openSpecs('p-bridge-fuzzy');
    seedDraft(specs, 'task-2', [
      { text: 'expired tokens rejected (401)', verify: 'pnpm vitest run packages/core/x' },
      { text: 'auth works' },
    ]);

    expect(() => applyApprovalLockSideEffect(specs, specLockApproval('task-2'), 'approve')).toThrow(
      /refusing to lock 'task-2'.*no wired verification command/is,
    );
    expect(specs.getSpec('task-2')?.state).toBe('draft');
  });

  it('approve of a non-lock approval (no spec-lock key) does nothing to any spec', () => {
    const specs = openSpecs('p-bridge-nonlock');
    seedDraft(specs, 'task-3', VALID_CRITERIA);

    const nonLock = specLockApproval('task-3', { idempotencyKey: 'issue-file:iss-9' });
    const result = applyApprovalLockSideEffect(specs, nonLock, 'approve');

    expect(result).toBeUndefined();
    expect(specs.getSpec('task-3')?.state).toBe('draft');
  });

  it('approve of an approval mail with NO idempotency key does nothing', () => {
    const specs = openSpecs('p-bridge-nokey');
    seedDraft(specs, 'task-4', VALID_CRITERIA);
    const noKey = specLockApproval('task-4', { idempotencyKey: undefined });
    expect(applyApprovalLockSideEffect(specs, noKey, 'approve')).toBeUndefined();
    expect(specs.getSpec('task-4')?.state).toBe('draft');
  });

  it('decline of a spec-lock approval records nothing — the spec stays draft', () => {
    const specs = openSpecs('p-bridge-decline');
    seedDraft(specs, 'task-5', VALID_CRITERIA);

    const result = applyApprovalLockSideEffect(specs, specLockApproval('task-5'), 'decline');

    expect(result).toBeUndefined();
    expect(specs.getSpec('task-5')?.state).toBe('draft');
  });

  it('idempotent re-approve of an already-locked spec is a no-op (returns the locked record, no throw)', () => {
    const specs = openSpecs('p-bridge-idempotent');
    seedDraft(specs, 'task-6', VALID_CRITERIA);
    applyApprovalLockSideEffect(specs, specLockApproval('task-6'), 'approve');

    const again = applyApprovalLockSideEffect(specs, specLockApproval('task-6'), 'approve');

    expect(again?.state).toBe('locked');
    expect(again?.lockedBy).toBe(OPERATOR);
    expect(specs.getSpec('task-6')?.state).toBe('locked');
  });

  it('non-approval mail type is ignored', () => {
    const specs = openSpecs('p-bridge-wrongtype');
    seedDraft(specs, 'task-7', VALID_CRITERIA);
    const notApproval = specLockApproval('task-7', { type: 'chat' as DeliveredMail['type'] });
    expect(applyApprovalLockSideEffect(specs, notApproval, 'approve')).toBeUndefined();
    expect(specs.getSpec('task-7')?.state).toBe('draft');
  });
});
