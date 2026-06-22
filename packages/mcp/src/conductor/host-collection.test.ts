/**
 * PR-B COLLECTION integration: prove the PRODUCTION host wiring (`host.ts`'s `makeTurnCostCapture` +
 * `makeToolActivityRecorder`, bound to the engine's `captureTurnCost` + `onToolActivity` seams) actually
 * RECORDS cost + tool usage into the project DispatchStore over a real engine-driven turn (FakePty + an
 * in-memory MCP transport — the same hermetic harness as engine.test.ts). This is the seam the prior
 * round left DEAD; here we exercise the engine→host→store path end-to-end (NOT the parser in isolation).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  FakePty,
  defaultMailRenderer,
  openDispatchStore,
  openMailStore,
  openRegistry,
  openRosterStore,
  WEDGE_MS,
  type DeliveredMail,
  type ProjectId,
  type ProjectRegistry,
} from '@co/core';
import { ConductorEngine, type ConductorEngineDeps, type HostedPane } from './engine.js';
import { makeTurnCostCapture, makeToolActivityRecorder } from './host.js';
import type { HostedIdentity } from '../live-session-host.js';

const ESC = '\u001B';
const CLAUDE_READY = ESC + '[2J' + ESC + '[H' + '> Welcome\r\n> \r\n  ? for shortcuts\r\n';

const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let engines: ConductorEngine[] = [];
let clients: Client[] = [];
let registries: ProjectRegistry[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  engines = [];
  clients = [];
  registries = [];
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
  for (const r of registries) {
    try {
      r.close();
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

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function makeProject(): { projectId: ProjectId; cwd: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'co-host-collect-'));
  dataDirs.push(dataDir);
  process.env.CO_DATA_DIR = dataDir;
  const registry = openRegistry();
  registries.push(registry);
  const cwd = join(dataDir, 'repo');
  return { projectId: registry.register(cwd), cwd };
}

function seedRoster(projectId: ProjectId): void {
  const roster = openRosterStore(projectId);
  try {
    roster.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
    roster.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-1' });
    roster.recordAgent({ agentId: 'impl-x', role: 'implementer', parent: 'lead-1' });
  } finally {
    roster.close();
  }
}

function seedActionableMail(projectId: ProjectId, agent: string): DeliveredMail {
  const mail = openMailStore(projectId);
  try {
    return mail.send({
      type: 'clarify_request',
      to: agent,
      from: 'lead-1',
      subject: 'do the thing',
      body: 'please act',
    });
  } finally {
    mail.close();
  }
}

function makeIdentity(over: Pick<HostedIdentity, 'agent' | 'projectId' | 'cwd'>): HostedIdentity {
  return {
    role: 'implementer',
    parent: 'lead-1',
    pane: `pane-${over.agent}`,
    provider: 'claude',
    resume: { provider: 'claude', sessionId: `session-${over.agent}` },
    ...over,
  };
}

function makeClock(): { now: () => number; set: (t: number) => void } {
  let t = 0;
  return { now: () => t, set: (next) => void (t = next) };
}

function makeQuietWindow(): {
  quietWindow: (signal: AbortSignal) => Promise<void>;
  settle: () => void;
} {
  const waiters = new Set<() => void>();
  return {
    quietWindow: (signal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          waiters.delete(finish);
          signal.removeEventListener('abort', finish);
          resolve();
        };
        signal.addEventListener('abort', finish, { once: true });
        waiters.add(finish);
      }),
    settle: () => {
      for (const w of [...waiters]) w();
    },
  };
}

function makeEngine(over: Partial<ConductorEngineDeps>): {
  engine: ConductorEngine;
  pty: FakePty;
  clock: ReturnType<typeof makeClock>;
  qw: ReturnType<typeof makeQuietWindow>;
} {
  const pty = new FakePty();
  const clock = makeClock();
  const qw = makeQuietWindow();
  const engine = new ConductorEngine({
    pty,
    makeTransport: () => InMemoryTransport.createLinkedPair(),
    now: clock.now,
    quietWindow: qw.quietWindow,
    injectOptions: { retryDelay: () => new Promise<void>(() => {}) },
    ...over,
  });
  engines.push(engine);
  return { engine, pty, clock, qw };
}

async function hostPane(
  engine: ConductorEngine,
  pty: FakePty,
  identity: HostedIdentity,
): Promise<HostedPane> {
  const ensureP = engine.ensureHosted(identity);
  const pane = pty.panes[pty.panes.length - 1]!;
  pane.emit(CLAUDE_READY);
  return ensureP;
}

async function driveTurnToIdle(
  pane: FakePty['panes'][number],
  item: DeliveredMail,
  clock: ReturnType<typeof makeClock>,
  qw: ReturnType<typeof makeQuietWindow>,
): Promise<void> {
  await tick();
  pane.emit(defaultMailRenderer(item));
  await tick();
  clock.set(1000);
  pane.emit('⠋ working…\r\n');
  await tick();
  clock.set(1000 + WEDGE_MS + 1);
  qw.settle();
}

describe('host.ts collection wiring — records cost + tool usage over a production-shaped turn', () => {
  it('captureTurnCost records the agent cost rollup; onToolActivity records tool usage', async () => {
    const { projectId, cwd } = makeProject();
    seedRoster(projectId);
    const item = seedActionableMail(projectId, 'impl-x');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });

    // A fixture Claude transcript JSONL — the host's captureTurnCost reads this in production.
    const transcriptJsonl = JSON.stringify({
      type: 'assistant',
      message: {
        usage: {
          input_tokens: 200,
          output_tokens: 400,
          cache_read_input_tokens: 5000,
          cache_creation_input_tokens: 750,
        },
      },
    });

    // The PRODUCTION host factories, wired exactly as serveConductor wires them onto the engine.
    const captureTurnCost = makeTurnCostCapture(projectId, {
      readClaudeTranscript: async () => transcriptJsonl,
    });
    const recordToolActivity = makeToolActivityRecorder(projectId);

    const { engine, pty, clock, qw } = makeEngine({
      captureTurnCost,
      onToolActivity: recordToolActivity,
    });

    const hosted = await hostPane(engine, pty, identity);
    const pane = pty.panes[0]!;

    // The live provider (an MCP client on the bound transport) makes a productive co_* call this turn.
    const client = new Client({ name: 'co-collect-test', version: '0.0.0' });
    clients.push(client);
    await client.connect(hosted.clientTransport);

    // Run ONE turn; mid-turn the provider calls co_status (a productive co_* tool → tool.invoked).
    const turnP = engine.runOneTurn(hosted, item, {
      onInjected: () => {
        void client.callTool({ name: 'co_status', arguments: {} });
      },
    });
    // Let the tool call complete (records tool.invoked) before driving to idle.
    await tick();
    await tick();
    await driveTurnToIdle(pane, item, clock, qw);
    const outcome = await turnP;
    expect(outcome.errored).toBe(false);

    // The cost capture ran in the turn-end region and recorded the transcript usage.
    const store = openDispatchStore(projectId);
    try {
      const cost = store.getAgentCostRollup('impl-x');
      expect(cost).toEqual({
        agentId: 'impl-x',
        inputTokens: 200,
        outputTokens: 400,
        cacheReadTokens: 5000,
        cacheCreationTokens: 750,
        totalTokens: 600,
        costUsd: null, // no result line in this fixture ⇒ no dollar cost reported
      });

      // The tool activity was recorded into the durable per-agent tool-usage projection.
      const usage = store.getAgentToolUsage('impl-x');
      expect(usage).not.toBeNull();
      expect(usage!.toolCalls).toBeGreaterThanOrEqual(1);
      expect(usage!.toolErrors).toBe(0);
      expect(usage!.turnsToFirstProductiveCoCall).toBe(0); // co_status succeeded on turn 0
    } finally {
      store.close();
    }
  });

  it('a missing transcript records NO cost and never fails the turn (fail-soft)', async () => {
    const { projectId, cwd } = makeProject();
    seedRoster(projectId);
    const item = seedActionableMail(projectId, 'impl-x');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });

    // The reader resolves undefined (no transcript yet) — the capture must record nothing, not throw.
    const captureTurnCost = makeTurnCostCapture(projectId, {
      readClaudeTranscript: async () => undefined,
    });
    const { engine, pty, clock, qw } = makeEngine({ captureTurnCost });
    const hosted = await hostPane(engine, pty, identity);
    const pane = pty.panes[0]!;

    const turnP = engine.runOneTurn(hosted, item);
    await driveTurnToIdle(pane, item, clock, qw);
    const outcome = await turnP;

    expect(outcome.errored).toBe(false); // the turn still completed cleanly
    const store = openDispatchStore(projectId);
    try {
      expect(store.getAgentCostRollup('impl-x')).toBeNull(); // nothing recorded — never a fabricated 0
    } finally {
      store.close();
    }
  });

  it('a throwing transcript reader is swallowed — the turn still yields ok (fail-soft)', async () => {
    const { projectId, cwd } = makeProject();
    seedRoster(projectId);
    const item = seedActionableMail(projectId, 'impl-x');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });

    const captureTurnCost = makeTurnCostCapture(projectId, {
      readClaudeTranscript: async () => {
        throw new Error('disk gone');
      },
    });
    const { engine, pty, clock, qw } = makeEngine({ captureTurnCost });
    const hosted = await hostPane(engine, pty, identity);
    const pane = pty.panes[0]!;

    const turnP = engine.runOneTurn(hosted, item);
    await driveTurnToIdle(pane, item, clock, qw);
    const outcome = await turnP;

    expect(outcome.errored).toBe(false); // a thrown cost reader must not fail the turn
    const store = openDispatchStore(projectId);
    try {
      expect(store.getAgentCostRollup('impl-x')).toBeNull();
    } finally {
      store.close();
    }
  });
});
