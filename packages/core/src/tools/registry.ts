import type { z } from 'zod';
import type { ToolContext } from './context.js';

/** A tool handler: pure-ish function of (context, validated input) -> structured output. */
export type ToolHandler<I = unknown, O = unknown> = (ctx: ToolContext, input: I) => O | Promise<O>;

/**
 * A declared tool. The schemas are the single SYNTAX source (Principle 5): the input
 * schema is self-describing (every field carries a .describe()), the output schema fixes
 * the structured result shape. `handler` is the real implementation in core.
 */
export interface ToolSpec<I = unknown, O = unknown> {
  /** Stable tool name, snake_case, `co_*` (e.g. 'co_mail_send'). Unique in a registry. */
  readonly name: string;
  /** Short human title. */
  readonly title: string;
  /** One-paragraph self-describing description (what it does + when to use — NOT a field list). */
  readonly description: string;
  /** Self-describing zod input schema (a ZodObject; every field .describe()'d). */
  readonly inputSchema: z.ZodType<I>;
  /** Structured-result zod schema. */
  readonly outputSchema: z.ZodType<O>;
  /** The real handler. A tool whose handler IS {@link notImplemented} is a stub (the gate fails it). */
  readonly handler: ToolHandler<I, O>;
}

/** A typed, append-only registry of tools. Single source of truth — the MCP adapter mounts
 *  this, the completeness gate checks it, the role-scoper filters it. */
export interface ToolRegistry {
  /** Register a tool. Throws on a duplicate name (fail loud — Principle 9). */
  register<I, O>(spec: ToolSpec<I, O>): void;
  /** Lookup by name. */
  get(name: string): ToolSpec | undefined;
  /** True iff a tool of that name is registered. */
  has(name: string): boolean;
  /** All registered tools, in registration order. */
  list(): readonly ToolSpec[];
}

export function createToolRegistry(): ToolRegistry {
  // Storage is type-erased to the default `ToolSpec` (= ToolSpec<unknown, unknown>): the
  // generic `register<I, O>` exists for call-site inference, but a registry holds tools of
  // many different I/O shapes, so each is widened on the way in. `byName` is the index;
  // `order` preserves registration order for `list()`.
  const byName = new Map<string, ToolSpec>();
  const order: ToolSpec[] = [];
  return {
    register<I, O>(spec: ToolSpec<I, O>): void {
      if (byName.has(spec.name)) {
        throw new Error(
          `co tool registry: duplicate tool name '${spec.name}' — names must be unique (fail loud, Principle 9).`,
        );
      }
      const erased = spec as unknown as ToolSpec;
      byName.set(spec.name, erased);
      order.push(erased);
    },
    get(name: string): ToolSpec | undefined {
      return byName.get(name);
    },
    has(name: string): boolean {
      return byName.has(name);
    },
    list(): readonly ToolSpec[] {
      return [...order];
    },
  };
}

/**
 * The shared NOT-IMPLEMENTED sentinel handler. A declared tool that uses this is a STUB:
 * the L2 completeness gate (phase C) recognizes this exact reference and FAILS the build.
 * It throws loudly (Principle 9) if ever actually invoked. Use it nowhere in shipped tools —
 * it exists so the gate has a precise, testable definition of "stubbed".
 *
 * Its zero-parameter arrow is intentionally assignable to {@link ToolHandler} (TS allows a
 * function to ignore trailing parameters), so the sentinel needs no unused `ctx`/`input`
 * bindings — it always throws regardless of arguments (review #67).
 */
export const notImplemented: ToolHandler = () => {
  throw new Error(
    'co tool: not implemented. A declared tool must ship a real handler (L2 completeness gate).',
  );
};
