import {
  BASE_ROLES,
  openMailStore,
  openRegistry,
  toolsForRole,
  type Role,
  type ToolContext,
  type ToolSpec,
} from '@co/core';

/** The launch-environment variable the mount reads the calling agent's identity from. */
export const CO_AGENT_ENV = 'CO_AGENT';

/** The launch-environment variable the mount reads the role to SCOPE the offered toolset by. */
export const CO_ROLE_ENV = 'CO_ROLE';

/**
 * Resolve the offered toolset from the launch environment's `CO_ROLE`. The scoping role is
 * MOUNT-controlled (this env), never self-declared — distinct from `co_orient`'s lenient `role`
 * input, so an agent cannot widen its own toolset by claiming a role (mcp-tools.md / permissions.md).
 *
 * Returns the role-scoped {@link ToolSpec} list when `CO_ROLE` names a base role, or `undefined` —
 * meaning "offer the full registry" — when it is absent or unrecognized. Scoping is RELEVANCE, not a
 * security wall (permissions.md), so an unknown role fails SOFT to the full set rather than throwing;
 * `toolsForRole` still fails loud on a phantom tool (a declaration bug), which this never masks.
 */
export function toolsFromEnv(): readonly ToolSpec[] | undefined {
  const raw = process.env[CO_ROLE_ENV];
  if (raw == null || raw.trim().length === 0) return undefined;
  const role = raw.trim().toLowerCase();
  if (!(BASE_ROLES as readonly string[]).includes(role)) return undefined;
  return toolsForRole(role as Role);
}

/**
 * Build the default stdio {@link ToolContext} factory. The server serves a SINGLE agent for the
 * life of the process, so this resolves identity + project + mail bus ONCE (eagerly, here) and
 * hands the same context to every tool call — opening the registry/MailStore once and reusing
 * them. The MOUNT supplies identity from the launch environment; a tool never invents who is
 * calling (mcp-tools.md). Fails loud (Principle 9):
 *   - missing/empty `CO_AGENT`        → throw (never fabricate an identity);
 *   - cwd not a registered project    → throw (registration is an init concern, not the tool
 *                                        server's — it never silently registers).
 *
 * Resolving eagerly means a misconfigured launch fails BEFORE the transport connects, rather than
 * on the first tool call.
 */
export function defaultContextFactory(): () => ToolContext {
  const agent = process.env[CO_AGENT_ENV];
  if (agent == null || agent.length === 0) {
    throw new Error(
      `co MCP server: ${CO_AGENT_ENV} is not set — the mount must supply the agent identity ` +
        '(Principle 9: a tool never invents who is calling).',
    );
  }

  const cwd = process.cwd();
  const registry = openRegistry();
  const projectId = registry.resolve(cwd);
  if (projectId == null) {
    registry.close();
    throw new Error(
      `co MCP server: worktree '${cwd}' is not a registered project (Principle 9). ` +
        "Registration is an init concern, not the tool server's — register the project first.",
    );
  }

  const mail = openMailStore(projectId);
  const ctx: ToolContext = { agent, projectId, cwd, mail, registry };
  return () => ctx;
}
