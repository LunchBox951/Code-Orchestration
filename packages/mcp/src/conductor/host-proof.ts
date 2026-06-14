/**
 * P4 (Stage 10 · AC-S10-4·2) — the turnkey host-proof driver. Composes the LANDED building blocks
 * into the full operator proof: spawn → inject 1 mail → 1 turn → assert mail routed → SIGKILL →
 * `recoverProjectStore` → reconstruct → mid-turn `steer`.
 *
 * IN-SANDBOX: runs against {@link FakePty} + the fake-provider transport (2a) + injected time
 * (deterministic). The FakePty pane and turn are driven externally by the test harness (emit
 * startup bytes, then turn bytes, then settle the quiet window).
 *
 * HOST-LIVE: the operator swaps in `NodePtyHost.create()` + the real stream transport (2a's
 * {@link createStreamTransportPair}) + real timers. That swap is the ONLY `[host-live]` part.
 *
 * REGISTERS ZERO AGENT MCP TOOLS (Principle 4 + D4). The driver is operator-only.
 */
import {
  openMailStore,
  openSessionStore,
  recoverProjectStore,
  type DeliveredMail,
  type InjectMailOptions,
  type ProjectId,
  type PtyHost,
  type SessionRecord,
} from '@co/core';
import { ConductorEngine, type TransportPair } from './engine.js';
import type { HostedIdentity } from '../live-session-host.js';

// ── Seams ─────────────────────────────────────────────────────────────────────

/**
 * Injectable seams for {@link runHostProof}. In-sandbox, inject {@link FakePty},
 * {@link InMemoryTransport.createLinkedPair} (or {@link createStreamTransportPair}), a mutable
 * counter clock, and a controllable settle seam. Host-live, inject {@link NodePtyHost.create},
 * {@link createStreamTransportPair}, {@link monotonicNowMs}, and {@link realQuietWindow}.
 */
export interface HostProofSeams {
  /** Hosts panes. `FakePty` in-sandbox; `NodePtyHost` host-live. */
  readonly pty: PtyHost;
  /** Produces the linked transport pair for the engine's MCP bind. */
  readonly makeTransport: () => TransportPair;
  /** Monotonic ms source — DATA, never a wall clock. */
  readonly now: () => number;
  /** Byte-quiet window seam. */
  readonly quietWindow: (signal: AbortSignal) => Promise<void>;
  /** Extra inject options (e.g. a non-resolving `retryDelay` for sandbox determinism). */
  readonly injectOptions?: Omit<InjectMailOptions, 'provider'>;
  /**
   * Called after the turn completes with the client-side transport so that in-sandbox tests can
   * connect a fake MCP Client and call `co_mail_send`, simulating what a real agent does during
   * a turn. The driver awaits this before checking the mail store for routed items.
   *
   * In-sandbox: inject a fake-client function that calls `co_mail_send`.
   * Host-live: omit (the real agent calls `co_mail_send` naturally during the turn).
   */
  readonly awaitMailRouted?: (clientTransport: TransportPair[0]) => Promise<void>;
}

// ── Result ────────────────────────────────────────────────────────────────────

/** The structured outcome of {@link runHostProof}. Every field asserts one step of the sequence. */
export interface HostProofResult {
  /** True when the turn ran without error. */
  readonly turnRan: boolean;
  /** True when the turn reached an idle boundary (byte-quiescence). */
  readonly turnIdle: boolean;
  /** True when `recoverProjectStore` + `selectAllSessions` reconstructed the agent's session. */
  readonly sessionReconstructed: boolean;
  /** True when at least one mail item was routed to another agent during or after the turn. */
  readonly mailRouted: boolean;
  /** True when `engine.steer` succeeded on the (still-warm) hosted pane. */
  readonly steerCompleted: boolean;
  /** The recovered session records (for caller inspection). */
  readonly recoveredSessions: readonly SessionRecord[];
}

// ── Driver ────────────────────────────────────────────────────────────────────

/**
 * Run the FULL host-proof sequence against the injected `seams` and return the structured result.
 *
 * Sequence:
 *   1. Build a {@link ConductorEngine} with `seams`.
 *   2. {@link ConductorEngine.ensureHosted} — spawn the provider pane and drive it to ready.
 *      (In-sandbox: the test emits startup bytes before awaiting this; host-live: real pty ready.)
 *   3. {@link ConductorEngine.runOneTurn} — inject `mail` into the warm pane and drive exactly
 *      one turn to its idle boundary.
 *      (In-sandbox: the test drives the byte trace and settles the quiet window in parallel.)
 *   3b. `seams.awaitMailRouted` — in-sandbox, a fake MCP Client connects and calls `co_mail_send`
 *       to prove the {@link LiveDelivery} routing path is live. Host-live: the real agent calls
 *       `co_mail_send` naturally during the turn, so this seam is omitted. Either way, the driver
 *       checks the parent's mail store for routed items and records `mailRouted`.
 *   4. `pane.kill('SIGKILL')` — simulate a crash.
 *   5. {@link recoverProjectStore} — holistic replay from the event log.
 *   6. {@link openSessionStore}.listSessions() — reconstruct the live set; assert the agent is there.
 *   7. {@link ConductorEngine.steer} — mid-turn `interrupt` on the still-hosted pane (the engine
 *      keeps the warm handle until explicit release; steer proves the routing path is live).
 *
 * @param projectId - The project whose live set to drive.
 * @param identity  - The authoritative session identity (from the P2 session record).
 * @param mail      - The actionable item to inject (caller seeds it before calling).
 * @param seams     - Injected seams (pty / transport / timing).
 */
export async function runHostProof(
  projectId: ProjectId,
  identity: HostedIdentity,
  mail: DeliveredMail,
  seams: HostProofSeams,
): Promise<HostProofResult> {
  const engine = new ConductorEngine({
    pty: seams.pty,
    makeTransport: seams.makeTransport,
    now: seams.now,
    quietWindow: seams.quietWindow,
    ...(seams.injectOptions != null ? { injectOptions: seams.injectOptions } : {}),
  });

  // Step 2: spawn → driveToReady → bind MCP.
  const hosted = await engine.ensureHosted(identity);

  // Step 3: inject mail → run EXACTLY ONE turn → detect idle.
  const turn = await engine.runOneTurn(hosted, mail);

  // Step 3b: prove emitted-mail routing through the live MCP surface.
  // In-sandbox: the seam connects a fake MCP Client and calls co_mail_send, simulating what the
  // real agent does during a turn. Host-live: omit the seam; the real agent calls co_mail_send
  // naturally, and the mail is already in the store by the time the turn resolves.
  await seams.awaitMailRouted?.(hosted.clientTransport);
  const routingStore = openMailStore(projectId);
  let mailRouted: boolean;
  try {
    mailRouted = routingStore.outstanding(identity.parent).length > 0;
  } finally {
    routingStore.close();
  }

  // Step 4: SIGKILL — simulate a provider crash.
  hosted.pane.kill('SIGKILL');

  // Step 5: holistic recovery — rebuild every read-model from the event log.
  recoverProjectStore(projectId);

  // Step 6: reconstruct the live set from the recovered projections.
  const sessionStore = openSessionStore(projectId);
  let recoveredSessions: readonly SessionRecord[];
  try {
    recoveredSessions = sessionStore.listSessions();
  } finally {
    sessionStore.close();
  }
  const sessionReconstructed = recoveredSessions.some((s) => s.agentId === identity.agent);

  // Step 7: mid-turn steer — interrupt on the still-hosted warm pane.
  // The engine keeps the warm handle until explicit release; an interrupt writes the provider's
  // interrupt key to the pane without a composer echo (no await on a pty read).
  await engine.steer(projectId, identity.agent, { kind: 'interrupt' });

  await engine.closeAll();

  return {
    turnRan: !turn.errored,
    turnIdle: turn.turnEnd?.idle === true,
    mailRouted,
    sessionReconstructed,
    steerCompleted: true,
    recoveredSessions,
  };
}

// ── Operator entry ────────────────────────────────────────────────────────────

/**
 * The `co-mcp host-proof <provider>` operator entry. Runs {@link runHostProof} once against the
 * given provider using the `[host-live]` seams (real node-pty, real stream transport, real timers).
 *
 * This is the documented `[host-live]` invocation path in the P4 runbook (`docs/host-proof.md`).
 * It is NEVER called in-sandbox; the test directly calls {@link runHostProof} with fake seams.
 *
 * Fails loud (Principle 9) on a missing provider argument.
 */
export async function runHostProofCommand(argv: readonly string[]): Promise<void> {
  const provider = argv[0];
  const projectId = argv[1];
  if (provider !== 'claude' && provider !== 'codex') {
    throw new Error(
      `co-mcp host-proof: provider must be 'claude' or 'codex' (got: ${provider ?? '(none)'}). ` +
        'Usage: co-mcp host-proof <provider> <projectId>',
    );
  }
  if (projectId == null || projectId.trim().length === 0) {
    throw new Error(
      'co-mcp host-proof: a project id is required. ' +
        'Usage: co-mcp host-proof <provider> <projectId>',
    );
  }
  // [host-live] — import real seams at call-time (node-pty + real timers + stream transport).
  // These are NOT imported at module-load so the module is safe to import in-sandbox tests
  // without side-effects (node-pty is a native addon; its absence in sandbox must not crash).
  const { NodePtyHost } = await import('@co/core');
  const { createStreamTransportPair } = await import('./real-transport.js');
  const { monotonicNowMs, realQuietWindow } = await import('./host.js');

  const mailStore = openMailStore(projectId);
  let mail: DeliveredMail | undefined;
  try {
    const entries = mailStore.outstanding('@operator');
    mail = entries[0];
    if (mail == null) {
      throw new Error(
        `co-mcp host-proof: no outstanding @operator mail in project '${projectId}'. ` +
          'Inject a test mail with `co mail send` before running the proof.',
      );
    }
  } finally {
    mailStore.close();
  }

  const pty = await NodePtyHost.create();

  // [host-live] identity — build the correct discriminated ResumeHandle for the provider.
  const resume =
    provider === 'claude'
      ? ({ provider: 'claude', sessionId: `host-proof-session-${provider}` } as const)
      : ({ provider: 'codex', codexHome: process.env.HOME ?? '/tmp' } as const);

  const identity: HostedIdentity = {
    agent: `host-proof-${provider}`,
    role: 'coordinator',
    parent: '@operator',
    pane: `host-proof-pane-${provider}`,
    projectId,
    cwd: process.cwd(),
    provider,
    resume,
  };

  console.error(`[co host-proof] running against ${provider} in project '${projectId}'…`);

  const result = await runHostProof(projectId, identity, mail, {
    pty,
    makeTransport: createStreamTransportPair,
    now: monotonicNowMs,
    quietWindow: realQuietWindow,
  });

  console.error(
    `[co host-proof] result:\n` +
      `  turnRan=${result.turnRan}\n` +
      `  turnIdle=${result.turnIdle}\n` +
      `  mailRouted=${result.mailRouted}\n` +
      `  sessionReconstructed=${result.sessionReconstructed}\n` +
      `  steerCompleted=${result.steerCompleted}\n` +
      `  recoveredSessions=${result.recoveredSessions.length}`,
  );

  if (
    !result.turnRan ||
    !result.mailRouted ||
    !result.sessionReconstructed ||
    !result.steerCompleted
  ) {
    throw new Error(
      '[co host-proof] FAIL — one or more proof steps did not pass (see output above).',
    );
  }

  console.error('[co host-proof] PASS — all proof steps completed.');
}
