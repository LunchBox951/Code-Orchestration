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
import { toolsForRole, type ProjectId, type Role } from '@co/core';
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
  /** The parent agent id (used for roster context). */
  readonly parent: string;
  /** The resolved project id for this session. */
  readonly projectId: ProjectId;
  /** Absolute path of the worktree/cwd the agent operates in. */
  readonly cwd: string;
}

/**
 * A handle to a live-hosted session. Returned by {@link LiveSessionHost.hostSession}.
 * Closing frees all stores opened for the session.
 */
export interface HostedSession {
  /**
   * Release all per-session resources (opened stores). Called by the Conductor when the
   * pane's session ends. The connected transport handles its own lifecycle.
   */
  close(): void;
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
   * @returns A handle to close per-session resources when the pane ends.
   */
  hostSession(identity: HostedIdentity, transport: Transport): Promise<HostedSession>;
}

/**
 * Production implementation of {@link LiveSessionHost}. Builds a role-scoped co MCP server for
 * each hosted pane and connects it to the supplied transport. Identity comes from the Conductor's
 * session record — never re-derived from, or overridable by, the live provider.
 */
export class LiveSessionHostImpl implements LiveSessionHost {
  async hostSession(identity: HostedIdentity, transport: Transport): Promise<HostedSession> {
    const agent = identity.agent?.trim();
    if (agent == null || agent.length === 0) {
      throw new Error(
        'LiveSessionHost.hostSession: authoritative agent identity is missing or blank — ' +
          'the Conductor must supply the session record identity (Principle 9: never fabricate).',
      );
    }

    const { ctx, close } = openContextStores({
      agent,
      projectId: identity.projectId,
      cwd: identity.cwd,
    });

    let server;
    try {
      const scopedTools = toolsForRole(identity.role);
      server = createCoMcpServer({
        tools: scopedTools,
        contextFactory: () => ctx,
      });
      await server.connect(transport);
    } catch (e) {
      close();
      throw e;
    }

    return { close };
  }
}
