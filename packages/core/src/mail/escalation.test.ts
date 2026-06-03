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
  OPERATOR,
  MAIL_CHAT,
  MAIL_APPROVAL,
  MAIL_CLARIFY_REQUEST,
  MAIL_CLARIFY_RESPONSE,
  MAIL_ESCALATION,
  mailKind,
  completionPredicate,
  makeMailEvent,
  makeMailForwardEvent,
  mailUpcasters,
  mailSchemas,
  type DeliveredMail,
  type MailEnvelope,
} from './events.js';
import { MailProjector } from './mail-projector.js';
import { openMailStore } from './mail-store.js';
import { InProcessDelivery, type Delivery } from './delivery.js';
import {
  prototypeParentResolver,
  escalate,
  forwardEscalation,
  resolveEscalation,
  forwardOnTimeout,
  waitingItems,
  isAwaitingReply,
  CLARIFY_TIMEOUT_SECONDS_KEY,
  CLARIFY_TIMEOUT_SECONDS_DEFAULT,
  CLARIFY_TIMEOUT_POLICY,
} from './escalation.js';

// ── Program-data dir per test (mirrors mail.test.ts) ──────────────────────────
const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let repoDirs: string[] = [];

function useDataDir(): void {
  const dir = mkdtempSync(join(tmpdir(), 'co-esc-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'co-esc-repo-'));
  repoDirs.push(dir);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}

/** Drop + re-fold the WHOLE log into a fresh read-model — the replay path (chain/waiting are log-derived). */
function rebuildOf(projectId: string): void {
  const store = openProjectStore(projectId);
  try {
    rebuildAll(store, [new MailProjector()], (e) => decode(e, mailUpcasters, mailSchemas));
  } finally {
    store.close();
  }
}

/** The chain the prototype resolver double exercises. */
const CHAIN = { implementer: 'impl-1', lead: 'lead-1', coordinator: 'coord-1' } as const;

describe('AC-L1-6 — registries lit up for escalation (registered, not switched)', () => {
  it('escalation is actionable with a resolve-or-forward predicate (registered generically)', () => {
    expect(mailKind(MAIL_ESCALATION)).toBe('actionable');
    expect(completionPredicate(MAIL_ESCALATION)).toBeTypeOf('function');
  });

  it('the predicate resolves only holder replies down; forward-up is folded by a forward receipt', () => {
    const pred = completionPredicate(MAIL_ESCALATION)!;
    const held = { seq: 7, recipient: 'lead-1', sender: 'impl-1' } as DeliveredMail;
    // A raw escalation, even from the holder, is not enough: forward-up must pass through
    // the forward seam so the projector sees a replayed forward receipt.
    expect(
      pred(held, {
        sender: 'lead-1',
        recipient: 'coord-1',
        type: MAIL_ESCALATION,
        causationId: '7',
      } as DeliveredMail),
    ).toBe(false);
    // The holder resolves it DOWN to the original asker → discharged.
    expect(
      pred(held, {
        sender: 'lead-1',
        recipient: 'impl-1',
        type: MAIL_CHAT,
        correlationId: '7',
        causationId: '7',
      } as DeliveredMail),
    ).toBe(true);
    // The holder sending unrelated caused mail is NOT resolve-or-forward.
    expect(
      pred(held, {
        sender: 'lead-1',
        recipient: 'auditor',
        type: MAIL_CHAT,
        correlationId: '7',
        causationId: '7',
      } as DeliveredMail),
    ).toBe(false);
    // A non-holder acting in-thread does NOT discharge it.
    expect(
      pred(held, {
        sender: 'someone-else',
        recipient: 'impl-1',
        type: MAIL_CHAT,
        correlationId: '7',
        causationId: '7',
      } as DeliveredMail),
    ).toBe(false);
    // The holder referencing a DIFFERENT item does NOT discharge it.
    expect(
      pred(held, {
        sender: 'lead-1',
        recipient: 'impl-1',
        type: MAIL_CHAT,
        correlationId: '7',
        causationId: '99',
      } as DeliveredMail),
    ).toBe(false);
  });
});

describe('AC-L1-6 — the parent-resolver seam + structural coordinator→@operator (freeze #5)', () => {
  it('resolves the full chain implementer → lead → coordinator → @operator', () => {
    const r = prototypeParentResolver(CHAIN);
    expect(r.parentOf(CHAIN.implementer)).toBe(CHAIN.lead);
    expect(r.parentOf(CHAIN.lead)).toBe(CHAIN.coordinator);
    expect(r.parentOf(CHAIN.coordinator)).toBe(OPERATOR);
  });

  it('a coordinator ALWAYS resolves to @operator (cannot be misconfigured to a peer)', () => {
    // Even if a caller tries to also name the coordinator as some other agent's parent, the
    // coordinator id itself is forced to @operator structurally.
    const r = prototypeParentResolver({
      implementer: 'i',
      lead: 'coord-1',
      coordinator: 'coord-1',
    });
    expect(r.parentOf('coord-1')).toBe(OPERATOR);
  });

  it('the operator is the top of the chain — asking for its parent fails loud', () => {
    const r = prototypeParentResolver(CHAIN);
    expect(() => r.parentOf(OPERATOR)).toThrow(/top of the escalation chain/i);
  });

  it('an unknown id fails loud rather than guessing a parent', () => {
    const r = prototypeParentResolver(CHAIN);
    expect(() => r.parentOf('stranger')).toThrow(/no parent/i);
  });
});

describe('AC-L1-6 — the resolve-or-forward chain (every forward advances + shares one thread)', () => {
  it('implementer → lead → coordinator → @operator: each forward discharges + advances, one correlationId', () => {
    const resolver = prototypeParentResolver(CHAIN);
    const mail = openMailStore('p-esc-chain');
    try {
      // implementer raises to its lead.
      const e1 = escalate(mail, resolver, {
        from: CHAIN.implementer,
        subject: 'blocked: spec ambiguous',
        body: 'cannot proceed without a ruling',
      });
      expect(e1.recipient).toBe(CHAIN.lead);
      expect(e1.kind).toBe('actionable');
      expect(mail.outstandingCount(CHAIN.lead)).toBe(1);
      const thread = String(e1.seq); // the root seq is the thread id

      // lead forwards UP to the coordinator: e1 discharged, coordinator now holds e2.
      const leadHeld = mail.inbox(CHAIN.lead).find((m) => m.seq === e1.seq)!;
      const e2 = forwardEscalation(mail, resolver, leadHeld);
      expect(e2.recipient).toBe(CHAIN.coordinator);
      expect(e2.correlationId).toBe(thread); // reuses the thread
      expect(e2.causationId).toBe(String(e1.seq));
      expect(mail.outstandingCount(CHAIN.lead)).toBe(0); // e1 discharged
      expect(mail.outstandingCount(CHAIN.coordinator)).toBe(1); // chain advanced

      // coordinator forwards UP to @operator: e2 discharged, operator now holds e3.
      const coordHeld = mail.inbox(CHAIN.coordinator).find((m) => m.seq === e2.seq)!;
      const e3 = forwardEscalation(mail, resolver, coordHeld);
      expect(e3.recipient).toBe(OPERATOR); // coordinator → @operator (freeze #5)
      expect(e3.correlationId).toBe(thread); // STILL the same thread
      expect(e3.causationId).toBe(String(e2.seq));
      expect(mail.outstandingCount(CHAIN.coordinator)).toBe(0); // e2 discharged
      expect(mail.outstandingCount(OPERATOR)).toBe(1); // operator now holds it

      // The whole chain shares ONE thread; the coordinator's parent is @operator.
      for (const e of [e1, e2, e3]) {
        expect(e.correlationId ?? String(e.seq)).toBe(thread);
      }
      expect(resolver.parentOf(CHAIN.coordinator)).toBe(OPERATOR);

      // Only the top holder's item is outstanding — nothing was dropped along the way.
      expect(mail.outstandingCount(CHAIN.implementer)).toBe(0);
      expect(mail.outstandingCount(CHAIN.lead)).toBe(0);
      expect(mail.outstandingCount(CHAIN.coordinator)).toBe(0);
      expect(mail.outstanding(OPERATOR).map((m) => m.seq)).toEqual([e3.seq]);
    } finally {
      mail.close();
    }
  });

  it('a top-level answer to a multi-hop escalation flows back down every forwarded hop', () => {
    const resolver = prototypeParentResolver(CHAIN);
    const mail = openMailStore('p-esc-chain-answer');
    try {
      const e1 = escalate(mail, resolver, {
        from: CHAIN.implementer,
        subject: 'blocked',
        body: 'b',
      });
      const e2 = forwardEscalation(
        mail,
        resolver,
        mail.inbox(CHAIN.lead).find((m) => m.seq === e1.seq)!,
      );
      const e3 = forwardEscalation(
        mail,
        resolver,
        mail.inbox(CHAIN.coordinator).find((m) => m.seq === e2.seq)!,
      );

      resolveEscalation(mail, mail.inbox(OPERATOR).find((m) => m.seq === e3.seq)!, {
        subject: 're: blocked',
        body: 'use the approved path',
      });

      expect(mail.outstandingCount(OPERATOR)).toBe(0);
      expect(mail.inbox(CHAIN.coordinator)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sender: OPERATOR,
            recipient: CHAIN.coordinator,
            causationId: String(e3.seq),
            body: 'use the approved path',
          }),
        ]),
      );
      expect(mail.inbox(CHAIN.lead)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sender: CHAIN.coordinator,
            recipient: CHAIN.lead,
            causationId: String(e2.seq),
            body: 'use the approved path',
          }),
        ]),
      );
      expect(mail.inbox(CHAIN.implementer)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sender: CHAIN.lead,
            recipient: CHAIN.implementer,
            causationId: String(e1.seq),
            body: 'use the approved path',
          }),
        ]),
      );
    } finally {
      mail.close();
    }
  });

  it('the chain state is log-derived: it survives a rebuildAll', () => {
    const resolver = prototypeParentResolver(CHAIN);
    const seed = openMailStore('p-esc-chain-replay');
    try {
      const e1 = escalate(seed, resolver, { from: CHAIN.implementer, subject: 's', body: 'b' });
      const e2 = forwardEscalation(
        seed,
        resolver,
        seed.inbox(CHAIN.lead).find((m) => m.seq === e1.seq)!,
      );
      forwardEscalation(
        seed,
        resolver,
        seed.inbox(CHAIN.coordinator).find((m) => m.seq === e2.seq)!,
      );
    } finally {
      seed.close();
    }
    rebuildOf('p-esc-chain-replay');
    const mail = openMailStore('p-esc-chain-replay');
    try {
      // After rebuild: every below-top holder is clear and only @operator still holds it,
      // and the surviving item is the forwarded escalation (chain state is log-derived).
      expect(mail.outstandingCount(CHAIN.lead)).toBe(0);
      expect(mail.outstandingCount(CHAIN.coordinator)).toBe(0);
      const top = mail.outstanding(OPERATOR);
      expect(top).toHaveLength(1);
      expect(top[0]!.type).toBe(MAIL_ESCALATION);
    } finally {
      mail.close();
    }
  });
});

describe('AC-L1-6 — resolve-or-forward holds / sticky (never dropped)', () => {
  it('a held escalation stays outstanding until the holder acts; resolving DOWN clears it', () => {
    const resolver = prototypeParentResolver(CHAIN);
    const mail = openMailStore('p-esc-resolve');
    try {
      const e1 = escalate(mail, resolver, {
        from: CHAIN.implementer,
        subject: 'which approach?',
        body: 'A or B?',
      });
      expect(mail.outstandingCount(CHAIN.lead)).toBe(1);

      // Doing NOTHING leaves it outstanding (sticky / never dropped).
      expect(mail.outstanding(CHAIN.lead).map((m) => m.seq)).toEqual([e1.seq]);

      // The lead RESOLVES it down to the asker (in-thread). It discharges + flows back down.
      const held = mail.inbox(CHAIN.lead).find((m) => m.seq === e1.seq)!;
      const answer = resolveEscalation(mail, held, {
        subject: 're: which approach?',
        body: 'use A',
      });
      expect(answer.recipient).toBe(CHAIN.implementer); // the resolution reaches the asker
      expect(answer.type).toBe(MAIL_CHAT); // default carrier is informational
      expect(answer.correlationId).toBe(String(e1.seq)); // same thread
      expect(answer.causationId).toBe(String(e1.seq)); // caused by the escalation
      expect(mail.outstandingCount(CHAIN.lead)).toBe(0); // discharged by the holder's act
      expect(mail.inbox(CHAIN.lead).find((m) => m.seq === e1.seq)!.resolved).toBe(true);
    } finally {
      mail.close();
    }
  });

  it('an UNRELATED in-thread message from a non-holder never discharges it (only the holder can)', () => {
    const resolver = prototypeParentResolver(CHAIN);
    const mail = openMailStore('p-esc-sticky');
    try {
      const e1 = escalate(mail, resolver, { from: CHAIN.implementer, subject: 's', body: 'b' });
      // The asker chats in the same thread — NOT the holder, so the escalation stays outstanding.
      mail.send({
        type: MAIL_CHAT,
        to: CHAIN.lead,
        from: CHAIN.implementer,
        subject: 'fyi',
        body: 'still blocked',
        correlationId: String(e1.seq),
        causationId: String(e1.seq),
      });
      expect(mail.outstandingCount(CHAIN.lead)).toBe(1); // not dropped, not resolved
    } finally {
      mail.close();
    }
  });

  it('an unrelated caused message from the holder does not silently drop a held escalation', () => {
    const resolver = prototypeParentResolver(CHAIN);
    const mail = openMailStore('p-esc-holder-unrelated');
    try {
      const e1 = escalate(mail, resolver, { from: CHAIN.implementer, subject: 's', body: 'b' });
      mail.send({
        type: MAIL_CHAT,
        to: 'auditor',
        from: CHAIN.lead,
        subject: 'fyi',
        body: 'not a forward or answer',
        correlationId: String(e1.seq),
        causationId: String(e1.seq),
      });

      expect(mail.outstandingCount(CHAIN.lead)).toBe(1);
      expect(mail.inbox(CHAIN.lead).find((m) => m.seq === e1.seq)!.resolved).toBe(false);
    } finally {
      mail.close();
    }
  });

  it('a raw caused escalation from the holder does not discharge without the forward receipt', () => {
    const resolver = prototypeParentResolver(CHAIN);
    const mail = openMailStore('p-esc-raw-forward');
    try {
      const e1 = escalate(mail, resolver, { from: CHAIN.implementer, subject: 's', body: 'b' });
      mail.send({
        type: MAIL_ESCALATION,
        to: CHAIN.coordinator,
        from: CHAIN.lead,
        subject: 's',
        body: 'b',
        correlationId: String(e1.seq),
        causationId: String(e1.seq),
      });

      expect(mail.outstandingCount(CHAIN.lead)).toBe(1);
      expect(mail.outstandingCount(CHAIN.coordinator)).toBe(1);
      expect(mail.inbox(CHAIN.lead).find((m) => m.seq === e1.seq)!.resolved).toBe(false);
    } finally {
      mail.close();
    }
  });

  it('forwarding the same held item twice fails instead of duplicating parent obligations', () => {
    const resolver = prototypeParentResolver(CHAIN);
    const mail = openMailStore('p-esc-double-forward');
    try {
      const e1 = escalate(mail, resolver, { from: CHAIN.implementer, subject: 's', body: 'b' });
      const held = mail.inbox(CHAIN.lead).find((m) => m.seq === e1.seq)!;
      forwardEscalation(mail, resolver, held);

      expect(() => forwardEscalation(mail, resolver, held)).toThrow(/unresolved actionable/i);
      expect(mail.outstandingCount(CHAIN.lead)).toBe(0);
      expect(mail.outstandingCount(CHAIN.coordinator)).toBe(1);
    } finally {
      mail.close();
    }
  });

  it('a holder-sent escalation back to the requester is not a down-resolution', () => {
    const resolver = prototypeParentResolver(CHAIN);
    const mail = openMailStore('p-esc-down-punt');
    try {
      const e1 = escalate(mail, resolver, { from: CHAIN.implementer, subject: 's', body: 'b' });
      mail.send({
        type: MAIL_ESCALATION,
        to: CHAIN.implementer,
        from: CHAIN.lead,
        subject: 'still blocked',
        body: 'punted downward',
        correlationId: String(e1.seq),
        causationId: String(e1.seq),
      });

      expect(mail.outstandingCount(CHAIN.lead)).toBe(1);
      expect(mail.inbox(CHAIN.lead).find((m) => m.seq === e1.seq)!.resolved).toBe(false);
    } finally {
      mail.close();
    }
  });

  it('resolving a raw escalation caused by a clarify does not unblock the original asker', () => {
    const mail = openMailStore('p-esc-raw-clarify-relay');
    try {
      const req = mail.send({
        type: MAIL_CLARIFY_REQUEST,
        to: CHAIN.lead,
        from: CHAIN.implementer,
        subject: 'intent?',
        body: 'what did you mean?',
      });
      const raw = mail.send({
        type: MAIL_ESCALATION,
        to: CHAIN.coordinator,
        from: CHAIN.lead,
        subject: req.subject,
        body: req.body,
        correlationId: String(req.seq),
        causationId: String(req.seq),
      });

      resolveEscalation(mail, raw, {
        subject: 're: intent?',
        body: 'use the simpler interpretation',
      });

      expect(mail.outstandingCount(CHAIN.coordinator)).toBe(0);
      expect(mail.outstandingCount(CHAIN.lead)).toBe(1);
      expect(isAwaitingReply(mail, CHAIN.implementer)).toBe(true);
      expect(
        mail
          .inbox(CHAIN.implementer)
          .some((m) => m.type === MAIL_CLARIFY_RESPONSE && m.causationId === String(req.seq)),
      ).toBe(false);
    } finally {
      mail.close();
    }
  });

  it('resolveEscalation rejects escalation as a resolution carrier', () => {
    const resolver = prototypeParentResolver(CHAIN);
    const mail = openMailStore('p-esc-resolve-carrier');
    try {
      const e1 = escalate(mail, resolver, { from: CHAIN.implementer, subject: 's', body: 'b' });
      const held = mail.inbox(CHAIN.lead).find((m) => m.seq === e1.seq)!;

      expect(() =>
        resolveEscalation(mail, held, {
          type: MAIL_ESCALATION,
          subject: 'still blocked',
          body: 'this must use forwardEscalation',
        }),
      ).toThrow(/forwardEscalation/i);
      expect(mail.outstandingCount(CHAIN.lead)).toBe(1);
    } finally {
      mail.close();
    }
  });

  it('resolveEscalation rejects non-escalation and already-resolved handles', () => {
    const resolver = prototypeParentResolver(CHAIN);
    const mail = openMailStore('p-esc-resolve-invalid');
    try {
      const chat = mail.send({
        type: MAIL_CHAT,
        to: CHAIN.lead,
        from: CHAIN.implementer,
        subject: 'fyi',
        body: 'not actionable',
      });
      expect(() =>
        resolveEscalation(mail, chat, {
          subject: 're',
          body: 'no-op',
        }),
      ).toThrow(/unresolved persisted escalation/i);

      const e1 = escalate(mail, resolver, { from: CHAIN.implementer, subject: 's', body: 'b' });
      const held = mail.inbox(CHAIN.lead).find((m) => m.seq === e1.seq)!;
      resolveEscalation(mail, held, { subject: 're', body: 'answer' });

      expect(() =>
        resolveEscalation(mail, held, {
          subject: 're again',
          body: 'duplicate',
        }),
      ).toThrow(/unresolved persisted escalation/i);
    } finally {
      mail.close();
    }
  });
});

describe('AC-L1-6 — never-drop on a FAILED persist (the write throws; no silent success)', () => {
  /** A Delivery double whose deliver always throws (a failed persist). */
  const throwingDelivery: Delivery = {
    deliver(): DeliveredMail {
      throw new Error('disk full: persist failed');
    },
  };

  it('escalate THROWS when the underlying persist fails (never a silent drop)', () => {
    const resolver = prototypeParentResolver(CHAIN);
    const mail = openMailStore('p-esc-fail-raise', { delivery: throwingDelivery });
    try {
      expect(() =>
        escalate(mail, resolver, { from: CHAIN.implementer, subject: 's', body: 'b' }),
      ).toThrow(/persist failed/i);
    } finally {
      mail.close();
    }
  });

  it('forwardEscalation THROWS when the underlying persist fails (never a silent drop)', () => {
    const resolver = prototypeParentResolver(CHAIN);
    const mail = openMailStore('p-esc-fail-fwd', {
      delivery: {
        ...throwingDelivery,
        forward(): DeliveredMail {
          throw new Error('disk full: persist failed');
        },
      },
    });
    try {
      // A held escalation to forward (its prior persistence is irrelevant to this seam test).
      const held = {
        seq: 5,
        recipient: CHAIN.lead,
        sender: CHAIN.implementer,
        type: MAIL_ESCALATION,
        subject: 's',
        body: 'b',
        ts: 0,
      } as DeliveredMail;
      expect(() => forwardEscalation(mail, resolver, held)).toThrow(/persist failed/i);
    } finally {
      mail.close();
    }
  });
});

describe('AC-L1-6 — clarify-timeout policy = forward-up (POLICY only; firing is L7, no wall-clock)', () => {
  it('exposes the forward-up policy and the 1800s default', () => {
    expect(CLARIFY_TIMEOUT_POLICY).toBe('forward-up');
    expect(CLARIFY_TIMEOUT_SECONDS_DEFAULT).toBe(1800);
    expect(CLARIFY_TIMEOUT_SECONDS_KEY).toBe('clarify_timeout_seconds');
  });

  it('forwardOnTimeout forwards the unanswered item UP the chain (reuses the thread, no clock read)', () => {
    const resolver = prototypeParentResolver(CHAIN);
    const mail = openMailStore('p-esc-timeout');
    try {
      // A child raises a clarify_request to its lead; the lead never answers (it "times out").
      const req = mail.send({
        type: MAIL_CLARIFY_REQUEST,
        to: CHAIN.lead,
        from: CHAIN.implementer,
        subject: 'intent?',
        body: 'what did you mean?',
      });
      expect(mail.outstandingCount(CHAIN.lead)).toBe(1);

      // The policy fires (L7 would call this on expiry): forward the unanswered item UP.
      const held = mail.inbox(CHAIN.lead).find((m) => m.seq === req.seq)!;
      const forwarded = forwardOnTimeout(mail, resolver, held);
      expect(forwarded.type).toBe(MAIL_ESCALATION); // becomes an escalation up the chain
      expect(forwarded.recipient).toBe(CHAIN.coordinator); // the lead's parent
      expect(forwarded.correlationId).toBe(String(req.seq)); // same thread
      expect(forwarded.causationId).toBe(String(req.seq));
      expect(mail.outstandingCount(CHAIN.lead)).toBe(0); // the old holder forwarded it
      expect(mail.outstandingCount(CHAIN.coordinator)).toBe(1); // the higher level now owns it
      expect(isAwaitingReply(mail, CHAIN.implementer)).toBe(true); // no real answer flowed down yet
    } finally {
      mail.close();
    }
  });

  it('a higher-level answer to a timeout-forwarded clarify flows back to the original asker', () => {
    const resolver = prototypeParentResolver(CHAIN);
    const mail = openMailStore('p-esc-timeout-answer');
    try {
      const req = mail.send({
        type: MAIL_CLARIFY_REQUEST,
        to: CHAIN.lead,
        from: CHAIN.implementer,
        subject: 'intent?',
        body: 'what did you mean?',
      });
      const forwarded = forwardOnTimeout(
        mail,
        resolver,
        mail.inbox(CHAIN.lead).find((m) => m.seq === req.seq)!,
      );

      const heldByCoordinator = mail.inbox(CHAIN.coordinator).find((m) => m.seq === forwarded.seq)!;
      const down = resolveEscalation(mail, heldByCoordinator, {
        subject: 're: intent?',
        body: 'use the simpler interpretation',
      });

      expect(down.recipient).toBe(CHAIN.lead);
      expect(mail.outstandingCount(CHAIN.coordinator)).toBe(0);
      const answer = mail
        .inbox(CHAIN.implementer)
        .find((m) => m.type === MAIL_CLARIFY_RESPONSE && m.causationId === String(req.seq));
      expect(answer).toMatchObject({
        sender: CHAIN.lead,
        recipient: CHAIN.implementer,
        correlationId: String(req.seq),
        body: 'use the simpler interpretation',
      });
      expect(isAwaitingReply(mail, CHAIN.implementer)).toBe(false);
    } finally {
      mail.close();
    }
  });

  it('a relay failure while answering a timeout-forwarded clarify rolls back the down-answer', () => {
    const resolver = prototypeParentResolver(CHAIN);
    const projectId = 'p-esc-timeout-relay-fail';
    const store = openProjectStore(projectId);
    const projectors: Projector[] = [new MailProjector()];
    const inner = new InProcessDelivery(projectId, store, projectors);
    const delivery: Delivery = {
      deliver(envelope) {
        if (envelope.type === MAIL_CLARIFY_RESPONSE) {
          throw new Error('relay persist failed');
        }
        return inner.deliver(envelope);
      },
      forward(held, envelope) {
        return inner.forward(held, envelope);
      },
      resolve(_held, envelope, relays) {
        return store.transaction((tx) => {
          const [stored] = tx.append([makeMailEvent(projectId, envelope)]);
          applyEvent(tx, decode(stored!, mailUpcasters, mailSchemas), projectors);
          if ((relays ?? []).length > 0) {
            throw new Error('relay persist failed');
          }
          throw new Error('test expected a relay');
        });
      },
      markRead(recipient, seq) {
        return inner.markRead(recipient, seq);
      },
    };
    const mail = openMailStore(projectId, { delivery });
    try {
      const req = mail.send({
        type: MAIL_CLARIFY_REQUEST,
        to: CHAIN.lead,
        from: CHAIN.implementer,
        subject: 'intent?',
        body: 'what did you mean?',
      });
      const forwarded = forwardOnTimeout(
        mail,
        resolver,
        mail.inbox(CHAIN.lead).find((m) => m.seq === req.seq)!,
      );
      const heldByCoordinator = mail.inbox(CHAIN.coordinator).find((m) => m.seq === forwarded.seq)!;

      expect(() =>
        resolveEscalation(mail, heldByCoordinator, {
          subject: 're: intent?',
          body: 'use the simpler interpretation',
        }),
      ).toThrow(/relay persist failed/i);

      expect(mail.outstandingCount(CHAIN.coordinator)).toBe(1);
      expect(mail.outstandingCount(CHAIN.lead)).toBe(0);
      expect(isAwaitingReply(mail, CHAIN.implementer)).toBe(true);
      expect(
        mail
          .inbox(CHAIN.lead)
          .some((m) => m.sender === CHAIN.coordinator && m.causationId === String(forwarded.seq)),
      ).toBe(false);
      expect(
        mail
          .inbox(CHAIN.implementer)
          .some((m) => m.type === MAIL_CLARIFY_RESPONSE && m.causationId === String(req.seq)),
      ).toBe(false);
    } finally {
      mail.close();
      store.close();
    }
  });
});

describe('AC-L1-6 — threaded brainstorm + never-guess + asker-blocked (WAITING)', () => {
  it('a child blocks (isAwaitingReply) on a clarify it raised; the parent answer threads and unblocks it', () => {
    const mail = openMailStore('p-esc-brainstorm');
    let reqSeq = -1;
    try {
      // The child is uncertain on intent → it RAISES a clarify rather than guessing (never-guess).
      const req = mail.send({
        type: MAIL_CLARIFY_REQUEST,
        to: CHAIN.lead,
        from: CHAIN.implementer,
        subject: 'intent?',
        body: 'spec says X — does that include Y?',
      });
      reqSeq = req.seq;

      // The asker is WAITING (blocked) while its raised clarify is unresolved.
      expect(isAwaitingReply(mail, CHAIN.implementer)).toBe(true);
      expect(waitingItems(mail, CHAIN.implementer).map((m) => m.seq)).toEqual([req.seq]);
      // The parent is NOT awaiting — it did not raise the clarify, it holds it.
      expect(isAwaitingReply(mail, CHAIN.lead)).toBe(false);

      // The parent answers in-thread (the threaded brainstorm); the answer threads correctly.
      const held = mail.inbox(CHAIN.lead).find((m) => m.seq === req.seq)!;
      const resp = mail.reply(held, {
        type: MAIL_CLARIFY_RESPONSE,
        subject: 're: intent?',
        body: 'yes, Y is included',
      });
      expect(resp.correlationId).toBe(String(req.seq)); // same thread (freeze #7)
      expect(resp.causationId).toBe(String(req.seq)); // answers the request

      // The child is no longer awaiting — the clarify it raised is resolved.
      expect(isAwaitingReply(mail, CHAIN.implementer)).toBe(false);
      expect(waitingItems(mail, CHAIN.implementer)).toEqual([]);
    } finally {
      mail.close();
    }

    // The blocked/awaiting state is log-derived: it reproduces across a rebuild.
    rebuildOf('p-esc-brainstorm');
    const m = openMailStore('p-esc-brainstorm');
    try {
      expect(isAwaitingReply(m, CHAIN.implementer)).toBe(false);
      expect(m.inbox(CHAIN.lead).find((x) => x.seq === reqSeq)!.resolved).toBe(true);
    } finally {
      m.close();
    }
  });

  it('an unanswered clarify keeps the asker WAITING across a rebuild (un-loseable)', () => {
    const mail = openMailStore('p-esc-waiting-replay');
    try {
      mail.send({
        type: MAIL_CLARIFY_REQUEST,
        to: CHAIN.lead,
        from: CHAIN.implementer,
        subject: 'q',
        body: '?',
      });
      expect(isAwaitingReply(mail, CHAIN.implementer)).toBe(true);
    } finally {
      mail.close();
    }
    rebuildOf('p-esc-waiting-replay');
    const m = openMailStore('p-esc-waiting-replay');
    try {
      expect(isAwaitingReply(m, CHAIN.implementer)).toBe(true); // still blocked — never lost
    } finally {
      m.close();
    }
  });

  it('an off-thread clarify_response does not wake the original asker', () => {
    const mail = openMailStore('p-esc-wrong-thread-answer');
    try {
      const req = mail.send({
        type: MAIL_CLARIFY_REQUEST,
        to: CHAIN.lead,
        from: CHAIN.implementer,
        subject: 'q',
        body: '?',
      });
      mail.send({
        type: MAIL_CLARIFY_RESPONSE,
        to: CHAIN.implementer,
        from: CHAIN.lead,
        subject: 'off-thread',
        body: 'not the answer',
        correlationId: 'wrong-thread',
        causationId: String(req.seq),
      });

      expect(mail.inbox(CHAIN.lead).find((m) => m.seq === req.seq)!.resolved).toBe(false);
      expect(isAwaitingReply(mail, CHAIN.implementer)).toBe(true);
    } finally {
      mail.close();
    }
  });
});

describe('AC-L1-9 — L0 preserved + pristine (escalation/forward events)', () => {
  function escSnapshot(db: DatabaseSync): string {
    return JSON.stringify(
      db
        .prepare(
          'SELECT seq, recipient, sender, type, subject, body, correlation_id, causation_id, idempotency_key, ts, kind, read, resolved, thread_id, decision FROM inbox ORDER BY seq',
        )
        .all(),
    );
  }

  it('an escalate + forward chain rebuilds byte-identical (incl. resolved + thread_id)', () => {
    const PID = 'p-esc-bytes';
    const store = openProjectStore(PID);
    const projectors: Projector[] = [new MailProjector()];
    const decodeFn = (e: StoredEvent): StoredEvent => decode(e, mailUpcasters, mailSchemas);

    try {
      // root escalation (implementer → lead) …
      const e1 = store.transaction((tx) => {
        const [s] = tx.append([
          makeMailEvent(PID, {
            type: MAIL_ESCALATION,
            to: CHAIN.lead,
            from: CHAIN.implementer,
            subject: 'blocked',
            body: 'help',
          }),
        ]);
        applyEvent(tx, decodeFn(s!), projectors);
        return s!;
      });
      // … forwarded UP (lead → coordinator), reusing the thread + causation = e1.seq.
      store.transaction((tx) => {
        const [s] = tx.append([
          makeMailEvent(PID, {
            type: MAIL_ESCALATION,
            to: CHAIN.coordinator,
            from: CHAIN.lead,
            subject: 'blocked',
            body: 'help',
            correlationId: String(e1.seq),
            causationId: String(e1.seq),
          }),
        ]);
        applyEvent(tx, decodeFn(s!), projectors);
      });
      store.transaction((tx) => {
        const [s] = tx.append([makeMailForwardEvent(PID, CHAIN.lead, e1.seq, CHAIN.coordinator)]);
        applyEvent(tx, decodeFn(s!), projectors);
      });

      const live = store.transaction((tx) => escSnapshot(tx.raw as DatabaseSync));
      rebuildAll(store, projectors, decodeFn);
      const replayed = store.transaction((tx) => escSnapshot(tx.raw as DatabaseSync));

      expect(replayed).toBe(live);
      // Guard against a vacuous pass — the forward really discharged the root escalation.
      expect(live).toContain('"type":"escalation"');
      expect(live).toContain('"resolved":1');
    } finally {
      store.close();
    }
  });

  it('a forward receipt for a non-forwardable approval fails loud during projection', () => {
    const PID = 'p-esc-forward-receipt-approval';
    const store = openProjectStore(PID);
    const projectors: Projector[] = [new MailProjector()];
    const decodeFn = (e: StoredEvent): StoredEvent => decode(e, mailUpcasters, mailSchemas);

    try {
      const approval = store.transaction((tx) => {
        const [s] = tx.append([
          makeMailEvent(PID, {
            type: MAIL_APPROVAL,
            to: OPERATOR,
            from: CHAIN.implementer,
            subject: 'approve outward?',
            body: 'public action',
          }),
        ]);
        applyEvent(tx, decodeFn(s!), projectors);
        return s!;
      });

      expect(() =>
        store.transaction((tx) => {
          const [s] = tx.append([
            makeMailForwardEvent(PID, OPERATOR, approval.seq, CHAIN.coordinator),
          ]);
          applyEvent(tx, decodeFn(s!), projectors);
        }),
      ).toThrow(/cannot forward.*approval/i);

      const row = store.transaction(
        (tx) =>
          (tx.raw as DatabaseSync)
            .prepare('SELECT resolved FROM inbox WHERE seq = ?')
            .get(approval.seq) as { resolved: number },
      );
      expect(row.resolved).toBe(0);
    } finally {
      store.close();
    }
  });

  it('a wrong-thread forward receipt fails loud and does not resolve the held item', () => {
    const PID = 'p-esc-forward-receipt-thread';
    const store = openProjectStore(PID);
    const projectors: Projector[] = [new MailProjector()];
    const decodeFn = (e: StoredEvent): StoredEvent => decode(e, mailUpcasters, mailSchemas);

    try {
      const e1 = store.transaction((tx) => {
        const [s] = tx.append([
          makeMailEvent(PID, {
            type: MAIL_ESCALATION,
            to: CHAIN.lead,
            from: CHAIN.implementer,
            subject: 'blocked',
            body: 'help',
          }),
        ]);
        applyEvent(tx, decodeFn(s!), projectors);
        return s!;
      });
      store.transaction((tx) => {
        const [s] = tx.append([
          makeMailEvent(PID, {
            type: MAIL_ESCALATION,
            to: CHAIN.coordinator,
            from: CHAIN.lead,
            subject: 'blocked',
            body: 'help',
            correlationId: 'wrong-thread',
            causationId: String(e1.seq),
          }),
        ]);
        applyEvent(tx, decodeFn(s!), projectors);
      });

      expect(() =>
        store.transaction((tx) => {
          const [s] = tx.append([makeMailForwardEvent(PID, CHAIN.lead, e1.seq, CHAIN.coordinator)]);
          applyEvent(tx, decodeFn(s!), projectors);
        }),
      ).toThrow(/no matching escalation/i);

      const rows = store.transaction((tx) =>
        (tx.raw as DatabaseSync)
          .prepare('SELECT recipient, resolved FROM inbox ORDER BY seq')
          .all(),
      ) as Array<{ recipient: string; resolved: number }>;
      expect(rows).toEqual([
        { recipient: CHAIN.lead, resolved: 0 },
        { recipient: CHAIN.coordinator, resolved: 0 },
      ]);
    } finally {
      store.close();
    }
  });

  it('a default in-process escalate + forward is repo-pristine (writes only to CO_DATA_DIR)', () => {
    const repo = makeRepo();
    const resolver = prototypeParentResolver(CHAIN);
    const mail = openMailStore('p-esc-pristine');
    try {
      const e1 = assertRepoPristine(repo, () => {
        const raised = escalate(mail, resolver, {
          from: CHAIN.implementer,
          subject: 's',
          body: 'b',
        });
        const held = mail.inbox(CHAIN.lead).find((m) => m.seq === raised.seq)!;
        forwardEscalation(mail, resolver, held); // a forward writes nothing into the repo either
        return raised;
      });
      expect(e1.recipient).toBe(CHAIN.lead);
      expect(mail.outstandingCount(CHAIN.coordinator)).toBe(1);
    } finally {
      mail.close();
    }
  });
});

describe('no-stub readiness (helps W6): escalation is a live, registered type', () => {
  it('the escalation envelope validates + flows like any seed type (no free-form leak)', () => {
    const mail = openMailStore('p-esc-validate');
    try {
      const env: MailEnvelope = {
        type: MAIL_ESCALATION,
        to: CHAIN.lead,
        from: CHAIN.implementer,
        subject: 's',
        body: 'b',
      };
      const d = mail.send(env);
      expect(d.kind).toBe('actionable');
      expect(mail.inbox(CHAIN.lead).find((m) => m.seq === d.seq)!.type).toBe(MAIL_ESCALATION);
    } finally {
      mail.close();
    }
  });
});
