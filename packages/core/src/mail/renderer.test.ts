import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertRepoPristine } from '../config/pristine.js';
import {
  MAIL_APPROVAL,
  MAIL_APPROVAL_RESPONSE,
  MAIL_CHAT,
  MAIL_ESCALATION,
  MAIL_REVIEW_RESPONSE,
  MAIL_TYPES,
  type DeliveredMail,
  type MailType,
} from './events.js';
import {
  createRendererRegistry,
  defaultMailCardRenderer,
  defaultMailRenderer,
} from './renderer.js';

// Renderer is pure/in-memory, so most tests need no fixtures; the pristine test needs a
// throwaway repo-like tree (mirrors mail.test.ts / pristine.test.ts).
let repoDirs: string[] = [];

afterEach(() => {
  for (const dir of repoDirs) rmSync(dir, { recursive: true, force: true });
  repoDirs = [];
});

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-mail-repo-'));
  repoDirs.push(dir);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}

/** A delivered mail of `type` with predictable, per-type fields for substring assertions. */
function mailOf(type: MailType, extra: Partial<DeliveredMail> = {}): DeliveredMail {
  return {
    seq: 1,
    recipient: 'bob',
    sender: 'alice',
    type,
    subject: `subject for ${type}`,
    body: `body for ${type}`,
    ts: 0,
    kind: 'informational',
    ...extra,
  };
}

describe('AC-L1-8 — the default renderer renders each seed type to structured text', () => {
  it('renders every MAIL_TYPES member to non-empty markdown carrying its key fields', () => {
    for (const type of MAIL_TYPES) {
      const out = defaultMailRenderer(mailOf(type));
      expect(out.length).toBeGreaterThan(0);
      expect(out).toContain(type); // the type header
      expect(out).toContain('alice → bob'); // sender → recipient
      expect(out).toContain(`subject for ${type}`); // subject
      expect(out).toContain(`body for ${type}`); // body
    }
  });

  it('surfaces a type-specific field generically — an approval_response carries its decision', () => {
    const approved = defaultMailRenderer(mailOf(MAIL_APPROVAL_RESPONSE, { decision: 'approve' }));
    expect(approved).toContain('approve');
    const declined = defaultMailRenderer(mailOf(MAIL_APPROVAL_RESPONSE, { decision: 'decline' }));
    expect(declined).toContain('decline');
    // A type WITHOUT a decision must not invent one (the default is data-driven, not per-type).
    expect(defaultMailRenderer(mailOf(MAIL_CHAT))).not.toMatch(/decision/i);
  });
});

describe('AC-L1-8 — the registry routes per-type, defaulting otherwise', () => {
  it('a registered custom renderer overrides the default for its type only', () => {
    const registry = createRendererRegistry();

    // Before registering: the type uses the generic default.
    expect(registry.render(mailOf(MAIL_APPROVAL))).toContain('subject for approval');

    // The L9 plug-point: register a per-type human card for `approval`.
    registry.register(MAIL_APPROVAL, (mail) => `APPROVAL CARD :: ${mail.subject}`);
    expect(registry.render(mailOf(MAIL_APPROVAL))).toBe('APPROVAL CARD :: subject for approval');

    // Every OTHER type still falls through to the default.
    const chatOut = registry.render(mailOf(MAIL_CHAT));
    expect(chatOut).toContain('subject for chat');
    expect(chatOut).not.toContain('APPROVAL CARD');
  });

  it('honors a custom default renderer passed at construction', () => {
    const registry = createRendererRegistry({ default: (mail) => `FALLBACK:${mail.type}` });
    expect(registry.render(mailOf(MAIL_CHAT))).toBe('FALLBACK:chat');
    // A registered renderer still wins over the custom default.
    registry.register(MAIL_CHAT, () => 'SPECIFIC');
    expect(registry.render(mailOf(MAIL_CHAT))).toBe('SPECIFIC');
  });
});

describe('AC-L1-9 — rendering is pure/in-memory (does no I/O)', () => {
  it('rendering inside assertRepoPristine does not write the repo', () => {
    const repo = makeRepo();
    const registry = createRendererRegistry();
    const out = assertRepoPristine(repo, () => registry.render(mailOf(MAIL_CHAT)));
    expect(out).toContain('subject for chat');
  });

  it('renderCard inside assertRepoPristine does not write the repo', () => {
    const repo = makeRepo();
    const registry = createRendererRegistry();
    const card = assertRepoPristine(repo, () => registry.renderCard(mailOf(MAIL_CHAT)));
    expect(card.title).toBe('subject for chat');
  });
});

// ── SF-6 / AC-S15-12 — typed payload CARDS (key/value fields + body), per-type logic in CORE ──

/** Collapse a card's key/value rows to a `Map` for label-keyed assertions. */
function fieldMap(fields: readonly { label: string; value: string }[]): Map<string, string> {
  return new Map(fields.map((f) => [f.label, f.value]));
}

describe('AC-S15-12 [SF-6] — the generic default card is data-driven (presence, not per-type)', () => {
  it('builds title/body + From/To, surfacing structured fields only when present', () => {
    const card = defaultMailCardRenderer(mailOf(MAIL_CHAT, { sender: 'alice', recipient: 'bob' }));
    expect(card.title).toBe('subject for chat');
    expect(card.body).toBe('body for chat');
    const fields = fieldMap(card.fields);
    expect(fields.get('From')).toBe('alice');
    expect(fields.get('To')).toBe('bob');
    // A chat carries no decision/verdict, so the generic card must not invent those rows.
    expect(fields.has('Decision')).toBe(false);
    expect(fields.has('Verdict')).toBe(false);
  });

  it('surfaces a decision generically when the envelope carries one', () => {
    const card = defaultMailCardRenderer(mailOf(MAIL_APPROVAL_RESPONSE, { decision: 'approve' }));
    expect(fieldMap(card.fields).get('Decision')).toBe('approve');
  });
});

describe('AC-S15-12 [SF-6] — registry.renderCard returns per-type cards from CORE', () => {
  it('approval → an approve/decline card surfacing the ask (and a decision when present)', () => {
    const registry = createRendererRegistry();
    const card = registry.renderCard(
      mailOf(MAIL_APPROVAL, { subject: 'Publish v1?', body: 'may we ship?', sender: 'lead-7' }),
    );
    expect(card.title).toBe('Publish v1?');
    expect(card.body).toBe('may we ship?');
    const fields = fieldMap(card.fields);
    expect(fields.get('From')).toBe('lead-7');
    // The ask is laid out: a decision is required.
    expect([...fields.values()].some((v) => /approve/i.test(v) && /decline/i.test(v))).toBe(true);

    const decided = registry.renderCard(mailOf(MAIL_APPROVAL, { decision: 'decline' }));
    expect(fieldMap(decided.fields).get('Decision')).toBe('decline');
  });

  it('escalation → a readable problem summary surfacing the resolve-or-forward obligation', () => {
    const registry = createRendererRegistry();
    const card = registry.renderCard(
      mailOf(MAIL_ESCALATION, {
        subject: 'Blocked on auth',
        body: 'context here',
        sender: 'lead-3',
      }),
    );
    expect(card.title).toBe('Blocked on auth');
    expect(card.body).toBe('context here');
    const fields = fieldMap(card.fields);
    expect(fields.get('From')).toBe('lead-3');
    expect([...fields.values()].some((v) => /resolve|forward/i.test(v))).toBe(true);
  });

  it('review_response → the verdict card surfacing reviewVerdict prominently', () => {
    const registry = createRendererRegistry();
    const passed = registry.renderCard(
      mailOf(MAIL_REVIEW_RESPONSE, {
        subject: 'Re: review',
        reviewVerdict: 'PASS',
        sender: 'rev-1',
      }),
    );
    expect(passed.title).toBe('Re: review');
    const passedFields = fieldMap(passed.fields);
    expect(passedFields.get('Verdict')).toBe('PASS');
    expect(passedFields.get('From')).toBe('rev-1');
    // The verdict is the FIRST field (most prominent).
    expect(passed.fields[0]?.label).toBe('Verdict');

    const issues = registry.renderCard(mailOf(MAIL_REVIEW_RESPONSE, { reviewVerdict: 'ISSUES' }));
    expect(fieldMap(issues.fields).get('Verdict')).toBe('ISSUES');
  });

  it('an UNREGISTERED type falls back to the generic default card', () => {
    const registry = createRendererRegistry();
    const card = registry.renderCard(mailOf(MAIL_CHAT, { sender: 'alice', recipient: 'bob' }));
    expect(card.title).toBe('subject for chat');
    expect(card.body).toBe('body for chat');
    const fields = fieldMap(card.fields);
    expect(fields.get('From')).toBe('alice');
    expect(fields.get('To')).toBe('bob');
    // No per-type 'Action' row for a plain chat — that is the approval/escalation card's job.
    expect(fields.has('Action')).toBe(false);
  });

  it('a custom registered card overrides the built-in for its type only', () => {
    const registry = createRendererRegistry();
    registry.registerCard(MAIL_APPROVAL, (mail) => ({
      title: `CUSTOM ${mail.subject}`,
      fields: [],
      body: mail.body,
    }));
    expect(registry.renderCard(mailOf(MAIL_APPROVAL)).title).toBe('CUSTOM subject for approval');
    // Every other type keeps its built-in / default card.
    expect(
      registry.renderCard(mailOf(MAIL_REVIEW_RESPONSE, { reviewVerdict: 'PASS' })).fields[0]?.label,
    ).toBe('Verdict');
  });

  it('honors a custom defaultCard passed at construction (built-ins still win for their type)', () => {
    const registry = createRendererRegistry({
      defaultCard: (mail) => ({ title: `FALLBACK:${mail.type}`, fields: [], body: mail.body }),
    });
    expect(registry.renderCard(mailOf(MAIL_CHAT)).title).toBe('FALLBACK:chat');
    // A pre-registered built-in card still wins over the custom default.
    expect(registry.renderCard(mailOf(MAIL_APPROVAL)).title).toBe('subject for approval');
  });
});
