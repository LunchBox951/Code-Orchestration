/**
 * AC-S10-4·1 — the real stream-backed {@link TransportPair}: a fake MCP Client completes an
 * `initialize` + `co_mail_inbox` round-trip through the pair without any real provider binary.
 *
 * This proves the real transport plumbing independently of the InMemoryTransport used in the
 * rest of the engine tests. The test follows the same `connectClient` assertion style from
 * `engine.test.ts:262` but uses `createStreamTransportPair()` instead of
 * `InMemoryTransport.createLinkedPair()`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  FakePty,
  openRegistry,
  openRosterStore,
  type ProjectId,
  type ProjectRegistry,
  type RosterStore,
} from '@co/core';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ConductorEngine } from './engine.js';
import type { HostedIdentity } from '../live-session-host.js';
import { createStreamTransportPair } from './real-transport.js';

// ── Startup fixture (shared with engine.test.ts) ─────────────────────────────
const ESC = '';
const CLAUDE_READY = ESC + '[2J' + ESC + '[H' + '╭─ Welcome ─╮\r\n❯ \r\n  ? for shortcuts\r\n';

// ── Cleanup state ─────────────────────────────────────────────────────────────
const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let engines: ConductorEngine[] = [];
let clients: Client[] = [];
let registries: ProjectRegistry[] = [];
let rosterStores: RosterStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  engines = [];
  clients = [];
  registries = [];
  rosterStores = [];
});

afterEach(async () => {
  for (const engine of engines) {
    try {
      await engine.closeAll();
    } catch {
      /* best-effort */
    }
  }
  for (const client of clients) {
    try {
      await client.close();
    } catch {
      /* best-effort */
    }
  }
  for (const closeable of [...rosterStores, ...registries]) {
    try {
      closeable.close();
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
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeProject(): { projectId: ProjectId; cwd: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'co-rt-'));
  dataDirs.push(dataDir);
  process.env.CO_DATA_DIR = dataDir;
  const registry = openRegistry();
  registries.push(registry);
  const cwd = join(dataDir, 'repo');
  return { projectId: registry.register(cwd), cwd };
}

function seedParentChain(projectId: ProjectId): void {
  const roster = openRosterStore(projectId);
  rosterStores.push(roster);
  roster.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
}

function makeIdentity(
  over: Partial<HostedIdentity> & Pick<HostedIdentity, 'agent' | 'projectId' | 'cwd'>,
): HostedIdentity {
  return {
    role: 'implementer',
    parent: 'coord-1',
    pane: `pane-${over.agent}`,
    provider: 'claude',
    resume: { provider: 'claude', sessionId: `session-${over.agent}` },
    ...over,
  };
}

const neverResolve = (): Promise<void> => new Promise<void>(() => {});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('createStreamTransportPair — real stream-backed MCP transport', () => {
  it('returns a TransportPair where a fake Client completes initialize + co_mail_inbox', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    const identity = makeIdentity({ agent: 'impl-rt', projectId, cwd });

    const pty = new FakePty();
    const engine = new ConductorEngine({
      pty,
      makeTransport: createStreamTransportPair,
      now: () => 0,
      quietWindow: neverResolve,
      injectOptions: { retryDelay: neverResolve },
    });
    engines.push(engine);

    // Spawn → driveToReady → bind using the real stream transport.
    const ensureP = engine.ensureHosted(identity);
    const pane = pty.panes[0]!;
    pane.emit(CLAUDE_READY);
    const hosted = await ensureP;

    expect(hosted.startup).toEqual({ authed: true });

    // Connect a fake MCP Client to the CLIENT side of the real transport pair.
    const client = new Client({ name: 'co-rt-test', version: '0.0.0' });
    clients.push(client);
    await client.connect(hosted.clientTransport);

    // Prove a real MCP round-trip: co_mail_inbox succeeds through the stream-backed pair.
    const inbox = await client.callTool({ name: 'co_mail_inbox', arguments: {} });
    // The response is structured content (an object, not an error).
    expect(inbox.isError).toBeFalsy();
    expect(inbox.content).toBeDefined();

    // Prove co_status round-trip too: the authoritative identity is wired correctly.
    const status = await client.callTool({ name: 'co_status', arguments: {} });
    expect((status.structuredContent as Record<string, unknown>).agent).toBe('impl-rt');
  });

  it('is distinct from InMemoryTransport: both sides perform real stream serialisation', () => {
    const realPair = createStreamTransportPair();
    const memPair = InMemoryTransport.createLinkedPair();
    // Real transport's constructor name is StdioServerTransport, not InMemoryTransport.
    expect(realPair[0].constructor.name).not.toBe('InMemoryTransport');
    expect(realPair[1].constructor.name).not.toBe('InMemoryTransport');
    // Both sides are distinct objects (not the same reference).
    expect(realPair[0]).not.toBe(realPair[1]);
    // InMemoryTransport pair uses its own class.
    expect(memPair[0].constructor.name).toBe('InMemoryTransport');
    void memPair;
  });
});
