/**
 * Stage 15 P-F (L1) — `FakeProvider`: the reusable in-sandbox provider double for the Conductor
 * host-proof harness. It plays a realistic startup → spinner → quiet timeline against a {@link FakePty}
 * pane AND drives the MCP client side to call tools, so the SAME `runHostProof` driver can be exercised
 * with no real `claude`/`codex` binary (a `sandbox-fake` run).
 *
 * RULING (do NOT quarantine to a test dir): this ships in `src`, exactly like {@link FakePty} ships in
 * `packages/core/src` and is barrel-exported. Rationale: the FakePty precedent (seam-fakes ship in src),
 * it needs the MCP SDK `Client` (an mcp-layer concern, not core), and it keeps the unified `runProof`
 * uniform (all targets resolved from one module, no test-only branch). Principle 12 (pristine-repo) is
 * about not committing orchestration STATE (`.co/` files) — NOT about seam-fakes; CO treats these as
 * first-class.
 *
 * The pieces are deliberately composable: the fine-grained host-proof tests drive `runHostProof`
 * directly with the {@link makeCounterClock} / {@link makeControllableQuietWindow} / {@link driveTurnToIdle}
 * / {@link routeProofMail} primitives, while {@link driveFakeProviderProof} is the higher-level
 * autonomous drive that lets `runProof('fake')` (L2) be a SINGLE call.
 *
 * SOURCE holds no raw control bytes: ESC/BEL only appear inside the {@link CLAUDE_READY} fixture
 * (authored from code points in `@co/core`), never inline here.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  CLAUDE_READY,
  MAIL_CLARIFY_REQUEST,
  WEDGE_MS,
  defaultMailRenderer,
  openMailStore,
  type DeliveredMail,
  type FakePty,
  type FakePtyPane,
  type MailStore,
  type ProjectId,
} from '@co/core';
import type { TransportPair } from './engine.js';

// ── Determinism helpers (lifted from the host-proof test scaffolding) ───────────────────────────────

/** Drain microtasks + a macrotask. */
export const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A few ticks for steps with several chained internal awaits (e.g. the MCP bind handshake). */
export const flush = async (n = 4): Promise<void> => {
  for (let i = 0; i < n; i++) await tick();
};

/** Poll `predicate` on a real (wall-clock) cadence until true; throws on timeout. Used only to wait for
 *  a CONCURRENT promise (the driver) to seed a store row — orthogonal to the injected engine clock. */
export const waitUntil = async (predicate: () => boolean, timeoutMs = 1000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for fake-provider predicate');
};

/** A `retryDelay` seam that never wins the echo race — parks `injectMail` until the provider emits the
 *  composer echo (the deterministic in-sandbox injection contract). */
export const neverResolve = (): Promise<void> => new Promise<void>(() => {});

/**
 * The injected-clock mark for the SEPARATE steer turn (turn-2). {@link driveFakeProviderProof} emits the
 * turn-2 spinner byte at this mark; the operator-path `beforeSteer` settles the quiet window at
 * `STEER_TURN_CLOCK_MS + WEDGE_MS + 1` so the steer interrupts BEFORE the turn reaches byte-idle.
 */
export const STEER_TURN_CLOCK_MS = 2000;

// ── Counter clock ───────────────────────────────────────────────────────────────────────────────────

/** A mutable monotonic clock — DATA, never a wall clock (the detector's replay-determinism rests on it). */
export interface CounterClock {
  readonly now: () => number;
  set(t: number): void;
}

/** Build a {@link CounterClock} starting at 0. */
export function makeCounterClock(): CounterClock {
  let t = 0;
  return { now: () => t, set: (next) => void (t = next) };
}

// ── Controllable byte-quiet window ────────────────────────────────────────────────────────────────────

/** A controllable byte-quiet window seam: each armed window resolves on `settle()` or on its own re-arm abort. */
export interface ControllableQuietWindow {
  readonly quietWindow: (signal: AbortSignal) => Promise<void>;
  settle(): void;
}

/** Build a {@link ControllableQuietWindow}. */
export function makeControllableQuietWindow(): ControllableQuietWindow {
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

// ── Turn timeline ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Drive a hosted pane through ONE idle turn: echo the injected text (so `injectMail` submits exactly one
 * Enter), emit turn bytes, advance the counter clock past {@link WEDGE_MS}, then settle the quiet window
 * with no further output ⇒ idle. This is the executable reference for correct turn-1 timing.
 */
export async function driveTurnToIdle(
  pane: FakePtyPane,
  item: DeliveredMail,
  clock: CounterClock,
  qw: ControllableQuietWindow,
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

// ── MCP route-client ──────────────────────────────────────────────────────────────────────────────────

/** A single `co_mail_send` arguments payload routed through the fake provider's MCP client. */
export interface ProofMailArgs {
  readonly to: string;
  /** Mail type; default {@link MAIL_CLARIFY_REQUEST}. */
  readonly type?: string;
  readonly subject: string;
  readonly body: string;
}

/** Options for {@link routeProofMail}. The single-message defaults derive subject/body from `nonce`. */
export interface RouteProofMailOptions {
  /** Recipient of the (default) single proof mail. */
  readonly to: string;
  /** The per-run nonce echoed in the default subject/body. */
  readonly nonce: string;
  /** Mail type for the default single message. */
  readonly type?: string;
  /** Override the default subject (`turn complete <nonce>`). */
  readonly subject?: string;
  /** Override the default body (`proof routing <nonce>`). */
  readonly body?: string;
  /** Send these messages instead of the single default (for duplicate / extra-invalid variations). */
  readonly messages?: readonly ProofMailArgs[];
  /** Register the connected client for cleanup (callers close it; the host-proof test closes in afterEach). */
  readonly register?: (client: Client) => void;
}

/**
 * Connect a fake MCP {@link Client} to the client-side transport and call `co_mail_send` once per
 * message, simulating what a real agent does during a turn (the FakePty pane cannot itself make real MCP
 * calls — this seam bridges that gap in-sandbox). Returns the connected client so the caller can close
 * it; also invokes `register` if supplied.
 */
export async function routeProofMail(
  clientTransport: TransportPair[0],
  opts: RouteProofMailOptions,
): Promise<Client> {
  const client = new Client({ name: 'fake-provider-router', version: '0.0.0' });
  opts.register?.(client);
  await client.connect(clientTransport);
  const messages: readonly ProofMailArgs[] = opts.messages ?? [
    {
      to: opts.to,
      ...(opts.type != null ? { type: opts.type } : {}),
      subject: opts.subject ?? `turn complete ${opts.nonce}`,
      body: opts.body ?? `proof routing ${opts.nonce}`,
    },
  ];
  for (const message of messages) {
    await client.callTool({
      name: 'co_mail_send',
      arguments: {
        to: message.to,
        type: message.type ?? MAIL_CLARIFY_REQUEST,
        subject: message.subject,
        body: message.body,
      },
    });
  }
  return client;
}

// ── Autonomous drive ──────────────────────────────────────────────────────────────────────────────────

/** Seams for {@link driveFakeProviderProof}. */
export interface FakeProviderDriveDeps {
  /** The {@link FakePty} `runHostProof` is hosting the proof pane on. */
  readonly pty: FakePty;
  /** The counter clock shared with the `runHostProof` seam bundle. */
  readonly clock: CounterClock;
  /** The controllable quiet window shared with the `runHostProof` seam bundle. */
  readonly quietWindow: ControllableQuietWindow;
  /** The turn-1 actionable item (its rendered text is the echo `driveTurnToIdle` emits). */
  readonly mail: DeliveredMail;
  /** The per-run nonce — the seeded steer mail carries `host-proof steer <nonce>` in its subject. */
  readonly nonce: string;
  /** The project whose mail store the seeded steer mail lands in. */
  readonly projectId: ProjectId;
  /** The hosted agent id — recipient of the seeded steer-proof mail (`identity.agent`). */
  readonly steerRecipient: string;
  /** Opens the mail store to poll for the seeded steer mail. Default: {@link openMailStore}. */
  readonly openMail?: (projectId: ProjectId) => MailStore;
  /** The startup ready bytes to emit. Default: the shared {@link CLAUDE_READY} fixture. */
  readonly readyBytes?: string;
}

/**
 * The higher-level autonomous FakeProvider drive: run this CONCURRENTLY with `runHostProof` (the
 * `runProof('fake')` path does `Promise.all`). It watches for the spawned pane, emits the shared
 * `CLAUDE_READY` once the engine's `driveToReady` listener is attached, drives turn-1 (the route-proof
 * turn) to idle, then — for the SEPARATE steer turn — echoes the seeded steer mail and emits a spinner
 * byte so the operator-path `beforeSteer` can settle the window and steer mid-turn.
 *
 * Routing the proof mail itself rides the `awaitMailRouted` seam the `runHostProof` driver already calls
 * (wired to {@link routeProofMail} by `runProof`), not this drive — the FakePty pane cannot make real
 * MCP calls, so routing must use the client-side transport the driver hands to that seam.
 */
export async function driveFakeProviderProof(deps: FakeProviderDriveDeps): Promise<void> {
  const openMail = deps.openMail ?? openMailStore;
  const readyBytes = deps.readyBytes ?? CLAUDE_READY;

  // Guard the Promise.all race: let runHostProof's synchronous prefix spawn the pane + attach the
  // driveToReady onData listener before we emit READY (it does both before its first await).
  await tick();
  const pane = deps.pty.panes[0];
  if (pane == null) {
    throw new Error(
      'driveFakeProviderProof: no pane was spawned — runHostProof must run concurrently (its ' +
        'synchronous prefix spawns the pane before its first await).',
    );
  }

  // Drive startup to ready, then drive the route-proof turn (turn-1) to its idle boundary.
  pane.emit(readyBytes);
  await flush(6);
  await driveTurnToIdle(pane, deps.mail, deps.clock, deps.quietWindow);

  // Drive the SEPARATE steer turn (turn-2): wait for runHostProof to seed the steer mail, echo it so
  // turn-2's injectMail submits, then emit a spinner byte at STEER_TURN_CLOCK_MS so the quiet window
  // re-arms. The operator-path beforeSteer settles it past WEDGE_MS, interrupting mid-turn.
  const store = openMail(deps.projectId);
  try {
    const steerSubject = `host-proof steer ${deps.nonce}`;
    await waitUntil(() =>
      store.outstanding(deps.steerRecipient).some((item) => item.subject.includes(steerSubject)),
    );
    const steerMail = store
      .outstanding(deps.steerRecipient)
      .find((item) => item.subject.includes(steerSubject));
    if (steerMail == null) {
      throw new Error(
        'driveFakeProviderProof: expected the seeded steer-proof mail to be outstanding.',
      );
    }
    pane.emit(defaultMailRenderer(steerMail)); // composer echo → turn-2 injectMail submits
    await tick();
    deps.clock.set(STEER_TURN_CLOCK_MS);
    pane.emit('⠋ steer turn working…\r\n'); // turn-2 bytes re-arm the quiet window
    await tick();
  } finally {
    store.close();
  }
}
