/**
 * PR-B COLLECTION integration: prove the PRODUCTION host wiring (`host.ts`'s `makeTurnCostCapture` +
 * `makeToolActivityRecorder`, bound to the engine's `captureTurnCost` + `onToolActivity` seams) actually
 * RECORDS cost + tool usage into the project DispatchStore over a real engine-driven turn (FakePty + an
 * in-memory MCP transport — the same hermetic harness as engine.test.ts). This is the seam the prior
 * round left DEAD; here we exercise the engine→host→store path end-to-end (NOT the parser in isolation).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
import type { TurnCostCapture } from './engine.js';
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

// ── Fix-up: the DEFAULT reader against a real Claude Code transcript tree (the dead-seam catcher) ───
//
// This is the test the prior round LACKED: it does NOT inject a fixture readClaudeTranscript. It builds
// a temp isolated-home `projects/<slug>/<uuid>.jsonl` tree exactly as Claude Code writes (under
// CLAUDE_CONFIG_DIR = the isolated home) and drives the PRODUCTION default reader via makeTurnCostCapture
// with only `isolatedHomeDirFor` wired. The prior reader targeted `${home}/co-transcript-<agent>.jsonl`
// — a path nothing ever writes — so it would silently record nothing here (the dead seam).
describe('host.ts collection — DEFAULT Claude transcript reader over the real projects/**/*.jsonl tree', () => {
  function writeClaudeTranscript(
    isolatedHome: string,
    slug: string,
    uuid: string,
    lines: unknown[],
  ): void {
    const dir = join(isolatedHome, 'projects', slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${uuid}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n'));
  }

  it('the default reader globs projects/**/*.jsonl, picks the newest, and extracts the TurnUsage', async () => {
    const { projectId } = makeProject();
    const dataDir = process.env.CO_DATA_DIR!;
    const isolatedHomeDirFor = (agent: string): string => join(dataDir, 'isolated', agent);
    const home = isolatedHomeDirFor('impl-x');

    // An older transcript (a stale session) and a newer one (this session's). The default reader must
    // pick the NEWEST by mtime — so the recorded usage must be the newer file's, not the stale one's.
    writeClaudeTranscript(home, '-tmp-co-old', 'aaaaaaaa-1111-2222-3333-444444444444', [
      { type: 'assistant', message: { usage: { input_tokens: 1, output_tokens: 1 } } },
    ]);
    writeClaudeTranscript(home, '-tmp-co-repo', 'bbbbbbbb-5555-6666-7777-888888888888', [
      { type: 'user', message: { role: 'user', content: 'go' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          usage: {
            input_tokens: 321,
            output_tokens: 654,
            cache_read_input_tokens: 9876,
            cache_creation_input_tokens: 1234,
          },
        },
      },
    ]);
    // Make the second file unambiguously newer than the first.
    const old = new Date(Date.now() - 60_000);
    const fresh = new Date();
    utimesSync(
      join(home, 'projects', '-tmp-co-old', 'aaaaaaaa-1111-2222-3333-444444444444.jsonl'),
      old,
      old,
    );
    utimesSync(
      join(home, 'projects', '-tmp-co-repo', 'bbbbbbbb-5555-6666-7777-888888888888.jsonl'),
      fresh,
      fresh,
    );

    // The PRODUCTION default reader path: only isolatedHomeDirFor wired — NO injected readClaudeTranscript.
    const captureTurnCost = makeTurnCostCapture(projectId, { isolatedHomeDirFor });
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd: join(dataDir, 'repo') });
    await captureTurnCost({ identity, turn: 0 } satisfies TurnCostCapture);

    const store = openDispatchStore(projectId);
    try {
      const cost = store.getAgentCostRollup('impl-x');
      expect(cost).toEqual({
        agentId: 'impl-x',
        inputTokens: 321,
        outputTokens: 654,
        cacheReadTokens: 9876,
        cacheCreationTokens: 1234,
        totalTokens: 975, // input + output (no explicit total in the transcript)
        costUsd: null,
      });
    } finally {
      store.close();
    }
  });

  it('records NOTHING (never throws) when no projects transcript tree exists (fail-soft)', async () => {
    const { projectId } = makeProject();
    const dataDir = process.env.CO_DATA_DIR!;
    const isolatedHomeDirFor = (agent: string): string => join(dataDir, 'isolated', agent);
    // No projects/ tree written at all — the default reader must resolve undefined and record nothing.
    const captureTurnCost = makeTurnCostCapture(projectId, { isolatedHomeDirFor });
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd: join(dataDir, 'repo') });
    await expect(
      captureTurnCost({ identity, turn: 0 } satisfies TurnCostCapture),
    ).resolves.toBeUndefined();

    const store = openDispatchStore(projectId);
    try {
      expect(store.getAgentCostRollup('impl-x')).toBeNull();
    } finally {
      store.close();
    }
  });
});

// ── Fix-up: Codex cumulative `total_token_usage` is recorded as the PER-TURN DELTA (no over-count) ──
//
// Codex's `total_token_usage` is a session-running total. The prior wiring recorded it verbatim per
// turn, and cost_rollup SUMS observations → a cumulative-of-cumulatives over-count across turns. This
// drives a multi-turn Codex sequence through makeTurnCostCapture with an injected token-count reader
// returning rising cumulative totals, and asserts the rollup reflects per-turn deltas, not the sum.
describe('host.ts collection — Codex cumulative token_count is delta-d per turn', () => {
  function codexCumulative(input: number, output: number, total: number): unknown {
    return {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: input, output_tokens: output, total_tokens: total },
      },
    };
  }

  it('three rising cumulative readings roll up to the LAST cumulative, not the sum of cumulatives', async () => {
    const { projectId } = makeProject();
    const identity = makeIdentity({
      agent: 'codex-1',
      projectId,
      cwd: join(process.env.CO_DATA_DIR!, 'repo'),
    });
    const codexIdentity: HostedIdentity = { ...identity, provider: 'codex' };

    // Cumulative session totals after turns 0, 1, 2. Per-turn deltas: 100/40, +100/+60, +100/+60.
    const readings = [
      codexCumulative(100, 40, 140),
      codexCumulative(200, 100, 300),
      codexCumulative(300, 160, 460),
    ];
    let call = 0;
    const captureTurnCost = makeTurnCostCapture(projectId, {
      readCodexTokenCount: async () => readings[call++],
    });

    for (let turn = 0; turn < readings.length; turn++) {
      await captureTurnCost({ identity: codexIdentity, turn } satisfies TurnCostCapture);
    }

    const store = openDispatchStore(projectId);
    try {
      const rollup = store.getAgentCostRollup('codex-1');
      // The SUM of per-turn DELTAS equals the LAST cumulative reading (140 + 160 + 160 = 460 input,
      // 40 + 60 + 60 = 160 output). The buggy verbatim-cumulative path would have summed 100+200+300=600
      // input and 40+100+160=300 output (a cumulative-of-cumulatives over-count).
      expect(rollup?.inputTokens).toBe(300);
      expect(rollup?.outputTokens).toBe(160);
      expect(rollup?.totalTokens).toBe(460);
    } finally {
      store.close();
    }
  });
});
