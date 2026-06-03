import type { MailStore } from '../mail/mail-store.js';
import type { ProjectRegistry, ProjectId } from '../registry/registry.js';

/**
 * What every tool handler receives. Assembled by whoever MOUNTS the surface — the
 * in-process test harness at L2, the Conductor at L7 — NEVER invented by a tool. This is
 * the seam that makes every tool callable headless (inject a context) while deferring
 * live identity-injection + session wiring to L7 (transport-agnostic — mcp-tools.md).
 */
export interface ToolContext {
  /** The calling agent's identity (opaque id). Injected by the mount; a tool never invents it. */
  readonly agent: string;
  /** The resolved project id for this invocation (registry.resolve(cwd)). */
  readonly projectId: ProjectId;
  /** Absolute path of the worktree/cwd the agent is operating in. */
  readonly cwd: string;
  /** The L1 mail bus over this project, opened by the mount (tools never open their own store). */
  readonly mail: MailStore;
  /** The project registry (path <-> id). */
  readonly registry: ProjectRegistry;
}
