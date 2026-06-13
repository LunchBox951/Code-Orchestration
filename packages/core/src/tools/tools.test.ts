import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertRepoPristine } from '../config/pristine.js';
import {
  MAIL_CHAT,
  MAIL_CLARIFY_REQUEST,
  MAIL_CLARIFY_RESPONSE,
  MAIL_REVIEW_REQUEST,
  MAIL_REVIEW_RESPONSE,
  MAIL_WORKER_DONE,
  OPERATOR,
} from '../mail/events.js';
import { openMailStore, type MailStore } from '../mail/mail-store.js';
import { openRegistry, type ProjectRegistry } from '../registry/registry.js';
import { openReviewStore, type ReviewStore } from '../review/review-store.js';
import type { ToolContext } from './context.js';
import { buildCoreRegistry } from './core-registry.js';
import { invokeTool } from './invoke.js';
import { notImplemented, type ToolRegistry } from './registry.js';
import type { WireMail } from './specs/wire.js';

// ── temp program-data dir + repo fixtures per test (mirrors mail.test.ts) ─────
const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let repoDirs: string[] = [];
const CWD = '/work/p-tools'; // a fixed logical worktree path; the mail/status tools never touch disk

function useDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'co-tools-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'co-tools-repo-'));
  repoDirs.push(dir);
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}

/** A harness over a real temp store: a shared mail bus + registry, and per-agent contexts. */
function setup(): {
  reg: ToolRegistry;
  ctx: (agent: string) => ToolContext;
  close: () => void;
} {
  const mail: MailStore = openMailStore('p-tools');
  const reviews: ReviewStore = openReviewStore('p-tools');
  const registry: ProjectRegistry = openRegistry();
  const reg = buildCoreRegistry();
  return {
    reg,
    ctx: (agent: string): ToolContext => ({
      agent,
      projectId: 'p-tools',
      cwd: CWD,
      mail,
      reviews,
      registry,
    }),
    close: () => {
      mail.close();
      reviews.close();
      registry.close();
    },
  };
}

// Structural views of the validated structured outputs (avoid `any`).
type ListOut = { mail: WireMail[] };
type OneOut = { mail: WireMail };
type AckOut = { acked: WireMail[] };
type StatusOut = {
  agent: string;
  project_id: string;
  cwd: string;
  outstanding: number;
  inbox_unread: number;
};
type OrientOut = { guidance: string };

const ALL_TOOLS = [
  'co_mail_send',
  'co_mail_inbox',
  'co_mail_get',
  'co_mail_thread',
  'co_mail_ack',
  'co_mail_retract',
  'co_status',
  'co_worktree_info',
  'co_orient',
  'co_sling',
  'co_finish',
  'co_merge',
  'co_review_finalize',
  'co_push',
  'co_pr_merge',
  'co_kickback',
  'co_spec_get',
  'co_spec_draft',
  'co_spec_lock',
  'co_spec_archive',
  'co_plan_ingest',
  'co_phase_status',
  'co_issue_capture',
  'co_issue_list',
  'co_issue_diagnose',
  'co_issue_file',
  'co_research_finalize',
  'co_research_get',
];

describe('buildCoreRegistry — the canonical single source of truth', () => {
  it('registers exactly the real tools, in order, with non-stub handlers', () => {
    const reg = buildCoreRegistry();
    expect(reg.list().map((t) => t.name)).toEqual(ALL_TOOLS);
    for (const spec of reg.list()) {
      expect(spec.handler).not.toBe(notImplemented); // no stubs reach the canonical registry
      expect(spec.description.length).toBeGreaterThan(0); // every tool self-describes
      expect(spec.inputSchema).toBeDefined();
      expect(spec.outputSchema).toBeDefined();
    }
  });

  it('co_push public contract names the required pr_merge PASS', () => {
    const push = buildCoreRegistry().get('co_push');
    expect(push?.description).toMatch(/pr_merge PASS/);
  });

  it('co_pr_merge public contract names the required pr_merge PASS', () => {
    const prMerge = buildCoreRegistry().get('co_pr_merge');
    expect(prMerge?.description).toMatch(/pr_merge PASS/);
  });
});

describe('invokeTool — the transport-agnostic headless harness', () => {
  it('fails loud on an unknown tool (Principle 9)', async () => {
    const { reg, ctx, close } = setup();
    try {
      await expect(invokeTool(reg, ctx('alice'), 'co_does_not_exist', {})).rejects.toThrow(
        /unknown tool/i,
      );
    } finally {
      close();
    }
  });

  it('rejects input that fails the input schema — never a silent default', async () => {
    const { reg, ctx, close } = setup();
    try {
      // Missing the required `subject` → schema rejects before the bus is touched.
      await expect(
        invokeTool(reg, ctx('alice'), 'co_mail_send', { to: 'bob', type: MAIL_CHAT, body: 'x' }),
      ).rejects.toThrow(/schema validation/i);
      // Wrong type for `id` (string, not number).
      await expect(invokeTool(reg, ctx('alice'), 'co_mail_get', { id: 'oops' })).rejects.toThrow(
        /schema validation/i,
      );
    } finally {
      close();
    }
  });
});

describe('co_mail_send / co_mail_inbox — send round-trips into the recipient inbox', () => {
  it('a sent message lands in the recipient inbox, structured and typed', async () => {
    const { reg, ctx, close } = setup();
    try {
      const sent = (await invokeTool(reg, ctx('alice'), 'co_mail_send', {
        to: 'bob',
        type: MAIL_CHAT,
        subject: 'hi',
        body: 'hello',
      })) as WireMail;
      expect(sent.sender).toBe('alice');
      expect(sent.recipient).toBe('bob');
      expect(sent.type).toBe(MAIL_CHAT);

      const inbox = (await invokeTool(reg, ctx('bob'), 'co_mail_inbox', {})) as ListOut;
      expect(inbox.mail).toHaveLength(1);
      expect(inbox.mail[0]?.seq).toBe(sent.seq);
      expect(inbox.mail[0]?.subject).toBe('hi');

      // The sender never appears in its own (recipient) inbox.
      const aliceInbox = (await invokeTool(reg, ctx('alice'), 'co_mail_inbox', {})) as ListOut;
      expect(aliceInbox.mail).toEqual([]);
    } finally {
      close();
    }
  });

  it('rejects worker_done through generic mail send; co_finish owns that durable signal', async () => {
    const { reg, ctx, close } = setup();
    try {
      await expect(
        invokeTool(reg, ctx('impl-1'), 'co_mail_send', {
          to: 'lead-1',
          type: MAIL_WORKER_DONE,
          subject: 'worker_done: co/feature',
          body: 'done',
        }),
      ).rejects.toThrow(/schema validation/i);
    } finally {
      close();
    }
  });

  it('rejects review_request through generic mail send; review gates own that durable signal', async () => {
    const { reg, ctx, close } = setup();
    try {
      await expect(
        invokeTool(reg, ctx('lead-1'), 'co_mail_send', {
          to: OPERATOR,
          type: MAIL_REVIEW_REQUEST,
          subject: 'review?',
          body: 'please review',
        }),
      ).rejects.toThrow(/schema validation/i);
    } finally {
      close();
    }
  });

  it('a threaded reply (in_reply_to) lands with correct correlation_id/causation_id', async () => {
    const { reg, ctx, close } = setup();
    try {
      const req = (await invokeTool(reg, ctx('worker'), 'co_mail_send', {
        to: 'lead',
        type: MAIL_CLARIFY_REQUEST,
        subject: 'which db?',
        body: 'sqlite or pg?',
      })) as WireMail;

      const reply = (await invokeTool(reg, ctx('lead'), 'co_mail_send', {
        type: MAIL_CLARIFY_RESPONSE,
        in_reply_to: req.seq,
        subject: 're: which db?',
        body: 'sqlite',
      })) as WireMail;

      expect(reply.sender).toBe('lead');
      expect(reply.recipient).toBe('worker'); // recipient derived from the answered mail
      expect(reply.correlation_id).toBe(String(req.seq)); // thread id = root seq (freeze #7)
      expect(reply.causation_id).toBe(String(req.seq)); // answers the request
    } finally {
      close();
    }
  });

  it('rejects review_response replies to non-review_request mail', async () => {
    const { reg, ctx, close } = setup();
    try {
      const leadCtx = ctx('lead');
      const req = leadCtx.mail.send({
        to: OPERATOR,
        type: MAIL_CLARIFY_REQUEST,
        from: 'lead',
        subject: 'question?',
        body: 'please answer',
      });

      await expect(
        invokeTool(reg, ctx(OPERATOR), 'co_mail_send', {
          type: MAIL_REVIEW_RESPONSE,
          in_reply_to: req.seq,
          subject: 're: question?',
          body: 'passes',
          review_verdict: 'PASS',
        }),
      ).rejects.toThrow(/review_request/i);
    } finally {
      close();
    }
  });

  it('a review_response carries review_verdict through send, inbox, get, and thread', async () => {
    const { reg, ctx, close } = setup();
    try {
      const leadCtx = ctx('lead');
      const req = leadCtx.mail.requestHumanReview(
        {
          type: MAIL_REVIEW_REQUEST,
          to: OPERATOR,
          from: 'lead',
          subject: 'review requested',
          body: 'please review',
          idempotencyKey: 'review-request:rev-tools-review-response',
        },
        {
          reviewId: 'rev-tools-review-response',
          target: 'main',
          branch: 'co/feature',
          scope: 'pr_merge',
          requestedBy: 'lead',
          reviewerKind: 'human',
        },
      ).mail;

      const reply = (await invokeTool(reg, ctx(OPERATOR), 'co_mail_send', {
        type: MAIL_REVIEW_RESPONSE,
        in_reply_to: req.seq,
        subject: 're: review requested',
        body: 'passes',
        review_verdict: 'PASS',
      })) as WireMail;

      expect(reply.review_verdict).toBe('PASS');

      const inbox = (await invokeTool(reg, ctx('lead'), 'co_mail_inbox', {})) as ListOut;
      expect(inbox.mail.find((m) => m.seq === reply.seq)?.review_verdict).toBe('PASS');

      const byGet = (await invokeTool(reg, ctx('lead'), 'co_mail_get', {
        id: reply.seq,
      })) as OneOut;
      expect(byGet.mail.review_verdict).toBe('PASS');

      const thread = (await invokeTool(reg, ctx('lead'), 'co_mail_thread', {
        thread_id: String(req.seq),
      })) as ListOut;
      expect(thread.mail.find((m) => m.seq === reply.seq)?.review_verdict).toBe('PASS');
    } finally {
      close();
    }
  });

  it('unread_only narrows the inbox to mail still needing attention', async () => {
    const { reg, ctx, close } = setup();
    try {
      const a = (await invokeTool(reg, ctx('alice'), 'co_mail_send', {
        to: 'bob',
        type: MAIL_CHAT,
        subject: 'one',
        body: 'b',
      })) as WireMail;
      await invokeTool(reg, ctx('alice'), 'co_mail_send', {
        to: 'bob',
        type: MAIL_CHAT,
        subject: 'two',
        body: 'b',
      });
      await invokeTool(reg, ctx('bob'), 'co_mail_ack', { ids: [a.seq] }); // read the first

      const unread = (await invokeTool(reg, ctx('bob'), 'co_mail_inbox', {
        unread_only: true,
      })) as ListOut;
      expect(unread.mail.map((m) => m.subject)).toEqual(['two']);
    } finally {
      close();
    }
  });

  it('unread_only keeps acknowledged unresolved actionable mail visible', async () => {
    const { reg, ctx, close } = setup();
    try {
      const req = (await invokeTool(reg, ctx('alice'), 'co_mail_send', {
        to: 'bob',
        type: MAIL_CLARIFY_REQUEST,
        subject: 'answer needed',
        body: '?',
      })) as WireMail;
      await invokeTool(reg, ctx('bob'), 'co_mail_ack', { ids: [req.seq] });

      const needsAttention = (await invokeTool(reg, ctx('bob'), 'co_mail_inbox', {
        unread_only: true,
      })) as ListOut;
      expect(needsAttention.mail.map((m) => m.seq)).toEqual([req.seq]);
      expect(needsAttention.mail[0]?.read).toBe(true);
      expect(needsAttention.mail[0]?.resolved).toBe(false);
    } finally {
      close();
    }
  });

  it('co_mail_send schema rejects unknown mail types before the bus layer', () => {
    const send = buildCoreRegistry().get('co_mail_send');
    expect(() =>
      send?.inputSchema.parse({ to: 'bob', type: 'wizard_mail', subject: 's', body: 'b' }),
    ).toThrow();
  });

  it('co_mail_send schema rejects worker_done before the handler', () => {
    const send = buildCoreRegistry().get('co_mail_send');
    expect(() =>
      send?.inputSchema.parse({
        to: 'lead-1',
        type: MAIL_WORKER_DONE,
        subject: 'worker_done: co/feature',
        body: 'done',
      }),
    ).toThrow();
  });

  it('co_mail_send schema rejects review_request before the handler', () => {
    const send = buildCoreRegistry().get('co_mail_send');
    expect(() =>
      send?.inputSchema.parse({
        to: OPERATOR,
        type: MAIL_REVIEW_REQUEST,
        subject: 'review?',
        body: 'please review',
      }),
    ).toThrow();
  });

  it('a reply to a mail NOT in the caller inbox fails loud', async () => {
    const { reg, ctx, close } = setup();
    try {
      const req = (await invokeTool(reg, ctx('worker'), 'co_mail_send', {
        to: 'lead',
        type: MAIL_CLARIFY_REQUEST,
        subject: 'q',
        body: '?',
      })) as WireMail;
      // The worker is the SENDER, not the recipient — it cannot reply to its own request.
      await expect(
        invokeTool(reg, ctx('worker'), 'co_mail_send', {
          type: MAIL_CLARIFY_RESPONSE,
          in_reply_to: req.seq,
          subject: 're',
          body: 'a',
        }),
      ).rejects.toThrow(/not in worker's inbox/);
    } finally {
      close();
    }
  });
});

describe('co_mail_get — authorizes by sender/recipient (no cross-agent peeking)', () => {
  it('the sender and recipient can get it; a third party cannot', async () => {
    const { reg, ctx, close } = setup();
    try {
      const sent = (await invokeTool(reg, ctx('alice'), 'co_mail_send', {
        to: 'bob',
        type: MAIL_CHAT,
        subject: 's',
        body: 'b',
      })) as WireMail;

      const byBob = (await invokeTool(reg, ctx('bob'), 'co_mail_get', { id: sent.seq })) as OneOut;
      expect(byBob.mail.seq).toBe(sent.seq);
      const byAlice = (await invokeTool(reg, ctx('alice'), 'co_mail_get', {
        id: sent.seq,
      })) as OneOut;
      expect(byAlice.mail.seq).toBe(sent.seq);

      await expect(invokeTool(reg, ctx('carol'), 'co_mail_get', { id: sent.seq })).rejects.toThrow(
        /not found or not visible to carol/,
      );
    } finally {
      close();
    }
  });
});

describe('co_mail_thread — every visible mail in the thread, in order', () => {
  it('returns the request and its reply, oldest first', async () => {
    const { reg, ctx, close } = setup();
    try {
      const req = (await invokeTool(reg, ctx('worker'), 'co_mail_send', {
        to: 'lead',
        type: MAIL_CLARIFY_REQUEST,
        subject: 'q',
        body: '?',
      })) as WireMail;
      const reply = (await invokeTool(reg, ctx('lead'), 'co_mail_send', {
        type: MAIL_CLARIFY_RESPONSE,
        in_reply_to: req.seq,
        subject: 'a',
        body: 'answer',
      })) as WireMail;

      const thread = (await invokeTool(reg, ctx('worker'), 'co_mail_thread', {
        thread_id: String(req.seq),
      })) as ListOut;
      expect(thread.mail.map((m) => m.seq)).toEqual([req.seq, reply.seq]);
    } finally {
      close();
    }
  });
});

describe('co_mail_ack — flips read on the caller mail', () => {
  it('marks received mail read; the inbox reflects it', async () => {
    const { reg, ctx, close } = setup();
    try {
      const sent = (await invokeTool(reg, ctx('alice'), 'co_mail_send', {
        to: 'bob',
        type: MAIL_CHAT,
        subject: 's',
        body: 'b',
      })) as WireMail;
      expect(sent.read).toBe(false);

      const acked = (await invokeTool(reg, ctx('bob'), 'co_mail_ack', {
        ids: [sent.seq],
      })) as AckOut;
      expect(acked.acked[0]?.read).toBe(true);

      const inbox = (await invokeTool(reg, ctx('bob'), 'co_mail_inbox', {})) as ListOut;
      expect(inbox.mail.find((m) => m.seq === sent.seq)?.read).toBe(true);
    } finally {
      close();
    }
  });
});

describe('co_mail_retract — the sender withdraws; a non-sender cannot', () => {
  it('removes the mail from the recipient inbox; a non-sender retract throws', async () => {
    const { reg, ctx, close } = setup();
    try {
      const sent = (await invokeTool(reg, ctx('alice'), 'co_mail_send', {
        to: 'bob',
        type: MAIL_CHAT,
        subject: 's',
        body: 'b',
      })) as WireMail;

      // A non-sender cannot retract.
      await expect(
        invokeTool(reg, ctx('bob'), 'co_mail_retract', { id: sent.seq }),
      ).rejects.toThrow();

      // The sender can — it becomes a tombstone and leaves bob's inbox.
      const r = (await invokeTool(reg, ctx('alice'), 'co_mail_retract', {
        id: sent.seq,
      })) as OneOut;
      expect(r.mail.retracted).toBe(true);
      const bobInbox = (await invokeTool(reg, ctx('bob'), 'co_mail_inbox', {})) as ListOut;
      expect(bobInbox.mail).toEqual([]);
    } finally {
      close();
    }
  });
});

describe('co_status — the honest L2 agent record; counts track the bus', () => {
  it('reports identity + live coordination state, and the counts move with the mail', async () => {
    const { reg, ctx, close } = setup();
    try {
      const before = (await invokeTool(reg, ctx('lead'), 'co_status', {})) as StatusOut;
      expect(before).toMatchObject({
        agent: 'lead',
        project_id: 'p-tools',
        cwd: CWD,
        outstanding: 0,
        inbox_unread: 0,
      });

      // An actionable item to the lead lifts both outstanding and inbox_unread.
      const req = (await invokeTool(reg, ctx('worker'), 'co_mail_send', {
        to: 'lead',
        type: MAIL_CLARIFY_REQUEST,
        subject: 'q',
        body: '?',
      })) as WireMail;
      const afterSend = (await invokeTool(reg, ctx('lead'), 'co_status', {})) as StatusOut;
      expect(afterSend.outstanding).toBe(1);
      expect(afterSend.inbox_unread).toBe(1);

      // Acking clears unread but NOT the outstanding actionable (viewing never resolves it).
      await invokeTool(reg, ctx('lead'), 'co_mail_ack', { ids: [req.seq] });
      const afterAck = (await invokeTool(reg, ctx('lead'), 'co_status', {})) as StatusOut;
      expect(afterAck.inbox_unread).toBe(0);
      expect(afterAck.outstanding).toBe(1);

      // The worker retracting its request drops the outstanding count to zero.
      await invokeTool(reg, ctx('worker'), 'co_mail_retract', { id: req.seq });
      const afterRetract = (await invokeTool(reg, ctx('lead'), 'co_status', {})) as StatusOut;
      expect(afterRetract.outstanding).toBe(0);
    } finally {
      close();
    }
  });
});

describe('co_orient — workflow-only guidance (Principle 5: schemas are the syntax source)', () => {
  it('returns non-empty workflow guidance and restates NO tool field-name list', async () => {
    const { reg, ctx, close } = setup();
    try {
      const out = (await invokeTool(reg, ctx('worker'), 'co_orient', {})) as OrientOut;
      expect(out.guidance.length).toBeGreaterThan(0);
      expect(out.guidance.toLowerCase()).toContain('mail'); // it teaches the coordination workflow

      // The schemas are the single syntax source — orient must not restate any tool's fields.
      const FORBIDDEN_FIELD_TOKENS = [
        'in_reply_to',
        'idempotency_key',
        'unread_only',
        'thread_id',
        'head_sha',
        'inbox_unread',
        'correlation_id',
        'causation_id',
      ];
      for (const token of FORBIDDEN_FIELD_TOKENS) {
        expect(out.guidance).not.toContain(token);
      }
    } finally {
      close();
    }
  });

  it('still returns guidance (and no field list) when given role/topic', async () => {
    const { reg, ctx, close } = setup();
    try {
      const out = (await invokeTool(reg, ctx('worker'), 'co_orient', {
        role: 'implementer',
        topic: 'finish',
      })) as OrientOut;
      expect(out.guidance).toContain('implementer');
      expect(out.guidance).not.toContain('in_reply_to');
    } finally {
      close();
    }
  });
});

describe('tools are repo-pristine — a representative tool call writes no repo footprint', () => {
  it('wrapping a co_mail_send (via invokeTool) in assertRepoPristine does not throw', async () => {
    const repo = makeRepo();
    const { reg, ctx, close } = setup();
    try {
      // The in-process store write happens synchronously inside the handler (before invokeTool's
      // first await), so assertRepoPristine — which hashes the repo right after fn() returns the
      // pending promise — sees the full effect. The write goes only to CO_DATA_DIR, so the target
      // repo stays byte-identical (Principle 12). Awaiting the returned promise then yields the mail.
      const sent = (await assertRepoPristine(repo, () =>
        invokeTool(reg, ctx('alice'), 'co_mail_send', {
          to: 'bob',
          type: MAIL_CHAT,
          subject: 's',
          body: 'b',
        }),
      )) as WireMail;
      expect(sent.recipient).toBe('bob');

      // The send really happened — pristine did not block it, it just proved no repo write.
      const inbox = (await invokeTool(reg, ctx('bob'), 'co_mail_inbox', {})) as ListOut;
      expect(inbox.mail).toHaveLength(1);
    } finally {
      close();
    }
  });
});
