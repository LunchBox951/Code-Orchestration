import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openProjectStore } from '../store/sqlite-store.js';
import {
  MAIL_CHAT,
  MAIL_CLARIFY_REQUEST,
  MAIL_ESCALATION,
  type DeliveredMail,
  type MailEnvelope,
} from './events.js';
import { MailProjector } from './mail-projector.js';
import {
  InProcessDelivery,
  LiveDelivery,
  type Delivery,
  type LiveDeliveryOptions,
} from './delivery.js';
import { openMailStore } from './mail-store.js';

// ── Program-data dir per test (mirrors mail.test.ts) ──────────────────────────
const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];

function useDataDir(): void {
  const dir = mkdtempSync(join(tmpdir(), 'co-live-delivery-'));
  dataDirs.push(dir);
  process.env.CO_DATA_DIR = dir;
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

/** Capture the injected wake / inject seams so each test can assert exactly when they fire. */
interface Seams extends LiveDeliveryOptions {
  readonly wakeCalls: string[];
  readonly injectCalls: Array<{ recipient: string; mail: DeliveredMail }>;
  readonly wakeFailures: Array<{ recipient: string; mail: DeliveredMail; error: unknown }>;
  readonly injectFailures: Array<{ recipient: string; mail: DeliveredMail; error: unknown }>;
}
function makeSeams(): Seams {
  const wakeCalls: string[] = [];
  const injectCalls: Array<{ recipient: string; mail: DeliveredMail }> = [];
  const wakeFailures: Array<{ recipient: string; mail: DeliveredMail; error: unknown }> = [];
  const injectFailures: Array<{ recipient: string; mail: DeliveredMail; error: unknown }> = [];
  return {
    wakeCalls,
    injectCalls,
    wakeFailures,
    injectFailures,
    wake: (recipient) => wakeCalls.push(recipient),
    injectToRecipient: (recipient, mail) => {
      injectCalls.push({ recipient, mail });
    },
    onWakeFailure: (recipient, mail, error) => wakeFailures.push({ recipient, mail, error }),
    onInjectFailure: (recipient, mail, error) => injectFailures.push({ recipient, mail, error }),
  };
}

const tick = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));
const flush = async (): Promise<void> => {
  await tick();
  await tick();
};

const ACTIONABLE: MailEnvelope = {
  type: MAIL_CLARIFY_REQUEST, // actionable in the kind registry
  to: 'bob',
  from: 'alice',
  subject: 'need a decision',
  body: 'which provider?',
};
const INFORMATIONAL: MailEnvelope = {
  type: MAIL_CHAT, // informational in the kind registry
  to: 'bob',
  from: 'alice',
  subject: 'fyi',
  body: 'just so you know',
};

describe('LiveDelivery — deliver persists (delegation) + wakes + injects actionable only', () => {
  it('deliver of an ACTIONABLE mail: persists, wakes once, injects once', () => {
    const store = openProjectStore('p-live-actionable');
    const seams = makeSeams();
    // Typed as Delivery to make the drop-in-Delivery shape explicit (review #185): LiveDelivery is a
    // drop-in for the Delivery seam, so L7 can swap in the Conductor-side writer without bus changes.
    const delivery: Delivery = new LiveDelivery(
      'p-live-actionable',
      store,
      [new MailProjector()],
      seams,
    );
    const mail = openMailStore('p-live-actionable', { delivery });
    try {
      const delivered = mail.send(ACTIONABLE);

      // (1) persisted Conductor-side — visible in the recipient inbox, same as InProcessDelivery.
      const inbox = mail.inbox('bob');
      expect(inbox).toHaveLength(1);
      expect(inbox[0]!.subject).toBe('need a decision');
      expect(inbox[0]!.kind).toBe('actionable');

      // (2) woke the recipient exactly once.
      expect(seams.wakeCalls).toEqual(['bob']);

      // (3) injected the unread actionable item exactly once, with the persisted row.
      expect(seams.injectCalls).toHaveLength(1);
      expect(seams.injectCalls[0]!.recipient).toBe('bob');
      expect(seams.injectCalls[0]!.mail).toEqual(delivered);
    } finally {
      mail.close();
      store.close();
    }
  });

  it('deliver of an INFORMATIONAL mail: persists + wakes, but does NOT inject', () => {
    const store = openProjectStore('p-live-informational');
    const seams = makeSeams();
    const delivery = new LiveDelivery('p-live-informational', store, [new MailProjector()], seams);
    const mail = openMailStore('p-live-informational', { delivery });
    try {
      mail.send(INFORMATIONAL);

      expect(mail.inbox('bob')).toHaveLength(1);
      expect(mail.inbox('bob')[0]!.kind).toBe('informational');
      expect(seams.wakeCalls).toEqual(['bob']); // still woken
      expect(seams.injectCalls).toEqual([]); // informational is never injected
    } finally {
      mail.close();
      store.close();
    }
  });

  it('does not wake or inject again when an idempotent retry returns the existing row', () => {
    const store = openProjectStore('p-live-idempotent-retry');
    const seams = makeSeams();
    const delivery = new LiveDelivery(
      'p-live-idempotent-retry',
      store,
      [new MailProjector()],
      seams,
    );
    const mail = openMailStore('p-live-idempotent-retry', { delivery });
    try {
      const envelope = { ...ACTIONABLE, idempotencyKey: 'clarify:once' };

      const first = mail.send(envelope);
      const second = mail.send(envelope);

      expect(second.seq).toBe(first.seq);
      expect(mail.inbox('bob')).toHaveLength(1);
      expect(seams.wakeCalls).toEqual(['bob']);
      expect(seams.injectCalls).toHaveLength(1);
      expect(seams.injectCalls[0]!.mail).toEqual(first);
    } finally {
      mail.close();
      store.close();
    }
  });

  it('retries wake and injection on an idempotent retry after wake failed post-persist', () => {
    const store = openProjectStore('p-live-idempotent-wake-retry');
    const wakeFailures: Array<{ recipient: string; mail: DeliveredMail; error: unknown }> = [];
    const injectCalls: Array<{ recipient: string; mail: DeliveredMail }> = [];
    let wakeAttempts = 0;
    const delivery = new LiveDelivery(
      'p-live-idempotent-wake-retry',
      store,
      [new MailProjector()],
      {
        wake: () => {
          wakeAttempts += 1;
          if (wakeAttempts === 1) throw new Error('wake failed');
        },
        injectToRecipient: (recipient, mail) => {
          injectCalls.push({ recipient, mail });
        },
        onWakeFailure: (recipient, mail, error) => wakeFailures.push({ recipient, mail, error }),
        onInjectFailure: () => {},
      },
    );
    const mail = openMailStore('p-live-idempotent-wake-retry', { delivery });
    try {
      const envelope = { ...ACTIONABLE, idempotencyKey: 'clarify:wake-once' };

      const first = mail.send(envelope);
      expect(wakeAttempts).toBe(1);
      expect(wakeFailures).toHaveLength(1);
      expect(injectCalls).toEqual([]);

      const second = mail.send(envelope);
      expect(second.seq).toBe(first.seq);
      expect(wakeAttempts).toBe(2);
      expect(wakeFailures).toHaveLength(1);
      expect(injectCalls).toHaveLength(1);
      expect(injectCalls[0]).toMatchObject({ recipient: 'bob', mail: first });
    } finally {
      mail.close();
      store.close();
    }
  });

  it('recovers live side effects for an existing idempotent mail in a new LiveDelivery instance', () => {
    const projectId = 'p-live-idempotent-new-instance';
    const seedStore = openProjectStore(projectId);
    const envelope = { ...ACTIONABLE, idempotencyKey: 'clarify:after-restart' };
    let seeded: DeliveredMail;
    try {
      seeded = new InProcessDelivery(projectId, seedStore, [new MailProjector()]).deliver(envelope);
    } finally {
      seedStore.close();
    }

    const liveStore = openProjectStore(projectId);
    const seams = makeSeams();
    const delivery = new LiveDelivery(projectId, liveStore, [new MailProjector()], seams);
    try {
      const delivered = delivery.deliver(envelope);

      expect(delivered.seq).toBe(seeded!.seq);
      expect(seams.wakeCalls).toEqual(['bob']);
      expect(seams.injectCalls).toHaveLength(1);
      expect(seams.injectCalls[0]!.mail).toEqual(seeded!);
    } finally {
      liveStore.close();
    }
  });

  it('does not repeat live side effects in a new LiveDelivery instance after durable ack', () => {
    const projectId = 'p-live-idempotent-new-instance-acked';
    const envelope = { ...ACTIONABLE, idempotencyKey: 'clarify:after-success' };
    let first: DeliveredMail;
    const firstStore = openProjectStore(projectId);
    const firstSeams = makeSeams();
    try {
      const firstDelivery = new LiveDelivery(
        projectId,
        firstStore,
        [new MailProjector()],
        firstSeams,
      );
      first = firstDelivery.deliver(envelope);
      expect(firstSeams.wakeCalls).toEqual(['bob']);
      expect(firstSeams.injectCalls).toHaveLength(1);
    } finally {
      firstStore.close();
    }

    const secondStore = openProjectStore(projectId);
    const secondSeams = makeSeams();
    try {
      const secondDelivery = new LiveDelivery(
        projectId,
        secondStore,
        [new MailProjector()],
        secondSeams,
      );
      const second = secondDelivery.deliver(envelope);

      expect(second.seq).toBe(first!.seq);
      expect(secondSeams.wakeCalls).toEqual([]);
      expect(secondSeams.injectCalls).toEqual([]);
    } finally {
      secondStore.close();
    }
  });

  it('reports async injection rejection instead of dropping it after wake', async () => {
    const store = openProjectStore('p-live-inject-fail');
    const failures: Array<{ recipient: string; mail: DeliveredMail; error: unknown }> = [];
    const delivery = new LiveDelivery('p-live-inject-fail', store, [new MailProjector()], {
      wake: () => {},
      injectToRecipient: async () => {
        throw new Error('inject failed');
      },
      onWakeFailure: () => {},
      onInjectFailure: (recipient, mail, error) => failures.push({ recipient, mail, error }),
    });
    const mail = openMailStore('p-live-inject-fail', { delivery });
    try {
      const delivered = mail.send(ACTIONABLE);
      await tick();

      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ recipient: 'bob', mail: delivered });
      expect(failures[0]!.error).toBeInstanceOf(Error);
      expect((failures[0]!.error as Error).message).toBe('inject failed');
    } finally {
      mail.close();
      store.close();
    }
  });

  it('serializes async injections per recipient and continues after a rejection', async () => {
    const store = openProjectStore('p-live-inject-serial');
    const calls: Array<{ recipient: string; mail: DeliveredMail }> = [];
    const failures: Array<{ recipient: string; mail: DeliveredMail; error: unknown }> = [];
    let rejectFirst!: (error: unknown) => void;
    let resolveSecond!: () => void;
    const delivery = new LiveDelivery('p-live-inject-serial', store, [new MailProjector()], {
      wake: () => {},
      injectToRecipient: (recipient, mail) => {
        calls.push({ recipient, mail });
        if (calls.length === 1) {
          return new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          });
        }
        return new Promise<void>((resolve) => {
          resolveSecond = resolve;
        });
      },
      onWakeFailure: () => {},
      onInjectFailure: (recipient, mail, error) => failures.push({ recipient, mail, error }),
    });
    const mail = openMailStore('p-live-inject-serial', { delivery });
    try {
      const first = mail.send(ACTIONABLE);
      await flush();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ recipient: 'bob', mail: first });

      const second = mail.send({ ...ACTIONABLE, subject: 'second question' });
      await flush();
      expect(calls).toHaveLength(1);

      rejectFirst(new Error('first inject failed'));
      await flush();
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ recipient: 'bob', mail: first });
      expect(calls).toHaveLength(2);
      expect(calls[1]).toMatchObject({ recipient: 'bob', mail: second });

      resolveSecond();
      await flush();
      expect(failures).toHaveLength(1);
    } finally {
      mail.close();
      store.close();
    }
  });
});

describe('LiveDelivery — receipts persist only (no wake, no injection)', () => {
  it('markRead: persists the read-receipt, does not wake or inject', () => {
    const store = openProjectStore('p-live-markread');
    const seams = makeSeams();
    const delivery = new LiveDelivery('p-live-markread', store, [new MailProjector()], seams);
    const mail = openMailStore('p-live-markread', { delivery });
    try {
      const delivered = mail.send(INFORMATIONAL); // seed a mail to read
      // Reset the seam captures so we observe ONLY the markRead's effects.
      seams.wakeCalls.length = 0;
      seams.injectCalls.length = 0;

      const updated = delivery.markRead!('bob', delivered.seq);

      expect(updated.read).toBe(true); // persisted (read-state folded)
      expect(seams.wakeCalls).toEqual([]); // no wake
      expect(seams.injectCalls).toEqual([]); // no injection
    } finally {
      mail.close();
      store.close();
    }
  });

  it('retract: persists the tombstone, does not wake or inject', () => {
    const store = openProjectStore('p-live-retract');
    const seams = makeSeams();
    const delivery = new LiveDelivery('p-live-retract', store, [new MailProjector()], seams);
    const mail = openMailStore('p-live-retract', { delivery });
    try {
      const delivered = mail.send(ACTIONABLE); // seed a mail to retract (sent by alice)
      seams.wakeCalls.length = 0;
      seams.injectCalls.length = 0;

      const updated = delivery.retract!('alice', delivered.seq);

      expect(updated.retracted).toBe(true); // persisted (tombstone folded)
      expect(mail.inbox('bob')).toEqual([]); // dropped from the recipient inbox
      expect(seams.wakeCalls).toEqual([]); // no wake
      expect(seams.injectCalls).toEqual([]); // no injection
    } finally {
      mail.close();
      store.close();
    }
  });
});

describe('LiveDelivery — persistence parity with InProcessDelivery (delegation, not divergence)', () => {
  it('deliver yields the same inbox row as InProcessDelivery for the same envelope', () => {
    const liveStore = openProjectStore('p-parity-live');
    const inprocStore = openProjectStore('p-parity-inproc');
    const seams = makeSeams();
    const live = new LiveDelivery('p-parity-live', liveStore, [new MailProjector()], seams);
    const inproc = new InProcessDelivery('p-parity-inproc', inprocStore, [new MailProjector()]);
    try {
      const liveRow = live.deliver(ACTIONABLE);
      const inprocRow = inproc.deliver(ACTIONABLE);

      // `ts` is the wall-clock append time (so it differs between the two appends); normalize it to a
      // constant so the comparison is over the actual inbox-row content — proving LiveDelivery
      // delegates rather than diverging. (seq is the first mail event in each fresh store, so it
      // matches too.)
      const normalize = (m: DeliveredMail): DeliveredMail => ({ ...m, ts: 0 });
      expect(normalize(liveRow)).toEqual(normalize(inprocRow));
    } finally {
      liveStore.close();
      inprocStore.close();
    }
  });
});

describe('LiveDelivery — forward + resolve wake/inject every new-item recipient (incl. relays)', () => {
  it('forward of an escalation: persists, wakes the up-chain recipient, injects (actionable)', () => {
    const store = openProjectStore('p-live-forward');
    const seams = makeSeams();
    const delivery = new LiveDelivery('p-live-forward', store, [new MailProjector()], seams);
    const mail = openMailStore('p-live-forward', { delivery });
    try {
      // A held escalation the holder ('lead') must forward up to 'coord'.
      const held = mail.send({
        type: MAIL_ESCALATION,
        to: 'lead',
        from: 'impl',
        subject: 'esc',
        body: 'help',
      });
      // Reset captures so we observe ONLY the forward (the held deliver already woke 'lead').
      seams.wakeCalls.length = 0;
      seams.injectCalls.length = 0;

      const thread = held.correlationId ?? String(held.seq);
      const forwarded = delivery.forward!(held, {
        type: MAIL_ESCALATION,
        to: 'coord',
        from: 'lead', // = held.recipient (assertForwardEnvelope)
        subject: 'esc',
        body: 'help',
        causationId: String(held.seq),
        correlationId: thread,
      });

      expect(forwarded.recipient).toBe('coord');
      expect(forwarded.kind).toBe('actionable');
      expect(seams.wakeCalls).toEqual(['coord']); // woke the up-chain recipient
      expect(seams.injectCalls).toHaveLength(1); // an actionable escalation is injected
      expect(seams.injectCalls[0]!.recipient).toBe('coord');
      expect(seams.injectCalls[0]!.mail).toEqual(forwarded);
    } finally {
      mail.close();
      store.close();
    }
  });

  it('resolve of an escalation: wakes the response recipient AND every relay; injects actionable relays only', () => {
    const store = openProjectStore('p-live-resolve');
    const seams = makeSeams();
    const delivery = new LiveDelivery('p-live-resolve', store, [new MailProjector()], seams);
    const mail = openMailStore('p-live-resolve', { delivery });
    try {
      const held = mail.send({
        type: MAIL_ESCALATION,
        to: 'lead',
        from: 'impl',
        subject: 'esc',
        body: 'help',
      });
      seams.wakeCalls.length = 0;
      seams.injectCalls.length = 0;

      const thread = held.correlationId ?? String(held.seq);
      // Informational answer back to the escalation's sender ('impl'), plus two relays flowing down:
      // an ACTIONABLE clarify to 'carol' (must be injected) and an INFORMATIONAL note to 'dave' (wake only).
      const response: MailEnvelope = {
        type: MAIL_CHAT,
        to: 'impl', // = held.sender (assertResolutionEnvelope)
        from: 'lead', // = held.recipient
        subject: 're: esc',
        body: 'do X',
        causationId: String(held.seq),
        correlationId: thread,
      };
      const actionableRelay: MailEnvelope = {
        type: MAIL_CLARIFY_REQUEST,
        to: 'carol',
        from: 'lead',
        subject: 'relay-q',
        body: 'please confirm',
        causationId: String(held.seq),
        correlationId: thread,
      };
      const infoRelay: MailEnvelope = {
        type: MAIL_CHAT,
        to: 'dave',
        from: 'lead',
        subject: 'relay-fyi',
        body: 'for your awareness',
        causationId: String(held.seq),
        correlationId: thread,
      };

      const resolved = delivery.resolve!(held, response, [actionableRelay, infoRelay]);

      expect(resolved.recipient).toBe('impl');
      // Duty 2: every new-item recipient is woken — the response AND each relay (the relay-wake gap, #193).
      expect(seams.wakeCalls).toEqual(['impl', 'carol', 'dave']);
      // Duty 3: inject only the outstanding-actionable items — the clarify relay, NOT the informational
      // response or the informational relay.
      expect(seams.injectCalls).toHaveLength(1);
      expect(seams.injectCalls[0]!.recipient).toBe('carol');
      expect(seams.injectCalls[0]!.mail.kind).toBe('actionable');
      expect(seams.injectCalls[0]!.mail.subject).toBe('relay-q');
    } finally {
      mail.close();
      store.close();
    }
  });
});
