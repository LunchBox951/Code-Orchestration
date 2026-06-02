import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertRepoPristine } from '../config/pristine.js';
import {
  MAIL_APPROVAL,
  MAIL_APPROVAL_RESPONSE,
  MAIL_CHAT,
  MAIL_TYPES,
  type DeliveredMail,
  type MailType,
} from './events.js';
import { createRendererRegistry, defaultMailRenderer } from './renderer.js';

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
});
