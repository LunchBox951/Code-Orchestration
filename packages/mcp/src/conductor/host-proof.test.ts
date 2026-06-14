/**
 * AC-S10-4·2 — the scripted host-proof driver: proves the FULL sequence deterministically over
 * `FakePty` + in-memory transport + injected time (no real binary, no real clock).
 *
 *   spawn → inject 1 mail → 1 turn idle → SIGKILL → recoverProjectStore → reconstruct session
 *   → mid-turn steer (interrupt)
 *
 * Clone of the `engine.test.ts` harness pattern: the test drives the FakePty pane in parallel
 * with the async driver using scripted bytes + the controllable quiet window.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  FakePty,
  QUIET_WINDOW_MS,
  defaultMailRenderer,
  openMailStore,
  openRegistry,
  openRosterStore,
  type DeliveredMail,
  type ProjectId,
  type ProjectRegistry,
  type RosterStore,
  type MailStore,
} from '@co/core';
import type { HostedIdentity } from '../live-session-host.js';
import { runHostProof } from './host-proof.js';

// ── Startup fixture ────────────────────────────────────────────────────────────
const ESC = '';
const CLAUDE_READY = ESC + '[2J' + ESC + '[H' + '╭─ Welcome ─╮\r\n❯ \r\n  ? for shortcuts\r\n';

// ── Cleanup state ──────────────────────────────────────────────────────────────
const ORIGINAL_ENV = process.env;
let dataDirs: string[] = [];
let registries: ProjectRegistry[] = [];
let mailStores: MailStore[] = [];
let rosterStores: RosterStore[] = [];
let clients: Client[] = [];

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  dataDirs = [];
  registries = [];
  mailStores = [];
  rosterStores = [];
  clients = [];
});

afterEach(async () => {
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

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeProject(): { projectId: ProjectId; cwd: string } {
  const dataDir = mkdtempSync(join(tmpdir(), 'co-hp-'));
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

function seedActionableMail(projectId: ProjectId, agent: string): void {
  const mail = openMailStore(projectId);
  mailStores.push(mail);
  mail.send({
    type: 'clarify_request',
    to: agent,
    from: 'coord-1',
    subject: 'host-proof task',
    body: 'prove the plumbing',
  });
}

function outstandingItem(projectId: ProjectId, agent: string): DeliveredMail {
  const store = openMailStore(projectId);
  mailStores.push(store);
  const item = store.outstanding(agent)[0];
  if (item == null) throw new Error(`test expected outstanding mail for '${agent}'`);
  return item;
}

function makeIdentity(agent: string, projectId: ProjectId, cwd: string): HostedIdentity {
  return {
    agent,
    role: 'implementer',
    parent: 'coord-1',
    pane: `pane-${agent}`,
    provider: 'claude',
    resume: { provider: 'claude', sessionId: `session-${agent}` },
    projectId,
    cwd,
  };
}

/** Drain microtasks + a macrotask. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
/** A few ticks for steps with several chained internal awaits (e.g. MCP bind handshake). */
const flush = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i++) await tick();
};

/** Mutable monotonic clock — DATA, never a wall clock. */
function makeClock(): { now: () => number; set: (t: number) => void } {
  let t = 0;
  return { now: () => t, set: (next) => void (t = next) };
}

/** Controllable byte-quiet window: resolves on `settle()` or on its own re-arm abort. */
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

/** Drive a hosted pane through ONE idle turn: echo the injected text, emit turn bytes, settle quiet. */
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

const neverResolve = (): Promise<void> => new Promise<void>(() => {});

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('runHostProof — AC-S10-4·2: full sequence deterministically over FakePty + fakes', () => {
  it('runs spawn → inject → 1 turn → SIGKILL → recover → reconstruct → steer deterministically', async () => {
    const { projectId, cwd } = makeProject();
    seedParentChain(projectId);
    seedActionableMail(projectId, 'impl-hp');
    const identity = makeIdentity('impl-hp', projectId, cwd);
    const mail = outstandingItem(projectId, 'impl-hp');

    const pty = new FakePty();
    const clock = makeClock();
    const qw = makeQuietWindow();

    // Start the driver — it will block at ensureHosted until the pane emits startup bytes.
    // awaitMailRouted: simulates the agent calling co_mail_send via the live MCP surface to
    // prove LiveDelivery routing works (the FakePty architectural constraint means the pane
    // can't make real MCP calls itself; this seam bridges that gap in-sandbox).
    const proofP = runHostProof(projectId, identity, mail, {
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      injectOptions: { retryDelay: neverResolve },
      awaitMailRouted: async (clientTransport) => {
        const c = new Client({ name: 'fake-provider-router', version: '0.0.0' });
        clients.push(c);
        await c.connect(clientTransport);
        await c.callTool({
          name: 'co_mail_send',
          arguments: {
            to: 'coord-1',
            type: 'clarify_request',
            subject: 'turn complete',
            body: 'proof routing',
          },
        });
      },
    });

    // The pane is spawned synchronously before ensureHosted's first await.
    expect(pty.panes).toHaveLength(1);
    const pane = pty.panes[0]!;
    expect(pane.spec.command).toBe('claude');

    // Drive startup to ready.
    pane.emit(CLAUDE_READY);
    await flush(6); // driveToReady resolves, MCP bind completes, injectMail starts

    // Drive EXACTLY ONE turn to its idle boundary.
    await driveTurnToIdle(pane, mail, clock, qw);

    // Await the full proof.
    const result = await proofP;

    // AC-S10-4·2 (1): turn ran without error and reached an idle boundary.
    expect(result.turnRan).toBe(true);
    expect(result.turnIdle).toBe(true);

    // AC-S10-4·2 (emitted mail routed): fake MCP client called co_mail_send → LiveDelivery routed
    // it to coord-1's inbox through the real MCP surface (proven without a real binary).
    expect(result.mailRouted).toBe(true);

    // AC-S10-4·2 (2): recoverProjectStore + listSessions reconstructed the agent's session.
    expect(result.sessionReconstructed).toBe(true);
    expect(result.recoveredSessions.some((s) => s.agentId === 'impl-hp')).toBe(true);

    // AC-S10-4·2 (3): mid-turn interrupt steer completed on the still-warm hosted pane.
    expect(result.steerCompleted).toBe(true);
    // Interrupt key (ESC) was written to the pane.
    expect(pane.written).toContain(ESC);

    // EXACTLY one turn submitted: the composer received exactly one Enter.
    expect(pane.written.filter((w) => w === '\r')).toHaveLength(1);
  });
});
