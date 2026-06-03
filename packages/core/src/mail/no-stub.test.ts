import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { openProjectStore } from '../store/sqlite-store.js';
import { rebuildAll } from '../replay/projector.js';
import { decode, type SchemaMap } from '../replay/decode.js';
import {
  OPERATOR,
  MAIL_CHAT,
  MAIL_OPERATOR_MESSAGE,
  MAIL_CLARIFY_REQUEST,
  MAIL_CLARIFY_RESPONSE,
  MAIL_APPROVAL,
  MAIL_APPROVAL_RESPONSE,
  MAIL_ESCALATION,
  MAIL_WORKER_DONE,
  MAIL_TYPES,
  EVENT_MAIL_READ,
  EVENT_MAIL_FORWARD,
  mailSchemas,
  mailUpcasters,
  mailKinds,
  completionPredicates,
  type CompletionPredicate,
  type DeliveredMail,
  type MailEnvelope,
  type MailKind,
  type MailType,
} from './events.js';
import { MailProjector } from './mail-projector.js';
import { openMailStore, type MailStore } from './mail-store.js';
import { checkMailTypeCompleteness } from './completeness.js';

// ── Program-data dir per test (mirrors mail.test.ts) ──────────────────────────
const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];

function useDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-mail-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
  return dir;
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  useDataDir();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
});

/** The real `handles` probe — bound so it never depends on `this`. */
const realHandles = (type: string): boolean => new MailProjector().handles(type);

/** The complete-registry args over the REAL seed enum. */
function realArgs() {
  return {
    types: MAIL_TYPES,
    schemas: mailSchemas,
    kinds: mailKinds,
    predicates: completionPredicates,
    handles: realHandles,
  };
}

/**
 * Exercise a LIVE flow for every {@link MAIL_TYPES} member through a real store: `send`
 * the unthreaded ones and `reply` the threaded/structured ones (a `clarify_response`
 * answering a `clarify_request`; an `approval_response` with a `decision` answering an
 * `approval`). Returns the delivered mail per type — proof each declared type has a real
 * flow, not just a registry entry.
 */
function exerciseEveryType(mail: MailStore): Record<MailType, DeliveredMail> {
  const chat = mail.send({
    type: MAIL_CHAT,
    to: 'bob',
    from: 'alice',
    subject: 'hi',
    body: 'hello',
  });
  const operatorMessage = mail.send({
    type: MAIL_OPERATOR_MESSAGE,
    to: OPERATOR,
    from: 'lead',
    subject: 'status',
    body: 'all green',
  });
  const clarifyRequest = mail.send({
    type: MAIL_CLARIFY_REQUEST,
    to: 'lead',
    from: 'worker',
    subject: 'which db?',
    body: 'sqlite or pg?',
  });
  const clarifyResponse = mail.reply(
    mail.inbox('lead').find((m) => m.seq === clarifyRequest.seq)!,
    { type: MAIL_CLARIFY_RESPONSE, subject: 're: which db?', body: 'sqlite' },
  );
  const approval = mail.send({
    type: MAIL_APPROVAL,
    to: OPERATOR,
    from: 'lead',
    subject: 'ship v1?',
    body: 'requesting a bless on the outward push',
  });
  const approvalResponse = mail.reply(mail.inbox(OPERATOR).find((m) => m.seq === approval.seq)!, {
    type: MAIL_APPROVAL_RESPONSE,
    subject: 're: ship v1?',
    body: 'approved',
    decision: 'approve',
  });
  const escalation = mail.send({
    type: MAIL_ESCALATION,
    to: 'lead',
    from: 'worker',
    subject: 'blocked',
    body: 'cannot proceed without a decision',
  });
  const workerDone = mail.send({
    type: MAIL_WORKER_DONE,
    to: 'lead',
    from: 'worker',
    subject: 'worker_done: co/feature',
    body: 'finished co/feature; tests 3/3 passed',
  });
  return {
    [MAIL_CHAT]: chat,
    [MAIL_OPERATOR_MESSAGE]: operatorMessage,
    [MAIL_CLARIFY_REQUEST]: clarifyRequest,
    [MAIL_CLARIFY_RESPONSE]: clarifyResponse,
    [MAIL_APPROVAL]: approval,
    [MAIL_APPROVAL_RESPONSE]: approvalResponse,
    [MAIL_ESCALATION]: escalation,
    [MAIL_WORKER_DONE]: workerDone,
  };
}

describe('AC-L1-7 — no-stub completeness: GREEN over the real seed enum', () => {
  it('the real MAIL_TYPES + registries + projector handles are complete (no violations)', () => {
    expect(checkMailTypeCompleteness(realArgs())).toEqual([]);
  });

  it('proves it is not vacuous — the enum has every seed type and is non-empty', () => {
    expect(MAIL_TYPES.length).toBe(8);
    expect([...MAIL_TYPES].sort()).toEqual(
      [
        MAIL_APPROVAL,
        MAIL_APPROVAL_RESPONSE,
        MAIL_CHAT,
        MAIL_CLARIFY_REQUEST,
        MAIL_CLARIFY_RESPONSE,
        MAIL_ESCALATION,
        MAIL_OPERATOR_MESSAGE,
        MAIL_WORKER_DONE,
      ].sort(),
    );
  });
});

describe('AC-L1-7 — no-stub completeness: RED for a declared-but-unflowed type', () => {
  const BOGUS = 'bogus_unflowed';
  const dummyPredicate: CompletionPredicate = () => true;

  it('a fully-unwired actionable stub (no schema / no kind / not folded / no predicate) is flagged', () => {
    // The headline RED: a type declared in the enum with NOTHING wired behind it.
    const violations = checkMailTypeCompleteness({
      types: [...MAIL_TYPES, BOGUS],
      schemas: mailSchemas, // no BOGUS schema
      kinds: mailKinds, // no BOGUS kind
      predicates: completionPredicates, // no BOGUS predicate
      handles: realHandles, // does not fold BOGUS
    });
    const forBogus = violations.filter((v) => v.type === BOGUS);
    expect(forBogus.length).toBeGreaterThan(0);
    // Every other (real) type is still complete — only BOGUS is flagged.
    expect(violations.every((v) => v.type === BOGUS)).toBe(true);
  });

  it('(a) a declared type missing ONLY its schema is flagged for the schema', () => {
    const kinds = new Map<string, MailKind>([...mailKinds, [BOGUS, 'actionable']]);
    const predicates = new Map<string, CompletionPredicate>([
      ...completionPredicates,
      [BOGUS, dummyPredicate],
    ]);
    const violations = checkMailTypeCompleteness({
      types: [...MAIL_TYPES, BOGUS],
      schemas: mailSchemas, // ← the only gap
      kinds,
      predicates,
      handles: (t) => realHandles(t) || t === BOGUS,
    });
    const forBogus = violations.filter((v) => v.type === BOGUS);
    expect(forBogus).toHaveLength(1);
    expect(forBogus[0]!.reason).toMatch(/schema/i);
  });

  it('(b) a declared type that is unclassified OR unfolded is flagged for the flow', () => {
    const schemas: SchemaMap = new Map([
      ...mailSchemas,
      [BOGUS, z.object({ subject: z.string(), body: z.string() })],
    ]);

    // Unclassified (no kind) — note: predicate check is skipped while the kind is unknown.
    const unclassified = checkMailTypeCompleteness({
      types: [BOGUS],
      schemas,
      kinds: mailKinds, // ← no BOGUS kind
      predicates: completionPredicates,
      handles: (t) => realHandles(t) || t === BOGUS,
    });
    expect(unclassified).toHaveLength(1);
    expect(unclassified[0]!).toMatchObject({ type: BOGUS });
    expect(unclassified[0]!.reason).toMatch(/classif/i);

    // Unfolded (projector does not handle it) — classified informational so (c) is satisfied.
    const unfolded = checkMailTypeCompleteness({
      types: [BOGUS],
      schemas,
      kinds: new Map<string, MailKind>([...mailKinds, [BOGUS, 'informational']]),
      predicates: completionPredicates, // informational → correctly has none
      handles: realHandles, // ← returns false for BOGUS
    });
    expect(unfolded).toHaveLength(1);
    expect(unfolded[0]!).toMatchObject({ type: BOGUS });
    expect(unfolded[0]!.reason).toMatch(/projector|fold/i);
  });

  it('(c) an actionable type missing its predicate is flagged; an informational type with one is too', () => {
    const schemas: SchemaMap = new Map([
      ...mailSchemas,
      [BOGUS, z.object({ subject: z.string(), body: z.string() })],
    ]);
    const folds = (t: string): boolean => realHandles(t) || t === BOGUS;

    // Actionable but NO predicate → flagged.
    const actionableNoPredicate = checkMailTypeCompleteness({
      types: [BOGUS],
      schemas,
      kinds: new Map<string, MailKind>([...mailKinds, [BOGUS, 'actionable']]),
      predicates: completionPredicates, // ← no BOGUS predicate
      handles: folds,
    });
    expect(actionableNoPredicate).toHaveLength(1);
    expect(actionableNoPredicate[0]!.reason).toMatch(/predicate/i);

    // Informational but HAS a predicate → flagged (it should have none).
    const informationalWithPredicate = checkMailTypeCompleteness({
      types: [BOGUS],
      schemas,
      kinds: new Map<string, MailKind>([...mailKinds, [BOGUS, 'informational']]),
      predicates: new Map<string, CompletionPredicate>([
        ...completionPredicates,
        [BOGUS, dummyPredicate],
      ]),
      handles: folds,
    });
    expect(informationalWithPredicate).toHaveLength(1);
    expect(informationalWithPredicate[0]!.reason).toMatch(/predicate/i);
  });
});

describe('AC-L1-7 — every declared type has a real LIVE flow (not just a registry entry)', () => {
  it('sends/replies every MAIL_TYPES member and each round-trips into its recipient inbox', () => {
    const mail = openMailStore('p-exercise-all');
    try {
      const delivered = exerciseEveryType(mail);
      const seen = new Set<MailType>();
      for (const type of MAIL_TYPES) {
        const d = delivered[type];
        expect(d.type).toBe(type);
        // It really landed in its recipient's inbox (a real flow, end to end).
        const inInbox = mail.inbox(d.recipient).some((m) => m.seq === d.seq && m.type === type);
        expect(inInbox).toBe(true);
        seen.add(type);
      }
      // EVERY declared type was exercised.
      expect([...seen].sort()).toEqual([...MAIL_TYPES].sort());
      // The structured `approval_response` carried its decision through the flow.
      expect(delivered[MAIL_APPROVAL_RESPONSE].decision).toBe('approve');
    } finally {
      mail.close();
    }
  });
});

describe('AC-L1-7 — the bus boundary rejects non-enum types (regressions 1, 7)', () => {
  it('send rejects an ad-hoc / free-form type not in MAIL_TYPES', () => {
    const mail = openMailStore('p-reject-adhoc');
    try {
      expect(() =>
        mail.send({
          type: 'totally_made_up' as MailEnvelope['type'],
          to: 'bob',
          from: 'alice',
          subject: 's',
          body: 'b',
        }),
      ).toThrow(/unknown type/i);
    } finally {
      mail.close();
    }
  });

  it('mail.read is NOT a participant type and send rejects it (the no-stub check ignores it)', () => {
    // The read-receipt is INFRASTRUCTURE: it has a schema + is folded, but it is deliberately
    // NOT in MAIL_TYPES, so the completeness check (which iterates MAIL_TYPES) never sees it.
    expect((MAIL_TYPES as readonly string[]).includes(EVENT_MAIL_READ)).toBe(false);
    const mail = openMailStore('p-reject-read');
    try {
      expect(() =>
        mail.send({
          type: EVENT_MAIL_READ as unknown as MailType,
          to: 'bob',
          from: 'alice',
          subject: 's',
          body: 'b',
        }),
      ).toThrow(/unknown type/i);
    } finally {
      mail.close();
    }
  });

  it('mail.forwarded is NOT a participant type and send rejects it (the no-stub check ignores it)', () => {
    expect((MAIL_TYPES as readonly string[]).includes(EVENT_MAIL_FORWARD)).toBe(false);
    const mail = openMailStore('p-reject-forwarded');
    try {
      expect(() =>
        mail.send({
          type: EVENT_MAIL_FORWARD as unknown as MailType,
          to: 'bob',
          from: 'alice',
          subject: 's',
          body: 'b',
        }),
      ).toThrow(/unknown type/i);
    } finally {
      mail.close();
    }
  });
});

describe('AC-L1-9 — byte-equal replay holds with the FULL type set', () => {
  function snapshotInbox(projectId: string): string {
    const store = openProjectStore(projectId);
    try {
      return store.transaction((tx) =>
        JSON.stringify(
          (tx.raw as DatabaseSync)
            .prepare(
              'SELECT seq, recipient, sender, type, subject, body, correlation_id, causation_id, idempotency_key, ts, kind, read, resolved, thread_id, decision FROM inbox ORDER BY seq',
            )
            .all(),
        ),
      );
    } finally {
      store.close();
    }
  }

  it('a log exercising every MAIL_TYPES member rebuilds byte-identical to the live read-model', () => {
    const projectId = 'p-fulltype-replay';
    const mail = openMailStore(projectId);
    try {
      exerciseEveryType(mail);
    } finally {
      mail.close();
    }

    const live = snapshotInbox(projectId);

    // Discard + re-fold the whole log into a fresh read-model.
    const store = openProjectStore(projectId);
    try {
      rebuildAll(store, [new MailProjector()], (e) => decode(e, mailUpcasters, mailSchemas));
    } finally {
      store.close();
    }
    const replayed = snapshotInbox(projectId);

    expect(replayed).toBe(live);
    // Guard against a vacuous pass: every declared type really appears in the snapshot.
    for (const type of MAIL_TYPES) {
      expect(live).toContain(`"type":"${type}"`);
    }
    expect(live).toContain('"decision":"approve"');
  });
});
