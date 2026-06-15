/**
 * L7-ENG (Stage 9 · Phase P1a) — the Conductor ENGINE: the motor that drives the landed L7 components.
 *
 * Stage 8 (L7) landed every Conductor *component* — pty hosting (`PtyHost`/`FakePty`), the startup
 * driver (`driveToReady`), the mail injector (`injectMail`), the turn-end detector (`detectTurnEnd`),
 * the liveness watchdog, and `LiveSessionHostImpl` — but NOTHING drove them. This module is the
 * single-turn cycle that wires them into one deterministic loop:
 *
 *   select → ensure-hosted (spawn) → bind MCP → driveToReady → injectMail → run ONE turn →
 *   detectTurnEnd → yield.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY IT LIVES IN `packages/mcp` (not pure `@co/core`): the engine binds {@link LiveSessionHostImpl}
 * to an MCP-SDK transport, and `@co/core` depends only on `zod` (no MCP SDK). The AC-L2-1 layering
 * guard (`core/src/tools/layering.test.ts`) is import-boundary-only: this module imports just the bare
 * `@co/core` barrel, the MCP SDK, node builtins, and local files — so it passes the guard and reworks
 * no landed contract (Principle D2 — landed seams are frozen).
 *
 * THE ENGINE REGISTERS ZERO AGENT MCP TOOLS (Principle D4 — the Conductor is never agent-callable).
 * It is a class, not a tool; the Principle-4 completeness gate stays green by construction.
 *
 * DETERMINISM (AC-S9-1): all timing is an INJECTED seam — there is NO wall clock in the testable path.
 * `now()` supplies the monotonic ms DATA the detector reads (never a real clock), and `quietWindow()`
 * is the turn-end settle seam (the analogue of `injectMail`'s `retryDelay`). Same input ⇒ same result.
 *
 * SCOPE (P1a + P1b): host/spawn/drive + the single-turn cycle + MNR-5 launch authority (P1a); plus
 * (P1b) routing emitted mail through a pane-bound `LiveDelivery` (wake + inject the recipient's pane),
 * post-turn liveness classification ({@link classifyLiveness}) surfaced on the {@link TurnOutcome} with
 * a warm yield, and the deferred clarify-timeout tick ({@link ConductorEngine.tickClarifyTimeouts} →
 * `forwardOnTimeout`). The standalone reconcile loop over recorded state (orphaned-RUNNING reap) is P4.
 */
import {
  type DeliveredMail,
  type DeliveryFactory,
  type DetectorEvent,
  type InjectMailOptions,
  type LivenessVerdict,
  type MailRenderer,
  type MailStore,
  type Pane,
  type ProjectId,
  type PtyHost,
  type RosterStore,
  type SpawnSpec,
  type StartupOutcome,
  type Steer,
  type ToolSpec,
  type TurnEndConfig,
  type TurnEndResult,
  CLARIFY_TIMEOUT_SECONDS_DEFAULT,
  CLARIFY_TIMEOUT_SECONDS_KEY,
  LiveDelivery,
  classifyLiveness,
  defaultMailRenderer,
  detectTurnEnd,
  driveToReady,
  forwardOnTimeout,
  injectMail,
  openConfigStore,
  openMailStore,
  openRosterStore,
  parseOsc0Titles,
  roleParentResolver,
  steerPane,
  watchDialogs,
  waitingItems,
  type ReviewerSpawnGate,
} from '@co/core';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  LiveSessionHostImpl,
  type HostedIdentity,
  type HostedSession,
  type LiveSessionHost,
} from '../live-session-host.js';

/**
 * A linked transport pair for one MCP bind. The engine gives the SERVER side to
 * {@link LiveSessionHost.hostSession}; the CLIENT side is where the live provider (an MCP client)
 * attaches. In-sandbox this is `InMemoryTransport.createLinkedPair()` (returned `[client, server]`);
 * host-live injects the transport pair supplied by the operator entry or host integration.
 */
export type TransportPair = readonly [client: Transport, server: Transport];

/**
 * The engine's constructor seams. Required seams have no default so the determinism / host-live
 * boundaries stay explicit; optional seams carry sandbox-safe defaults.
 */
export interface ConductorEngineDeps {
  /** Hosts panes. `FakePty` in-sandbox; `NodePtyHost` host-live. */
  readonly pty: PtyHost;
  /**
   * Produces the linked transport pair for a bind. The engine hands the SERVER side to
   * `host.hostSession`. REQUIRED (no default): sandbox injects `InMemoryTransport.createLinkedPair`;
   * host-live injects the real pty-bound pair. Keeping it injected makes the [host-live] seam explicit
   * and keeps this module free of any sandbox-only transport dependency.
   */
  readonly makeTransport: (identity: HostedIdentity) => TransportPair;
  /**
   * Optional per-session tool override. Omit for normal role-scoped sessions; host-proof uses this
   * to offer the smallest surface needed for the binary proof.
   */
  readonly sessionTools?: (identity: HostedIdentity) => readonly ToolSpec[] | undefined;
  /**
   * Monotonic ms source — the `at` for synthesized {@link DetectorEvent}s and the `observedAt` for
   * {@link detectTurnEnd}. This is DATA, never a wall clock (the detector's replay-determinism rests on
   * it). REQUIRED (no default) so a real clock can never sneak into the testable path.
   */
  readonly now: () => number;
  /**
   * Turn-end settle seam (the analogue of `injectMail`'s `retryDelay`). Resolves when the byte-quiet
   * window has elapsed; the engine ABORTS the in-flight call (via the `AbortSignal`) on each new pane
   * chunk and re-arms, so a settled window with no new bytes means the turn is idle. REQUIRED so timing
   * stays injected. Production wires a real timer cleared on abort; sandbox injects a controllable promise.
   */
  readonly quietWindow: (signal: AbortSignal) => Promise<void>;
  /** Binds the co MCP surface to a pane transport under the authoritative identity. Default: a fresh
   *  {@link LiveSessionHostImpl} (the real, sandbox-tested host). */
  readonly host?: LiveSessionHost;
  /** Opens the project mail bus for selection + the actionable item to inject. Default: {@link openMailStore}. */
  readonly openMail?: (projectId: ProjectId) => MailStore;
  /** Renders a delivered mail into the text injected into the pane. Default: {@link defaultMailRenderer}. */
  readonly renderMail?: MailRenderer;
  /**
   * Builds the {@link SpawnSpec} for an identity. Default: a minimal fresh-spawn spec
   * (`command = provider`, `cwd`, isolated `CODEX_HOME` when codex). Full env-isolation,
   * `prelaunchFiles`, and `--resume` args are host-side ([host-live], deferred).
   */
  readonly spawnSpecFor?: (identity: HostedIdentity) => SpawnSpec;
  /** Extra options forwarded to {@link injectMail} (e.g. a controllable `retryDelay` in sandbox). */
  readonly injectOptions?: Omit<InjectMailOptions, 'provider'>;
  /** Base {@link detectTurnEnd} config. `provider` is always taken from the hosted identity (authoritative). */
  readonly turnConfig?: Omit<TurnEndConfig, 'provider'>;
  /**
   * OPTIONAL turn MCP-activity source: subscribe to a pane's co-server call log, pushing
   * `mcp`/`mcp_start`/`mcp_end` {@link DetectorEvent}s into the turn trace; returns an unsubscribe.
   * Default: none — byte-quiescence drives idle (the detector treats an absent MCP log as quiescent).
   * Wiring the real call log is the Option-C MCP-sentinel host-side integration; P1b consumes it for
   * liveness classification. Present here so the seam is frozen, not bolted on later.
   */
  readonly mcpActivity?: (pane: Pane, push: (ev: DetectorEvent) => void) => () => void;
  /** Opens the project roster for the clarify-timeout {@link roleParentResolver}. Default: {@link openRosterStore}. */
  readonly openRoster?: (projectId: ProjectId) => RosterStore;
  /**
   * The clarify-timeout in seconds for a project (P1b clarify-tick). Default: the
   * `clarify_timeout_seconds` effective-config value, else {@link CLARIFY_TIMEOUT_SECONDS_DEFAULT}.
   * Injected so a test need not stand up the global config store.
   */
  readonly clarifyTimeoutSeconds?: (projectId: ProjectId) => number;
  /**
   * The ROUTING wake seam (P1b): notified when emitted mail wakes a recipient — i.e. the
   * {@link LiveDelivery} `wake` callback fired for `recipient`. In-sandbox this is the observable
   * "scheduled for a turn" signal; host-side (P2) it enqueues a not-yet-hosted recipient for launch.
   * Default: none (a warm recipient is driven directly by the inject seam).
   */
  readonly onRecipientWake?: (projectId: ProjectId, recipient: string) => void;
  /**
   * The ROUTING failure seam (P1b): notified when a routed live-delivery side-effect (wake or inject)
   * fails AFTER the mail was durably persisted — the {@link LiveDelivery} ledger keeps the item
   * pending and re-tries on the next deliver (re-wake). Default: none (host-side logs/metrics).
   */
  readonly onRouteFailure?: (failure: RouteFailure) => void;
  /**
   * LAZY factory for the P2 reviewer-spawn gate (AC-S10-2 / RG-4). Called per `ensureHosted` to
   * forward the gate into each hosted session's ctx so `co_merge` calls can trigger live reviewer
   * spawns. LAZY (factory, not gate) to break the construction cycle: the gate wraps THIS engine, so
   * it can only be constructed AFTER the engine is created. Absent ⇒ no spawn gate in hosted sessions
   * (headless path; co_merge gates on recorded verdicts). Conditionally-spread in hostSession opts so
   * an absent gate never passes an explicit `undefined` (exactOptionalPropertyTypes safe).
   */
  readonly reviewerSpawnGate?: () => ReviewerSpawnGate | undefined;
}

/** A routed live-delivery side-effect that failed post-persist (the {@link LiveDelivery} ledger re-tries). */
export interface RouteFailure {
  /** Which half of the live effect failed. */
  readonly phase: 'wake' | 'inject';
  readonly projectId: ProjectId;
  readonly recipient: string;
  /** The durably-persisted mail whose live effect failed. */
  readonly mail: DeliveredMail;
  readonly error: unknown;
}

/**
 * A pane the engine has hosted: spawned, driven to ready, and MCP-bound under the Conductor's
 * AUTHORITATIVE identity (never client-supplied). Held warm across turns until {@link ConductorEngine.release}.
 */
export interface HostedPane {
  /** The Conductor's authoritative identity for this pane (from the session record; AC-L7-2). */
  readonly identity: HostedIdentity;
  /** The live pty pane. */
  readonly pane: Pane;
  /** The bound MCP session; `close()` frees its resources. */
  readonly session: HostedSession;
  /** The startup outcome — `{ authed: true }` or `{ authed: false, loginRequired }` (surfaced, not driven). */
  readonly startup: StartupOutcome;
  /**
   * The client side of the bind transport. The live provider attaches here ([host-live]); unused
   * in-sandbox beyond optional client-side assertions. Its lifecycle is the host's, not the engine's.
   */
  readonly clientTransport: Transport;
}

/**
 * The outcome of running EXACTLY ONE turn. `turnEnd` is the {@link detectTurnEnd} verdict — an
 * idle / turn-boundary signal ONLY (turn-end ≠ work-end; completion stays keyed to the
 * `co_finish`/`worker_done` verbs and is NEVER inferred from idle here). `errored` is the MNR-2 seam:
 * a turn that threw yields WITHOUT consuming its mail, so P1b's `LiveDelivery` live-effect ledger can
 * re-inject the still-outstanding item on re-wake. Liveness classification of this outcome is P1b.
 */
export interface TurnOutcome {
  /** The detector verdict — present iff the turn was driven to an idle boundary. */
  readonly turnEnd?: TurnEndResult;
  /** True iff the turn threw; the mail was NOT consumed (P1b re-injects). */
  readonly errored: boolean;
  /** The error, when `errored`. */
  readonly error?: unknown;
  /**
   * The post-turn liveness verdict (P1b) — present on a non-errored turn. `dead`/`wedged` are
   * breaks; `alive` may still carry a `silent_stop` break (the turn yielded without a completion
   * verb). The Conductor yields the pane WARM on a healthy-liveness turn; the verdict's break is the
   * signal the host-side watchdog escalates on (nudge → STUCK). Reaping a `dead` pane is the P4
   * reconcile loop's job, not this in-turn classification's.
   */
  readonly liveness?: LivenessVerdict;
}

export interface RunOneTurnOptions {
  /** Called after the mail has been submitted to the provider composer, before turn-end observation. */
  readonly onInjected?: () => void;
}

/** The result of one {@link ConductorEngine.runCycle}: the hosted pane, the injected item, and the turn. */
export interface CycleOutcome {
  readonly hosted: HostedPane;
  readonly mail: DeliveredMail;
  readonly turn: TurnOutcome;
}

/**
 * SELECT a WAITING agent with work to do: the first candidate that has an outstanding INJECTABLE
 * ACTIONABLE item (an unresolved actionable mail) in its inbox — the same predicate `LiveDelivery`
 * uses to decide what to push into a live pane. Pure over the mail bus; candidates that share a
 * project reuse one opened store. Returns the chosen `{ identity, mail }`, or `undefined` if none.
 */
export function selectEligible(
  candidates: readonly HostedIdentity[],
  openMail: (projectId: ProjectId) => MailStore,
): { readonly identity: HostedIdentity; readonly mail: DeliveredMail } | undefined {
  const stores = new Map<ProjectId, MailStore>();
  try {
    for (const identity of candidates) {
      let store = stores.get(identity.projectId);
      if (store == null) {
        store = openMail(identity.projectId);
        stores.set(identity.projectId, store);
      }
      const [mail] = store.outstanding(identity.agent);
      if (mail != null) return { identity, mail };
    }
    return undefined;
  } finally {
    for (const store of stores.values()) store.close();
  }
}

/** Default {@link SpawnSpec}: a minimal fresh spawn. Host-side hardening (isolation env, resume) is deferred. */
function defaultSpawnSpec(identity: HostedIdentity): SpawnSpec {
  const env: Record<string, string> =
    identity.resume.provider === 'codex' ? { CODEX_HOME: identity.resume.codexHome } : {};
  return { command: identity.provider, args: [], cwd: identity.cwd, env };
}

/**
 * Default clarify-timeout: the project's effective `clarify_timeout_seconds` config, else
 * {@link CLARIFY_TIMEOUT_SECONDS_DEFAULT}. Reads program-data config ONLY (never the repo); the
 * value is the AGE bound, not the clock — the firing time is still the injected `now()` (P1b).
 */
function defaultClarifyTimeoutSeconds(projectId: ProjectId): number {
  const config = openConfigStore();
  try {
    const raw = config.resolveEffective(projectId)[CLARIFY_TIMEOUT_SECONDS_KEY];
    return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
      ? raw
      : CLARIFY_TIMEOUT_SECONDS_DEFAULT;
  } finally {
    config.close();
  }
}

/**
 * The Conductor engine. Owns the single-turn cycle and the MNR-5 launch authority. Stateful: it holds
 * the warm hosted panes it has launched. NOT a tool and NOT agent-callable (Principle D4).
 */
export class ConductorEngine {
  private readonly deps: ConductorEngineDeps;
  private readonly host: LiveSessionHost;
  private readonly openMail: (projectId: ProjectId) => MailStore;
  private readonly openRoster: (projectId: ProjectId) => RosterStore;
  private readonly renderMail: MailRenderer;
  private readonly spawnSpecFor: (identity: HostedIdentity) => SpawnSpec;
  private readonly clarifyTimeoutSeconds: (projectId: ProjectId) => number;
  /** Warm panes, keyed `${projectId}:${agent}` — the engine's launch-authority ledger (MNR-5). */
  private readonly hosted = new Map<string, HostedPane>();
  /** Pane-id occupancy, keyed `${projectId}:${pane}` — refuses two agents claiming one pane (MNR-5). */
  private readonly hostedPanes = new Map<string, string>();
  /** Per-pane exit flags, keyed `${projectId}:${agent}` — the `dead` liveness signal (P1b). */
  private readonly paneExited = new Map<string, boolean>();
  /** Per-pane onExit unsubscribers, keyed `${projectId}:${agent}` — torn down on release. */
  private readonly paneExitUnsub = new Map<string, () => void>();
  /**
   * When each unresolved clarify was FIRST observed by a tick, keyed
   * `${projectId}:${agent}:${seq}` → `now()`. The clarify-timeout ages against this injected-time
   * mark (never a wall clock), so the WHEN stays the Conductor's and replay-deterministic (P1b
   * clarify-tick). After each tick, entries are pruned within each processed (project, agent) scope:
   * a clarify answered before its timeout is removed on the next tick for that agent. Agents absent
   * from `candidates` this tick are never touched — their clocks survive unharmed.
   */
  private readonly clarifyFirstSeen = new Map<string, number>();

  constructor(deps: ConductorEngineDeps) {
    this.deps = deps;
    this.host = deps.host ?? new LiveSessionHostImpl();
    this.openMail = deps.openMail ?? openMailStore;
    this.openRoster = deps.openRoster ?? openRosterStore;
    this.renderMail = deps.renderMail ?? defaultMailRenderer;
    this.spawnSpecFor = deps.spawnSpecFor ?? defaultSpawnSpec;
    this.clarifyTimeoutSeconds =
      deps.clarifyTimeoutSeconds ?? ((projectId) => defaultClarifyTimeoutSeconds(projectId));
  }

  private static agentKey(projectId: ProjectId, agent: string): string {
    return `${projectId}:${agent}`;
  }
  private static paneKey(projectId: ProjectId, pane: string): string {
    return `${projectId}:${pane}`;
  }

  /** Whether this engine currently hosts `agent` in `projectId`. */
  isHosted(projectId: ProjectId, agent: string): boolean {
    return this.hosted.has(ConductorEngine.agentKey(projectId, agent));
  }

  /** The warm hosted handle for `agent`, or `undefined`. Use this to reuse a warm pane (no relaunch). */
  getHosted(projectId: ProjectId, agent: string): HostedPane | undefined {
    return this.hosted.get(ConductorEngine.agentKey(projectId, agent));
  }

  /**
   * MNR-5 — LAUNCH AUTHORITY. Ensure `identity`'s pane is hosted by LAUNCHING it: spawn the pane →
   * bind the co MCP surface ({@link LiveSessionHost.hostSession}) → {@link driveToReady} through the
   * interstitial state machine. The MCP bind happens before startup completes so real providers can
   * initialize their configured MCP server during their own startup handshake.
   * The Conductor is the single
   * launch authority keyed to the agent (`WorktreeRecord.agent`): a second host request for an
   * already-hosted agent — OR for a pane id already claimed by another agent — is REFUSED here, BEFORE a
   * duplicate pane is spawned (the `LiveSessionHostImpl` static guard is the MCP-bind backstop). Warm
   * reuse across turns does NOT call this — it reuses the handle from {@link getHosted}.
   *
   * @param identity - The authoritative session identity.
   * @param spec - Optional explicit SpawnSpec (P2 placement-based launch). When present, used instead
   *   of {@link ConductorEngineDeps.spawnSpecFor}. Allows the placement→launch-spec builder to supply
   *   the fully-isolated config (MNR-6) without reworking ensureHosted's core.
   * @returns the hosted handle. @throws if the agent or pane is already hosted (MNR-5), or if startup /
   *          binding fails (fail-loud, Principle 9 — `driveToReady` rejects on a pty exit).
   */
  async ensureHosted(identity: HostedIdentity, spec?: SpawnSpec): Promise<HostedPane> {
    const agentKey = ConductorEngine.agentKey(identity.projectId, identity.agent);
    const paneKey = ConductorEngine.paneKey(identity.projectId, identity.pane);
    if (this.hosted.has(agentKey)) {
      throw new Error(
        `ConductorEngine.ensureHosted: agent '${identity.agent}' is already hosted in project ` +
          `'${identity.projectId}' (MNR-5 — refusing to launch a second pane for one agent).`,
      );
    }
    if (this.hostedPanes.has(paneKey)) {
      throw new Error(
        `ConductorEngine.ensureHosted: pane '${identity.pane}' is already hosted by agent ` +
          `'${this.hostedPanes.get(paneKey)}' in project '${identity.projectId}' ` +
          `(MNR-5 — refusing a duplicate pane claim).`,
      );
    }

    // Spawn the pane. When a caller-supplied spec is present (P2 placement-based launch), use it
    // directly (it already carries the isolated config from buildPlacementLaunchSpec); otherwise fall
    // back to the injected spawnSpecFor seam (the default minimal spec or a host-live override).
    const pane = this.deps.pty.spawn(spec ?? this.spawnSpecFor(identity));
    const startupP = driveToReady(pane, identity.provider);
    // The promise is awaited below, but attach a catch immediately so an early startup failure cannot
    // surface as an unhandled rejection while the MCP bind is still being established.
    void startupP.catch(() => {});
    let session: HostedSession | undefined;
    let clientTransport: Transport | undefined;
    try {
      // Bind the co MCP surface to the pane's transport under the AUTHORITATIVE identity (never the
      // client's). The engine hands the server side to the host; the client side is the provider's seam.
      // P1b: thread the ROUTING delivery factory so this pane's emitted mail wakes + injects its
      // recipients' live panes (the `LiveDelivery` seams bind back to THIS engine's hosted-pane lookup).
      const [transportClient, serverTransport] = this.deps.makeTransport(identity);
      clientTransport = transportClient;
      const spawnGate = this.deps.reviewerSpawnGate?.();
      const sessionTools = this.deps.sessionTools?.(identity);
      session = await this.host.hostSession(identity, serverTransport, {
        deliveryFactory: this.routingDeliveryFactory(),
        ...(spawnGate != null ? { reviewerSpawnGate: spawnGate } : {}),
        ...(sessionTools != null ? { tools: sessionTools } : {}),
      });

      // Drive it through its startup interstitials to ready (or surface a terminal login menu).
      // The detector was armed immediately after spawn so tests and real providers cannot lose early
      // startup bytes while the MCP bind starts.
      const startup = await startupP;

      // Track pane exit for the `dead` liveness signal (P1b). The subscription lives until release.
      this.paneExited.set(agentKey, false);
      this.paneExitUnsub.set(
        agentKey,
        pane.onExit(() => this.paneExited.set(agentKey, true)),
      );

      const hostedPane: HostedPane = { identity, pane, session, startup, clientTransport };
      this.hosted.set(agentKey, hostedPane);
      this.hostedPanes.set(paneKey, identity.agent);
      return hostedPane;
    } catch (error) {
      // A startup/bind failure must NOT leak the spawned pane (a real process host-side). Kill it and
      // re-throw; the launch ledger was never claimed, so the agent stays cleanly re-hostable.
      try {
        pane.kill();
      } catch {
        /* best-effort: the pty may already be gone (e.g. driveToReady rejected on exit) */
      }
      await Promise.allSettled([session?.close(), clientTransport?.close?.()]);
      await Promise.allSettled([startupP]);
      throw error;
    }
  }

  /**
   * Inject ONE rendered actionable mail into a hosted pane and drive EXACTLY ONE turn to its idle
   * boundary. The cycle is structured so it NEVER drops mail on error (MNR-2):
   *   1. render + {@link injectMail} (write → echo-verify → exactly one Enter);
   *   2. observe the turn trace (bytes/OSC0 from the pane, + any MCP activity) and {@link detectTurnEnd};
   *   3. yield — leave the pane WARM (no teardown; the warm-session waiter holds it for the next turn).
   *
   * The mail is NOT marked read / consumed here: an errored turn yields with the item still outstanding,
   * so P1b's `LiveDelivery` live-effect ledger re-injects it on re-wake. `turnEnd.idle` is a UI/liveness
   * signal ONLY — work-completion stays keyed to `co_finish`/`worker_done`; the engine never treats idle
   * as "done". Exactly one turn is driven: one inject, one detect, then return.
   */
  async runOneTurn(
    hosted: HostedPane,
    mail: DeliveredMail,
    opts: RunOneTurnOptions = {},
  ): Promise<TurnOutcome> {
    try {
      const text = this.renderMail(mail);
      await injectMail(hosted.pane, text, {
        provider: hosted.identity.provider,
        ...this.deps.injectOptions,
      });
      opts.onInjected?.();
      const { turnEnd, trace, observedAt } = await this.observeTurnEnd(hosted);
      // P1b: classify liveness over the SAME turn trace and surface it. The turn has yielded
      // (turnActive=false), so the classifier reads `dead` (pane exited) or a `silent_stop` break
      // (idle without a completion verb); otherwise the session is healthy and the pane stays WARM.
      const liveness = this.classifyTurnLiveness(hosted, trace, observedAt);
      return { turnEnd, errored: false, liveness };
    } catch (error) {
      // MNR-2 seam: yield on an errored turn WITHOUT consuming the mail. We deliberately do nothing
      // that would mark the item read/resolved — it stays outstanding for P1b to re-inject.
      return { errored: true, error };
    }
  }

  /**
   * Observe a single turn to its idle boundary. Accumulates a {@link DetectorEvent} trace from the
   * pane's output (`bytes` per chunk + any OSC-0 titles) and any injected MCP activity, then re-arms the
   * byte-quiet window until it settles with no new output — at which point {@link detectTurnEnd} renders
   * the verdict at `observedAt = now()`. Returns the verdict, the trace (for P1b liveness
   * classification), and `observedAt`. Subscriptions are torn down on settle.
   */
  private async observeTurnEnd(
    hosted: HostedPane,
  ): Promise<{ turnEnd: TurnEndResult; trace: readonly DetectorEvent[]; observedAt: number }> {
    const trace: DetectorEvent[] = [];
    let abortCurrent: (() => void) | null = null;

    const record = (ev: DetectorEvent): void => {
      trace.push(ev);
      // New activity → abort the in-flight quiet window so the loop re-arms (a working session is
      // never silent; quiescence only counts once output truly stops).
      abortCurrent?.();
    };
    const unsubData = hosted.pane.onData((chunk) => {
      const at = this.deps.now();
      record({ kind: 'bytes', at, bytes: chunk.length });
      for (const title of parseOsc0Titles(chunk)) record({ kind: 'osc0', at, title });
    });
    const unsubMcp = this.deps.mcpActivity?.(hosted.pane, record) ?? noop;
    const unsubDialogs = watchDialogs(hosted.pane, { provider: hosted.identity.provider });

    try {
      for (;;) {
        const controller = new AbortController();
        abortCurrent = () => controller.abort();
        await this.deps.quietWindow(controller.signal);
        abortCurrent = null;
        if (!controller.signal.aborted) break; // window elapsed with no new output ⇒ idle
        // else: new output arrived during the window ⇒ re-arm and keep watching.
      }
      const observedAt = this.deps.now();
      const turnEnd = detectTurnEnd(trace, observedAt, {
        ...this.deps.turnConfig,
        provider: hosted.identity.provider,
      });
      return { turnEnd, trace, observedAt };
    } finally {
      unsubData();
      unsubMcp();
      unsubDialogs();
    }
  }

  /**
   * Classify post-turn liveness over the turn's trace (P1b). The turn has YIELDED, so `turnActive` is
   * false — the classifier never reads `wedged` here (that is a still-active frozen turn, the host-side
   * watchdog's job); it reads `dead` when the pane exited, a `silent_stop` break when the turn went idle
   * with no completion verb, else healthy `alive`. `pidAlive` defaults to "the pane has not exited"; the
   * real `kill(pid,0)` is the host-side seam. Time is DATA — the same `observedAt` the detector used.
   */
  private classifyTurnLiveness(
    hosted: HostedPane,
    trace: readonly DetectorEvent[],
    observedAt: number,
  ): LivenessVerdict {
    const agentKey = ConductorEngine.agentKey(hosted.identity.projectId, hosted.identity.agent);
    const exited = this.paneExited.get(agentKey) ?? false;
    return classifyLiveness({ trace, exited, pidAlive: !exited, turnActive: false }, observedAt, {
      ...this.deps.turnConfig,
      provider: hosted.identity.provider,
    });
  }

  /**
   * Build the ROUTING delivery factory (P1b) threaded into a hosted pane's mail bus. Its
   * {@link LiveDelivery} persists exactly as the in-process writer (freeze #3, delegated), and binds
   * its wake/inject callbacks back to THIS engine: a warm recipient's pane is woken and injected
   * directly. The factory's `projectId` is the pane's own project (supplied by `openMailStore`).
   */
  private routingDeliveryFactory(): DeliveryFactory {
    return (projectId, store, projectors) =>
      new LiveDelivery(projectId, store, projectors, {
        wake: (recipient) => this.routeWake(projectId, recipient),
        injectToRecipient: (recipient, mail) => this.routeInject(projectId, recipient, mail),
        onWakeFailure: (recipient, mail, error) =>
          this.deps.onRouteFailure?.({ phase: 'wake', projectId, recipient, mail, error }),
        onInjectFailure: (recipient, mail, error) =>
          this.deps.onRouteFailure?.({ phase: 'inject', projectId, recipient, mail, error }),
      });
  }

  /**
   * ROUTING wake (P1b): an emitted item delivered to `recipient` should take a turn. For a warm
   * (already-hosted) recipient this is just the scheduling signal — the inject seam drives its pane
   * directly. Resolving a NOT-yet-hosted recipient to a pane to launch is P2's job (PlacementRecord);
   * here we only surface the wake so the sandbox proof can observe it. Never throws (so the
   * LiveDelivery proceeds to inject a warm recipient).
   */
  private routeWake(projectId: ProjectId, recipient: string): void {
    this.deps.onRecipientWake?.(projectId, recipient);
  }

  /**
   * ROUTING inject (P1b): render `mail` and {@link injectMail} it into `recipient`'s warm pane (the
   * `LiveDelivery` inject seam, bound to this engine's hosted-pane lookup). A not-yet-hosted recipient
   * throws fail-loud (Principle 9) — the LiveDelivery ledger reports it via `onInjectFailure` and keeps
   * the item pending, so a later re-wake (once the recipient is hosted) re-injects it (MNR-2). Reuses
   * the same injected `injectOptions` as a driven turn, so timing stays deterministic in-sandbox.
   */
  private async routeInject(
    projectId: ProjectId,
    recipient: string,
    mail: DeliveredMail,
  ): Promise<void> {
    const hosted = this.getHosted(projectId, recipient);
    if (hosted == null) {
      throw new Error(
        `ConductorEngine.routeInject: recipient '${recipient}' is not hosted in project ` +
          `'${projectId}' — cannot inject routed mail to a pane that is not warm (P2 resolves a ` +
          'not-yet-hosted recipient from a PlacementRecord).',
      );
    }
    await injectMail(hosted.pane, this.renderMail(mail), {
      provider: hosted.identity.provider,
      ...this.deps.injectOptions,
    });
  }

  /**
   * The single-turn CYCLE (the P1a keystone). SELECT a WAITING agent with an outstanding injectable
   * actionable item from `candidates` → ensure its pane (warm reuse, else launch via {@link ensureHosted})
   * → inject its first outstanding item → run EXACTLY ONE turn → yield (the pane stays warm). Returns the
   * {@link CycleOutcome}, or `null` when no candidate is eligible.
   */
  async runCycle(candidates: readonly HostedIdentity[]): Promise<CycleOutcome | null> {
    const selected = selectEligible(candidates, this.openMail);
    if (selected == null) return null;
    const { identity, mail } = selected;
    const hosted =
      this.getHosted(identity.projectId, identity.agent) ?? (await this.ensureHosted(identity));
    const turn = await this.runOneTurn(hosted, mail);
    return { hosted, mail, turn };
  }

  /**
   * SF-2 — STEER a warm hosted pane MID-TURN, WITHOUT tearing it down (Principle 1 — the turn continues).
   * Look up the agent's warm pane ({@link getHosted}) and apply the operator's {@link Steer} via
   * {@link steerPane}: `answer`/`redirect` inject the operator text (echo-verified, exactly one Enter);
   * `interrupt` sends the provider's interrupt key. This method NEVER releases / closes / kills / signals
   * the pane — the hosted ledger keeps it, so the live session stays warm for the rest of the turn.
   *
   * Operator-initiated only: the engine registers ZERO agent MCP tools (Principle D4 — the Conductor is
   * never agent-callable); this is a METHOD, not a tool. Throws fail-loud (Principle 9) if the agent is
   * not hosted (there is no warm pane to steer — steering never spawns or relaunches). The provider is
   * the pane's AUTHORITATIVE identity, and the same injected timing seam as a driven turn is forwarded,
   * so the text-steer stays deterministic in-sandbox.
   *
   * The real mid-turn interrupt against a live binary (and the exact per-provider interrupt key) is
   * host-side ([host-live], deferred); here it is proven in-sandbox over `FakePty`.
   */
  async steer(projectId: ProjectId, agent: string, steer: Steer): Promise<void> {
    const hosted = this.getHosted(projectId, agent);
    if (hosted == null) {
      throw new Error(
        `ConductorEngine.steer: agent '${agent}' is not hosted in project '${projectId}' — ` +
          'cannot steer a pane that is not warm (Principle 1 — steering never spawns or relaunches).',
      );
    }
    await steerPane(hosted.pane, steer, {
      provider: hosted.identity.provider,
      ...this.deps.injectOptions,
    });
  }

  /**
   * Fire the deferred clarify-timeout policy (Q4 / P1b). For each `candidate` that is WAITING on a
   * `clarify_request` it raised ({@link waitingItems}), age the unanswered item against the project's
   * `clarify_timeout_seconds`: on the FIRST observation the engine marks `now()`; once `now()` has
   * advanced past the timeout, it fires {@link forwardOnTimeout}, which forwards the item UP from its
   * holder to the holder's parent ({@link roleParentResolver}) — the SAME threading as a manual
   * `forwardEscalation`. Time is the injected `now()` seam (the WHEN is the Conductor's, replay-safe);
   * `forwardOnTimeout` itself reads no clock. Returns the forwarded escalations (for logging/inspection).
   *
   * This is the in-turn-adjacent tick, NOT P4's standalone reconcile over recorded state.
   */
  async tickClarifyTimeouts(
    candidates: readonly HostedIdentity[],
  ): Promise<readonly DeliveredMail[]> {
    const observedAt = this.deps.now();
    const forwarded: DeliveredMail[] = [];
    const agentsByProject = new Map<ProjectId, Set<string>>();
    for (const identity of candidates) {
      let agents = agentsByProject.get(identity.projectId);
      if (agents == null) {
        agents = new Set();
        agentsByProject.set(identity.projectId, agents);
      }
      agents.add(identity.agent);
    }

    for (const [projectId, agents] of agentsByProject) {
      const timeoutMs = this.clarifyTimeoutSeconds(projectId) * 1000;
      // Nested try/finally so `mail` is closed even if `openRoster` throws (no leak on the error path).
      const mail = this.openMail(projectId);
      try {
        const roster = this.openRoster(projectId);
        try {
          const resolver = roleParentResolver(roster);
          for (const agent of agents) {
            const waiting = waitingItems(mail, agent);
            const currentWaitingKeys = new Set<string>();
            for (const unanswered of waiting) {
              const key = `${projectId}:${agent}:${unanswered.seq}`;
              currentWaitingKeys.add(key);
              const firstSeen = this.clarifyFirstSeen.get(key);
              if (firstSeen == null) {
                this.clarifyFirstSeen.set(key, observedAt);
                continue; // just observed — start its clock; it cannot already have timed out.
              }
              if (observedAt - firstSeen >= timeoutMs) {
                forwarded.push(forwardOnTimeout(mail, resolver, unanswered));
                this.clarifyFirstSeen.delete(key); // forwarded — stop tracking the discharged item.
              }
            }
            // Prune stale entries for this (project, agent) scope — keys that were tracking a
            // clarify that is no longer waiting (answered before its timeout). Only prune within
            // the exact scope processed this tick; an absent-from-candidates agent's clock is
            // never touched (it may still be waiting in a future tick).
            const prefix = `${projectId}:${agent}:`;
            for (const key of this.clarifyFirstSeen.keys()) {
              if (key.startsWith(prefix) && !currentWaitingKeys.has(key)) {
                this.clarifyFirstSeen.delete(key);
              }
            }
          }
        } finally {
          roster.close();
        }
      } finally {
        mail.close();
      }
    }
    return forwarded;
  }

  /**
   * Release a warm pane: drop it from the launch ledger, stop its pane, then close its MCP session
   * (frees the host's stores + static guard). P1b layers liveness classification / yield-to-watchdog
   * onto this same post-turn seam. No-op if the agent is not hosted.
   */
  async release(
    projectId: ProjectId,
    agent: string,
    options: { readonly onPaneKillError?: (error: unknown) => void } = {},
  ): Promise<void> {
    const agentKey = ConductorEngine.agentKey(projectId, agent);
    const hosted = this.hosted.get(agentKey);
    if (hosted == null) return;
    this.hosted.delete(agentKey);
    this.hostedPanes.delete(ConductorEngine.paneKey(projectId, hosted.identity.pane));
    this.dropExitTracking(agentKey);
    try {
      hosted.pane.kill();
    } catch (error) {
      try {
        options.onPaneKillError?.(error);
      } catch {
        /* diagnostic callback failed; session cleanup must still run */
      }
      /* best-effort: pane may already be gone */
    }
    await hosted.session.close();
  }

  /** Release every warm pane (teardown). Best-effort: one failing close does not abort the rest. */
  async closeAll(): Promise<void> {
    const all = [...this.hosted.entries()];
    this.hosted.clear();
    this.hostedPanes.clear();
    for (const [agentKey] of all) this.dropExitTracking(agentKey);
    for (const [, hosted] of all) {
      try {
        hosted.pane.kill();
      } catch {
        /* best-effort: pane may already be gone */
      }
      try {
        await hosted.session.close();
      } catch {
        /* best-effort teardown */
      }
    }
  }

  /** Tear down a pane's exit subscription + flag (P1b). */
  private dropExitTracking(agentKey: string): void {
    this.paneExitUnsub.get(agentKey)?.();
    this.paneExitUnsub.delete(agentKey);
    this.paneExited.delete(agentKey);
  }
}

const noop = (): void => {};
