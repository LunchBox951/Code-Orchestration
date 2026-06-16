import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  buildCoreRegistry,
  MAIL_TYPES,
  openMailStore,
  openRegistry,
  openReviewStore,
  toolsForRole,
  type MailStore,
  type ProjectRegistry,
  type ReviewStore,
  type ToolContext,
} from '@co/core';
import { createCoMcpServer, type CoMcpServerOptions } from './server.js';
import { LiveSessionHostImpl } from './live-session-host.js';

// The canonical `co_*` tools the mount must expose 1:1 (registration order from buildCoreRegistry).
// Pinned here so the parity test catches a tool added OR dropped.
const EXPECTED_TOOLS = [
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

const COORDINATOR_TOOL_LIST_BUDGET_BYTES = 16_000;

// ── Per-test program-data dir + live stores (mirrors the CO_DATA_DIR idiom in mail.test.ts) ──
const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let openStores: MailStore[] = [];
let openReviews: ReviewStore[] = [];
let openRegs: ProjectRegistry[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  openStores = [];
  openReviews = [];
  openRegs = [];
});

afterEach(() => {
  for (const m of openStores) m.close();
  for (const r of openReviews) r.close();
  for (const r of openRegs) r.close();
  process.env = ORIGINAL_ENV;
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
  openStores = [];
  openReviews = [];
  openRegs = [];
});

/**
 * A real, headless {@link ToolContext} for `agent` over a fresh temp program-data dir: a registered
 * project + its mail bus. This is the test-injected `contextFactory` payload — no Conductor, no env
 * (the L2 invocation seam), proving the adapter dispatches structured I/O end to end.
 */
function makeTestContext(agent: string): ToolContext {
  const dataDir = mkdtempSync(join(tmpdir(), 'co-mcp-'));
  dataDirs.push(dataDir);
  process.env.CO_DATA_DIR = dataDir;
  const registry = openRegistry();
  openRegs.push(registry);
  const cwd = join(dataDir, 'repo');
  const projectId = registry.register(cwd);
  const mail = openMailStore(projectId);
  const reviews = openReviewStore(projectId);
  openStores.push(mail);
  openReviews.push(reviews);
  return { agent, projectId, cwd, mail, registry, reviews };
}

/** Connect an in-memory MCP client to a co server built with the given options (no subprocess). */
async function connect(opts: CoMcpServerOptions): Promise<Client> {
  const server = createCoMcpServer(opts);
  const client = new Client({ name: 'co-mcp-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

describe('createCoMcpServer — tool-list parity', () => {
  it('exposes exactly the canonical tools, 1:1 with the core registry', async () => {
    const ctx = makeTestContext('impl-parity');
    const client = await connect({ contextFactory: () => ctx });

    const { tools } = await client.listTools();
    const exposed = tools.map((t) => t.name).sort();
    const fromRegistry = buildCoreRegistry()
      .list()
      .map((t) => t.name)
      .sort();

    // Nothing added, nothing dropped: the exposed surface IS the registry.
    expect(exposed).toEqual(fromRegistry);
    expect(exposed).toEqual([...EXPECTED_TOOLS].sort());
    expect(exposed).toHaveLength(EXPECTED_TOOLS.length);
  });

  it('publishes each tool with its description and input JSON schema', async () => {
    const ctx = makeTestContext('impl-schema');
    const client = await connect({ contextFactory: () => ctx });

    const { tools } = await client.listTools();
    const send = tools.find((t) => t.name === 'co_mail_send');
    expect(send?.description).toMatch(/send/i);
    // The zod input schema is mounted as a JSON schema (the self-describing surface): co_mail_send
    // carries its fields (e.g. `subject`), proving the schema crossed the protocol.
    const props = (send?.inputSchema as { properties?: Record<string, unknown> } | undefined)
      ?.properties;
    expect(props).toBeDefined();
    expect(props).toHaveProperty('subject');
  });

  it('publishes co_mail_send.type as the sendable mail enum over MCP', async () => {
    const ctx = makeTestContext('impl-mail-enum');
    const client = await connect({ contextFactory: () => ctx });

    const { tools } = await client.listTools();
    const send = tools.find((t) => t.name === 'co_mail_send');
    const props = (send?.inputSchema as { properties?: Record<string, unknown> } | undefined)
      ?.properties;
    const typeSchema = props?.type as { enum?: unknown[] } | undefined;

    expect(typeSchema?.enum).toEqual(
      MAIL_TYPES.filter(
        (type) => type !== 'worker_done' && type !== 'review_request' && type !== 'review_response',
      ),
    );
  });

  it('keeps the coordinator tools/list payload compact enough for provider MCP startup', async () => {
    const ctx = makeTestContext('coord-compact-schema');
    const client = await connect({
      contextFactory: () => ctx,
      tools: toolsForRole('coordinator'),
    });

    const { tools } = await client.listTools();
    const encoded = JSON.stringify(tools);
    expect(encoded.length).toBeLessThan(COORDINATOR_TOOL_LIST_BUDGET_BYTES);
    expect(encoded).not.toContain('"$schema"');

    const send = tools.find((t) => t.name === 'co_mail_send');
    expect(send?.title).toBeUndefined();
    const props = (send?.inputSchema as { properties?: Record<string, unknown> } | undefined)
      ?.properties;
    const subjectSchema = props?.subject as { description?: unknown } | undefined;
    expect(subjectSchema?.description).toBeUndefined();
  });

  it('does not publish Review-view-only verdict fields over MCP co_mail_send', async () => {
    const ctx = makeTestContext('impl-review-verdict-schema');
    const client = await connect({ contextFactory: () => ctx });

    const { tools } = await client.listTools();
    const send = tools.find((t) => t.name === 'co_mail_send');
    const props = (send?.inputSchema as { properties?: Record<string, unknown> } | undefined)
      ?.properties;
    expect(props).not.toHaveProperty('review_verdict');
  });

  it('publishes co_sling without agent-supplied account/cost controls or capacity-only WAITING wording', async () => {
    const ctx = makeTestContext('impl-sling-schema');
    const client = await connect({ contextFactory: () => ctx });

    const { tools } = await client.listTools();
    const sling = tools.find((t) => t.name === 'co_sling');
    expect(sling).toBeDefined();
    expect(sling?.description).toMatch(/dispatch policy/i);
    expect(sling?.description).not.toMatch(/when routing inputs .* supplied/i);
    expect(sling?.description).not.toMatch(/all providers are at capacity/i);

    const props = (sling?.inputSchema as { properties?: Record<string, unknown> } | undefined)
      ?.properties;
    expect(props).toBeDefined();
    expect(props).not.toHaveProperty('accounts');
    expect(props).not.toHaveProperty('cost');
    expect(props).not.toHaveProperty('budget');
  });

  it('omits optional output schemas by default while keeping them opt-in for compatible clients', async () => {
    const ctx = makeTestContext('impl-output-schema');
    const defaultClient = await connect({ contextFactory: () => ctx });

    const defaultSling = (await defaultClient.listTools()).tools.find((t) => t.name === 'co_sling');
    const defaultSend = (await defaultClient.listTools()).tools.find(
      (t) => t.name === 'co_mail_send',
    );
    expect(defaultSling?.outputSchema).toBeUndefined();
    expect(defaultSend?.outputSchema).toBeUndefined();

    const outputClient = await connect({
      contextFactory: () => ctx,
      advertiseOutputSchema: true,
    });
    const outputTools = (await outputClient.listTools()).tools;
    const sling = outputTools.find((t) => t.name === 'co_sling');
    const send = outputTools.find((t) => t.name === 'co_mail_send');

    const outputProps = (
      sling?.outputSchema as { properties?: Record<string, unknown> } | undefined
    )?.properties;
    const sendOutputProps = (
      send?.outputSchema as { properties?: Record<string, unknown> } | undefined
    )?.properties;
    const placementProps = (
      outputProps?.placement as { properties?: Record<string, unknown> } | undefined
    )?.properties;
    const waitingProps = (
      outputProps?.waiting as { properties?: Record<string, unknown> } | undefined
    )?.properties;
    expect(sendOutputProps).not.toHaveProperty('review_verdict');
    expect(placementProps).not.toHaveProperty('account');
    expect(waitingProps).not.toHaveProperty('maxed_accounts');
    expect(waitingProps).not.toHaveProperty('unavailable_accounts');
  });
});

describe('createCoMcpServer — protocol round-trip (in-memory)', () => {
  it('round-trips co_mail_send → co_mail_inbox with structured I/O', async () => {
    const ctx = makeTestContext('impl-rt');
    const client = await connect({ contextFactory: () => ctx });

    const sendRes = await client.callTool({
      name: 'co_mail_send',
      arguments: { to: 'impl-rt', type: 'chat', subject: 'hello', body: 'world' },
    });
    expect(sendRes.isError).toBeFalsy();
    const sent = sendRes.structuredContent as Record<string, unknown>;
    expect(sent.sender).toBe('impl-rt');
    expect(sent.recipient).toBe('impl-rt');
    expect(sent.subject).toBe('hello');

    const inboxRes = await client.callTool({ name: 'co_mail_inbox', arguments: {} });
    const inbox = inboxRes.structuredContent as { mail: Array<Record<string, unknown>> };
    expect(inbox.mail).toHaveLength(1);
    const [first] = inbox.mail;
    expect(first?.subject).toBe('hello');
    expect(first?.body).toBe('world');
    expect(first?.seq).toBe(sent.seq);
  });

  it('rejects review_response through MCP mail tools at the schema boundary', async () => {
    const leadCtx = makeTestContext('lead-review');
    const projectId = leadCtx.projectId;
    const cwd = leadCtx.cwd;
    const mail = leadCtx.mail!;
    const reviews = leadCtx.reviews!;
    const registry = leadCtx.registry!;
    const client = await connect({
      contextFactory: () => ({
        agent: '@operator',
        projectId,
        cwd,
        mail,
        reviews,
        registry,
      }),
    });

    const req = mail.requestHumanReview(
      {
        type: 'review_request',
        to: '@operator',
        from: 'lead-review',
        subject: 'review requested',
        body: 'please review',
        idempotencyKey: 'review-request:rev-mcp-review-response',
      },
      {
        reviewId: 'rev-mcp-review-response',
        target: 'main',
        branch: 'co/feature',
        scope: 'pr_merge',
        requestedBy: 'lead-review',
        reviewerKind: 'human',
      },
    ).mail;

    const sendRes = await client.callTool({
      name: 'co_mail_send',
      arguments: {
        type: 'review_response',
        in_reply_to: req.seq,
        subject: 're: review requested',
        body: 'passes',
        review_verdict: 'PASS',
      },
    });
    expect(sendRes.isError).toBe(true);
    const errorContent = sendRes.content as Array<{ text?: string }> | undefined;
    expect(errorContent?.[0]?.text).toMatch(/Input validation error|Invalid option/i);

    const leadClient = await connect({
      contextFactory: () => ({
        agent: 'lead-review',
        projectId,
        cwd,
        mail,
        reviews,
        registry,
      }),
    });
    const inboxRes = await leadClient.callTool({ name: 'co_mail_inbox', arguments: {} });
    const inbox = inboxRes.structuredContent as { mail: Array<Record<string, unknown>> };
    expect(inbox.mail.filter((m) => m.type === 'review_response')).toHaveLength(0);
  });

  it('co_status returns the calling agent record', async () => {
    const ctx = makeTestContext('impl-status');
    const client = await connect({ contextFactory: () => ctx });

    const res = await client.callTool({ name: 'co_status', arguments: {} });
    expect(res.isError).toBeFalsy();
    const status = res.structuredContent as Record<string, unknown>;
    expect(status.agent).toBe('impl-status');
    expect(status.project_id).toBe(ctx.projectId);
    expect(status.cwd).toBe(ctx.cwd);
    expect(status.inbox_unread).toBe(0);
    expect(status.outstanding).toBe(0);
  });

  it('surfaces a core dispatch error as an MCP tool error (fail loud, Principle 9)', async () => {
    const ctx = makeTestContext('impl-err');
    const client = await connect({ contextFactory: () => ctx });

    // A NEW message with no `to` is rejected by core (co_mail_send) — the adapter must propagate
    // that as a tool error, never a silent success.
    const res = await client.callTool({
      name: 'co_mail_send',
      arguments: { type: 'chat', subject: 's', body: 'b' },
    });
    expect(res.isError).toBe(true);
  });
});

describe('createCoMcpServer — per-role tool-scoping (AC-L2-5: the server scopes the offered toolset per role)', () => {
  it('exposes EXACTLY the reviewer’s scoped tools, 1:1 — a strict subset of the registry', async () => {
    const ctx = makeTestContext('rev-scope');
    const reviewerTools = toolsForRole('reviewer');
    const client = await connect({ tools: reviewerTools, contextFactory: () => ctx });

    const { tools } = await client.listTools();
    const exposed = tools.map((t) => t.name).sort();
    // 1:1 with exactly the reviewer's scoped tools — nothing added, nothing dropped.
    expect(exposed).toEqual(reviewerTools.map((t) => t.name).sort());
    // Scoped, not the whole registry: strictly fewer than the full set, and missing the tools the
    // seed omits (the dispatch-only verbs).
    expect(exposed.length).toBeLessThan(buildCoreRegistry().list().length);
    expect(exposed).not.toContain('co_mail_retract');
    expect(exposed).not.toContain('co_sling');
  });

  it('two roles expose DIFFERENT scoped surfaces through the same builder', async () => {
    const revClient = await connect({
      tools: toolsForRole('reviewer'),
      contextFactory: () => makeTestContext('rev'),
    });
    const implClient = await connect({
      tools: toolsForRole('implementer'),
      contextFactory: () => makeTestContext('impl'),
    });

    const rev = (await revClient.listTools()).tools.map((t) => t.name).sort();
    const impl = (await implClient.listTools()).tools.map((t) => t.name).sort();
    expect(rev).not.toEqual(impl);
    expect(impl).toContain('co_mail_retract'); // implementer carries retract…
    expect(rev).not.toContain('co_mail_retract'); // …the leaf reviewer does not.
  });
});

describe('LiveSessionHostImpl — fail-loud on missing identity (Principle 9)', () => {
  it('hostSession rejects a blank authoritative agent without fabricating an identity', async () => {
    const host = new LiveSessionHostImpl();
    // A blank/missing agent must throw (Principle 9 — never fabricate who is calling).
    await expect(
      host.hostSession(
        {
          agent: '',
          role: 'implementer',
          parent: 'lead-1',
          pane: 'pane-blank',
          projectId: 'proj-1',
          cwd: '/tmp',
          provider: 'claude',
          resume: { provider: 'claude', sessionId: 'session-blank' },
        },
        {} as import('@modelcontextprotocol/sdk/shared/transport.js').Transport,
      ),
    ).rejects.toThrow(/authoritative agent.*missing or blank/);
  });
});
