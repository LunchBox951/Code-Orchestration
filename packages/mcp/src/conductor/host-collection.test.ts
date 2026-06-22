/**
 * PR-B COLLECTION integration: prove the PRODUCTION host wiring (`host.ts`'s `makeTurnCostCapture` +
 * `makeToolActivityRecorder`, bound to the engine's `captureTurnCost` + `onToolActivity` seams) actually
 * RECORDS cost + tool usage into the project DispatchStore over a real engine-driven turn (FakePty + an
 * in-memory MCP transport — the same hermetic harness as engine.test.ts). This is the seam the prior
 * round left DEAD; here we exercise the engine→host→store path end-to-end (NOT the parser in isolation).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
  type DispatchStore,
  type ProjectId,
  type ProjectRegistry,
  type ToolInvoked,
} from '@co/core';
import { ConductorEngine, type ConductorEngineDeps, type HostedPane } from './engine.js';
import type { TurnCostCapture } from './engine.js';
import {
  claudeTurnCostToObservation,
  codexTurnCostToObservation,
  makeHostedUsageSourceFactory,
  makeTurnCostCapture,
  makeToolActivityRecorder,
} from './host.js';
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
    // Spy on the durable recordToolInvoked the recorder feeds the store so we can assert the host
    // recorder's activity.durationMs → tool.invoked duration_ms passthrough end-to-end (the adapter
    // layering rule forbids opening the store directly from the test to read the raw row).
    const recordedInvocations: ToolInvoked[] = [];
    const recordToolActivity = makeToolActivityRecorder(projectId, {
      openDispatch: (pid) => {
        const store = openDispatchStore(pid);
        return {
          ...store,
          recordToolInvoked: (inv) => {
            recordedInvocations.push(inv);
            return store.recordToolInvoked(inv);
          },
        } satisfies DispatchStore;
      },
    });

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
      expect(usage).toBeDefined();
      expect(usage!.toolCalls).toBeGreaterThanOrEqual(1);
      expect(usage!.toolErrors).toBe(0);
      expect(usage!.turnsToFirstProductiveCoCall).toBe(0); // co_status succeeded on turn 0

      // The host recorder mapped the server's activity.durationMs onto the durable tool.invoked
      // duration_ms (the rollup carries no duration column, so assert the recorded payload directly).
      const coStatusInv = recordedInvocations.find(
        (inv) => inv.agent === 'impl-x' && inv.tool === 'co_status',
      );
      expect(coStatusInv).toBeDefined();
      expect(typeof coStatusInv!.duration_ms).toBe('number');
      expect(coStatusInv!.duration_ms).toBeGreaterThanOrEqual(0);
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
      expect(store.getAgentCostRollup('impl-x')).toBeUndefined(); // nothing recorded — never a fabricated 0
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
    const diagnostics: unknown[] = [];
    const { engine, pty, clock, qw } = makeEngine({
      captureTurnCost,
      onCollectionError: (diagnostic) => diagnostics.push(diagnostic),
    });
    const hosted = await hostPane(engine, pty, identity);
    const pane = pty.panes[0]!;

    const turnP = engine.runOneTurn(hosted, item);
    await driveTurnToIdle(pane, item, clock, qw);
    const outcome = await turnP;

    expect(outcome.errored).toBe(false); // a thrown cost reader must not fail the turn
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({
      kind: 'cost',
      identity: { agent: 'impl-x' },
      turn: 0,
    });
    const store = openDispatchStore(projectId);
    try {
      expect(store.getAgentCostRollup('impl-x')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('a throwing tool-usage recorder is fail-soft but surfaced as a collection diagnostic', async () => {
    const { projectId, cwd } = makeProject();
    seedRoster(projectId);
    const item = seedActionableMail(projectId, 'impl-x');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const diagnostics: unknown[] = [];
    const { engine, pty, clock, qw } = makeEngine({
      onToolActivity: () => {
        throw new Error('tool store unavailable');
      },
      onCollectionError: (diagnostic) => diagnostics.push(diagnostic),
    });
    const hosted = await hostPane(engine, pty, identity);
    const pane = pty.panes[0]!;
    const client = new Client({ name: 'co-collect-tool-error-test', version: '0.0.0' });
    clients.push(client);
    await client.connect(hosted.clientTransport);

    const turnP = engine.runOneTurn(hosted, item, {
      onInjected: () => {
        void client.callTool({ name: 'co_status', arguments: {} });
      },
    });
    await tick();
    await tick();
    await driveTurnToIdle(pane, item, clock, qw);
    const outcome = await turnP;

    expect(outcome.errored).toBe(false);
    expect(diagnostics).toHaveLength(2); // start + end events both attempted durable collection.
    expect(diagnostics[0]).toMatchObject({
      kind: 'tool',
      identity: { agent: 'impl-x' },
      turn: 0,
    });
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

  it('does not re-record an unchanged transcript after restart and only records appended usage', async () => {
    const { projectId } = makeProject();
    const dataDir = process.env.CO_DATA_DIR!;
    const isolatedHomeDirFor = (agent: string): string => join(dataDir, 'isolated', agent);
    const home = isolatedHomeDirFor('impl-x');
    const transcriptPath = join(
      home,
      'projects',
      '-tmp-co-repo',
      'cccccccc-1111-2222-3333-444444444444.jsonl',
    );
    mkdirSync(join(home, 'projects', '-tmp-co-repo'), { recursive: true });
    writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 10, output_tokens: 5 } },
      }),
    );

    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd: join(dataDir, 'repo') });
    await makeTurnCostCapture(projectId, { isolatedHomeDirFor })({
      identity,
      turn: 0,
    } satisfies TurnCostCapture);
    await makeTurnCostCapture(projectId, { isolatedHomeDirFor })({
      identity,
      turn: 0,
    } satisfies TurnCostCapture);
    writeFileSync(
      transcriptPath,
      '\n' +
        JSON.stringify({
          type: 'assistant',
          message: { usage: { input_tokens: 30, output_tokens: 7 } },
        }),
      { flag: 'a' },
    );
    await makeTurnCostCapture(projectId, { isolatedHomeDirFor })({
      identity,
      turn: 0,
    } satisfies TurnCostCapture);

    const store = openDispatchStore(projectId);
    try {
      const rollup = store.getAgentCostRollup('impl-x');
      expect(rollup?.inputTokens).toBe(40);
      expect(rollup?.outputTokens).toBe(12);
      expect(rollup?.totalTokens).toBe(52);
      expect(store.getRollup('agent', 'impl-x')?.observations).toBe(2);
    } finally {
      store.close();
    }
  });

  it('does not switch to an unrelated newer Claude transcript once an active cursor exists', async () => {
    const { projectId } = makeProject();
    const dataDir = process.env.CO_DATA_DIR!;
    const isolatedHomeDirFor = (agent: string): string => join(dataDir, 'isolated', agent);
    const home = isolatedHomeDirFor('impl-x');
    const activeDir = join(home, 'projects', '-tmp-co-repo');
    const unrelatedDir = join(home, 'projects', '-tmp-other-repo');
    mkdirSync(activeDir, { recursive: true });
    mkdirSync(unrelatedDir, { recursive: true });
    const activePath = join(activeDir, 'active.jsonl');
    writeFileSync(
      activePath,
      JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 10, output_tokens: 5 } },
      }),
    );

    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd: join(dataDir, 'repo') });
    await makeTurnCostCapture(projectId, { isolatedHomeDirFor })({
      identity,
      turn: 0,
    } satisfies TurnCostCapture);

    writeFileSync(
      join(unrelatedDir, 'newer.jsonl'),
      JSON.stringify({
        type: 'assistant',
        message: { usage: { input_tokens: 999, output_tokens: 999 } },
      }),
    );
    const fresh = new Date(Date.now() + 60_000);
    utimesSync(join(unrelatedDir, 'newer.jsonl'), fresh, fresh);

    await makeTurnCostCapture(projectId, { isolatedHomeDirFor })({
      identity,
      turn: 1,
    } satisfies TurnCostCapture);

    const store = openDispatchStore(projectId);
    try {
      const rollup = store.getAgentCostRollup('impl-x');
      expect(rollup?.inputTokens).toBe(10);
      expect(rollup?.outputTokens).toBe(5);
      expect(store.getRollup('agent', 'impl-x')?.observations).toBe(1);
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
      expect(store.getAgentCostRollup('impl-x')).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

describe('host.ts collection — DEFAULT Codex logs_2.sqlite reader under isolated home', () => {
  function writeCodexLogsDb(isolatedHome: string, bodies?: readonly string[]): void {
    mkdirSync(isolatedHome, { recursive: true });
    const dbPath = join(isolatedHome, 'logs_2.sqlite');
    const rows = bodies ?? [
      'event.name="codex.sse_event" event.kind=response.completed ' +
        'input_token_count=222 output_token_count=33 cached_token_count=10 ' +
        'reasoning_token_count=5 tool_token_count=255 event.timestamp=2026-06-22T20:22:34.682Z',
    ];
    execFileSync(
      process.execPath,
      [
        '-e',
        `
          const { DatabaseSync } = require('node:sqlite');
          const rows = ${JSON.stringify(rows)};
          const db = new DatabaseSync(${JSON.stringify(dbPath)});
          db.exec('CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, feedback_log_body TEXT)');
          const insert = db.prepare('INSERT INTO logs (ts, feedback_log_body) VALUES (?, ?)');
          for (const [index, body] of rows.entries()) insert.run(index + 1, body);
          db.close();
        `,
      ],
      { env: { ...process.env, NODE_NO_WARNINGS: '1' } },
    );
  }

  it('opens ${isolatedHome}/logs_2.sqlite by default and records Codex token usage', async () => {
    const { projectId } = makeProject();
    const dataDir = process.env.CO_DATA_DIR!;
    const isolatedHomeDirFor = (agent: string): string => join(dataDir, 'isolated', agent);
    writeCodexLogsDb(isolatedHomeDirFor('codex-1'));
    const captureTurnCost = makeTurnCostCapture(projectId, { isolatedHomeDirFor });
    const identity = makeIdentity({
      agent: 'codex-1',
      projectId,
      cwd: join(dataDir, 'repo'),
    });
    const codexIdentity: HostedIdentity = {
      ...identity,
      provider: 'codex',
      resume: { provider: 'codex', codexHome: isolatedHomeDirFor('codex-1') },
    };

    await captureTurnCost({ identity: codexIdentity, turn: 0 } satisfies TurnCostCapture);

    const store = openDispatchStore(projectId);
    try {
      const rollup = store.getAgentCostRollup('codex-1');
      expect(rollup?.inputTokens).toBe(222);
      expect(rollup?.outputTokens).toBe(33);
      expect(rollup?.totalTokens).toBe(255);
      expect(rollup?.costUsd).toBeNull();
    } finally {
      store.close();
    }
  });

  it('does not re-record an unchanged latest Codex token row after capture restart', async () => {
    const { projectId } = makeProject();
    const dataDir = process.env.CO_DATA_DIR!;
    const isolatedHomeDirFor = (agent: string): string => join(dataDir, 'isolated', agent);
    writeCodexLogsDb(isolatedHomeDirFor('codex-1'));
    const identity = makeIdentity({
      agent: 'codex-1',
      projectId,
      cwd: join(dataDir, 'repo'),
    });
    const codexIdentity: HostedIdentity = {
      ...identity,
      provider: 'codex',
      resume: { provider: 'codex', codexHome: isolatedHomeDirFor('codex-1') },
    };

    await makeTurnCostCapture(projectId, { isolatedHomeDirFor })({
      identity: codexIdentity,
      turn: 0,
    } satisfies TurnCostCapture);
    await makeTurnCostCapture(projectId, { isolatedHomeDirFor })({
      identity: codexIdentity,
      turn: 0,
    } satisfies TurnCostCapture);

    const store = openDispatchStore(projectId);
    try {
      const rollup = store.getAgentCostRollup('codex-1');
      expect(rollup?.inputTokens).toBe(222);
      expect(rollup?.outputTokens).toBe(33);
      expect(rollup?.totalTokens).toBe(255);
      expect(store.getRollup('agent', 'codex-1')?.observations).toBe(1);
    } finally {
      store.close();
    }
  });
});

describe('host.ts collection — hosted Claude usage source reads the isolated statusLine file', () => {
  it('does not depend on daemon-global CO_CLAUDE_STATUSLINE_PATH', async () => {
    const { projectId } = makeProject();
    const dataDir = process.env.CO_DATA_DIR!;
    const isolatedHomeDirFor = (agent: string): string => join(dataDir, 'isolated', agent);
    const home = isolatedHomeDirFor('impl-x');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'co-statusline.json'),
      JSON.stringify({
        rate_limits: {
          five_hour: { used_percentage: 12, resets_at: '2026-06-22T21:00:00.000Z' },
        },
      }),
    );
    const binDir = join(dataDir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const fakeClaude = join(binDir, 'claude');
    writeFileSync(fakeClaude, '#!/usr/bin/env sh\necho \'{"logged_in":false,"plan":"max"}\'\n');
    chmodSync(fakeClaude, 0o755);
    process.env.PATH = `${binDir}:${process.env.PATH ?? ''}`;
    delete process.env.CO_CLAUDE_STATUSLINE_PATH;
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd: join(dataDir, 'repo') });
    const factory = makeHostedUsageSourceFactory(identity, isolatedHomeDirFor);

    const snapshot = await factory({ provider: 'claude', account: 'claude:max' }).read('claude');

    expect(snapshot.available).toBe(true);
    expect(snapshot.source).toBe('statusLine');
    expect(snapshot.account).toBe('claude:max');
    expect(snapshot.windows).toEqual([
      { kind: 'five_hour', used_pct: 12, reset_at: '2026-06-22T21:00:00.000Z' },
    ]);
  });
});

describe('host.ts collection — durable cost turn identity across capture restarts', () => {
  it('does not reuse turn 0 after the capture closure is recreated for an agent with prior cost', async () => {
    const { projectId } = makeProject();
    const dataDir = process.env.CO_DATA_DIR!;
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd: join(dataDir, 'repo') });

    const captureFirst = makeTurnCostCapture(projectId, {
      readClaudeTranscript: async () =>
        JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 10 } } }),
    });
    await captureFirst({ identity, turn: 0 } satisfies TurnCostCapture);

    const captureAfterRestart = makeTurnCostCapture(projectId, {
      readClaudeTranscript: async () =>
        JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 30 } } }),
    });
    await expect(
      captureAfterRestart({ identity, turn: 0 } satisfies TurnCostCapture),
    ).resolves.toBeUndefined();

    const store = openDispatchStore(projectId);
    try {
      const rollup = store.getAgentCostRollup('impl-x');
      expect(rollup?.inputTokens).toBe(40);
      expect(rollup?.totalTokens).toBe(0); // only input tokens were observed, no input+output pair.
      expect(store.getRollup('agent', 'impl-x')?.observations).toBe(2);
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

  function codexPerTurn(input: number, output: number, total: number): unknown {
    return {
      type: 'token_count',
      info: {
        last_token_usage: { input_tokens: input, output_tokens: output, total_tokens: total },
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

  it('treats a lower cumulative reading as a new Codex session boundary', async () => {
    const { projectId } = makeProject();
    const identity = makeIdentity({
      agent: 'codex-1',
      projectId,
      cwd: join(process.env.CO_DATA_DIR!, 'repo'),
    });
    const codexIdentity: HostedIdentity = { ...identity, provider: 'codex' };
    const readings = [codexCumulative(500, 100, 600), codexCumulative(50, 20, 70)];
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
      expect(rollup?.inputTokens).toBe(550);
      expect(rollup?.outputTokens).toBe(120);
      expect(rollup?.totalTokens).toBe(670);
      expect(store.getRollup('agent', 'codex-1')?.observations).toBe(2);
    } finally {
      store.close();
    }
  });

  it('uses the persisted cumulative source cursor after capture restart', async () => {
    const { projectId } = makeProject();
    const identity = makeIdentity({
      agent: 'codex-1',
      projectId,
      cwd: join(process.env.CO_DATA_DIR!, 'repo'),
    });
    const codexIdentity: HostedIdentity = { ...identity, provider: 'codex' };

    await makeTurnCostCapture(projectId, {
      readCodexTokenCount: async () => codexCumulative(500, 100, 600),
    })({ identity: codexIdentity, turn: 0 } satisfies TurnCostCapture);

    await makeTurnCostCapture(projectId, {
      readCodexTokenCount: async () => codexCumulative(700, 140, 840),
    })({ identity: codexIdentity, turn: 0 } satisfies TurnCostCapture);

    const store = openDispatchStore(projectId);
    try {
      const rollup = store.getAgentCostRollup('codex-1');
      expect(rollup?.inputTokens).toBe(700);
      expect(rollup?.outputTokens).toBe(140);
      expect(rollup?.totalTokens).toBe(840);
      expect(store.getRollup('agent', 'codex-1')?.observations).toBe(2);
    } finally {
      store.close();
    }
  });

  it('does not double-count a per-turn Codex row between cumulative readings', async () => {
    const { projectId } = makeProject();
    const identity = makeIdentity({
      agent: 'codex-1',
      projectId,
      cwd: join(process.env.CO_DATA_DIR!, 'repo'),
    });
    const codexIdentity: HostedIdentity = { ...identity, provider: 'codex' };
    const readings = [
      codexCumulative(100, 10, 110),
      codexPerTurn(20, 2, 22),
      codexCumulative(150, 15, 165),
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
      expect(rollup?.inputTokens).toBe(150);
      expect(rollup?.outputTokens).toBe(15);
      expect(rollup?.totalTokens).toBe(165);
      expect(store.getRollup('agent', 'codex-1')?.observations).toBe(3);
    } finally {
      store.close();
    }
  });
});

// ── The exported PURE field-mapping helpers, tested in isolation (their docstring's stated contract) ──
describe('host.ts collection — claude/codexTurnCostToObservation field mapping', () => {
  it('codexTurnCostToObservation maps usedPct onto used_pct', () => {
    const identity = makeIdentity({ agent: 'codex-1', projectId: 'p', cwd: '/tmp/repo' });
    const obs = codexTurnCostToObservation(
      { ...identity, provider: 'codex' },
      'codex-1',
      0,
      { totalTokens: 100, usedPct: 42 },
      'src',
    );
    expect(obs?.used_pct).toBe(42);
    expect(obs?.total_tokens).toBe(100);
  });

  it('claudeTurnCostToObservation maps cost_usd and the cache token fields', () => {
    const identity = makeIdentity({ agent: 'impl-x', projectId: 'p', cwd: '/tmp/repo' });
    const obs = claudeTurnCostToObservation(
      identity,
      'impl-x',
      0,
      {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 5000,
        cacheCreationInputTokens: 750,
        costUsd: 1.5,
      },
      'src',
    );
    expect(obs?.cost_usd).toBe(1.5);
    expect(obs?.cache_read_input_tokens).toBe(5000);
    expect(obs?.cache_creation_input_tokens).toBe(750);
  });
});
