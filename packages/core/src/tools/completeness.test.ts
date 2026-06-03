import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildCoreRegistry } from './core-registry.js';
import { checkToolCompleteness } from './completeness.js';
import { notImplemented, type ToolHandler, type ToolRegistry, type ToolSpec } from './registry.js';

// The completeness gate is the heir to L1's mail-type no-stub assertion (mail/no-stub.test.ts):
// a pure function proven GREEN over the REAL registry (buildCoreRegistry) and RED over a synthetic
// stubbed/partial tool added to a fresh copy of it. Because this rides `pnpm test`, shipping a real
// stub later turns the suite (and CI, and the review gate) red — the AC-L2-3 verify.

/** The real `co_*` tools the canonical registry declares (non-vacuous GREEN guard). */
const EXPECTED_TOOLS = [
  'co_mail_send',
  'co_mail_inbox',
  'co_mail_get',
  'co_mail_thread',
  'co_mail_ack',
  'co_mail_retract',
  'co_status',
  'co_worktree_info',
  'co_orient',
  'co_sling',
  'co_finish',
] as const;

const BOGUS = 'co_bogus';

type BogusOverrides = {
  title?: string;
  description?: string;
  inputSchema?: z.ZodType;
  outputSchema?: z.ZodType;
  handler?: ToolHandler;
};

/**
 * A synthetic tool named {@link BOGUS} that is COMPLETE by default; each override knocks out one
 * condition so the test can prove the gate flags exactly that gap (and nothing on a real tool). The
 * cast mirrors registry.test.ts: it lets a test construct a deliberately malformed spec (a
 * non-`ZodObject` schema, the stub handler) that the type system would otherwise forbid.
 */
function bogus(overrides: BogusOverrides = {}): ToolSpec {
  return {
    name: BOGUS,
    title: 'Bogus synthetic tool',
    description: 'A synthetic tool the completeness gate should evaluate.',
    inputSchema: z.object({ x: z.number().describe('a described input field') }),
    outputSchema: z.object({ y: z.number().describe('a described output field') }),
    handler: () => ({ y: 1 }),
    ...overrides,
  } as unknown as ToolSpec;
}

/** A fresh copy of the REAL registry with one bogus tool registered onto it. */
function realPlus(bad: ToolSpec): ToolRegistry {
  const registry = buildCoreRegistry();
  registry.register(bad);
  return registry;
}

describe('AC-L2-3 — completeness gate: GREEN over the real registry', () => {
  it('the real buildCoreRegistry() is complete (no violations)', () => {
    expect(checkToolCompleteness(buildCoreRegistry())).toEqual([]);
  });

  it('proves it is not vacuous — exactly the expected co_* tools are declared', () => {
    const names = buildCoreRegistry()
      .list()
      .map((t) => t.name);
    expect(names).toHaveLength(EXPECTED_TOOLS.length);
    expect([...names].sort()).toEqual([...EXPECTED_TOOLS].sort());
  });
});

describe('AC-L2-3 — completeness gate: RED for a stub/partial tool', () => {
  it('(c) a tool whose handler is the notImplemented sentinel is flagged for the handler', () => {
    const violations = checkToolCompleteness(realPlus(bogus({ handler: notImplemented })));
    const forBogus = violations.filter((v) => v.tool === BOGUS);
    expect(forBogus).toHaveLength(1);
    expect(forBogus[0]!.reason).toMatch(/handler/i);
    // Only the bogus tool is flagged — every real tool is still complete.
    expect(violations.every((v) => v.tool === BOGUS)).toBe(true);
  });

  it('(a) a tool with an undescribed input field is flagged for self-describing input', () => {
    const violations = checkToolCompleteness(
      realPlus(bogus({ inputSchema: z.object({ x: z.number() }) })), // ← field lacks .describe()
    );
    const forBogus = violations.filter((v) => v.tool === BOGUS);
    expect(forBogus).toHaveLength(1);
    expect(forBogus[0]!.reason).toMatch(/describ/i);
    expect(forBogus[0]!.reason).toContain("'x'");
    expect(violations.every((v) => v.tool === BOGUS)).toBe(true);
  });

  it('(a) a tool whose inputSchema is not a ZodObject is flagged (self-describing + not mountable)', () => {
    const violations = checkToolCompleteness(
      realPlus(bogus({ inputSchema: z.string().describe('not an object') })),
    );
    const forBogus = violations.filter((v) => v.tool === BOGUS);
    expect(forBogus.length).toBeGreaterThan(0);
    expect(forBogus.some((v) => /ZodObject/i.test(v.reason))).toBe(true);
    expect(violations.every((v) => v.tool === BOGUS)).toBe(true);
  });

  it('(b) a tool with a non-ZodObject outputSchema is flagged for output', () => {
    const violations = checkToolCompleteness(
      realPlus(bogus({ outputSchema: z.string().describe('not an object') })),
    );
    const forBogus = violations.filter((v) => v.tool === BOGUS);
    expect(forBogus.length).toBeGreaterThan(0);
    expect(forBogus.some((v) => /output/i.test(v.reason))).toBe(true);
    expect(violations.every((v) => v.tool === BOGUS)).toBe(true);
  });

  it('a fully-unwired tool surfaces several violations, all naming it; no real tool is flagged', () => {
    const violations = checkToolCompleteness(
      realPlus(
        bogus({
          title: '',
          description: '',
          inputSchema: z.string(),
          outputSchema: z.string(),
          handler: notImplemented,
        }),
      ),
    );
    const forBogus = violations.filter((v) => v.tool === BOGUS);
    // (a) not-a-ZodObject input + empty title + empty description, (b) output, (c) handler,
    // (d) input + output not mountable — many violations, every one naming the bogus tool.
    expect(forBogus.length).toBeGreaterThanOrEqual(4);
    expect(violations.every((v) => v.tool === BOGUS)).toBe(true);
  });
});
