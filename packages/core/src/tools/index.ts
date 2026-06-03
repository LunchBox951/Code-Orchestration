// L2 tool-registry foundation (phase A): the FROZEN cross-phase contracts every later
// L2 tool plugs into. `ToolContext` is the invocation seam (what a handler receives);
// `ToolSpec`/`ToolHandler` are the typed declaration (schemas = the single syntax source,
// Principle 5); `ToolRegistry` + `createToolRegistry` are the append-only single source of
// truth the MCP adapter mounts, the completeness gate checks, and the role-scoper filters;
// `notImplemented` is the stub sentinel the gate detects. Phase A ships types + mechanism +
// sentinel only — the real tools and the canonical registry instance arrive in phase B.
export type { ToolContext } from './context.js';
export type { ToolHandler, ToolSpec, ToolRegistry } from './registry.js';
export { createToolRegistry, notImplemented } from './registry.js';

// L2-B1: the first REAL tools. `buildCoreRegistry` is the canonical single source of truth
// (the `co_*` tools as self-describing ToolSpecs); `invokeTool` is the transport-agnostic
// headless harness that validates I/O and dispatches to a handler (the seam the MCP adapter
// reuses); `readWorktreeInfo` is the read-only git helper behind `co_worktree_info`.
export { buildCoreRegistry } from './core-registry.js';
export { invokeTool } from './invoke.js';
export type { WorktreeInfo } from './worktree.js';
export { readWorktreeInfo } from './worktree.js';

// L2-B2: schema-exposure helpers so the thin MCP adapter can mount each tool's zod schemas onto
// the MCP SDK WITHOUT importing zod or reaching into a schema's internals (AC-L2-1 layering).
export { toolInputShape, toolOutputShape } from './schema.js';

// L2-C completeness gate (the keystone): the no-stub assertion over the WHOLE tool registry — heir
// to L1's mail-type no-stub check. A declared-but-stubbed/partial tool fails it (and so the suite,
// CI, and the review gate). Pure function; proven GREEN-on-real / RED-on-synthetic by its test.
export type { ToolViolation } from './completeness.js';
export { checkToolCompleteness } from './completeness.js';

// L2-D role-scoped orientation: the WORKFLOW-ONLY, role-scoped `co_orient` body (AC-L2-4). A pure
// function of (role, topic) — never restates a tool's field list (schemas are the syntax source,
// Principle 5) and never bakes a target repo's project memory (the prompting split, Principle 11).
export { orientContent } from './orient-content.js';

// L2-D per-role tool-scoping (AC-L2-5): the base-role vocabulary + the SEED per-role toolsets over
// the current tools, and `toolsForRole` — the relevance-scoping hook the MCP mount passes into
// `createCoMcpServer({ tools })`. Fails loud on a phantom tool (the scoping analogue of the C gate);
// authoritative rosters are an L6 concern.
export type { Role } from './scoping.js';
export { BASE_ROLES, roleToolsets, toolsForRole } from './scoping.js';
