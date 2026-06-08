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
  toolsForRole,
  type MailStore,
  type ProjectRegistry,
  type ToolContext,
} from '@co/core';
import { createCoMcpServer, type CoMcpServerOptions } from './server.js';
import { LiveSessionHostStub } from './live-session-host.js';

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
];

// ── Per-test program-data dir + live stores (mirrors the CO_DATA_DIR idiom in mail.test.ts) ──
const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let openStores: MailStore[] = [];
let openRegs: ProjectRegistry[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  openStores = [];
  openRegs = [];
});

afterEach(() => {
  for (const m of openStores) m.close();
  for (const r of openRegs) r.close();
  process.env = ORIGINAL_ENV;
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true });
  dataDirs = [];
  openStores = [];
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
  openStores.push(mail);
  return { agent, projectId, cwd, mail, registry };
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

  it('publishes each tool with its title, description, and an input JSON schema', async () => {
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

  it('publishes co_mail_send.type as the exact MAIL_TYPES enum over MCP', async () => {
    const ctx = makeTestContext('impl-mail-enum');
    const client = await connect({ contextFactory: () => ctx });

    const { tools } = await client.listTools();
    const send = tools.find((t) => t.name === 'co_mail_send');
    const props = (send?.inputSchema as { properties?: Record<string, unknown> } | undefined)
      ?.properties;
    const typeSchema = props?.type as { enum?: unknown[] } | undefined;

    expect(typeSchema?.enum).toEqual([...MAIL_TYPES]);
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

    const outputProps = (
      sling?.outputSchema as { properties?: Record<string, unknown> } | undefined
    )?.properties;
    const placementProps = (
      outputProps?.placement as { properties?: Record<string, unknown> } | undefined
    )?.properties;
    const waitingProps = (
      outputProps?.waiting as { properties?: Record<string, unknown> } | undefined
    )?.properties;
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

describe('LiveSessionHostStub — the L7 live-session-hosting seam', () => {
  it('hostSession throws with the documented L7 plug-point contract (never a silent no-op)', () => {
    const host = new LiveSessionHostStub();
    expect(() => host.hostSession()).toThrow(/L7 plug-point/);
    expect(() => host.hostSession()).toThrow(/not implemented at L2/);
  });
});
