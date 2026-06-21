/**
 * Stage 10 P3 (CTL-OBS · §3b, mcp half) — the engine-backed {@link LiveStateProvider}.
 *
 * The LIVE half of observability (which agents are WARM right now, their outstanding actionable mail,
 * and the operator-control state) can only be answered by the running engine + its control surface — so
 * it lives in `@co/mcp`, not `@co/core`. The SHAPE and the MERGE ({@link queryLiveObservability}) are in
 * core (transport-agnostic, cli-callable); this class fills the seam in the daemon process. Stage 11's
 * operator-IPC binding exposes the resulting snapshot across the app → daemon socket.
 *
 * Registers ZERO agent MCP tools — a plain provider class, operator-only (Principle 4 + D4).
 */
import {
  openMailStore,
  type LiveAgentState,
  type LiveStateProvider,
  type MailStore,
  type ProjectId,
} from '@co/core';
import type { ConductorEngine } from './engine.js';
import type { DaemonBackedAgentRouter } from './agent-router.js';

/** Constructor seams for {@link EngineLiveStateProvider}. */
export interface EngineLiveStateProviderDeps {
  /** The running engine — the warm-set source (`isHosted`). */
  readonly engine: ConductorEngine;
  /** The project whose live state this provider reports. */
  readonly projectId: ProjectId;
  /** Opens the project mail bus for the outstanding-actionable count. Default: {@link openMailStore}. */
  readonly openMail?: (projectId: ProjectId) => MailStore;
  /**
   * The operator-control router, for the paused/stuck overlay. Absent ⇒ paused/stuck reported `false`
   * (a pure engine-observe with no control surface wired).
   */
  readonly router?: DaemonBackedAgentRouter;
}

/**
 * Fills the core {@link LiveStateProvider} seam from the running {@link ConductorEngine} (warm set) + the
 * project mail store (outstanding actionable count) + the optional {@link DaemonBackedAgentRouter}
 * (paused/stuck/stopped). One mail-store open per `liveStates` call (closed in `finally`); the engine + router
 * reads are pure in-memory lookups.
 */
export class EngineLiveStateProvider implements LiveStateProvider {
  private readonly engine: ConductorEngine;
  private readonly projectId: ProjectId;
  private readonly openMail: (projectId: ProjectId) => MailStore;
  private readonly router: DaemonBackedAgentRouter | undefined;

  constructor(deps: EngineLiveStateProviderDeps) {
    this.engine = deps.engine;
    this.projectId = deps.projectId;
    this.openMail = deps.openMail ?? openMailStore;
    this.router = deps.router;
  }

  liveStates(agentIds: readonly string[]): readonly LiveAgentState[] {
    const mail = this.openMail(this.projectId);
    try {
      return agentIds.map((agentId) => ({
        agentId,
        hosted: this.engine.isHosted(this.projectId, agentId),
        outstandingMail: mail.outstandingCount(agentId),
        paused: this.router?.isPaused(agentId) ?? false,
        stuck: this.router?.isStuck(agentId) ?? false,
        stopped: this.router?.isStopped(agentId) ?? false,
      }));
    } finally {
      mail.close();
    }
  }
}
