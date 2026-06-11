import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
  EVENT_MAIL_RETRACTED,
  MAIL_CHAT,
  MAIL_CLARIFY_REQUEST,
  MAIL_CLARIFY_RESPONSE,
  MAIL_ESCALATION,
  MAIL_REVIEW_RESPONSE,
  MAIL_TYPES,
  makeMailEvent,
  makeMailForwardEvent,
  makeMailRetractEvent,
  mailSchemas,
  mailUpcasters,
} from './events.js';
import { MailProjector } from './mail-projector.js';
import { LiveDeliveryStub } from './delivery.js';
import { openMailStore } from './mail-store.js';

// ── temp program-data dir + repo fixtures per test (mirrors mail.test.ts) ─────
const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let repoDirs: string[] = [];

function useDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-retract-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
  return dir;
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

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-retract-repo-'));
  repoDirs.push(dir);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}

describe('mail.retracted — the sender withdraws a message (tombstone)', () => {
  it('drops the mail from the recipient inbox but keeps the row (Principle 14)', () => {
    const mail = openMailStore('p-retract');
    try {
      const d = mail.send({ type: MAIL_CHAT, to: 'bob', from: 'alice', subject: 's', body: 'b' });
      expect(mail.inbox('bob')).toHaveLength(1);

      const retracted = mail.retract('alice', d.seq);
      expect(retracted.retracted).toBe(true);
      expect(retracted.seq).toBe(d.seq);

      // Gone from the recipient's inbox …
      expect(mail.inbox('bob')).toEqual([]);
      // … but the sender can still see the tombstone (it is not deleted).
      const sent = mail.sentBy('alice').find((m) => m.seq === d.seq);
      expect(sent?.retracted).toBe(true);
    } finally {
      mail.close();
    }
  });

  it('only the original sender may retract — a non-sender fails loud (Principle 9)', () => {
    const mail = openMailStore('p-retract-owner');
    try {
      const d = mail.send({ type: MAIL_CHAT, to: 'bob', from: 'alice', subject: 's', body: 'b' });
      // The recipient cannot retract someone else's mail.
      expect(() => mail.retract('bob', d.seq)).toThrow(/no mail seq=.* sent by 'bob'/);
      // A stranger cannot either.
      expect(() => mail.retract('carol', d.seq)).toThrow(/sent by 'carol'/);
      // The mail is untouched — still in bob's inbox.
      expect(mail.inbox('bob')).toHaveLength(1);
    } finally {
      mail.close();
    }
  });

  it('retracting an actionable item removes it from outstanding()/outstandingCount()', () => {
    const mail = openMailStore('p-retract-outstanding');
    try {
      const req = mail.send({
        type: MAIL_CLARIFY_REQUEST,
        to: 'lead',
        from: 'worker',
        subject: 'q',
        body: '?',
      });
      expect(mail.outstandingCount('lead')).toBe(1);

      mail.retract('worker', req.seq);
      expect(mail.outstandingCount('lead')).toBe(0);
      expect(mail.outstanding('lead')).toEqual([]);
    } finally {
      mail.close();
    }
  });

  it('a retracted actionable item cannot be forwarded later through a stale handle', () => {
    const mail = openMailStore('p-retract-stale-forward');
    try {
      const held = mail.send({
        type: MAIL_ESCALATION,
        to: 'lead',
        from: 'worker',
        subject: 'blocked',
        body: 'need authority',
      });

      mail.retract('worker', held.seq);

      expect(() =>
        mail.forward(held, {
          type: MAIL_ESCALATION,
          to: 'coordinator',
          from: 'lead',
          subject: held.subject,
          body: held.body,
          correlationId: String(held.seq),
          causationId: String(held.seq),
        }),
      ).toThrow(/retracted|unresolved actionable/i);
      expect(mail.outstandingCount('coordinator')).toBe(0);
    } finally {
      mail.close();
    }
  });

  it('retracting a forwarded escalation lets the reopened held item be forwarded again', () => {
    const mail = openMailStore('p-retract-forward-retry');
    try {
      const held = mail.send({
        type: MAIL_ESCALATION,
        to: 'lead',
        from: 'worker',
        subject: 'blocked',
        body: 'need authority',
      });
      const firstForward = mail.forward(held, {
        type: MAIL_ESCALATION,
        to: 'coordinator',
        from: 'lead',
        subject: held.subject,
        body: held.body,
        correlationId: String(held.seq),
        causationId: String(held.seq),
      });

      mail.retract('lead', firstForward.seq);

      const reopened = mail.inbox('lead').find((m) => m.seq === held.seq)!;
      expect(reopened.resolved).toBe(false);
      const secondForward = mail.forward(reopened, {
        type: MAIL_ESCALATION,
        to: 'coordinator-2',
        from: 'lead',
        subject: held.subject,
        body: held.body,
        correlationId: String(held.seq),
        causationId: String(held.seq),
      });

      expect(secondForward.recipient).toBe('coordinator-2');
      expect(mail.outstandingCount('lead')).toBe(0);
    } finally {
      mail.close();
    }
  });

  it('duplicate retract of an old forward does not reopen an item after it was re-forwarded', () => {
    const mail = openMailStore('p-retract-duplicate-forward');
    try {
      const held = mail.send({
        type: MAIL_ESCALATION,
        to: 'lead',
        from: 'worker',
        subject: 'blocked',
        body: 'need authority',
      });
      const firstForward = mail.forward(held, {
        type: MAIL_ESCALATION,
        to: 'coordinator',
        from: 'lead',
        subject: held.subject,
        body: held.body,
        correlationId: String(held.seq),
        causationId: String(held.seq),
      });

      mail.retract('lead', firstForward.seq);
      const reopened = mail.inbox('lead').find((m) => m.seq === held.seq)!;
      const secondForward = mail.forward(reopened, {
        type: MAIL_ESCALATION,
        to: 'coordinator-2',
        from: 'lead',
        subject: held.subject,
        body: held.body,
        correlationId: String(held.seq),
        causationId: String(held.seq),
      });

      expect(mail.outstandingCount('lead')).toBe(0);
      expect(secondForward.recipient).toBe('coordinator-2');
      mail.retract('lead', firstForward.seq);
      expect(mail.outstandingCount('lead')).toBe(0);
      expect(mail.inbox('lead').find((m) => m.seq === held.seq)?.resolved).toBe(true);
    } finally {
      mail.close();
    }
  });

  it('a retracted actionable item cannot be replied to later through a stale handle', () => {
    const mail = openMailStore('p-retract-stale-reply');
    try {
      const held = mail.send({
        type: MAIL_CLARIFY_REQUEST,
        to: 'lead',
        from: 'worker',
        subject: 'question',
        body: 'need input',
      });

      mail.retract('worker', held.seq);

      expect(() =>
        mail.reply(held, {
          type: MAIL_CLARIFY_RESPONSE,
          subject: 'answer',
          body: 'too late',
          from: 'lead',
        }),
      ).toThrow(/retracted/i);
      expect(mail.inbox('worker')).toEqual([]);
      expect(mail.sentBy('lead')).toEqual([]);
    } finally {
      mail.close();
    }
  });

  it('a forged late forward receipt cannot resolve a retracted held item during projection', () => {
    const projectId = 'p-retract-forward-receipt';
    const store = openProjectStore(projectId);
    const projectors: Projector[] = [new MailProjector()];
    const decodeFn = (e: StoredEvent): StoredEvent => decode(e, mailUpcasters, mailSchemas);

    try {
      const held = store.transaction((tx) => {
        const [stored] = tx.append([
          makeMailEvent(projectId, {
            type: MAIL_ESCALATION,
            to: 'lead',
            from: 'worker',
            subject: 'blocked',
            body: 'need authority',
          }),
        ]);
        applyEvent(tx, decodeFn(stored!), projectors);
        return stored!;
      });
      store.transaction((tx) => {
        const [stored] = tx.append([
          makeMailEvent(projectId, {
            type: MAIL_ESCALATION,
            to: 'coordinator',
            from: 'lead',
            subject: 'blocked',
            body: 'need authority',
            correlationId: String(held.seq),
            causationId: String(held.seq),
          }),
        ]);
        applyEvent(tx, decodeFn(stored!), projectors);
      });
      const mail = openMailStore(projectId);
      try {
        mail.retract('worker', held.seq);
      } finally {
        mail.close();
      }

      expect(() =>
        store.transaction((tx) => {
          const [stored] = tx.append([
            makeMailForwardEvent(projectId, 'lead', held.seq, 'coordinator'),
          ]);
          applyEvent(tx, decodeFn(stored!), projectors);
        }),
      ).toThrow(/retracted/i);

      const row = store.transaction(
        (tx) =>
          (tx.raw as DatabaseSync)
            .prepare('SELECT resolved, retracted FROM inbox WHERE seq = ?')
            .get(held.seq) as { resolved: number; retracted: number },
      );
      expect(row).toEqual({ resolved: 0, retracted: 1 });
    } finally {
      store.close();
    }
  });

  it('a forged retract receipt with mismatched actor is rejected during projection', () => {
    const projectId = 'p-retract-forged-actor';
    const store = openProjectStore(projectId);
    const projectors: Projector[] = [new MailProjector()];
    const decodeFn = (e: StoredEvent): StoredEvent => decode(e, mailUpcasters, mailSchemas);

    try {
      const sent = store.transaction((tx) => {
        const [stored] = tx.append([
          makeMailEvent(projectId, {
            type: MAIL_CHAT,
            to: 'bob',
            from: 'alice',
            subject: 's',
            body: 'b',
          }),
        ]);
        applyEvent(tx, decodeFn(stored!), projectors);
        return stored!;
      });

      expect(() =>
        store.transaction((tx) => {
          const [stored] = tx.append([
            { ...makeMailRetractEvent(projectId, 'alice', sent.seq), actor: 'mallory' },
          ]);
          applyEvent(tx, decodeFn(stored!), projectors);
        }),
      ).toThrow(/actor.*sender/i);
    } finally {
      store.close();
    }
  });

  it('a forged retract receipt from a non-sender is rejected during projection', () => {
    const projectId = 'p-retract-forged-sender';
    const store = openProjectStore(projectId);
    const projectors: Projector[] = [new MailProjector()];
    const decodeFn = (e: StoredEvent): StoredEvent => decode(e, mailUpcasters, mailSchemas);

    try {
      const sent = store.transaction((tx) => {
        const [stored] = tx.append([
          makeMailEvent(projectId, {
            type: MAIL_CHAT,
            to: 'bob',
            from: 'alice',
            subject: 's',
            body: 'b',
          }),
        ]);
        applyEvent(tx, decodeFn(stored!), projectors);
        return stored!;
      });

      expect(() =>
        store.transaction((tx) => {
          const [stored] = tx.append([makeMailRetractEvent(projectId, 'mallory', sent.seq)]);
          applyEvent(tx, decodeFn(stored!), projectors);
        }),
      ).toThrow(/sent by 'mallory'|original sender/i);

      const row = store.transaction(
        (tx) =>
          (tx.raw as DatabaseSync)
            .prepare('SELECT retracted FROM inbox WHERE seq = ?')
            .get(sent.seq) as { retracted: number },
      );
      expect(row.retracted).toBe(0);
    } finally {
      store.close();
    }
  });

  it('review mail retract receipts are rejected during projection', () => {
    const projectId = 'p-retract-review-mail';
    const store = openProjectStore(projectId);
    const projectors: Projector[] = [new MailProjector()];
    const decodeFn = (e: StoredEvent): StoredEvent => decode(e, mailUpcasters, mailSchemas);

    try {
      const response = store.transaction((tx) => {
        const [stored] = tx.append([
          makeMailEvent(projectId, {
            type: MAIL_REVIEW_RESPONSE,
            to: 'lead',
            from: '@operator',
            subject: 'review',
            body: 'PASS',
            reviewVerdict: 'PASS',
          }),
        ]);
        applyEvent(tx, decodeFn(stored!), projectors);
        return stored!;
      });

      expect(() =>
        store.transaction((tx) => {
          const [stored] = tx.append([makeMailRetractEvent(projectId, '@operator', response.seq)]);
          applyEvent(tx, decodeFn(stored!), projectors);
        }),
      ).toThrow(/review_response|review mail/i);
    } finally {
      store.close();
    }
  });

  it('LiveDeliveryStub.retract fails loud with the documented L7 plug-point error', () => {
    expect(() => new LiveDeliveryStub().retract()).toThrow(/not implemented|L7 plug-point/i);
  });
});

describe('AC-L1-9 preserved — a log with a mail.retracted event replays byte-identical', () => {
  function snapshot(projectId: string): string {
    const store = openProjectStore(projectId);
    try {
      return store.transaction((tx) =>
        JSON.stringify(
          (tx.raw as DatabaseSync)
            .prepare(
              'SELECT seq, recipient, sender, type, subject, body, correlation_id, causation_id, ' +
                'idempotency_key, ts, kind, read, resolved, thread_id, decision, retracted ' +
                'FROM inbox ORDER BY seq',
            )
            .all(),
        ),
      );
    } finally {
      store.close();
    }
  }

  it('send + retract rebuilds byte-identical to the live read-model (retracted=1 preserved)', () => {
    const projectId = 'p-retract-replay';
    let seq: number;
    const mail = openMailStore(projectId);
    try {
      const d = mail.send({ type: MAIL_CHAT, to: 'bob', from: 'alice', subject: 's', body: 'b' });
      seq = d.seq;
      mail.retract('alice', seq);
    } finally {
      mail.close();
    }

    const live = snapshot(projectId);

    const store = openProjectStore(projectId);
    try {
      rebuildAll(store, [new MailProjector()], (e) => decode(e, mailUpcasters, mailSchemas));
    } finally {
      store.close();
    }
    const replayed = snapshot(projectId);

    expect(replayed).toBe(live);
    // Guard against a vacuous pass: the retract really took effect, and the raw event is logged.
    expect(live).toContain('"retracted":1');

    const raw = openProjectStore(projectId);
    try {
      const types = raw.readAll().map((e) => e.type);
      expect(types).toContain(EVENT_MAIL_RETRACTED);
      // The tombstone is infrastructure — never a sendable participant type.
      expect((MAIL_TYPES as readonly string[]).includes(EVENT_MAIL_RETRACTED)).toBe(false);
    } finally {
      raw.close();
    }
  });
});

describe('AC-L1-9 preserved — retract writes nothing into a target repo (pristine)', () => {
  it('wrapping a retract in assertRepoPristine does not throw (writes only to CO_DATA_DIR)', () => {
    const repo = makeRepo();
    const mail = openMailStore('p-retract-pristine');
    try {
      const d = mail.send({ type: MAIL_CHAT, to: 'bob', from: 'alice', subject: 's', body: 'b' });
      const result = assertRepoPristine(repo, () => mail.retract('alice', d.seq));
      expect(result.retracted).toBe(true);
      expect(mail.inbox('bob')).toEqual([]);
    } finally {
      mail.close();
    }
  });
});

describe('mail idempotency after retraction', () => {
  it('retrying a retracted send with the same idempotency key returns the tombstone', () => {
    const mail = openMailStore('p-retract-idempotency');
    try {
      const first = mail.send({
        type: MAIL_CHAT,
        to: 'bob',
        from: 'alice',
        subject: 's',
        body: 'b',
        idempotencyKey: 'chat:once',
      });
      const retracted = mail.retract('alice', first.seq);
      const retry = mail.send({
        type: MAIL_CHAT,
        to: 'bob',
        from: 'alice',
        subject: 's',
        body: 'b',
        idempotencyKey: 'chat:once',
      });

      expect(retry.seq).toBe(first.seq);
      expect(retry.retracted).toBe(true);
      expect(retry).toEqual(retracted);
      expect(mail.inbox('bob')).toEqual([]);
    } finally {
      mail.close();
    }
  });
});
