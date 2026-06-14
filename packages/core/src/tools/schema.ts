import { z } from 'zod';
import type { ToolSpec } from './registry.js';

export type ToolJsonSchemaObject = {
  readonly type: 'object';
  readonly properties?: Record<string, object>;
  readonly required?: readonly string[];
  readonly [key: string]: unknown;
};

const STRIPPED_JSON_SCHEMA_METADATA_KEYS = new Set([
  '$schema',
  'description',
  'title',
  'default',
  'examples',
  'contentEncoding',
  'contentMediaType',
]);

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

/**
 * A compact JSON-schema projection of a tool's input. It is generated from the same canonical zod
 * schema as {@link toolInputShape}, but strips prose-heavy metadata that bloats provider MCP
 * `tools/list` payloads while preserving machine-readable validation constraints. Core validation
 * still uses the full zod schema through `invokeTool`; this projection is only wire metadata for
 * clients choosing tools.
 */
export function toolInputJsonSchema(spec: ToolSpec): ToolJsonSchemaObject {
  return toolJsonSchema(spec.name, 'inputSchema', spec.inputSchema);
}

/**
 * Compact JSON-schema projection of a tool's output, used only when an adapter opts into publishing
 * output schemas. Runtime output validation still belongs to `invokeTool`.
 */
export function toolOutputJsonSchema(spec: ToolSpec): ToolJsonSchemaObject {
  return toolJsonSchema(spec.name, 'outputSchema', spec.outputSchema);
}

function toolJsonSchema(
  toolName: string,
  side: 'inputSchema' | 'outputSchema',
  schema: z.ZodType,
): ToolJsonSchemaObject {
  if (!(schema instanceof z.ZodObject)) {
    throw new Error(
      `toolJsonSchema: tool '${toolName}' ${side} must be a ZodObject (Principle 9).`,
    );
  }
  const compact = stripJsonSchemaMetadata(z.toJSONSchema(schema));
  if (!isToolJsonSchemaObject(compact)) {
    throw new Error(
      `toolJsonSchema: tool '${toolName}' ${side} did not produce an object JSON schema (Principle 9).`,
    );
  }
  return compact;
}

function stripJsonSchemaMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripJsonSchemaMetadata);
  if (value === null || typeof value !== 'object') return value;

  const compact: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (STRIPPED_JSON_SCHEMA_METADATA_KEYS.has(key)) continue;
    compact[key] = isJsonSchemaMapKey(key)
      ? stripJsonSchemaMap(child)
      : stripJsonSchemaMetadata(child);
  }
  return compact;
}

function stripJsonSchemaMap(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return stripJsonSchemaMetadata(value);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, stripJsonSchemaMetadata(child)]),
  );
}

function isJsonSchemaMapKey(key: string): boolean {
  return (
    key === 'properties' ||
    key === 'patternProperties' ||
    key === '$defs' ||
    key === 'definitions' ||
    key === 'dependentSchemas'
  );
}

function isToolJsonSchemaObject(value: unknown): value is ToolJsonSchemaObject {
  return (
    value !== null &&
    typeof value === 'object' &&
    'type' in value &&
    (value as { readonly type?: unknown }).type === 'object'
  );
}
