/**
 * L7-ENG (Stage 9 · Phase P1a) — the Conductor ENGINE: the motor that drives the landed L7 components.
 *
 * Stage 8 (L7) landed every Conductor *component* — pty hosting (`PtyHost`/`FakePty`), the startup
 * driver (`driveToReady`), the mail injector (`injectMail`), the turn-end detector (`detectTurnEnd`),
 * the liveness watchdog, and `LiveSessionHostImpl` — but NOTHING drove them. This module is the
 * single-turn cycle that wires them into one deterministic loop:
 *
 *   select → ensure-hosted (spawn) → driveToReady → bind MCP → injectMail → run ONE turn →
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
 * SCOPE (P1a): host/spawn/drive + the single-turn cycle + MNR-5 launch authority. Mail-routing through
 * `LiveDelivery`, liveness classification / yield-to-watchdog, and the clarify-timeout tick are P1b —
 * this module leaves clean seams for them (see {@link TurnOutcome} and the notes on `runOneTurn`).
 */
import {
  type DeliveredMail,
  type DetectorEvent,
  type InjectMailOptions,
  type MailRenderer,
  type MailStore,
  type Pane,
  type ProjectId,
  type PtyHost,
  type SpawnSpec,
  type StartupOutcome,
  type TurnEndConfig,
  type TurnEndResult,
  defaultMailRenderer,
  detectTurnEnd,
  driveToReady,
  injectMail,
  openMailStore,
  parseOsc0Titles,
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
 * host-live ([host-live], deferred) it is the pty-bound transport pair the spawned provider connects to.
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
  readonly makeTransport: () => TransportPair;
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
 * The Conductor engine. Owns the single-turn cycle and the MNR-5 launch authority. Stateful: it holds
 * the warm hosted panes it has launched. NOT a tool and NOT agent-callable (Principle D4).
 */
export class ConductorEngine {
  private readonly deps: ConductorEngineDeps;
  private readonly host: LiveSessionHost;
  private readonly openMail: (projectId: ProjectId) => MailStore;
  private readonly renderMail: MailRenderer;
  private readonly spawnSpecFor: (identity: HostedIdentity) => SpawnSpec;
  /** Warm panes, keyed `${projectId}:${agent}` — the engine's launch-authority ledger (MNR-5). */
  private readonly hosted = new Map<string, HostedPane>();
  /** Pane-id occupancy, keyed `${projectId}:${pane}` — refuses two agents claiming one pane (MNR-5). */
  private readonly hostedPanes = new Map<string, string>();

  constructor(deps: ConductorEngineDeps) {
    this.deps = deps;
    this.host = deps.host ?? new LiveSessionHostImpl();
    this.openMail = deps.openMail ?? openMailStore;
    this.renderMail = deps.renderMail ?? defaultMailRenderer;
    this.spawnSpecFor = deps.spawnSpecFor ?? defaultSpawnSpec;
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
   * {@link driveToReady} through the interstitial state machine → bind the co MCP surface
   * ({@link LiveSessionHost.hostSession}) under the authoritative identity. The Conductor is the single
   * launch authority keyed to the agent (`WorktreeRecord.agent`): a second host request for an
   * already-hosted agent — OR for a pane id already claimed by another agent — is REFUSED here, BEFORE a
   * duplicate pane is spawned (the `LiveSessionHostImpl` static guard is the MCP-bind backstop). Warm
   * reuse across turns does NOT call this — it reuses the handle from {@link getHosted}.
   *
   * @returns the hosted handle. @throws if the agent or pane is already hosted (MNR-5), or if startup /
   *          binding fails (fail-loud, Principle 9 — `driveToReady` rejects on a pty exit).
   */
  async ensureHosted(identity: HostedIdentity): Promise<HostedPane> {
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

    // Spawn the pane (host-side build artifacts / env-isolation live in the SpawnSpec).
    const pane = this.deps.pty.spawn(this.spawnSpecFor(identity));
    try {
      // Drive it through its startup interstitials to ready (or surface a terminal login menu);
      // `driveToReady` rejects fail-loud (Principle 9) if the pty exits before ready.
      const startup = await driveToReady(pane, identity.provider);
      // Bind the co MCP surface to the pane's transport under the AUTHORITATIVE identity (never the
      // client's). The engine hands the server side to the host; the client side is the provider's seam.
      const [clientTransport, serverTransport] = this.deps.makeTransport();
      const session = await this.host.hostSession(identity, serverTransport);

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
  async runOneTurn(hosted: HostedPane, mail: DeliveredMail): Promise<TurnOutcome> {
    try {
      const text = this.renderMail(mail);
      await injectMail(hosted.pane, text, {
        provider: hosted.identity.provider,
        ...this.deps.injectOptions,
      });
      const turnEnd = await this.observeTurnEnd(hosted);
      return { turnEnd, errored: false };
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
   * the verdict at `observedAt = now()`. Subscriptions are torn down on settle.
   */
  private async observeTurnEnd(hosted: HostedPane): Promise<TurnEndResult> {
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
      return detectTurnEnd(trace, observedAt, {
        ...this.deps.turnConfig,
        provider: hosted.identity.provider,
      });
    } finally {
      unsubData();
      unsubMcp();
    }
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
   * Release a warm pane: close its MCP session (frees the host's stores + static guard) and drop it from
   * the launch ledger. P1b layers liveness classification / yield-to-watchdog onto this same post-turn
   * seam. No-op if the agent is not hosted.
   */
  async release(projectId: ProjectId, agent: string): Promise<void> {
    const agentKey = ConductorEngine.agentKey(projectId, agent);
    const hosted = this.hosted.get(agentKey);
    if (hosted == null) return;
    this.hosted.delete(agentKey);
    this.hostedPanes.delete(ConductorEngine.paneKey(projectId, hosted.identity.pane));
    await hosted.session.close();
  }

  /** Release every warm pane (teardown). Best-effort: one failing close does not abort the rest. */
  async closeAll(): Promise<void> {
    const all = [...this.hosted.values()];
    this.hosted.clear();
    this.hostedPanes.clear();
    for (const hosted of all) {
      try {
        await hosted.session.close();
      } catch {
        /* best-effort teardown */
      }
    }
  }
}

const noop = (): void => {};
