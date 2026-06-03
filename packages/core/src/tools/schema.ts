import { z } from 'zod';
import type { ToolSpec } from './registry.js';

/**
 * The raw zod `.shape` of a tool's INPUT schema — exactly what the MCP SDK's `registerTool`
 * consumes to (a) publish the tool's JSON-schema, the self-describing surface the model reads
 * natively (mcp-tools.md), and (b) validate incoming args. It lives HERE (core), not in the thin
 * MCP adapter, so the adapter never imports zod or reaches into a schema's internals: pulling a
 * schema apart IS core logic (AC-L2-1 layering — the adapter mounts what core exposes). Fails loud
 * (Principle 9) if a spec's input schema is not a `ZodObject` — every `co_*` tool takes an object,
 * so a non-object is a tool-declaration bug, surfaced at mount time rather than masked.
 */
export function toolInputShape(spec: ToolSpec): z.core.$ZodShape {
  if (!(spec.inputSchema instanceof z.ZodObject)) {
    throw new Error(
      `toolInputShape: tool '${spec.name}' inputSchema must be a ZodObject (Principle 9).`,
    );
  }
  return spec.inputSchema.shape;
}

/**
 * The raw zod `.shape` of a tool's OUTPUT schema — what `registerTool`'s `outputSchema` consumes
 * to publish the structured-result schema and validate the tool's `structuredContent`. Same
 * layering rationale and loud-fail contract as {@link toolInputShape}: every `co_*` tool returns a
 * structured object, so a non-`ZodObject` output schema is a declaration bug.
 */
export function toolOutputShape(spec: ToolSpec): z.core.$ZodShape {
  if (!(spec.outputSchema instanceof z.ZodObject)) {
    throw new Error(
      `toolOutputShape: tool '${spec.name}' outputSchema must be a ZodObject (Principle 9).`,
    );
  }
  return spec.outputSchema.shape;
}
