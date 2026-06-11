import {
  BASE_ROLES,
  OPERATOR,
  buildCoreRegistry,
  defaultUsageSourceFactory,
  findSubRole,
  openDispatchStore,
  openMailStore,
  openRegistry,
  openReviewStore,
  openRosterStore,
  openSpecStore,
  openWorktreeStore,
  parseSubRoleId,
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

/** The launch-environment variable the mount reads the calling agent's recorded parent from. */
export const CO_PARENT_ENV = 'CO_PARENT';

/** The launch-environment variable the mount may use when cwd is a slung, unregistered sandbox. */
export const CO_PROJECT_ID_ENV = 'CO_PROJECT_ID';

const OPERATOR_TOOL_NAMES = new Set(['co_merge', 'co_push', 'co_pr_merge']);

function toolsForOperator(): readonly ToolSpec[] {
  return buildCoreRegistry()
    .list()
    .filter((tool) => OPERATOR_TOOL_NAMES.has(tool.name));
}

/**
 * Resolve the offered toolset from the launch environment's `CO_ROLE`. The scoping role is
 * MOUNT-controlled (this env), never self-declared — distinct from `co_orient`'s lenient `role`
 * input, so an agent cannot widen its own toolset by claiming a role (mcp-tools.md / permissions.md).
 *
 * Returns the role-scoped {@link ToolSpec} list when `CO_ROLE` names a base role, or `undefined` —
 * meaning "offer the full registry" — only when it is absent (local unscoped/dev mode). A present
 * blank or unknown role fails loud: mount typos must never widen an agent to the full registry. A
 * known sub-role form (`implementer:test`) validates the sub-role and exposes the base-role toolset;
 * narrower restrictions are enforced by role/profile lookup and individual tool caller checks.
 */
export function toolsFromEnv(): readonly ToolSpec[] | undefined {
  const agent = process.env[CO_AGENT_ENV]?.trim();
  const raw = process.env[CO_ROLE_ENV];
  if (raw == null) {
    if (agent === OPERATOR) return toolsForOperator();
    if (process.env[CO_PARENT_ENV] != null) {
      throw new Error(
        `co MCP server: ${CO_PARENT_ENV} is set but ${CO_ROLE_ENV} is absent — refusing to ` +
          'expose the full toolset.',
      );
    }
    if (process.env[CO_PROJECT_ID_ENV] != null) {
      throw new Error(
        `co MCP server: ${CO_PROJECT_ID_ENV} is set but ${CO_ROLE_ENV} is absent — refusing to ` +
          'expose the full toolset for a scoped project mount.',
      );
    }
    return undefined;
  }
  if (agent === OPERATOR) {
    throw new Error(
      `co MCP server: ${OPERATOR} mounts must not set ${CO_ROLE_ENV}; the operator is not a ` +
        'roster role.',
    );
  }
  if (raw.trim().length === 0) {
    throw new Error(
      `co MCP server: ${CO_ROLE_ENV} is set but empty — refusing to expose the full toolset.`,
    );
  }
  const parsed = parseSubRoleId(raw.trim().toLowerCase());
  const role = parsed.baseRole;
  if (!(BASE_ROLES as readonly string[]).includes(role)) {
    throw new Error(
      `co MCP server: unknown ${CO_ROLE_ENV} '${raw.trim()}' — refusing to expose the full toolset.`,
    );
  }
  if (parsed.name != null && findSubRole(role as Role, parsed.name) == null) {
    throw new Error(
      `co MCP server: unknown ${CO_ROLE_ENV} sub-role '${raw.trim()}' — refusing to expose ` +
        'the base role toolset.',
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
  const rawAgent = process.env[CO_AGENT_ENV];
  const agent = rawAgent?.trim();
  if (agent == null || agent.length === 0) {
    throw new Error(
      `co MCP server: ${CO_AGENT_ENV} is not set — the mount must supply the agent identity ` +
        '(Principle 9: a tool never invents who is calling).',
    );
  }
  const isOperator = agent === OPERATOR;
  if (process.env[CO_ROLE_ENV] == null && process.env[CO_PARENT_ENV] != null) {
    throw new Error(
      `co MCP server: ${CO_PARENT_ENV} is set but ${CO_ROLE_ENV} is absent — refusing an ` +
        'ambiguous unscoped mount.',
    );
  }

  const cwd = process.cwd();
  const registry = openRegistry();
  const closeOnFailure: Array<() => void> = [() => registry.close()];
  const closeOpened = (): void => {
    for (const close of [...closeOnFailure].reverse()) {
      try {
        close();
      } catch {
        // Preserve the original mount failure; cleanup best-effort is enough here.
      }
    }
  };

  try {
    const explicitProjectId = process.env[CO_PROJECT_ID_ENV]?.trim();
    if (process.env[CO_PROJECT_ID_ENV] != null && explicitProjectId === '') {
      throw new Error(
        `co MCP server: ${CO_PROJECT_ID_ENV} is set but empty — the mount must supply a project id.`,
      );
    }

    const resolvedFromCwd = registry.resolve(cwd);
    const projectId = explicitProjectId ?? resolvedFromCwd;
    if (projectId == null) {
      throw new Error(
        `co MCP server: worktree '${cwd}' is not a registered project and ${CO_PROJECT_ID_ENV} ` +
          "is not set (Principle 9). Registration / sandbox binding is an init concern, not the tool server's.",
      );
    }
    registry.dataDirFor(projectId); // validates the id is bounded under program-data.
    if (explicitProjectId != null && resolvedFromCwd != null && resolvedFromCwd !== projectId) {
      throw new Error(
        `co MCP server: ${CO_PROJECT_ID_ENV} '${projectId}' does not match registered cwd project ` +
          `'${resolvedFromCwd}'.`,
      );
    }
    if (resolvedFromCwd != null && process.env[CO_ROLE_ENV] == null && !isOperator) {
      throw new Error(
        `co MCP server: registered project mount '${cwd}' requires ${CO_ROLE_ENV} — refusing ` +
          'to expose the full toolset.',
      );
    }

    const mail = openMailStore(projectId);
    closeOnFailure.push(() => mail.close());
    // L3: open + inject the worktree store alongside mail (a second connection on the same per-project
    // store.db is safe — node:sqlite is synchronous and the two own different scopes/tables). A tool
    // never opens its own store; the mount resolves and injects it.
    const worktrees = openWorktreeStore(projectId);
    closeOnFailure.push(() => worktrees.close());
    // L4: open + inject the dispatch store (usage/cost/placement). PlacementProjector/UsageProjector/
    // CostProjector own distinct tables from WorktreeProjector so sharing the same store.db is safe.
    const dispatch = openDispatchStore(projectId);
    closeOnFailure.push(() => dispatch.close());
    // L5: open + inject the review store (verdict/request/serialize). ReviewProjector owns a distinct
    // scope (`review:`) and read-model table from the other stores, so sharing the same store.db is safe.
    const reviews = openReviewStore(projectId);
    closeOnFailure.push(() => reviews.close());
    // L6a: open + inject the roster store (agent→role→parent projection). RosterProjector owns a
    // distinct scope (`agent:`) and read-model table (`roster`) from the other stores, so sharing the
    // same store.db is safe. A tool never opens its own store; the mount resolves and injects it.
    const roster = openRosterStore(projectId);
    closeOnFailure.push(() => roster.close());
    // L6b: open + inject the spec store (spec draft/lock/archive projection). SpecsProjector owns a
    // distinct scope (`spec:`) and read-model table (`specs`) from the other stores, so sharing the
    // same store.db is safe. A tool never opens its own store; the mount resolves and injects it.
    const specs = openSpecStore(projectId);
    closeOnFailure.push(() => specs.close());
    let scopedSandbox: ReturnType<typeof worktrees.listWorktrees>[number] | undefined;
    if (explicitProjectId != null && resolvedFromCwd == null) {
      const normalizedCwd = resolve(cwd);
      scopedSandbox = worktrees
        .listWorktrees()
        .find((w) => !w.removed && resolve(w.path) === normalizedCwd);
      if (scopedSandbox == null) {
        throw new Error(
          `co MCP server: ${CO_PROJECT_ID_ENV} '${projectId}' does not record cwd '${cwd}' as a ` +
            'live slung worktree.',
        );
      }
    }
    const rawRole = process.env[CO_ROLE_ENV];
    if (isOperator && rawRole != null) {
      throw new Error(
        `co MCP server: ${OPERATOR} mounts must not set ${CO_ROLE_ENV}; the operator is not a ` +
          'roster role.',
      );
    }
    if (scopedSandbox != null && rawRole == null) {
      throw new Error(
        `co MCP server: ${CO_PROJECT_ID_ENV} '${projectId}' binds cwd '${cwd}' to a slung ` +
          `sandbox, so ${CO_ROLE_ENV} and ${CO_PARENT_ENV} are required.`,
      );
    }
    if (rawRole != null) {
      if (rawRole.trim().length === 0) {
        throw new Error(
          `co MCP server: ${CO_ROLE_ENV} is set but empty — refusing to register a roster entry.`,
        );
      }
      const parsed = parseSubRoleId(rawRole.trim().toLowerCase());
      const role = parsed.baseRole;
      if (!(BASE_ROLES as readonly string[]).includes(role)) {
        throw new Error(
          `co MCP server: unknown ${CO_ROLE_ENV} '${rawRole.trim()}' — refusing to register ` +
            'a roster entry.',
        );
      }
      if (parsed.name != null && findSubRole(role as Role, parsed.name) == null) {
        throw new Error(
          `co MCP server: unknown ${CO_ROLE_ENV} sub-role '${rawRole.trim()}' — refusing to ` +
            'register a roster entry.',
        );
      }
      const parent = process.env[CO_PARENT_ENV]?.trim();
      if (parent == null || parent.length === 0) {
        throw new Error(
          `co MCP server: ${CO_PARENT_ENV} is required when ${CO_ROLE_ENV} is set — the mount ` +
            'must supply the recorded parent for roster registration.',
        );
      }
      if (scopedSandbox != null && parent !== scopedSandbox.parent) {
        throw new Error(
          `co MCP server: ${CO_PARENT_ENV} '${parent}' does not match the recorded worktree ` +
            `parent '${scopedSandbox.parent}' for cwd '${cwd}'.`,
        );
      }
      if (scopedSandbox != null) {
        if (scopedSandbox.agent == null) {
          throw new Error(
            `co MCP server: cwd '${cwd}' is a scoped slung sandbox but has no recorded ` +
              `worktree agent. Refusing to trust ${CO_AGENT_ENV} as the authority source.`,
          );
        }
        if (scopedSandbox.agent !== agent) {
          throw new Error(
            `co MCP server: ${CO_AGENT_ENV} '${agent}' does not match the recorded worktree ` +
              `agent '${scopedSandbox.agent}' for cwd '${cwd}'.`,
          );
        }
        if (scopedSandbox.role == null) {
          throw new Error(
            `co MCP server: cwd '${cwd}' is a scoped slung sandbox but has no recorded ` +
              `worktree role. Refusing to trust ${CO_ROLE_ENV} as the authority source.`,
          );
        }
        const recordedRole =
          scopedSandbox.subRole != null
            ? `${scopedSandbox.role}:${scopedSandbox.subRole}`
            : scopedSandbox.role;
        const mountedRole = parsed.name != null ? `${role}:${parsed.name}` : role;
        if (scopedSandbox.role !== role || scopedSandbox.subRole !== parsed.name) {
          throw new Error(
            `co MCP server: ${CO_ROLE_ENV} '${mountedRole}' does not match the recorded ` +
              `worktree role '${recordedRole}' for cwd '${cwd}'.`,
          );
        }
      }
      roster.recordAgent({
        agentId: agent,
        role: role as Role,
        ...(parsed.name != null ? { subRole: parsed.name } : {}),
        parent,
      });
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
      roster,
      specs,
      usageSourceFactory: defaultUsageSourceFactory,
    };
    return () => ctx;
  } catch (e) {
    closeOpened();
    throw e;
  }
}
