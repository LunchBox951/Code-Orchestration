import {
  BASE_ROLES,
  defaultUsageSourceFactory,
  openDispatchStore,
  openMailStore,
  openRegistry,
  openReviewStore,
  openWorktreeStore,
  toolsForRole,
  type Role,
  type ToolContext,
  type ToolSpec,
} from '@co/core';
import { resolve } from 'node:path';

/** The launch-environment variable the mount reads the calling agent's identity from. */
export const CO_AGENT_ENV = 'CO_AGENT';

/** The launch-environment variable the mount reads the role to SCOPE the offered toolset by. */
export const CO_ROLE_ENV = 'CO_ROLE';

/** The launch-environment variable the mount may use when cwd is a slung, unregistered sandbox. */
export const CO_PROJECT_ID_ENV = 'CO_PROJECT_ID';

/**
 * Resolve the offered toolset from the launch environment's `CO_ROLE`. The scoping role is
 * MOUNT-controlled (this env), never self-declared — distinct from `co_orient`'s lenient `role`
 * input, so an agent cannot widen its own toolset by claiming a role (mcp-tools.md / permissions.md).
 *
 * Returns the role-scoped {@link ToolSpec} list when `CO_ROLE` names a base role, or `undefined` —
 * meaning "offer the full registry" — only when it is absent (local unscoped/dev mode). A present
 * blank or unknown role fails loud: mount typos must never widen an agent to the full registry. A
 * sub-role form (`implementer:test`) scopes to its base role until L6 owns narrower rosters.
 */
export function toolsFromEnv(): readonly ToolSpec[] | undefined {
  const raw = process.env[CO_ROLE_ENV];
  if (raw == null) return undefined;
  if (raw.trim().length === 0) {
    throw new Error(
      `co MCP server: ${CO_ROLE_ENV} is set but empty — refusing to expose the full toolset.`,
    );
  }
  const role = raw.trim().toLowerCase().split(':', 1)[0]!;
  if (!(BASE_ROLES as readonly string[]).includes(role)) {
    throw new Error(
      `co MCP server: unknown ${CO_ROLE_ENV} '${raw.trim()}' — refusing to expose the full toolset.`,
    );
  }
  return toolsForRole(role as Role);
}

/**
 * Build the default stdio {@link ToolContext} factory. The server serves a SINGLE agent for the
 * life of the process, so this resolves identity + project + mail bus ONCE (eagerly, here) and
 * hands the same context to every tool call — opening the registry/MailStore once and reusing
 * them. The MOUNT supplies identity from the launch environment; a tool never invents who is
 * calling (mcp-tools.md). Fails loud (Principle 9):
 *   - missing/empty `CO_AGENT`        → throw (never fabricate an identity);
 *   - cwd not a registered project AND no valid `CO_PROJECT_ID` sandbox binding → throw
 *     (registration / sandbox binding is an init concern, not the tool server's).
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
  const explicitProjectId = process.env[CO_PROJECT_ID_ENV]?.trim();
  if (process.env[CO_PROJECT_ID_ENV] != null && explicitProjectId === '') {
    registry.close();
    throw new Error(
      `co MCP server: ${CO_PROJECT_ID_ENV} is set but empty — the mount must supply a project id.`,
    );
  }

  const resolvedFromCwd = registry.resolve(cwd);
  const projectId = explicitProjectId ?? resolvedFromCwd;
  if (projectId == null) {
    registry.close();
    throw new Error(
      `co MCP server: worktree '${cwd}' is not a registered project and ${CO_PROJECT_ID_ENV} ` +
        "is not set (Principle 9). Registration / sandbox binding is an init concern, not the tool server's.",
    );
  }
  registry.dataDirFor(projectId); // validates the id is bounded under program-data.
  if (explicitProjectId != null && resolvedFromCwd != null && resolvedFromCwd !== projectId) {
    registry.close();
    throw new Error(
      `co MCP server: ${CO_PROJECT_ID_ENV} '${projectId}' does not match registered cwd project ` +
        `'${resolvedFromCwd}'.`,
    );
  }

  const mail = openMailStore(projectId);
  // L3: open + inject the worktree store alongside mail (a second connection on the same per-project
  // store.db is safe — node:sqlite is synchronous and the two own different scopes/tables). A tool
  // never opens its own store; the mount resolves and injects it.
  const worktrees = openWorktreeStore(projectId);
  // L4: open + inject the dispatch store (usage/cost/placement). PlacementProjector/UsageProjector/
  // CostProjector own distinct tables from WorktreeProjector so sharing the same store.db is safe.
  const dispatch = openDispatchStore(projectId);
  // L5: open + inject the review store (verdict/request/serialize). ReviewProjector owns a distinct
  // scope (`review:`) and read-model table from the other stores, so sharing the same store.db is safe.
  const reviews = openReviewStore(projectId);
  if (explicitProjectId != null && resolvedFromCwd == null) {
    const normalizedCwd = resolve(cwd);
    const isRecordedSandbox = worktrees
      .listWorktrees()
      .some((w) => !w.removed && resolve(w.path) === normalizedCwd);
    if (!isRecordedSandbox) {
      mail.close();
      worktrees.close();
      dispatch.close();
      reviews.close();
      registry.close();
      throw new Error(
        `co MCP server: ${CO_PROJECT_ID_ENV} '${projectId}' does not record cwd '${cwd}' as a ` +
          'live slung worktree.',
      );
    }
  }
  const ctx: ToolContext = {
    agent,
    projectId,
    cwd,
    mail,
    registry,
    worktrees,
    dispatch,
    reviews,
    usageSourceFactory: defaultUsageSourceFactory,
  };
  return () => ctx;
}
