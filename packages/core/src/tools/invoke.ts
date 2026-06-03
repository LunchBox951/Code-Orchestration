import type { ToolContext } from './context.js';
import type { ToolRegistry } from './registry.js';

/**
 * Dispatch a tool HEADLESS: look it up in the registry, validate `rawInput` against its
 * `inputSchema`, run its handler with `ctx`, validate the handler's result against its
 * `outputSchema`, and return that validated structured output.
 *
 * Fails loud (Principle 9): an unknown tool, an input that fails the input schema, or a
 * handler result that fails the output schema each THROW (never a silent default / partial
 * result). This is the transport-agnostic seam every tool test uses and that the MCP adapter
 * (B2) reuses — the L2 analogue of L1's in-process delivery: it makes every tool AC testable
 * with no Conductor and no MCP server. The schemas are the single syntax source (Principle 5),
 * so validation lives HERE rather than being restated per transport.
 */
export async function invokeTool(
  registry: ToolRegistry,
  ctx: ToolContext,
  name: string,
  rawInput: unknown,
): Promise<unknown> {
  const spec = registry.get(name);
  if (!spec) {
    throw new Error(
      `invokeTool: unknown tool '${name}' — not registered (fail loud, Principle 9). ` +
        `Registered: ${registry
          .list()
          .map((t) => t.name)
          .join(', ')}`,
    );
  }

  let input: unknown;
  try {
    input = spec.inputSchema.parse(rawInput);
  } catch (cause) {
    throw new Error(`invokeTool('${name}'): input failed schema validation`, { cause });
  }

  const result = await spec.handler(ctx, input);

  try {
    return spec.outputSchema.parse(result);
  } catch (cause) {
    throw new Error(`invokeTool('${name}'): handler output failed schema validation`, { cause });
  }
}
