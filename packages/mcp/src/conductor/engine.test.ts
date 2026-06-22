/**
 * P1a [sandbox] acceptance for the Conductor engine (AC-S9-1, slice a). Over `FakePty` + an in-memory
 * MCP transport, a deterministic test proves the single-turn cycle:
 *   select a WAITING agent with outstanding actionable mail → ensure its pane (spawn) → driveToReady →
 *   bind LiveSessionHostImpl MCP under the AUTHORITATIVE identity → injectMail → run EXACTLY ONE turn →
 *   detectTurnEnd (idle, NOT "done"; completion stays verb-keyed) → yield.
 * Plus the MNR-5 launch-authority refusal and the MNR-2 errored-turn-doesn't-drop-mail seam.
 *
 * Determinism: NO wall clock in the testable path. `now` reads a mutable counter; `quietWindow` is a
 * controllable settle seam (resolves on `settle()` or on the engine's re-arm abort). Like the landed pty
 * fixtures, the pane is driven by emitting scripted bytes right after each async step is launched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  FakePty,
  MAIL_APPROVAL_RESPONSE,
  MAIL_CLARIFY_RESPONSE,
  MAIL_WORKER_DONE,
  defaultMailRenderer,
  turnKickoffCorrelationId,
  openMailStore,
  openRegistry,
  openRosterStore,
  openSessionStore,
  WEDGE_MS,
  type DeliveredMail,
  type DetectorEvent,
  type MailStore,
  type ProjectId,
  type ProjectRegistry,
  type RosterStore,
} from '@co/core';
import {
  ConductorEngine,
  selectEligible,
  transcriptTailFrom,
  TRANSCRIPT_TAIL_MAX_CHARS,
  TRANSCRIPT_TAIL_HARD_MAX_CHARS,
  type ConductorEngineDeps,
  type HostedPane,
  type RouteFailure,
} from './engine.js';
import type { HostedIdentity } from '../live-session-host.js';

// ── Scripted startup fixture: a claude session that is ready immediately (no interstitial). ──
// ESC authored as a `\u` escape so the SOURCE holds no raw control byte (the C2 pristine-repo rule).
const ESC = '\u001B';
const CLAUDE_READY = ESC + '[2J' + ESC + '[H' + '╭─ Welcome ─╮\r\n❯ \r\n  ? for shortcuts\r\n';
const CLEAR_SCREEN = ESC + '[2J' + ESC + '[H';
const CLAUDE_PERMISSION =
  CLEAR_SCREEN +
  'Claude wants to use co_mail_send.\nDo you want to proceed?\n' +
  ESC +
  '[1m❯ 1. Yes\n  2. No\n';

// ── Cleanup state ────────────────────────────────────────────────────────────
const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let engines: ConductorEngine[] = [];
let clients: Client[] = [];
let registries: ProjectRegistry[] = [];
let mailStores: MailStore[] = [];
let rosterStores: RosterStore[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  engines = [];
  clients = [];
  registries = [];
  mailStores = [];
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
  for (const closeable of [...mailStores, ...rosterStores, ...registries]) {
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

// ── Helpers ────────────────────────────────────────────────────────────────
/** Drain microtasks + a macrotask so a launched async step advances to its next await. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
/** A few ticks, for steps with several chained internal awaits (e.g. the MCP bind handshake). */
const flush = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i++) await tick();
};

/** Register a fresh temp project; sets CO_DATA_DIR so every store opens under one program-data dir. */
function makeProject(): { projectId: ProjectId; cwd: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'co-eng-'));
  dataDirs.push(dataDir);
  process.env.CO_DATA_DIR = dataDir;
  const registry = openRegistry();
  registries.push(registry);
  const cwd = join(dataDir, 'repo');
  return { projectId: registry.register(cwd), cwd };
}

/** Seed the parent chain a real Conductor spawn would have recorded (mirrors live-session-host tests). */
function seedParentChain(projectId: ProjectId, parent: string): void {
  const roster = openRosterStore(projectId);
  rosterStores.push(roster);
  if (parent === '@operator') return;
  roster.recordAgent({ agentId: 'coord-1', role: 'coordinator', parent: '@operator' });
  if (parent === 'coord-1') return;
  if (parent === 'lead-1') {
    roster.recordAgent({ agentId: 'lead-1', role: 'lead', parent: 'coord-1' });
    return;
  }
  throw new Error(`test fixture does not know how to seed parent '${parent}'`);
}

function makeIdentity(
  over: Partial<HostedIdentity> & Pick<HostedIdentity, 'agent' | 'projectId' | 'cwd'>,
): HostedIdentity {
  return {
    role: 'implementer',
    parent: 'lead-1',
    pane: `pane-${over.agent}`,
    provider: 'claude',
    resume: { provider: 'claude', sessionId: `session-${over.agent}` },
    ...over,
  };
}

/** Send an outstanding actionable item (`clarify_request`) to `agent` so selection treats it as eligible. */
function seedActionableMail(projectId: ProjectId, agent: string, from = 'lead-1'): void {
  const mail = openMailStore(projectId);
  try {
    mail.send({
      type: 'clarify_request',
      to: agent,
      from,
      subject: 'do the thing',
      body: 'please act',
    });
  } finally {
    mail.close();
  }
}

/** Seed a one-shot kickoff (`clarify_request` carrying the turn-kickoff correlation id) for `agent`. */
function seedKickoffMail(projectId: ProjectId, agent: string): void {
  const mail = openMailStore(projectId);
  try {
    mail.send({
      type: 'clarify_request',
      to: agent,
      from: '@operator',
      subject: 'Operator kickoff',
      body: 'orchestrate the thing',
      correlationId: turnKickoffCorrelationId(agent),
    });
  } finally {
    mail.close();
  }
}

/** Open a tracked mail store and read the first outstanding actionable item for `agent`. */
function outstandingItem(projectId: ProjectId, agent: string): DeliveredMail {
  const store = openMailStore(projectId);
  mailStores.push(store);
  const item = store.outstanding(agent)[0];
  if (item == null) throw new Error(`test expected an outstanding item for '${agent}'`);
  return item;
}

/** Count a tracked agent's outstanding actionable items. */
function outstandingCount(projectId: ProjectId, agent: string): number {
  const store = openMailStore(projectId);
  mailStores.push(store);
  return store.outstanding(agent).length;
}

/** A mutable monotonic clock — the DATA the detector reads (never a wall clock). */
function makeClock(): { now: () => number; set: (t: number) => void } {
  let t = 0;
  return { now: () => t, set: (next) => void (t = next) };
}

/** A controllable byte-quiet window: each armed call resolves on `settle()` OR on its own re-arm abort. */
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

/** Build engine deps over a FakePty + in-memory transports + the injected clock/quiet-window seams. */
function makeEngine(over: Partial<ConductorEngineDeps> = {}): {
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
    // A never-resolving retry seam: only the composer echo can advance injection (no timer flakiness).
    injectOptions: { retryDelay: () => new Promise<void>(() => {}) },
    ...over,
  });
  engines.push(engine);
  return { engine, pty, clock, qw };
}

/** Drive a hosted pane through ONE idle turn: echo the injected text, emit turn bytes, then settle quiet. */
async function driveTurnToIdle(
  pane: FakePty['panes'][number],
  item: DeliveredMail,
  clock: ReturnType<typeof makeClock>,
  qw: ReturnType<typeof makeQuietWindow>,
): Promise<void> {
  await tick(); // injectMail has written the payload and is awaiting the echo
  pane.emit(defaultMailRenderer(item)); // composer echoes the injected text → exactly one Enter
  await tick(); // injectMail submits; observeTurnEnd arms the first quiet window
  clock.set(1000);
  pane.emit('⠋ working…\r\n'); // the turn produces bytes, then goes quiet
  await tick(); // the new bytes re-arm the quiet window
  clock.set(1000 + WEDGE_MS + 1);
  qw.settle(); // the window elapses with no further output ⇒ idle
}

/** Spawn + drive a pane to ready, returning the warm handle and its FakePty pane (for driving). */
async function hostPane(
  engine: ConductorEngine,
  pty: FakePty,
  identity: HostedIdentity,
): Promise<{ hosted: HostedPane; pane: FakePty['panes'][number] }> {
  const ensureP = engine.ensureHosted(identity);
  const pane = pty.panes[pty.panes.length - 1]!; // spawned synchronously before the first await
  pane.emit(CLAUDE_READY);
  const hosted = await ensureP;
  return { hosted, pane };
}

/** Connect a tracked MCP client to a hosted pane's client transport (the live provider's seam). */
async function connectClient(hosted: HostedPane): Promise<Client> {
  const client = new Client({ name: 'co-eng-test', version: '0.0.0' });
  clients.push(client);
  await client.connect(hosted.clientTransport);
  return client;
}

// ── selection ────────────────────────────────────────────────────────────────
describe('selectEligible — a WAITING agent with an outstanding injectable actionable item', () => {
  it('picks the candidate with outstanding actionable mail and skips the idle one', () => {
    const { projectId, cwd } = makeProject();
    seedActionableMail(projectId, 'impl-busy');
    const idle = makeIdentity({ agent: 'impl-idle', projectId, cwd });
    const busy = makeIdentity({ agent: 'impl-busy', projectId, cwd });

    const selected = selectEligible([idle, busy], openMailStore);
    expect(selected?.identity.agent).toBe('impl-busy');
    expect(selected?.mail.subject).toBe('do the thing');
  });

  it('returns undefined when no candidate has outstanding actionable mail', () => {
    const { projectId, cwd } = makeProject();
    const idle = makeIdentity({ agent: 'impl-idle', projectId, cwd });
    expect(selectEligible([idle], openMailStore)).toBeUndefined();
  });

  it.each([
    [MAIL_WORKER_DONE, 'worker finished'],
    [MAIL_CLARIFY_RESPONSE, 'operator answered'],
    [MAIL_APPROVAL_RESPONSE, 'operator approved'],
  ] as const)(
    'falls back to unread %s wake mail when no actionable item is outstanding',
    (type, subject) => {
      const { projectId, cwd } = makeProject();
      const store = openMailStore(projectId);
      mailStores.push(store);
      const wake = store.send({
        type,
        to: 'lead-1',
        from: type === MAIL_WORKER_DONE ? 'impl-x' : '@operator',
        subject,
        body: 'continue',
        ...(type === MAIL_APPROVAL_RESPONSE ? { decision: 'approve' as const } : {}),
      });
      const lead = makeIdentity({
        agent: 'lead-1',
        role: 'lead',
        parent: 'coord-1',
        projectId,
        cwd,
      });

      const selected = selectEligible([lead], openMailStore);
      expect(selected?.identity.agent).toBe('lead-1');
      expect(selected?.mail.seq).toBe(wake.seq);
    },
  );
});

// ── the keystone single-turn cycle ────────────────────────────────────────────
describe('ConductorEngine — ensure-hosted → bind → inject → ONE turn → detect → yield', () => {
  it('starts the MCP transport before waiting for provider startup', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const identity = makeIdentity({ agent: 'impl-prebind', projectId, cwd });
    const transportAgents: string[] = [];
    const { engine, pty } = makeEngine({
      makeTransport: (id: HostedIdentity) => {
        transportAgents.push(id.agent);
        return InMemoryTransport.createLinkedPair();
      },
    });

    const ensureP = engine.ensureHosted(identity);
    expect(pty.panes).toHaveLength(1);
    await flush();

    expect(transportAgents).toEqual(['impl-prebind']);

    pty.panes[0]!.emit(CLAUDE_READY);
    await expect(ensureP).resolves.toBeDefined();
  });

  it('drives the full cycle deterministically and yields on an idle (not "done") turn', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    seedActionableMail(projectId, 'impl-x');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, pty, clock, qw } = makeEngine();

    // ensure-hosted: spawn → driveToReady → bind MCP.
    const ensureP = engine.ensureHosted(identity);
    expect(pty.panes).toHaveLength(1); // spawned synchronously before the first await
    const pane = pty.panes[0]!;
    expect(pane.spec.command).toBe('claude');
    expect(pane.spec.cwd).toBe(cwd);
    pane.emit(CLAUDE_READY); // drive startup to ready
    const hosted = await ensureP;
    expect(hosted.startup).toEqual({ authed: true });
    expect(engine.isHosted(projectId, 'impl-x')).toBe(true);

    // The bind used the AUTHORITATIVE identity (AC-L7-2): a client on the bound transport is impl-x.
    const client = new Client({ name: 'co-eng-test', version: '0.0.0' });
    clients.push(client);
    await client.connect(hosted.clientTransport);
    const status = await client.callTool({ name: 'co_status', arguments: {} });
    expect((status.structuredContent as Record<string, unknown>).agent).toBe('impl-x');

    // run EXACTLY ONE turn over a synthesized byte trace.
    const item = outstandingItem(projectId, 'impl-x');
    const turnP = engine.runOneTurn(hosted, item);
    await driveTurnToIdle(pane, item, clock, qw);
    const outcome = await turnP;

    // turn-end is idle, and it is NOT "done" — no completion verb was seen.
    expect(outcome.errored).toBe(false);
    expect(outcome.turnEnd?.idle).toBe(true);
    expect(outcome.turnEnd?.sawCompletionVerb).toBe(false);
    expect(outcome.turnEnd?.idleSignals).toContain('byte-quiescence');

    // EXACTLY one turn: the composer received exactly one submit (Enter); the cycle never injected twice.
    expect(pane.written.filter((w) => w === '\r')).toHaveLength(1);
    // yield = the pane stays WARM (not torn down) for the next turn.
    expect(engine.isHosted(projectId, 'impl-x')).toBe(true);
  });

  it('runCycle selects, hosts, and runs one turn end-to-end', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    seedActionableMail(projectId, 'impl-x');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, pty, clock, qw } = makeEngine();

    const cycleP = engine.runCycle([identity]);
    expect(pty.panes).toHaveLength(1); // selected + spawned before the first await
    const pane = pty.panes[0]!;
    pane.emit(CLAUDE_READY);
    await flush(); // driveToReady resolves, the MCP bind completes, injectMail starts
    const item = outstandingItem(projectId, 'impl-x');
    await driveTurnToIdle(pane, item, clock, qw);
    const outcome = await cycleP;

    expect(outcome?.mail.subject).toBe('do the thing');
    expect(outcome?.turn.errored).toBe(false);
    expect(outcome?.turn.turnEnd?.idle).toBe(true);
    expect(outcome?.turn.turnEnd?.sawCompletionVerb).toBe(false);
  });

  it('runCycle returns null when no candidate is eligible', async () => {
    const { projectId, cwd } = makeProject();
    const identity = makeIdentity({ agent: 'impl-idle', projectId, cwd });
    const { engine, pty } = makeEngine();
    expect(await engine.runCycle([identity])).toBeNull();
    expect(pty.panes).toHaveLength(0); // nothing eligible ⇒ nothing spawned
  });

  it.each([
    [MAIL_WORKER_DONE, 'impl-x', 'worker_done: co/x'],
    [MAIL_APPROVAL_RESPONSE, '@operator', 'Re: approve action'],
  ] as const)(
    'runCycle marks an informational %s wake item read only after the turn performs MCP work',
    async (type, from, subject) => {
      const { projectId, cwd } = makeProject();
      seedParentChain(projectId, 'coord-1');
      const store = openMailStore(projectId);
      mailStores.push(store);
      const wake =
        type === MAIL_APPROVAL_RESPONSE
          ? store.send({
              type,
              to: 'lead-1',
              from,
              subject,
              body: 'approved',
              decision: 'approve',
            })
          : store.send({
              type,
              to: 'lead-1',
              from,
              subject,
              body: 'finished',
            });
      const identity = makeIdentity({
        agent: 'lead-1',
        role: 'lead',
        parent: 'coord-1',
        projectId,
        cwd,
      });
      const { engine, pty, clock, qw } = makeEngine({
        mcpActivity: (_pane, push) => {
          push({ kind: 'mcp', at: 1000, verb: 'co_merge' } satisfies DetectorEvent);
          return () => {};
        },
      });

      const cycleP = engine.runCycle([identity]);
      expect(pty.panes).toHaveLength(1);
      const pane = pty.panes[0]!;
      pane.emit(CLAUDE_READY);
      await flush();
      await driveTurnToIdle(pane, wake, clock, qw);
      const outcome = await cycleP;

      expect(outcome?.mail.seq).toBe(wake.seq);
      expect(outcome?.turn.errored).toBe(false);
      expect(store.inbox('lead-1').find((item) => item.seq === wake.seq)?.read).toBe(true);
      expect(selectEligible([identity], openMailStore)).toBeUndefined();
    },
  );

  it('keeps the permission dialog watcher attached for the full post-submit turn', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    seedActionableMail(projectId, 'impl-x');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, pty, clock, qw } = makeEngine();
    const { hosted, pane } = await hostPane(engine, pty, identity);

    const item = outstandingItem(projectId, 'impl-x');
    const turnP = engine.runOneTurn(hosted, item);
    await tick(); // injectMail has written the payload and is awaiting the echo
    pane.emit(defaultMailRenderer(item));
    await tick(); // injectMail submitted; observeTurnEnd is now watching the provider turn

    const writeCountBeforeDialog = pane.written.length;
    clock.set(1000);
    pane.emit(CLAUDE_PERMISSION);
    await tick();

    expect(pane.written.slice(writeCountBeforeDialog)).toEqual(['\r']);

    clock.set(1000 + WEDGE_MS + 1);
    qw.settle();
    const outcome = await turnP;
    expect(outcome.errored).toBe(false);
    expect(outcome.turnEnd?.idle).toBe(true);
  });
});

// ── F5: a one-shot kickoff is consumed after a single driven turn (never re-injected) ──────────
describe('ConductorEngine — one-shot kickoff consumption (F5)', () => {
  it('retracts a one-shot kickoff after a non-errored turn EVEN without MCP activity', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    seedKickoffMail(projectId, 'impl-x');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    // No mcpActivity seam → sawMcpActivity is false; the prior code left the kickoff outstanding and
    // the daemon re-injected it every tick (the ~8× operator-kickoff duplication).
    const { engine, pty, clock, qw } = makeEngine();
    const { hosted, pane } = await hostPane(engine, pty, identity);

    expect(outstandingCount(projectId, 'impl-x')).toBe(1);
    const item = outstandingItem(projectId, 'impl-x');
    const turnP = engine.runOneTurn(hosted, item);
    await driveTurnToIdle(pane, item, clock, qw);
    const outcome = await turnP;

    expect(outcome.errored).toBe(false);
    // The kickoff has served its purpose and is retracted — a second tick would select nothing.
    expect(outstandingCount(projectId, 'impl-x')).toBe(0);
  });

  it('does NOT consume ordinary actionable mail on a turn without MCP activity (no over-consume)', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    seedActionableMail(projectId, 'impl-x'); // a normal clarify_request, NOT a kickoff
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, pty, clock, qw } = makeEngine();
    const { hosted, pane } = await hostPane(engine, pty, identity);

    const item = outstandingItem(projectId, 'impl-x');
    const turnP = engine.runOneTurn(hosted, item);
    await driveTurnToIdle(pane, item, clock, qw);
    await turnP;

    // A non-kickoff item without MCP progress stays outstanding (MNR-2: re-injected until acted on).
    expect(outstandingCount(projectId, 'impl-x')).toBe(1);
  });
});

// ── #68: a transient overload backs the agent off instead of re-injecting every tick ───────────
describe('ConductorEngine — transient-overload backoff (#68)', () => {
  it('keeps mail outstanding and skips re-selection after an overload turn with no MCP progress', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    seedActionableMail(projectId, 'impl-x');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, pty, clock, qw } = makeEngine(); // no mcpActivity seam → no MCP progress
    const { hosted, pane } = await hostPane(engine, pty, identity);

    const item = outstandingItem(projectId, 'impl-x');
    const turnP = engine.runOneTurn(hosted, item);
    await tick();
    pane.emit(defaultMailRenderer(item));
    await tick();
    clock.set(1000);
    pane.emit('API Error: 529 {"type":"overloaded_error"}\r\n'); // the provider could not work
    await tick();
    clock.set(1000 + WEDGE_MS + 1);
    qw.settle();
    const outcome = await turnP;

    expect(outcome.errored).toBe(false);
    // The mail is NOT consumed (it must be retried once the provider recovers)...
    expect(outstandingCount(projectId, 'impl-x')).toBe(1);
    // ...and the agent is in a backoff window, so the next cycle SKIPS it (no re-inject storm).
    expect(await engine.runCycle([identity])).toBeNull();

    // After the backoff window elapses, the agent is selectable again (a clean turn would clear it).
    clock.set(1000 + WEDGE_MS + 1 + 5_000); // > nextRewakeAt (observedAt + 1s for the first attempt)
    const resumed = engine.runCycle([identity]);
    await driveTurnToIdle(pane, item, clock, qw);
    expect(await resumed).not.toBeNull();
  });

  it('does NOT back off a normal (non-overload) turn', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    seedActionableMail(projectId, 'impl-x');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, pty, clock, qw } = makeEngine();
    const { hosted, pane } = await hostPane(engine, pty, identity);

    const item = outstandingItem(projectId, 'impl-x');
    const turnP = engine.runOneTurn(hosted, item);
    await driveTurnToIdle(pane, item, clock, qw); // emits a normal working spinner, no overload
    await turnP;

    // A normal turn does not back off — the agent stays immediately selectable.
    const next = engine.runCycle([identity]);
    await driveTurnToIdle(pane, item, clock, qw);
    expect(await next).not.toBeNull();
  });
});

// ── #73: concurrent-launch + mid-turn release safety ───────────────────────────────────────────
describe('ConductorEngine — concurrent-launch + mid-turn release safety (#73)', () => {
  it('collapses concurrent ensureHosted for one agent to a single launch (no double-spawn)', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, pty } = makeEngine();

    const p1 = engine.ensureHosted(identity);
    const p2 = engine.ensureHosted(identity); // shares the in-flight launch — must NOT spawn a 2nd pane
    expect(pty.panes.length).toBe(1);
    pty.panes[0]!.emit(CLAUDE_READY);
    const [h1, h2] = await Promise.all([p1, p2]);
    expect(h1).toBe(h2); // same hosted handle
    expect(pty.panes.length).toBe(1); // still exactly one live pane
  });

  it('defers the pane kill to the turn boundary when release() arrives mid-turn', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    seedActionableMail(projectId, 'impl-x');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, pty, clock, qw } = makeEngine();
    const { hosted, pane } = await hostPane(engine, pty, identity);

    let killed = false;
    const origKill = pane.kill.bind(pane);
    (pane as unknown as { kill: () => void }).kill = () => {
      killed = true;
      origKill();
    };

    const item = outstandingItem(projectId, 'impl-x');
    const turnP = engine.runOneTurn(hosted, item);
    await tick(); // turn is in flight (injectMail awaiting echo) → turnInFlight=true
    await engine.release(projectId, 'impl-x'); // deferred — must NOT kill the pane mid-turn
    expect(killed).toBe(false);

    await driveTurnToIdle(pane, item, clock, qw);
    await turnP; // the turn's finally finalizes the deferred release
    expect(killed).toBe(true); // killed only after the turn yielded
  });
});

// ── completion stays verb-keyed (turn-end ≠ work-end) ──────────────────────────
describe('ConductorEngine — turn-end is a liveness signal only; completion stays verb-keyed', () => {
  it('reflects a co_finish verb in the trace but STILL yields on byte-quiescence (never on the verb)', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    seedActionableMail(projectId, 'impl-x');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });

    // mcpActivity injects a co_finish call into the turn trace (the Option-C MCP sentinel).
    const { engine, pty, clock, qw } = makeEngine({
      mcpActivity: (_pane, push) => {
        push({ kind: 'mcp', at: 1000, verb: 'co_finish' } satisfies DetectorEvent);
        return () => {};
      },
    });

    const ensureP = engine.ensureHosted(identity);
    const pane = pty.panes[0]!;
    pane.emit(CLAUDE_READY);
    const hosted = await ensureP;

    const item = outstandingItem(projectId, 'impl-x');
    const turnP = engine.runOneTurn(hosted, item);
    await driveTurnToIdle(pane, item, clock, qw);
    const outcome = await turnP;

    // The verb is REFLECTED (completion's business), but idle was driven by byte-quiescence — the engine
    // yielded on the turn boundary, and the mail was NOT consumed (no "idle ⇒ done" shortcut).
    expect(outcome.turnEnd?.sawCompletionVerb).toBe(true);
    expect(outcome.turnEnd?.idle).toBe(true);
    expect(outstandingCount(projectId, 'impl-x')).toBe(1);
  });
});

// ── MNR-5: single launch authority / one-worktree race ─────────────────────────
describe('ConductorEngine — MNR-5 launch authority (no duplicate dispatch)', () => {
  it('refuses a second host for an already-hosted agent, BEFORE spawning a duplicate pane', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, pty } = makeEngine();

    const ensureP = engine.ensureHosted(identity);
    pty.panes[0]!.emit(CLAUDE_READY);
    await ensureP;

    await expect(engine.ensureHosted(identity)).rejects.toThrow(/already hosted|MNR-5/i);
    expect(pty.panes).toHaveLength(1); // no second pane was ever spawned
  });

  it('refuses a second agent claiming an already-hosted pane id', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const first = makeIdentity({ agent: 'impl-x', pane: 'pane-shared', projectId, cwd });
    const second = makeIdentity({ agent: 'impl-y', pane: 'pane-shared', projectId, cwd });
    const { engine, pty } = makeEngine();

    const ensureP = engine.ensureHosted(first);
    pty.panes[0]!.emit(CLAUDE_READY);
    await ensureP;

    await expect(engine.ensureHosted(second)).rejects.toThrow(/already hosted|MNR-5/i);
    expect(pty.panes).toHaveLength(1);
  });

  it('re-hosts after release (the slot is freed)', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, pty } = makeEngine();

    const ensureP = engine.ensureHosted(identity);
    pty.panes[0]!.emit(CLAUDE_READY);
    await ensureP;
    await engine.release(projectId, 'impl-x');
    expect(engine.isHosted(projectId, 'impl-x')).toBe(false);

    const reHostP = engine.ensureHosted(identity);
    pty.panes[1]!.emit(CLAUDE_READY);
    await expect(reHostP).resolves.toBeDefined();
    expect(pty.panes).toHaveLength(2);
  });

  it('release still closes the session when pane.kill and the kill-error reporter both throw', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, pty } = makeEngine();

    const ensureP = engine.ensureHosted(identity);
    const pane = pty.panes[0]!;
    pane.emit(CLAUDE_READY);
    await ensureP;
    (pane as unknown as { kill: () => void }).kill = () => {
      throw new Error('kill failed in test');
    };

    await expect(
      engine.release(projectId, 'impl-x', {
        onPaneKillError: () => {
          throw new Error('reporter failed in test');
        },
      }),
    ).resolves.toBeUndefined();

    expect(engine.isHosted(projectId, 'impl-x')).toBe(false);
  });

  it('closeAll kills warm panes and clears the hosted ledger', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, pty } = makeEngine();

    const ensureP = engine.ensureHosted(identity);
    const pane = pty.panes[0]!;
    let exited = false;
    pane.onExit(() => void (exited = true));
    pane.emit(CLAUDE_READY);
    await ensureP;

    await engine.closeAll();

    expect(exited).toBe(true);
    expect(engine.isHosted(projectId, 'impl-x')).toBe(false);
  });
});

// ── fail-loud: a startup failure must not leak the spawned pane ────────────────
describe('ConductorEngine — ensureHosted fails loud without leaking the pane', () => {
  it('kills the pane and leaves the agent re-hostable when startup fails (pty exits)', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, pty } = makeEngine();

    const ensureP = engine.ensureHosted(identity);
    pty.panes[0]!.exit(1, null); // the pty exits before reaching ready ⇒ driveToReady rejects
    await expect(ensureP).rejects.toThrow(/exited|ready/i);
    expect(engine.isHosted(projectId, 'impl-x')).toBe(false); // the launch ledger was never claimed

    // re-hostable: a fresh launch for the same agent succeeds (the slot was never poisoned).
    const reHostP = engine.ensureHosted(identity);
    pty.panes[1]!.emit(CLAUDE_READY);
    await expect(reHostP).resolves.toBeDefined();
  });

  it('closes the client transport when startup fails after the MCP session is bound', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    let clientCloseCount = 0;
    const { engine, pty } = makeEngine({
      makeTransport: () => {
        const pair = InMemoryTransport.createLinkedPair();
        const originalClose = pair[0].close?.bind(pair[0]);
        pair[0].close = async () => {
          clientCloseCount += 1;
          await originalClose?.();
        };
        return pair;
      },
    });

    const ensureP = engine.ensureHosted(identity);
    await flush(); // let hostSession bind before startup fails
    pty.panes[0]!.exit(1, null);

    await expect(ensureP).rejects.toThrow(/exited|ready/i);
    expect(clientCloseCount).toBeGreaterThanOrEqual(1);
    const sessions = openSessionStore(projectId);
    const roster = openRosterStore(projectId);
    try {
      expect(sessions.getSession('impl-x')).toBeUndefined();
      expect(roster.getAgent('impl-x')).toBeUndefined();
    } finally {
      sessions.close();
      roster.close();
    }
  });
});

// ── MNR-2 seam: an errored turn must not drop its mail ──────────────────────────
describe('ConductorEngine — MNR-2 seam: an errored turn yields WITHOUT consuming the mail', () => {
  it('keeps the actionable item outstanding when the turn errors (P1b re-injects it)', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    seedActionableMail(projectId, 'impl-x');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });

    // An injection that can never echo-verify (retryDelay resolves immediately, no echo) ⇒ the turn errors.
    const { engine, pty } = makeEngine({
      injectOptions: { retryDelay: async () => {}, maxEchoAttempts: 2 },
    });

    const ensureP = engine.ensureHosted(identity);
    pty.panes[0]!.emit(CLAUDE_READY);
    const hosted = await ensureP;

    const item = outstandingItem(projectId, 'impl-x');
    const outcome = await engine.runOneTurn(hosted, item);

    expect(outcome.errored).toBe(true);
    // The mail was NEVER marked read/resolved — it stays outstanding for P1b's LiveDelivery ledger.
    expect(outstandingCount(projectId, 'impl-x')).toBe(1);
    // The pane stays warm (yield), so the re-injection can reuse it.
    expect(engine.isHosted(projectId, 'impl-x')).toBe(true);
  });
});

// ── MNR-2 seam (end-to-end re-select): the NEXT runCycle re-selects the errored agent ──────────────
// AC-S10-5 (#b): after an errored turn the mail stays outstanding; the NEXT runCycle call
// re-selects the SAME agent (selectEligible re-injects it) — the work is never dropped.
describe('ConductorEngine — MNR-2 end-to-end: runCycle re-selects the same agent after an errored turn', () => {
  it('the NEXT runCycle selects the same agent whose turn errored because its mail is still outstanding', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    seedActionableMail(projectId, 'impl-x');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    // Use an inject-fail config so the turn errors immediately (echo-verify never happens).
    const { engine, pty } = makeEngine({
      injectOptions: { retryDelay: async () => {}, maxEchoAttempts: 2 },
    });

    // Cycle 1: cold launch → pane ready → turn errors (inject echo-verify fails).
    const cycle1 = engine.runCycle([identity]);
    pty.panes[0]!.emit(CLAUDE_READY); // drive ensureHosted
    const outcome1 = await cycle1;
    expect(outcome1).not.toBeNull();
    expect(outcome1!.turn.errored).toBe(true); // the turn threw — no mail consumed
    // The mail is STILL outstanding (MNR-2: errored turn does not eat its mail).
    expect(outstandingCount(projectId, 'impl-x')).toBe(1);

    // Cycle 2: impl-x's mail is STILL outstanding → selectEligible RE-SELECTS it.
    // The pane stayed warm (MNR-2: pane not reaped on error) — no CLAUDE_READY needed.
    const cycle2 = engine.runCycle([identity]);
    const outcome2 = await cycle2;
    // Non-null outcome proves the agent was RE-SELECTED (selectEligible found outstanding mail).
    expect(outcome2).not.toBeNull();
    expect(outcome2!.hosted.pane).toBe(pty.panes[0]); // the SAME warm pane was reused
    expect(outcome2!.turn.errored).toBe(true); // error persists (echo-verify still fails; expected)
  });
});

// ── P1b: route emitted mail via LiveDelivery (wake + inject the recipient's pane) ───────────────
describe('ConductorEngine — P1b routes emitted mail via LiveDelivery (wake + inject recipient pane)', () => {
  it('an emitted ACTIONABLE mail wakes the recipient AND injects its warm pane (echo-verified)', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const wakes: Array<{ projectId: string; recipient: string }> = [];
    const { engine, pty } = makeEngine({
      onRecipientWake: (pid, recipient) => wakes.push({ projectId: pid, recipient }),
    });
    // Host the sender AND the recipient (both warm) — routing targets a known/warm pane in P1b.
    const { hosted: hostedA } = await hostPane(
      engine,
      pty,
      makeIdentity({ agent: 'impl-a', projectId, cwd }),
    );
    const { pane: bPane } = await hostPane(
      engine,
      pty,
      makeIdentity({ agent: 'impl-b', projectId, cwd }),
    );
    const clientA = await connectClient(hostedA);

    // impl-a emits an actionable clarify to impl-b through its hosted MCP session (co_mail_send).
    await clientA.callTool({
      name: 'co_mail_send',
      arguments: { to: 'impl-b', type: 'clarify_request', subject: 'route me', body: 'please act' },
    });
    // LiveDelivery.deliver fired: it woke impl-b and enqueued an inject into its pane; drive the echo.
    const item = outstandingItem(projectId, 'impl-b');
    bPane.emit(defaultMailRenderer(item));
    await flush();

    // (1) wake fired for impl-b; (2) its pane received the echo-verified text + exactly one submit.
    expect(wakes).toContainEqual({ projectId, recipient: 'impl-b' });
    expect(bPane.written.join('')).toContain('route me');
    expect(bPane.written.filter((w) => w === '\r')).toHaveLength(1);
  });

  it('an emitted INFORMATIONAL mail wakes the recipient but does NOT inject (and never fails)', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const wakes: Array<{ projectId: string; recipient: string }> = [];
    const routeFailures: RouteFailure[] = [];
    const { engine, pty } = makeEngine({
      onRecipientWake: (pid, recipient) => wakes.push({ projectId: pid, recipient }),
      onRouteFailure: (f) => routeFailures.push(f),
    });
    const { hosted: hostedA } = await hostPane(
      engine,
      pty,
      makeIdentity({ agent: 'impl-a', projectId, cwd }),
    );
    const clientA = await connectClient(hostedA);

    // impl-b is NOT hosted: informational mail must still wake it, and must NEVER attempt an inject
    // (the `isInjectableActionable` gate) — so an unhosted recipient yields no inject failure.
    await clientA.callTool({
      name: 'co_mail_send',
      arguments: { to: 'impl-b', type: 'chat', subject: 'fyi', body: 'just so you know' },
    });
    await flush();

    expect(wakes).toContainEqual({ projectId, recipient: 'impl-b' });
    expect(routeFailures).toHaveLength(0); // informational is never injected ⇒ no inject attempt
    expect(outstandingCount(projectId, 'impl-b')).toBe(0); // chat is informational, not an action
    // It was still DELIVERED (persisted), just not injected.
    const inbox = openMailStore(projectId);
    mailStores.push(inbox);
    expect(inbox.inbox('impl-b').some((m) => m.subject === 'fyi')).toBe(true);
  });
});

// ── P1b: MNR-2 — a failed routed inject is re-injected on re-wake (never dropped) ───────────────
describe('ConductorEngine — P1b MNR-2: the LiveDelivery ledger re-injects a failed routed item on re-wake', () => {
  it('a routed inject that fails (recipient not yet hosted) re-injects once the recipient is warm', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const routeFailures: RouteFailure[] = [];
    const { engine, pty } = makeEngine({ onRouteFailure: (f) => routeFailures.push(f) });

    // Host ONLY the sender; the recipient impl-b is not yet hosted (its pane cannot receive an inject).
    const { hosted: hostedA } = await hostPane(
      engine,
      pty,
      makeIdentity({ agent: 'impl-a', projectId, cwd }),
    );
    const clientA = await connectClient(hostedA);

    // inject → error: an actionable clarify to the not-yet-hosted impl-b (idempotent so a resend re-wakes).
    const sendArgs = {
      to: 'impl-b',
      type: 'clarify_request',
      subject: 'route me',
      body: 'please act',
      idempotency_key: 'route:mnr2',
    };
    await clientA.callTool({ name: 'co_mail_send', arguments: sendArgs });
    await flush();

    // The routed inject FAILED — reported (not dropped) — and the item stays OUTSTANDING.
    expect(routeFailures).toHaveLength(1);
    expect(routeFailures[0]!.phase).toBe('inject');
    expect(routeFailures[0]!.recipient).toBe('impl-b');
    expect(outstandingCount(projectId, 'impl-b')).toBe(1);

    // re-wake → re-inject: host impl-b (now warm), then RE-SEND the same idempotent mail.
    const { pane: bPane } = await hostPane(
      engine,
      pty,
      makeIdentity({ agent: 'impl-b', projectId, cwd }),
    );
    await clientA.callTool({ name: 'co_mail_send', arguments: sendArgs });
    await flush(); // the ledger re-injects the still-outstanding item into impl-b's warm pane
    const item = outstandingItem(projectId, 'impl-b');
    bPane.emit(defaultMailRenderer(item)); // drive the echo so the re-inject submits
    await flush();

    // The re-inject LANDED (echo-verified text + exactly one submit); no new failure; never dropped.
    expect(bPane.written.join('')).toContain('route me');
    expect(bPane.written.filter((w) => w === '\r')).toHaveLength(1);
    expect(routeFailures).toHaveLength(1); // the re-inject did not fail
    expect(outstandingCount(projectId, 'impl-b')).toBe(1); // still outstanding — agent not left idle holding it
  });
});

// ── P1b: liveness classification + yield ───────────────────────────────────────────────────────
describe('ConductorEngine — P1b classifies post-turn liveness and yields warm', () => {
  it('a turn that yields idle WITHOUT a completion verb is alive + a silent_stop break', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    seedActionableMail(projectId, 'impl-x');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, pty, clock, qw } = makeEngine();
    const { hosted, pane } = await hostPane(engine, pty, identity);

    const item = outstandingItem(projectId, 'impl-x');
    const turnP = engine.runOneTurn(hosted, item);
    await driveTurnToIdle(pane, item, clock, qw);
    const outcome = await turnP;

    expect(outcome.errored).toBe(false);
    expect(outcome.liveness?.liveness).toBe('alive'); // the process is fine ...
    expect(outcome.liveness?.break?.kind).toBe('silent_stop'); // ... but it yielded without finishing
    expect(engine.isHosted(projectId, 'impl-x')).toBe(true); // healthy liveness ⇒ the pane stays WARM
  });

  it('a yielded coordinator turn is not classified as missing co_finish post-turn', async () => {
    const { projectId, cwd } = makeProject();
    seedActionableMail(projectId, 'coord-1', '@operator');
    const identity = makeIdentity({
      agent: 'coord-1',
      projectId,
      cwd,
      role: 'coordinator',
      parent: '@operator',
    });
    const { engine, pty, clock, qw } = makeEngine();
    const { hosted, pane } = await hostPane(engine, pty, identity);

    const item = outstandingItem(projectId, 'coord-1');
    const turnP = engine.runOneTurn(hosted, item);
    await driveTurnToIdle(pane, item, clock, qw);
    const outcome = await turnP;

    expect(outcome.turnEnd?.idle).toBe(true);
    expect(outcome.turnEnd?.sawCompletionVerb).toBe(false);
    expect(outcome.liveness?.liveness).toBe('alive');
    expect(outcome.liveness?.break).toBeUndefined();
  });

  it('a turn that ends with a completion verb is healthy (no break)', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    seedActionableMail(projectId, 'impl-x');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, pty, clock, qw } = makeEngine({
      mcpActivity: (_pane, push) => {
        push({ kind: 'mcp', at: 1000, verb: 'co_finish' } satisfies DetectorEvent);
        return () => {};
      },
    });
    const { hosted, pane } = await hostPane(engine, pty, identity);

    const item = outstandingItem(projectId, 'impl-x');
    const turnP = engine.runOneTurn(hosted, item);
    await driveTurnToIdle(pane, item, clock, qw);
    const outcome = await turnP;

    expect(outcome.turnEnd?.sawCompletionVerb).toBe(true);
    expect(outcome.liveness?.liveness).toBe('alive');
    expect(outcome.liveness?.break).toBeUndefined(); // a finished turn carries no break
  });

  it('a turn with a failed completion verb remains silent-stop eligible', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    seedActionableMail(projectId, 'impl-x');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, pty, clock, qw } = makeEngine({
      mcpActivity: (_pane, push) => {
        push({ kind: 'mcp_start', at: 900, verb: 'co_finish' } satisfies DetectorEvent);
        push({ kind: 'mcp_end', at: 1000, verb: 'co_finish', ok: false } satisfies DetectorEvent);
        return () => {};
      },
    });
    const { hosted, pane } = await hostPane(engine, pty, identity);

    const item = outstandingItem(projectId, 'impl-x');
    const turnP = engine.runOneTurn(hosted, item);
    await driveTurnToIdle(pane, item, clock, qw);
    const outcome = await turnP;

    expect(outcome.turnEnd?.sawCompletionVerb).toBe(false);
    expect(outcome.liveness?.liveness).toBe('alive');
    expect(outcome.liveness?.break?.kind).toBe('silent_stop');
  });
});

// ── P1b: clarify-timeout tick (forwardOnTimeout on expiry) ──────────────────────────────────────
describe('ConductorEngine — P1b fires the clarify-timeout tick (forwardOnTimeout) on expiry', () => {
  it('forwards an unanswered clarify UP the chain once its age exceeds the timeout', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1'); // roster: coord-1 (→ @operator), lead-1 (→ coord-1)
    // impl-x asked lead-1; lead-1 is the holder that has not answered.
    const store = openMailStore(projectId);
    mailStores.push(store);
    const clarify = store.send({
      type: 'clarify_request',
      to: 'lead-1',
      from: 'impl-x',
      subject: 'which provider?',
      body: 'claude or codex?',
    });
    const asker = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, clock } = makeEngine({ clarifyTimeoutSeconds: () => 1800 });

    // Tick #1 at t=0: just observed — starts the item's clock; nothing is forwarded.
    clock.set(0);
    expect(await engine.tickClarifyTimeouts([asker])).toHaveLength(0);
    expect(store.inbox('coord-1')).toHaveLength(0);

    // Advance PAST the timeout; tick #2 forwards lead-1's held clarify up to coord-1 (parentOf(lead-1)).
    clock.set(1800 * 1000 + 1);
    const forwarded = await engine.tickClarifyTimeouts([asker]);
    expect(forwarded).toHaveLength(1);

    const escalation = store.inbox('coord-1').find((m) => m.causationId === String(clarify.seq));
    expect(escalation).toBeDefined();
    expect(escalation!.type).toBe('escalation'); // same threading as a manual forwardEscalation
    expect(escalation!.sender).toBe('lead-1'); // forwarded UP from the holder
    expect(escalation!.correlationId).toBe(String(clarify.seq));
  });

  it('does not forward before the timeout elapses', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const store = openMailStore(projectId);
    mailStores.push(store);
    store.send({ type: 'clarify_request', to: 'lead-1', from: 'impl-x', subject: 's', body: 'b' });
    const asker = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, clock } = makeEngine({ clarifyTimeoutSeconds: () => 1800 });

    clock.set(0);
    await engine.tickClarifyTimeouts([asker]);
    clock.set(1800 * 1000 - 1); // one ms short of the timeout
    expect(await engine.tickClarifyTimeouts([asker])).toHaveLength(0);
    expect(store.inbox('coord-1')).toHaveLength(0);
  });

  it('prunes clarifyFirstSeen when a clarify is answered before its timeout (no map leak)', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const store = openMailStore(projectId);
    mailStores.push(store);
    // impl-x sends a clarify_request to lead-1; impl-x is the asker (waiting for a reply).
    const clarify = store.send({
      type: 'clarify_request',
      to: 'lead-1',
      from: 'impl-x',
      subject: 'q',
      body: 'b',
    });
    const asker = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, clock } = makeEngine({ clarifyTimeoutSeconds: () => 1800 });

    // Tick #1: impl-x is in candidates; the entry is recorded in clarifyFirstSeen.
    clock.set(0);
    expect(await engine.tickClarifyTimeouts([asker])).toHaveLength(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((engine as any).clarifyFirstSeen.size).toBe(1);

    // lead-1 ANSWERS the clarify before the timeout — impl-x is no longer waiting.
    store.reply(clarify, { type: 'clarify_response', subject: 'answer', body: 'answered' });

    // Tick #2 (still well before timeout): the answered clarify is gone from waitingItems for
    // impl-x, so its clarifyFirstSeen entry must be pruned — no unbounded-growth leak.
    clock.set(100);
    expect(await engine.tickClarifyTimeouts([asker])).toHaveLength(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((engine as any).clarifyFirstSeen.size).toBe(0);
  });

  it('does NOT prune a still-unanswered clarify whose agent is absent from candidates this tick', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const store = openMailStore(projectId);
    mailStores.push(store);
    store.send({ type: 'clarify_request', to: 'lead-1', from: 'impl-x', subject: 'q', body: 'b' });
    const asker = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, clock } = makeEngine({ clarifyTimeoutSeconds: () => 1800 });

    // Tick #1 with impl-x in candidates: clock starts at t=0.
    clock.set(0);
    expect(await engine.tickClarifyTimeouts([asker])).toHaveLength(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((engine as any).clarifyFirstSeen.size).toBe(1);

    // Tick #2 with impl-x ABSENT from candidates: its clock must survive unharmed.
    clock.set(500);
    expect(await engine.tickClarifyTimeouts([])).toHaveLength(0); // no candidates processed
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((engine as any).clarifyFirstSeen.size).toBe(1); // entry NOT pruned

    // Tick #3 with impl-x in candidates again, past the timeout: forward fires using the
    // preserved t=0 clock (not a fresh clock from t=500, which would not yet have timed out).
    clock.set(1800 * 1000 + 1);
    const forwarded = await engine.tickClarifyTimeouts([asker]);
    expect(forwarded).toHaveLength(1); // forwarded using the preserved t=0 first-seen clock
  });
});

// ── P1b: warm-pane reuse (getHosted branch — ensureHosted SKIPPED, no relaunch) ─────────────────
describe('ConductorEngine — P1b runCycle reuses a warm pane (no relaunch)', () => {
  it('a second cycle for an already-warm agent reuses the handle and never spawns a second pane', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    seedActionableMail(projectId, 'impl-x');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, pty, clock, qw } = makeEngine();

    // First cycle: COLD launch (spawns exactly one pane).
    const cycle1 = engine.runCycle([identity]);
    pty.panes[0]!.emit(CLAUDE_READY);
    await flush();
    const item1 = outstandingItem(projectId, 'impl-x');
    await driveTurnToIdle(pty.panes[0]!, item1, clock, qw);
    await cycle1;
    expect(pty.panes).toHaveLength(1);
    expect(engine.isHosted(projectId, 'impl-x')).toBe(true);

    // The item is unresolved (completion is verb-keyed), so it is still selectable for a second cycle.
    // Second cycle: WARM reuse — getHosted returns the handle, ensureHosted is NOT called (no 2nd spawn).
    const cycle2 = engine.runCycle([identity]);
    expect(pty.panes).toHaveLength(1); // reused synchronously — no relaunch before the first await
    const item2 = outstandingItem(projectId, 'impl-x');
    await driveTurnToIdle(pty.panes[0]!, item2, clock, qw);
    const outcome2 = await cycle2;

    expect(outcome2).not.toBeNull();
    expect(outcome2!.hosted.pane).toBe(pty.panes[0]); // the SAME warm pane, not a fresh one
    expect(pty.panes).toHaveLength(1); // still exactly one pane after two cycles
  });
});

// ── SF-2: mid-turn steer over the warm hosted pane, NEVER tear down (Principle 1) ────────────────
describe('ConductorEngine — SF-2 steer: route a mid-turn steer to the warm pane, keep it alive', () => {
  const CR = String.fromCharCode(0x0d); // submit key — codepoint-authored so the source holds no raw CR

  it('interrupt routes EXACTLY the provider key to the warm pane and leaves the session intact', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd }); // provider defaults to 'claude'
    const { engine, pty } = makeEngine();
    const { hosted, pane } = await hostPane(engine, pty, identity);

    let exited = false;
    pane.onExit(() => void (exited = true));
    const before = pane.written.length;

    await engine.steer(projectId, 'impl-x', { kind: 'interrupt' });

    // exactly the interrupt key (claude ⇒ ESC) reached the warm pane — nothing else ...
    expect(pane.written.slice(before)).toEqual([ESC]);
    // ... and the pane is STILL warm: not exited, not signal-stopped, still in the hosted ledger.
    expect(exited).toBe(false);
    expect(pane.stopped).toBe(false);
    expect(engine.isHosted(projectId, 'impl-x')).toBe(true);
    expect(engine.getHosted(projectId, 'impl-x')?.pane).toBe(hosted.pane); // same warm pane, never released
  });

  it('answer routes the operator text + exactly one submit into the warm pane (echo-verified)', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, pty } = makeEngine();
    const { pane } = await hostPane(engine, pty, identity);

    const steerP = engine.steer(projectId, 'impl-x', { kind: 'answer', text: 'use claude' });
    await tick(); // injectMail has written the text and is awaiting the composer echo
    pane.emit('use claude'); // the composer echoes the operator's answer → exactly one submit
    await steerP;

    expect(pane.written.join('')).toContain('use claude');
    expect(pane.written.filter((w) => w === CR)).toHaveLength(1); // exactly one Enter
    expect(engine.isHosted(projectId, 'impl-x')).toBe(true); // still warm — steering never releases
  });

  it('throws fail-loud when the agent is not hosted (no warm pane to steer)', async () => {
    const { projectId } = makeProject();
    const { engine } = makeEngine();
    await expect(engine.steer(projectId, 'nope', { kind: 'interrupt' })).rejects.toThrow(
      /not hosted/i,
    );
  });
});

// ── Stage 15 §7: writeInput + resizePty on the warm hosted pane ─────────────────────────────────
describe('ConductorEngine — writeInput / resizePty: pass raw input and PTY resize to the warm pane', () => {
  it('writeInput writes the data bytes directly to the warm pane', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, pty } = makeEngine();
    const { pane } = await hostPane(engine, pty, identity);

    const before = pane.written.length;
    engine.writeInput(projectId, 'impl-x', 'hello\r');

    expect(pane.written.slice(before)).toEqual(['hello\r']);
    expect(engine.isHosted(projectId, 'impl-x')).toBe(true); // still warm
  });

  it('writeInput throws fail-loud when the agent is not hosted', () => {
    const { projectId } = makeProject();
    const { engine } = makeEngine();
    expect(() => engine.writeInput(projectId, 'ghost', 'x')).toThrow(/not hosted/i);
  });

  it('resizePty calls resize on the warm pane with the correct dims', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, pty } = makeEngine();
    await hostPane(engine, pty, identity);

    const pane = pty.panes[pty.panes.length - 1]!;
    engine.resizePty(projectId, 'impl-x', 120, 40);
    engine.resizePty(projectId, 'impl-x', 200, 50);

    expect(pane.resizes).toEqual([
      [120, 40],
      [200, 50],
    ]);
    expect(engine.isHosted(projectId, 'impl-x')).toBe(true); // still warm
  });

  it('resizePty throws fail-loud when the agent is not hosted', () => {
    const { projectId } = makeProject();
    const { engine } = makeEngine();
    expect(() => engine.resizePty(projectId, 'ghost', 120, 40)).toThrow(/not hosted/i);
  });
});

// ── Stage 12 C-P1 (TRANSCRIPT-SEAM) — the persistent transcript ring buffer ──────
describe('transcript tail (Stage 12 C-P1) — a bounded, most-recent-bytes ring buffer per agent', () => {
  it('captures startup interstitial bytes in both the tail and live stream', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, pty } = makeEngine();
    const seen: string[] = [];
    const unsub = engine.onTranscript((pid, agent, _generation, chunk) => {
      if (pid === projectId && agent === 'impl-x') seen.push(chunk);
    });

    const ensureP = engine.ensureHosted(identity);
    const pane = pty.panes[pty.panes.length - 1]!;
    pane.emit(CLAUDE_READY);
    await ensureP;
    unsub();

    expect(engine.transcriptTail(projectId, 'impl-x')).toBe(CLAUDE_READY);
    expect(seen).toEqual([CLAUDE_READY]);
  });

  it('accumulates a hosted pane’s output (ANSI/ESC bytes intact) into the tail', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, pty } = makeEngine();
    const { pane } = await hostPane(engine, pty, identity);

    const chunks = ['first ', ESC + '[1msecond' + ESC + '[0m ', 'third'];
    for (const c of chunks) pane.emit(c);

    // The persistent onData observer concatenates every chunk, control bytes preserved verbatim.
    expect(engine.transcriptTail(projectId, 'impl-x')).toBe(CLAUDE_READY + chunks.join(''));
  });

  it('bounds the tail to TRANSCRIPT_TAIL_MAX_CHARS, dropping the OLDEST bytes (keeps most-recent)', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, pty } = makeEngine();
    const { pane } = await hostPane(engine, pty, identity);

    // Emit past the cap: a full cap of 'A' (oldest), then 1000 'B' (newest). Total = cap + 1000.
    pane.emit('A'.repeat(TRANSCRIPT_TAIL_MAX_CHARS));
    pane.emit('B'.repeat(1000));

    const tail = engine.transcriptTail(projectId, 'impl-x');
    expect(tail).toHaveLength(TRANSCRIPT_TAIL_MAX_CHARS); // bounded exactly to the cap
    // The 1000 oldest 'A's were dropped; the most-recent window survives in order.
    expect(tail).toBe('A'.repeat(TRANSCRIPT_TAIL_MAX_CHARS - 1000) + 'B'.repeat(1000));
    expect(tail.endsWith('B'.repeat(1000))).toBe(true); // the newest bytes are always kept
  });

  it('a single over-cap chunk is truncated to its most-recent TRANSCRIPT_TAIL_MAX_CHARS', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, pty } = makeEngine();
    const { pane } = await hostPane(engine, pty, identity);

    pane.emit('x'.repeat(TRANSCRIPT_TAIL_MAX_CHARS) + 'TAIL');
    const tail = engine.transcriptTail(projectId, 'impl-x');
    expect(tail).toHaveLength(TRANSCRIPT_TAIL_MAX_CHARS);
    expect(tail.endsWith('TAIL')).toBe(true);
  });

  it('returns the empty tail for an agent that is not hosted / has produced nothing', () => {
    const { projectId } = makeProject();
    const { engine } = makeEngine();
    expect(engine.transcriptTail(projectId, 'nobody')).toBe('');
  });

  it('onTranscript fires (projectId, agent, chunk) on every chunk; unsubscribe stops it', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, pty } = makeEngine();
    const { pane } = await hostPane(engine, pty, identity);

    const seen: Array<[ProjectId, string, number, string]> = [];
    const unsub = engine.onTranscript((pid, agent, generation, chunk) =>
      seen.push([pid, agent, generation, chunk]),
    );
    pane.emit('one');
    pane.emit('two');
    unsub();
    pane.emit('three'); // after unsubscribe — not observed

    expect(seen).toEqual([
      [projectId, 'impl-x', 1, 'one'],
      [projectId, 'impl-x', 1, 'two'],
    ]);
  });

  it('isolates transcript listener failures so later listeners still receive the chunk', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, pty } = makeEngine();
    const { pane } = await hostPane(engine, pty, identity);

    const seen: string[] = [];
    engine.onTranscript(() => {
      throw new Error('subscriber failed');
    });
    engine.onTranscript((_pid, _agent, _generation, chunk) => seen.push(chunk));

    expect(() => pane.emit('still delivered')).not.toThrow();
    expect(seen).toEqual(['still delivered']);
  });

  it('increments transcript generation when the same agent is rehosted', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, pty } = makeEngine();

    await hostPane(engine, pty, identity);
    expect(engine.transcriptTailSnapshot(projectId, 'impl-x').generation).toBe(1);
    await engine.release(projectId, 'impl-x');

    const ensureP = engine.ensureHosted(identity);
    const pane = pty.panes[pty.panes.length - 1]!;
    pane.emit(CLAUDE_READY);
    await ensureP;
    pane.emit('new generation');

    const snap = engine.transcriptTailSnapshot(projectId, 'impl-x');
    expect(snap.generation).toBe(2);
    expect(snap.tail).toBe(CLAUDE_READY + 'new generation');
  });

  it('drops the tail + stops the stream once the pane is released', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, pty } = makeEngine();
    const { pane } = await hostPane(engine, pty, identity);

    pane.emit('before release');
    expect(engine.transcriptTail(projectId, 'impl-x')).toBe(CLAUDE_READY + 'before release');

    const seen: string[] = [];
    engine.onTranscript((_pid, _agent, _generation, chunk) => seen.push(chunk));
    await engine.release(projectId, 'impl-x'); // tears down the persistent onData subscription + tail

    pane.emit('after release'); // the pane is detached — no listener fires, no buffer grows
    expect(seen).toHaveLength(0);
    expect(engine.transcriptTail(projectId, 'impl-x')).toBe(''); // tail dropped on release
  });
});

// ── #66 sub-bug B — the alt-screen-boundary tail (transcriptTailFrom) ─────────────
// A flat most-recent-64KiB slice drops the early `ESC[?1049h` an interactive TUI emits ONCE to enter the
// alternate screen, so replaying a mid-stream tail into a fresh xterm stacks/garbles frames. The retained
// tail must ALWAYS start at-or-before the last alt-screen-enter (within the hard ceiling). These assert
// the PURE function directly; every alt-screen case below would FAIL under the old flat-64KiB logic.
const ALT_ENTER = ESC + '[?1049h'; // DEC private mode 1049 set — switch to the alternate screen
const ALT_LEAVE = ESC + '[?1049l'; // DEC private mode 1049 reset — leave it (NOT a retain boundary)
describe('transcriptTailFrom (#66 sub-bug B) — never slices away the alternate-screen setup', () => {
  it('keeps the FULL buffer verbatim when at/under the soft bound (common case, unchanged)', () => {
    const buf = ALT_ENTER + 'a small frame';
    expect(transcriptTailFrom(buf)).toEqual({ tail: buf, dropped: 0 });

    const exact = 'z'.repeat(TRANSCRIPT_TAIL_MAX_CHARS); // exactly at the bound — still verbatim
    expect(transcriptTailFrom(exact)).toEqual({ tail: exact, dropped: 0 });
  });

  it('retains back to the early alt-screen-enter even after >64 KiB of frames (the fix)', () => {
    // Early alt-screen setup, then far more than the soft bound of redraw frames after it.
    const setup = ALT_ENTER + ESC + '[2J' + ESC + '[H'; // enter alt screen, clear, home
    const frames = 'F'.repeat(TRANSCRIPT_TAIL_MAX_CHARS * 2); // 128 KiB > 64 KiB soft bound
    const buf = setup + frames;

    const { tail, dropped } = transcriptTailFrom(buf);

    // The load-bearing invariant: the alt-screen-enter is ALWAYS present in the retained tail…
    expect(tail.includes(ALT_ENTER)).toBe(true);
    // …and it is the FIRST thing in the tail (we retained from exactly that boundary).
    expect(tail.startsWith(ALT_ENTER)).toBe(true);
    expect(tail).toBe(buf); // setup+frames is under the 256 KiB hard ceiling, so nothing is dropped
    expect(dropped).toBe(0);
    // The OLD flat-64KiB logic would have kept only `buf.slice(buf.length - 64KiB)` — pure 'F's, no
    // ESC[?1049h — which is exactly the garble this fix prevents:
    expect(buf.slice(buf.length - TRANSCRIPT_TAIL_MAX_CHARS).includes(ALT_ENTER)).toBe(false);
  });

  it('keeps the LAST alt-screen-enter when several are present (re-entered the alt screen)', () => {
    const firstEnter = ALT_ENTER + 'one'.repeat(TRANSCRIPT_TAIL_MAX_CHARS); // pushed well past the bound
    const lastEnter = ALT_ENTER + 'two'; // the re-enter we must anchor on
    const buf = firstEnter + lastEnter;

    const { tail } = transcriptTailFrom(buf);

    expect(tail.startsWith(ALT_ENTER)).toBe(true);
    expect(tail).toBe(lastEnter); // anchored on the LAST enter, not the first
    // Exactly one alt-screen-enter survives — we did not drag in the earlier one.
    expect(tail.split(ALT_ENTER).length - 1).toBe(1);
  });

  it('honours the HARD ceiling: an unreachably-old alt-screen-enter is NOT dragged in', () => {
    // Alt-screen-enter, then MORE than the hard ceiling of bytes after it → it falls outside the window.
    const buf = ALT_ENTER + 'G'.repeat(TRANSCRIPT_TAIL_HARD_MAX_CHARS + 5_000);

    const { tail, dropped } = transcriptTailFrom(buf);

    expect(tail.length).toBeLessThanOrEqual(TRANSCRIPT_TAIL_HARD_MAX_CHARS); // memory stays bounded
    expect(tail.includes(ALT_ENTER)).toBe(false); // the stale enter is beyond reach — not retained
    expect(dropped).toBe(buf.length - tail.length); // dropped + tail re-form the whole buffer
    expect(buf.slice(dropped)).toBe(tail);
  });

  it('an alt-screen-LEAVE is not a retain boundary (only ENTER setup matters)', () => {
    // Only a 1049l (leave) early, then >64 KiB of frames. Leave is not load-bearing for replay setup.
    const buf = ALT_LEAVE + 'H'.repeat(TRANSCRIPT_TAIL_MAX_CHARS + 4_000);

    const { tail } = transcriptTailFrom(buf);

    expect(tail.includes(ALT_LEAVE)).toBe(false); // leave is treated as ordinary bytes, may be dropped
    expect(tail.length).toBe(TRANSCRIPT_TAIL_MAX_CHARS); // falls back to the flat most-recent-N window
  });

  it('with NO alt-screen, snaps the start FORWARD to the last full-screen-clear (clean frame)', () => {
    // No 1049h anywhere. A full-screen clear sits just inside the soft window; replay should open there.
    const head = 'P'.repeat(TRANSCRIPT_TAIL_MAX_CHARS); // older than the window — dropped
    const clearFrame = ESC + '[2J' + ESC + '[H' + 'fresh frame';
    const buf = head + clearFrame;

    const { tail, dropped } = transcriptTailFrom(buf);

    expect(tail.startsWith(ESC + '[2J')).toBe(true); // opens on the clean clear, not mid-frame
    expect(tail).toBe(clearFrame);
    expect(tail.length).toBeLessThanOrEqual(TRANSCRIPT_TAIL_MAX_CHARS); // snapping forward never grows
    expect(buf.slice(dropped)).toBe(tail);
  });

  it('with neither alt-screen nor a clear, falls back to the flat most-recent-N (legacy behavior)', () => {
    const buf = 'A'.repeat(TRANSCRIPT_TAIL_MAX_CHARS) + 'B'.repeat(1_000);

    const { tail, dropped } = transcriptTailFrom(buf);

    expect(tail.length).toBe(TRANSCRIPT_TAIL_MAX_CHARS);
    expect(tail.endsWith('B'.repeat(1_000))).toBe(true);
    expect(dropped).toBe(1_000);
    expect(buf.slice(dropped)).toBe(tail);
  });
});

// ── #66 sub-bug B — the live engine tail keeps the alt-screen-enter across chunk boundaries ──────
describe('engine transcript tail (#66 sub-bug B) — alt-screen-enter survives a >64 KiB stream', () => {
  it('retains the early ESC[?1049h in the engine tail + tracks the absolute offset', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, pty } = makeEngine();
    const { pane } = await hostPane(engine, pty, identity); // emits CLAUDE_READY first

    // The interactive TUI enters the alt screen ONCE, then redraws far past the soft bound.
    pane.emit(ALT_ENTER + ESC + '[2J' + ESC + '[H');
    pane.emit('F'.repeat(TRANSCRIPT_TAIL_MAX_CHARS));
    pane.emit('F'.repeat(20_000) + 'LIVE-TAIL');

    const snap = engine.transcriptTailSnapshot(projectId, 'impl-x');
    expect(snap.tail.includes(ALT_ENTER)).toBe(true); // never sliced away across chunk boundaries
    expect(snap.tail.startsWith(ALT_ENTER)).toBe(true); // retained from exactly the alt-screen boundary
    expect(snap.tail.endsWith('LIVE-TAIL')).toBe(true); // the live tail is still present
    // The offset is the absolute char position where the retained tail starts in the pane stream — here
    // the alt-screen-enter sits immediately after CLAUDE_READY, so the tail starts at CLAUDE_READY.length.
    expect(snap.offset).toBe(CLAUDE_READY.length);
  });

  it('recognizes an alt-screen-enter split across pane chunks', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId, 'lead-1');
    const identity = makeIdentity({ agent: 'impl-x', projectId, cwd });
    const { engine, pty } = makeEngine();
    const { pane } = await hostPane(engine, pty, identity);

    pane.emit(ALT_ENTER.slice(0, 4));
    pane.emit(ALT_ENTER.slice(4));
    pane.emit('F'.repeat(TRANSCRIPT_TAIL_MAX_CHARS + 1_000));

    const snap = engine.transcriptTailSnapshot(projectId, 'impl-x');
    expect(snap.tail.startsWith(ALT_ENTER)).toBe(true);
    expect(snap.offset).toBe(CLAUDE_READY.length);
  });
});
