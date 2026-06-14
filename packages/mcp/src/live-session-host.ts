/**
 * The live-session-hosting seam (L7) — the L2 analogue of L1's now-real `LiveDelivery`.
 * {@link LiveSessionHostImpl} serves the co MCP surface to ONE hosted pane at a time, injecting the
 * Conductor's AUTHORITATIVE per-pane agent identity (from the B0 session record) into every
 * {@link ToolContext} — server-side, never trusting client-supplied identity — and offering the
 * role-scoped toolset. In production the Conductor hosts the REAL interactive claude/codex in a pty
 * (Principle 2 — authentic-terminal; never headless `-p`/`exec`); binding this MCP server to that live
 * pty's transport and waking/routing on inbound mail is the host-side runtime wiring, while the
 * identity-injecting surface itself is real here and sandbox-tested over an in-memory transport.
 */
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  openSessionStore,
  toolsForRole,
  type DeliveryFactory,
  type ProjectId,
  type ResumeHandle,
  type ReviewerSpawnGate,
  type Role,
  type SessionStore,
  type ToolSpec,
} from '@co/core';
import { createCoMcpServer } from './server.js';
import { openContextStores } from './context.js';

/**
 * The authoritative per-pane identity the Conductor supplies when hosting a session. All fields
 * come from the Conductor's session record (B0 SessionRecord) — never from the client (live
 * provider). The Conductor assigned this identity; the host trusts it and injects it into every
 * ToolContext without re-deriving or allowing client override (AC-L7-2; Principle 9).
 */
export interface HostedIdentity {
  /** The pane's authoritative agent id (from the session record). Never client-supplied. */
  readonly agent: string;
  /** The base role to scope the offered toolset. */
  readonly role: Role;
  /** Optional sub-role specialization to preserve in the roster record. */
  readonly subRole?: string;
  /** The parent agent id (used for roster context). */
  readonly parent: string;
  /** The live pane id backing this hosted session. */
  readonly pane: string;
  /** The resolved project id for this session. */
  readonly projectId: ProjectId;
  /** Absolute path of the worktree/cwd the agent operates in. */
  readonly cwd: string;
  /** Provider backing this pane. */
  readonly provider: 'claude' | 'codex';
  /** Provider-specific resume handle persisted for recovery. */
  readonly resume: ResumeHandle;
}

/**
 * A handle to a live-hosted session. Returned by {@link LiveSessionHost.hostSession}.
 * Closing frees all stores opened for the session.
 */
export interface HostedSession {
  /**
   * Release all per-session resources (MCP server/transport + opened stores). Called by the
   * Conductor when the pane's session ends.
   */
  close(): Promise<void>;
}

/** Optional per-session wiring the Conductor supplies when hosting a pane. */
export interface HostSessionOptions {
  /**
   * The L7 routing seam: a {@link DeliveryFactory} threaded into this pane's mail bus so its emitted
   * mail delivers through a `LiveDelivery` whose wake/inject callbacks the Conductor binds to live
   * panes. Absent ⇒ the in-process default writer (persist-only; the C1 identity surface is unchanged).
   */
  readonly deliveryFactory?: DeliveryFactory;
  /**
   * The P2 reviewer-spawn gate (AC-S10-2 / RG-4): when present, this pane's `co_merge` calls can
   * trigger live reviewer spawns by forwarding the gate through the assembled ToolContext. Absent ⇒
   * `co_merge` gates on an already-recorded verdict (headless path; unchanged).
   */
  readonly reviewerSpawnGate?: ReviewerSpawnGate;
  /**
   * Optional explicit tool surface. Normal Conductor sessions omit this and receive
   * `toolsForRole(identity.role)`; host-proof can pass a minimal proof surface to isolate provider
   * MCP startup from the full role vocabulary.
   */
  readonly tools?: readonly ToolSpec[];
}

/**
 * The live MCP session host. Serves the co MCP surface to one pane/session at a time, stamping
 * the Conductor's authoritative agent identity into every ToolContext — server-side, never
 * trusting what the live provider (client) claims (AC-L7-2; Principle 9).
 *
 * This is the L7 C1 implementation; pty hosting (B1) and mail injection (C2) are separate phases.
 */
export interface LiveSessionHost {
  /**
   * Host the co MCP surface for a single pane. Connects the co MCP server to `transport`,
   * injecting `identity.agent` (and project + store context) into every tool call's ToolContext.
   * The offered toolset is role-scoped to `identity.role` — matching the stdio mount's behaviour
   * but with identity injected from the session record rather than from env.
   *
   * Fails loud (Principle 9) if `identity.agent` is missing or blank — never fabricates an
   * identity or falls back to a client-claimed one.
   *
   * @param identity  The Conductor's authoritative session identity (from the session record).
   * @param transport The server-side transport to connect the MCP server to.
   * @param opts      Optional per-session wiring (e.g. the L7 routing delivery seam).
   * @returns A handle to close per-session resources when the pane ends.
   */
  hostSession(
    identity: HostedIdentity,
    transport: Transport,
    opts?: HostSessionOptions,
  ): Promise<HostedSession>;
}

type SessionStoreOpener = (projectId: ProjectId) => SessionStore;

/**
 * Production implementation of {@link LiveSessionHost}. Builds a role-scoped co MCP server for
 * each hosted pane and connects it to the supplied transport. Identity comes from the Conductor's
 * session record — never re-derived from, or overridable by, the live provider.
 */
export class LiveSessionHostImpl implements LiveSessionHost {
  private static readonly activeHostedAgents = new Set<string>();
  private static readonly activeHostedPanes = new Set<string>();

  constructor(private readonly openSessions: SessionStoreOpener = openSessionStore) {}

  async hostSession(
    identity: HostedIdentity,
    transport: Transport,
    opts?: HostSessionOptions,
  ): Promise<HostedSession> {
    const agent = identity.agent?.trim();
    if (agent == null || agent.length === 0) {
      throw new Error(
        'LiveSessionHost.hostSession: authoritative agent identity is missing or blank — ' +
          'the Conductor must supply the session record identity (Principle 9: never fabricate).',
      );
    }

    const parent = identity.parent?.trim();
    if (parent == null || parent.length === 0) {
      throw new Error(
        'LiveSessionHost.hostSession: authoritative parent identity is missing or blank — ' +
          'the Conductor must supply the recorded spawn parent.',
      );
    }
    const pane = identity.pane?.trim();
    if (pane == null || pane.length === 0) {
      throw new Error(
        'LiveSessionHost.hostSession: authoritative pane identity is missing or blank — ' +
          'the Conductor must supply the session record pane.',
      );
    }

    const activeKey = `${identity.projectId}:${agent}`;
    const paneKey = `${identity.projectId}:${pane}`;
    if (LiveSessionHostImpl.activeHostedAgents.has(activeKey)) {
      throw new Error(
        `LiveSessionHost.hostSession: agent '${agent}' already has an active hosted MCP session ` +
          `in project '${identity.projectId}'.`,
      );
    }
    if (LiveSessionHostImpl.activeHostedPanes.has(paneKey)) {
      throw new Error(
        `LiveSessionHost.hostSession: pane '${pane}' already has an active hosted MCP session ` +
          `in project '${identity.projectId}'.`,
      );
    }
    let sessionStore: SessionStore | undefined;
    let activeClaimed = false;
    let sessionClaimed = false;
    let opened: ReturnType<typeof openContextStores> | undefined;
    let server;
    try {
      sessionStore = this.openSessions(identity.projectId);
      LiveSessionHostImpl.activeHostedAgents.add(activeKey);
      LiveSessionHostImpl.activeHostedPanes.add(paneKey);
      activeClaimed = true;
      sessionStore.recordSession({
        agentId: agent,
        pane,
        cwd: identity.cwd,
        provider: identity.provider,
        resume: identity.resume,
      });
      sessionClaimed = true;
      opened = openContextStores(
        {
          agent,
          projectId: identity.projectId,
          cwd: identity.cwd,
        },
        {
          ...(opts?.deliveryFactory != null ? { deliveryFactory: opts.deliveryFactory } : {}),
          ...(opts?.reviewerSpawnGate != null ? { reviewerSpawnGate: opts.reviewerSpawnGate } : {}),
        },
      );
      opened.ctx.roster!.recordAgent({
        agentId: agent,
        role: identity.role,
        ...(identity.subRole != null ? { subRole: identity.subRole } : {}),
        parent,
      });
      const scopedTools = opts?.tools ?? toolsForRole(identity.role);
      server = createCoMcpServer({
        tools: scopedTools,
        contextFactory: () => opened!.ctx,
      });
      await server.connect(transport);
    } catch (e) {
      try {
        await server?.close();
      } catch {
        /* best-effort close of a partially connected MCP server */
      }
      if (activeClaimed) {
        LiveSessionHostImpl.activeHostedAgents.delete(activeKey);
        LiveSessionHostImpl.activeHostedPanes.delete(paneKey);
      }
      if (sessionClaimed) {
        try {
          sessionStore?.endSession(agent, pane);
        } catch {
          /* best-effort rollback of a failed host setup */
        }
      }
      sessionStore?.close();
      opened?.close();
      throw e;
    }

    let closed = false;
    const hostedSessionStore = sessionStore;
    const hostedServer = server;
    if (hostedSessionStore == null || hostedServer == null) {
      throw new Error('LiveSessionHost.hostSession: setup completed without required handles.');
    }
    const activeHostedAgents = LiveSessionHostImpl.activeHostedAgents;
    const activeHostedPanes = LiveSessionHostImpl.activeHostedPanes;
    return {
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        try {
          await hostedServer.close();
        } finally {
          try {
            hostedSessionStore.endSession(agent, pane);
          } finally {
            hostedSessionStore.close();
            activeHostedAgents.delete(activeKey);
            activeHostedPanes.delete(paneKey);
            opened?.close();
          }
        }
      },
    };
  }
}
