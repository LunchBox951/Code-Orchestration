/**
 * P4 (Stage 10 · AC-S10-4·2) — the turnkey host-proof driver. Composes the LANDED building blocks
 * into the full operator proof: spawn → inject route-proof mail → route+idle turn → assert mail
 * routed → warm-pane `steer` proof → SIGKILL → `recoverProjectStore` → reconstruct.
 *
 * IN-SANDBOX: runs against {@link FakePty} + the fake-provider transport (2a) + injected time
 * (deterministic). The FakePty pane and turn are driven externally by the test harness (emit
 * startup bytes, then turn bytes, then settle the quiet window).
 *
 * HOST-LIVE: the operator swaps in `NodePtyHost.create()` + a socket bridge transport (the
 * provider launches `co-mcp bridge <socket>`) + real timers. That swap is the ONLY `[host-live]` part.
 *
 * REGISTERS ZERO AGENT MCP TOOLS (Principle 4 + D4). The driver is operator-only.
 */
import {
  MAIL_CLARIFY_REQUEST,
  OPERATOR,
  WEDGE_MS,
  buildPaneLaunchConfig,
  defaultMailRenderer,
  FakePty,
  NodePtyHost,
  normalizeStartupOutput,
  openMailStore,
  openRegistry,
  openSessionStore,
  recoverProjectStore,
  toolsForRole,
  type DeliveredMail,
  type InjectMailOptions,
  type MailRenderer,
  type MailStore,
  type ProjectId,
  type PtyHost,
  type SessionRecord,
  type SpawnSpec,
} from '@co/core';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ConductorEngine, type TransportPair } from './engine.js';
import {
  STEER_TURN_CLOCK_MS,
  driveFakeProviderProof,
  makeControllableQuietWindow,
  makeCounterClock,
  neverResolve,
  routeProofMail,
} from './fake-provider.js';
import type { HostedIdentity } from '../live-session-host.js';
import {
  CO_AGENT_ENV,
  CO_MCP_BRIDGE_LOG_ENV,
  CO_PARENT_ENV,
  CO_PROJECT_ID_ENV,
  CO_ROLE_ENV,
} from '../context.js';
import { defaultCoMcpPaths } from './host-launch-paths.js';
import { providerAuthPrelaunchFiles } from './placement-launch.js';
import { resolveHostLiveSeams } from './host-live-seams.js';

// ── Seams ─────────────────────────────────────────────────────────────────────

/**
 * Injectable seams for {@link runHostProof}. In-sandbox, inject {@link FakePty},
 * {@link InMemoryTransport.createLinkedPair} (or a socket/stream transport pair), a mutable
 * counter clock, and a controllable settle seam. Host-live, inject {@link NodePtyHost.create},
 * {@link createSocketBridgeTransportPair}, {@link monotonicNowMs}, and {@link realQuietWindow}.
 */
export interface HostProofSeams {
  /** Hosts panes. `FakePty` in-sandbox; `NodePtyHost` host-live. */
  readonly pty: PtyHost;
  /** Produces the linked transport pair for the engine's MCP bind. */
  readonly makeTransport: (identity: HostedIdentity) => TransportPair;
  /** Optional explicit tool surface for the hosted proof session. */
  readonly sessionTools?: (identity: HostedIdentity) => ReturnType<typeof toolsForRole> | undefined;
  /** Monotonic ms source — DATA, never a wall clock. */
  readonly now: () => number;
  /** Byte-quiet window seam. */
  readonly quietWindow: (signal: AbortSignal) => Promise<void>;
  /** Extra inject options (e.g. a non-resolving `retryDelay` for sandbox determinism). */
  readonly injectOptions?: Omit<InjectMailOptions, 'provider'>;
  /** Optional proof-specific renderer for the injected mail text. */
  readonly renderMail?: MailRenderer;
  /** Optional host-live settle after startup before injecting the proof turn. */
  readonly afterReady?: () => Promise<void>;
  /** Optional host-live settle after route proof before steering the still-running turn. */
  readonly beforeSteer?: () => Promise<void>;
  /**
   * When true, the routed proof turn is allowed to reach natural idle before a second short turn is
   * used only to prove mid-turn steering. Host-live uses this because interrupting the routed turn can
   * correctly prevent that same turn from reporting byte-idle.
   */
  readonly separateSteerTurn?: boolean;
  /** Delay before steering the separate steer-proof turn, giving the provider time to start work. */
  readonly steerTurnStartDelayMs?: number;
  /** Max time to wait for routed proof mail when host-live routing is polling the mail store. */
  readonly routeTimeoutMs?: number;
  /** Max extra time to wait for routed proof mail after the turn has reached its byte-idle boundary. */
  readonly routePostSettleGraceMs?: number;
  /** Optional pane transcript hook for host-live diagnostics. */
  readonly onPaneData?: (chunk: string) => void;
  /** Optional explicit provider spawn spec. Host-live uses this to attach provider MCP config. */
  readonly spawnSpec?: SpawnSpec;
  /**
   * Called after the turn completes with the client-side transport so that in-sandbox tests can
   * connect a fake MCP Client and call `co_mail_send`, simulating what a real agent does during
   * a turn. The driver awaits this before checking the mail store for routed items.
   *
   * In-sandbox: inject a fake-client function that calls `co_mail_send`.
   * Host-live: omit (the real agent calls `co_mail_send` naturally during the turn).
   */
  readonly awaitMailRouted?: (clientTransport: TransportPair[0]) => Promise<void>;
  /**
   * Optional per-run nonce that a routed proof mail must echo in its subject or body. Host-live uses this
   * to prove the reply belongs to THIS proof run, not a stale same-sender item from an earlier attempt.
   */
  readonly expectedRouteNonce?: string;
}

// ── Result ────────────────────────────────────────────────────────────────────

/** The structured outcome of {@link runHostProof}. Every field asserts one step of the sequence. */
export interface HostProofResult {
  /** True when the turn ran without error. */
  readonly turnRan: boolean;
  /** True when the turn reached an idle boundary (byte-quiescence). */
  readonly turnIdle: boolean;
  /** Turn error diagnostic when `turnRan` is false. */
  readonly turnError?: string;
  /** True when `recoverProjectStore` + `openSessionStore().listSessions()` reconstructed the agent's session. */
  readonly sessionReconstructed: boolean;
  /** True when at least one mail item was routed to another agent during or after the turn. */
  readonly mailRouted: boolean;
  /** True when `engine.steer` succeeded on the (still-warm) hosted pane. */
  readonly steerCompleted: boolean;
  /** True when the steer was sent before the turn promise settled. */
  readonly steerMidTurn: boolean;
  /** The recovered session records (for caller inspection). */
  readonly recoveredSessions: readonly SessionRecord[];
}

// ── Driver ────────────────────────────────────────────────────────────────────

const DEFAULT_ROUTE_TIMEOUT_MS = 30_000;
const DEFAULT_ROUTE_POST_SETTLE_GRACE_MS = 1_000;
const DEFAULT_STEER_TURN_START_DELAY_MS = 1_000;
const ROUTE_POLL_INTERVAL_MS = 250;

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
 *   4. {@link ConductorEngine.steer} — interrupt on the still-hosted pane BEFORE crash simulation.
 *      Default/in-sandbox path steers the routed turn. With `separateSteerTurn`, the routed turn is
 *      first allowed to reach idle; the driver then seeds a second no-tools steer mail, waits until
 *      that mail has been submitted into the warm pane, and interrupts that second turn. This is the
 *      host-live path because interrupting the route-proof turn can correctly prevent that same turn
 *      from reporting byte-idle.
 *   5. `pane.kill('SIGKILL')` — simulate a crash.
 *   6. {@link recoverProjectStore} — holistic replay from the event log.
 *   7. {@link openSessionStore}.listSessions() — reconstruct the live set; assert the agent is there.
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
    ...(seams.sessionTools != null ? { sessionTools: seams.sessionTools } : {}),
    now: seams.now,
    quietWindow: seams.quietWindow,
    ...(seams.injectOptions != null ? { injectOptions: seams.injectOptions } : {}),
    ...(seams.renderMail != null ? { renderMail: seams.renderMail } : {}),
  });

  let unsubPaneData = noop;
  try {
    // Step 2: spawn → bind MCP → driveToReady.
    const hosted = await engine.ensureHosted(identity, seams.spawnSpec);
    if (seams.onPaneData != null) {
      unsubPaneData = hosted.pane.onData(seams.onPaneData);
    }
    if (!hosted.startup.authed) {
      const methods = hosted.startup.loginRequired?.methods.join(', ') || 'unknown methods';
      throw new Error(
        `runHostProof: provider '${identity.provider}' is not authenticated; login required ` +
          `before host proof can inject a turn (${methods}).`,
      );
    }
    await seams.afterReady?.();

    const beforeRouteSeq = parentInboxMaxSeq(projectId, identity.parent);

    // Step 3: inject mail → run EXACTLY ONE turn → detect idle. Keep the promise live so the steer can
    // be sent before the turn settles whenever the routing proof arrives first.
    let turnSettled = false;
    const turnP = engine.runOneTurn(hosted, mail).finally(() => {
      turnSettled = true;
    });

    // Step 3b: prove emitted-mail routing through the live MCP surface.
    // In-sandbox: the seam connects a fake MCP Client and calls co_mail_send, simulating what the
    // real agent does during a turn. Host-live: omit the seam; the driver polls for the real routed
    // proof mail and races that with the turn boundary.
    let mailRouted: boolean;
    if (seams.awaitMailRouted != null) {
      await seams.awaitMailRouted(hosted.clientTransport);
      mailRouted = hasRoutedProofMail(
        projectId,
        identity,
        beforeRouteSeq,
        seams.expectedRouteNonce,
      );
    } else {
      mailRouted = await waitForRouteOrTimeout(
        () => turnSettled,
        () => hasRoutedProofMail(projectId, identity, beforeRouteSeq, seams.expectedRouteNonce),
        seams.routeTimeoutMs ?? DEFAULT_ROUTE_TIMEOUT_MS,
        seams.routePostSettleGraceMs ?? DEFAULT_ROUTE_POST_SETTLE_GRACE_MS,
      );
      if (!mailRouted && !turnSettled) {
        throw new Error(
          `runHostProof: routed proof mail was not observed within ` +
            `${seams.routeTimeoutMs ?? DEFAULT_ROUTE_TIMEOUT_MS}ms while the turn was still active.`,
        );
      }
    }

    let steerMidTurn = false;
    const turn = await (async () => {
      if (seams.separateSteerTurn === true) {
        const routedTurn = await turnP;
        mailRouted = hasRoutedProofMail(
          projectId,
          identity,
          beforeRouteSeq,
          seams.expectedRouteNonce,
        );
        const steerMail = seedSteerProofMail(
          projectId,
          identity,
          seams.expectedRouteNonce ?? randomUUID(),
        );
        let markSteerTurnInjected!: () => void;
        const steerTurnInjected = new Promise<void>((resolve) => {
          markSteerTurnInjected = resolve;
        });
        let steerTurnSettled = false;
        const steerTurnP = engine
          .runOneTurn(hosted, steerMail, { onInjected: markSteerTurnInjected })
          .finally(() => {
            steerTurnSettled = true;
          });
        const steerReady = await Promise.race([
          steerTurnInjected.then(() => ({ injected: true }) as const),
          steerTurnP.then((outcome) => ({ injected: false, outcome }) as const),
        ]);
        if (!steerReady.injected) {
          throw new Error(
            `runHostProof: separate steer turn failed before injection completed: ` +
              errorMessage(steerReady.outcome.error),
          );
        }
        await sleepMs(seams.steerTurnStartDelayMs ?? DEFAULT_STEER_TURN_START_DELAY_MS);
        await seams.beforeSteer?.();
        steerMidTurn = !steerTurnSettled;
        await engine.steer(projectId, identity.agent, { kind: 'interrupt' });
        await steerTurnP;
        return routedTurn;
      }

      // Step 4: steer the still-live warm pane before crash simulation. When routing proves before the
      // turn settles, this is a true mid-turn steer (SF-2); otherwise it remains a fail-loud warm-pane
      // steer before crash.
      await seams.beforeSteer?.();
      steerMidTurn = !turnSettled;
      await engine.steer(projectId, identity.agent, { kind: 'interrupt' });
      return turnP;
    })();
    mailRouted = hasRoutedProofMail(projectId, identity, beforeRouteSeq, seams.expectedRouteNonce);

    // Step 5: SIGKILL — simulate a provider crash.
    hosted.pane.kill('SIGKILL');

    // Step 6: holistic recovery — rebuild every read-model from the event log.
    recoverProjectStore(projectId);

    // Step 7: reconstruct the live set from the recovered projections.
    const sessionStore = openSessionStore(projectId);
    let recoveredSessions: readonly SessionRecord[];
    try {
      recoveredSessions = sessionStore.listSessions();
    } finally {
      sessionStore.close();
    }
    const sessionReconstructed = recoveredSessions.some((s) => s.agentId === identity.agent);

    return {
      turnRan: !turn.errored,
      turnIdle: turn.turnEnd?.idle === true,
      ...(turn.error != null ? { turnError: errorMessage(turn.error) } : {}),
      mailRouted,
      sessionReconstructed,
      steerCompleted: true,
      steerMidTurn,
      recoveredSessions,
    };
  } finally {
    unsubPaneData();
    await engine.closeAll();
  }
}

// ── Unified runProof + Principle-2 provenance guard (Stage 15 P-F) ──────────────

/**
 * The provenance tier of a proof run. `sandbox-fake` is a green FakePty run (it proves the harness
 * wiring, NOT a real provider); `host-live` is a run against a real `claude`/`codex` binary in a real
 * node-pty. A `fake` run can NEVER carry `host-live` — see {@link deriveProofFidelity}.
 */
export type ProofFidelity = 'sandbox-fake' | 'host-live';

/** The proof target: the in-sandbox FakeProvider, or a real provider binary. */
export type ProofMode = 'fake' | 'claude' | 'codex';

/** A {@link HostProofResult} stamped with its authentic provenance {@link ProofFidelity}. */
export interface ProofResult extends HostProofResult {
  readonly fidelity: ProofFidelity;
}

/** Host-live launch artifacts assembled by {@link runHostProofCommand}; ignored for the `fake` mode. */
export interface HostLiveProofInputs {
  /** The provider spawn spec (the isolated, scoped MCP config). */
  readonly spawnSpec: SpawnSpec;
  /** The smallest proof tool surface for the hosted session (the single `co_mail_send` tool). */
  readonly sessionTools: (identity: HostedIdentity) => ReturnType<typeof toolsForRole> | undefined;
  /** The nonce-bearing renderer (emits the tool-call prompt for the route-proof mail only). */
  readonly renderMail: MailRenderer;
  /** The Conductor-owned bridge socket path for the host-live transport pair. */
  readonly socketPath: string;
  /** The bridge diagnostic log path. */
  readonly bridgeLogPath: string;
  /** When true, attach the host-proof pane-trace diagnostic (`CO_HOST_PROOF_TRACE`). */
  readonly trace?: boolean;
}

/** Options for {@link runProof}. The caller supplies the mode-independent "what to prove" inputs. */
export interface RunProofOptions {
  readonly projectId: ProjectId;
  readonly identity: HostedIdentity;
  /** The seeded actionable proof mail (the route-proof turn injects it). */
  readonly mail: DeliveredMail;
  /** The per-run nonce a routed proof mail must echo. */
  readonly nonce: string;
  /** Host-live launch artifacts — REQUIRED for `claude` | `codex`, ignored for `fake`. */
  readonly hostLive?: HostLiveProofInputs;
  /** fake-only: the mail store opener for the autonomous drive's steer-mail poll. Default: {@link openMailStore}. */
  readonly openMail?: (projectId: ProjectId) => MailStore;
  /** fake-only: register the fake MCP clients for cleanup. Default: closed internally after the run. */
  readonly registerClient?: (client: Client) => void;
}

/**
 * Principle 2 (authentic-terminal) + Principle 9 (fail-loud) — derive the provenance tier from the
 * RESOLVED pty host, NEVER from a parameter. A {@link FakePty} ⇒ `sandbox-fake`; a {@link NodePtyHost} ⇒
 * `host-live`. THROWS if the host is neither, or if its kind does not match the requested mode (a `fake`
 * run must NEVER be able to carry `host-live`, even if mislabeled). This is the only place `fidelity`
 * is set, and it is derived — not settable.
 */
export function deriveProofFidelity(mode: ProofMode, pty: PtyHost): ProofFidelity {
  const isFake = pty instanceof FakePty;
  const isNode = pty instanceof NodePtyHost;
  if (!isFake && !isNode) {
    throw new Error(
      `runProof: cannot derive a provenance tier — the resolved pty host '${ptyHostLabel(pty)}' is ` +
        'neither a FakePty (sandbox-fake) nor a NodePtyHost (host-live). Fail-loud (Principle 9): a ' +
        'proof result must carry an authentic fidelity tier.',
    );
  }
  if (mode === 'fake') {
    if (!isFake) {
      throw new Error(
        "runProof: mode 'fake' resolved a non-FakePty host — refusing to tag a non-sandbox bundle as " +
          "'sandbox-fake', and a fake run must NEVER be able to carry 'host-live' (Principle 2 — " +
          'authentic-terminal; Principle 9 — fail-loud).',
      );
    }
    return 'sandbox-fake';
  }
  // mode === 'claude' | 'codex' — host-live only.
  if (!isNode) {
    throw new Error(
      `runProof: mode '${mode}' resolved a non-NodePtyHost host — a host-live proof must run against ` +
        'the real node-pty adapter. Fail-loud (Principle 9).',
    );
  }
  return 'host-live';
}

function ptyHostLabel(pty: unknown): string {
  if (pty == null) return String(pty);
  const ctor = (pty as { constructor?: { name?: string } }).constructor;
  return ctor?.name ?? typeof pty;
}

/**
 * Principle 2 (authentic-terminal) FORWARD GATE — throw (fail-loud) unless `result` is `host-live`.
 *
 * There is no programmatic SH-1 / host-live evidence sink today (host-proof prints to stderr + exits;
 * SH-1 evidence is a manual bundle per `docs/sh1-runbook.md`). This assertion IS the forward gate: any
 * FUTURE SH-1-evidence recorder MUST call it before recording a result as host-live / SH-1 evidence, so
 * a `sandbox-fake` run can never be confused for the real thing.
 */
export function assertHostLiveProof(result: ProofResult): void {
  if (result.fidelity !== 'host-live') {
    throw new Error(
      `assertHostLiveProof: refusing to treat a '${result.fidelity}' proof as host-live / SH-1 ` +
        'evidence. A fake run is sandbox-fake — it proves the harness wiring, NOT that a real ' +
        'claude/codex binary reached ready and routed mail through a real pty (Principle 2 — ' +
        'authentic-terminal). Only a host-live result may be recorded as SH-1 evidence; any future ' +
        'SH-1-evidence recorder MUST call this gate first (Principle 9 — fail-loud).',
    );
  }
}

/**
 * The ONE unified proof entry: the in-sandbox vitest path and the operator host-live path are the SAME
 * `runHostProof` driver, differing ONLY by the resolved seam bundle. `fake` builds {@link FakePty} +
 * the {@link driveFakeProviderProof} autonomous drive + in-memory transport + injected clock/quiet-window
 * and runs both concurrently; `claude`/`codex` build the host-live bundle (real node-pty + socket bridge
 * transport + real timers). The returned {@link ProofResult} is stamped with the tamper-resistant
 * {@link ProofFidelity} derived from the resolved pty host.
 */
export async function runProof(mode: ProofMode, opts: RunProofOptions): Promise<ProofResult> {
  return mode === 'fake' ? runFakeProof(opts) : runHostLiveProof(mode, opts);
}

async function runFakeProof(opts: RunProofOptions): Promise<ProofResult> {
  const { projectId, identity, mail, nonce } = opts;
  const pty = new FakePty();
  const fidelity = deriveProofFidelity('fake', pty); // 'sandbox-fake', or fail-loud on a forced mismatch
  const clock = makeCounterClock();
  const qw = makeControllableQuietWindow();
  const ownedClients: Client[] = [];
  const registerClient =
    opts.registerClient ?? ((client: Client) => void ownedClients.push(client));

  try {
    const proofP = runHostProof(projectId, identity, mail, {
      pty,
      makeTransport: () => InMemoryTransport.createLinkedPair(),
      now: clock.now,
      quietWindow: qw.quietWindow,
      injectOptions: { retryDelay: neverResolve },
      separateSteerTurn: true,
      steerTurnStartDelayMs: 0,
      expectedRouteNonce: nonce,
      // Route the proof mail through the live MCP surface (the FakePty pane can't itself make MCP calls).
      awaitMailRouted: (clientTransport) =>
        routeProofMail(clientTransport, {
          to: identity.parent,
          nonce,
          register: registerClient,
        }).then(() => undefined),
      // Settle the SEPARATE steer turn (turn-2) AFTER the interrupt is sent (steerMidTurn=true) — the
      // operator path. driveFakeProviderProof emits the turn-2 spinner at STEER_TURN_CLOCK_MS.
      beforeSteer: async () => {
        setTimeout(() => {
          clock.set(STEER_TURN_CLOCK_MS + WEDGE_MS + 1);
          qw.settle();
        }, 0);
      },
    });
    const driveP = driveFakeProviderProof({
      pty,
      clock,
      quietWindow: qw,
      mail,
      nonce,
      projectId,
      steerRecipient: identity.agent,
      ...(opts.openMail != null ? { openMail: opts.openMail } : {}),
    });
    const [result] = await Promise.all([proofP, driveP]);
    return { ...result, fidelity };
  } finally {
    for (const client of ownedClients) {
      try {
        await client.close();
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

async function runHostLiveProof(
  mode: 'claude' | 'codex',
  opts: RunProofOptions,
): Promise<ProofResult> {
  const hostLive = opts.hostLive;
  if (hostLive == null) {
    throw new Error(
      `runProof: mode '${mode}' requires host-live launch inputs (opts.hostLive: spawnSpec / ` +
        'sessionTools / renderMail / socketPath / bridgeLogPath). Fail-loud (Principle 9).',
    );
  }
  // [host-live] — resolve the shared real seam bundle at call-time (node-pty native addon + real timers
  // + socket bridge transport). NOT at module load, so the in-sandbox test import stays free of the
  // host-only graph. The benchmark driver builds from the SAME resolveHostLiveSeams (one wiring path).
  const seams = await resolveHostLiveSeams(mode);

  const result = await runHostProof(opts.projectId, opts.identity, opts.mail, {
    pty: seams.pty,
    makeTransport: () => seams.makeTransport(hostLive.socketPath, hostLive.bridgeLogPath),
    sessionTools: hostLive.sessionTools,
    now: seams.now,
    quietWindow: seams.quietWindow,
    injectOptions: { retryDelay: seams.injectRetryDelay, allowUnverifiedSubmit: true },
    afterReady: seams.readySettle,
    ...(hostLive.trace === true ? { onPaneData: hostProofTracePaneData } : {}),
    renderMail: hostLive.renderMail,
    spawnSpec: hostLive.spawnSpec,
    expectedRouteNonce: opts.nonce,
    separateSteerTurn: true,
    routeTimeoutMs: DEFAULT_ROUTE_TIMEOUT_MS,
  });
  return { ...result, fidelity: seams.fidelity };
}

function seedSteerProofMail(
  projectId: ProjectId,
  identity: HostedIdentity,
  nonce: string,
): DeliveredMail {
  const store = openMailStore(projectId);
  try {
    return store.send({
      type: MAIL_CLARIFY_REQUEST,
      to: identity.agent,
      from: OPERATOR,
      subject: `host-proof steer ${nonce}`,
      body:
        `Steer proof nonce: ${nonce}\n\n` +
        'Do not call tools. Keep the turn active briefly until interrupted. If not interrupted, ' +
        `print: host-proof steer complete ${nonce}`,
      idempotencyKey: `${nonce}:steer`,
    });
  } finally {
    store.close();
  }
}

function parentInboxMaxSeq(projectId: ProjectId, parent: string): number {
  const store = openMailStore(projectId);
  try {
    return Math.max(0, ...store.inbox(parent).map((item) => item.seq));
  } finally {
    store.close();
  }
}

function hasRoutedProofMail(
  projectId: ProjectId,
  identity: HostedIdentity,
  beforeRouteSeq: number,
  expectedRouteNonce: string | undefined,
): boolean {
  const routingStore = openMailStore(projectId);
  try {
    // Principle 9 — fail loud: assert the hosted agent itself sent a NEW reply to the parent,
    // NOT merely that the parent's queue is non-empty. The parent may already hold ≥1 item
    // before the turn runs (e.g. the injected test mail in the [host-live] path), so a plain
    // `.length > 0` check is unconditionally true and can never catch broken routing.
    // Matching by `sender === identity.agent` proves a NEW item arrived FROM the hosted agent.
    const routed = routingStore.inbox(identity.parent).filter((item) => {
      if (item.seq <= beforeRouteSeq) return false;
      if (item.sender !== identity.agent) return false;
      return true;
    });
    if (routed.length !== 1) return false;
    const [item] = routed;
    if (item == null || item.type !== MAIL_CLARIFY_REQUEST) return false;
    return (
      expectedRouteNonce == null ||
      item.subject.includes(expectedRouteNonce) ||
      item.body.includes(expectedRouteNonce)
    );
  } finally {
    routingStore.close();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const noop = (): void => {};

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function waitForRouteOrTimeout(
  turnSettled: () => boolean,
  hasRoute: () => boolean,
  timeoutMs: number,
  postSettleGraceMs: number,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let postSettleDeadline: number | undefined;
  while (Date.now() <= deadline) {
    if (hasRoute()) return true;
    if (turnSettled()) {
      postSettleDeadline ??= Date.now() + Math.max(0, postSettleGraceMs);
    }
    const effectiveDeadline =
      postSettleDeadline == null ? deadline : Math.min(deadline, postSettleDeadline);
    const remaining = Math.max(0, effectiveDeadline - Date.now());
    if (remaining === 0) break;
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.min(ROUTE_POLL_INTERVAL_MS, remaining)),
    );
  }
  return hasRoute();
}

export function hostProofMailRenderer(nonce: string, proofToolName: string): MailRenderer {
  return (mail) => {
    if (mail.sender === OPERATOR && mail.subject === `host-proof ${nonce}`) {
      return (
        `Host proof nonce ${nonce}: call the ${proofToolName} MCP tool exactly once to ` +
        `${OPERATOR} with type ${MAIL_CLARIFY_REQUEST}; include nonce ${nonce} in the subject ` +
        'or body. Do not use shell, Bash, node, or a custom script. After the tool call returns, ' +
        `print this visible line in the chat: host-proof complete ${nonce}`
      );
    }
    return defaultMailRenderer(mail);
  };
}

// ── Provider launch config ───────────────────────────────────────────────────

export interface HostProofLaunchPaths {
  /** Isolated config/home dir for the proof pane. */
  readonly isolatedHomeDir: string;
  /** Absolute co MCP stdio command. */
  readonly coMcpCommand: string;
  /** Arguments for the co MCP stdio command. */
  readonly coMcpArgs?: readonly string[];
  /** Optional per-pane bridge socket path. */
  readonly coMcpBridgeSocketPath?: (isolatedHomeDir: string, agent: string) => string;
  /** Absolute co CLI command used by Codex hooks. */
  readonly coCliCommand: string;
  /** Optional host-copied Claude auth file contents for the isolated CLAUDE_CONFIG_DIR. */
  readonly claudeCredentialsJson?: string;
  /** Optional host-copied Claude interactive state for the isolated CLAUDE_CONFIG_DIR. */
  readonly claudeStateJson?: string;
  /** Optional host-copied Codex auth file contents for the isolated CODEX_HOME. */
  readonly codexAuthJson?: string;
  /** Optional Codex hook CLI args, e.g. an absolute script path for `node <script>`. */
  readonly coCliArgs?: readonly string[];
}

export function buildHostProofSpawnSpec(
  identity: HostedIdentity,
  paths: HostProofLaunchPaths,
): SpawnSpec {
  const mountedRole =
    identity.subRole != null ? `${identity.role}:${identity.subRole}` : identity.role;
  const bridgeSocketPath = paths.coMcpBridgeSocketPath?.(paths.isolatedHomeDir, identity.agent);
  const coMcpArgs =
    bridgeSocketPath == null
      ? paths.coMcpArgs
      : [...(paths.coMcpArgs ?? []), 'bridge', bridgeSocketPath];
  const paneLaunchConfig = buildPaneLaunchConfig(identity.provider, {
    cwd: identity.cwd,
    isolatedHomeDir: paths.isolatedHomeDir,
    // Thread the base role so buildPaneLaunchConfig injects the repo-agnostic base system prompt
    // (Claude --append-system-prompt / Codex config override). Without this the prompt is a no-op.
    role: identity.role,
    ...(identity.provider === 'claude'
      ? { coMcpConfig: `${paths.isolatedHomeDir.replace(/\/+$/u, '')}/mcp/co-mcp.json` }
      : {}),
    coMcpCommand: paths.coMcpCommand,
    coMcpArgs,
    coMcpEnv: {
      [CO_AGENT_ENV]: identity.agent,
      [CO_ROLE_ENV]: mountedRole,
      [CO_PARENT_ENV]: identity.parent,
      [CO_PROJECT_ID_ENV]: identity.projectId,
      ...bridgeDiagnosticEnv(paths.isolatedHomeDir, bridgeSocketPath),
    },
    coCliCommand: paths.coCliCommand,
    ...(paths.coCliArgs != null ? { coCliArgs: paths.coCliArgs } : {}),
  });

  return {
    command: identity.provider,
    args: [...paneLaunchConfig.args, ...codexBridgeSocketArgs(identity.provider, bridgeSocketPath)],
    cwd: identity.cwd,
    env: { ...paneLaunchConfig.env },
    prelaunchFiles: [
      ...(paneLaunchConfig.prelaunchFiles ?? []),
      ...providerAuthPrelaunchFiles(identity.provider, paths.isolatedHomeDir, paths),
    ],
  };
}

function bridgeDiagnosticEnv(
  isolatedHomeDir: string,
  bridgeSocketPath: string | undefined,
): Record<string, string> {
  if (bridgeSocketPath == null) return {};
  return {
    [CO_MCP_BRIDGE_LOG_ENV]: hostProofBridgeLogPath(isolatedHomeDir),
  };
}

function hostProofBridgeLogPath(isolatedHomeDir: string): string {
  return `${isolatedHomeDir.replace(/\/+$/u, '')}/mcp/bridge.log`;
}

function codexBridgeSocketArgs(
  provider: 'claude' | 'codex',
  bridgeSocketPath: string | undefined,
): readonly string[] {
  if (provider !== 'codex' || bridgeSocketPath == null) return [];
  return ['--add-dir', dirname(bridgeSocketPath)];
}

// ── Operator entry ────────────────────────────────────────────────────────────

/**
 * The `co-mcp host-proof <provider> [projectId]` operator entry. Runs {@link runHostProof} once
 * against the given provider using the `[host-live]` seams (real node-pty, real socket bridge transport,
 * real timers). When `projectId` is omitted, it is resolved from the current working directory
 * via the project registry (the same lookup that `co doctor` / `co status` perform).
 *
 * This is the documented `[host-live]` invocation path in the P4 runbook (`docs/host-proof.md`).
 * It is NEVER called in-sandbox; the test directly calls {@link runHostProof} with fake seams.
 *
 * Fails loud (Principle 9) on a missing provider or an unregistered CWD.
 */
export async function runHostProofCommand(argv: readonly string[]): Promise<void> {
  const provider = argv[0];
  if (provider !== 'claude' && provider !== 'codex') {
    throw new Error(
      `co-mcp host-proof: provider must be 'claude' or 'codex' (got: ${provider ?? '(none)'}). ` +
        'Usage: co-mcp host-proof <provider> [projectId]',
    );
  }

  // Resolve projectId: explicit argv[1] wins; otherwise look up from CWD (same as `co doctor`).
  let projectId: string | undefined = argv[1]?.trim() || undefined;
  if (projectId == null) {
    const registry = openRegistry();
    try {
      projectId = registry.resolve(process.cwd()) ?? undefined;
    } finally {
      registry.close();
    }
    if (projectId == null) {
      throw new Error(
        `co-mcp host-proof: '${process.cwd()}' is not a registered project. ` +
          'Either register the project first (co doctor) or pass the projectId explicitly: ' +
          'co-mcp host-proof <provider> <projectId>',
      );
    }
  }
  const runId = randomUUID();
  const nonce = `host-proof-${provider}-${runId}`;
  const agent = `host-proof-${provider}-${runId}`;
  const isolatedHomeDir = hostProofIsolatedHomeDir(projectId, agent);

  // [host-live] identity — build the correct discriminated ResumeHandle for the provider.
  const resume =
    provider === 'claude'
      ? ({ provider: 'claude', sessionId: `host-proof-session-${provider}` } as const)
      : ({ provider: 'codex', codexHome: isolatedHomeDir } as const);

  const identity: HostedIdentity = {
    agent,
    role: 'coordinator',
    parent: '@operator',
    pane: `host-proof-pane-${provider}-${runId}`,
    projectId,
    cwd: process.cwd(),
    provider,
    resume,
  };

  const mcpPaths = defaultCoMcpPaths({ includeProviderAuth: true });
  const socketPath = mcpPaths.coMcpBridgeSocketPath?.(isolatedHomeDir, identity.agent);
  if (socketPath == null) {
    throw new Error('co-mcp host-proof: default MCP paths did not provide a bridge socket path.');
  }
  const spawnSpec = buildHostProofSpawnSpec(identity, {
    isolatedHomeDir,
    ...mcpPaths,
  });
  const proofToolName = 'mcp__co__co_mail_send';
  const proofTools = toolsForRole('coordinator').filter((tool) => tool.name === 'co_mail_send');
  if (proofTools.length !== 1) {
    throw new Error(
      `co-mcp host-proof: expected exactly one co_mail_send proof tool, got ${proofTools.length}.`,
    );
  }
  const bridgeLogPath = hostProofBridgeLogPath(isolatedHomeDir);

  const mailStore = openMailStore(projectId);
  let mail: DeliveredMail;
  try {
    mail = mailStore.send({
      type: MAIL_CLARIFY_REQUEST,
      to: identity.agent,
      from: OPERATOR,
      subject: `host-proof ${nonce}`,
      body:
        `Host proof nonce: ${nonce}\n\n` +
        `Call the ${proofToolName} MCP tool exactly once. Do not use shell, Bash, node, or a ` +
        `custom script. Send it to ${OPERATOR} with type ${MAIL_CLARIFY_REQUEST}. The subject ` +
        `or body must include this nonce exactly: ${nonce}. After the tool call returns, print ` +
        `this visible line in the chat: host-proof complete ${nonce}`,
      idempotencyKey: nonce,
    });
  } finally {
    mailStore.close();
  }

  console.error(`[co host-proof] running against ${provider} in project '${projectId}'…`);

  // Thin wrapper over the unified driver: this assembles the host-live launch artifacts; runProof
  // resolves the host-live seam bundle (real node-pty + socket bridge transport + real timers) and
  // stamps the tamper-resistant `host-live` fidelity. Output + pass-criteria below are unchanged.
  const result = await runProof(provider, {
    projectId,
    identity,
    mail,
    nonce,
    hostLive: {
      spawnSpec,
      sessionTools: () => proofTools,
      renderMail: hostProofMailRenderer(nonce, proofToolName),
      socketPath,
      bridgeLogPath,
      trace: process.env.CO_HOST_PROOF_TRACE === '1',
    },
  });

  console.error(
    `[co host-proof] result:\n` +
      `  turnRan=${result.turnRan}\n` +
      `  turnIdle=${result.turnIdle}\n` +
      `  turnError=${result.turnError ?? '-'}\n` +
      `  mailRouted=${result.mailRouted}\n` +
      `  sessionReconstructed=${result.sessionReconstructed}\n` +
      `  steerCompleted=${result.steerCompleted}\n` +
      `  steerMidTurn=${result.steerMidTurn}\n` +
      `  recoveredSessions=${result.recoveredSessions.length}`,
  );

  if (
    !result.turnRan ||
    !result.turnIdle ||
    !result.mailRouted ||
    !result.sessionReconstructed ||
    !result.steerCompleted ||
    !result.steerMidTurn
  ) {
    throw new Error(
      '[co host-proof] FAIL — one or more proof steps did not pass (see output above).',
    );
  }

  console.error('[co host-proof] PASS — all proof steps completed.');
}

function hostProofIsolatedHomeDir(projectId: ProjectId, agent: string): string {
  const registry = openRegistry();
  try {
    return join(registry.dataDirFor(projectId), 'host-proof', agent);
  } finally {
    registry.close();
  }
}

// The host-live inject-retry + ready-settle timers (formerly hardcoded magic numbers here) now live in
// host-live-seams.ts and are env-overridable (CO_HOST_LIVE_INJECT_RETRY_MS / CO_HOST_LIVE_READY_SETTLE_MS),
// shared by both the host-proof and worker-benchmark drivers.
function hostProofTracePaneData(chunk: string): void {
  const normalized = normalizeStartupOutput(chunk);
  if (normalized.length > 0) {
    console.error(`[co host-proof trace] ${normalized}`);
  }
}
