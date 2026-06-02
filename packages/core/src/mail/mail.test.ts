import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { openProjectStore } from '../store/sqlite-store.js';
import type { NewEvent, StoreTx, StoredEvent } from '../store/types.js';
import { applyEvent, rebuildAll, type Projector } from '../replay/projector.js';
import { decode, type SchemaMap } from '../replay/decode.js';
import type { UpcasterRegistry } from '../replay/upcaster.js';
import { assertRepoPristine } from '../config/pristine.js';
import {
  OPERATOR,
  MAIL_CHAT,
  MAIL_OPERATOR_MESSAGE,
  makeMailEvent,
  mailSchemas,
  type DeliveredMail,
  type MailEnvelope,
} from './events.js';
import { MailProjector } from './mail-projector.js';
import { InProcessDelivery, LiveDeliveryStub, type Delivery } from './delivery.js';
import { openMailStore } from './mail-store.js';

// ── Program-data dir per test (mirrors config-store.test.ts) ──────────────────
const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let repoDirs: string[] = [];

function useDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-mail-'));
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

/** A throwaway repo-like tree (a tracked file + a `.git/HEAD`), mirroring pristine.test.ts. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-mail-repo-'));
  repoDirs.push(dir);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}

describe('AC-L1-1 — typed envelope + reserved-field activation + read-back', () => {
  it('round-trips a chat with every reserved field set; reserved columns persisted', () => {
    const mail = openMailStore('p-roundtrip');
    let delivered: DeliveredMail;
    try {
      delivered = mail.send({
        type: MAIL_CHAT,
        to: 'bob',
        from: 'alice',
        subject: 'hi',
        body: 'hello there',
        correlationId: 'thread-42',
        causationId: 'evt-1',
        idempotencyKey: 'idem-1',
      });

      // Read back through the inbox, schema-valid, reserved fields surfaced.
      const inbox = mail.inbox('bob');
      expect(inbox).toHaveLength(1);
      const item = inbox[0]!;
      expect(item).toEqual(delivered);
      expect(item).toMatchObject({
        seq: delivered.seq,
        recipient: 'bob',
        sender: 'alice', // actor
        type: MAIL_CHAT,
        subject: 'hi',
        body: 'hello there',
        correlationId: 'thread-42',
        causationId: 'evt-1',
        idempotencyKey: 'idem-1',
      });
      expect(typeof item.ts).toBe('number');
    } finally {
      mail.close();
    }

    // The reserved columns are populated on the raw L0 event (the widened Store).
    const raw = openProjectStore('p-roundtrip');
    try {
      const events = raw.readAll();
      expect(events).toHaveLength(1);
      const ev = events[0]!;
      expect(ev.scope).toBe('mail:bob');
      expect(ev.type).toBe(MAIL_CHAT);
      expect(ev.actor).toBe('alice');
      expect(ev.correlationId).toBe('thread-42');
      expect(ev.causationId).toBe('evt-1');
      expect(ev.idempotencyKey).toBe('idem-1');
      expect(ev.payload).toEqual({ subject: 'hi', body: 'hello there' });
      expect(ev.seq).toBe(delivered.seq);
    } finally {
      raw.close();
    }
  });

  it('flows operator_message to @operator (both seed types are exercised)', () => {
    const mail = openMailStore('p-op');
    try {
      const d = mail.send({
        type: MAIL_OPERATOR_MESSAGE,
        to: OPERATOR,
        from: 'lead-7',
        subject: 'status',
        body: 'all green',
      });
      const inbox = mail.inbox(OPERATOR);
      expect(inbox).toHaveLength(1);
      expect(inbox[0]).toEqual(d);
      expect(inbox[0]).toMatchObject({
        recipient: OPERATOR,
        sender: 'lead-7',
        type: MAIL_OPERATOR_MESSAGE,
      });
    } finally {
      mail.close();
    }
  });

  it('isolates inboxes: a recipient never sees another recipient’s mail', () => {
    const mail = openMailStore('p-iso');
    try {
      mail.send({ type: MAIL_CHAT, to: 'bob', from: 'alice', subject: 's', body: 'b' });
      mail.send({ type: MAIL_CHAT, to: 'carol', from: 'alice', subject: 's', body: 'b' });
      expect(mail.inbox('bob')).toHaveLength(1);
      expect(mail.inbox('carol')).toHaveLength(1);
      expect(mail.inbox('dave')).toEqual([]);
    } finally {
      mail.close();
    }
  });
});

describe('AC-L1-1 — validated send (no ad-hoc/free-form types; schema enforced)', () => {
  it('throws on an unknown/free-form type', () => {
    const mail = openMailStore('p-bogus');
    try {
      expect(() =>
        mail.send({
          type: 'bogus' as MailEnvelope['type'],
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

  it('throws when the payload fails the zod schema', () => {
    const mail = openMailStore('p-badpayload');
    try {
      expect(() =>
        mail.send({
          type: MAIL_CHAT,
          to: 'bob',
          from: 'alice',
          subject: 123 as unknown as string, // not a string → schema rejects
          body: 'b',
        }),
      ).toThrow();
    } finally {
      mail.close();
    }
  });

  it('throws fail-loud on empty/missing addressing', () => {
    const mail = openMailStore('p-addr');
    try {
      expect(() =>
        mail.send({ type: MAIL_CHAT, to: '', from: 'alice', subject: 's', body: 'b' }),
      ).toThrow(/'to'/);
      expect(() =>
        mail.send({ type: MAIL_CHAT, to: 'bob', from: '', subject: 's', body: 'b' }),
      ).toThrow(/'from'/);
    } finally {
      mail.close();
    }
  });
});

describe('AC-L1-1 — idempotent send (dedupe on idempotencyKey)', () => {
  it('collapses two sends with the same key to one inbox item (same seq)', () => {
    const mail = openMailStore('p-idem');
    try {
      const a = mail.send({
        type: MAIL_CHAT,
        to: 'bob',
        from: 'alice',
        subject: 's',
        body: 'first',
        idempotencyKey: 'k-1',
      });
      const b = mail.send({
        type: MAIL_CHAT,
        to: 'bob',
        from: 'alice',
        subject: 's',
        body: 'second (ignored — dedupe)',
        idempotencyKey: 'k-1',
      });
      expect(mail.inbox('bob')).toHaveLength(1);
      expect(b.seq).toBe(a.seq);
      expect(b).toEqual(a);
      expect(mail.inbox('bob')[0]!.body).toBe('first'); // the first send wins
    } finally {
      mail.close();
    }
  });

  it('treats sends WITHOUT an idempotencyKey as distinct', () => {
    const mail = openMailStore('p-distinct');
    try {
      mail.send({ type: MAIL_CHAT, to: 'bob', from: 'alice', subject: 's', body: 'one' });
      mail.send({ type: MAIL_CHAT, to: 'bob', from: 'alice', subject: 's', body: 'two' });
      expect(mail.inbox('bob')).toHaveLength(2);
    } finally {
      mail.close();
    }
  });
});

describe('AC-L1-2 — in-process delivery; headless; L7 stub fails loud', () => {
  it('makes a sent mail immediately visible to inbox() with no Conductor', () => {
    const mail = openMailStore('p-inproc');
    try {
      expect(mail.inbox('bob')).toEqual([]);
      mail.send({ type: MAIL_CHAT, to: 'bob', from: 'alice', subject: 's', body: 'b' });
      // Synchronous: visible right away, in-process.
      expect(mail.inbox('bob')).toHaveLength(1);
    } finally {
      mail.close();
    }
  });

  it('LiveDeliveryStub.deliver throws the documented not-implemented error', () => {
    // Typed as the seam to prove the stub is a drop-in Delivery (L7 swaps the writer).
    const stub: Delivery = new LiveDeliveryStub();
    const env: MailEnvelope = {
      type: MAIL_CHAT,
      to: 'bob',
      from: 'alice',
      subject: 's',
      body: 'b',
    };
    expect(() => stub.deliver(env)).toThrow(/not implemented|L7 plug-point/i);
  });
});

describe('AC-L1-2 — send routes through the Delivery seam (regression 5)', () => {
  it('calls delivery.deliver and never writes the store directly', () => {
    const calls: MailEnvelope[] = [];
    const fake: DeliveredMail = {
      seq: 999,
      recipient: 'bob',
      sender: 'alice',
      type: MAIL_CHAT,
      subject: 's',
      body: 'b',
      ts: 0,
    };
    const spy: Delivery = {
      deliver(env) {
        calls.push(env);
        return fake;
      },
    };
    const mail = openMailStore('p-seam', { delivery: spy });
    try {
      const env: MailEnvelope = {
        type: MAIL_CHAT,
        to: 'bob',
        from: 'alice',
        subject: 's',
        body: 'b',
      };
      const result = mail.send(env);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual(env);
      expect(result).toBe(fake);
      // The spy persisted nothing → the facade did NOT write the store itself.
      expect(mail.inbox('bob')).toEqual([]);
    } finally {
      mail.close();
    }
  });

  it('validates BEFORE the seam: a bad envelope throws and never reaches delivery (freeze #8)', () => {
    let called = false;
    const spy: Delivery = {
      deliver() {
        called = true;
        throw new Error('should not be reached');
      },
    };
    const mail = openMailStore('p-seam-validate', { delivery: spy });
    try {
      expect(() =>
        mail.send({
          type: 'nope' as MailEnvelope['type'],
          to: 'bob',
          from: 'alice',
          subject: 's',
          body: 'b',
        }),
      ).toThrow(/unknown type/i);
      expect(called).toBe(false);
    } finally {
      mail.close();
    }
  });

  it('the default delivery is in-process (no override → persists + shows in inbox)', () => {
    // Constructing an InProcessDelivery over a project store and routing a send
    // through it is exactly what the default openMailStore wiring does.
    const store = openProjectStore('p-default');
    const delivery = new InProcessDelivery('p-default', store, [new MailProjector()]);
    const mail = openMailStore('p-default', { delivery });
    try {
      mail.send({ type: MAIL_CHAT, to: 'bob', from: 'alice', subject: 's', body: 'b' });
      expect(mail.inbox('bob')).toHaveLength(1);
    } finally {
      mail.close();
      store.close();
    }
  });
});

// ── AC-L0-2 preserved: mail events replay byte-equal alongside a non-mail projector ──
class CounterProjector implements Projector {
  readonly name = 'counter';
  handles(type: string): boolean {
    return type === 'counter.inc';
  }
  private ensure(db: DatabaseSync): void {
    db.exec('CREATE TABLE IF NOT EXISTS counter (scope TEXT PRIMARY KEY, count INTEGER NOT NULL)');
  }
  reset(tx: StoreTx): void {
    const db = tx.raw as DatabaseSync;
    this.ensure(db);
    db.exec('DELETE FROM counter');
  }
  apply(tx: StoreTx, event: StoredEvent): void {
    const db = tx.raw as DatabaseSync;
    this.ensure(db);
    const { by } = event.payload as { by: number };
    db.prepare(
      'INSERT INTO counter (scope, count) VALUES (?, ?) ON CONFLICT(scope) DO UPDATE SET count = count + ?',
    ).run(event.scope, by, by);
  }
}

describe('AC-L1-9 — L0 preserved: byte-equal replay alongside mail (AC-L0-2)', () => {
  const combinedSchemas: SchemaMap = new Map<string, z.ZodType>([
    ...mailSchemas,
    ['counter.inc', z.object({ by: z.number() })],
  ]);
  const combinedUpcasters: UpcasterRegistry = new Map();

  function snapshot(db: DatabaseSync): string {
    db.exec('CREATE TABLE IF NOT EXISTS counter (scope TEXT PRIMARY KEY, count INTEGER NOT NULL)');
    return JSON.stringify({
      inbox: db
        .prepare(
          'SELECT seq, recipient, sender, type, subject, body, correlation_id, causation_id, idempotency_key, ts FROM inbox ORDER BY seq',
        )
        .all(),
      counter: db.prepare('SELECT scope, count FROM counter ORDER BY scope').all(),
    });
  }

  it('a mix of mail + non-mail events rebuilds byte-identical to the live read-model', () => {
    const store = openProjectStore('p-replay');
    const projectors: Projector[] = [new MailProjector(), new CounterProjector()];

    const counter = (scope: string, by: number): NewEvent => ({
      projectId: 'p-replay',
      scope,
      type: 'counter.inc',
      v: 1,
      payload: { by },
    });
    const sequence: NewEvent[] = [
      counter('c:a', 1),
      makeMailEvent('p-replay', {
        type: MAIL_CHAT,
        to: 'bob',
        from: 'alice',
        subject: 'hi',
        body: 'one',
        correlationId: 'thr-1',
      }),
      counter('c:b', 5),
      makeMailEvent('p-replay', {
        type: MAIL_OPERATOR_MESSAGE,
        to: OPERATOR,
        from: 'lead-7',
        subject: 'status',
        body: 'two',
        idempotencyKey: 'k-1',
      }),
      counter('c:a', 2),
    ];

    try {
      for (const e of sequence) {
        store.transaction((tx) => {
          const [s] = tx.append([e]);
          applyEvent(tx, decode(s!, combinedUpcasters, combinedSchemas), projectors);
        });
      }
      const live = store.transaction((tx) => snapshot(tx.raw as DatabaseSync));

      rebuildAll(store, projectors, (e) => decode(e, combinedUpcasters, combinedSchemas));
      const replayed = store.transaction((tx) => snapshot(tx.raw as DatabaseSync));

      expect(replayed).toBe(live);
      // Guard against a vacuous pass (two empty snapshots are also "equal").
      expect(live).toContain('"recipient":"bob"');
      expect(live).toContain('"recipient":"@operator"');
      expect(live).toContain('"scope":"c:a","count":3');
    } finally {
      store.close();
    }
  });
});

describe('AC-L1-9 — pristine: a send writes nothing into a target repo', () => {
  it('wrapping a send in assertRepoPristine does not throw (writes only to CO_DATA_DIR)', () => {
    const repo = makeRepo();
    const mail = openMailStore('p-pristine');
    try {
      const result = assertRepoPristine(repo, () =>
        mail.send({
          type: MAIL_OPERATOR_MESSAGE,
          to: OPERATOR,
          from: 'lead-7',
          subject: 's',
          body: 'b',
        }),
      );
      expect(result.recipient).toBe(OPERATOR);
      // The send really happened — pristine did not block it, it just proved no repo write.
      expect(mail.inbox(OPERATOR)).toHaveLength(1);
    } finally {
      mail.close();
    }
  });
});
