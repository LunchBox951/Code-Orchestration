import { openMailStore, openRegistry, type ToolContext } from '@co/core';

/** The launch-environment variable the mount reads the calling agent's identity from. */
export const CO_AGENT_ENV = 'CO_AGENT';

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
