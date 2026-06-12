import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openProjectStore } from '../store/sqlite-store.js';
import {
  MAIL_CHAT,
  MAIL_CLARIFY_REQUEST,
  type DeliveredMail,
  type MailEnvelope,
} from './events.js';
import { MailProjector } from './mail-projector.js';
import { InProcessDelivery, LiveDelivery, type LiveDeliveryOptions } from './delivery.js';
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
}
function makeSeams(): Seams {
  const wakeCalls: string[] = [];
  const injectCalls: Array<{ recipient: string; mail: DeliveredMail }> = [];
  return {
    wakeCalls,
    injectCalls,
    wake: (recipient) => wakeCalls.push(recipient),
    injectToRecipient: (recipient, mail) => injectCalls.push({ recipient, mail }),
  };
}

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
    const delivery = new LiveDelivery('p-live-actionable', store, [new MailProjector()], seams);
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
