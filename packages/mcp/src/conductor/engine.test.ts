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
  defaultMailRenderer,
  openMailStore,
  openRegistry,
  openRosterStore,
  QUIET_WINDOW_MS,
  type DeliveredMail,
  type DetectorEvent,
  type MailStore,
  type ProjectId,
  type ProjectRegistry,
  type RosterStore,
} from '@co/core';
import { ConductorEngine, selectEligible, type ConductorEngineDeps } from './engine.js';
import type { HostedIdentity } from '../live-session-host.js';

// ── Scripted startup fixture: a claude session that is ready immediately (no interstitial). ──
// ESC authored as a `\u` escape so the SOURCE holds no raw control byte (the C2 pristine-repo rule).
const ESC = '\u001B';
const CLAUDE_READY = ESC + '[2J' + ESC + '[H' + '╭─ Welcome ─╮\r\n❯ \r\n  ? for shortcuts\r\n';

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
  clock.set(1000 + QUIET_WINDOW_MS + 1);
  qw.settle(); // the window elapses with no further output ⇒ idle
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
});

// ── the keystone single-turn cycle ────────────────────────────────────────────
describe('ConductorEngine — ensure-hosted → bind → inject → ONE turn → detect → yield', () => {
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
