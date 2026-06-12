/**
 * C1 sandbox tests for LiveSessionHostImpl: per-pane authoritative identity injection over an
 * in-memory MCP transport. Tests AC-L7-2 (identity is conductor-injected, never client-supplied).
 *
 * Also includes the AC-L7-8 assertion: buildCoreRegistry() registers zero Conductor-control verbs.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  BASE_ROLES,
  buildCoreRegistry,
  checkToolCompleteness,
  openMailStore,
  openRegistry,
  openRosterStore,
  openSessionStore,
  toolsForRole,
  type MailStore,
  type ProjectRegistry,
  type Role,
  type RosterStore,
  type SessionStore,
} from '@co/core';
import {
  LiveSessionHostImpl,
  type HostedIdentity,
  type HostedSession,
} from './live-session-host.js';

// ── Shared cleanup state ────────────────────────────────────────────────────
const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let openedSessions: HostedSession[] = [];
let openedRegistries: ProjectRegistry[] = [];
let openedMailStores: MailStore[] = [];
let openedRosterStores: RosterStore[] = [];
let openedSessionStores: SessionStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  openedSessions = [];
  openedRegistries = [];
  openedMailStores = [];
  openedRosterStores = [];
  openedSessionStores = [];
});

afterEach(async () => {
  for (const s of openedSessions) {
    try {
      await s.close();
    } catch {
      /* best-effort */
    }
  }
  for (const m of openedMailStores) {
    try {
      m.close();
    } catch {
      /* best-effort */
    }
  }
  for (const r of openedRegistries) {
    try {
      r.close();
    } catch {
      /* best-effort */
    }
  }
  for (const r of openedRosterStores) {
    try {
      r.close();
    } catch {
      /* best-effort */
    }
  }
  for (const s of openedSessionStores) {
    try {
      s.close();
    } catch {
      /* best-effort */
    }
  }
  process.env = ORIGINAL_ENV;
  for (const dir of dataDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  dataDirs = [];
  openedSessions = [];
  openedMailStores = [];
  openedRegistries = [];
  openedRosterStores = [];
  openedSessionStores = [];
});

/**
 * Register a fresh temp project and return its projectId + cwd. Sets CO_DATA_DIR so the stores
 * open under the same program-data directory, mirroring the CO_DATA_DIR idiom used in other tests.
 */
function makeProject(): { projectId: string; cwd: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'co-lsh-'));
  dataDirs.push(dataDir);
  process.env.CO_DATA_DIR = dataDir;

  const registry = openRegistry();
  openedRegistries.push(registry);
  const cwd = join(dataDir, 'repo');
  const projectId = registry.register(cwd);
  return { projectId, cwd };
}

function makeHostedIdentity(
  identity: Omit<HostedIdentity, 'pane' | 'provider' | 'resume'> &
    Partial<Pick<HostedIdentity, 'pane' | 'provider' | 'resume'>>,
): HostedIdentity {
  const provider = identity.provider ?? 'claude';
  return {
    ...identity,
    pane: identity.pane ?? `pane-${identity.agent}`,
    provider,
    resume:
      identity.resume ??
      (provider === 'claude'
        ? { provider: 'claude', sessionId: `session-${identity.agent}` }
        : { provider: 'codex', codexHome: `/tmp/codex-${identity.agent}` }),
  };
}

/** Seed the already-existing parent chain that a real Conductor spawn would have recorded earlier. */
function seedParentChain(projectId: string, parent: string): void {
  const roster = openRosterStore(projectId);
  try {
    if (parent === '@operator') return;
    roster.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
    if (parent === 'coord-1') return;
    if (parent === 'lead-1') {
      roster.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-1' });
      return;
    }
  } finally {
    roster.close();
  }
  throw new Error(`test fixture does not know how to seed parent '${parent}'`);
}

/**
 * Host a session with `identity` over a linked in-memory transport pair. Returns a connected MCP
 * Client and the HostedSession handle for cleanup. The server-side transport is consumed by the
 * host; the client uses the client-side transport.
 */
async function hostAndConnect(
  identity: HostedIdentity,
): Promise<{ client: Client; session: HostedSession }> {
  const host = new LiveSessionHostImpl();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const session = await host.hostSession(identity, serverTransport);
  openedSessions.push(session);
  const client = new Client({ name: 'co-lsh-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, session };
}

// ── Handshake + role-scoped surface ────────────────────────────────────────

describe('LiveSessionHostImpl — handshake + role-scoped surface', () => {
  it('completes initialize→initialized and exposes exactly the implementer toolset', async () => {
    const { projectId, cwd } = makeProject();
    const identity = makeHostedIdentity({
      agent: 'impl-x',
      role: 'implementer',
      parent: 'lead-1',
      projectId,
      cwd,
    });
    seedParentChain(projectId, identity.parent);

    const { client } = await hostAndConnect(identity);
    const { tools } = await client.listTools();
    const exposed = tools.map((t) => t.name).sort();
    const expected = toolsForRole('implementer')
      .map((t) => t.name)
      .sort();

    expect(exposed).toEqual(expected);
    expect(exposed.length).toBeGreaterThan(0);
    // Role-scoped: strictly fewer tools than the full registry.
    expect(exposed.length).toBeLessThan(buildCoreRegistry().list().length);
  });

  it('scopes each base role to exactly its own toolset', async () => {
    for (const role of BASE_ROLES as readonly Role[]) {
      const { projectId, cwd } = makeProject();
      const identity = makeHostedIdentity({
        agent: `agent-${role}`,
        role,
        parent: role === 'coordinator' ? '@operator' : 'coord-1',
        projectId,
        cwd,
      });
      seedParentChain(projectId, identity.parent);
      const { client } = await hostAndConnect(identity);
      const { tools } = await client.listTools();
      const exposed = tools.map((t) => t.name).sort();
      const expected = toolsForRole(role)
        .map((t) => t.name)
        .sort();
      expect(exposed).toEqual(expected);
    }
  });
});

// ── Authoritative identity injection (AC-L7-2) ─────────────────────────────

describe('LiveSessionHostImpl — authoritative identity injection (AC-L7-2)', () => {
  it('acts as the conductor-supplied agent, not any identity the client could claim', async () => {
    const { projectId, cwd } = makeProject();
    const identity = makeHostedIdentity({
      agent: 'impl-x',
      role: 'implementer',
      parent: 'lead-1',
      projectId,
      cwd,
    });
    seedParentChain(projectId, identity.parent);

    const { client } = await hostAndConnect(identity);

    // co_status returns the calling agent identity from the injected ToolContext.
    const res = await client.callTool({ name: 'co_status', arguments: {} });
    expect(res.isError).toBeFalsy();
    const status = res.structuredContent as Record<string, unknown>;

    // The server-injected identity must be impl-x — not whatever the client might claim.
    expect(status.agent).toBe('impl-x');
    expect(status.project_id).toBe(projectId);
  });

  it('records the hosted agent in the roster before serving role-gated tools', async () => {
    const { projectId, cwd } = makeProject();
    const identity = makeHostedIdentity({
      agent: 'impl-x',
      role: 'implementer',
      parent: 'lead-1',
      projectId,
      cwd,
    });
    seedParentChain(projectId, identity.parent);

    const { client } = await hostAndConnect(identity);

    const issues = await client.callTool({ name: 'co_issue_list', arguments: {} });
    expect(issues.isError).toBeFalsy();
    const roster = openRosterStore(projectId);
    openedRosterStores.push(roster);
    expect(roster.getAgent('impl-x')).toMatchObject({
      agentId: 'impl-x',
      role: 'implementer',
      parent: 'lead-1',
    });
  });

  it('preserves a hosted sub-role in the roster record', async () => {
    const { projectId, cwd } = makeProject();
    const identity = makeHostedIdentity({
      agent: 'impl-code',
      role: 'implementer',
      subRole: 'code',
      parent: 'lead-1',
      projectId,
      cwd,
    });
    seedParentChain(projectId, identity.parent);

    await hostAndConnect(identity);

    const roster = openRosterStore(projectId);
    openedRosterStores.push(roster);
    expect(roster.getAgent('impl-code')).toMatchObject({
      agentId: 'impl-code',
      role: 'implementer',
      subRole: 'code',
      parent: 'lead-1',
    });
  });

  it('accepts an already-registered hosted sub-role when the identity matches', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const roster = openRosterStore(projectId);
    openedRosterStores.push(roster);
    roster.recordAgent({
      agentId: 'impl-code',
      role: 'implementer',
      subRole: 'code',
      parent: 'lead-1',
    });
    const identity = makeHostedIdentity({
      agent: 'impl-code',
      role: 'implementer',
      subRole: 'code',
      parent: 'lead-1',
      projectId,
      cwd,
    });

    await expect(hostAndConnect(identity)).resolves.toBeDefined();
    expect(roster.getAgent('impl-code')?.subRole).toBe('code');
  });

  it('mail sent from the hosted session is stamped with the conductor-supplied agent', async () => {
    const { projectId, cwd } = makeProject();
    const identity = makeHostedIdentity({
      agent: 'impl-x',
      role: 'implementer',
      parent: 'lead-1',
      projectId,
      cwd,
    });
    seedParentChain(projectId, identity.parent);

    const { client } = await hostAndConnect(identity);

    // Send a mail from the hosted session; check the `sender` field in the response.
    const sendRes = await client.callTool({
      name: 'co_mail_send',
      arguments: { to: 'impl-x', type: 'chat', subject: 'ping', body: 'pong' },
    });
    expect(sendRes.isError).toBeFalsy();
    const sent = sendRes.structuredContent as Record<string, unknown>;

    // Identity comes from contextFactory, not from the client args — no 'from' field in args.
    expect(sent.sender).toBe('impl-x');
  });

  it('inbox query returns only the hosted-agent inbox (not another agent)', async () => {
    const { projectId, cwd } = makeProject();

    // Seed a mail for impl-x and one for impl-other using a direct store.
    const seedMail = openMailStore(projectId);
    openedMailStores.push(seedMail);
    seedMail.send({ type: 'chat', to: 'impl-x', from: 'lead-1', subject: 'for-x', body: 'hi' });
    seedMail.send({
      type: 'chat',
      to: 'impl-other',
      from: 'lead-1',
      subject: 'for-other',
      body: 'yo',
    });
    seedMail.close();
    openedMailStores.splice(openedMailStores.indexOf(seedMail), 1);

    const identity = makeHostedIdentity({
      agent: 'impl-x',
      role: 'implementer',
      parent: 'lead-1',
      projectId,
      cwd,
    });
    seedParentChain(projectId, identity.parent);
    const { client } = await hostAndConnect(identity);

    const inboxRes = await client.callTool({ name: 'co_mail_inbox', arguments: {} });
    expect(inboxRes.isError).toBeFalsy();
    const inbox = inboxRes.structuredContent as { mail: Array<Record<string, unknown>> };

    // Only impl-x's mail appears — not impl-other's.
    expect(inbox.mail.some((m) => m.subject === 'for-x')).toBe(true);
    expect(inbox.mail.every((m) => m.recipient === 'impl-x')).toBe(true);
  });
});

// ── Fail-loud: missing/blank authoritative agent (Principle 9) ─────────────

describe('LiveSessionHostImpl — fail-loud on missing identity (Principle 9)', () => {
  it('throws when the authoritative agent is blank', async () => {
    const host = new LiveSessionHostImpl();
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    await expect(
      host.hostSession(
        makeHostedIdentity({
          agent: '',
          role: 'implementer',
          parent: 'lead-1',
          projectId: 'proj-1',
          cwd: '/tmp',
        }),
        serverTransport,
      ),
    ).rejects.toThrow(/authoritative agent.*missing or blank/);
  });

  it('throws when the authoritative agent is whitespace-only', async () => {
    const host = new LiveSessionHostImpl();
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    await expect(
      host.hostSession(
        makeHostedIdentity({
          agent: '   ',
          role: 'implementer',
          parent: 'lead-1',
          projectId: 'proj-1',
          cwd: '/tmp',
        }),
        serverTransport,
      ),
    ).rejects.toThrow(/authoritative agent.*missing or blank/);
  });
});

// ── Two-pane identity isolation ────────────────────────────────────────────

describe('LiveSessionHostImpl — two-pane identity isolation', () => {
  it('two hosted sessions each inject their own agent with no cross-pane leakage', async () => {
    const p1 = makeProject();
    const p2 = makeProject();

    const id1 = makeHostedIdentity({
      agent: 'impl-x',
      role: 'implementer',
      parent: 'lead-1',
      projectId: p1.projectId,
      cwd: p1.cwd,
    });
    const id2 = makeHostedIdentity({
      agent: 'impl-y',
      role: 'implementer',
      parent: 'lead-1',
      projectId: p2.projectId,
      cwd: p2.cwd,
    });
    seedParentChain(p1.projectId, id1.parent);
    seedParentChain(p2.projectId, id2.parent);

    const { client: client1 } = await hostAndConnect(id1);
    const { client: client2 } = await hostAndConnect(id2);

    const res1 = await client1.callTool({ name: 'co_status', arguments: {} });
    const res2 = await client2.callTool({ name: 'co_status', arguments: {} });

    const s1 = res1.structuredContent as Record<string, unknown>;
    const s2 = res2.structuredContent as Record<string, unknown>;

    expect(s1.agent).toBe('impl-x');
    expect(s2.agent).toBe('impl-y');

    // No cross-pane leakage: each sees its own project.
    expect(s1.project_id).toBe(p1.projectId);
    expect(s2.project_id).toBe(p2.projectId);
    expect(s1.project_id).not.toBe(s2.project_id);
  });

  it('refuses a second simultaneous host for the same project agent until the first closes', async () => {
    const { projectId, cwd } = makeProject();
    const identity = makeHostedIdentity({
      agent: 'impl-x',
      role: 'implementer',
      parent: 'lead-1',
      projectId,
      cwd,
    });
    seedParentChain(projectId, identity.parent);

    const host = new LiveSessionHostImpl();
    const [, firstServerTransport] = InMemoryTransport.createLinkedPair();
    const first = await host.hostSession(identity, firstServerTransport);
    openedSessions.push(first);

    const [, duplicateServerTransport] = InMemoryTransport.createLinkedPair();
    await expect(host.hostSession(identity, duplicateServerTransport)).rejects.toThrow(
      /already has an active hosted MCP session/i,
    );

    await first.close();

    const [, nextServerTransport] = InMemoryTransport.createLinkedPair();
    const next = await host.hostSession(identity, nextServerTransport);
    openedSessions.push(next);
  });

  it('refuses a second simultaneous host for the same project agent across host instances', async () => {
    const { projectId, cwd } = makeProject();
    const identity = makeHostedIdentity({
      agent: 'impl-x',
      role: 'implementer',
      parent: 'lead-1',
      projectId,
      cwd,
    });
    seedParentChain(projectId, identity.parent);

    const firstHost = new LiveSessionHostImpl();
    const secondHost = new LiveSessionHostImpl();
    const [, firstServerTransport] = InMemoryTransport.createLinkedPair();
    const first = await firstHost.hostSession(identity, firstServerTransport);
    openedSessions.push(first);

    const [, duplicateServerTransport] = InMemoryTransport.createLinkedPair();
    await expect(secondHost.hostSession(identity, duplicateServerTransport)).rejects.toThrow(
      /already has an active hosted MCP session/i,
    );
  });

  it('refuses a second simultaneous host for the same project pane with a different agent', async () => {
    const { projectId, cwd } = makeProject();
    const firstIdentity = makeHostedIdentity({
      agent: 'impl-x',
      role: 'implementer',
      parent: 'lead-1',
      pane: 'pane-shared',
      projectId,
      cwd,
    });
    const secondIdentity = makeHostedIdentity({
      agent: 'impl-y',
      role: 'implementer',
      parent: 'lead-1',
      pane: 'pane-shared',
      projectId,
      cwd,
    });
    seedParentChain(projectId, firstIdentity.parent);

    const firstHost = new LiveSessionHostImpl();
    const secondHost = new LiveSessionHostImpl();
    const [, firstServerTransport] = InMemoryTransport.createLinkedPair();
    const first = await firstHost.hostSession(firstIdentity, firstServerTransport);
    openedSessions.push(first);

    const [, duplicateServerTransport] = InMemoryTransport.createLinkedPair();
    await expect(secondHost.hostSession(secondIdentity, duplicateServerTransport)).rejects.toThrow(
      /pane 'pane-shared' already has an active hosted MCP session/i,
    );
  });

  it('does not poison active guards when opening the session store throws', async () => {
    const { projectId, cwd } = makeProject();
    const identity = makeHostedIdentity({
      agent: 'impl-x',
      role: 'implementer',
      parent: 'lead-1',
      pane: 'pane-x',
      projectId,
      cwd,
    });
    seedParentChain(projectId, identity.parent);

    const throwingHost = new LiveSessionHostImpl(() => {
      throw new Error('open session store failed');
    });
    const [, failedTransport] = InMemoryTransport.createLinkedPair();
    await expect(throwingHost.hostSession(identity, failedTransport)).rejects.toThrow(
      /open session store failed/,
    );

    const normalHost = new LiveSessionHostImpl();
    const [, nextTransport] = InMemoryTransport.createLinkedPair();
    const session = await normalHost.hostSession(identity, nextTransport);
    openedSessions.push(session);
  });

  it('rolls back and allows re-host when MCP transport connection throws', async () => {
    const { projectId, cwd } = makeProject();
    const identity = makeHostedIdentity({
      agent: 'impl-x',
      role: 'implementer',
      parent: 'lead-1',
      pane: 'pane-x',
      projectId,
      cwd,
    });
    seedParentChain(projectId, identity.parent);

    const host = new LiveSessionHostImpl();
    const [, failingTransport] = InMemoryTransport.createLinkedPair();
    failingTransport.start = async () => {
      throw new Error('transport start failed');
    };
    await expect(host.hostSession(identity, failingTransport)).rejects.toThrow(
      /transport start failed/,
    );

    const sessions = openSessionStore(projectId);
    openedSessionStores.push(sessions);
    expect(sessions.getSession(identity.agent)).toBeUndefined();

    const [, nextTransport] = InMemoryTransport.createLinkedPair();
    const session = await host.hostSession(identity, nextTransport);
    openedSessions.push(session);
  });

  it('refuses a host when the B0 session store already has the pane active for another agent', async () => {
    const { projectId, cwd } = makeProject();
    const identity = makeHostedIdentity({
      agent: 'impl-y',
      role: 'implementer',
      parent: 'lead-1',
      pane: 'pane-shared',
      projectId,
      cwd,
    });
    seedParentChain(projectId, identity.parent);
    const sessions = openSessionStore(projectId);
    openedSessionStores.push(sessions);
    sessions.recordSession({
      agentId: 'impl-x',
      pane: 'pane-shared',
      cwd,
      provider: identity.provider,
      resume: identity.resume,
    });

    const host = new LiveSessionHostImpl();
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    await expect(host.hostSession(identity, serverTransport)).rejects.toThrow(
      /pane.*already hosted|duplicate pane/i,
    );
  });

  it('refuses a host when the B0 session store already has an active record', async () => {
    const { projectId, cwd } = makeProject();
    const identity = makeHostedIdentity({
      agent: 'impl-x',
      role: 'implementer',
      parent: 'lead-1',
      projectId,
      cwd,
    });
    seedParentChain(projectId, identity.parent);
    const sessions = openSessionStore(projectId);
    openedSessionStores.push(sessions);
    sessions.recordSession({
      agentId: identity.agent,
      pane: identity.pane,
      cwd,
      provider: identity.provider,
      resume: identity.resume,
    });

    const host = new LiveSessionHostImpl();
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    await expect(host.hostSession(identity, serverTransport)).rejects.toThrow(
      /already has an active session|duplicate host/i,
    );
  });

  it('close tears down the owned MCP transport, so later client calls fail loud', async () => {
    const { projectId, cwd } = makeProject();
    const identity = makeHostedIdentity({
      agent: 'impl-x',
      role: 'implementer',
      parent: 'lead-1',
      projectId,
      cwd,
    });
    seedParentChain(projectId, identity.parent);
    const { client, session } = await hostAndConnect(identity);

    await session.close();

    await expect(client.listTools()).rejects.toThrow(/not connected|closed/i);
  });
});

// ── AC-L7-8: no Conductor-control verb in the agent-facing registry ─────────

describe('AC-L7-8 — buildCoreRegistry registers zero Conductor/host/steer/pty/session verbs', () => {
  // The verbs that would indicate a Conductor-control tool was accidentally added.
  const CONDUCTOR_VERB_PATTERNS = [
    /^co_host/,
    /^co_steer/,
    /^co_session/,
    /^co_pty/,
    /^co_conductor/,
    /^co_launch/,
    /^co_spawn/,
  ];

  it('no registered tool name matches a Conductor-control verb pattern', () => {
    const registry = buildCoreRegistry();
    const toolNames = registry.list().map((t) => t.name);

    for (const name of toolNames) {
      for (const pattern of CONDUCTOR_VERB_PATTERNS) {
        expect(
          pattern.test(name),
          `tool '${name}' matches Conductor-control pattern ${pattern} — violates AC-L7-8`,
        ).toBe(false);
      }
    }
  });

  it('checkToolCompleteness returns [] — every declared tool is real, not a stub', () => {
    const registry = buildCoreRegistry();
    const violations = checkToolCompleteness(registry);
    expect(violations).toEqual([]);
  });

  it('no role toolset references a Conductor-control verb', () => {
    for (const role of BASE_ROLES as readonly Role[]) {
      const tools = toolsForRole(role);
      for (const spec of tools) {
        for (const pattern of CONDUCTOR_VERB_PATTERNS) {
          expect(
            pattern.test(spec.name),
            `role '${role}' toolset contains '${spec.name}' which matches Conductor-control pattern ${pattern}`,
          ).toBe(false);
        }
      }
    }
  });
});
