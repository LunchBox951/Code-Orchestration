import {
  BASE_ROLES,
  OPERATOR,
  buildCoreRegistry,
  defaultUsageSourceFactory,
  findSubRole,
  openAgentControlStore,
  openDispatchStore,
  openIssueStore,
  openMailStore,
  openPlanStore,
  openArchiveStore,
  openRegistry,
  openResearchStore,
  openReviewStore,
  openRosterStore,
  openSpecStore,
  openWorktreeStore,
  parseSubRoleId,
  toolsForRole,
  type DeliveryFactory,
  type ProjectId,
  type ReviewerSpawnGate,
  type Role,
  type ToolContext,
  type ToolSpec,
  type UsageSourceFactory,
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

/** Optional bridge-process diagnostic log path, scoped to the isolated provider home. */
export const CO_MCP_BRIDGE_LOG_ENV = 'CO_MCP_BRIDGE_LOG';

const OPERATOR_TOOL_NAMES = new Set(['co_merge', 'co_push', 'co_pr_merge', 'co_spec_lock']);

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
 * The explicit identity a per-pane session context is built from. All fields are authoritative
 * (supplied by the Conductor from its session record); none are read from process.env.
 */
export interface ExplicitIdentity {
  /** The pane's authoritative agent id. Never read from client input. */
  readonly agent: string;
  /** The resolved project id for this session. */
  readonly projectId: ProjectId;
  /** Absolute path of the worktree/cwd the agent operates in. */
  readonly cwd: string;
}

/** Optional wiring for {@link openContextStores}. */
export interface OpenContextStoresOptions {
  /**
   * Thread a delivery seam into the assembled mail store (the L7 routing seam). When present, the
   * per-pane mail bus routes its writes through the factory's {@link DeliveryFactory} — e.g. a
   * `LiveDelivery` whose wake/inject callbacks the Conductor binds to live panes — instead of the
   * default in-process writer. Absent ⇒ the in-process default (the stdio mount path is unchanged).
   */
  readonly deliveryFactory?: DeliveryFactory;
  /**
   * The P2 placement-spawn gate (AC-S10-2 / RG-4): when present, assembled into the ctx so that
   * `co_merge` / `co_sling` calls by this pane's agent can trigger live reviewer or child spawns.
   * Absent ⇒ headless behaviour (unchanged).
   */
  readonly reviewerSpawnGate?: ReviewerSpawnGate;
  /**
   * Passive usage-source factory for this mounted context. Hosted panes can inject identity-scoped
   * provider readers (for example the pane's isolated Claude statusLine file) instead of using daemon
   * process globals — also used by host-live capture wrappers.
   */
  readonly usageSourceFactory?: UsageSourceFactory;
}

/**
 * Open all per-project stores for `identity` and assemble a {@link ToolContext}. This is the
 * shared store-open + context assembly used by BOTH {@link defaultContextFactory} (env-sourced
 * stdio mount) and the per-pane {@link LiveSessionHost} (explicit conductor-supplied identity).
 * Mount-specific env cross-checks (CO_PROJECT_ID vs cwd, CO_AGENT vs recorded worktree, roster
 * registration) belong to the calling mount, not here.
 *
 * `opts.deliveryFactory` is the optional L7 routing seam: when set, the assembled mail bus delivers
 * through it (a `LiveDelivery` bound to live panes) rather than the in-process default.
 *
 * Returns a { ctx, close } pair; the caller is responsible for calling `close()` on error or
 * session end to release all opened stores.
 */
export function openContextStores(
  identity: ExplicitIdentity,
  opts?: OpenContextStoresOptions,
): {
  ctx: ToolContext;
  close: () => void;
} {
  const registry = openRegistry();
  const closeOnFailure: Array<() => void> = [() => registry.close()];
  const closeAll = (): void => {
    for (const close of [...closeOnFailure].reverse()) {
      try {
        close();
      } catch {
        // best-effort cleanup
      }
    }
  };

  try {
    const { agent, projectId, cwd } = identity;
    const mail = openMailStore(
      projectId,
      opts?.deliveryFactory != null ? { deliveryFactory: opts.deliveryFactory } : undefined,
    );
    closeOnFailure.push(() => mail.close());
    const worktrees = openWorktreeStore(projectId);
    closeOnFailure.push(() => worktrees.close());
    const dispatch = openDispatchStore(projectId);
    closeOnFailure.push(() => dispatch.close());
    const reviews = openReviewStore(projectId);
    closeOnFailure.push(() => reviews.close());
    const roster = openRosterStore(projectId);
    closeOnFailure.push(() => roster.close());
    const specs = openSpecStore(projectId);
    closeOnFailure.push(() => specs.close());
    const plans = openPlanStore(projectId);
    closeOnFailure.push(() => plans.close());
    const issues = openIssueStore(projectId);
    closeOnFailure.push(() => issues.close());
    const research = openResearchStore(projectId);
    closeOnFailure.push(() => research.close());
    const archive = openArchiveStore(projectId);
    closeOnFailure.push(() => archive.close());
    // #131 — durable operator-control state, injected read-only so co_sling can EXCLUDE stopped
    // children from the active-child cap (a STOPPED child holds no live slot). Opened by the mount,
    // never by the tool (Principle 9).
    const agentControlStore = openAgentControlStore(projectId);
    const agentControl = {
      isStopped: (agentId: string): boolean => agentControlStore.isStopped(agentId),
      listStopped: (): readonly string[] => agentControlStore.listStopped(),
    };
    closeOnFailure.push(() => agentControlStore.close());

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
      plans,
      issues,
      research,
      archive,
      agentControl,
      usageSourceFactory: opts?.usageSourceFactory ?? defaultUsageSourceFactory,
      ...(opts?.reviewerSpawnGate != null ? { reviewerSpawnGate: opts.reviewerSpawnGate } : {}),
    };
    return { ctx, close: closeAll };
  } catch (e) {
    closeAll();
    throw e;
  }
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

  // Phase 1: resolve projectId from the launch environment using a temp registry.
  // Closed explicitly before opening the full store set — avoids holding two registries at once.
  const envRegistry = openRegistry();
  let projectId!: string;
  let resolvedFromCwd: string | undefined;
  let explicitProjectId: string | undefined;
  try {
    explicitProjectId = process.env[CO_PROJECT_ID_ENV]?.trim();
    if (process.env[CO_PROJECT_ID_ENV] != null && explicitProjectId === '') {
      throw new Error(
        `co MCP server: ${CO_PROJECT_ID_ENV} is set but empty — the mount must supply a project id.`,
      );
    }
    resolvedFromCwd = envRegistry.resolve(cwd);
    const candidate = explicitProjectId ?? resolvedFromCwd;
    if (candidate == null) {
      throw new Error(
        `co MCP server: worktree '${cwd}' is not a registered project and ${CO_PROJECT_ID_ENV} ` +
          "is not set (Principle 9). Registration / sandbox binding is an init concern, not the tool server's.",
      );
    }
    projectId = candidate;
    envRegistry.dataDirFor(projectId); // validates the id is bounded under program-data.
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
  } catch (e) {
    try {
      envRegistry.close();
    } catch {
      // best-effort; preserve original error
    }
    throw e;
  }
  envRegistry.close(); // phase 1 done — close temp registry before opening stores

  // Phase 2: open all stores via the shared helper, then perform env-specific cross-checks.
  const { ctx, close: closeOpened } = openContextStores({ agent, projectId, cwd });
  // worktrees is always present: openContextStores opens it unconditionally.
  const worktrees = ctx.worktrees!;
  const roster = ctx.roster!;
  try {
    // Env-specific cross-checks: CO_PROJECT_ID vs recorded worktrees, CO_AGENT vs worktree agent,
    // CO_ROLE vs worktree role, roster registration. These remain in the env path.
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
    return () => ctx;
  } catch (e) {
    closeOpened();
    throw e;
  }
}
