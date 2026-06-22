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
  MAIL_CLARIFY_REQUEST,
  MAIL_CLARIFY_RESPONSE,
  MAIL_TYPES,
  makeMailEvent,
  makeMailReadEvent,
  mailSchemas,
  mailUpcasters,
  mailKinds,
  mailKind,
  completionPredicates,
  completionPredicate,
  type DeliveredMail,
  type MailEnvelope,
} from './events.js';
import { ensureInboxTable, MailProjector } from './mail-projector.js';
import { InProcessDelivery, type Delivery } from './delivery.js';
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
  it('migrates a legacy inbox projection that predates retraction + review verdict columns', () => {
    const store = openProjectStore('p-legacy-inbox');
    try {
      store.transaction((tx) => {
        const db = tx.raw as DatabaseSync;
        db.exec(`
          CREATE TABLE inbox (
            seq             INTEGER PRIMARY KEY,
            recipient       TEXT NOT NULL,
            sender          TEXT NOT NULL,
            type            TEXT NOT NULL,
            subject         TEXT NOT NULL,
            body            TEXT NOT NULL,
            correlation_id  TEXT,
            causation_id    TEXT,
            idempotency_key TEXT,
            ts              INTEGER NOT NULL,
            kind            TEXT NOT NULL,
            read            INTEGER NOT NULL DEFAULT 0,
            resolved        INTEGER NOT NULL DEFAULT 0,
            thread_id       TEXT NOT NULL,
            decision        TEXT
          );
        `);
        ensureInboxTable(db);
        const columns = db.prepare('PRAGMA table_info(inbox)').all() as Array<{ name: string }>;
        expect(columns.map((c) => c.name)).toEqual(
          expect.arrayContaining(['retracted', 'review_verdict']),
        );
      });
    } finally {
      store.close();
    }

    const mail = openMailStore('p-legacy-inbox');
    try {
      expect(mail.inbox('bob')).toEqual([]);
      const sent = mail.send({
        type: MAIL_CHAT,
        to: 'bob',
        from: 'alice',
        subject: 'legacy ok',
        body: 'projection migrated',
      });
      expect(mail.inbox('bob')).toEqual([sent]);
    } finally {
      mail.close();
    }
  });

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

  it('scopes an idempotencyKey to the sender/recipient/type operation boundary', () => {
    const mail = openMailStore('p-idem-scope');
    try {
      const toBob = mail.send({
        type: MAIL_CHAT,
        to: 'bob',
        from: 'alice',
        subject: 's',
        body: 'for bob',
        idempotencyKey: 'shared-key',
      });
      const toCarol = mail.send({
        type: MAIL_CHAT,
        to: 'carol',
        from: 'alice',
        subject: 's',
        body: 'for carol',
        idempotencyKey: 'shared-key',
      });
      const fromDana = mail.send({
        type: MAIL_CHAT,
        to: 'bob',
        from: 'dana',
        subject: 's',
        body: 'from dana',
        idempotencyKey: 'shared-key',
      });

      expect(toCarol.seq).not.toBe(toBob.seq);
      expect(fromDana.seq).not.toBe(toBob.seq);
      expect(mail.inbox('bob').map((m) => m.body)).toEqual(['for bob', 'from dana']);
      expect(mail.inbox('carol').map((m) => m.body)).toEqual(['for carol']);
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

  it('partial UNIQUE index collapses a duplicate-key event that slipped past the in-tx dedup (#7 §5 #8)', () => {
    // The read-then-append dedup is per-transaction; two PROCESSES can both pass it and append the
    // same idempotency_key. Simulate that by folding two same-key events in separate transactions
    // (bypassing deliver's dedup). The partial UNIQUE index + ON CONFLICT must collapse to one row.
    const store = openProjectStore('p-idem-race');
    try {
      const projectors = [new MailProjector()];
      const fold = (body: string): void => {
        store.transaction((tx) => {
          const [stored] = tx.append([
            makeMailEvent('p-idem-race', {
              type: MAIL_CHAT,
              to: 'bob',
              from: 'alice',
              subject: 's',
              body,
              idempotencyKey: 'race-key',
            }),
          ]);
          applyEvent(tx, decode(stored!, mailUpcasters, mailSchemas), projectors);
        });
      };
      fold('first');
      fold('second');
      const rows = store.transaction(
        (tx) =>
          (tx.raw as DatabaseSync)
            .prepare(`SELECT body FROM inbox WHERE recipient = 'bob'`)
            .all() as Array<{ body: string }>,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.body).toBe('first'); // lowest seq wins; the duplicate collapsed
    } finally {
      store.close();
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

  // L7 C2 replaced the throwing `LiveDeliveryStub` with the real Conductor-side `LiveDelivery`
  // (delegates persistence to InProcessDelivery + injected wake/inject seams). Its behavior is
  // covered in live-delivery.test.ts; the drop-in `Delivery` shape is still asserted there.
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

describe('AC-L1-2 — reply derives threading from the persisted row', () => {
  it('ignores forged DeliveredMail fields and replies to the stored sender from the stored recipient', () => {
    const mail = openMailStore('p-reply-forged');
    try {
      const actual = mail.send({
        type: MAIL_CHAT,
        to: 'lead',
        from: 'worker',
        subject: 'q',
        body: '?',
      });
      const forged = {
        ...actual,
        recipient: OPERATOR,
        sender: 'worker',
        correlationId: 'forged-thread',
      };

      const reply = mail.reply(forged, {
        type: MAIL_CHAT,
        subject: 're',
        body: 'answer',
      });

      expect(reply.sender).toBe('lead');
      expect(reply.recipient).toBe('worker');
      expect(reply.correlationId).toBe(String(actual.seq));
      expect(reply.causationId).toBe(String(actual.seq));
    } finally {
      mail.close();
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

// ── W3: actionable/informational, sticky resolution, read-state, registries ──────

/**
 * Drop + re-fold the WHOLE log into a fresh read-model — the AC-L1-3 / AC-L0-2
 * replay path. Anything log-derived (read/resolved) is reproduced; anything held as
 * mutable-only state would be lost. The mail store is closed before this so only one
 * sqlite handle touches the file at a time.
 */
function rebuildOf(projectId: string): void {
  const store = openProjectStore(projectId);
  try {
    rebuildAll(store, [new MailProjector()], (e) => decode(e, mailUpcasters, mailSchemas));
  } finally {
    store.close();
  }
}

describe('AC-L1-3 — actionable mail is un-loseable across restart (the headline invariant)', () => {
  it('a VIEWED clarify_request stays pending across rebuild; only a clarify_response clears it', () => {
    // worker asks lead — actionable FOR THE LEAD (the recipient must answer it).
    const mail = openMailStore('p-headline');
    let req: DeliveredMail;
    try {
      req = mail.send({
        type: MAIL_CLARIFY_REQUEST,
        to: 'lead',
        from: 'worker',
        subject: 'which db?',
        body: 'sqlite or pg?',
      });
      expect(req.kind).toBe('actionable');
      expect(req.resolved).toBe(false);
      expect(mail.outstandingCount('lead')).toBe(1);

      // Lead VIEWS it — viewing must NOT resolve an actionable item (freeze #4).
      const viewed = mail.markRead('lead', req.seq);
      expect(viewed.read).toBe(true);
      expect(viewed.resolved).toBe(false);
      expect(mail.outstandingCount('lead')).toBe(1);
    } finally {
      mail.close();
    }

    // Rebuild from the log: STILL pending, and the read-state survived the rebuild
    // (so neither "viewed" nor "pending" is mutable-only state — both are log-derived).
    rebuildOf('p-headline');
    {
      const m = openMailStore('p-headline');
      try {
        expect(m.outstandingCount('lead')).toBe(1);
        const row = m.inbox('lead').find((x) => x.seq === req.seq)!;
        expect(row.read).toBe(true);
        expect(row.resolved).toBe(false);
      } finally {
        m.close();
      }
    }

    // The lead REPLIES — an in-thread clarify_response clears the request.
    {
      const m = openMailStore('p-headline');
      try {
        const reqRow = m.inbox('lead').find((x) => x.seq === req.seq)!;
        const resp = m.reply(reqRow, {
          type: MAIL_CLARIFY_RESPONSE,
          subject: 're: which db?',
          body: 'sqlite',
        });
        expect(resp.type).toBe(MAIL_CLARIFY_RESPONSE);
        expect(resp.recipient).toBe('worker'); // reply goes back to the asker
        expect(resp.correlationId).toBe(String(req.seq)); // thread id = root seq (freeze #7)
        expect(resp.causationId).toBe(String(req.seq)); // answers the request
        expect(m.outstandingCount('lead')).toBe(0); // request cleared
        expect(m.inbox('lead').find((x) => x.seq === req.seq)!.resolved).toBe(true);
      } finally {
        m.close();
      }
    }

    // The RESOLVED state also survives a rebuild (it is the closing event, log-derived).
    rebuildOf('p-headline');
    {
      const m = openMailStore('p-headline');
      try {
        expect(m.outstandingCount('lead')).toBe(0);
        expect(m.inbox('lead').find((x) => x.seq === req.seq)!.resolved).toBe(true);
      } finally {
        m.close();
      }
    }
  });
});

describe('AC-L1-3 — informational mail clears on view (event-sourced; survives rebuild)', () => {
  it('marking it read sets read=true, never counts as outstanding, and the rebuild preserves it', () => {
    const mail = openMailStore('p-info');
    let seq: number;
    try {
      const d = mail.send({
        type: MAIL_OPERATOR_MESSAGE,
        to: OPERATOR,
        from: 'lead',
        subject: 's',
        body: 'b',
      });
      expect(d.kind).toBe('informational');
      expect(d.read).toBe(false);
      expect(mail.outstandingCount(OPERATOR)).toBe(0); // informational is never outstanding

      const viewed = mail.markRead(OPERATOR, d.seq);
      expect(viewed.read).toBe(true);
      seq = d.seq;
    } finally {
      mail.close();
    }

    rebuildOf('p-info');
    const m = openMailStore('p-info');
    try {
      const row = m.inbox(OPERATOR).find((x) => x.seq === seq)!;
      expect(row.read).toBe(true); // read-state is a pure function of the log
      expect(row.kind).toBe('informational');
    } finally {
      m.close();
    }
  });
});

describe('AC-L1-3 — outstanding-action count is a projection (drops on resolve; rebuild identical)', () => {
  it('counts unresolved actionable items, drops as they resolve, and rebuilds to the same count', () => {
    const mail = openMailStore('p-count');
    try {
      const r1 = mail.send({
        type: MAIL_CLARIFY_REQUEST,
        to: 'lead',
        from: 'w1',
        subject: 'q1',
        body: '?',
      });
      const r2 = mail.send({
        type: MAIL_CLARIFY_REQUEST,
        to: 'lead',
        from: 'w2',
        subject: 'q2',
        body: '?',
      });
      mail.send({ type: MAIL_CLARIFY_REQUEST, to: 'lead', from: 'w3', subject: 'q3', body: '?' });
      // Informational mail to the SAME recipient does NOT add to the outstanding count.
      mail.send({ type: MAIL_CHAT, to: 'lead', from: 'w4', subject: 'fyi', body: 'hi' });
      expect(mail.outstandingCount('lead')).toBe(3);
      expect(mail.outstanding('lead')).toHaveLength(3);
      expect(mail.outstanding('lead').every((x) => x.kind === 'actionable' && !x.resolved)).toBe(
        true,
      );

      const inbox = mail.inbox('lead');
      mail.reply(inbox.find((x) => x.seq === r1.seq)!, {
        type: MAIL_CLARIFY_RESPONSE,
        subject: 'a1',
        body: 'x',
      });
      mail.reply(inbox.find((x) => x.seq === r2.seq)!, {
        type: MAIL_CLARIFY_RESPONSE,
        subject: 'a2',
        body: 'y',
      });
      expect(mail.outstandingCount('lead')).toBe(1);
    } finally {
      mail.close();
    }

    rebuildOf('p-count');
    const m = openMailStore('p-count');
    try {
      expect(m.outstandingCount('lead')).toBe(1);
    } finally {
      m.close();
    }
  });
});

describe('AC-L1-4 — completion-predicate registry (generic Map; clarify pairing)', () => {
  it('a clarify_request is closed only by an in-thread clarify_response (correlationId + causationId)', () => {
    const mail = openMailStore('p-pred');
    try {
      const req = mail.send({
        type: MAIL_CLARIFY_REQUEST,
        to: 'lead',
        from: 'worker',
        subject: 'q',
        body: '?',
      });

      // Same thread, WRONG causationId → predicate says "not mine" → request stays open.
      mail.send({
        type: MAIL_CLARIFY_RESPONSE,
        to: 'lead',
        from: 'someone',
        subject: 'noise',
        body: 'unrelated',
        correlationId: String(req.seq),
        causationId: '99999',
      });
      expect(mail.outstandingCount('lead')).toBe(1);

      // The correct in-thread reply (causationId = the request seq) resolves it.
      mail.reply(mail.inbox('lead').find((x) => x.seq === req.seq)!, {
        type: MAIL_CLARIFY_RESPONSE,
        subject: 'a',
        body: 'answer',
      });
      expect(mail.outstandingCount('lead')).toBe(0);
    } finally {
      mail.close();
    }
  });

  it('a clarify_request is not closed by a spoofed response from the wrong actor or to the wrong recipient', () => {
    const mail = openMailStore('p-pred-spoof');
    try {
      const req = mail.send({
        type: MAIL_CLARIFY_REQUEST,
        to: 'lead',
        from: 'worker',
        subject: 'q',
        body: '?',
      });

      mail.send({
        type: MAIL_CLARIFY_RESPONSE,
        to: 'worker',
        from: 'intruder',
        subject: 'spoof',
        body: 'not the holder',
        correlationId: String(req.seq),
        causationId: String(req.seq),
      });
      expect(mail.outstandingCount('lead')).toBe(1);

      mail.send({
        type: MAIL_CLARIFY_RESPONSE,
        to: 'auditor',
        from: 'lead',
        subject: 'misrouted',
        body: 'not back to the asker',
        correlationId: String(req.seq),
        causationId: String(req.seq),
      });
      expect(mail.outstandingCount('lead')).toBe(1);

      mail.reply(mail.inbox('lead').find((x) => x.seq === req.seq)!, {
        type: MAIL_CLARIFY_RESPONSE,
        subject: 'a',
        body: 'answer',
      });
      expect(mail.outstandingCount('lead')).toBe(0);
    } finally {
      mail.close();
    }
  });

  it('the registries are generic Maps (lookup, not a switch); informational types have no predicate', () => {
    expect(completionPredicates instanceof Map).toBe(true);
    expect(mailKinds instanceof Map).toBe(true);
    expect(completionPredicate(MAIL_CLARIFY_REQUEST)).toBeTypeOf('function');
    expect(completionPredicate(MAIL_CLARIFY_RESPONSE)).toBeUndefined();
    expect(completionPredicate(MAIL_CHAT)).toBeUndefined();
    expect(completionPredicate(MAIL_OPERATOR_MESSAGE)).toBeUndefined();
  });
});

describe('AC-L1-4 — no-stub readiness (helps W6): every actionable type has a predicate', () => {
  it('mailKind is total over MAIL_TYPES, and each actionable member has a registered predicate', () => {
    for (const type of MAIL_TYPES) {
      expect(() => mailKind(type)).not.toThrow(); // kind registry is total over MAIL_TYPES
      if (mailKind(type) === 'actionable') {
        expect(completionPredicate(type)).toBeTypeOf('function');
      } else {
        expect(completionPredicate(type)).toBeUndefined();
      }
    }
  });
});

describe('AC-L1-9 — new events replay byte-equal; send/markRead are repo-pristine', () => {
  function w3Snapshot(db: DatabaseSync): string {
    return JSON.stringify(
      db
        .prepare(
          'SELECT seq, recipient, sender, type, subject, body, correlation_id, causation_id, idempotency_key, ts, kind, read, resolved, thread_id FROM inbox ORDER BY seq',
        )
        .all(),
    );
  }

  it('a clarify thread + read-receipt rebuilds byte-identical (incl. kind/read/resolved/thread_id)', () => {
    const store = openProjectStore('p-w3-replay');
    const projectors: Projector[] = [new MailProjector()];
    const decodeFn = (e: StoredEvent): StoredEvent => decode(e, mailUpcasters, mailSchemas);

    try {
      // request (root) → response (closes it) → read-receipt on the request.
      const req = store.transaction((tx) => {
        const [s] = tx.append([
          makeMailEvent('p-w3-replay', {
            type: MAIL_CLARIFY_REQUEST,
            to: 'lead',
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
          makeMailEvent('p-w3-replay', {
            type: MAIL_CLARIFY_RESPONSE,
            to: 'worker',
            from: 'lead',
            subject: 'a',
            body: 'answer',
            correlationId: String(req.seq),
            causationId: String(req.seq),
          }),
        ]);
        applyEvent(tx, decodeFn(s!), projectors);
      });
      store.transaction((tx) => {
        const [s] = tx.append([makeMailReadEvent('p-w3-replay', 'lead', req.seq)]);
        applyEvent(tx, decodeFn(s!), projectors);
      });

      const live = store.transaction((tx) => w3Snapshot(tx.raw as DatabaseSync));
      rebuildAll(store, projectors, decodeFn);
      const replayed = store.transaction((tx) => w3Snapshot(tx.raw as DatabaseSync));

      expect(replayed).toBe(live);
      // Guard against a vacuous pass — the request really was resolved AND viewed.
      expect(live).toContain('"kind":"actionable"');
      expect(live).toContain('"resolved":1');
      expect(live).toContain('"read":1');
    } finally {
      store.close();
    }
  });

  it('wrapping a send + markRead in assertRepoPristine does not throw (writes only to CO_DATA_DIR)', () => {
    const repo = makeRepo();
    const mail = openMailStore('p-w3-pristine');
    try {
      const viewed = assertRepoPristine(repo, () => {
        const d = mail.send({
          type: MAIL_CLARIFY_REQUEST,
          to: 'lead',
          from: 'worker',
          subject: 's',
          body: 'b',
        });
        return mail.markRead('lead', d.seq);
      });
      expect(viewed.read).toBe(true);
      expect(mail.outstandingCount('lead')).toBe(1); // viewed, but still pending (un-loseable)
    } finally {
      mail.close();
    }
  });
});
