import { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import { notImplemented } from './registry.js';
import { toolInputShape, toolOutputShape } from './schema.js';

/**
 * The L2 completeness gate (AC-L2-3; MC-1, Principle 4 — declared-not-stubbed). It is the heir to
 * L1's mail-type no-stub assertion ({@link checkMailTypeCompleteness} in mail/completeness.ts),
 * generalized from "every declared mail type has a real flow" to "every declared TOOL is real, not
 * a stub or partial". A declared-but-stubbed/partial tool is exactly the banned stub; this is the
 * integrity gate that makes the single MCP surface safe (mcp-tools.md §"Completeness gate").
 *
 * "A real handler, not a throw-stub" cannot be proven by the type system — it needs a runtime
 * check — so the gate is a PURE function (no store, no git, no MCP) run as a test over the real
 * registry. That lets the test prove it both GREEN (the real {@link buildCoreRegistry}) and RED
 * (a synthetic stubbed/partial tool). Because CI runs `pnpm test`, the gate runs in CI by riding
 * the suite: a stubbed tool turns the suite (and CI, and the review gate) red.
 */

/** A declared tool that fails the completeness check, with a human reason. */
export interface ToolViolation {
  readonly tool: string;
  readonly reason: string;
}

/** True iff `value` is a non-empty (non-blank) string. */
function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * A field schema's `.description`, or `undefined` when absent/blank. Order-INDEPENDENT: Zod stores
 * the description on the schema instance `.describe()` was called on, so `z.string().describe('d')
 * .optional()` carries it on the inner type, not the outer wrapper. We walk `.def.innerType` through
 * any `.optional()`/`.default()`/`.nullable()` wrappers and accept a description found at any layer,
 * so the gate cannot be falsely tripped by `.describe()` placement (it exists to catch description
 * DRIFT, not to enforce a call order).
 */
function describedText(schema: unknown): string | undefined {
  let current: unknown = schema;
  const seen = new Set<unknown>();
  while (current != null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const description = (current as { readonly description?: unknown }).description;
    if (typeof description === 'string' && description.trim().length > 0) return description;
    current = (current as { readonly def?: { readonly innerType?: unknown } }).def?.innerType;
  }
  return undefined;
}

/** The message of a thrown value, for a human-readable mountability reason. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Check that every tool in `registry` is COMPLETE — not a stub or partial. A tool is complete iff
 * ALL hold (one {@link ToolViolation} per FAILED condition, so a fully-unwired tool surfaces
 * several, each naming that tool; `[]` ⇒ every declared tool is complete):
 *
 *   (a) SELF-DESCRIBING INPUT (Principle 5) — `inputSchema` is a `ZodObject`, every field carries a
 *       non-empty `.description`, and the tool itself has a non-empty `title` + `description`. This
 *       is how a tool is operable from its schema alone, without reading `co`'s source.
 *   (b) STRUCTURED OUTPUT — `outputSchema` is present and is a `ZodObject` (a structured result,
 *       not a prose blob).
 *   (c) REAL HANDLER — `handler` is present and is NOT the {@link notImplemented} sentinel (compared
 *       by reference). This is the precise, testable definition of "stubbed".
 *   (d) REACHABLE / MOUNTABLE — `toolInputShape(spec)` and `toolOutputShape(spec)` do not throw, so
 *       the tool can actually be mounted by the MCP adapter. Checked via core's own schema.ts
 *       helpers — NOT by importing `packages/mcp` (the gate lives in core; the adapter's 1:1 mount
 *       is separately proven by `packages/mcp`'s parity test).
 *
 * Pure function (no I/O), so the test can prove it GREEN-on-real and RED-on-synthetic.
 */
export function checkToolCompleteness(registry: ToolRegistry): ToolViolation[] {
  const violations: ToolViolation[] = [];

  for (const spec of registry.list()) {
    const tool = spec.name;

    // (a) self-describing input — a ZodObject whose every field is .describe()'d, plus a titled +
    // described tool. Each gap is its own violation so a wholly-undescribed tool surfaces many.
    if (spec.inputSchema instanceof z.ZodObject) {
      for (const [field, fieldSchema] of Object.entries(spec.inputSchema.shape)) {
        if (describedText(fieldSchema) == null) {
          violations.push({
            tool,
            reason: `self-describing input: field '${field}' is missing a non-empty .description`,
          });
        }
      }
    } else {
      violations.push({ tool, reason: 'self-describing input: inputSchema must be a ZodObject' });
    }
    if (!hasText(spec.title)) {
      violations.push({ tool, reason: 'self-describing: missing a non-empty title' });
    }
    if (!hasText(spec.description)) {
      violations.push({ tool, reason: 'self-describing: missing a non-empty description' });
    }

    // (b) structured output — a present ZodObject output schema (covers both missing and non-object).
    if (!(spec.outputSchema instanceof z.ZodObject)) {
      violations.push({
        tool,
        reason: 'structured output: outputSchema must be present and a ZodObject',
      });
    }

    // (c) real handler — present and NOT the notImplemented stub sentinel (compared by reference).
    if (spec.handler == null) {
      violations.push({ tool, reason: 'real handler: handler is missing' });
    } else if (spec.handler === notImplemented) {
      violations.push({
        tool,
        reason:
          'real handler: handler is the notImplemented stub sentinel (declared but not implemented)',
      });
    }

    // (d) reachable / mountable — the MCP-facing input/output shapes resolve via core's schema.ts
    // helpers (loud-fail on a non-ZodObject), so the adapter can mount the tool.
    try {
      toolInputShape(spec);
    } catch (err) {
      violations.push({ tool, reason: `not mountable: ${messageOf(err)}` });
    }
    try {
      toolOutputShape(spec);
    } catch (err) {
      violations.push({ tool, reason: `not mountable: ${messageOf(err)}` });
    }
  }

  return violations;
}
